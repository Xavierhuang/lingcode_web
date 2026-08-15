'use strict';

// cloud-functions-routes.js — owner-console CRUD for serverless functions.
//
// Apps INVOKE functions via the anon-key data path in cloud-backend.js
// (/api/cloud/be/:id/functions/:slug); OWNERS author them here, session-authed,
// on their standalone account backends. The actual execution lives in
// cloud-functions-runtime.js (sandboxed Deno).

const crypto = require('crypto');
const { getUserFromRequest } = require('./auth-helpers');
const dataPlane = require('./cloud-data-plane');
const { limitsForTier } = require('./cloud-limits');
const runtime = require('./cloud-functions-runtime');
const pythonRuntime = require('./cloud-python-runtime');
const cloudFunctions = require('./cloud-functions');

const SLUG_RE = /^[a-z][a-z0-9-]{0,40}$/; // url-safe, lowercase, dash-allowed
const RUNTIMES = new Set(['deno-ts', 'python']); // Preview: 'python' requires per-backend enable flag

// Preview gate. 'python' is opt-in per backend via account_backends.python_runtime_enabled
// (see migrate.js additive column). 'deno-ts' is universally allowed — that's
// the historical default and existing rows.
function runtimeAllowedForBackend(db, backendRow, runtimeName) {
  if (runtimeName === 'deno-ts') return true;
  if (runtimeName === 'python') {
    // Column may not exist on very old DBs; treat missing as disabled (safe default).
    try {
      const cols = db.prepare('PRAGMA table_info(account_backends)').all().map((c) => c.name);
      if (!cols.includes('python_runtime_enabled')) return false;
    } catch (_) { return false; }
    return !!backendRow.python_runtime_enabled;
  }
  return false;
}

// Pick the runtime module for save-side previews / test invocations.
function runtimeModule(runtimeName) {
  return runtimeName === 'python' ? pythonRuntime : runtime;
}

