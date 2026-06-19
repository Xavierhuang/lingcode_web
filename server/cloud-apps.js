'use strict';

// cloud-apps.js — "Cloud Apps": BUILT static frontends (Vite/React/etc.)
// deployed from the native LingCode IDE and served at /apps/<id>/* with REAL
// sub-path asset serving + SPA fallback.
//
// Why this is separate from saved-prototypes.js: a /try prototype is one base64
// blob rendered inside a sandboxed <iframe srcdoc>, which inlines all CSS/JS.
// A production build emits index.html that fetches hashed /assets/*.js chunks
// over the network — the srcdoc renderer can't serve those. Here every file is
// stored individually (bytes in the roomy cloud Postgres via cloud-data-plane,
// metadata in control-plane SQLite) and served at its true path with the right
// content-type, so code-split chunks, dynamic imports, and client-side routing
// all work.
//
// Upload is a single gzip'd tar of the dist/ contents (the IDE produces it with
// `tar -czf … -C <outputDir> .`). The global 128KB express.json parser is
// SKIPPED for /api/account/cloud-apps in index.js, so the upload route reads the
// raw request stream directly.
//
// Re-deploy is atomic via a version flip: new bytes are written under
// `${appId}/${newVersion}/…` keys, then the cloud_app_files rows + cloud_apps.version
// are swapped in a single SQLite transaction, then the old version's bytes are
// dropped best-effort. No half-served window.

const express = require('express');
const zlib = require('zlib');
const crypto = require('crypto');
const dns = require('dns').promises;
const tar = require('tar-stream');
const { getUserFromRequest } = require('./auth-helpers');
const { resolveResourceAccess, projectRole } = require('./project-access');
const cloudDataPlane = require('./cloud-data-plane');

// The edge IP a custom domain must resolve to. A CNAME to apps.lingcode.dev
// also resolves here (DNS follows the chain), so a single resolve4() check
// covers both the CNAME and the direct-A-record setups.
const EDGE_IP = process.env.LINGCODE_EDGE_IP || '138.197.107.228';

// ── Limits / quotas ──────────────────────────────────────────────────────
const APP_CAP_PER_USER = 25;                  // separate from the 50 saved-prototype cap
const MAX_APP_BYTES = 100 * 1024 * 1024;      // 100MB total per app (built apps routinely exceed 8MB)
const MAX_SINGLE_FILE = 25 * 1024 * 1024;     // 25MB per file
const MAX_FILES = 2000;
const TITLE_MAX = 120;
const DEPLOY_RATE_WINDOW_MS = 60 * 60 * 1000;
const DEPLOY_RATE_MAX = 12;                   // deploys/hour/user

// RFC-1123 hostname (labels 1–63, alnum + hyphen, ≥2 labels). Same shape as
// cloud-domains.js HOST_RE — kept local to avoid a cross-module coupling.
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per-user deploy-rate buckets (same shape as saved-prototypes.allowSave).
const deployBuckets = new Map();
function allowDeploy(userId) {
  const now = Date.now();
  let b = deployBuckets.get(userId);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + DEPLOY_RATE_WINDOW_MS }; deployBuckets.set(userId, b); }
  b.count += 1;
  return b.count <= DEPLOY_RATE_MAX;
}

function publicOrigin() {
  return String(process.env.PUBLIC_ORIGIN || 'https://lingcode.dev').replace(/\/$/, '');
}

// How many prior deploys to keep blobs for (so rollback works). Older versions'
// rows are dropped and their bytes reclaimed — unless a retained deploy (e.g. a
// rollback) still points at them.
const KEEP_DEPLOYMENTS = 10;

// Reclaim blobs for deploys older than the last KEEP_DEPLOYMENTS. A version's
// bytes are only deleted when NO retained deploy references them — a rollback
// re-points the live manifest at an older version's blobs, so those stay alive.
async function pruneDeployments(db, appId) {
  let rows;
  try { rows = db.prepare('SELECT id, version, files_json FROM deployments WHERE app_id = ? ORDER BY version DESC').all(appId); }
  catch (_) { return; }
  if (rows.length <= KEEP_DEPLOYMENTS) return;
  const keep = rows.slice(0, KEEP_DEPLOYMENTS);
  const drop = rows.slice(KEEP_DEPLOYMENTS);
  const referencedVersions = new Set();
  for (const d of keep) {
    try {
      for (const f of JSON.parse(d.files_json)) {
        const m = /^[^/]+\/(\d+)\//.exec(f.blob_key);
        if (m) referencedVersions.add(Number(m[1]));
      }
    } catch (_) { /* skip a corrupt manifest */ }
  }
  for (const d of drop) {
    try { db.prepare('DELETE FROM deployments WHERE id = ?').run(d.id); } catch (_) {}
    if (!referencedVersions.has(d.version)) {
      try { await cloudDataPlane.deleteAppBlobsForAppVersion(appId, d.version); } catch (_) {}
    }
  }
}

