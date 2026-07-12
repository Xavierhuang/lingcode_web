'use strict';

// cloud-compute-scheduler.js — cron scheduling for the COMPUTE TIER (Sub-project 2).
//
// Promotes the compute tier from "run a job on demand" to "run the 44 cron jobs a
// real pipeline needs". A 60s tick (one per API process, like cloud-worker-cron.js)
// finds due `compute_schedules` and enqueues a 'schedule'-trigger run into
// compute_runs — which the runner (cloud-compute-runner.js) then claims. Two things
// the 30s worker-cron path can't do, that pipelines require:
//
//   • OVERLAP CONTROL — `skip` (don't start if the job already has an active run —
//     this replaces cliffslist's advisory-lock-for-serialization at the platform
//     level), `queue` (enqueue anyway; it waits its turn), or `allow` (concurrent).
//   • RETRIES — a failed/timed-out scheduled run is re-enqueued up to max_retries
//     with exponential backoff (via compute_runs.not_before).
//
// Cron parsing is shared with cloud-worker-cron.js (5-field, UTC). Schedule
// timestamps are epoch ms (matching worker_crons); run timestamps are ISO strings
// (matching compute_runs).

const crypto = require('crypto');
const { parseCron, nextRunAfter } = require('./cloud-worker-cron');
const { computeAccess, computeTierShortfall } = require('./cloud-compute');

// Resolve the backend owner's tier (prototype_backends.user_id → users.tier).
// Returns null if it can't be resolved (missing tables/rows) — callers treat null
// as "don't enforce", so a partial DB never blocks legitimate runs.
function ownerTier(db, backendId) {
  try {
    const r = db.prepare('SELECT u.tier AS tier FROM prototype_backends b JOIN users u ON u.id = b.user_id WHERE b.id = ?').get(backendId);
    return r ? r.tier : null;
  } catch (_) { return null; }
}

const TICK_MS = 60 * 1000;
const OVERLAP_POLICIES = new Set(['skip', 'queue', 'allow']);
const MAX_RETRIES_CAP = 10;

const nowIso = () => new Date().toISOString();
const genId = (p) => `${p}-${crypto.randomBytes(12).toString('hex')}`;

// ── Enqueue helpers ─────────────────────────────────────────────────────────────
function insertRun(db, { jobId, backendId, scheduleId, trigger, inputJson, attempt, maxAttempts, notBefore }) {
  const id = genId('crun');
  db.prepare(`INSERT INTO compute_runs (id, job_id, backend_id, status, trigger, input_json, schedule_id, attempt, max_attempts, not_before, queued_at)
              VALUES (?,?,?,'queued',?,?,?,?,?,?,?)`)
    .run(id, jobId, backendId, trigger, inputJson || null, scheduleId, attempt, maxAttempts, notBefore || null, nowIso());
  return id;
}

// Enqueue every schedule due at `nowMs`, applying its overlap policy, then advance
// next_run_at. Returns a small summary for tests/telemetry.
function enqueueDue(db, nowMs) {
  const due = db.prepare(
    'SELECT * FROM compute_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? LIMIT 500'
  ).all(nowMs);
  let enqueued = 0, skipped = 0, blocked = 0;
  const tierCache = new Map(); // backendId → shortfall-or-null, computed once per tick
  for (const s of due) {
    let status;
    // Tier enforcement: if the backend owner's plan can't run this project's compute
    // config (e.g. after a transfer to a lower tier), DON'T run — flag it so the
    // owner is reminded to upgrade. Unresolvable tier (null) means don't enforce.
    if (!tierCache.has(s.backend_id)) {
      const tier = ownerTier(db, s.backend_id);
      tierCache.set(s.backend_id, tier ? computeTierShortfall(db, s.backend_id, tier) : null);
    }
    if (tierCache.get(s.backend_id)) {
      status = 'blocked_tier'; blocked++;
    } else if (s.overlap_policy === 'skip') {
      const active = db.prepare(`SELECT COUNT(*) AS n FROM compute_runs WHERE job_id = ? AND status IN ('queued','running')`).get(s.job_id).n;
      if (active > 0) { status = 'skipped'; skipped++; }
      else { insertRun(db, { jobId: s.job_id, backendId: s.backend_id, scheduleId: s.id, trigger: 'schedule', inputJson: s.input_json, attempt: 0, maxAttempts: s.max_retries }); status = 'enqueued'; enqueued++; }
    } else {
      insertRun(db, { jobId: s.job_id, backendId: s.backend_id, scheduleId: s.id, trigger: 'schedule', inputJson: s.input_json, attempt: 0, maxAttempts: s.max_retries });
      status = 'enqueued'; enqueued++;
    }
    let next = null; try { next = nextRunAfter(s.schedule, nowMs); } catch (_) { next = null; }
    db.prepare('UPDATE compute_schedules SET last_run_at = ?, last_status = ?, next_run_at = ? WHERE id = ?').run(nowMs, status, next, s.id);
  }
  return { enqueued, skipped, blocked, due: due.length };
}

