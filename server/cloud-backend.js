'use strict';

// cloud-backend.js — LingCode Cloud control plane + Phase-1 data proxy.
//
//   Console (browser, session-authed) ──► /api/cloud/backends/...
//                                          provision / status / tables / sql
//   Generated app (iframe, anon-JWT)  ──► /api/cloud/be/:id/select|insert
//
// The console only ever talks to THIS server; the admin Postgres connection
// string + JWT secret live in cloud-data-plane.js and never reach a browser.
// Mirrors the auth/ownership/envelope conventions of secrets-vault.js and
// supabase-tools.js: { ok:true, data } / { ok:false, error, message, status }.

const crypto = require('crypto');
const { getUserFromRequest } = require('./auth-helpers');
const { resolveResourceAccess } = require('./project-access');
const dataPlane = require('./cloud-data-plane');
const cloudFunctions = require('./cloud-functions');
const { limitsForTier, assertUnderLimit, assertStorageRoom, storageUsedBytes, storageWarningLevel } = require('./cloud-limits');
const secretsVault = require('./secrets-vault');
const storage = require('./cloud-storage');
const functionsRuntime = require('./cloud-functions-runtime');
const fnInvoke = require('./cloud-fn-invoke');
const cloudPush = require('./cloud-push');
const cloudTelemetry = require('./cloud-telemetry');

const MAX_OBJECT_PATH = 256;

// ── Managed auth emails: built-in defaults + per-backend overrides ──────
// kind 'magiclink' | 'otp'. Owners can override subject/html per backend
// (backend_email_templates); {{link}}, {{code}}, {{email}} are substituted at
// send time. These defaults are the single source of truth for the GET route
// and the senders, so the console always shows the real default to start from.
const EMAIL_KINDS = ['magiclink', 'otp'];
const EMAIL_DEFAULTS = {
  magiclink: {
    subject: 'Your sign-in link',
    html: `<p>Click to sign in:</p><p><a href="{{link}}">Sign in</a></p>
<p>This link expires in 15 minutes. If you didn't request it, you can ignore this email.</p>
<p style="color:#666;font-size:12px;">{{link}}</p>`,
  },
  otp: {
    subject: 'Your sign-in code: {{code}}',
    html: `<p>Your sign-in code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">{{code}}</p>
<p>It expires in 10 minutes. If you didn't request it, you can ignore this email.</p>`,
  },
};
function applyTemplateVars(str, vars) {
  return String(str == null ? '' : str).replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}
// Resolve the effective subject/html for a managed email: per-backend override
// if present, else the built-in default; then substitute placeholders.
function resolveEmailTemplate(db, backendId, kind, vars) {
  let tpl = null;
  try { tpl = db.prepare('SELECT subject, html FROM backend_email_templates WHERE backend_id=? AND kind=?').get(backendId, kind); } catch (_) {}
  const base = tpl || EMAIL_DEFAULTS[kind];
  return { subject: applyTemplateVars(base.subject, vars), html: applyTemplateVars(base.html, vars) };
}

// Append a log line (capped ring buffer per backend) for the Logs tab.
function logEvent(db, backendId, source, level, message) {
  try {
    db.prepare('INSERT INTO backend_logs (backend_id, ts, source, level, message) VALUES (?, ?, ?, ?, ?)')
      .run(backendId, new Date().toISOString(), source, level, String(message || '').slice(0, 2000));
    // Keep only the most recent 500 rows per backend.
    db.prepare(`DELETE FROM backend_logs WHERE backend_id = ? AND id NOT IN (
      SELECT id FROM backend_logs WHERE backend_id = ? ORDER BY id DESC LIMIT 500
    )`).run(backendId, backendId);
  } catch { /* logging is best-effort */ }
}

// Per-user concurrency cap (same rationale as supabase-tools.js).
const MAX_PER_USER_INFLIGHT = 6;
const _inflight = new Map();
function _enter(id) { const c = _inflight.get(id) || 0; if (c >= MAX_PER_USER_INFLIGHT) return false; _inflight.set(id, c + 1); return true; }
function _exit(id) { const c = _inflight.get(id) || 0; if (c <= 1) _inflight.delete(id); else _inflight.set(id, c - 1); }

function ownsPrototype(db, prototypeId, userId) {
  return !!db.prepare('SELECT 1 FROM saved_prototypes WHERE id = ? AND user_id = ?').get(prototypeId, userId);
}
function getBackendByPrototype(db, prototypeId) {
  return db.prepare('SELECT * FROM prototype_backends WHERE prototype_id = ?').get(prototypeId);
}
function getBackendById(db, backendId) {
  return db.prepare('SELECT * FROM prototype_backends WHERE id = ?').get(backendId);
}
// Standalone (account/project) backend lookup.
function getAccountBackend(db, userId, projectKey) {
  return db.prepare('SELECT * FROM account_backends WHERE user_id = ? AND project_key = ?').get(userId, projectKey);
}
// Resolve a backend by its id across BOTH tables (the data plane + per-backend
// MCP route by id and must see prototype- and account-owned backends alike).
function getAnyBackendById(db, backendId) {
  return getBackendById(db, backendId) || db.prepare('SELECT * FROM account_backends WHERE id = ?').get(backendId);
}
// Public projection — never leak nothing sensitive (there's nothing secret on
// the row itself; anon_jwt is public-by-design).
function publicBackend(row) {
  if (!row) return null;
  return {
    backend_id: row.id, status: row.status, gateway_url: row.gateway_url,
    anon_key: row.anon_jwt, schema: row.schema_name, isolation: row.isolation,
    created_at: row.created_at,
  };
}

