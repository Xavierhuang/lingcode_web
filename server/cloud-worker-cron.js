'use strict';

// cloud-worker-cron.js — scheduled jobs for the COMPUTE tier (cloud-workers.js).
//
// WHY THIS EXISTS: Cloudflare rejects per-tenant Cron Triggers on Workers-for-
// Platforms *dispatch* scripts, so a deployed tenant Worker can't schedule its own
// background work. Instead LingCode runs ONE scheduler here (a 60s setInterval in
// the API process) that, each minute, finds due rows in `worker_crons` and fires a
// signed HTTP request to https://<worker>.run.lingcode.dev<path>. The tenant app
// handles that request like any other route — its "cron handler" is just an HTTP
// endpoint it guards with the HMAC header we send.
//
// Auth: every fired request carries
//   X-LingCode-Cron:           <worker id>
//   X-LingCode-Cron-Timestamp: <epoch ms>
//   X-LingCode-Cron-Signature: hex HMAC-SHA256(`${id}.${ts}`, LINGCODE_CRON_SIGNING_KEY)
// so the app can verify the call is a genuine LingCode-scheduled invocation and not
// a public hit. If the signing key isn't configured, the timestamp is still sent but
// no signature — the app should then treat the endpoint as best-effort.
//
// Cron syntax: standard 5 fields  ┌ minute (0-59)
//                                 │ ┌ hour (0-23)
//                                 │ │ ┌ day-of-month (1-31)
//                                 │ │ │ ┌ month (1-12)
//                                 │ │ │ │ ┌ day-of-week (0-6, 0/7=Sun)
//   * , - and */step supported. DOM/DOW use cron's OR semantics when both restricted.

const crypto = require('crypto');
const { limitsForTier } = require('./cloud-limits');

const SIGNING_KEY = process.env.LINGCODE_CRON_SIGNING_KEY || '';
const APPS_DOMAIN = process.env.LINGCODE_APPS_DOMAIN || 'run.lingcode.dev';
const FIRE_TIMEOUT_MS = 30 * 1000;          // matches the Worker ~30s ceiling
const TICK_MS = 60 * 1000;
const PATH_MAX = 512;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

// ── Cron parsing ───────────────────────────────────────────────────────────
// dow accepts 0-7 (both 0 and 7 = Sunday); parseCron normalizes 7 → 0 afterward.
const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

// Expand one field ("*", "5", "1,2", "1-5", "*/15", "0-30/10") into a Set of ints.
function parseField(spec, min, max) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`bad cron field: "${part}"`);
    const [, range, stepRaw] = m;
    const step = stepRaw ? parseInt(stepRaw, 10) : 1;
    if (step < 1) throw new Error(`bad cron step: "${part}"`);
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) { const [a, b] = range.split('-').map((n) => parseInt(n, 10)); lo = a; hi = b; }
    else { lo = hi = parseInt(range, 10); }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron field out of range: "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

// Parse a 5-field expression into matcher sets. Throws on anything malformed so the
// CRUD route can 400 instead of silently never firing.
function parseCron(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron must have 5 fields (min hour dom month dow)');
  const sets = fields.map((f, i) => parseField(f, FIELD_RANGES[i][0], FIELD_RANGES[i][1]));
  // Normalize Sunday: cron allows 7 for Sunday; we store 0.
  if (sets[4].has(7)) { sets[4].add(0); sets[4].delete(7); }
  return {
    minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4],
    domRestricted: fields[2] !== '*', dowRestricted: fields[4] !== '*',
  };
}

function matches(c, d) {
  if (!c.minute.has(d.getUTCMinutes())) return false;
  if (!c.hour.has(d.getUTCHours())) return false;
  if (!c.month.has(d.getUTCMonth() + 1)) return false;
  const domOk = c.dom.has(d.getUTCDate());
  const dowOk = c.dow.has(d.getUTCDay());
  // Cron OR semantics: when BOTH dom and dow are restricted, either matching fires.
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk;
  if (c.domRestricted) return domOk;
  if (c.dowRestricted) return dowOk;
  return true; // both '*'
}

// Next firing strictly after `fromMs` (UTC, minute granularity). Returns null if
// nothing matches within a year (e.g. an impossible date like Feb 30).
function nextRunAfter(expr, fromMs) {
  const c = parseCron(expr);
  const d = new Date(fromMs);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1); // strictly after
  const limit = fromMs + 366 * 24 * 60 * 60 * 1000;
  while (d.getTime() <= limit) {
    if (matches(c, d)) return d.getTime();
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  return null;
}

function signCron(id, ts) {
  if (!SIGNING_KEY) return null;
  return crypto.createHmac('sha256', SIGNING_KEY).update(`${id}.${ts}`).digest('hex');
}

// ── Firing one due cron ─────────────────────────────────────────────────────
async function fireCron(db, row) {
  const ts = Date.now();
  const url = `https://${row.worker_id}.${APPS_DOMAIN}${row.path || '/'}`;
  const headers = { 'X-LingCode-Cron': row.worker_id, 'X-LingCode-Cron-Timestamp': String(ts) };
  const sig = signCron(row.worker_id, ts);
  if (sig) headers['X-LingCode-Cron-Signature'] = sig;
  if (row.headers_json) { try { Object.assign(headers, JSON.parse(row.headers_json)); } catch (_) {} }

  let status = 0;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FIRE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: row.method || 'POST', headers, signal: ctrl.signal });
    status = res.status;
  } catch (_) {
    status = 0; // network error / timeout
  } finally {
    clearTimeout(t);
  }

  const next = nextRunAfter(row.schedule, ts);
  db.prepare('UPDATE worker_crons SET last_run_at = ?, last_status = ?, next_run_at = ? WHERE id = ?')
    .run(ts, status, next, row.id);
}