// Re-enqueue failed/timed-out scheduled runs that have retries left, exactly once
// each (retry_scheduled guard), with exponential backoff applied via not_before.
function retrySweep(db, nowMs) {
  const failed = db.prepare(
    `SELECT * FROM compute_runs WHERE status IN ('failed','timed_out') AND retry_scheduled = 0 AND schedule_id IS NOT NULL AND attempt < max_attempts LIMIT 200`
  ).all();
  let retried = 0;
  for (const r of failed) {
    const s = db.prepare('SELECT retry_backoff_sec FROM compute_schedules WHERE id = ?').get(r.schedule_id);
    const backoffSec = (s ? s.retry_backoff_sec : 60) * Math.pow(2, r.attempt); // exponential
    const notBefore = new Date(nowMs + backoffSec * 1000).toISOString();
    const tx = db.transaction(() => {
      const upd = db.prepare('UPDATE compute_runs SET retry_scheduled = 1 WHERE id = ? AND retry_scheduled = 0').run(r.id);
      if (!upd.changes) return; // someone else already handled it
      insertRun(db, { jobId: r.job_id, backendId: r.backend_id, scheduleId: r.schedule_id, trigger: 'retry', inputJson: r.input_json, attempt: r.attempt + 1, maxAttempts: r.max_attempts, notBefore });
      retried++;
    });
    tx();
  }
  return { retried };
}

let _ticking = false;
function tick(db, nowMs = Date.now()) {
  if (_ticking) return;
  _ticking = true;
  try { enqueueDue(db, nowMs); retrySweep(db, nowMs); }
  catch (_) { /* keep the scheduler alive across any single-tick failure */ }
  finally { _ticking = false; }
}

function startComputeScheduler(db) {
  // Backfill next_run_at for any enabled schedule missing it (created while the
  // scheduler was down), same as cloud-worker-cron.
  try {
    const orphans = db.prepare('SELECT id, schedule FROM compute_schedules WHERE enabled = 1 AND next_run_at IS NULL').all();
    for (const o of orphans) {
      let next = null; try { next = nextRunAfter(o.schedule, Date.now()); } catch (_) {}
      db.prepare('UPDATE compute_schedules SET next_run_at = ? WHERE id = ?').run(next, o.id);
    }
  } catch (_) { /* table may not exist yet on first boot */ }
  const handle = setInterval(() => tick(db), TICK_MS);
  if (handle.unref) handle.unref();
  return handle;
}