function registerCloudFunctionsRoutes(app, db) {
  // Ownership gate (account backends), mirroring cloud-oauth.js:ownerBackend.
  function ownerBackend(req, res) {
    if (!dataPlane.isConfigured()) { res.status(503).json({ ok: false, error: 'cloud_not_configured' }); return null; }
    const user = getUserFromRequest(db, req);
    if (!user) { res.status(401).json({ ok: false, error: 'unauthorized' }); return null; }
    const backendId = String(req.params.backendId || '');
    const row = db.prepare('SELECT * FROM account_backends WHERE id = ? AND user_id = ?').get(backendId, user.id);
    if (!row) { res.status(404).json({ ok: false, error: 'backend_not_found' }); return null; }
    return { user, row };
  }

  function parseSecrets(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 32);
  }

  // List functions for a backend (owner sees source).
  app.get('/api/cloud/account/backends/:backendId/functions', (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const rows = db.prepare('SELECT slug, source, runtime, enabled, secrets, updated_at FROM backend_functions WHERE backend_id = ? ORDER BY slug').all(ctx.row.id);
    res.json({ ok: true, data: {
      runtime_available: runtime.isAvailable(),
      // Preview: presence of firejail + python3 on the API host. UI hides the
      // Python author path when false.
      python_runtime_available: pythonRuntime.isAvailable(),
      python_runtime_enabled: !!ctx.row.python_runtime_enabled,
      functions: rows.map((r) => ({ ...r, enabled: !!r.enabled, secrets: r.secrets ? JSON.parse(r.secrets) : [] })),
      // Curated built-in templates (Twilio, Resend, ElevenLabs, http-fetch, …)
      // the app can invoke without writing a Deno function. Surfaced so the
      // console can render a gallery + secret-status.
      templates: cloudFunctions.listTemplates(),
    } });
  });

  // Create or update a function by slug.
  app.put('/api/cloud/account/backends/:backendId/functions/:slug', (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const slug = String(req.params.slug || '').toLowerCase();
    if (!SLUG_RE.test(slug)) return res.status(400).json({ ok: false, error: 'invalid_slug', message: 'slug must be lowercase letters/digits/dashes, starting with a letter' });
    const source = String((req.body && req.body.source) || '');
    if (!source.trim()) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'source required' });
    // Runtime: accept from body, default to 'deno-ts' for back-compat. 'python'
    // is Preview and requires account_backends.python_runtime_enabled=1.
    const runtimeName = String((req.body && req.body.runtime) || 'deno-ts');
    if (!RUNTIMES.has(runtimeName)) return res.status(400).json({ ok: false, error: 'invalid_runtime', message: `runtime must be one of: ${[...RUNTIMES].join(', ')}` });
    if (!runtimeAllowedForBackend(db, ctx.row, runtimeName)) {
      return res.status(403).json({ ok: false, error: 'python_runtime_not_enabled', message: 'The Python runtime is a Preview feature and is not enabled for this backend.' });
    }
    const rt = runtimeModule(runtimeName);
    if (Buffer.byteLength(source, 'utf8') > rt.MAX_SOURCE_BYTES) return res.status(413).json({ ok: false, error: 'source_too_large', message: `max ${rt.MAX_SOURCE_BYTES} bytes` });
    const secrets = parseSecrets(req.body && req.body.secrets);
    const enabled = !(req.body && req.body.enabled === false);
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT id FROM backend_functions WHERE backend_id = ? AND slug = ?').get(ctx.row.id, slug);
    try {
      db.prepare(`INSERT INTO backend_functions (id, backend_id, slug, source, runtime, enabled, secrets, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(backend_id, slug) DO UPDATE SET source=excluded.source, runtime=excluded.runtime, enabled=excluded.enabled, secrets=excluded.secrets, updated_at=excluded.updated_at`)
        .run(existing ? existing.id : crypto.randomUUID(), ctx.row.id, slug, source, runtimeName, enabled ? 1 : 0, JSON.stringify(secrets), now, now);
      res.json({ ok: true, data: { slug, runtime: runtimeName, enabled, secrets, updated_at: now } });
    } catch (err) { res.status(err.status || 500).json({ ok: false, error: err.code || 'function_save_failed', message: err.message }); }
  });

  app.delete('/api/cloud/account/backends/:backendId/functions/:slug', (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    db.prepare('DELETE FROM backend_functions WHERE backend_id = ? AND slug = ?').run(ctx.row.id, String(req.params.slug || '').toLowerCase());
    res.json({ ok: true });
  });

  // Owner test harness — run the saved (or supplied) source with a sample input,
  // bypassing the anon-key data path. Returns the runtime result incl. logs.
  app.post('/api/cloud/account/backends/:backendId/functions/:slug/test', async (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const slug = String(req.params.slug || '').toLowerCase();
    const row = db.prepare('SELECT source, runtime FROM backend_functions WHERE backend_id = ? AND slug = ?').get(ctx.row.id, slug);
    const source = String((req.body && req.body.source) || (row && row.source) || '');
    if (!source.trim()) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'no source to test' });
    // Runtime: request-body override > saved row > default. Same gate as save
    // (Python is Preview-gated per backend).
    const runtimeName = String((req.body && req.body.runtime) || (row && row.runtime) || 'deno-ts');
    if (!RUNTIMES.has(runtimeName)) return res.status(400).json({ ok: false, error: 'invalid_runtime', message: `runtime must be one of: ${[...RUNTIMES].join(', ')}` });
    if (!runtimeAllowedForBackend(db, ctx.row, runtimeName)) {
      return res.status(403).json({ ok: false, error: 'python_runtime_not_enabled', message: 'The Python runtime is a Preview feature and is not enabled for this backend.' });
    }
    const rt = runtimeModule(runtimeName);
    if (!rt.isAvailable()) {
      const isPython = runtimeName === 'python';
      return res.status(503).json({
        ok: false,
        error: isPython ? 'python_runtime_unavailable' : 'functions_runtime_unavailable',
        message: isPython
          ? 'The Python functions runtime (firejail + python3) is not installed on this server.'
          : 'The functions runtime is not installed on this server.',
      });
    }
    const limit = limitsForTier(ctx.row.tier || 'free');
    const r = await rt.runUserFunction({
      backendId: ctx.row.id, gatewayUrl: ctx.row.gateway_url, slug, source,
      input: req.body && req.body.input, timeoutMs: limit.maxFunctionMs,
    });
    res.json({ ok: true, data: r });
  });
}

module.exports = { registerCloudFunctionsRoutes };
