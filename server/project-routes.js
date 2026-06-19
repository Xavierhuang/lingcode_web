'use strict';

// project-routes.js — collaborator management for deployed projects. A "project"
// (projects table) is the owner-assigned identity that ties a managed backend,
// a deployed app/worker, and the project source together so ONE invite grants
// owner/editor/viewer access to all of them.
//
// This mirrors collab-routes.js (which does the same for /try prototypes): the
// invite-by-email + pending-invite + claim flow, share-link tokens, and the
// role hierarchy are intentionally the same shapes. Resource-level enforcement
// lives in project-access.js (resolveResourceAccess), used by the cloud-*.js
// route files — this module only manages the project + its membership.

const crypto = require('crypto');
const zlib = require('zlib');
const express = require('express');
const tarStream = require('tar-stream');
const { getUserFromRequest } = require('./auth-helpers');
const { sendResendEmail } = require('./mail-resend');
const { roleAtLeast, projectRole } = require('./project-access');
const dataPlane = require('./cloud-data-plane');
// Resource teardown, shared with each resource's own DELETE route. Used by the
// project-delete cascade so deleting a project can actually take its deployed
// site offline (and optionally drop its managed backend).
const { teardownWorker } = require('./cloud-workers');
const { teardownApp } = require('./cloud-apps');
const { teardownBackend } = require('./cloud-backend');
// fflate is only needed to normalize a user-uploaded .zip into our .tgz pipeline.
// Loaded lazily/guarded so a missing dep degrades to "tgz-only" rather than crashing.
let fflate = null; try { fflate = require('fflate'); } catch (_) { /* zip upload disabled */ }

// Cap on a source-snapshot tarball (the repo-less fallback to git sharing).
const SOURCE_MAX_BYTES = 50 * 1024 * 1024; // 50MB

// Canonicalize a git remote URL so SSH/HTTPS/.git/trailing-slash variants of the
// SAME repo compare equal — e.g. `git@github.com:Owner/Repo.git`,
// `https://github.com/Owner/Repo`, and `ssh://git@github.com/owner/repo/` all
// become `github.com/owner/repo`. Used to match a freshly-cloned folder to the
// project a collaborator was invited to (their repo's origin is the one thing
// that always travels through GitHub). Empty string if nothing usable.
function normalizeGitRemote(u) {
  let s = String(u || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^git\+/, '');
  s = s.replace(/^(https?|ssh|git):\/\//, '');   // strip scheme
  s = s.replace(/^[^@/]*@/, '');                  // strip user@ (git@, etc.)
  s = s.replace(/:/, '/');                         // scp-style host:owner/repo → host/owner/repo
  s = s.replace(/\.git$/, '');
  s = s.replace(/\/+$/, '');
  return s;
}

// Paths we never store in a shared snapshot: dependency dirs, VCS internals,
// OS cruft, and — critically — env files (the #1 secret-leak vector).
const SNAPSHOT_SKIP_RE = /(^|\/)(node_modules|\.git|\.next|\.turbo|dist|build|__MACOSX)(\/|$)|(^|\/)\.DS_Store$|(^|\/)\.env(\.[^/]*)?$/i;

// High-signal credential patterns. We don't block on these (the recipients are
// invited collaborators, not the public) — we surface a warning so the owner can
// rotate. Mirrors the /try pre-publish scanner's vendors, compact set.
const SECRET_RES = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,                                   // AWS access key id
  /\bsk-[A-Za-z0-9]{20,}\b/,                            // OpenAI-style
  /\bAIza[0-9A-Za-z\-_]{35}\b/,                         // Google API key
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,                   // Slack
  /\bghp_[0-9A-Za-z]{36}\b/,                            // GitHub PAT
  /(?:api[_-]?key|secret|passwd|password|token)\s*[:=]\s*['"][^'"\n]{12,}['"]/i,
];

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true; // NUL → binary
  return false;
}
function scanForSecrets(buf) {
  if (buf.length > 512 * 1024 || looksBinary(buf)) return false;
  const text = buf.toString('utf8');
  return SECRET_RES.some((re) => re.test(text));
}

// Convert a user-uploaded .zip into our canonical gzip-tar, dropping skip-listed
// paths and collecting secret warnings. Returns { tgz, kept, dropped, warnings }.
async function zipBufferToScrubbedTgz(zipBuf) {
  if (!fflate) throw new Error('zip_unsupported');
  let files;
  try { files = fflate.unzipSync(new Uint8Array(zipBuf)); }
  catch (_) { throw new Error('bad_zip'); }
  const pack = tarStream.pack();
  const warnings = [];
  let kept = 0, dropped = 0;
  for (const name of Object.keys(files)) {
    if (name.endsWith('/')) continue;                  // directory entry
    if (SNAPSHOT_SKIP_RE.test(name)) { dropped++; continue; }
    const data = Buffer.from(files[name]);
    if (scanForSecrets(data)) warnings.push(name);
    pack.entry({ name, size: data.length }, data);
    kept++;
  }
  pack.finalize();
  const chunks = [];
  for await (const c of pack) chunks.push(c);
  const tgz = zlib.gzipSync(Buffer.concat(chunks));
  return { tgz, kept, dropped, warnings };
}

function isGzip(buf) { return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b; }
function isZip(buf) { return buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07); }

