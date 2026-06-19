'use strict';

// cloud-function-cron.js — scheduled serverless functions for the managed-backend
// tier. Reuses the worker-cron 5-field parser/scheduler math, but instead of
// firing an HTTP call it INVOKES the Deno function in-process (cloud-fn-invoke),
// so apps get digests / cleanup / polling jobs without running their own server.

const crypto = require('crypto');
const { getUserFromRequest } = require('./auth-helpers');
const { nextRunAfter } = require('./cloud-worker-cron');
const { limitsForTier } = require('./cloud-limits');
const fnInvoke = require('./cloud-fn-invoke');

const TICK_MS = 60 * 1000;
const SLUG_RE = /^[a-z][a-z0-9-]{0,40}$/;

// ── Firing one due schedule ─────────────────────────────────────────────────
async function fireSchedule(db, row) {
  const ts = Date.now();
  let status = 'ok';
  try {
    const beRow = db.prepare('SELECT * FROM account_backends WHERE id = ?').get(row.backend_id);
    const fnRow = beRow && db.prepare('SELECT * FROM backend_functions WHERE backend_id = ? AND slug = ? AND enabled = 1').get(row.backend_id, row.slug);
    if (!beRow || !fnRow) {
      status = 'skipped: function missing/disabled';
    } else {
      let input = { scheduled: true, time: new Date(ts).toISOString() };
      if (row.input_json) { try { input = Object.assign(input, JSON.parse(row.input_json)); } catch (_) {} }
      const r = await fnInvoke.invokeUserFunction(db, beRow, fnRow, { input, request: { method: 'SCHEDULE', scheduled: true } });
      status = r.ok ? 'ok' : ('error: ' + String(r.error || '').slice(0, 160));
    }
  } catch (e) {
    status = 'error: ' + String((e && e.message) || e).slice(0, 160);
  }
  const next = nextRunAfter(row.schedule, ts);
  db.prepare('UPDATE backend_function_schedules SET last_run_at = ?, last_status = ?, next_run_at = ? WHERE id = ?')
    .run(ts, status, next, row.id);
}

let _ticking = false;
async function tick(db) {
  if (_ticking) return;
  _ticking = true;
  try {
    const now = Date.now();
    const due = db.prepare(
      'SELECT * FROM backend_function_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? LIMIT 100'
    ).all(now);
    // Serialize: each fire spawns a Deno process, so don't fan out unbounded.
    for (const row of due) { try { await fireSchedule(db, row); } catch (_) {} }
  } catch (_) { /* keep the scheduler alive across any single-tick failure */ } finally {
    _ticking = false;
  }
}

function startFunctionCronScheduler(db) {
  try {
    const orphans = db.prepare('SELECT id, schedule FROM backend_function_schedules WHERE enabled = 1 AND next_run_at IS NULL').all();
    for (const o of orphans) {
      db.prepare('UPDATE backend_function_schedules SET next_run_at = ? WHERE id = ?').run(nextRunAfter(o.schedule, Date.now()), o.id);
    }
  } catch (_) { /* table may not exist yet on first boot */ }
  const handle = setInterval(() => { tick(db); }, TICK_MS);
  if (handle.unref) handle.unref();
  return handle;
}

// ── Owner CRUD (session-authed, account backends) ───────────────────────────
function registerFunctionCronRoutes(app, db) {
  const express = require('express');
  const dataPlane = require('./cloud-data-plane');

  function ownerBackend(req, res) {
    if (!dataPlane.isConfigured()) { res.status(503).json({ ok: false, error: 'cloud_not_configured' }); return null; }
    const user = getUserFromRequest(db, req);
    if (!user) { res.status(401).json({ ok: false, error: 'unauthorized' }); return null; }
    const backendId = String(req.params.backendId || '');
    const row = db.prepare('SELECT * FROM account_backends WHERE id = ? AND user_id = ?').get(backendId, user.id);
    if (!row) { res.status(404).json({ ok: false, error: 'backend_not_found' }); return null; }
    return { user, row };
  }

  app.get('/api/cloud/account/backends/:backendId/functions/:slug/schedules', (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const rows = db.prepare(
      'SELECT id, slug, schedule, input_json, enabled, last_run_at, last_status, next_run_at, created_at FROM backend_function_schedules WHERE backend_id = ? AND slug = ? ORDER BY created_at DESC'
    ).all(ctx.row.id, String(req.params.slug || '').toLowerCase());
    res.json({ ok: true, data: rows });
  });

  app.post('/api/cloud/account/backends/:backendId/functions/:slug/schedules', express.json({ limit: '16kb' }), (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const slug = String(req.params.slug || '').toLowerCase();
    if (!SLUG_RE.test(slug)) return res.status(400).json({ ok: false, error: 'invalid_slug' });
    const schedule = String((req.body && req.body.schedule) || '').trim();
    try { nextRunAfter(schedule, Date.now()); }
    catch (e) { return res.status(400).json({ ok: false, error: 'invalid_schedule', message: String(e.message || e) }); }
    let inputJson = null;
    if (req.body && req.body.input !== undefined) {
      try { inputJson = JSON.stringify(req.body.input).slice(0, 8192); } catch (_) { inputJson = null; }
    }
    // Reuse the per-tier cron cap (counts schedules across this backend).
    const max = limitsForTier(ctx.row.tier || 'free').maxCrons ?? 0;
    const count = db.prepare('SELECT COUNT(*) AS n FROM backend_function_schedules WHERE backend_id = ?').get(ctx.row.id).n;
    if (count >= max) return res.status(402).json({ ok: false, error: 'quota_exceeded', message: `Plan limit reached for scheduled functions (${max}).`, cap: max });

    const id = crypto.randomUUID();
    const now = Date.now();
    const next = nextRunAfter(schedule, now);
    db.prepare(`INSERT INTO backend_function_schedules (id, backend_id, slug, schedule, input_json, enabled, next_run_at, created_at)
                VALUES (?,?,?,?,?,1,?,?)`)
      .run(id, ctx.row.id, slug, schedule, inputJson, next, now);
    res.json({ ok: true, data: { id, slug, schedule, enabled: 1, next_run_at: next } });
  });

  app.patch('/api/cloud/account/backends/:backendId/functions/:slug/schedules/:id', express.json({ limit: '4kb' }), (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const row = db.prepare('SELECT * FROM backend_function_schedules WHERE id = ? AND backend_id = ?').get(String(req.params.id || ''), ctx.row.id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    const enabled = (req.body && req.body.enabled) ? 1 : 0;
    const next = enabled ? nextRunAfter(row.schedule, Date.now()) : null;
    db.prepare('UPDATE backend_function_schedules SET enabled = ?, next_run_at = ? WHERE id = ?').run(enabled, next, row.id);
    res.json({ ok: true, data: { id: row.id, enabled, next_run_at: next } });
  });

  app.delete('/api/cloud/account/backends/:backendId/functions/:slug/schedules/:id', (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const r = db.prepare('DELETE FROM backend_function_schedules WHERE id = ? AND backend_id = ?').run(String(req.params.id || ''), ctx.row.id);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true });
  });
}

module.exports = { startFunctionCronScheduler, registerFunctionCronRoutes, fireSchedule };