// Record an immutable deploy row (the rollback manifest) and supersede the prior
// live one. Best-effort: history must never block or fail a deploy.
function recordDeployment(db, { appId, userId, version, title, indexPath, totalBytes, fileCount, files, sourceVersion = null, note = null, now }) {
  const manifest = JSON.stringify(files.map((f) => ({
    path: f.path, content_type: f.contentType || f.content_type, byte_len: f.byteLen != null ? f.byteLen : f.byte_len, blob_key: f.blobKey || f.blob_key,
  })));
  try {
    db.transaction(() => {
      db.prepare("UPDATE deployments SET status = 'superseded' WHERE app_id = ? AND status = 'live'").run(appId);
      db.prepare(`INSERT INTO deployments
          (id, app_id, user_id, version, status, title, index_path, total_bytes, file_count, files_json, source_version, note, created_at)
          VALUES (?,?,?,?, 'live', ?,?,?,?,?,?,?,?)`)
        .run(crypto.randomUUID(), appId, userId, version, title, indexPath, totalBytes, fileCount, manifest, sourceVersion, note, now);
    })();
  } catch (_) { /* history is best-effort */ }
}

function decodeHeader(v) {
  if (typeof v !== 'string' || !v) return '';
  try { return decodeURIComponent(v); } catch (_) { return v; }
}

// Normalize an archive/request path: forward slashes, no leading ./ or /, no
// traversal, no directory entries. Returns null if illegal.
function normalizeRel(name) {
  let p = String(name || '').replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  if (!p || p.endsWith('/')) return null;
  if (p.length > 1024) return null;
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return p;
}

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', cjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  wasm: 'application/wasm', txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8',
  webmanifest: 'application/manifest+json', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
};
function contentTypeFor(rel) {
  const m = /\.([a-z0-9]+)$/i.exec(rel);
  const ext = m ? m[1].toLowerCase() : '';
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

function notFoundPage(msg) {
  const m = String(msg).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Not found · LingCode</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0a;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;padding:24px;text-align:center}h1{font-size:1.5rem;margin:0 0 8px;font-weight:500}p{color:#888;margin:0 0 24px}a{color:#00d084;text-decoration:none}a:hover{text-decoration:underline}</style></head><body><h1>404</h1><p>${m}</p><a href="/try.html">Build something on /try →</a></body></html>`;
}

// Stream the raw (gunzip'd tar) request body. Writes each file's bytes to the
// blob store under the new version key as it arrives (one file buffered at a
// time — extract is paused until next() so memory stays bounded). Resolves with
// the file metadata list; rejects with an {code,error,message} error on caps,
// bad paths, or malformed archives.
function extractArchive(req, appId, version) {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const extract = tar.extract();
    const files = [];
    let totalBytes = 0;
    let fileCount = 0;
    let failed = null;
    const fail = (code, error, message) => { if (!failed) failed = { code, error, message }; };

    extract.on('entry', (header, stream, next) => {
      if (failed || header.type !== 'file') { stream.on('end', next); stream.resume(); return; }
      const rel = normalizeRel(header.name);
      if (rel === null) { fail(400, 'bad_path', `Illegal path in archive: ${header.name}`); stream.on('end', next); stream.resume(); return; }
      const chunks = [];
      let len = 0;
      stream.on('data', (c) => {
        if (failed) return;
        len += c.length;
        if (len > MAX_SINGLE_FILE) return fail(413, 'file_too_large', `${rel} exceeds ${MAX_SINGLE_FILE} bytes`);
        if (totalBytes + len > MAX_APP_BYTES) return fail(413, 'app_too_large', `App exceeds ${Math.round(MAX_APP_BYTES / 1048576)}MB`);
        chunks.push(c);
      });
      stream.on('error', () => { fail(400, 'archive_error', 'Malformed archive entry'); next(); });
      stream.on('end', () => {
        if (failed) return next();
        fileCount += 1;
        if (fileCount > MAX_FILES) { fail(413, 'too_many_files', `App exceeds ${MAX_FILES} files`); return next(); }
        totalBytes += len;
        const buf = Buffer.concat(chunks);
        const contentType = contentTypeFor(rel);
        const blobKey = `${appId}/${version}/${rel}`;
        cloudDataPlane.putAppFileBlob(blobKey, buf, contentType)
          .then(() => { files.push({ path: rel, contentType, byteLen: buf.length, blobKey }); next(); })
          .catch((e) => { fail(500, 'blob_write_failed', (e && e.message) || 'storage error'); next(); });
      });
    });

    extract.on('finish', () => {
      if (failed) return reject(Object.assign(new Error(failed.error), failed));
      resolve({ files, totalBytes, fileCount });
    });
    extract.on('error', () => reject(Object.assign(new Error('archive_error'), { code: 400, error: 'archive_error', message: 'Could not read archive' })));
    gunzip.on('error', () => reject(Object.assign(new Error('bad_gzip'), { code: 400, error: 'bad_gzip', message: 'Body is not valid gzip' })));

    req.pipe(gunzip).pipe(extract);
  });
}