// Unpack a gzip-tar snapshot into a { path: content } map for the browser editor.
// Text files only (binary or >512KB entries are listed in `skipped`, not loaded)
// so the payload stays editor-sized. Resolves { files, skipped }.
function tgzToFileMap(tgzBuf) {
  return new Promise((resolve, reject) => {
    const files = {};
    const skipped = [];
    const extract = tarStream.extract();
    extract.on('entry', (header, stream, next) => {
      if (header.type !== 'file') { stream.resume(); return next(); }
      const chunks = [];
      let size = 0;
      let tooBig = false;
      stream.on('data', (c) => { size += c.length; if (size > 512 * 1024) tooBig = true; else chunks.push(c); });
      stream.on('end', () => {
        const name = String(header.name).replace(/^\.\//, '');
        if (tooBig) { skipped.push(name); return next(); }
        const buf = Buffer.concat(chunks);
        if (looksBinary(buf)) { skipped.push(name); return next(); }
        files[name] = buf.toString('utf8');
        next();
      });
      stream.on('error', () => next());
    });
    extract.on('finish', () => resolve({ files, skipped }));
    extract.on('error', reject);
    const gunzip = zlib.createGunzip();
    gunzip.on('error', reject);
    gunzip.pipe(extract);
    gunzip.end(tgzBuf);
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITE_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;       // share-link: 48 hours
const PENDING_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // email invite: 14 days
const PENDING_TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // ownership transfer offer: 7 days

// Per-inviter rate limit (mirrors collab-routes.js allowInvite).
const INVITE_RATE_WINDOW_MS = 60 * 60 * 1000;
const INVITE_RATE_MAX = 30;
const inviteBuckets = new Map();
function allowInvite(userId) {
  const now = Date.now();
  let b = inviteBuckets.get(userId);
  if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + INVITE_RATE_WINDOW_MS }; inviteBuckets.set(userId, b); }
  b.count += 1;
  return b.count <= INVITE_RATE_MAX;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function getInitials(name) {
  return String(name || '?').trim().slice(0, 2).toUpperCase();
}
function publicUser(row) {
  if (!row) return null;
  const name = String(row.email || '').split('@')[0];
  return { id: row.id, email: row.email, name, initials: getInitials(name) };
}
// Shape a cloud_apps row for the UI: expose the root-served vanity hostname/URL
// (<slug>.apps.lingcode.dev) so pages link/label by that instead of the raw UUID.
// Falls back to the /apps/<id>/ sub-path for apps deployed before slugs existed.
const APPS_VANITY_APEX = process.env.LINGCODE_APPS_VANITY_APEX || 'apps.lingcode.dev';
function appResource(row) {
  if (!row) return null;
  const hostname = row.slug ? `${row.slug}.${APPS_VANITY_APEX}` : null;
  return {
    id: row.id,
    ...(row.title !== undefined ? { title: row.title } : {}),
    hostname,
    url: hostname ? `https://${hostname}/` : `/apps/${row.id}/`,
  };
}
function requireJsonContent(req, res) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) { res.status(415).json({ ok: false, error: 'unsupported_media_type' }); return false; }
  return true;
}
function publicOrigin() {
  return String(process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '') || 'https://lingcode.dev';
}

/**
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
function registerProjectRoutes(app, db) {

  // ── Permission middleware ──────────────────────────────────────────────────
  function requireProjectRole(minRole) {
    return (req, res, next) => {
      const u = getUserFromRequest(db, req);
      if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const projectId = req.params.id;
      if (!projectId || !UUID_RE.test(projectId)) return res.status(400).json({ ok: false, error: 'invalid_id' });
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
      if (!project) return res.status(404).json({ ok: false, error: 'project_not_found' });
      const role = projectRole(db, projectId, u.id);
      if (!role) return res.status(404).json({ ok: false, error: 'project_not_found' }); // hide existence
      if (!roleAtLeast(role, minRole)) return res.status(403).json({ ok: false, error: 'forbidden' });
      req._projUser = u;
      req._projRole = role;
      req._project = project;
      next();
    };
  }

  // ── Create a project (auth) ────────────────────────────────────────────────
  // The Mac app calls this on first connect to mint a canonical id it persists
  // in <workspace>/.lingcode/project.json. Idempotent linking happens via
  // /link-resource, not here.
  app.post('/api/projects', (req, res) => {
    if (!requireJsonContent(req, res)) return;
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const name = String((req.body && req.body.name) || 'Project').trim().slice(0, 120) || 'Project';
    // Capture the folder's git remote at creation so collaborators who clone the
    // repo can later be matched back to this project by remote (see /resolve).
    const gitRemote = req.body && req.body.git_remote
      ? String(req.body.git_remote).trim().slice(0, 500) || null : null;
    const id = crypto.randomUUID();
    const now = Date.now();
    db.transaction(() => {
      db.prepare('INSERT INTO projects (id, owner_id, name, git_remote, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, u.id, name, gitRemote, now, now);
      db.prepare('INSERT INTO project_members (id, project_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), id, u.id, 'owner', u.id, now);
    })();
    res.status(201).json({ ok: true, project: { id, name, role: 'owner' } });
  });

  // ── List my projects (owned + shared) ──────────────────────────────────────
  app.get('/api/projects', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.set('Cache-Control', 'no-store');
    const rows = db.prepare(`
      SELECT p.id, p.name, p.owner_id, p.git_remote, p.created_at, p.updated_at, pm.role
      FROM project_members pm JOIN projects p ON p.id = pm.project_id
      WHERE pm.user_id = ?
      ORDER BY p.updated_at DESC
    `).all(u.id);
    const projects = rows.map((p) => {
      const backend = db.prepare('SELECT id, status FROM account_backends WHERE project_id = ?').get(p.id);
      const app_ = db.prepare('SELECT id, slug FROM cloud_apps WHERE project_id = ?').get(p.id);
      const worker = db.prepare('SELECT id, hostname FROM cloud_workers WHERE project_id = ?').get(p.id);
      const ownerEmail = (db.prepare('SELECT email FROM users WHERE id = ?').get(p.owner_id) || {}).email || null;
      return {
        id: p.id, name: p.name, role: p.role,
        is_owner: p.owner_id === u.id, owner_email: ownerEmail,
        git_remote: p.git_remote || null,
        backend: backend ? { id: backend.id, status: backend.status } : null,
        app: app_ ? appResource(app_) : null,
        worker: worker ? { id: worker.id, hostname: worker.hostname } : null,
        created_at: p.created_at, updated_at: p.updated_at,
      };
    });
    res.json({ ok: true, projects });
  });

  // ── Resolve a project by git remote (collaborator clone → same project) ─────
  // A freshly-cloned folder may have no `.lingcode/project.json` (manifest not
  // committed, or .lingcode gitignored). The repo's origin remote DID travel via
  // GitHub, so we match it to the project the caller was invited to. Member-only
  // (never reveals projects the user can't access). Registered BEFORE
  // '/api/projects/:id' so the literal segment isn't captured as an id.
  app.get('/api/projects/resolve', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.set('Cache-Control', 'no-store');
    const target = normalizeGitRemote(req.query.git_remote);
    if (!target) return res.json({ ok: true, project: null });
    const rows = db.prepare(`
      SELECT p.id, p.name, p.owner_id, p.git_remote, pm.role
      FROM project_members pm JOIN projects p ON p.id = pm.project_id
      WHERE pm.user_id = ? AND p.git_remote IS NOT NULL AND p.git_remote != ''
      ORDER BY p.updated_at DESC
    `).all(u.id);
    // Match on the normalized remote; prefer a project the caller owns.
    const matches = rows.filter((r) => normalizeGitRemote(r.git_remote) === target);
    const match = matches.find((r) => r.owner_id === u.id) || matches[0];
    if (!match) return res.json({ ok: true, project: null });
    const app_ = db.prepare('SELECT id, slug FROM cloud_apps WHERE project_id = ?').get(match.id);
    const worker = db.prepare('SELECT id, hostname FROM cloud_workers WHERE project_id = ?').get(match.id);
    res.json({ ok: true, project: {
      id: match.id, name: match.name, role: match.role,
      is_owner: match.owner_id === u.id,
      app: app_ ? { id: app_.id } : null,
      worker: worker ? { id: worker.id, hostname: worker.hostname } : null,
    } });
  });

  // ── Claim a token (entrypoint from the invite email OR a share-link) ────────
  // Registered BEFORE '/api/projects/:id' so the literal path isn't shadowed by
  // the parameterized route. Handles two token kinds: a by-email pending invite
  // (project_pending_invites → joins at the invited role) and an owner share
  // link (project_members.invite_token → joins as viewer).
  app.get('/api/projects/claim', (req, res) => {
    const token = String(req.query.token || '');
    if (!token) return res.status(400).type('html').send('<p>Missing token.</p>');

    const pending = db.prepare('SELECT * FROM project_pending_invites WHERE token = ?').get(token);
    const shareRow = pending ? null : db.prepare("SELECT project_id, user_id, invite_expires FROM project_members WHERE invite_token = ? AND role = 'owner'").get(token);
    if (!pending && !shareRow) return res.status(404).type('html').send('<p>Invite not found or already claimed under a different account. Ask the owner to resend.</p>');
    const expiry = pending ? pending.expires_at : shareRow.invite_expires;
    const consumed = pending ? pending.consumed_at : null;
    if (expiry && expiry < Date.now() && !consumed) return res.status(410).type('html').send('<p>Invite expired. Ask the owner to resend.</p>');

    const user = getUserFromRequest(db, req);
    if (!user) {
      const nextUrl = `/api/projects/claim?token=${encodeURIComponent(token)}`;
      return res.redirect(`/signin.html?invite=1&next=${encodeURIComponent(nextUrl)}`);
    }

    const projectId = pending ? pending.project_id : shareRow.project_id;
    const role = pending ? pending.role : 'viewer';
    const invitedBy = pending ? pending.invited_by : shareRow.user_id;
    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).type('html').send('<p>The project this invite refers to no longer exists.</p>');

    const existing = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, user.id);
    db.transaction(() => {
      if (!existing) {
        db.prepare('INSERT INTO project_members (id, project_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(crypto.randomUUID(), projectId, user.id, role, invitedBy, Date.now());
      }
      if (pending && !pending.consumed_at) {
        db.prepare('UPDATE project_pending_invites SET consumed_at = ?, consumed_by = ? WHERE id = ?').run(Date.now(), user.id, pending.id);
      }
    })();

    const effectiveRole = existing ? existing.role : role;
    const deepLink = `lingcode://project/${encodeURIComponent(project.id)}`;
    const webUrl = `/account.html?project=${encodeURIComponent(project.id)}`;
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Invite accepted</title>
<body style="font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:64px auto;padding:0 20px;color:#1a1a1a;">
<h2>You're in.</h2>
<p>You now have <strong>${escapeHtml(effectiveRole)}</strong> access to <strong>${escapeHtml(project.name)}</strong>.</p>
<p style="margin:24px 0;">
  <a href="${escapeHtml(deepLink)}" style="display:inline-block;background:#7c3aed;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;">Open in LingCode</a>
  &nbsp;&nbsp;<a href="${escapeHtml(webUrl)}">Open web console</a>
</p>
<p style="color:#888;font-size:13px;">If "Open in LingCode" does nothing, the app may not be installed — use the web console.</p>
</body>`);
  });

  // ── Single project detail (any member) — powers the control panel header ────
  app.get('/api/projects/:id', requireProjectRole('viewer'), (req, res) => {
    const p = req._project;
    const backend = db.prepare('SELECT id, status, label FROM account_backends WHERE project_id = ?').get(p.id);
    const app_ = db.prepare('SELECT id, title, slug FROM cloud_apps WHERE project_id = ?').get(p.id);
    const worker = db.prepare('SELECT id, hostname, title FROM cloud_workers WHERE project_id = ?').get(p.id);
    const ownerEmail = (db.prepare('SELECT email FROM users WHERE id = ?').get(p.owner_id) || {}).email || null;
    // Pending ownership transfer (if any, not expired). Surfaced so the owner
    // sees "pending → X / cancel" and the target sees an "accept ownership" prompt.
    const xfer = db.prepare(`
      SELECT pt.to_user_id, pt.expires_at, u.email AS to_email
      FROM project_pending_transfers pt JOIN users u ON u.id = pt.to_user_id
      WHERE pt.project_id = ?
    `).get(p.id);
    const pendingTransfer = (xfer && xfer.expires_at > Date.now())
      ? { to_email: xfer.to_email, to_user_id: xfer.to_user_id, expires_at: xfer.expires_at, is_me: xfer.to_user_id === req._projUser.id }
      : null;
    res.json({ ok: true, project: {
      id: p.id, name: p.name, role: req._projRole, is_owner: p.owner_id === req._projUser.id,
      owner_email: ownerEmail, git_remote: p.git_remote || null, default_branch: p.default_branch || null,
      backend: backend ? { id: backend.id, status: backend.status, label: backend.label } : null,
      app: app_ ? appResource(app_) : null,
      worker: worker ? { id: worker.id, hostname: worker.hostname, title: worker.title || null, url: worker.hostname ? `https://${worker.hostname}/` : null } : null,
      pending_transfer: pendingTransfer,
      created_at: p.created_at, updated_at: p.updated_at,
    } });
  });

  // ── Project settings: rename + git remote (owner) ───────────────────────────
  app.patch('/api/projects/:id', requireProjectRole('owner'), (req, res) => {
    if (!requireJsonContent(req, res)) return;
    const body = req.body || {};
    const sets = [], vals = [];
    if (typeof body.name === 'string') { sets.push('name = ?'); vals.push(body.name.trim().slice(0, 120) || 'Project'); }
    if (body.git_remote !== undefined) {
      const gr = body.git_remote === null ? null : String(body.git_remote).trim().slice(0, 500) || null;
      sets.push('git_remote = ?'); vals.push(gr);
    }
    if (body.default_branch !== undefined) {
      const b = body.default_branch === null ? null : String(body.default_branch).trim().slice(0, 100) || null;
      sets.push('default_branch = ?'); vals.push(b);
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing_to_update' });
    sets.push('updated_at = ?'); vals.push(Date.now());
    vals.push(req.params.id);
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    res.json({ ok: true });
  });

  // ── Leave a project (any non-owner member) ──────────────────────────────────
  app.post('/api/projects/:id/leave', requireProjectRole('viewer'), (req, res) => {
    if (req._projRole === 'owner') return res.status(400).json({ ok: false, error: 'owner_cannot_leave', message: 'Transfer ownership or delete the project instead.' });
    db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(req.params.id, req._projUser.id);
    res.json({ ok: true });
  });

  // ── Delete a project (owner) ────────────────────────────────────────────────
  // Always dissolves the project + its membership. Optional cascade via query:
  //   ?site=1    → tear down the deployed Worker(s) + static app(s) so the
  //                <slug>.lingcode.app URL stops serving (else they're de-linked).
  //   ?backend=1 → also drop the managed Postgres backend(s) and their data
  //                (irreversible; else de-linked).
  // Returns { torn_down, failures } so the UI can warn if a teardown didn't take
  // (e.g. the Cloudflare script delete failed) instead of reporting a clean win.
  app.delete('/api/projects/:id', requireProjectRole('owner'), async (req, res) => {
    const pid = req.params.id;
    const truthy = (v) => v === '1' || v === 'true';
    const deleteSite = truthy(req.query.site);
    const deleteBackend = truthy(req.query.backend);
    const failures = [];
    const torn = { workers: [], apps: [], backends: [] };
    try {
      if (deleteSite) {
        for (const w of db.prepare('SELECT id FROM cloud_workers WHERE project_id = ?').all(pid)) {
          try { const r = await teardownWorker(db, w.id); torn.workers.push(w.id); if (r && r.ok === false) failures.push({ type: 'worker', id: w.id, error: r.error }); }
          catch (e) { failures.push({ type: 'worker', id: w.id, error: String((e && e.message) || e) }); }
        }
        for (const a of db.prepare('SELECT id FROM cloud_apps WHERE project_id = ?').all(pid)) {
          try { await teardownApp(db, a.id); torn.apps.push(a.id); }
          catch (e) { failures.push({ type: 'app', id: a.id, error: String((e && e.message) || e) }); }
        }
      } else {
        db.prepare('UPDATE cloud_apps SET project_id = NULL WHERE project_id = ?').run(pid);
        db.prepare('UPDATE cloud_workers SET project_id = NULL WHERE project_id = ?').run(pid);
      }

      if (deleteBackend) {
        for (const b of db.prepare('SELECT id FROM account_backends WHERE project_id = ?').all(pid)) {
          try { const r = await teardownBackend(db, b.id); if (r && r.ok === false) failures.push({ type: 'backend', id: b.id, error: r.error }); else torn.backends.push(b.id); }
          catch (e) { failures.push({ type: 'backend', id: b.id, error: String((e && e.message) || e) }); }
        }
      } else {
        db.prepare('UPDATE account_backends SET project_id = NULL WHERE project_id = ?').run(pid);
      }

      db.transaction(() => {
        db.prepare('DELETE FROM project_members WHERE project_id = ?').run(pid);
        db.prepare('DELETE FROM project_pending_invites WHERE project_id = ?').run(pid);
        db.prepare('DELETE FROM project_pending_transfers WHERE project_id = ?').run(pid);
        db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
      })();

      res.json({ ok: true, torn_down: torn, failures });
    } catch (err) {
      console.error('[project-routes] delete cascade failed', pid, err);
      res.status(500).json({ ok: false, error: 'delete_failed', message: String((err && err.message) || err) });
    }
  });

  // ── Members ────────────────────────────────────────────────────────────────
  app.get('/api/projects/:id/members', requireProjectRole('viewer'), (req, res) => {
    const rows = db.prepare(`
      SELECT pm.user_id, pm.role, pm.created_at, u.email
      FROM project_members pm JOIN users u ON pm.user_id = u.id
      WHERE pm.project_id = ? ORDER BY pm.created_at ASC
    `).all(req.params.id);
    const members = rows.map((r) => ({ ...publicUser({ id: r.user_id, email: r.email }), role: r.role, joined_at: r.created_at }));
    const pending = db.prepare('SELECT email, role, created_at, expires_at FROM project_pending_invites WHERE project_id = ? AND consumed_at IS NULL ORDER BY created_at ASC').all(req.params.id);
    res.json({ ok: true, members, pending });
  });

  // POST invite by email (owner)
  app.post('/api/projects/:id/members', requireProjectRole('owner'), async (req, res) => {
    if (!requireJsonContent(req, res)) return;
    if (!allowInvite(req._projUser.id)) return res.status(429).json({ ok: false, error: 'rate_limited' });
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const role = String(body.role || 'viewer');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'invalid_email' });
    if (!['editor', 'viewer'].includes(role)) return res.status(400).json({ ok: false, error: 'invalid_role' });

    const invitee = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
    const projectName = req._project.name;

    // Pending-invite branch: no account yet.
    if (!invitee) {
      const token = crypto.randomBytes(24).toString('base64url');
      const now = Date.now();
      const expiresAt = now + PENDING_INVITE_TTL_MS;
      const existing = db.prepare('SELECT id FROM project_pending_invites WHERE project_id = ? AND email = ?').get(req.params.id, email);
      if (existing) {
        db.prepare('UPDATE project_pending_invites SET role=?, token=?, invited_by=?, created_at=?, expires_at=?, consumed_at=NULL, consumed_by=NULL WHERE id=?')
          .run(role, token, req._projUser.id, now, expiresAt, existing.id);
      } else {
        db.prepare('INSERT INTO project_pending_invites (id, project_id, email, role, token, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(crypto.randomUUID(), req.params.id, email, role, token, req._projUser.id, now, expiresAt);
      }
      let emailSent = false;
      try {
        const claimUrl = `${publicOrigin()}/api/projects/claim?token=${encodeURIComponent(token)}`;
        const inviterName = (req._projUser.email || '').split('@')[0] || 'A collaborator';
        const html = `
<p>${escapeHtml(inviterName)} invited you to collaborate on <strong>${escapeHtml(projectName)}</strong> as <strong>${escapeHtml(role)}</strong> on LingCode Cloud.</p>
<p style="margin:18px 0;"><a href="${escapeHtml(claimUrl)}" style="display:inline-block;background:#7c3aed;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;">Sign up &amp; accept</a></p>
<p style="color:#666;font-size:13px;line-height:1.5;">Once you create an account you'll get ${escapeHtml(role)} access to this project's managed backend.</p>
<p style="color:#999;font-size:12px;margin-top:24px;">This invite expires in 14 days. If the button does not work, copy this URL:<br>${escapeHtml(claimUrl)}</p>`;
        const sent = await sendResendEmail({ to: email, subject: `${inviterName} invited you to ${projectName}`, html });
        emailSent = !!sent.ok;
        if (!sent.ok) console.error('[projects] pending-invite email failed:', sent.error);
      } catch (e) { console.error('[projects] pending-invite email exception:', e.message); }
      return res.status(201).json({ ok: true, action: 'pending', role, email_sent: emailSent });
    }

    // Existing-user branch.
    const existing = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(req.params.id, invitee.id);
    if (existing) {
      if (existing.role !== role && existing.role !== 'owner') {
        db.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?').run(role, req.params.id, invitee.id);
      }
      return res.json({ ok: true, action: 'updated', role });
    }
    db.prepare('INSERT INTO project_members (id, project_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), req.params.id, invitee.id, role, req._projUser.id, Date.now());
    let emailSent = false;
    try {
      const inviterName = (req._projUser.email || '').split('@')[0] || 'A collaborator';
      const openUrl = `${publicOrigin()}/account.html?project=${encodeURIComponent(req.params.id)}`;
      const html = `
<p>${escapeHtml(inviterName)} invited you to collaborate on <strong>${escapeHtml(projectName)}</strong> as <strong>${escapeHtml(role)}</strong>.</p>
<p style="margin:18px 0;"><a href="${escapeHtml(openUrl)}" style="display:inline-block;background:#7c3aed;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;">Open project</a></p>
<p style="color:#666;font-size:13px;line-height:1.5;">${role === 'viewer' ? 'You have read-only access to the backend console.' : 'You can read and write the backend data.'} It also appears in LingCode under "Shared with me".</p>`;
      const sent = await sendResendEmail({ to: invitee.email, subject: `${inviterName} invited you to ${projectName}`, html });
      emailSent = !!sent.ok;
      if (!sent.ok) console.error('[projects] invite email failed:', sent.error);
    } catch (e) { console.error('[projects] invite email exception:', e.message); }
    res.status(201).json({ ok: true, action: 'invited', role, email_sent: emailSent });
  });

  // Revoke an unconsumed by-email invite (owner)
  app.post('/api/projects/:id/revoke-invite', requireProjectRole('owner'), (req, res) => {
    if (!requireJsonContent(req, res)) return;
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: 'invalid_email' });
    db.prepare('DELETE FROM project_pending_invites WHERE project_id = ? AND email = ? AND consumed_at IS NULL').run(req.params.id, email);
    res.json({ ok: true });
  });

  // PATCH change role (owner)
  app.patch('/api/projects/:id/members/:userId', requireProjectRole('owner'), (req, res) => {
    if (!requireJsonContent(req, res)) return;
    const targetId = req.params.userId;
    const role = String((req.body || {}).role || '');
    if (!['editor', 'viewer'].includes(role)) return res.status(400).json({ ok: false, error: 'invalid_role' });
    const result = db.prepare("UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ? AND role != 'owner'")
      .run(role, req.params.id, targetId);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'not_found_or_owner' });
    res.json({ ok: true });
  });

  // DELETE remove member (owner)
  app.delete('/api/projects/:id/members/:userId', requireProjectRole('owner'), (req, res) => {
    const targetId = req.params.userId;
    const target = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(req.params.id, targetId);
    if (!target) return res.status(404).json({ ok: false, error: 'not_found' });
    if (target.role === 'owner') return res.status(400).json({ ok: false, error: 'cannot_remove_owner' });
    db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(req.params.id, targetId);
    // Void any pending ownership transfer aimed at the member we just removed.
    db.prepare('DELETE FROM project_pending_transfers WHERE project_id = ? AND to_user_id = ?').run(req.params.id, targetId);
    res.json({ ok: true });
  });

  // ── Share link (owner) ─────────────────────────────────────────────────────
  app.get('/api/projects/:id/share-link', requireProjectRole('owner'), (req, res) => {
    const token = crypto.randomBytes(24).toString('base64url');
    const expires = Date.now() + INVITE_TOKEN_TTL_MS;
    db.prepare("UPDATE project_members SET invite_token = ?, invite_expires = ? WHERE project_id = ? AND role = 'owner' AND user_id = ?")
      .run(token, expires, req.params.id, req._projUser.id);
    res.json({ ok: true, url: `${publicOrigin()}/api/projects/claim?token=${token}`, token, expires_at: expires });
  });

  // POST join via share-link token (auth) — joins as viewer
  app.post('/api/projects/:id/join', (req, res) => {
    if (!requireJsonContent(req, res)) return;
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const token = String((req.body || {}).token || '');
    if (!token) return res.status(400).json({ ok: false, error: 'missing_token' });
    const ownerRow = db.prepare("SELECT user_id, invite_token, invite_expires FROM project_members WHERE project_id = ? AND role = 'owner' AND invite_token = ?")
      .get(req.params.id, token);
    if (!ownerRow) return res.status(403).json({ ok: false, error: 'invalid_token' });
    if (!ownerRow.invite_expires || Date.now() > ownerRow.invite_expires) return res.status(403).json({ ok: false, error: 'token_expired' });
    const existing = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(req.params.id, u.id);
    if (existing) return res.json({ ok: true, role: existing.role, action: 'already_member' });
    db.prepare('INSERT INTO project_members (id, project_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), req.params.id, u.id, 'viewer', ownerRow.user_id, Date.now());
    res.status(201).json({ ok: true, role: 'viewer', action: 'joined' });
  });

  // ── Ownership transfer (accept-required) ────────────────────────────────────
  // Initiate (owner): offer ownership to an existing member — emails them a prompt.
  // Accept (target): atomic swap of projects.owner_id, the two member roles, and
  // the project's resource owners. Cancel/decline (owner OR target): clear it.

  app.post('/api/projects/:id/transfer', requireProjectRole('owner'), async (req, res) => {
    if (!requireJsonContent(req, res)) return;
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: 'invalid_email' });
    const target = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
    const notMember = { ok: false, error: 'not_a_member', message: 'The new owner must already be a collaborator. Invite them first, then transfer.' };
    if (!target) return res.status(404).json(notMember);
    if (target.id === req._projUser.id) return res.status(400).json({ ok: false, error: 'already_owner', message: 'You are already the owner.' });
    if (!db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(req.params.id, target.id)) return res.status(404).json(notMember);
    const token = crypto.randomBytes(24).toString('base64url');
    const now = Date.now(), expiresAt = now + PENDING_TRANSFER_TTL_MS;
    db.prepare(`
      INSERT INTO project_pending_transfers (id, project_id, to_user_id, from_user_id, token, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        to_user_id = excluded.to_user_id, from_user_id = excluded.from_user_id,
        token = excluded.token, created_at = excluded.created_at, expires_at = excluded.expires_at
    `).run(crypto.randomUUID(), req.params.id, target.id, req._projUser.id, token, now, expiresAt);
    let emailSent = false;
    try {
      const inviterName = (req._projUser.email || '').split('@')[0] || 'The owner';
      const openUrl = `${publicOrigin()}/project.html?id=${encodeURIComponent(req.params.id)}`;
      const html = `
<p>${escapeHtml(inviterName)} wants to transfer ownership of <strong>${escapeHtml(req._project.name)}</strong> to you on LingCode Cloud.</p>
<p style="margin:18px 0;"><a href="${escapeHtml(openUrl)}" style="display:inline-block;background:#7c3aed;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;">Review &amp; accept</a></p>
<p style="color:#666;font-size:13px;line-height:1.5;">Accepting makes you the owner of this project's backend (data, auth, storage, secrets), live deployment, and billing. Source stored in LingCode comes too; code in an external Git repo isn't transferred — ask ${escapeHtml(inviterName)} for repo access. They become an editor. This offer expires in 7 days.</p>`;
      const sent = await sendResendEmail({ to: target.email, subject: `${inviterName} wants to transfer ${req._project.name} to you`, html });
      emailSent = !!sent.ok;
      if (!sent.ok) console.error('[projects] transfer-offer email failed:', sent.error);
    } catch (e) { console.error('[projects] transfer-offer email exception:', e.message); }
    res.json({ ok: true, action: 'transfer_pending', to: target.email, email_sent: emailSent });
  });

  app.post('/api/projects/:id/transfer/accept', (req, res) => {
    if (!requireJsonContent(req, res)) return;
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const xfer = db.prepare('SELECT * FROM project_pending_transfers WHERE project_id = ?').get(req.params.id);
    if (!xfer || xfer.to_user_id !== u.id) return res.status(404).json({ ok: false, error: 'no_pending_transfer' });
    if (xfer.expires_at <= Date.now()) {
      db.prepare('DELETE FROM project_pending_transfers WHERE project_id = ?').run(req.params.id);
      return res.status(410).json({ ok: false, error: 'transfer_expired', message: 'This transfer offer expired. Ask the owner to resend.' });
    }
    if (!db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(req.params.id, u.id)) return res.status(409).json({ ok: false, error: 'not_a_member' });
    const proj = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(req.params.id);
    if (!proj) return res.status(404).json({ ok: false, error: 'project_not_found' });
    const oldOwnerId = proj.owner_id;
    db.transaction(() => {
      db.prepare('UPDATE projects SET owner_id = ?, updated_at = ? WHERE id = ?').run(u.id, Date.now(), req.params.id);
      db.prepare("UPDATE project_members SET role = 'owner'  WHERE project_id = ? AND user_id = ?").run(req.params.id, u.id);
      db.prepare("UPDATE project_members SET role = 'editor' WHERE project_id = ? AND user_id = ?").run(req.params.id, oldOwnerId);
      // Reassign the project's resources so the new owner truly controls them
      // (resource ownership is keyed by user_id outside the project membership).
      db.prepare('UPDATE account_backends SET user_id = ? WHERE project_id = ?').run(u.id, req.params.id);
      db.prepare('UPDATE cloud_apps     SET user_id = ? WHERE project_id = ?').run(u.id, req.params.id);
      db.prepare('UPDATE cloud_workers  SET user_id = ? WHERE project_id = ?').run(u.id, req.params.id);
      db.prepare('DELETE FROM project_pending_transfers WHERE project_id = ?').run(req.params.id);
    })();
    res.json({ ok: true, role: 'owner' });
  });

  // Cancel (owner) or decline (target) a pending transfer.
  app.delete('/api/projects/:id/transfer', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const xfer = db.prepare('SELECT from_user_id, to_user_id FROM project_pending_transfers WHERE project_id = ?').get(req.params.id);
    if (!xfer) return res.json({ ok: true, action: 'noop' });
    if (u.id !== xfer.from_user_id && u.id !== xfer.to_user_id) return res.status(403).json({ ok: false, error: 'forbidden' });
    db.prepare('DELETE FROM project_pending_transfers WHERE project_id = ?').run(req.params.id);
    res.json({ ok: true, action: u.id === xfer.to_user_id ? 'declined' : 'cancelled' });
  });


  // ── Source snapshot (Phase 3 fallback when there's no git remote) ───────────
  // Body is a gzip tarball of the project source (ignore-list applied client-side).
  // git remote is preferred (set via PATCH /api/projects/:id { git_remote }); this
  // is the repo-less path. Snapshot, not sync — each upload is a new version.
  // Accepts a gzip tarball (.tgz, stored as-is) OR a .zip (normalized server-side
  // to .tgz: skip-list applied + secret-scanned). Client uploads as octet-stream;
  // we sniff the magic bytes, so the declared content-type doesn't have to be exact.
  const rawTar = express.raw({ type: ['application/gzip', 'application/x-gzip', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream'], limit: SOURCE_MAX_BYTES });

  app.post('/api/projects/:id/source', requireProjectRole('editor'), rawTar, async (req, res) => {
    if (!dataPlane.isConfigured()) return res.status(503).json({ ok: false, error: 'cloud_not_configured' });
    let bytes = req.body;
    if (!Buffer.isBuffer(bytes) || !bytes.length) return res.status(400).json({ ok: false, error: 'empty_body' });
    let warnings = [];
    if (isZip(bytes)) {
      try {
        const norm = await zipBufferToScrubbedTgz(bytes);
        bytes = norm.tgz;
        warnings = norm.warnings;
        if (!norm.kept) return res.status(400).json({ ok: false, error: 'empty_after_scrub', message: 'Nothing to store after removing node_modules/.git/.env.' });
      } catch (e) {
        const msg = e && e.message === 'zip_unsupported' ? 'Zip upload is unavailable on this server — upload a .tar.gz instead.' : 'Could not read that .zip.';
        return res.status(400).json({ ok: false, error: e && e.message === 'zip_unsupported' ? 'zip_unsupported' : 'bad_zip', message: msg });
      }
    } else if (!isGzip(bytes)) {
      return res.status(400).json({ ok: false, error: 'unsupported_archive', message: 'Upload a .zip or a .tar.gz of your source.' });
    }
    if (bytes.length > SOURCE_MAX_BYTES) return res.status(413).json({ ok: false, error: 'too_large', message: 'Source exceeds 50MB after packing.' });
    const prev = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM project_source_snapshots WHERE project_id = ?').get(req.params.id);
    const version = (prev.v || 0) + 1;
    const key = `srcsnap/${req.params.id}/${version}.tgz`;
    try { await dataPlane.putAppFileBlob(key, bytes, 'application/gzip'); }
    catch (e) { return res.status(500).json({ ok: false, error: 'store_failed', message: e && e.message }); }
    db.prepare('INSERT INTO project_source_snapshots (project_id, version, blob_key, total_bytes, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(req.params.id, version, key, bytes.length, Date.now());
    res.json({ ok: true, version, bytes: bytes.length, warnings });
  });

  app.get('/api/projects/:id/source/versions', requireProjectRole('viewer'), (req, res) => {
    const rows = db.prepare('SELECT version, total_bytes, created_at FROM project_source_snapshots WHERE project_id = ? ORDER BY version DESC').all(req.params.id);
    res.json({ ok: true, snapshots: rows });
  });

  app.get('/api/projects/:id/source', requireProjectRole('viewer'), async (req, res) => {
    if (!dataPlane.isConfigured()) return res.status(503).json({ ok: false, error: 'cloud_not_configured' });
    const wanted = Number(req.query.version) || null;
    const snap = wanted
      ? db.prepare('SELECT * FROM project_source_snapshots WHERE project_id = ? AND version = ?').get(req.params.id, wanted)
      : db.prepare('SELECT * FROM project_source_snapshots WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(req.params.id);
    if (!snap) return res.status(404).json({ ok: false, error: 'no_snapshot' });
    let bytes;
    try { bytes = await dataPlane.getAppFileBlob(snap.blob_key); }
    catch (e) { return res.status(500).json({ ok: false, error: 'fetch_failed', message: e && e.message }); }
    if (!bytes) return res.status(404).json({ ok: false, error: 'blob_missing' });
    res.set('Content-Type', 'application/gzip');
    res.set('Content-Disposition', `attachment; filename="source-v${snap.version}.tgz"`);
    res.send(bytes);
  });

  // Source as a { path: content } map for the in-browser editor (vs the raw .tgz
  // download above). Text files only; binary/oversize entries are listed in
  // `skipped`. Latest snapshot unless ?version=N.
  app.get('/api/projects/:id/source/files', requireProjectRole('viewer'), async (req, res) => {
    if (!dataPlane.isConfigured()) return res.status(503).json({ ok: false, error: 'cloud_not_configured' });
    const wanted = Number(req.query.version) || null;
    const snap = wanted
      ? db.prepare('SELECT * FROM project_source_snapshots WHERE project_id = ? AND version = ?').get(req.params.id, wanted)
      : db.prepare('SELECT * FROM project_source_snapshots WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(req.params.id);
    if (!snap) return res.status(404).json({ ok: false, error: 'no_snapshot' });
    let bytes;
    try { bytes = await dataPlane.getAppFileBlob(snap.blob_key); }
    catch (e) { return res.status(500).json({ ok: false, error: 'fetch_failed', message: e && e.message }); }
    if (!bytes) return res.status(404).json({ ok: false, error: 'blob_missing' });
    try {
      const { files, skipped } = await tgzToFileMap(bytes);
      res.json({ ok: true, version: snap.version, files, skipped });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'unpack_failed', message: e && e.message });
    }
  });

  // ── Link an existing resource into this project (editor+) ───────────────────
  // The Mac app calls this on deploy/connect to merge a just-created backend /
  // app / worker into the canonical project. The caller must currently own the
  // resource (its row.user_id) so you can't graft someone else's resource in.
  app.post('/api/projects/:id/link-resource', requireProjectRole('editor'), (req, res) => {
    if (!requireJsonContent(req, res)) return;
    const kind = String((req.body || {}).kind || '');
    const resourceId = String((req.body || {}).resourceId || '');
    const TABLES = { backend: 'account_backends', app: 'cloud_apps', worker: 'cloud_workers' };
    const table = TABLES[kind];
    if (!table) return res.status(400).json({ ok: false, error: 'invalid_kind' });
    if (!resourceId) return res.status(400).json({ ok: false, error: 'missing_resourceId' });
    const row = db.prepare(`SELECT id, user_id, project_id FROM ${table} WHERE id = ?`).get(resourceId);
    if (!row) return res.status(404).json({ ok: false, error: 'resource_not_found' });
    // Only the resource's current owner may move it, and only if it isn't already
    // attached to a DIFFERENT project.
    if (row.user_id !== req._projUser.id) return res.status(403).json({ ok: false, error: 'not_resource_owner' });
    if (row.project_id && row.project_id !== req.params.id) return res.status(409).json({ ok: false, error: 'already_linked' });
    db.prepare(`UPDATE ${table} SET project_id = ? WHERE id = ?`).run(req.params.id, resourceId);
    res.json({ ok: true, kind, resourceId, project_id: req.params.id });
  });
}

module.exports = { registerProjectRoutes };