// ── CRUD routes ───────────────────────────────────────────────────────────────
function registerComputeScheduleRoutes(app, db) {
  const express = require('express');

  app.get('/api/account/cloud-compute/:backendId/schedules', (req, res) => {
    const ctx = computeAccess(db, req, res); if (!ctx) return;
    const rows = db.prepare(
      `SELECT s.*, j.name AS job_name FROM compute_schedules s JOIN compute_jobs j ON j.id = s.job_id
       WHERE s.backend_id = ? ORDER BY s.created_at DESC`
    ).all(ctx.backend.id);
    res.json({ ok: true, data: rows });
  });

  app.post('/api/account/cloud-compute/:backendId/jobs/:jobId/schedules', express.json({ limit: '64kb' }), (req, res) => {
    const ctx = computeAccess(db, req, res); if (!ctx) return;
    const job = db.prepare('SELECT * FROM compute_jobs WHERE id = ? AND backend_id = ?').get(String(req.params.jobId || ''), ctx.backend.id);
    if (!job) return res.status(404).json({ ok: false, error: 'job_not_found' });

    const body = req.body || {};
    const schedule = String(body.schedule || '').trim();
    try { parseCron(schedule); } catch (e) { return res.status(400).json({ ok: false, error: 'invalid_schedule', message: String(e.message || e) }); }
    const overlap = String(body.overlap_policy || 'skip');
    if (!OVERLAP_POLICIES.has(overlap)) return res.status(400).json({ ok: false, error: 'invalid_overlap_policy', message: 'overlap_policy must be skip | queue | allow' });
    const maxRetries = Math.min(Math.max(parseInt(body.max_retries, 10) || 0, 0), MAX_RETRIES_CAP);
    const backoff = Math.min(Math.max(parseInt(body.retry_backoff_sec, 10) || 60, 1), 3600);
    let inputJson = null;
    if (body.input != null) { try { inputJson = JSON.stringify(body.input); } catch (_) { inputJson = null; } }

    // Cap schedules per backend (a real pipeline has many schedules per job — e.g.
    // cliffslist runs ~86 across ~43 jobs — so this is its own, higher limit).
    const schedCap = ctx.limits.maxComputeSchedules;
    const count = db.prepare('SELECT COUNT(*) AS n FROM compute_schedules WHERE backend_id = ?').get(ctx.backend.id).n;
    if (count >= schedCap) {
      return res.status(402).json({ ok: false, error: 'quota_exceeded', message: `Plan limit reached for schedules (${schedCap}).`, cap: schedCap });
    }
    const id = genId('csch');
    const next = nextRunAfter(schedule, Date.now());
    db.prepare(`INSERT INTO compute_schedules (id, job_id, backend_id, schedule, overlap_policy, max_retries, retry_backoff_sec, input_json, enabled, next_run_at, created_at)
                VALUES (?,?,?,?,?,?,?,?,1,?,?)`)
      .run(id, job.id, ctx.backend.id, schedule, overlap, maxRetries, backoff, inputJson, next, nowIso());
    res.json({ ok: true, data: { id, job_id: job.id, schedule, overlap_policy: overlap, max_retries: maxRetries, retry_backoff_sec: backoff, enabled: 1, next_run_at: next } });
  });

  app.patch('/api/account/cloud-compute/:backendId/schedules/:schedId', express.json({ limit: '8kb' }), (req, res) => {
    const ctx = computeAccess(db, req, res); if (!ctx) return;
    const row = db.prepare('SELECT * FROM compute_schedules WHERE id = ? AND backend_id = ?').get(String(req.params.schedId || ''), ctx.backend.id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    const enabled = (req.body && req.body.enabled) ? 1 : 0;
    const next = enabled ? nextRunAfter(row.schedule, Date.now()) : null;
    db.prepare('UPDATE compute_schedules SET enabled = ?, next_run_at = ? WHERE id = ?').run(enabled, next, row.id);
    res.json({ ok: true, data: { id: row.id, enabled, next_run_at: next } });
  });

  app.delete('/api/account/cloud-compute/:backendId/schedules/:schedId', (req, res) => {
    const ctx = computeAccess(db, req, res); if (!ctx) return;
    const r = db.prepare('DELETE FROM compute_schedules WHERE id = ? AND backend_id = ?').run(String(req.params.schedId || ''), ctx.backend.id);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true });
  });
}

module.exports = {
  registerComputeScheduleRoutes,
  startComputeScheduler,
  // exported for tests
  tick, enqueueDue, retrySweep, insertRun,
};