function bumpUsage(db, backendId, { read = 0, written = 0 } = {}) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO backend_usage (backend_id, day, db_rows_read, db_rows_written)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(backend_id, day) DO UPDATE SET
        db_rows_read = db_rows_read + excluded.db_rows_read,
        db_rows_written = db_rows_written + excluded.db_rows_written
    `).run(backendId, day, read, written);
  } catch { /* metering is best-effort */ }
}

// Daily managed-email quota: enforce the tier cap on today's count, then bump.
// Throws 402 quota_exceeded when over. Shared by send-email + magic-link.
function assertEmailQuotaAndBump(db, backendId, tier) {
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare('SELECT emails_sent FROM backend_usage WHERE backend_id = ? AND day = ?').get(backendId, day);
  assertUnderLimit(tier || 'free', 'maxEmailsPerDay', row ? row.emails_sent : 0);
  db.prepare(`INSERT INTO backend_usage (backend_id, day, emails_sent) VALUES (?, ?, 1)
    ON CONFLICT(backend_id, day) DO UPDATE SET emails_sent = emails_sent + 1`).run(backendId, day);
}

// HTML-escape for values interpolated into transactional email bodies.
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Console preflight: feature configured + user authed + owns the prototype.
// Returns { user, proto } or sends the response and returns null.
function consolePreflight(req, res, db, prototypeId) {
  if (!dataPlane.isConfigured()) {
    res.status(503).json({ ok: false, error: 'cloud_not_configured', message: 'LingCode Cloud is not configured on this server.' });
    return null;
  }
  const user = getUserFromRequest(db, req);
  if (!user) { res.status(401).json({ ok: false, error: 'unauthorized' }); return null; }
  if (!ownsPrototype(db, prototypeId, user.id)) {
    res.status(404).json({ ok: false, error: 'prototype_not_found', message: 'Save this prototype first.' });
    return null;
  }
  return { user };
}

function sendErr(res, err, route) {
  const status = (err && err.status) || 500;
  const httpStatus = status >= 400 && status < 500 ? status : 500;
  res.status(httpStatus).json({ ok: false, error: 'cloud_error', message: err?.message || `error during ${route}`, status });
}

// Provision (or return the existing live) backend. Two ownership modes share
// one code path — the data-plane provisioning (schema/role/anon-jwt) is identical:
//   - prototype: bound to a /try saved prototype  → prototype_backends
//   - account:   standalone (no prototypeId), keyed (userId, projectKey) → account_backends
// `table` is one of two hardcoded literals, never user input. Returns the public
// projection; throws on failure (caller maps to an HTTP error).
async function provisionBackend(db, { userId, tier, gatewayBase, prototypeId = null, projectKey = null, label = null }) {
  const account = !prototypeId;
  const table = account ? 'account_backends' : 'prototype_backends';
  const existing = account ? getAccountBackend(db, userId, projectKey) : getBackendByPrototype(db, prototypeId);
  // Keep the project name fresh (e.g. folder renamed) when reconnecting.
  if (account && existing && label) {
    try { db.prepare('UPDATE account_backends SET label = ? WHERE id = ?').run(String(label).slice(0, 120), existing.id); } catch (_) {}
  }
  if (existing && existing.status === 'live') return publicBackend(account ? getAccountBackend(db, userId, projectKey) : existing);

  const backendId = existing?.id || crypto.randomBytes(12).toString('hex');
  const now = new Date().toISOString();
  const schema = dataPlane.schemaName(backendId);
  const gatewayUrl = `${gatewayBase}/${backendId}`;

  if (!existing) {
    if (account) {
      db.prepare(`INSERT INTO account_backends
        (id, user_id, project_key, schema_name, status, tier, label, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'provisioning', ?, ?, ?, ?)`)
        .run(backendId, userId, projectKey, schema, tier || 'free', label ? String(label).slice(0, 120) : null, now, now);
    } else {
      db.prepare(`INSERT INTO prototype_backends
        (id, prototype_id, user_id, isolation, schema_name, status, tier, created_at, updated_at)
        VALUES (?, ?, ?, 'schema', ?, 'provisioning', ?, ?, ?)`)
        .run(backendId, prototypeId, userId, schema, tier || 'free', now, now);
    }
  } else {
    db.prepare(`UPDATE ${table} SET status='provisioning', updated_at=? WHERE id=?`).run(now, backendId);
  }

  try {
    await dataPlane.provisionBackend(backendId);
    const anonJwt = dataPlane.mintAnonJwt(backendId);
    db.prepare(`UPDATE ${table} SET status='live', anon_jwt=?, gateway_url=?, updated_at=? WHERE id=?`)
      .run(anonJwt, gatewayUrl, new Date().toISOString(), backendId);
    logEvent(db, backendId, 'control', 'info', 'Backend provisioned');
    return publicBackend(getAnyBackendById(db, backendId));
  } catch (provErr) {
    db.prepare(`UPDATE ${table} SET status='failed', updated_at=? WHERE id=?`).run(new Date().toISOString(), backendId);
    logEvent(db, backendId, 'control', 'error', `Provision failed: ${provErr.message}`);
    throw provErr;
  }
}

// Thin wrapper preserving the existing /try (prototype) call path.
async function provisionForPrototype(db, { prototypeId, userId, tier, gatewayBase }) {
  return provisionBackend(db, { prototypeId, userId, tier, gatewayBase });
}

// Tear down a managed backend completely (DATA LOSS): drop its Postgres schema,
// purge object storage, then remove the DB rows. Shared by the backend DELETE
// route and the project-delete cascade (project-routes.js). If the schema drop
// fails we abort and KEEP the rows so the backend stays manageable + retryable.
async function teardownBackend(db, id) {
  try {
    await dataPlane.dropBackend(id);
  } catch (e) {
    const error = `dropBackend failed: ${(e && e.message) || e}`;
    console.error('[cloud-backend] teardownBackend', id, error);
    return { ok: false, error };
  }
  if (storage.isConfigured()) {
    try { await storage.removePrefix(id); } catch (_) { /* best-effort; orphan swept later */ }
  }
  db.transaction(() => {
    db.prepare('DELETE FROM account_backends WHERE id = ?').run(id);
    db.prepare('DELETE FROM backend_oauth_providers WHERE backend_id = ?').run(id);
    db.prepare('DELETE FROM backend_objects WHERE backend_id = ?').run(id);
  })();
  return { ok: true };
}

/**
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
function registerCloudBackendRoutes(app, db) {
  // ── Provision a backend for a prototype ──────────────────────────────
  app.post('/api/cloud/backends', async (req, res) => {
    const prototypeId = String((req.body && req.body.prototype_id) || '');
    const ctx = consolePreflight(req, res, db, prototypeId); if (!ctx) return;
    if (!_enter(ctx.user.id)) return res.status(429).json({ ok: false, error: 'too_many_inflight' });
    try {
      const data = await provisionForPrototype(db, {
        prototypeId, userId: ctx.user.id, tier: ctx.user.tier,
        gatewayBase: `${req.protocol}://${req.get('host')}/api/cloud/be`,
      });
      res.json({ ok: true, data });
    } catch (err) {
      sendErr(res, err, 'provision');
    } finally { _exit(ctx.user.id); }
  });

  // ── Status ───────────────────────────────────────────────────────────
  app.get('/api/cloud/backends/:prototypeId', (req, res) => {
    const prototypeId = String(req.params.prototypeId || '');
    const ctx = consolePreflight(req, res, db, prototypeId); if (!ctx) return;
    const row = getBackendByPrototype(db, prototypeId);
    res.json({ ok: true, data: row ? publicBackend(row) : { status: 'none' } });
  });

  // ── Overview (status + table count + usage rollup) ───────────────────
  app.get('/api/cloud/backends/:prototypeId/overview', async (req, res) => {
    const prototypeId = String(req.params.prototypeId || '');
    const ctx = consolePreflight(req, res, db, prototypeId); if (!ctx) return;
    const row = getBackendByPrototype(db, prototypeId);
    if (!row || row.status !== 'live') return res.json({ ok: true, data: { status: row?.status || 'none' } });
    try {
      const tables = await dataPlane.listTables(row.id);
      const usage = db.prepare(`SELECT COALESCE(SUM(db_rows_read),0) AS reads, COALESCE(SUM(db_rows_written),0) AS writes FROM backend_usage WHERE backend_id = ?`).get(row.id);
      // Storage quota rollup: current bytes, the tier cap, and the 80/95% warning level
      // so the console can render "3.2 GB / 5 GB" + a near-limit banner.
      const lim = limitsForTier(row.tier || 'free');
      const storageUsed = storageUsedBytes(db, row.id);
      const maxStorageBytes = lim.maxStorageBytes;
      const storage = { storageUsedBytes: storageUsed, maxStorageBytes, storageWarning: storageWarningLevel(storageUsed, maxStorageBytes) };
      // Per-tier caps so the console can show usage-vs-quota bars (tables / users / files), not just storage.
      const limits = { maxTables: lim.maxTables, maxUsers: lim.maxUsers, maxObjects: lim.maxObjects, maxStorageBytes };
      res.json({ ok: true, data: { ...publicBackend(row), table_count: tables.length, usage: { ...usage, ...storage }, limits } });
    } catch (err) { sendErr(res, err, 'overview'); }
  });

  // ── Database: tables + rows ──────────────────────────────────────────
  app.get('/api/cloud/backends/:prototypeId/tables', async (req, res) => {
    const prototypeId = String(req.params.prototypeId || '');
    const ctx = consolePreflight(req, res, db, prototypeId); if (!ctx) return;
    const row = getBackendByPrototype(db, prototypeId);
    if (!row || row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    try { res.json({ ok: true, data: await dataPlane.listTables(row.id) }); }
    catch (err) { sendErr(res, err, 'tables'); }
  });

  app.get('/api/cloud/backends/:prototypeId/tables/:table/rows', async (req, res) => {
    const prototypeId = String(req.params.prototypeId || '');
    const ctx = consolePreflight(req, res, db, prototypeId); if (!ctx) return;
    const row = getBackendByPrototype(db, prototypeId);
    if (!row || row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    try {
      const data = await dataPlane.listRows(row.id, String(req.params.table || ''), {
        limit: req.query.limit, offset: req.query.offset,
      });
      bumpUsage(db, row.id, { read: data.rows.length });
      res.json({ ok: true, data });
    } catch (err) { sendErr(res, err, 'rows'); }
  });

  // ── SQL editor: read-only query + migration ──────────────────────────
  app.post('/api/cloud/backends/:prototypeId/sql/query', async (req, res) => {
    const prototypeId = String(req.params.prototypeId || '');
    const ctx = consolePreflight(req, res, db, prototypeId); if (!ctx) return;
    const row = getBackendByPrototype(db, prototypeId);
    if (!row || row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    const sql = (req.body && typeof req.body.sql === 'string') ? req.body.sql : '';
    if (!sql.trim()) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'sql required' });
    if (sql.length > 50_000) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'sql ≤ 50KB' });
    // Belt-and-braces read-only guard (the READ ONLY tx is the real backstop).
    const trimmed = sql.trim().replace(/^\(\s*/, '');
    if (!/^(select|with|table|explain|show)\s/i.test(trimmed)) {
      return res.status(400).json({ ok: false, error: 'read_only_violation', message: 'SQL editor is read-only here — use Run migration for writes.' });
    }
    try { res.json({ ok: true, data: await dataPlane.runReadOnlyQuery(row.id, sql) }); }
    catch (err) { sendErr(res, err, 'sql_query'); }
  });

  app.post('/api/cloud/backends/:prototypeId/sql/migrate', async (req, res) => {
    const prototypeId = String(req.params.prototypeId || '');
    const ctx = consolePreflight(req, res, db, prototypeId); if (!ctx) return;
    const row = getBackendByPrototype(db, prototypeId);
    if (!row || row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    const sql = (req.body && typeof req.body.sql === 'string') ? req.body.sql : '';
    if (!sql.trim()) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'sql required' });
    if (sql.length > 200_000) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'sql ≤ 200KB' });
    try {
      // Quota: cap tables per tier (checked pre-apply on CREATE TABLE).
      if (/create\s+table/i.test(sql)) {
        const tables = await dataPlane.listTables(row.id);
        assertUnderLimit(row.tier || 'free', 'maxTables', tables.length);
      }
      const data = await dataPlane.applyMigration(row.id, sql);
      bumpUsage(db, row.id, { written: 1 });
      logEvent(db, row.id, 'control', 'info', `Migration applied (${sql.length} bytes)`);
      res.json({ ok: true, data });
    } catch (err) { logEvent(db, row.id, 'control', 'error', `Migration failed: ${err.message}`); sendErr(res, err, 'sql_migrate'); }
  });

  // ── Account (standalone) backends console ────────────────────────────
  // Standalone backends provisioned from the IDE / account MCP have no
  // prototype row, so the prototype console can't reach them. These routes
  // key on backendId and verify ownership against account_backends.
  // `minRole` is fail-closed: it defaults to 'owner', so any route that forgets
  // to declare its level can only ever be reached by an owner — never a silent
  // privilege leak. Reads pass 'viewer', data mutations 'editor', security
  // config / destructive ops 'owner'. resolveResourceAccess maps a NULL
  // project_id (legacy solo backend) back to the direct user_id ownership check.
  function accountBackend(req, res, minRole = 'owner') {
    if (!dataPlane.isConfigured()) { res.status(503).json({ ok: false, error: 'cloud_not_configured' }); return null; }
    const user = getUserFromRequest(db, req);
    if (!user) { res.status(401).json({ ok: false, error: 'unauthorized' }); return null; }
    const backendId = String(req.params.backendId || '');
    const access = resolveResourceAccess(db, { resourceTable: 'account_backends', resourceId: backendId, userId: user.id, minRole });
    if (!access.ok) {
      if (access.code === 'forbidden') { res.status(403).json({ ok: false, error: 'forbidden' }); return null; }
      res.status(404).json({ ok: false, error: 'backend_not_found' }); return null;
    }
    return { user, row: access.row, role: access.role };
  }

  // List every standalone backend owned by the signed-in user.
  app.get('/api/cloud/account/backends', (req, res) => {
    if (!dataPlane.isConfigured()) return res.status(503).json({ ok: false, error: 'cloud_not_configured' });
    const user = getUserFromRequest(db, req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.set('Cache-Control', 'no-store');
    // Owned solo backends PLUS any backend whose project the user is a member of
    // (so a collaborator's console shows the shared backend). `role` distinguishes
    // owner from editor/viewer; legacy solo rows (no project_id) read as 'owner'.
    const rows = db.prepare(`
      SELECT DISTINCT ab.*,
        COALESCE(pm.role, CASE WHEN ab.user_id = @uid THEN 'owner' END) AS member_role
      FROM account_backends ab
      LEFT JOIN project_members pm ON ab.project_id = pm.project_id AND pm.user_id = @uid
      WHERE ab.user_id = @uid OR pm.user_id IS NOT NULL
      ORDER BY ab.created_at DESC
    `).all({ uid: user.id });
    res.json({ ok: true, data: rows.map((r) => ({ ...publicBackend(r), project_key: r.project_key, label: r.label, project_id: r.project_id, role: r.member_role || 'owner' })) });
  });

  // Rename a backend (owner) — sets the human-readable project label.
  app.patch('/api/cloud/account/backends/:backendId', (req, res) => {
    const ctx = accountBackend(req, res, "editor"); if (!ctx) return;
    const label = String((req.body && req.body.label) || '').trim().slice(0, 120);
    db.prepare('UPDATE account_backends SET label = ? WHERE id = ?').run(label || null, ctx.row.id);
    res.json({ ok: true, data: { label } });
  });

  // Eagerly provision (or reuse) the standalone backend for a project — called
  // by the IDE's "Connect Backend to This Project" so the backend exists (and
  // shows in the console) the moment you connect, not only on first agent use.
  // Idempotent per (user, project_key).
  app.post('/api/cloud/account/backends/provision', async (req, res) => {
    if (!dataPlane.isConfigured()) return res.status(503).json({ ok: false, error: 'cloud_not_configured' });
    const user = getUserFromRequest(db, req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const projectKey = String((req.body && req.body.project_key) || req.headers['x-lingcode-project'] || '').slice(0, 200);
    if (!projectKey) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'project_key required' });
    if (!_enter(user.id)) return res.status(429).json({ ok: false, error: 'too_many_inflight' });
    try {
      const data = await provisionBackend(db, {
        userId: user.id, tier: user.tier, projectKey,
        label: String((req.body && req.body.label) || '').trim().slice(0, 120) || null,
        gatewayBase: `${req.protocol}://${req.get('host')}/api/cloud/be`,
      });
      // Expose the backend's project_id (set by backfill or a prior link) so the
      // IDE can ADOPT an existing project instead of creating a duplicate.
      let projectId = null;
      if (data && data.backend_id) {
        const r = db.prepare('SELECT project_id FROM account_backends WHERE id = ?').get(data.backend_id);
        projectId = (r && r.project_id) || null;
      }
      res.json({ ok: true, data: { ...data, project_id: projectId } });
    } catch (err) { sendErr(res, err, 'account_provision'); }
    finally { _exit(user.id); }
  });

  app.get('/api/cloud/account/backends/:backendId/overview', async (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.json({ ok: true, data: { status: ctx.row.status } });
    try {
      const tables = await dataPlane.listTables(ctx.row.id);
      const usage = db.prepare(`SELECT COALESCE(SUM(db_rows_read),0) AS reads, COALESCE(SUM(db_rows_written),0) AS writes FROM backend_usage WHERE backend_id = ?`).get(ctx.row.id);
      // Exact total rows across all tables (admin count; a few small tables on the
      // dashboard, so the per-table count(*) fan-out is fine).
      let totalRows = 0;
      try { const counts = await Promise.all(tables.map((t) => dataPlane.countRows(ctx.row.id, t.name).catch(() => 0))); totalRows = counts.reduce((a, n) => a + (n || 0), 0); } catch (_) {}
      res.json({ ok: true, data: { ...publicBackend(ctx.row), project_key: ctx.row.project_key, table_count: tables.length, total_rows: totalRows, usage } });
    } catch (err) { sendErr(res, err, 'account_overview'); }
  });

  app.get('/api/cloud/account/backends/:backendId/tables', async (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    try { res.json({ ok: true, data: await dataPlane.listTables(ctx.row.id) }); }
    catch (err) { sendErr(res, err, 'account_tables'); }
  });

  app.get('/api/cloud/account/backends/:backendId/tables/:table/rows', async (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    try {
      // admin scope: the owner sees ALL rows of THEIR OWN backend (RLS bypassed,
      // scoped to this backend's schema) — like a table editor.
      const table = String(req.params.table || '');
      const order = req.query.order ? { column: String(req.query.order), ascending: String(req.query.dir || 'asc') !== 'desc' } : null;
      const data = await dataPlane.proxySelect(ctx.row.id, table, {
        limit: req.query.limit, offset: req.query.offset, order, admin: true,
      });
      let primaryKey = [];
      try { primaryKey = await dataPlane.primaryKeyColumns(ctx.row.id, table); } catch (_) {}
      let total = data.rows.length;
      try { total = await dataPlane.countRows(ctx.row.id, table); } catch (_) {}
      bumpUsage(db, ctx.row.id, { read: data.rows.length });
      res.json({ ok: true, data: { ...data, primary_key: primaryKey, total } });
    } catch (err) { sendErr(res, err, 'account_rows'); }
  });

  // ── Admin row writes (owner only, RLS bypassed within own schema) ────
  app.post('/api/cloud/account/backends/:backendId/tables/:table/rows', async (req, res) => {
    const ctx = accountBackend(req, res, "editor"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    try {
      const data = await dataPlane.proxyInsert(ctx.row.id, String(req.params.table || ''), req.body && req.body.row, { admin: true });
      logEvent(db, ctx.row.id, 'audit', 'info', `INSERT ${String(req.params.table || '')} (${data.rows.length} row) by ${ctx.user.email || ctx.user.id}`);
      res.json({ ok: true, data: data.rows });
    } catch (err) { sendErr(res, err, 'account_row_insert'); }
  });

  app.patch('/api/cloud/account/backends/:backendId/tables/:table/rows', async (req, res) => {
    const ctx = accountBackend(req, res, "editor"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    try {
      const data = await dataPlane.proxyUpdate(ctx.row.id, String(req.params.table || ''), {
        where: req.body && req.body.where, patch: req.body && req.body.patch, admin: true,
      });
      logEvent(db, ctx.row.id, 'audit', 'info', `UPDATE ${String(req.params.table || '')} (${data.rows.length} rows) by ${ctx.user.email || ctx.user.id}`);
      res.json({ ok: true, data: data.rows });
    } catch (err) { sendErr(res, err, 'account_row_update'); }
  });

  app.delete('/api/cloud/account/backends/:backendId/tables/:table/rows', async (req, res) => {
    const ctx = accountBackend(req, res, "editor"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    try {
      const data = await dataPlane.proxyDelete(ctx.row.id, String(req.params.table || ''), {
        where: req.body && req.body.where, admin: true,
      });
      logEvent(db, ctx.row.id, 'audit', 'info', `DELETE ${String(req.params.table || '')} (${data.rows.length} rows) by ${ctx.user.email || ctx.user.id}`);
      res.json({ ok: true, data: data.rows });
    } catch (err) { sendErr(res, err, 'account_row_delete'); }
  });

  // ── Run a migration from the console (owner) ─────────────────────────
  app.post('/api/cloud/account/backends/:backendId/sql/migrate', async (req, res) => {
    const ctx = accountBackend(req, res, "editor"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    const sql = (req.body && typeof req.body.sql === 'string') ? req.body.sql : '';
    if (!sql.trim()) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'sql required' });
    if (sql.length > 200_000) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'sql ≤ 200KB' });
    try {
      if (/create\s+table/i.test(sql)) {
        const tables = await dataPlane.listTables(ctx.row.id);
        assertUnderLimit(ctx.row.tier || 'free', 'maxTables', tables.length);
      }
      const data = await dataPlane.applyMigration(ctx.row.id, sql);
      logEvent(db, ctx.row.id, 'control', 'info', `Console migration (${sql.length} bytes)`);
      res.json({ ok: true, data });
    } catch (err) { logEvent(db, ctx.row.id, 'control', 'error', `Console migration failed: ${err.message}`); sendErr(res, err, 'account_sql_migrate'); }
  });

  // ── Tenant users: list + delete (owner) ──────────────────────────────
  app.get('/api/cloud/account/backends/:backendId/users', async (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    try { res.json({ ok: true, data: await dataPlane.listTenantUsers(ctx.row.id) }); }
    catch (err) { sendErr(res, err, 'account_users'); }
  });

  app.delete('/api/cloud/account/backends/:backendId/users/:userId', async (req, res) => {
    const ctx = accountBackend(req, res, "editor"); if (!ctx) return;
    try {
      await dataPlane.deleteTenantUser(ctx.row.id, String(req.params.userId || ''));
      logEvent(db, ctx.row.id, 'audit', 'info', `tenant user ${String(req.params.userId || '')} deleted by ${ctx.user.email || ctx.user.id}`);
      res.json({ ok: true });
    } catch (err) { sendErr(res, err, 'account_user_delete'); }
  });

  // ── Delete the backend (owner; drops schema + role, then the row) ────
  app.delete('/api/cloud/account/backends/:backendId', async (req, res) => {
    const ctx = accountBackend(req, res, "owner"); if (!ctx) return;
    try {
      logEvent(db, ctx.row.id, 'audit', 'info', `backend deleted by ${ctx.user.email || ctx.user.id}`);
      const r = await teardownBackend(db, ctx.row.id);
      if (!r.ok) return sendErr(res, new Error(r.error || 'backend_delete_failed'), 'account_backend_delete');
      res.json({ ok: true });
    } catch (err) { sendErr(res, err, 'account_backend_delete'); }
  });

  // Read-only SQL on a standalone backend (mirrors the prototype console).
  app.post('/api/cloud/account/backends/:backendId/sql/query', async (req, res) => {
    const ctx = accountBackend(req, res, "editor"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    const sql = (req.body && typeof req.body.sql === 'string') ? req.body.sql : '';
    if (!sql.trim()) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'sql required' });
    if (sql.length > 50_000) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'sql ≤ 50KB' });
    const trimmed = sql.trim().replace(/^\(\s*/, '');
    if (!/^(select|with|table|explain|show)\s/i.test(trimmed)) {
      return res.status(400).json({ ok: false, error: 'read_only_violation', message: 'SQL editor is read-only here.' });
    }
    try { res.json({ ok: true, data: await dataPlane.runReadOnlyQuery(ctx.row.id, sql) }); }
    catch (err) { sendErr(res, err, 'account_sql_query'); }
  });

  // ── Column metadata for the schema editor + typed inputs (owner) ─────
  app.get('/api/cloud/account/backends/:backendId/tables/:table/columns', async (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    try { res.json({ ok: true, data: await dataPlane.columnsOf(ctx.row.id, String(req.params.table || '')) }); }
    catch (err) { sendErr(res, err, 'account_columns'); }
  });

  // ── Rich schema introspection for the table/schema editor (owner) ────
  // pg_catalog-sourced detail beyond the basic /columns shape: identity,
  // generated, uniqueness, CHECK, enums, comments, plus policies/indexes/FKs.
  app.get('/api/cloud/account/backends/:backendId/tables/:table/columns/details', async (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    try { res.json({ ok: true, data: await dataPlane.tableColumns(ctx.row.id, String(req.params.table || '')) }); }
    catch (err) { sendErr(res, err, 'account_columns_details'); }
  });

  app.get('/api/cloud/account/backends/:backendId/tables/:table/policies', async (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    try { res.json({ ok: true, data: await dataPlane.policiesOf(ctx.row.id, String(req.params.table || '')) }); }
    catch (err) { sendErr(res, err, 'account_policies'); }
  });

  app.get('/api/cloud/account/backends/:backendId/tables/:table/indexes', async (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    try { res.json({ ok: true, data: await dataPlane.indexesOf(ctx.row.id, String(req.params.table || '')) }); }
    catch (err) { sendErr(res, err, 'account_indexes'); }
  });

  app.get('/api/cloud/account/backends/:backendId/tables/:table/foreign-keys', async (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    try { res.json({ ok: true, data: await dataPlane.foreignKeysOf(ctx.row.id, String(req.params.table || '')) }); }
    catch (err) { sendErr(res, err, 'account_foreign_keys'); }
  });

  // Schema advisors — security + performance lints across the whole backend.
  app.get('/api/cloud/account/backends/:backendId/advisors', async (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    try { res.json({ ok: true, data: await dataPlane.advisorsFor(ctx.row.id) }); }
    catch (err) { sendErr(res, err, 'account_advisors'); }
  });

  // ── Storage: list / upload / delete objects (owner, session-authed) ──
  app.get('/api/cloud/account/backends/:backendId/storage/objects', (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    const objs = db.prepare('SELECT bucket, path, content_type, bytes, created_at FROM backend_objects WHERE backend_id = ? ORDER BY created_at DESC LIMIT 500').all(ctx.row.id);
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, data: objs.map((o) => ({ ...o, url: `${origin}/api/cloud/be/${ctx.row.id}/storage/object?bucket=${encodeURIComponent(o.bucket)}&path=${encodeURIComponent(o.path)}` })) });
  });

  // Owner upload — writes straight to backend_objects (admin file manager), so
  // the console never needs the public anon-key path. Mirrors the anon upload's
  // size/quota checks (limitsForTier, maxObjects).
  app.post('/api/cloud/account/backends/:backendId/storage/objects', async (req, res) => {
    const ctx = accountBackend(req, res, "editor"); if (!ctx) return;
    const { bucket = 'public', path, content_type, data_b64 } = req.body || {};
    if (!path || typeof path !== 'string' || path.length > MAX_OBJECT_PATH) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'path required (≤256 chars)' });
    if (typeof data_b64 !== 'string' || !data_b64) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'data_b64 required' });
    const bytes = Math.ceil(data_b64.length * 3 / 4);
    const limit = limitsForTier(ctx.row.tier || 'free');
    if (bytes > limit.maxObjectBytes) return res.status(413).json({ ok: false, error: 'object_too_large', message: `max ${limit.maxObjectBytes} bytes` });
    try {
      const count = db.prepare('SELECT COUNT(*) AS n FROM backend_objects WHERE backend_id = ?').get(ctx.row.id).n;
      const prev = db.prepare('SELECT bytes FROM backend_objects WHERE backend_id=? AND bucket=? AND path=?').get(ctx.row.id, bucket, path);
      if (!prev) assertUnderLimit(ctx.row.tier || 'free', 'maxObjects', count);
      // Total-storage cap (net delta on replace-in-place).
      assertStorageRoom(db, ctx.row.id, ctx.row.tier || 'free', bytes - ((prev && prev.bytes) || 0));
      await persistObject(db, ctx.row.id, bucket, path, content_type, data_b64, bytes);
      bumpUsageStorage(db, ctx.row.id);
      res.json({ ok: true, data: { bucket, path, bytes, url: objectUrl(req, ctx.row.id, bucket, path) } });
    } catch (err) { sendErr(res, err, 'account_storage_upload'); }
  });

  app.delete('/api/cloud/account/backends/:backendId/storage/objects', async (req, res) => {
    const ctx = accountBackend(req, res, "editor"); if (!ctx) return;
    const bucket = String((req.body && req.body.bucket) || 'public');
    const path = String((req.body && req.body.path) || '');
    if (!path) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'path required' });
    if (storage.isConfigured()) { try { await storage.removeObject(ctx.row.id, bucket, path); } catch (_) { /* metadata delete still proceeds */ } }
    db.prepare('DELETE FROM backend_objects WHERE backend_id=? AND bucket=? AND path=?').run(ctx.row.id, bucket, path);
    bumpUsageStorage(db, ctx.row.id);
    res.json({ ok: true });
  });

  // ── Logs: recent backend events (owner) ─────────────────────────────
  app.get('/api/cloud/account/backends/:backendId/logs', (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    const logs = db.prepare('SELECT ts, source, level, message FROM backend_logs WHERE backend_id = ? ORDER BY id DESC LIMIT 200').all(ctx.row.id);
    res.json({ ok: true, data: logs });
  });

  // ── Usage: daily series for charts (owner) ──────────────────────────
  app.get('/api/cloud/account/backends/:backendId/usage', (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 30));
    const rows = db.prepare(`SELECT day, db_rows_read, db_rows_written, emails_sent
      FROM backend_usage WHERE backend_id = ? ORDER BY day DESC LIMIT ?`).all(ctx.row.id, days);
    res.json({ ok: true, data: rows.reverse() });
  });

  // ── Email templates: read / override / reset the managed auth emails ─
  app.get('/api/cloud/account/backends/:backendId/email-templates', (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    const out = EMAIL_KINDS.map((kind) => {
      let row = null;
      try { row = db.prepare('SELECT subject, html, updated_at FROM backend_email_templates WHERE backend_id=? AND kind=?').get(ctx.row.id, kind); } catch (_) {}
      return {
        kind,
        subject: row ? row.subject : EMAIL_DEFAULTS[kind].subject,
        html: row ? row.html : EMAIL_DEFAULTS[kind].html,
        default_subject: EMAIL_DEFAULTS[kind].subject,
        default_html: EMAIL_DEFAULTS[kind].html,
        is_custom: !!row,
        updated_at: row ? row.updated_at : null,
        placeholders: kind === 'otp' ? ['{{code}}', '{{email}}'] : ['{{link}}', '{{email}}'],
      };
    });
    res.json({ ok: true, data: out });
  });

  app.put('/api/cloud/account/backends/:backendId/email-templates/:kind', (req, res) => {
    const ctx = accountBackend(req, res, "owner"); if (!ctx) return;
    const kind = String(req.params.kind || '');
    if (EMAIL_KINDS.indexOf(kind) < 0) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'kind must be magiclink or otp' });
    const subject = String((req.body && req.body.subject) || '').trim();
    const html = String((req.body && req.body.html) || '').trim();
    if (!subject || !html) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'subject and html required' });
    if (subject.length > 300 || html.length > 50_000) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'subject ≤300 chars, html ≤50KB' });
    // Guard against breaking the email: the link/code placeholder must survive.
    const required = kind === 'otp' ? '{{code}}' : '{{link}}';
    if (html.indexOf(required) < 0) return res.status(400).json({ ok: false, error: 'invalid_request', message: `html must include the ${required} placeholder` });
    db.prepare(`INSERT INTO backend_email_templates (backend_id, kind, subject, html, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(backend_id, kind) DO UPDATE SET subject=excluded.subject, html=excluded.html, updated_at=excluded.updated_at`)
      .run(ctx.row.id, kind, subject, html, new Date().toISOString());
    logEvent(db, ctx.row.id, 'auth', 'info', `Email template '${kind}' updated`);
    res.json({ ok: true });
  });

  app.delete('/api/cloud/account/backends/:backendId/email-templates/:kind', (req, res) => {
    const ctx = accountBackend(req, res, "owner"); if (!ctx) return;
    db.prepare('DELETE FROM backend_email_templates WHERE backend_id=? AND kind=?').run(ctx.row.id, String(req.params.kind || ''));
    logEvent(db, ctx.row.id, 'audit', 'info', `email template '${String(req.params.kind || '')}' reset by ${ctx.user.email || ctx.user.id}`);
    res.json({ ok: true });
  });

  // ── Auth settings: toggle whether this backend requires MFA (owner) ──
  // Default off; when on, the data proxy rejects user tokens below aal2.
  app.get('/api/cloud/account/backends/:backendId/auth-settings', (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    const row = db.prepare('SELECT mfa_required FROM backend_auth_settings WHERE backend_id = ?').get(ctx.row.id);
    res.json({ ok: true, data: { mfa_required: !!(row && row.mfa_required) } });
  });

  app.put('/api/cloud/account/backends/:backendId/auth-settings', (req, res) => {
    const ctx = accountBackend(req, res, "owner"); if (!ctx) return;
    const mfaRequired = (req.body && req.body.mfa_required) ? 1 : 0;
    db.prepare(`INSERT INTO backend_auth_settings (backend_id, mfa_required, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(backend_id) DO UPDATE SET mfa_required = excluded.mfa_required, updated_at = excluded.updated_at`)
      .run(ctx.row.id, mfaRequired, new Date().toISOString());
    logEvent(db, ctx.row.id, 'auth', 'info', `MFA requirement ${mfaRequired ? 'enabled' : 'disabled'}`);
    res.json({ ok: true, data: { mfa_required: !!mfaRequired } });
  });

  // ── Secrets: 3rd-party API keys for function templates (owner only) ──
  // Values are AES-256-GCM encrypted at rest and never returned over HTTP.
  app.get('/api/cloud/account/backends/:backendId/secrets', (req, res) => {
    const ctx = accountBackend(req, res, "owner"); if (!ctx) return;
    if (!secretsVault.isConfigured()) return res.status(503).json({ ok: false, error: 'vault_not_configured' });
    res.json({ ok: true, data: secretsVault.listBackendSecretMeta(db, ctx.row.id) });
  });

  app.put('/api/cloud/account/backends/:backendId/secrets/:key', (req, res) => {
    const ctx = accountBackend(req, res, "owner"); if (!ctx) return;
    if (!secretsVault.isConfigured()) return res.status(503).json({ ok: false, error: 'vault_not_configured' });
    const key = String(req.params.key || '');
    if (!secretsVault.KEY_PATTERN.test(key)) return res.status(400).json({ ok: false, error: 'invalid_key', message: 'Key must match /^[A-Z][A-Z0-9_]{0,63}$/.' });
    const value = req.body && typeof req.body.value === 'string' ? req.body.value : null;
    if (value === null) return res.status(400).json({ ok: false, error: 'invalid_request', message: '`value` (string) required' });
    if (Buffer.byteLength(value, 'utf8') > secretsVault.MAX_VALUE_BYTES) return res.status(413).json({ ok: false, error: 'value_too_large' });
    // kind: 'secret' (default, masked) | 'var' (non-sensitive config, readable back).
    const kind = req.body && req.body.kind === 'var' ? 'var' : 'secret';
    const existing = db.prepare('SELECT COUNT(*) AS n FROM backend_secrets WHERE backend_id = ?').get(ctx.row.id).n;
    const replacing = !!db.prepare('SELECT 1 FROM backend_secrets WHERE backend_id = ? AND key = ?').get(ctx.row.id, key);
    if (!replacing && existing >= secretsVault.MAX_PER_BACKEND) return res.status(409).json({ ok: false, error: 'too_many_secrets', message: `max ${secretsVault.MAX_PER_BACKEND} secrets` });
    try { secretsVault.setBackendSecret(db, ctx.row.id, key, value, kind); logEvent(db, ctx.row.id, 'control', 'info', `${kind === 'var' ? 'Var' : 'Secret'} ${key} set`); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ ok: false, error: 'encrypt_failed', message: err.message }); }
  });

  // Read-back plaintext for a non-sensitive 'var' only (true secrets stay write-only).
  app.get('/api/cloud/account/backends/:backendId/secrets/:key/value', (req, res) => {
    const ctx = accountBackend(req, res, "owner"); if (!ctx) return;
    const value = secretsVault.readBackendVar(db, ctx.row.id, String(req.params.key || ''));
    if (value === null) return res.status(404).json({ ok: false, error: 'not_a_var', message: 'Only non-secret vars can be read back.' });
    res.json({ ok: true, data: { value } });
  });

  app.delete('/api/cloud/account/backends/:backendId/secrets/:key', (req, res) => {
    const ctx = accountBackend(req, res, "owner"); if (!ctx) return;
    const removed = secretsVault.deleteBackendSecret(db, ctx.row.id, String(req.params.key || ''));
    if (removed) logEvent(db, ctx.row.id, 'audit', 'info', `secret ${String(req.params.key || '')} deleted by ${ctx.user.email || ctx.user.id}`);
    res.json({ ok: true, data: { removed } });
  });

  // ── Egress allow-list for the http-fetch template (owner only) ──────
  app.get('/api/cloud/account/backends/:backendId/fetch-hosts', (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    const row = db.prepare('SELECT allowed_fetch_hosts FROM backend_auth_settings WHERE backend_id = ?').get(ctx.row.id);
    const hosts = (row && row.allowed_fetch_hosts) ? String(row.allowed_fetch_hosts).split(',').map((s) => s.trim()).filter(Boolean) : [];
    res.json({ ok: true, data: { hosts } });
  });

  app.put('/api/cloud/account/backends/:backendId/fetch-hosts', (req, res) => {
    const ctx = accountBackend(req, res, "owner"); if (!ctx) return;
    const raw = req.body && req.body.hosts;
    const arr = Array.isArray(raw) ? raw : String(raw || '').split(',');
    // Validate each as a bare hostname (no scheme/path/port); reject IP literals.
    const HOST_RE = /^(?=.{1,253}$)([a-z0-9](-?[a-z0-9]+)*\.)+[a-z]{2,}$/i;
    const hosts = []; const seen = new Set();
    for (let h of arr) {
      h = String(h || '').trim().toLowerCase().replace(/\.$/, '');
      if (!h || seen.has(h)) continue;
      if (require('net').isIP(h) || !HOST_RE.test(h)) return res.status(400).json({ ok: false, error: 'invalid_host', message: `Not a valid domain: ${h}` });
      seen.add(h); hosts.push(h);
    }
    if (hosts.length > 50) return res.status(400).json({ ok: false, error: 'too_many_hosts', message: 'max 50 hosts' });
    db.prepare(`INSERT INTO backend_auth_settings (backend_id, allowed_fetch_hosts, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(backend_id) DO UPDATE SET allowed_fetch_hosts = excluded.allowed_fetch_hosts, updated_at = excluded.updated_at`)
      .run(ctx.row.id, hosts.join(','), new Date().toISOString());
    logEvent(db, ctx.row.id, 'control', 'info', `Fetch allow-list updated (${hosts.length} host${hosts.length === 1 ? '' : 's'})`);
    res.json({ ok: true, data: { hosts } });
  });

  // ── pgvector similarity search over the owner's own rows (admin scope) ─
  app.post('/api/cloud/account/backends/:backendId/vector/search', async (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    const { table, column, embedding, limit, metric } = req.body || {};
    if (!table || !column) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'table and column required' });
    try {
      const data = await dataPlane.vectorSearch(ctx.row.id, { table, column, embedding, limit, metric, admin: true });
      res.json({ ok: true, data });
    } catch (err) { sendErr(res, err, 'account_vector_search'); }
  });

  // Owner-scope full-text + hybrid search (RLS bypassed within own schema).
  // Owner-scope managed embeddings — lets the console embed query text for the
  // hybrid-search box without the caller handling raw vectors.
  app.post('/api/cloud/account/backends/:backendId/vector/embed', async (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    return sendEmbed(res, managedEmbed(req.body && req.body.input), ctx.row.id);
  });

  app.post('/api/cloud/account/backends/:backendId/search/text', async (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    const { table, column, query, is_tsvector, limit } = req.body || {};
    if (!table || !column || !query) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'table, column, query required' });
    try {
      const data = await dataPlane.textSearch(ctx.row.id, { table, column, query, isTsvector: !!is_tsvector, limit, admin: true });
      res.json({ ok: true, data });
    } catch (err) { sendErr(res, err, 'account_text_search'); }
  });

  app.post('/api/cloud/account/backends/:backendId/search/hybrid', async (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    if (ctx.row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    const b = req.body || {};
    if (!b.table || !b.text_column || !b.vector_column || !b.query || !b.embedding) {
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'table, text_column, vector_column, query, embedding required' });
    }
    try {
      const data = await dataPlane.hybridSearch(ctx.row.id, {
        table: b.table, textColumn: b.text_column, vectorColumn: b.vector_column,
        query: b.query, embedding: b.embedding, idColumn: b.id_column || null,
        textIsTsvector: !!b.text_is_tsvector, metric: b.metric, limit: b.limit,
        fullTextWeight: b.full_text_weight, semanticWeight: b.semantic_weight, rrfK: b.rrf_k,
        admin: true,
      });
      res.json({ ok: true, data });
    } catch (err) { sendErr(res, err, 'account_hybrid_search'); }
  });

  // ── Realtime tail (owner SSE, admin scope — sees every row) ──────────
  app.get('/api/cloud/account/backends/:backendId/realtime', (req, res) => {
    const ctx = accountBackend(req, res, "viewer"); if (!ctx) return;
    const wanted = String((req.query && req.query.table) || '').split(',').map((s) => s.trim()).filter(Boolean);
    const tableSet = wanted.length ? new Set(wanted) : null;
    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache, no-transform');
    res.set('Connection', 'keep-alive');
    res.set('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');
    const onChange = (ev) => {
      if (ev.backendId !== ctx.row.id) return;
      if (tableSet && !tableSet.has(ev.table)) return;
      // oversized = row body dropped (too big for NOTIFY); client should refetch.
      try { res.write(`event: change\ndata: ${JSON.stringify({ table: ev.table, type: ev.type, row: ev.row, oversized: ev.oversized || undefined })}\n\n`); } catch (_) {}
    };
    dataPlane.ensureRealtimeListener();
    dataPlane.realtimeBus.on('change', onChange);
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
    const cleanup = () => { clearInterval(heartbeat); dataPlane.realtimeBus.removeListener('change', onChange); };
    req.on('close', cleanup);
    req.on('aborted', cleanup);
  });

  // ── Data proxy for generated apps (anon-JWT, no session) ─────────────
  // CORS: the preview iframe is sandboxed (opaque origin); auth is via the
  // bearer anon key, never cookies, so ACAO:* is safe.
  function cors(res) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  }
  app.options('/api/cloud/be/:backendId/*', (_req, res) => { cors(res); res.sendStatus(204); });

  function backendRequiresMfa(backendId) {
    try {
      const r = db.prepare('SELECT mfa_required FROM backend_auth_settings WHERE backend_id = ?').get(backendId);
      return !!(r && r.mfa_required);
    } catch (_) { return false; }
  }

  // opts.allowAal1: skip MFA enforcement so a signed-in user can still reach the
  // enroll/verify/refresh/signout routes before they have an aal2 token. Data
  // routes use the default (enforce) — when the backend requires MFA, a user
  // token below aal2 is rejected with 403 mfa_required.
  function proxyAuth(req, res, opts = {}) {
    cors(res);
    if (!dataPlane.isConfigured()) { res.status(503).json({ ok: false, error: 'cloud_not_configured' }); return null; }
    const backendId = String(req.params.backendId || '');
    const row = getAnyBackendById(db, backendId); // prototype- or account-owned
    if (!row || row.status !== 'live') { res.status(404).json({ ok: false, error: 'backend_not_found' }); return null; }
    const auth = req.headers.authorization || '';
    // Header bearer for fetch/XHR clients; ?apikey= query fallback for the
    // browser EventSource API (which can't set an Authorization header).
    const token = (auth.startsWith('Bearer ') ? auth.slice(7).trim() : '')
      || String((req.query && (req.query.apikey || req.query.token)) || '').trim();
    if (!token) { res.status(401).json({ ok: false, error: 'missing_anon_key' }); return null; }
    let claims;
    try { claims = dataPlane.verifyTenantJwt(backendId, token); }
    catch { res.status(403).json({ ok: false, error: 'invalid_token' }); return null; }
    const userId = claims.sub || null;
    if (userId && !opts.allowAal1 && claims.aal !== 'aal2' && backendRequiresMfa(backendId)) {
      res.status(403).json({ ok: false, error: 'mfa_required', message: 'Multi-factor authentication required.' });
      return null;
    }
    return { backendId, row, userId, aal: claims.aal || 'aal1' };
  }

  // Seconds in the access-token lifetime, mirroring CLOUD_ACCESS_TOKEN_TTL
  // (default '7d', see cloud-data-plane.accessTokenTtl) so clients know when to
  // refresh. Operators set this to '1h' once the refresh-capable SDK propagates.
  function ttlSeconds() {
    const m = /^(\d+)\s*(s|m|h|d)$/.exec((process.env.CLOUD_ACCESS_TOKEN_TTL || '7d').trim());
    if (!m) return 7 * 86400;
    const n = parseInt(m[1], 10);
    return n * (m[2] === 's' ? 1 : m[2] === 'm' ? 60 : m[2] === 'h' ? 3600 : 86400);
  }

  // Managed embeddings shared by the anon data-plane route and the owner
  // console. Reuses the OpenAI key configured for image generation so no extra
  // setup is needed; throws a tagged error (status + code) when unconfigured or
  // upstream-failed so every caller maps it to the same JSON shape.
  async function managedEmbed(input) {
    if (!input || (typeof input !== 'string' && !Array.isArray(input))) {
      throw Object.assign(new Error('input (string or string[]) required'), { status: 400, code: 'invalid_request' });
    }
    let key = process.env.CLOUD_EMBEDDINGS_API_KEY || '';
    if (!key) { try { const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get('LINGMODEL_IMAGE_UPSTREAM_KEY'); if (row && row.value && row.value.trim()) key = row.value.trim(); } catch (_) {} }
    if (!key) key = process.env.LINGMODEL_IMAGE_UPSTREAM_KEY || process.env.OPENAI_API_KEY || '';
    if (!key) throw Object.assign(new Error('Managed embeddings are not enabled on this server.'), { status: 503, code: 'embeddings_not_configured' });
    const url = process.env.CLOUD_EMBEDDINGS_API_URL || 'https://api.openai.com/v1/embeddings';
    const model = process.env.CLOUD_EMBEDDINGS_MODEL || 'text-embedding-3-small';
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ model, input }) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !Array.isArray(j.data)) throw Object.assign(new Error('embeddings call failed'), { status: 502, code: 'embeddings_failed' });
    const embeddings = j.data.map((d) => d.embedding);
    return { model, dimensions: embeddings[0] ? embeddings[0].length : 0, embeddings, embedding: embeddings[0] };
  }
  // Send a managedEmbed result/error as the standard { ok, data|error } JSON.
  function sendEmbed(res, p, backendId) {
    return p.then((data) => res.json({ ok: true, data }))
      .catch((err) => { if (err && err.code === 'embeddings_failed') logEvent(db, backendId, 'control', 'error', 'embeddings call failed'); res.status(err.status || 500).json({ ok: false, error: err.code || 'embeddings_error', message: err.message }); });
  }

  // Build the full auth response: short-lived access token + rotating refresh
  // token. `token` is retained alongside `access_token` for older clients.
  async function issueSession(backendId, user, { aal = 'aal1' } = {}) {
    const access = dataPlane.mintUserJwt(backendId, user, { aal });
    const refresh = await dataPlane.issueRefreshToken(backendId, user.id);
    return {
      user, token: access, access_token: access, refresh_token: refresh.token,
      token_type: 'bearer', expires_in: ttlSeconds(), aal,
    };
  }

  app.post('/api/cloud/be/:backendId/select', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const table = String((req.body && req.body.table) || '');
    if (!table) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'table required' });
    try {
      const data = await dataPlane.proxySelect(a.backendId, table, {
        where: req.body.where, order: req.body.order,
        limit: req.body.limit, offset: req.body.offset, userId: a.userId,
      });
      bumpUsage(db, a.backendId, { read: data.rows.length });
      res.json({ ok: true, data: data.rows });
    } catch (err) { sendErr(res, err, 'proxy_select'); }
  });

  app.post('/api/cloud/be/:backendId/insert', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const table = String((req.body && req.body.table) || '');
    if (!table) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'table required' });
    try {
      const data = await dataPlane.proxyInsert(a.backendId, table, req.body && req.body.row, { userId: a.userId });
      bumpUsage(db, a.backendId, { written: 1 });
      res.json({ ok: true, data: data.rows });
    } catch (err) { sendErr(res, err, 'proxy_insert'); }
  });

  // Update rows matching `where` with `patch`. `where` is required (the data
  // plane refuses an unscoped update). Returns the updated rows.
  app.post('/api/cloud/be/:backendId/update', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const table = String((req.body && req.body.table) || '');
    if (!table) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'table required' });
    try {
      const data = await dataPlane.proxyUpdate(a.backendId, table, {
        where: req.body && req.body.where, patch: req.body && req.body.patch, userId: a.userId,
      });
      bumpUsage(db, a.backendId, { written: data.rows.length });
      res.json({ ok: true, data: data.rows });
    } catch (err) { sendErr(res, err, 'proxy_update'); }
  });

  // Delete rows matching `where` (required). Returns the deleted rows.
  app.post('/api/cloud/be/:backendId/delete', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const table = String((req.body && req.body.table) || '');
    if (!table) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'table required' });
    try {
      const data = await dataPlane.proxyDelete(a.backendId, table, {
        where: req.body && req.body.where, userId: a.userId,
      });
      bumpUsage(db, a.backendId, { written: data.rows.length });
      res.json({ ok: true, data: data.rows });
    } catch (err) { sendErr(res, err, 'proxy_delete'); }
  });

  // ── Realtime: SSE stream of row changes (anon-key bearer or ?apikey=) ─
  // GET /api/cloud/be/:backendId/realtime[?table=foo,bar]
  // Streams INSERT/UPDATE/DELETE events the caller is allowed to see. Each
  // change is RLS-rechecked as the tenant before delivery (no cross-user
  // leakage). `table` (optional, comma-separated) filters to those tables.
  app.get('/api/cloud/be/:backendId/realtime', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const wanted = String((req.query && req.query.table) || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const tableSet = wanted.length ? new Set(wanted) : null; // null = all tables

    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache, no-transform');
    res.set('Connection', 'keep-alive');
    res.set('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx)
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');

    const onChange = async (ev) => {
      if (ev.backendId !== a.backendId) return;
      if (tableSet && !tableSet.has(ev.table)) return;
      let visible = false;
      try { visible = await dataPlane.canTenantSeeRow(a.backendId, ev.table, ev.type, ev.row, a.userId); }
      catch (_) { visible = false; }
      if (!visible) return; // oversized (row-less) events fail the visibility probe → dropped here
      try {
        res.write(`event: change\ndata: ${JSON.stringify({ table: ev.table, type: ev.type, row: ev.row })}\n\n`);
      } catch (_) {}
    };
    dataPlane.ensureRealtimeListener();
    dataPlane.realtimeBus.on('change', onChange);
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
    const cleanup = () => {
      clearInterval(heartbeat);
      dataPlane.realtimeBus.removeListener('change', onChange);
    };
    req.on('close', cleanup);
    req.on('aborted', cleanup);
  });

  // ── Auth: signup / signin (public, anon-key bearer, CORS) ────────────
  app.post('/api/cloud/be/:backendId/auth/signup', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const { email, password } = req.body || {};
    try {
      const beRow = getBackendById(db, a.backendId);
      const userCount = (await dataPlane.listTenantUsers(a.backendId)).length;
      assertUnderLimit(beRow?.tier || 'free', 'maxUsers', userCount);
      const user = await dataPlane.createTenantUser(a.backendId, email, password);
      logEvent(db, a.backendId, 'auth', 'info', `Signup ${user.email}`);
      res.json({ ok: true, data: await issueSession(a.backendId, user) });
    } catch (err) { sendErr(res, err, 'auth_signup'); }
  });

  app.post('/api/cloud/be/:backendId/auth/signin', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const { email, password } = req.body || {};
    try {
      const user = await dataPlane.verifyTenantUser(a.backendId, email, password);
      res.json({ ok: true, data: await issueSession(a.backendId, user) });
    } catch (err) { sendErr(res, err, 'auth_signin'); }
  });

  // ── Magic-link passwordless auth (managed email, anon-key bearer, CORS) ──
  // request: email a single-use, 15-min link `redirect_url?lc_magic=<token>`.
  // We store only sha256(token), and ALWAYS return ok for a valid email so the
  // endpoint can't be used to probe which addresses are registered.
  const MAGIC_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  app.post('/api/cloud/be/:backendId/auth/magiclink/request', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const email = String((req.body && req.body.email) || '').trim();
    const url = String((req.body && req.body.redirect_url) || '');
    if (!MAGIC_EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'valid email required' });
    if (!/^https?:\/\//i.test(url) || url.length > 2000) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'http(s) redirect_url required' });
    try {
      const beRow = getBackendById(db, a.backendId);
      assertEmailQuotaAndBump(db, a.backendId, beRow?.tier);
      const token = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      db.prepare(`INSERT INTO backend_magic_links (id, backend_id, email, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), a.backendId, email, tokenHash, expiresAt, new Date().toISOString());
      const link = url + (url.includes('?') ? '&' : '?') + 'lc_magic=' + encodeURIComponent(token);
      const { subject, html } = resolveEmailTemplate(db, a.backendId, 'magiclink', { link: escHtml(link), email: escHtml(email) });
      const { sendResendEmail } = require('./mail-resend');
      const sent = await sendResendEmail({ to: email, subject, html });
      if (!sent.ok) { logEvent(db, a.backendId, 'auth', 'error', `magiclink email failed: ${sent.error}`); return res.status(502).json({ ok: false, error: 'email_failed', message: 'Could not send sign-in email.' }); }
      logEvent(db, a.backendId, 'auth', 'info', `Magic link sent to ${email}`);
      res.json({ ok: true, data: { sent: true } });
    } catch (err) { sendErr(res, err, 'magiclink_request'); }
  });

  // verify: exchange a valid, unused, unexpired token for a user session JWT.
  app.post('/api/cloud/be/:backendId/auth/magiclink/verify', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const token = String((req.body && req.body.token) || '');
    if (!token) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'token required' });
    try {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const row = db.prepare('SELECT id, email, expires_at, used_at FROM backend_magic_links WHERE backend_id = ? AND token_hash = ?').get(a.backendId, tokenHash);
      if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
        return res.status(401).json({ ok: false, error: 'invalid_or_expired' });
      }
      db.prepare('UPDATE backend_magic_links SET used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
      const user = await dataPlane.getOrCreateTenantUserByEmail(a.backendId, row.email);
      logEvent(db, a.backendId, 'auth', 'info', `Magic-link sign-in ${user.email}`);
      res.json({ ok: true, data: await issueSession(a.backendId, user) });
    } catch (err) { sendErr(res, err, 'magiclink_verify'); }
  });

  // ── Auth: email OTP (6-digit code, no link) ──────────────────────────
  app.post('/api/cloud/be/:backendId/auth/otp/request', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!MAGIC_EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'valid email required' });
    try {
      const beRow = getBackendById(db, a.backendId) || getAnyBackendById(db, a.backendId);
      assertEmailQuotaAndBump(db, a.backendId, beRow?.tier);
      // Invalidate any outstanding codes for this email first.
      db.prepare('DELETE FROM backend_otp_codes WHERE backend_id = ? AND email = ? AND used_at IS NULL').run(a.backendId, email);
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const codeHash = crypto.createHash('sha256').update(code).digest('hex');
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      db.prepare(`INSERT INTO backend_otp_codes (id, backend_id, email, code_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), a.backendId, email, codeHash, expiresAt, new Date().toISOString());
      const { subject, html } = resolveEmailTemplate(db, a.backendId, 'otp', { code, email: escHtml(email) });
      const { sendResendEmail } = require('./mail-resend');
      const sent = await sendResendEmail({ to: email, subject, html });
      if (!sent.ok) { logEvent(db, a.backendId, 'auth', 'error', `otp email failed: ${sent.error}`); return res.status(502).json({ ok: false, error: 'email_failed', message: 'Could not send code.' }); }
      logEvent(db, a.backendId, 'auth', 'info', `OTP sent to ${email}`);
      res.json({ ok: true, data: { sent: true } });
    } catch (err) { sendErr(res, err, 'otp_request'); }
  });

  app.post('/api/cloud/be/:backendId/auth/otp/verify', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const code = String((req.body && req.body.code) || '').trim();
    if (!MAGIC_EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'email + 6-digit code required' });
    try {
      const row = db.prepare('SELECT * FROM backend_otp_codes WHERE backend_id = ? AND email = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1').get(a.backendId, email);
      if (!row || new Date(row.expires_at).getTime() < Date.now()) return res.status(401).json({ ok: false, error: 'invalid_or_expired' });
      if (row.attempts >= 5) { db.prepare('UPDATE backend_otp_codes SET used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id); return res.status(429).json({ ok: false, error: 'too_many_attempts' }); }
      const codeHash = crypto.createHash('sha256').update(code).digest('hex');
      if (codeHash !== row.code_hash) {
        db.prepare('UPDATE backend_otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
        return res.status(401).json({ ok: false, error: 'invalid_code' });
      }
      db.prepare('UPDATE backend_otp_codes SET used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
      const user = await dataPlane.getOrCreateTenantUserByEmail(a.backendId, email);
      logEvent(db, a.backendId, 'auth', 'info', `OTP sign-in ${email}`);
      res.json({ ok: true, data: await issueSession(a.backendId, user) });
    } catch (err) { sendErr(res, err, 'otp_verify'); }
  });

  // ── Auth: native Apple (on-device Sign in with Apple) ────────────────
  // The iOS app does Apple sign-in natively and POSTs the identity token; we
  // verify it against Apple's keys + the backend's configured bundle id. (Lazy
  // require of cloud-oauth avoids the cloud-backend⇄cloud-oauth require cycle.)
  app.post('/api/cloud/be/:backendId/auth/apple/native', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const idToken = String((req.body && (req.body.identity_token || req.body.id_token)) || '');
    if (!idToken) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'identity_token required' });
    try {
      const { verifyAppleIdentityToken, appleBundleId } = require('./cloud-oauth');
      const aud = appleBundleId(db, a.backendId);
      if (!aud) return res.status(503).json({ ok: false, error: 'apple_not_configured', message: 'Set your Apple bundle id via set_auth_provider first.' });
      const got = await verifyAppleIdentityToken(idToken, aud);
      const user = await dataPlane.getOrCreateTenantUserByEmail(a.backendId, got.email);
      logEvent(db, a.backendId, 'auth', 'info', `Apple native sign-in ${got.email}`);
      res.json({ ok: true, data: await issueSession(a.backendId, user) });
    } catch (err) { sendErr(res, err, 'apple_native'); }
  });

  // ── Refresh-token rotation ───────────────────────────────────────────
  // Exchange a refresh token for a new access token + a rotated refresh token.
  // A replayed (already-rotated) refresh token revokes the whole token family.
  app.post('/api/cloud/be/:backendId/auth/token/refresh', async (req, res) => {
    const a = proxyAuth(req, res, { allowAal1: true }); if (!a) return;
    const refreshToken = String((req.body && req.body.refresh_token) || '');
    if (!refreshToken) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'refresh_token required' });
    try {
      const rot = await dataPlane.rotateRefreshToken(a.backendId, refreshToken);
      const user = (await dataPlane.getTenantUserById(a.backendId, rot.userId)) || { id: rot.userId };
      // Refresh can't re-challenge MFA, so the renewed access token is aal1;
      // the client re-verifies TOTP if a protected route returns mfa_required.
      const access = dataPlane.mintUserJwt(a.backendId, user, { aal: 'aal1' });
      res.json({ ok: true, data: { user, token: access, access_token: access, refresh_token: rot.token, token_type: 'bearer', expires_in: ttlSeconds(), aal: 'aal1' } });
    } catch (err) { sendErr(res, err, 'auth_token_refresh'); }
  });

  // ── Sign out: revoke one refresh token, or all of the user's (all:true) ──
  app.post('/api/cloud/be/:backendId/auth/signout', async (req, res) => {
    const a = proxyAuth(req, res, { allowAal1: true }); if (!a) return;
    const refreshToken = String((req.body && req.body.refresh_token) || '');
    try {
      if (req.body && req.body.all && a.userId) await dataPlane.revokeRefreshTokens(a.backendId, a.userId);
      else if (refreshToken) await dataPlane.revokeRefreshToken(a.backendId, refreshToken);
      else return res.status(400).json({ ok: false, error: 'invalid_request', message: 'refresh_token or all:true required' });
      res.json({ ok: true });
    } catch (err) { sendErr(res, err, 'auth_signout'); }
  });

  // ── MFA (TOTP) — enroll, verify, list, remove. Require a signed-in user. ─
  function requireUser(a, res) {
    if (!a.userId) { res.status(401).json({ ok: false, error: 'auth_required', message: 'sign in first' }); return false; }
    return true;
  }

  app.post('/api/cloud/be/:backendId/auth/mfa/enroll', async (req, res) => {
    const a = proxyAuth(req, res, { allowAal1: true }); if (!a) return;
    if (!requireUser(a, res)) return;
    try {
      const user = await dataPlane.getTenantUserById(a.backendId, a.userId);
      const data = await dataPlane.enrollTotp(a.backendId, a.userId, { label: (user && user.email) || a.userId });
      res.json({ ok: true, data });
    } catch (err) { sendErr(res, err, 'mfa_enroll'); }
  });

  // Verify a TOTP code. First success completes enrollment; returns an aal2
  // access token (the assurance level needed once MFA is required).
  app.post('/api/cloud/be/:backendId/auth/mfa/verify', async (req, res) => {
    const a = proxyAuth(req, res, { allowAal1: true }); if (!a) return;
    if (!requireUser(a, res)) return;
    const code = String((req.body && req.body.code) || '');
    const factorId = (req.body && req.body.factor_id) || null;
    if (!code) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'code required' });
    try {
      await dataPlane.verifyTotp(a.backendId, a.userId, code, { factorId });
      const user = (await dataPlane.getTenantUserById(a.backendId, a.userId)) || { id: a.userId };
      const access = dataPlane.mintUserJwt(a.backendId, user, { aal: 'aal2' });
      res.json({ ok: true, data: { user, token: access, access_token: access, token_type: 'bearer', expires_in: ttlSeconds(), aal: 'aal2' } });
    } catch (err) { sendErr(res, err, 'mfa_verify'); }
  });

  // Which verified factors a user has — the client prompts for a code when this
  // is non-empty (used after a sign-in or an mfa_required rejection).
  app.post('/api/cloud/be/:backendId/auth/mfa/challenge', async (req, res) => {
    const a = proxyAuth(req, res, { allowAal1: true }); if (!a) return;
    if (!requireUser(a, res)) return;
    try {
      const factors = await dataPlane.listMfaFactors(a.backendId, a.userId);
      res.json({ ok: true, data: { factors: factors.filter((f) => f.verified) } });
    } catch (err) { sendErr(res, err, 'mfa_challenge'); }
  });

  app.get('/api/cloud/be/:backendId/auth/mfa/factors', async (req, res) => {
    const a = proxyAuth(req, res, { allowAal1: true }); if (!a) return;
    if (!requireUser(a, res)) return;
    try { res.json({ ok: true, data: await dataPlane.listMfaFactors(a.backendId, a.userId) }); }
    catch (err) { sendErr(res, err, 'mfa_factors'); }
  });

  app.delete('/api/cloud/be/:backendId/auth/mfa/factors/:factorId', async (req, res) => {
    const a = proxyAuth(req, res, { allowAal1: true }); if (!a) return;
    if (!requireUser(a, res)) return;
    try { await dataPlane.deleteMfaFactor(a.backendId, a.userId, String(req.params.factorId || '')); res.json({ ok: true }); }
    catch (err) { sendErr(res, err, 'mfa_factor_delete'); }
  });

  // ── Vector search (pgvector) ─────────────────────────────────────────
  // Semantic / similarity search over a vector column. Store embeddings as a
  // `vector(N)` column (apply_migration: CREATE TABLE docs(..., embedding vector(1536)))
  // and insert the embedding as a '[..]' literal; this ranks rows by distance.
  app.post('/api/cloud/be/:backendId/vector/search', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const table = String((req.body && req.body.table) || '');
    const column = String((req.body && req.body.column) || '');
    const embedding = req.body && req.body.embedding;
    if (!table || !column || !embedding) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'table, column, embedding required' });
    try {
      const data = await dataPlane.vectorSearch(a.backendId, {
        table, column, embedding, limit: req.body.limit, metric: req.body.metric, userId: a.userId,
      });
      bumpUsage(db, a.backendId, { read: data.rows.length });
      res.json({ ok: true, data: data.rows });
    } catch (err) { sendErr(res, err, 'vector_search'); }
  });

  // ── Full-text search (Postgres FTS) ──────────────────────────────────
  // Rank rows by ts_rank against a websearch query. `column` is a text column
  // by default; set is_tsvector:true if it's a generated tsvector column.
  app.post('/api/cloud/be/:backendId/search/text', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const { table, column, query, is_tsvector, limit } = req.body || {};
    if (!table || !column || !query) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'table, column, query required' });
    try {
      const data = await dataPlane.textSearch(a.backendId, { table, column, query, isTsvector: !!is_tsvector, limit, userId: a.userId });
      bumpUsage(db, a.backendId, { read: data.rows.length });
      res.json({ ok: true, data: data.rows });
    } catch (err) { sendErr(res, err, 'text_search'); }
  });

  // ── Hybrid search (FTS + vector via reciprocal rank fusion) ──────────
  // Pass both a text `query` and its `embedding` (call /vector/embed first).
  app.post('/api/cloud/be/:backendId/search/hybrid', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const b = req.body || {};
    if (!b.table || !b.text_column || !b.vector_column || !b.query || !b.embedding) {
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'table, text_column, vector_column, query, embedding required' });
    }
    try {
      const data = await dataPlane.hybridSearch(a.backendId, {
        table: b.table, textColumn: b.text_column, vectorColumn: b.vector_column,
        query: b.query, embedding: b.embedding, idColumn: b.id_column || null,
        textIsTsvector: !!b.text_is_tsvector, metric: b.metric, limit: b.limit,
        fullTextWeight: b.full_text_weight, semanticWeight: b.semantic_weight, rrfK: b.rrf_k,
        userId: a.userId,
      });
      bumpUsage(db, a.backendId, { read: data.rows.length });
      res.json({ ok: true, data: data.rows });
    } catch (err) { sendErr(res, err, 'hybrid_search'); }
  });

  // Managed embeddings (optional): turn text into a vector with no model setup.
  // Dormant unless CLOUD_EMBEDDINGS_API_KEY is set (OpenAI-compatible /embeddings).
  app.post('/api/cloud/be/:backendId/vector/embed', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    return sendEmbed(res, managedEmbed(req.body && req.body.input), a.backendId);
  });

  // ── Storage: upload / download / list (anon-key bearer, CORS) ────────
  app.post('/api/cloud/be/:backendId/storage/upload', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const beRow = getBackendById(db, a.backendId);
    const { bucket = 'public', path, content_type, data_b64 } = req.body || {};
    if (!path || typeof path !== 'string' || path.length > MAX_OBJECT_PATH) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'path required (≤256 chars)' });
    if (typeof data_b64 !== 'string' || !data_b64) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'data_b64 required' });
    const bytes = Math.ceil(data_b64.length * 3 / 4);
    const limit = limitsForTier(beRow?.tier || 'free');
    if (bytes > limit.maxObjectBytes) return res.status(413).json({ ok: false, error: 'object_too_large', message: `max ${limit.maxObjectBytes} bytes` });
    const storedPath = ownedPath(bucket, a.userId, path);
    try {
      const count = db.prepare('SELECT COUNT(*) AS n FROM backend_objects WHERE backend_id = ?').get(a.backendId).n;
      const prev = db.prepare('SELECT bytes FROM backend_objects WHERE backend_id=? AND bucket=? AND path=?').get(a.backendId, bucket, storedPath);
      if (!prev) assertUnderLimit(beRow?.tier || 'free', 'maxObjects', count);
      assertStorageRoom(db, a.backendId, beRow?.tier || 'free', bytes - (prev ? prev.bytes : 0), purchasedStorageBytesForBackend(db, a.backendId));
      await persistObject(db, a.backendId, bucket, storedPath, content_type, data_b64, bytes, a.userId);
      bumpUsageStorage(db, a.backendId);
      // Return the LOGICAL path/URL: for private-owned objects the gateway re-derives
      // the u_<userId>/ prefix from the caller's token, so the app always uses the
      // logical path it supplied (public objects are flat, so logical == stored).
      res.json({ ok: true, data: { bucket, path, bytes, url: objectUrl(req, a.backendId, bucket, bucket === 'public' ? storedPath : path) } });
    } catch (err) { sendErr(res, err, 'storage_upload'); }
  });

  // Download an object. Spaces-backed objects 302 to the CDN (public) or a
  // short-lived signed URL (private); legacy base64 rows stream inline.
  app.get('/api/cloud/be/:backendId/storage/object', async (req, res) => {
    cors(res);
    const backendId = String(req.params.backendId || '');
    const row = getAnyBackendById(db, backendId); // prototype- or account-owned
    if (!row || row.status !== 'live') return res.status(404).json({ ok: false, error: 'backend_not_found' });
    const bucket = String(req.query.bucket || 'public');
    const path = String(req.query.path || '');
    // Optional auth: this route stays open for shared/legacy objects (owner NULL),
    // but a token (if present) lets us resolve a private-OWNED object's u_<userId>/
    // keyspace and gate access to its owner. No token → only shared objects resolve.
    let userId = null;
    const auth = req.headers.authorization || '';
    const token = (auth.startsWith('Bearer ') ? auth.slice(7).trim() : '') || String((req.query && (req.query.apikey || req.query.token)) || '').trim();
    if (token) { try { userId = dataPlane.verifyTenantJwt(backendId, token).sub || null; } catch (_) { userId = null; } }
    // Try the owner-namespaced path first, then fall back to the literal path so
    // objects written before this change (flat path, owner NULL) still resolve.
    const ownPath = ownedPath(bucket, userId, path);
    let matchedPath = ownPath;
    let obj = db.prepare('SELECT content_type, data_b64, spaces_key, owner_user_id FROM backend_objects WHERE backend_id=? AND bucket=? AND path=?').get(backendId, bucket, ownPath);
    if (!obj && ownPath !== path) {
      matchedPath = path;
      obj = db.prepare('SELECT content_type, data_b64, spaces_key, owner_user_id FROM backend_objects WHERE backend_id=? AND bucket=? AND path=?').get(backendId, bucket, path);
    }
    if (!obj) return res.status(404).json({ ok: false, error: 'object_not_found' });
    // Owner gate: a private object owned by someone else is never served, even if
    // the path was guessed. Public objects are world-readable regardless of owner.
    if (obj.owner_user_id && bucket !== 'public' && obj.owner_user_id !== userId) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    if (obj.spaces_key && storage.isConfigured()) {
      try {
        const url = (bucket === 'public')
          ? storage.publicUrl(backendId, bucket, matchedPath)
          : await storage.presignGet(backendId, bucket, matchedPath);
        return res.redirect(302, url);
      } catch (err) { return sendErr(res, err, 'storage_object'); }
    }
    if (obj.data_b64) {
      res.set('Content-Type', obj.content_type || 'application/octet-stream');
      return res.send(Buffer.from(obj.data_b64, 'base64'));
    }
    return res.status(404).json({ ok: false, error: 'object_not_found' });
  });

  // Delete an object (app-facing; backs the SDK's storage.from(b).remove()).
  app.post('/api/cloud/be/:backendId/storage/remove', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const bucket = String((req.body && req.body.bucket) || 'public');
    const path = String((req.body && req.body.path) || '');
    if (!path) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'path required' });
    // Owner-scoped: a user can only remove their own object (the u_<userId>/ key
    // they own). Public-bucket deletes are gated on owner_user_id so a user can't
    // delete another user's public file; anon/owner deletes hit the flat path.
    const storedPath = ownedPath(bucket, a.userId, path);
    try {
      if (bucket === 'public' && a.userId) {
        const owner = db.prepare('SELECT owner_user_id FROM backend_objects WHERE backend_id=? AND bucket=? AND path=?').get(a.backendId, bucket, storedPath);
        if (owner && owner.owner_user_id && owner.owner_user_id !== a.userId) return res.status(403).json({ ok: false, error: 'forbidden' });
      }
      if (storage.isConfigured()) { try { await storage.removeObject(a.backendId, bucket, storedPath); } catch (_) { /* metadata delete still proceeds */ } }
      db.prepare('DELETE FROM backend_objects WHERE backend_id=? AND bucket=? AND path=?').run(a.backendId, bucket, storedPath);
      bumpUsageStorage(db, a.backendId);
      res.json({ ok: true, data: { removed: true } });
    } catch (err) { sendErr(res, err, 'storage_remove'); }
  });

  // Direct-to-Spaces upload, step 1: mint a short-lived presigned PUT URL so the
  // client uploads the bytes straight to Spaces (bypassing the droplet's base64
  // ceiling). The client PUTs to `uploadUrl` with exactly the returned `headers`,
  // then calls /storage/finalize to record the object. Only works when Spaces is
  // configured; otherwise the caller should fall back to base64 /storage/upload.
  app.post('/api/cloud/be/:backendId/storage/create-upload-url', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const { bucket = 'public', path, content_type } = req.body || {};
    if (!path || typeof path !== 'string' || path.length > MAX_OBJECT_PATH) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'path required (≤256 chars)' });
    if (!storage.isConfigured()) return res.status(409).json({ ok: false, error: 'direct_upload_unavailable', message: 'object storage not configured; use base64 /storage/upload' });
    const storedPath = ownedPath(bucket, a.userId, path);
    try {
      const beRow = getBackendById(db, a.backendId);
      const count = db.prepare('SELECT COUNT(*) AS n FROM backend_objects WHERE backend_id = ?').get(a.backendId).n;
      const replacing = !!db.prepare('SELECT 1 FROM backend_objects WHERE backend_id=? AND bucket=? AND path=?').get(a.backendId, bucket, storedPath);
      if (!replacing) assertUnderLimit(beRow?.tier || 'free', 'maxObjects', count);
      // Sign the owner-namespaced key; finalize re-derives the same key from the
      // caller's token, so the SDK only ever passes the logical path.
      const signed = await storage.presignPut(a.backendId, bucket, storedPath, content_type);
      res.json({ ok: true, data: { uploadUrl: signed.url, method: 'PUT', headers: signed.headers, bucket, path } });
    } catch (err) { sendErr(res, err, 'storage_create_upload_url'); }
  });

  // Direct-to-Spaces upload, step 2: after the client PUTs to the presigned URL,
  // read the object's true size from Spaces (HEAD), enforce the large-file cap
  // (maxUploadBytes), and record the metadata row. If the upload is over the cap
  // we delete it from Spaces and 413 — the bytes never touched the droplet.
  app.post('/api/cloud/be/:backendId/storage/finalize', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const { bucket = 'public', path } = req.body || {};
    if (!path || typeof path !== 'string') return res.status(400).json({ ok: false, error: 'invalid_request', message: 'path required' });
    if (!storage.isConfigured()) return res.status(409).json({ ok: false, error: 'direct_upload_unavailable' });
    const storedPath = ownedPath(bucket, a.userId, path);
    try {
      const beRow = getBackendById(db, a.backendId);
      const head = await storage.headObject(a.backendId, bucket, storedPath);
      if (!head) return res.status(404).json({ ok: false, error: 'object_not_found', message: 'no object at that path — was the PUT completed?' });
      const limit = limitsForTier(beRow?.tier || 'free');
      if (head.bytes > limit.maxUploadBytes) {
        try { await storage.removeObject(a.backendId, bucket, storedPath); } catch (_) { /* best-effort cleanup */ }
        return res.status(413).json({ ok: false, error: 'object_too_large', message: `max ${limit.maxUploadBytes} bytes` });
      }
      const prev = db.prepare('SELECT bytes FROM backend_objects WHERE backend_id=? AND bucket=? AND path=?').get(a.backendId, bucket, storedPath);
      try { assertStorageRoom(db, a.backendId, beRow?.tier || 'free', head.bytes - (prev ? prev.bytes : 0), purchasedStorageBytesForBackend(db, a.backendId)); }
      catch (quotaErr) { try { await storage.removeObject(a.backendId, bucket, storedPath); } catch (_) { /* best-effort cleanup of the orphaned upload */ } throw quotaErr; }
      recordSpacesObject(db, a.backendId, bucket, storedPath, head.contentType, head.bytes, head.key, head.etag, a.userId);
      bumpUsageStorage(db, a.backendId);
      res.json({ ok: true, data: { bucket, path, bytes: head.bytes, url: objectUrl(req, a.backendId, bucket, bucket === 'public' ? storedPath : path) } });
    } catch (err) { sendErr(res, err, 'storage_finalize'); }
  });

  // ── Push: app-facing subscribe + VAPID public key (anon-key bearer) ──
  // The SDK's client.push.subscribe() GETs the key for PushManager.subscribe,
  // then POSTs the resulting subscription here (tied to the signed-in user when
  // a user JWT is presented, so push.send({user_id}) can target one person).
  app.get('/api/cloud/be/:backendId/push/vapid-public', (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    if (!cloudPush.isAvailable()) return res.status(503).json({ ok: false, error: 'push_not_available' });
    const key = cloudPush.vapidPublic(db, a.backendId);
    if (!key) return res.status(503).json({ ok: false, error: 'push_not_available' });
    res.json({ ok: true, data: { key } });
  });

  app.post('/api/cloud/be/:backendId/push/subscribe', (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    try {
      const out = cloudPush.saveSubscription(db, a.backendId, a.userId, req.body && req.body.subscription);
      res.json({ ok: true, data: out });
    } catch (err) { res.status(400).json({ ok: false, error: 'invalid_subscription', message: err.message }); }
  });

  // ── Telemetry: app-facing event ingest (anon-key bearer) ─────────────
  // Apps batch analytics events, perf traces, and crashes here; the SDK's
  // client.telemetry.{logEvent,trace,recordError} all funnel into this. Folded
  // into daily aggregates + a 90-day raw event log + per-client first/last-seen
  // (see cloud-telemetry.js) — powers DAU/MAU, retention, funnels, params.
  app.post('/api/cloud/be/:backendId/telemetry', (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    if (!cloudTelemetry.allowIngest(a.backendId)) return res.status(429).json({ ok: false, error: 'rate_limited' });
    const events = (req.body && req.body.events) || [];
    try {
      const out = cloudTelemetry.recordEvents(db, a.backendId, events, { country: req.headers['cf-ipcountry'] });
      res.json({ ok: true, data: out });
    } catch (err) { res.status(400).json({ ok: false, error: 'telemetry_failed', message: err.message }); }
  });

  // GET /api/cloud/be/:backendId/config?client_id=X — resolve A/B + remote
  // config for a client (deterministic, sticky). Anon-key gated like ingest.
  app.get('/api/cloud/be/:backendId/config', (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const clientId = String((req.query && req.query.client_id) || '');
    try {
      res.json({ ok: true, data: cloudTelemetry.resolveConfig(db, a.backendId, clientId) });
    } catch (err) { res.status(500).json({ ok: false, error: 'config_failed', message: err.message }); }
  });

  // ── Functions: invoke a user function (Deno sandbox) or a curated
  //    template, anon-key bearer + CORS. User functions win on slug collision.
  app.post('/api/cloud/be/:backendId/functions/:slug', async (req, res) => {
    const a = proxyAuth(req, res); if (!a) return;
    const slug = String(req.params.slug || '');

    // 1) User-authored function (arbitrary code, sandboxed Deno). Now gets DB +
    //    storage access (ctx.db/ctx.storage) and the full inbound request
    //    (ctx.request), and may return a structured HTTP response — so it can be a
    //    real API endpoint / webhook receiver, not just a JSON compute call.
    const fn = db.prepare('SELECT * FROM backend_functions WHERE backend_id=? AND slug=? AND enabled=1').get(a.backendId, slug);
    if (fn) {
      if (!functionsRuntime.isAvailable()) return res.status(503).json({ ok: false, error: 'functions_runtime_unavailable', message: 'The functions runtime is not available on this server.' });
      try {
        const beRow = getAnyBackendById(db, a.backendId);
        const request = {
          method: req.method, path: req.path, query: req.query || {}, headers: req.headers || {},
          // Best-effort raw body (exact bytes need a raw-body capture hook; the
          // parsed body is re-serialized here as a fallback for webhook payloads).
          rawBody: (req.rawBody && Buffer.isBuffer(req.rawBody)) ? req.rawBody.toString('utf8')
            : (req.body !== undefined ? JSON.stringify(req.body) : null),
        };
        const r = await fnInvoke.invokeUserFunction(db, beRow, fn, { input: req.body && req.body.input, request, userId: a.userId });
        bumpUsage(db, a.backendId, {});
        db.prepare(`UPDATE backend_usage SET func_invocations = func_invocations + 1 WHERE backend_id=? AND day=?`).run(a.backendId, new Date().toISOString().slice(0, 10));
        if (!r.ok) { logEvent(db, a.backendId, 'function', 'error', `${slug}: ${r.error}`); return res.status(400).json({ ok: false, error: 'function_error', message: r.error }); }
        logEvent(db, a.backendId, 'function', 'info', `Invoked ${slug}`);
        // Structured HTTP response: handler returned { __http:true, status, headers, body }.
        const d = r.data;
        if (d && typeof d === 'object' && d.__http) {
          if (d.headers && typeof d.headers === 'object') {
            for (const [k, v] of Object.entries(d.headers)) { try { res.setHeader(k, String(v)); } catch (_) {} }
          }
          return res.status(Number(d.status) || 200).send(d.body == null ? '' : (typeof d.body === 'string' ? d.body : JSON.stringify(d.body)));
        }
        return res.json({ ok: true, data: d });
      } catch (err) { logEvent(db, a.backendId, 'function', 'error', `${slug}: ${err.message}`); return sendErr(res, err, 'function_invoke'); }
    }

    // 2) Built-in curated template (echo / send-email / elevenlabs-tts / http-fetch).
    const tmpl = cloudFunctions.getTemplate(slug);
    if (!tmpl) return res.status(404).json({ ok: false, error: 'unknown_function' });
    try {
      const beRow = getAnyBackendById(db, a.backendId); // prototype- OR account-backed
      // Resolve secrets from the right vault scope: prototype backends keep the
      // prototype store; account backends use backend_secrets (keyed by id).
      let secrets = {};
      if (secretsVault.isConfigured()) {
        if (beRow && beRow.prototype_id) {
          for (const name of tmpl.requiredSecrets) { const v = secretsVault.readSecret(db, beRow.prototype_id, name); if (v) secrets[name] = v; }
        } else {
          secrets = secretsVault.readAllBackendSecrets(db, a.backendId); // http-fetch may reference any
        }
      }
      for (const name of tmpl.requiredSecrets) {
        if (!secrets[name]) return res.status(412).json({ ok: false, error: 'missing_secret', message: `Set ${name} under the backend's Secrets first.`, missing: name });
      }
      // Egress allow-list for http-fetch (comma-separated hosts; empty = deny).
      let allowedHosts = [];
      try { const row = db.prepare('SELECT allowed_fetch_hosts FROM backend_auth_settings WHERE backend_id=?').get(a.backendId); allowedHosts = (row && row.allowed_fetch_hosts) ? String(row.allowed_fetch_hosts).split(',').map((s) => s.trim()).filter(Boolean) : []; } catch (_) {}
      // Managed email is metered + rate-limited per tier (it uses LingCode's
      // shared sender, so the app needs no key). Enforce before sending.
      if (slug === 'send-email') assertEmailQuotaAndBump(db, a.backendId, beRow && beRow.tier);
      const out = await cloudFunctions.runTemplate(slug, req.body && req.body.input, { secrets, backendId: a.backendId, allowedHosts });
      bumpUsage(db, a.backendId, {});
      db.prepare(`UPDATE backend_usage SET func_invocations = func_invocations + 1 WHERE backend_id=? AND day=?`).run(a.backendId, new Date().toISOString().slice(0, 10));
      logEvent(db, a.backendId, 'function', 'info', `Invoked ${slug}`);
      res.json({ ok: true, data: out });
    } catch (err) { logEvent(db, a.backendId, 'function', 'error', `${slug}: ${err.message}`); sendErr(res, err, 'function_invoke'); }
  });

  // ── Console: logs / users / storage list / functions list ───────────
  app.get('/api/cloud/backends/:prototypeId/logs', (req, res) => {
    const prototypeId = String(req.params.prototypeId || '');
    const ctx = consolePreflight(req, res, db, prototypeId); if (!ctx) return;
    const row = getBackendByPrototype(db, prototypeId);
    if (!row) return res.json({ ok: true, data: [] });
    const logs = db.prepare('SELECT ts, source, level, message FROM backend_logs WHERE backend_id = ? ORDER BY id DESC LIMIT 200').all(row.id);
    res.json({ ok: true, data: logs });
  });

  app.get('/api/cloud/backends/:prototypeId/auth/users', async (req, res) => {
    const prototypeId = String(req.params.prototypeId || '');
    const ctx = consolePreflight(req, res, db, prototypeId); if (!ctx) return;
    const row = getBackendByPrototype(db, prototypeId);
    if (!row || row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    try { res.json({ ok: true, data: await dataPlane.listTenantUsers(row.id) }); }
    catch (err) { sendErr(res, err, 'list_users'); }
  });

  app.delete('/api/cloud/backends/:prototypeId/auth/users/:userId', async (req, res) => {
    const prototypeId = String(req.params.prototypeId || '');
    const ctx = consolePreflight(req, res, db, prototypeId); if (!ctx) return;
    const row = getBackendByPrototype(db, prototypeId);
    if (!row || row.status !== 'live') return res.status(409).json({ ok: false, error: 'not_provisioned' });
    try { res.json({ ok: true, data: await dataPlane.deleteTenantUser(row.id, String(req.params.userId || '')) }); }
    catch (err) { sendErr(res, err, 'delete_user'); }
  });

  app.get('/api/cloud/backends/:prototypeId/storage/objects', (req, res) => {
    const prototypeId = String(req.params.prototypeId || '');
    const ctx = consolePreflight(req, res, db, prototypeId); if (!ctx) return;
    const row = getBackendByPrototype(db, prototypeId);
    if (!row) return res.json({ ok: true, data: [] });
    const objs = db.prepare('SELECT bucket, path, content_type, bytes, created_at FROM backend_objects WHERE backend_id = ? ORDER BY created_at DESC LIMIT 500').all(row.id);
    res.json({ ok: true, data: objs });
  });

  app.get('/api/cloud/backends/:prototypeId/functions', (req, res) => {
    const prototypeId = String(req.params.prototypeId || '');
    const ctx = consolePreflight(req, res, db, prototypeId); if (!ctx) return;
    res.json({ ok: true, data: cloudFunctions.listTemplates() });
  });
}