let _ticking = false;
async function tick(db) {
  if (_ticking) return;            // never overlap a slow tick with the next
  _ticking = true;
  try {
    const now = Date.now();
    const due = db.prepare(
      'SELECT * FROM worker_crons WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? LIMIT 200'
    ).all(now);
    // Lightweight HTTP fan-out; settle all, never throw out of the tick.
    await Promise.allSettled(due.map((row) => fireCron(db, row)));
  } catch (_) { /* keep the scheduler alive across any single-tick failure */ } finally {
    _ticking = false;
  }
}

// Start the 60s scheduler. Backfills next_run_at for any rows missing it (e.g.
// created while the scheduler was down). Returns the interval handle.
function startWorkerCronScheduler(db) {
  try {
    const orphans = db.prepare('SELECT id, schedule FROM worker_crons WHERE enabled = 1 AND next_run_at IS NULL').all();
    for (const o of orphans) {
      const next = nextRunAfter(o.schedule, Date.now());
      db.prepare('UPDATE worker_crons SET next_run_at = ? WHERE id = ?').run(next, o.id);
    }
  } catch (_) { /* table may not exist yet on first boot */ }
  const handle = setInterval(() => { tick(db); }, TICK_MS);
  if (handle.unref) handle.unref();
  return handle;
}

// ── CRUD routes ─────────────────────────────────────────────────────────────
function registerWorkerCronRoutes(app, db) {
  // workerAccess is the same membership gate the worker domain routes use.
  const { workerAccess } = require('./cloud-workers');
  const express = require('express');

  app.get('/api/account/cloud-workers/:id/crons', (req, res) => {
    const ctx = workerAccess(db, req, res, 'viewer'); if (!ctx) return;
    const rows = db.prepare(
      'SELECT id, schedule, path, method, enabled, last_run_at, last_status, next_run_at, created_at FROM worker_crons WHERE worker_id = ? ORDER BY created_at DESC'
    ).all(ctx.row.id);
    res.json({ ok: true, data: rows });
  });

  app.post('/api/account/cloud-workers/:id/crons', express.json({ limit: '16kb' }), (req, res) => {
    const ctx = workerAccess(db, req, res, 'editor'); if (!ctx) return;
    const body = req.body || {};
    const schedule = String(body.schedule || '').trim();
    const reqPath = String(body.path || '/').trim();
    const method = String(body.method || 'POST').trim().toUpperCase();

    try { nextRunAfter(schedule, Date.now()); }
    catch (e) { return res.status(400).json({ ok: false, error: 'invalid_schedule', message: String(e.message || e) }); }
    if (!reqPath.startsWith('/') || reqPath.length > PATH_MAX) {
      return res.status(400).json({ ok: false, error: 'invalid_path', message: 'path must start with "/" and be ≤ 512 chars.' });
    }
    if (!ALLOWED_METHODS.has(method)) return res.status(400).json({ ok: false, error: 'invalid_method' });
    let headersJson = null;
    if (body.headers && typeof body.headers === 'object') {
      try { headersJson = JSON.stringify(body.headers).slice(0, 4096); } catch (_) { headersJson = null; }
    }

    // Per-tier maxCrons cap (per worker). Owner's tier governs.
    const max = limitsForTier(ctx.user.tier || 'free').maxCrons ?? 0;
    const count = db.prepare('SELECT COUNT(*) AS n FROM worker_crons WHERE worker_id = ?').get(ctx.row.id).n;
    if (count >= max) {
      return res.status(402).json({ ok: false, error: 'quota_exceeded', message: `Plan limit reached for scheduled jobs (${max}). Upgrade for more.`, cap: max });
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const next = nextRunAfter(schedule, now);
    db.prepare(`INSERT INTO worker_crons (id, worker_id, user_id, schedule, path, method, headers_json, enabled, next_run_at, created_at)
                VALUES (?,?,?,?,?,?,?,1,?,?)`)
      .run(id, ctx.row.id, ctx.user.id, schedule, reqPath, method, headersJson, next, now);
    res.json({ ok: true, data: { id, schedule, path: reqPath, method, enabled: 1, next_run_at: next } });
  });

  // Toggle enabled / disabled (PATCH { enabled: bool }).
  app.patch('/api/account/cloud-workers/:id/crons/:cronId', express.json({ limit: '4kb' }), (req, res) => {
    const ctx = workerAccess(db, req, res, 'editor'); if (!ctx) return;
    const cronId = String(req.params.cronId || '');
    const row = db.prepare('SELECT * FROM worker_crons WHERE id = ? AND worker_id = ?').get(cronId, ctx.row.id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    const enabled = (req.body && req.body.enabled) ? 1 : 0;
    const next = enabled ? nextRunAfter(row.schedule, Date.now()) : null;
    db.prepare('UPDATE worker_crons SET enabled = ?, next_run_at = ? WHERE id = ?').run(enabled, next, cronId);
    res.json({ ok: true, data: { id: cronId, enabled, next_run_at: next } });
  });

  app.delete('/api/account/cloud-workers/:id/crons/:cronId', (req, res) => {
    const ctx = workerAccess(db, req, res, 'editor'); if (!ctx) return;
    const cronId = String(req.params.cronId || '');
    const r = db.prepare('DELETE FROM worker_crons WHERE id = ? AND worker_id = ?').run(cronId, ctx.row.id);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true });
  });
}

module.exports = {
  registerWorkerCronRoutes,
  startWorkerCronScheduler,
  // exported for tests
  parseCron, nextRunAfter, matches, signCron,
};