// ── Vanity subdomain (<slug>.apps.lingcode.dev) ──────────────────────────────
// A static app served at /apps/<id>/ gets a base-href'd build, which blanks ANY
// client-side router (it reads location.pathname = /apps/<id>/ and matches none
// of the app's "/"-rooted routes). Serving it at the ROOT of a vanity subdomain
// fixes that — and reuses the existing custom_domains + Caddy on-demand-TLS path
// (the host falls through `isOurHost` in cloud-domains.js and is served at root).
// Auto-assigned on first deploy; re-deploys keep the same subdomain.
const VANITY_APEX = process.env.LINGCODE_APPS_VANITY_APEX || 'apps.lingcode.dev';
const VANITY_RESERVED = new Set(['www', 'api', 'app', 'apps', 'admin', 'cdn', 'assets', 'static', 'mail', 'test', 'staging', 'status', 'lingcode']);

function slugifyTitle(title) {
  return String(title || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

// Assign (and persist) a root-served vanity subdomain for `appId`. Idempotent: a
// re-deploy returns the app's existing subdomain. Returns the full domain or null
// (never throws — a subdomain hiccup must not block a deploy).
function assignVanitySubdomain(db, appId, userId, title) {
  try {
    const existing = db.prepare(
      "SELECT domain FROM custom_domains WHERE app_id = ? AND status = 'active' AND domain LIKE ? ORDER BY created_at ASC LIMIT 1"
    ).get(appId, '%.' + VANITY_APEX);
    if (existing) return existing.domain;

    const taken = (slug) => !!db.prepare('SELECT 1 FROM custom_domains WHERE domain = ?').get(slug + '.' + VANITY_APEX);
    const rand = (n) => crypto.randomBytes(n).toString('hex');

    let base = slugifyTitle(title);
    if (base.length < 3 || base.startsWith('app-') || VANITY_RESERVED.has(base)) base = '';

    let slug = '';
    if (base && !taken(base)) slug = base;
    for (let i = 0; !slug && base && i < 5; i++) { const c = (base + '-' + rand(2)).slice(0, 40); if (!taken(c)) slug = c; }
    for (let i = 0; !slug && i < 8; i++) { const c = 'app-' + rand(6); if (!taken(c)) slug = c; }
    if (!slug) return null;

    const domain = slug + '.' + VANITY_APEX;
    db.prepare("INSERT INTO custom_domains (domain, prototype_id, app_id, user_id, status, created_at) VALUES (?, '', ?, ?, 'active', ?)")
      .run(domain, appId, userId, Date.now());
    try { db.prepare('UPDATE cloud_apps SET slug = ? WHERE id = ?').run(slug, appId); } catch (_) {}
    return domain;
  } catch (_) {
    return null;
  }
}

async function handleUpload(db, req, res, mode /* 'create' | 'update' */) {
  const u = getUserFromRequest(db, req);
  if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!cloudDataPlane.isConfigured()) {
    return res.status(503).json({ ok: false, error: 'cloud_unconfigured', message: 'Cloud storage is not configured on this server.' });
  }
  if (!allowDeploy(u.id)) return res.status(429).json({ ok: false, error: 'rate_limited', message: `Limit ${DEPLOY_RATE_MAX} deploys/hour.` });

  let appId, oldVersion, newVersion, existing = null;
  if (mode === 'update') {
    appId = String(req.params.id || '');
    if (!UUID_RE.test(appId)) return res.status(404).json({ ok: false, error: 'app_not_found' });
    // Editor+ may redeploy (shared) — falls back to direct ownership for legacy.
    const access = resolveResourceAccess(db, { resourceTable: 'cloud_apps', resourceId: appId, userId: u.id, minRole: 'editor' });
    if (!access.ok) {
      if (access.code === 'forbidden') return res.status(403).json({ ok: false, error: 'forbidden' });
      return res.status(404).json({ ok: false, error: 'app_not_found' });
    }
    existing = access.row;
    oldVersion = existing.version;
    newVersion = oldVersion + 1;
  } else {
    const count = db.prepare('SELECT COUNT(*) AS n FROM cloud_apps WHERE user_id = ?').get(u.id).n;
    if (count >= APP_CAP_PER_USER) return res.status(409).json({ ok: false, error: 'cap_reached', cap: APP_CAP_PER_USER });
    appId = crypto.randomUUID();
    oldVersion = null;
    newVersion = 1;
  }

  const title = (decodeHeader(req.headers['x-app-title']) || (existing && existing.title) || 'Untitled app').slice(0, TITLE_MAX);
  const indexPath = normalizeRel(decodeHeader(req.headers['x-app-index'])) || 'index.html';

  let result;
  try {
    result = await extractArchive(req, appId, newVersion);
  } catch (e) {
    await cloudDataPlane.deleteAppBlobsForAppVersion(appId, newVersion);
    return res.status((e && e.code) || 500).json({ ok: false, error: (e && e.error) || 'upload_failed', message: e && e.message });
  }

  if (!result.files.some((f) => f.path === indexPath)) {
    await cloudDataPlane.deleteAppBlobsForAppVersion(appId, newVersion);
    return res.status(400).json({ ok: false, error: 'missing_index', message: `Bundle has no ${indexPath} at its root.` });
  }

  const now = Date.now();
  try {
    const swap = db.transaction(() => {
      if (mode === 'update') {
        db.prepare('DELETE FROM cloud_app_files WHERE app_id = ?').run(appId);
        db.prepare('UPDATE cloud_apps SET title=?, index_path=?, version=?, total_bytes=?, file_count=?, updated_at=? WHERE id=?')
          .run(title, indexPath, newVersion, result.totalBytes, result.fileCount, now, appId);
      } else {
        db.prepare(`INSERT INTO cloud_apps (id, user_id, title, index_path, version, total_bytes, file_count, is_public, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,1,?,?)`)
          .run(appId, u.id, title, indexPath, newVersion, result.totalBytes, result.fileCount, now, now);
      }
      const ins = db.prepare('INSERT INTO cloud_app_files (app_id, path, content_type, byte_len, blob_key) VALUES (?,?,?,?,?)');
      for (const f of result.files) ins.run(appId, f.path, f.contentType, f.byteLen, f.blobKey);
    });
    swap();
  } catch (e) {
    await cloudDataPlane.deleteAppBlobsForAppVersion(appId, newVersion);
    return res.status(500).json({ ok: false, error: 'commit_failed', message: (e && e.message) || 'Could not save app.' });
  }

  // Record this deploy as an immutable version (the rollback manifest), then
  // RETAIN prior versions' bytes (pruned to the last KEEP_DEPLOYMENTS) so the
  // user can roll the app back to any of them with no re-upload — no GitHub,
  // no re-build. (Previously the prior version's blobs were dropped here.)
  const deployNote = (decodeHeader(req.headers['x-app-deploy-note']) || '').slice(0, 280) || null;
  recordDeployment(db, {
    appId, userId: u.id, version: newVersion, title, indexPath,
    totalBytes: result.totalBytes, fileCount: result.fileCount, files: result.files,
    note: deployNote, now,
  });
  pruneDeployments(db, appId).catch(() => {});

  // Attach to the IDE's project (if it sent one) so the app is co-managed.
  maybeLinkToProject(db, req, 'cloud_apps', appId, u.id);

  // Root-served vanity subdomain so a routed SPA renders (the /apps/<id>/ tier
  // blanks one). Best-effort; falls back to the sub-path URL if assignment fails.
  const vanity = assignVanitySubdomain(db, appId, u.id, title);
  if (vanity && typeof fetch === 'function') {
    // Warm Caddy's on-demand cert so the user's first open isn't a TLS stall.
    fetch(`https://${vanity}/`, { method: 'HEAD' }).catch(() => {});
  }
  const subpathUrl = `${publicOrigin()}/apps/${appId}/`;
  return res.status(mode === 'update' ? 200 : 201).json({
    ok: true,
    id: appId,
    url: vanity ? `https://${vanity}/` : subpathUrl,
    apps_url: subpathUrl,
    slug: vanity ? vanity.split('.')[0] : null,
  });
}

// Membership-aware access gate for a cloud app. Returns the row + caller role,
// or sends 404/403 and returns null. minRole is fail-closed (default owner).
function appAccess(db, req, res, minRole = 'owner') {
  const u = getUserFromRequest(db, req);
  if (!u) { res.status(401).json({ ok: false, error: 'unauthorized' }); return null; }
  const id = String(req.params.id || '');
  const access = resolveResourceAccess(db, { resourceTable: 'cloud_apps', resourceId: id, userId: u.id, minRole });
  if (!access.ok) {
    if (access.code === 'forbidden') { res.status(403).json({ ok: false, error: 'forbidden' }); return null; }
    res.status(404).json({ ok: false, error: 'app_not_found' }); return null;
  }
  return { user: u, row: access.row, role: access.role };
}

// On deploy, attach a fresh resource to the project named by the IDE's
// X-LingCode-Project-Id header — but only if the caller is an editor+ of it and
// the resource isn't already linked elsewhere. Best-effort; never throws.
function maybeLinkToProject(db, req, table, resourceId, userId) {
  const projectId = String(req.headers['x-lingcode-project-id'] || '').slice(0, 64);
  if (!projectId) return;
  const remote = String(req.headers['x-lingcode-git-remote'] || '').trim().slice(0, 500);
  const tbl = table === 'cloud_apps' ? 'cloud_apps' : 'cloud_workers';
  try {
    const role = projectRole(db, projectId, userId);
    if (role !== 'owner' && role !== 'editor') return;
    // Record the project's git remote (once) so a collaborator's clone can be
    // matched back to this project by remote even without the manifest.
    if (remote) {
      db.prepare("UPDATE projects SET git_remote = ? WHERE id = ? AND (git_remote IS NULL OR git_remote = '')").run(remote, projectId);
    }
    const row = db.prepare(`SELECT project_id FROM ${tbl} WHERE id = ?`).get(resourceId);
    if (row && !row.project_id) {
      db.prepare(`UPDATE ${tbl} SET project_id = ? WHERE id = ?`).run(projectId, resourceId);
    }
  } catch (_) { /* linking is best-effort */ }
}

// Tear down a deployed static app: DB rows + its stored blobs. Shared by the
// app DELETE route and the project-delete cascade (project-routes.js).
async function teardownApp(db, id) {
  db.transaction(() => {
    db.prepare('DELETE FROM cloud_app_files WHERE app_id = ?').run(id);
    db.prepare('DELETE FROM custom_domains WHERE app_id = ?').run(id);
    db.prepare('DELETE FROM cloud_apps WHERE id = ?').run(id);
  })();
  try { await cloudDataPlane.deleteAppBlobsForApp(id); } catch (_) { /* best-effort */ }
  return { ok: true };
}

// ── Management + custom-domain routes (auth: Bearer / session) ────────────
function registerCloudAppRoutes(app, db) {
  const jsonParser = express.json({ limit: '16kb' });

  // Create (new app) / Update (re-deploy in place; keeps id + attached domains).
  app.post('/api/account/cloud-apps', (req, res) => { handleUpload(db, req, res, 'create').catch((e) => res.status(500).json({ ok: false, error: 'server_error', message: e && e.message })); });
  app.put('/api/account/cloud-apps/:id', (req, res) => { handleUpload(db, req, res, 'update').catch((e) => res.status(500).json({ ok: false, error: 'server_error', message: e && e.message })); });

  // List the user's apps.
  app.get('/api/account/cloud-apps', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    // Owned apps PLUS apps in projects the user is a member of (shared).
    const rows = db.prepare(`
      SELECT DISTINCT ca.id, ca.title, ca.slug, ca.total_bytes, ca.file_count, ca.updated_at, ca.created_at,
        COALESCE(pm.role, CASE WHEN ca.user_id = @uid THEN 'owner' END) AS role
      FROM cloud_apps ca
      LEFT JOIN project_members pm ON ca.project_id = pm.project_id AND pm.user_id = @uid
      WHERE ca.user_id = @uid OR pm.user_id IS NOT NULL
      ORDER BY ca.created_at DESC
    `).all({ uid: u.id });
    const origin = publicOrigin();
    res.json({ ok: true, cap: APP_CAP_PER_USER, items: rows.map((r) => ({
      ...r,
      role: r.role || 'owner',
      hostname: r.slug ? `${r.slug}.${VANITY_APEX}` : null,
      // Prefer the root-served vanity subdomain (routed SPAs render there); the
      // /apps/<id>/ sub-path is the fallback for apps deployed before slugs.
      url: r.slug ? `https://${r.slug}.${VANITY_APEX}/` : `${origin}/apps/${r.id}/`,
    })) });
  });

  // Idempotently resolve (creating if needed) the project that backs this app,
  // so source-snapshot upload + collaborator sharing have a project to attach to.
  // Mirrors the cloud-workers ensure-project endpoint.
  app.post('/api/account/cloud-apps/:id/ensure-project', (req, res) => {
    const ctx = appAccess(db, req, res, 'owner'); if (!ctx) return;
    if (ctx.row.project_id) return res.json({ ok: true, project_id: ctx.row.project_id });
    const pid = crypto.randomUUID();
    const now = Date.now();
    db.transaction(() => {
      const name = String(ctx.row.title || ctx.row.id).slice(0, 120) || 'Project';
      db.prepare('INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(pid, ctx.user.id, name, now, now);
      db.prepare('INSERT INTO project_members (id, project_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), pid, ctx.user.id, 'owner', ctx.user.id, now);
      db.prepare('UPDATE cloud_apps SET project_id = ? WHERE id = ?').run(pid, ctx.row.id);
    })();
    res.status(201).json({ ok: true, project_id: pid });
  });

  // Delete an app (owner) — rows + blobs + attached domains.
  app.delete('/api/account/cloud-apps/:id', async (req, res) => {
    const ctx = appAccess(db, req, res, 'owner'); if (!ctx) return;
    await teardownApp(db, ctx.row.id);
    res.json({ ok: true });
  });

  // Deploy history — every deploy, newest first (viewer+). Each row is a
  // restorable version: what was deployed, how big, when, and any note.
  app.get('/api/account/cloud-apps/:id/deployments', (req, res) => {
    const ctx = appAccess(db, req, res, 'viewer'); if (!ctx) return;
    const rows = db.prepare(`SELECT id, version, status, total_bytes, file_count, source_version, note, created_at
                             FROM deployments WHERE app_id = ? ORDER BY version DESC`).all(ctx.row.id);
    res.json({ ok: true, current: ctx.row.version, retained: KEEP_DEPLOYMENTS, items: rows });
  });

  // Roll the app's CODE back to a retained version (editor+). Re-points the live
  // file manifest at that version's already-stored blobs and logs it as a new
  // forward version, so the rollback is itself reversible. Touches only the
  // served code — never the managed database's data.
  app.post('/api/account/cloud-apps/:id/rollback', jsonParser, (req, res) => {
    const ctx = appAccess(db, req, res, 'editor'); if (!ctx) return;
    const appId = ctx.row.id;
    const targetVersion = Number(req.body && req.body.version);
    if (!Number.isInteger(targetVersion)) return res.status(400).json({ ok: false, error: 'bad_version', message: 'Pass the version number to roll back to.' });
    if (targetVersion === ctx.row.version) return res.status(400).json({ ok: false, error: 'already_current', message: 'That version is already live.' });
    const target = db.prepare('SELECT * FROM deployments WHERE app_id = ? AND version = ?').get(appId, targetVersion);
    if (!target) return res.status(404).json({ ok: false, error: 'version_not_found', message: 'That version is no longer retained.' });
    let files;
    try { files = JSON.parse(target.files_json); } catch (_) { files = null; }
    if (!Array.isArray(files) || !files.length) return res.status(500).json({ ok: false, error: 'manifest_unavailable' });

    const now = Date.now();
    const newVersion = ctx.row.version + 1;
    try {
      db.transaction(() => {
        db.prepare('DELETE FROM cloud_app_files WHERE app_id = ?').run(appId);
        const ins = db.prepare('INSERT INTO cloud_app_files (app_id, path, content_type, byte_len, blob_key) VALUES (?,?,?,?,?)');
        for (const f of files) ins.run(appId, f.path, f.content_type, f.byte_len, f.blob_key);
        db.prepare('UPDATE cloud_apps SET version=?, total_bytes=?, file_count=?, index_path=?, updated_at=? WHERE id=?')
          .run(newVersion, target.total_bytes, target.file_count, target.index_path || ctx.row.index_path, now, appId);
        db.prepare("UPDATE deployments SET status='superseded' WHERE app_id=? AND status='live'").run(appId);
        db.prepare(`INSERT INTO deployments
            (id, app_id, user_id, version, status, title, index_path, total_bytes, file_count, files_json, source_version, note, created_at)
            VALUES (?,?,?,?, 'live', ?,?,?,?,?,?,?,?)`)
          .run(crypto.randomUUID(), appId, ctx.user.id, newVersion, target.title, target.index_path, target.total_bytes, target.file_count, target.files_json, target.version, `Rolled back to v${target.version}`, now);
      })();
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'rollback_failed', message: (e && e.message) || 'Could not roll back.' });
    }
    pruneDeployments(db, appId).catch(() => {});
    return res.json({ ok: true, version: newVersion, restored_from: target.version, url: `${publicOrigin()}/apps/${appId}/` });
  });

  // List an app's custom domains (owner).
  app.get('/api/account/cloud-apps/:id/custom-domains', (req, res) => {
    const ctx = appAccess(db, req, res, 'viewer'); if (!ctx) return;
    const id = ctx.row.id;
    const rows = db.prepare("SELECT domain, status, created_at FROM custom_domains WHERE app_id = ? ORDER BY created_at DESC").all(id);
    res.json({ ok: true, data: rows });
  });

  // Attach a customer-owned domain to an app (owner). Mirrors the prototype
  // attach in cloud-domains.js — same DNS-instructions response, so the Caddy
  // on-demand-TLS edge needs no change.
  app.post('/api/account/cloud-apps/:id/custom-domains', jsonParser, (req, res) => {
    const ctx = appAccess(db, req, res, 'editor'); if (!ctx) return;
    const u = ctx.user;
    const id = ctx.row.id;
    const domain = String((req.body && req.body.domain) || '').trim().toLowerCase().replace(/\.$/, '');
    if (!HOST_RE.test(domain)) return res.status(400).json({ ok: false, error: 'invalid_domain', message: 'Enter a valid domain like app.yoursite.com' });
    if (domain === 'lingcode.dev' || domain.endsWith('.lingcode.dev')) return res.status(400).json({ ok: false, error: 'reserved_domain' });
    const existing = db.prepare('SELECT user_id FROM custom_domains WHERE domain = ?').get(domain);
    if (existing) return res.status(409).json({ ok: false, error: 'domain_taken', message: 'That domain is already attached.' });
    const dnsFor = (d) => ({ cname: { name: d, value: 'apps.lingcode.dev' }, a: { name: d, value: '138.197.107.228' } });
    const attach = (d) => db.prepare("INSERT INTO custom_domains (domain, prototype_id, app_id, user_id, status, created_at) VALUES (?, '', ?, ?, 'active', ?)").run(d, id, u.id, new Date().toISOString());
    // App rows set app_id; prototype_id is '' (sentinel — the middleware branches on app_id first).
    attach(domain);
    // Convenience: also attach the apex↔www sibling so both forms work from one add.
    // Best-effort — a taken/invalid sibling silently no-ops and never fails the primary.
    const { siblingDomain } = require('./cloud-domains');
    const sib = siblingDomain(domain);
    const also = [];
    if (sib && HOST_RE.test(sib) && sib !== 'lingcode.dev' && !sib.endsWith('.lingcode.dev')
        && !db.prepare('SELECT 1 FROM custom_domains WHERE domain = ?').get(sib)) {
      attach(sib);
      also.push({ domain: sib, status: 'active', dns: dnsFor(sib) });
    }
    res.json({ ok: true, data: { domain, status: 'active', dns: dnsFor(domain), also: also } });
  });

  // Live status of an attached domain (owner). Resolves the domain's A records
  // (follows any CNAME) and reports whether it points at our edge yet — drives
  // the IDE's "Pending DNS → Verified" indicator. TLS is issued on-demand once
  // pointed=true, so that's the signal the domain is (about to be) live.
  app.get('/api/account/cloud-apps/:id/custom-domains/:domain/status', async (req, res) => {
    const ctx = appAccess(db, req, res, 'viewer'); if (!ctx) return;
    const id = ctx.row.id;
    const domain = String(req.params.domain || '').trim().toLowerCase();
    const row = db.prepare('SELECT 1 FROM custom_domains WHERE domain = ? AND app_id = ?').get(domain, id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });

    let addresses = [];
    try { addresses = await dns.resolve4(domain); } catch (_) { addresses = []; }
    const pointed = addresses.includes(EDGE_IP);
    res.json({ ok: true, domain, pointed, addresses, expected: EDGE_IP });
  });

  // Detach a domain (owner).
  app.delete('/api/account/cloud-apps/:id/custom-domains/:domain', (req, res) => {
    const ctx = appAccess(db, req, res, 'editor'); if (!ctx) return;
    const id = ctx.row.id;
    const domain = String(req.params.domain || '').trim().toLowerCase();
    const row = db.prepare('SELECT 1 FROM custom_domains WHERE domain = ? AND app_id = ?').get(domain, id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    db.prepare('DELETE FROM custom_domains WHERE domain = ?').run(domain);
    res.json({ ok: true });
  });
}