function bumpUsageStorage(db, backendId) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const total = db.prepare('SELECT COALESCE(SUM(bytes),0) AS b FROM backend_objects WHERE backend_id = ?').get(backendId).b;
    db.prepare(`INSERT INTO backend_usage (backend_id, day, storage_bytes) VALUES (?, ?, ?)
      ON CONFLICT(backend_id, day) DO UPDATE SET storage_bytes = excluded.storage_bytes`).run(backendId, day, total);
    maybeWarnStorage(db, backendId, total);
  } catch { /* best-effort */ }
}

// Emails the backend owner once when storage first crosses 80% and once at 95%, and
// clears those flags when usage drops back below 80% (one email per threshold crossing,
// not per write). Fire-and-forget: never blocks or throws into the write path, and
// no-ops silently when RESEND_API_KEY isn't configured.
function maybeWarnStorage(db, backendId, usedBytes) {
  try {
    const be = getAnyBackendById(db, backendId);
    if (!be) return;
    const max = limitsForTier(be.tier || 'free').maxStorageBytes;
    const level = storageWarningLevel(usedBytes, max);

    db.prepare('INSERT OR IGNORE INTO backend_storage_alerts (backend_id) VALUES (?)').run(backendId);
    const flags = db.prepare('SELECT warned_80, warned_95 FROM backend_storage_alerts WHERE backend_id = ?').get(backendId) || { warned_80: 0, warned_95: 0 };

    if (!level) {
      if (flags.warned_80 || flags.warned_95) {
        db.prepare('UPDATE backend_storage_alerts SET warned_80 = 0, warned_95 = 0 WHERE backend_id = ?').run(backendId);
      }
      return;
    }

    let threshold = 0;
    if (level === 'critical' && !flags.warned_95) threshold = 95;
    else if (level === 'warn' && !flags.warned_80) threshold = 80;
    if (!threshold) return;

    // Mark sent BEFORE sending so a transient Resend failure can't re-spam on the next
    // write. 95% implies 80%.
    db.prepare(`UPDATE backend_storage_alerts SET warned_80 = 1${threshold === 95 ? ', warned_95 = 1' : ''} WHERE backend_id = ?`).run(backendId);

    const owner = be.user_id ? db.prepare('SELECT email FROM users WHERE id = ?').get(be.user_id) : null;
    if (!owner || !owner.email) return;

    const usedMB = Math.round(usedBytes / 1024 / 1024);
    const maxMB = Math.round(max / 1024 / 1024);
    const label = be.label || be.project_key || backendId;
    const subject = `Your LingCode Cloud backend is at ${threshold}% storage`;
    const html =
      `<p>Heads up — your backend <strong>${label}</strong> has used <strong>${usedMB} MB of ${maxMB} MB</strong> (${threshold}%) of its storage.</p>` +
      `<p>At 100%, new uploads are rejected until you free up space or upgrade. <a href="https://lingcode.dev/pricing.html">See plans</a>.</p>`;
    const { sendResendEmail } = require('./mail-resend');
    Promise.resolve(sendResendEmail({ to: owner.email, subject, html })).catch(() => {});
  } catch (_) { /* never block the write path */ }
}

// Per-user isolation: a private-bucket object written by an AUTHENTICATED user
// is namespaced under u_<userId>/ so each user has an isolated keyspace (no path
// collisions, and the physical Spaces key is scoped too). The app supplies a
// logical path; the server adds this prefix on write and re-derives it on
// read/delete from the caller's JWT. Public objects (world-readable) and
// anon-key / owner-console writes (userId null) stay flat — preserving existing
// behavior and every already-stored object.
function ownedPath(bucket, userId, path) {
  return (bucket === 'private' && userId) ? `u_${userId}/${path}` : String(path);
}

// À-la-carte storage (Model B) the backend's OWNER has purchased, in bytes — it
// stacks on top of the tier's maxStorageBytes. Resolves backend → owner user →
// users.purchased_storage_bytes. 0 on any miss (column absent, no owner, etc.).
function purchasedStorageBytesForBackend(db, backendId) {
  try {
    const be = getAnyBackendById(db, backendId);
    if (!be || !be.user_id) return 0;
    const u = db.prepare('SELECT purchased_storage_bytes AS b FROM users WHERE id = ?').get(be.user_id);
    return (u && u.b) || 0;
  } catch (_) { return 0; }
}

// Persist an uploaded blob + its metadata row. When Spaces is configured the
// bytes go to object storage and data_b64 is stored empty (keeping data.db
// small); otherwise they fall back to inline base64 in SQLite. Shared by the
// app-facing and owner-console upload routes so both behave identically.
async function persistObject(db, backendId, bucket, path, contentType, data_b64, bytes, ownerUserId) {
  let spacesKey = null, etag = null, storedB64 = data_b64;
  if (storage.isConfigured()) {
    const buf = Buffer.from(data_b64, 'base64');
    const r = await storage.putObject(backendId, bucket, path, buf, contentType || 'application/octet-stream');
    spacesKey = r.key; etag = r.etag; storedB64 = ''; // offloaded — don't bloat SQLite
  }
  db.prepare(`INSERT INTO backend_objects (id, backend_id, bucket, path, content_type, bytes, data_b64, spaces_key, etag, owner_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(backend_id, bucket, path) DO UPDATE SET content_type=excluded.content_type, bytes=excluded.bytes, data_b64=excluded.data_b64, spaces_key=excluded.spaces_key, etag=excluded.etag, owner_user_id=excluded.owner_user_id`)
    .run(crypto.randomUUID(), backendId, bucket, path, contentType || 'application/octet-stream', bytes, storedB64, spacesKey, etag, ownerUserId || null, new Date().toISOString());
}