// Apps are served under the /apps/<id>/ sub-path, but a default Create-React-App
// or Vite build references its assets with ROOT-ABSOLUTE URLs (src="/static/..",
// href="/assets/..") that resolve against the domain root and 404 — so the page
// renders blank. Rewrite the entry document on serve: strip the leading slash off
// root-absolute src/href (leaving //cdn and http(s):// alone), then inject a
// <base href="/apps/<id>/"> so those now-relative URLs resolve at the sub-path.
// NOT applied to custom-domain serving (req._customDomain) — those serve at the
// domain root, where the original absolute paths are already correct.
function rewriteEntryHtmlForSubpath(html, id) {
  let out = html.replace(/(\s(?:src|href))="\/(?!\/)/gi, '$1="');
  const baseTag = `<base href="/apps/${id}/">`;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  else out = baseTag + out;
  return out;
}

// ── Public serving: GET /apps/:id/* with real sub-paths + SPA fallback ────
// MUST be registered AFTER installCustomDomainMiddleware so a custom-domain
// request rewritten to /apps/<id>/… is served here.
function registerCloudAppServingRoute(app, db) {
  // The wildcard route handles "/apps/<id>/" and every sub-path. Registered
  // FIRST so the trailing-slash form is served here (Express non-strict routing
  // would otherwise let the redirect below match it and loop).
  app.get('/apps/:id/*', async (req, res) => {
    const id = String(req.params.id || '');
    if (!UUID_RE.test(id)) return res.status(404).type('html').send(notFoundPage('App not found.'));
    const appRow = db.prepare('SELECT * FROM cloud_apps WHERE id = ?').get(id);
    if (!appRow) return res.status(404).type('html').send(notFoundPage('App not found, or deleted by the owner.'));
    if (Number(appRow.is_public) === 0) {
      const u = getUserFromRequest(db, req);
      if (!u || u.id !== appRow.user_id) return res.status(403).type('html').send(notFoundPage('This app is private.'));
    }

    const tail = req.params[0] || '';
    let rel = tail === '' ? appRow.index_path : normalizeRel(tail);
    if (rel === null) return res.status(404).type('text/plain').send('Not found');

    let fileRow = db.prepare('SELECT * FROM cloud_app_files WHERE app_id = ? AND path = ?').get(id, rel);
    let servedPath = rel;
    if (!fileRow) {
      const hasExt = /\.[a-z0-9]+$/i.test(rel);
      const wantsHtml = String(req.headers.accept || '').includes('text/html');
      // A missing hashed asset must 404 — never hand back index.html as JS
      // (that's the classic "Unexpected token '<'").
      if (hasExt && !wantsHtml) return res.status(404).type('text/plain').send('Not found');
      // SPA fallback: serve the entry document so client-side routes render.
      fileRow = db.prepare('SELECT * FROM cloud_app_files WHERE app_id = ? AND path = ?').get(id, appRow.index_path);
      servedPath = appRow.index_path;
      if (!fileRow) return res.status(404).type('html').send(notFoundPage('App entry missing.'));
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    const isHtml = String(fileRow.content_type || '').startsWith('text/html');
    const rewriteHtml = isHtml && !req._customDomain;                                         // sub-path base-path fix (see below)
    // `-b1` salts the ETag for sub-path HTML so browsers holding a pre-fix
    // (un-rewritten, blank) copy revalidate to a miss instead of a stale 304.
    const etag = `"${fileRow.byte_len}-${appRow.updated_at}-${servedPath}${rewriteHtml ? '-b1' : ''}"`;
    res.setHeader('ETag', etag);
    if (isHtml) res.setHeader('Cache-Control', 'no-cache');                                  // re-deploys picked up immediately
    else if (/^assets\//.test(servedPath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // Vite-hashed
    else res.setHeader('Cache-Control', 'public, max-age=3600');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    let bytes;
    try { bytes = await cloudDataPlane.getAppFileBlob(fileRow.blob_key); }
    catch (_) { return res.status(500).type('text/plain').send('Storage error'); }
    if (!bytes) return res.status(404).type('text/plain').send('Not found');

    if (rewriteHtml) bytes = Buffer.from(rewriteEntryHtmlForSubpath(bytes.toString('utf8'), id), 'utf8');
    res.setHeader('Content-Type', fileRow.content_type || 'application/octet-stream');
    res.setHeader('Content-Length', bytes.length);
    try { db.prepare('UPDATE cloud_apps SET last_opened_at = ? WHERE id = ?').run(Date.now(), id); } catch (_) {}
    return res.status(200).end(bytes);
  });

  // No trailing slash → redirect so relative asset URLs resolve against the app
  // root. Reached only for "/apps/<id>" (the wildcard route above already served
  // the trailing-slash form).
  app.get('/apps/:id', (req, res) => res.redirect(301, `/apps/${encodeURIComponent(req.params.id)}/`));
}

module.exports = { registerCloudAppRoutes, registerCloudAppServingRoute, teardownApp };