// Record metadata for a blob that was uploaded DIRECTLY to Spaces via a presigned
// PUT (the bytes never reached the droplet). Unlike persistObject this does no
// upload — it just writes the backend_objects row with spaces_key set and an
// empty data_b64. Used by the /storage/finalize route after a client PUT.
function recordSpacesObject(db, backendId, bucket, path, contentType, bytes, spacesKey, etag, ownerUserId) {
  db.prepare(`INSERT INTO backend_objects (id, backend_id, bucket, path, content_type, bytes, data_b64, spaces_key, etag, owner_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)
    ON CONFLICT(backend_id, bucket, path) DO UPDATE SET content_type=excluded.content_type, bytes=excluded.bytes, data_b64='', spaces_key=excluded.spaces_key, etag=excluded.etag, owner_user_id=excluded.owner_user_id`)
    .run(crypto.randomUUID(), backendId, bucket, path, contentType || 'application/octet-stream', bytes, spacesKey, etag, ownerUserId || null, new Date().toISOString());
}

// Public read URL for an object. Public-bucket Spaces objects resolve straight
// to the CDN (bytes bypass the droplet); everything else goes through the
// gateway /storage/object route (which streams legacy rows or 302s private ones).
function objectUrl(req, backendId, bucket, path) {
  if (bucket === 'public' && storage.isConfigured()) return storage.publicUrl(backendId, bucket, path);
  return `${req.protocol}://${req.get('host')}/api/cloud/be/${backendId}/storage/object?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`;
}

module.exports = { registerCloudBackendRoutes, teardownBackend, provisionForPrototype, provisionBackend, getAccountBackend, getAnyBackendById, ownedPath, purchasedStorageBytesForBackend };
