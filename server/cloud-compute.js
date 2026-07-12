'use strict';

// cloud-compute.js — the LingCode Cloud COMPUTE TIER control plane (Sub-project 1).
//
// WHY THIS EXISTS: cloud-workers.js hosts edge apps (V8, ~30s) and cloud-worker-
// cron.js fires 30s HTTP crons. Neither can run an 800s batch, headless Chromium,
// or arbitrary long-running code — the workloads a real backend pipeline (e.g.
// cliffslist's 44 ingestion/classification cron jobs) actually needs. The compute
// tier fills that gap: long-running CONTAINER jobs on a worker droplet inside the
// VPC, each handed a privileged, schema-scoped Postgres connection (LINGCODE_DB_URL,
// minted in cloud-data-plane.js) so it gets full SQL — transactions, advisory locks,
// COPY, unbounded result sets — co-located with the managed Postgres.
//
// This module owns: the job CRUD + run-enqueue + image-intake HTTP routes, the
// per-backend access gate, tier-limit enforcement, and the credential helper the
// runner (cloud-compute-runner.js) uses to build a job's environment. The runner
// is the process that actually executes containers.
//
// CONTROL-PLANE STATE (SQLite, migrate.js → migrateComputeTables):
//   compute_jobs       — one row per declared job
//   compute_runs       — the run ledger the runner claims from
//   compute_db_creds   — per-backend clogin_<id> password (vault-encrypted)

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { getUserFromRequest } = require('./auth-helpers');
const { limitsForTier, CLOUD_TIERS } = require('./cloud-limits');
const { parseCron, nextRunAfter } = require('./cloud-worker-cron');
const dataPlane = require('./cloud-data-plane');
const vault = require('./secrets-vault');

const OVERLAP_POLICIES = new Set(['skip', 'queue', 'allow']);

// Where uploaded image tarballs land on the box. The runner `docker load`s them.
const IMAGE_DIR = process.env.COMPUTE_IMAGE_DIR || '/var/lib/lingcode/compute-images';
const MAX_IMAGE_BYTES = Number(process.env.COMPUTE_MAX_IMAGE_BYTES || 2 * 1024 * 1024 * 1024); // 2 GB
const JOB_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;       // DNS-ish, 1–64 chars
// Managed base images a job may reference without uploading its own tarball.
const MANAGED_IMAGES = new Set(
  (process.env.COMPUTE_MANAGED_IMAGES || 'lingcode/compute-node:20,lingcode/compute-node:22,lingcode/compute-browser:20')
    .split(',').map((s) => s.trim()).filter(Boolean)
);
// A permissive but bounded hostname matcher for the egress allow-list (SP3).
const HOST_RE = /^[a-z0-9.-]{1,253}$/i;

function nowIso() { return new Date().toISOString(); }
function genId(prefix) { return `${prefix}-${crypto.randomBytes(12).toString('hex')}`; }

// ── Access gate ───────────────────────────────────────────────────────────────
// Resolve the requesting user, the backend, confirm ownership, and confirm the
// owner's tier includes compute. Returns { user, backend } or sends the error and
// returns null (mirrors cloud-workers.js workerAccess).
function computeAccess(db, req, res) {
  const u = getUserFromRequest(db, req);
  if (!u) { res.status(401).json({ ok: false, error: 'unauthorized' }); return null; }
  const backendId = String(req.params.backendId || '');
  // Standalone Mac-IDE-provisioned backends live in account_backends, not
  // prototype_backends. Mirror getAnyBackendById() in cloud-backend.js so the
  // compute REST API reaches both. Without the fallback, every account-tier
  // user hits backend_not_found even though their crons run fine on the runner.
  const backend = db.prepare('SELECT * FROM prototype_backends WHERE id = ?').get(backendId)
               || db.prepare('SELECT * FROM account_backends WHERE id = ?').get(backendId);
  if (!backend) { res.status(404).json({ ok: false, error: 'backend_not_found' }); return null; }
  if (backend.user_id !== u.id) { res.status(403).json({ ok: false, error: 'forbidden' }); return null; }
  const lim = limitsForTier(u.tier || 'free');
  if (!lim.maxComputeJobs || lim.maxComputeJobs <= 0) {
    res.status(402).json({ ok: false, error: 'compute_not_in_plan', message: 'The compute tier requires a paid plan. Upgrade to run container jobs.' });
    return null;
  }
  return { user: u, backend, limits: lim };
}

// ── Credential helper (consumed by the runner) ─────────────────────────────────
// Ensure the backend has a compute login role and return its LINGCODE_DB_URL.
// The password is generated once and stored vault-encrypted, so every run reuses
// the same credential (no churn). Re-minting the role each call is idempotent and
// also self-heals a role that was dropped out-of-band.
async function getComputeDbUrl(db, backendId) {
  let row = db.prepare('SELECT * FROM compute_db_creds WHERE backend_id = ?').get(backendId);
  let password;
  if (row) {
    password = vault._decrypt(row.password_enc);
  } else {
    password = crypto.randomBytes(24).toString('base64url'); // ~32 chars
  }
  const url = await dataPlane.ensureComputeLoginRole(backendId, password);
  if (!row) {
    db.prepare(`INSERT OR REPLACE INTO compute_db_creds (backend_id, role_name, password_enc, created_at)
                VALUES (?,?,?,?)`)
      .run(backendId, dataPlane.computeRoleName(backendId), vault._encrypt(password), nowIso());
  }
  return url;
}

// ── Job + run validation ───────────────────────────────────────────────────────
// Clamp requested resources to the owner tier's ceilings; reject an image that's
// neither a managed base nor this backend's own uploaded tarball tag.
function sanitizeJob(body, limits, backendId) {
  const name = String(body.name || '').trim().toLowerCase();
  if (!JOB_NAME_RE.test(name)) { const e = new Error('name must be 1–64 chars: lowercase letters, digits, hyphens'); e.status = 400; throw e; }
  const image = String(body.image || '').trim();
  const ownTag = `lingcode-compute/${backendId}:${name}`;
  if (image !== ownTag && !MANAGED_IMAGES.has(image)) {
    const e = new Error(`image must be a managed base (${[...MANAGED_IMAGES].join(', ')}) or this job's uploaded tag (${ownTag})`);
    e.status = 400; throw e;
  }
  const cpu = Math.min(Math.max(Number(body.cpu) || 1, 0.25), 4);
  const memory_mb = Math.min(Math.max(parseInt(body.memory_mb, 10) || 512, 128), limits.maxComputeMemoryMb);
  const timeout_sec = Math.min(Math.max(parseInt(body.timeout_sec, 10) || 900, 1), limits.maxComputeTimeoutSec);
  let entrypoint = null;
  if (body.entrypoint != null) {
    if (!Array.isArray(body.entrypoint)) { const e = new Error('entrypoint must be an array of strings'); e.status = 400; throw e; }
    entrypoint = JSON.stringify(body.entrypoint.map(String).slice(0, 64));
  }
  let env_json = null;
  if (body.env && typeof body.env === 'object') {
    const env = {};
    for (const [k, v] of Object.entries(body.env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = String(v);
    }
    env_json = JSON.stringify(env);
  }
  // Egress allow-list (SP3): the hostnames this job may reach. Stored as the job's
  // declared intent + passed to the container as LINGCODE_EGRESS_HOSTS; the runner
  // box enforces it at the network layer (default-deny). null = unset.
  let egress_hosts = null;
  if (body.egress_hosts != null) {
    if (!Array.isArray(body.egress_hosts)) { const e = new Error('egress_hosts must be an array of hostnames'); e.status = 400; throw e; }
    const hosts = body.egress_hosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean).slice(0, 64);
    for (const h of hosts) { if (!HOST_RE.test(h)) { const e = new Error(`invalid egress host: ${h}`); e.status = 400; throw e; } }
    egress_hosts = JSON.stringify(hosts);
  }
  return { name, image, cpu, memory_mb, timeout_sec, entrypoint, env_json, egress_hosts };
}

// ── Tier-shortfall check (for project transfer / downgrade) ────────────────────
// Caps are enforced when a job/schedule is CREATED, but if a project is transferred
// to a lower-tier account (or the owner downgrades), the EXISTING compute config can
// exceed the new owner's plan — and the scheduler would keep running it. This reports
// that gap so the new owner is reminded to upgrade. Returns null when the config fits
// (or there's no compute config at all), else an upgrade prompt + the lowest tier that
// would fit. Safe to call from a transfer flow, describe_backend, or a login check.
function computeTierShortfall(db, backendId, tier) {
  const lim = limitsForTier(tier);
  const j = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(memory_mb),0) AS mem, COALESCE(MAX(timeout_sec),0) AS tmo FROM compute_jobs WHERE backend_id = ?').get(backendId);
  const schedN = db.prepare('SELECT COUNT(*) AS n FROM compute_schedules WHERE backend_id = ?').get(backendId).n;
  if (j.n === 0 && schedN === 0) return null; // no compute config → nothing to warn about

  const reasons = [];
  if (!lim.maxComputeJobs || lim.maxComputeJobs <= 0) {
    reasons.push(`the compute tier needs a paid plan (this project has ${j.n} job${j.n === 1 ? '' : 's'} + ${schedN} schedule${schedN === 1 ? '' : 's'})`);
  } else {
    if (j.n > lim.maxComputeJobs) reasons.push(`${j.n} jobs exceed the '${tier}' cap of ${lim.maxComputeJobs}`);
    if (schedN > lim.maxComputeSchedules) reasons.push(`${schedN} schedules exceed the '${tier}' cap of ${lim.maxComputeSchedules}`);
    if (j.mem > lim.maxComputeMemoryMb) reasons.push(`a job needs ${j.mem}MB but '${tier}' caps memory at ${lim.maxComputeMemoryMb}MB`);
    if (j.tmo > lim.maxComputeTimeoutSec) reasons.push(`a job needs ${j.tmo}s but '${tier}' caps timeout at ${lim.maxComputeTimeoutSec}s`);
  }
  if (!reasons.length) return null;

  // Lowest standard tier (ascending) whose limits fit the existing config.
  let recommendedTier = null;
  for (const t of CLOUD_TIERS) {
    const L = limitsForTier(t);
    if (L.maxComputeJobs >= j.n && L.maxComputeSchedules >= schedN && L.maxComputeMemoryMb >= j.mem && L.maxComputeTimeoutSec >= j.tmo) { recommendedTier = t; break; }
  }
  return {
    needsUpgrade: true,
    currentTier: tier,
    recommendedTier,
    reasons,
    message: recommendedTier
      ? `This project's compute jobs need the '${recommendedTier}' plan to run — your current '${tier}' plan is too low (${reasons.join('; ')}). Upgrade to keep its scheduled pipeline running.`
      : `This project's compute jobs exceed all standard plans on '${tier}' (${reasons.join('; ')}). Contact support.`,
  };
}

// ── Manifest apply (SP4 authoring core; the primitive SP5 uses) ────────────────
// Declaratively reconcile a `lingcode.compute.json` for a backend in one atomic
// transaction: upsert every job by name, then REPLACE the schedules of the jobs
// named in the manifest (declarative — a schedule removed from the file is dropped).
// Validates EVERYTHING up front so a bad entry fails the whole apply (no partial
// state). Shape:
//   { jobs: [ {name, image, cpu?, memory_mb?, timeout_sec?, env?, egress_hosts?, entrypoint?} ],
//     schedules: [ {job, schedule, overlap_policy?, max_retries?, retry_backoff_sec?, input?} ] }
function applyManifest(db, backend, limits, manifest) {
  const jobs = Array.isArray(manifest && manifest.jobs) ? manifest.jobs : [];
  const schedules = Array.isArray(manifest && manifest.schedules) ? manifest.schedules : [];

  // 1) Validate jobs (reuses sanitizeJob) and the resulting count vs the cap.
  const cleanJobs = jobs.map((j) => sanitizeJob(j, limits, backend.id));
  const names = new Set(cleanJobs.map((j) => j.name));
  if (names.size !== cleanJobs.length) { const e = new Error('duplicate job name in manifest'); e.status = 400; throw e; }
  const existingNames = new Set(db.prepare('SELECT name FROM compute_jobs WHERE backend_id = ?').all(backend.id).map((r) => r.name));
  const finalCount = new Set([...existingNames, ...names]).size;
  if (finalCount > limits.maxComputeJobs) { const e = new Error(`manifest exceeds compute job cap (${limits.maxComputeJobs})`); e.status = 402; throw e; }

  // 2) Validate schedules (cron + policy + the job they name must be in the manifest).
  const cleanScheds = schedules.map((s) => {
    const job = String(s.job || '').trim().toLowerCase();
    if (!names.has(job)) { const e = new Error(`schedule references unknown job "${job}" (must be declared in jobs[])`); e.status = 400; throw e; }
    try { parseCron(String(s.schedule || '')); } catch (err) { const e = new Error(`bad schedule for "${job}": ${err.message}`); e.status = 400; throw e; }
    const overlap = String(s.overlap_policy || 'skip');
    if (!OVERLAP_POLICIES.has(overlap)) { const e = new Error(`bad overlap_policy for "${job}"`); e.status = 400; throw e; }
    return {
      job, schedule: String(s.schedule).trim(), overlap,
      max_retries: Math.min(Math.max(parseInt(s.max_retries, 10) || 0, 0), 10),
      retry_backoff_sec: Math.min(Math.max(parseInt(s.retry_backoff_sec, 10) || 60, 1), 3600),
      input_json: s.input != null ? JSON.stringify(s.input) : null,
    };
  });
  // Total schedules after this apply (manifest replaces the named jobs' schedules,
  // keeps others') must fit the tier's schedule cap.
  if (typeof limits.maxComputeSchedules === 'number') {
    const jobIds = db.prepare(`SELECT id FROM compute_jobs WHERE backend_id = ? AND name IN (${cleanJobs.map(() => '?').join(',') || 'NULL'})`).all(backend.id, ...cleanJobs.map((j) => j.name)).map((r) => r.id);
    const keptOthers = jobIds.length
      ? db.prepare(`SELECT COUNT(*) AS n FROM compute_schedules WHERE backend_id = ? AND job_id NOT IN (${jobIds.map(() => '?').join(',')})`).get(backend.id, ...jobIds).n
      : db.prepare('SELECT COUNT(*) AS n FROM compute_schedules WHERE backend_id = ?').get(backend.id).n;
    if (keptOthers + cleanScheds.length > limits.maxComputeSchedules) {
      const e = new Error(`manifest exceeds schedule cap (${limits.maxComputeSchedules}; would be ${keptOthers + cleanScheds.length})`); e.status = 402; throw e;
    }
  }

  // 3) Apply atomically.
  const now = nowIso();
  const tx = db.transaction(() => {
    const jobIdByName = {};
    for (const j of cleanJobs) {
      const existing = db.prepare('SELECT id FROM compute_jobs WHERE backend_id = ? AND name = ?').get(backend.id, j.name);
      if (existing) {
        db.prepare(`UPDATE compute_jobs SET image=?, entrypoint=?, cpu=?, memory_mb=?, timeout_sec=?, env_json=?, egress_hosts=?, updated_at=? WHERE id=?`)
          .run(j.image, j.entrypoint, j.cpu, j.memory_mb, j.timeout_sec, j.env_json, j.egress_hosts, now, existing.id);
        jobIdByName[j.name] = existing.id;
      } else {
        const id = genId('cjob');
        db.prepare(`INSERT INTO compute_jobs (id, backend_id, user_id, name, image, entrypoint, cpu, memory_mb, timeout_sec, env_json, egress_hosts, enabled, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`)
          .run(id, backend.id, backend.user_id, j.name, j.image, j.entrypoint, j.cpu, j.memory_mb, j.timeout_sec, j.env_json, j.egress_hosts, now, now);
        jobIdByName[j.name] = id;
      }
    }
    // Declarative schedules: drop existing schedules for the manifest's jobs, re-add.
    for (const jobId of Object.values(jobIdByName)) db.prepare('DELETE FROM compute_schedules WHERE job_id = ?').run(jobId);
    for (const s of cleanScheds) {
      const id = genId('csch');
      const next = nextRunAfter(s.schedule, Date.now());
      db.prepare(`INSERT INTO compute_schedules (id, job_id, backend_id, schedule, overlap_policy, max_retries, retry_backoff_sec, input_json, enabled, next_run_at, created_at)
                  VALUES (?,?,?,?,?,?,?,?,1,?,?)`)
        .run(id, jobIdByName[s.job], backend.id, s.schedule, s.overlap, s.max_retries, s.retry_backoff_sec, s.input_json, next, now);
    }
    return { jobs: cleanJobs.length, schedules: cleanScheds.length };
  });
  return tx();
}

// ── Routes ──────────────────────────────────────────────────────────────────────
function registerCloudComputeRoutes(app, db) {
  const express = require('express');

  // Declarative manifest apply (lingcode.compute.json).
  app.post('/api/account/cloud-compute/:backendId/apply', express.json({ limit: '256kb' }), (req, res) => {
    const ctx = computeAccess(db, req, res); if (!ctx) return;
    try {
      const summary = applyManifest(db, ctx.backend, ctx.limits, req.body || {});
      res.json({ ok: true, data: summary });
    } catch (e) {
      res.status(e.status || 400).json({ ok: false, error: 'invalid_manifest', message: String(e.message || e) });
    }
  });

  // List jobs for a backend.
  app.get('/api/account/cloud-compute/:backendId/jobs', (req, res) => {
    const ctx = computeAccess(db, req, res); if (!ctx) return;
    const rows = db.prepare(
      'SELECT id, name, image, cpu, memory_mb, timeout_sec, enabled, created_at, updated_at FROM compute_jobs WHERE backend_id = ? ORDER BY name'
    ).all(ctx.backend.id);
    res.json({ ok: true, data: rows });
  });

  // Create or update (upsert by name) a job — the manifest-apply primitive.
  app.post('/api/account/cloud-compute/:backendId/jobs', express.json({ limit: '64kb' }), (req, res) => {
    const ctx = computeAccess(db, req, res); if (!ctx) return;
    let j;
    try { j = sanitizeJob(req.body || {}, ctx.limits, ctx.backend.id); }
    catch (e) { return res.status(e.status || 400).json({ ok: false, error: 'invalid_job', message: String(e.message || e) }); }

    const existing = db.prepare('SELECT id FROM compute_jobs WHERE backend_id = ? AND name = ?').get(ctx.backend.id, j.name);
    const now = nowIso();
    if (existing) {
      db.prepare(`UPDATE compute_jobs SET image=?, entrypoint=?, cpu=?, memory_mb=?, timeout_sec=?, env_json=?, egress_hosts=?, updated_at=? WHERE id=?`)
        .run(j.image, j.entrypoint, j.cpu, j.memory_mb, j.timeout_sec, j.env_json, j.egress_hosts, now, existing.id);
      return res.json({ ok: true, data: { id: existing.id, ...j, updated: true } });
    }
    // New job — enforce the per-backend job count cap.
    const count = db.prepare('SELECT COUNT(*) AS n FROM compute_jobs WHERE backend_id = ?').get(ctx.backend.id).n;
    if (count >= ctx.limits.maxComputeJobs) {
      return res.status(402).json({ ok: false, error: 'quota_exceeded', message: `Plan limit reached for compute jobs (${ctx.limits.maxComputeJobs}). Upgrade for more.`, cap: ctx.limits.maxComputeJobs });
    }
    const id = genId('cjob');
    db.prepare(`INSERT INTO compute_jobs (id, backend_id, user_id, name, image, entrypoint, cpu, memory_mb, timeout_sec, env_json, egress_hosts, enabled, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`)
      .run(id, ctx.backend.id, ctx.user.id, j.name, j.image, j.entrypoint, j.cpu, j.memory_mb, j.timeout_sec, j.env_json, j.egress_hosts, now, now);
    res.json({ ok: true, data: { id, ...j, updated: false } });
  });

  app.delete('/api/account/cloud-compute/:backendId/jobs/:jobId', (req, res) => {
    const ctx = computeAccess(db, req, res); if (!ctx) return;
    const r = db.prepare('DELETE FROM compute_jobs WHERE id = ? AND backend_id = ?').run(String(req.params.jobId || ''), ctx.backend.id);
    if (!r.changes) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true });
  });

  // Upload a docker image tarball (gzip of `docker save`) for a job. The runner
  // `docker load`s it before the first run. Streamed straight to disk; the body is
  // the raw tarball (Content-Type application/octet-stream). Mirrors the synchronous
  // upload-then-respond shape of cloud-workers.js.
  app.put('/api/account/cloud-compute/:backendId/jobs/:jobId/image',
    express.raw({ type: '*/*', limit: MAX_IMAGE_BYTES }), (req, res) => {
      const ctx = computeAccess(db, req, res); if (!ctx) return;
      const job = db.prepare('SELECT * FROM compute_jobs WHERE id = ? AND backend_id = ?').get(String(req.params.jobId || ''), ctx.backend.id);
      if (!job) return res.status(404).json({ ok: false, error: 'not_found' });
      const buf = req.body;
      if (!buf || !buf.length) return res.status(400).json({ ok: false, error: 'empty_upload' });
      try {
        fs.mkdirSync(IMAGE_DIR, { recursive: true });
        const dest = path.join(IMAGE_DIR, `${ctx.backend.id}__${job.name}.tar.gz`);
        fs.writeFileSync(dest, buf);
        // Point the job at its own loaded tag; the runner loads `dest` → this tag.
        const tag = `lingcode-compute/${ctx.backend.id}:${job.name}`;
        db.prepare('UPDATE compute_jobs SET image = ?, updated_at = ? WHERE id = ?').run(tag, nowIso(), job.id);
        res.json({ ok: true, data: { image: tag, bytes: buf.length } });
      } catch (e) {
        res.status(500).json({ ok: false, error: 'image_write_failed', message: String(e.message || e).slice(0, 500) });
      }
    });

  // Enqueue a run (manual trigger). Respects the per-backend concurrency cap by
  // counting currently-active (queued|running) runs for the backend.
  app.post('/api/account/cloud-compute/:backendId/jobs/:jobId/run', express.json({ limit: '256kb' }), (req, res) => {
    const ctx = computeAccess(db, req, res); if (!ctx) return;
    const job = db.prepare('SELECT * FROM compute_jobs WHERE id = ? AND backend_id = ?').get(String(req.params.jobId || ''), ctx.backend.id);
    if (!job) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!job.enabled) return res.status(409).json({ ok: false, error: 'job_disabled' });

    const active = db.prepare(`SELECT COUNT(*) AS n FROM compute_runs WHERE backend_id = ? AND status IN ('queued','running')`).get(ctx.backend.id).n;
    if (active >= ctx.limits.maxComputeConcurrentRuns) {
      return res.status(429).json({ ok: false, error: 'concurrency_limit', message: `Too many active runs (${ctx.limits.maxComputeConcurrentRuns}). Wait for one to finish.`, cap: ctx.limits.maxComputeConcurrentRuns });
    }
    let inputJson = null;
    if (req.body && req.body.input != null) { try { inputJson = JSON.stringify(req.body.input); } catch (_) { inputJson = null; } }
    const id = genId('crun');
    db.prepare(`INSERT INTO compute_runs (id, job_id, backend_id, status, trigger, input_json, queued_at)
                VALUES (?,?,?,'queued','manual',?,?)`)
      .run(id, job.id, ctx.backend.id, inputJson, nowIso());
    res.json({ ok: true, data: { run_id: id, status: 'queued' } });
  });

  // List recent runs for a backend (newest first).
  app.get('/api/account/cloud-compute/:backendId/runs', (req, res) => {
    const ctx = computeAccess(db, req, res); if (!ctx) return;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const rows = db.prepare(
      `SELECT r.id, r.job_id, j.name AS job_name, r.status, r.trigger, r.exit_code, r.queued_at, r.started_at, r.finished_at, r.error
       FROM compute_runs r JOIN compute_jobs j ON j.id = r.job_id
       WHERE r.backend_id = ? ORDER BY r.queued_at DESC LIMIT ?`
    ).all(ctx.backend.id, limit);
    res.json({ ok: true, data: rows });
  });

  // Inspect one run incl. the captured log tail.
  app.get('/api/account/cloud-compute/:backendId/runs/:runId', (req, res) => {
    const ctx = computeAccess(db, req, res); if (!ctx) return;
    const row = db.prepare('SELECT * FROM compute_runs WHERE id = ? AND backend_id = ?').get(String(req.params.runId || ''), ctx.backend.id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, data: row });
  });

  // Request cancellation. A queued run is canceled immediately; a running run is
  // flagged (cancel_requested) and the runner kills its container on the next poll.
  app.post('/api/account/cloud-compute/:backendId/runs/:runId/cancel', (req, res) => {
    const ctx = computeAccess(db, req, res); if (!ctx) return;
    const row = db.prepare('SELECT * FROM compute_runs WHERE id = ? AND backend_id = ?').get(String(req.params.runId || ''), ctx.backend.id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    if (row.status === 'queued') {
      db.prepare(`UPDATE compute_runs SET status='canceled', finished_at=?, error='canceled before start' WHERE id=? AND status='queued'`).run(nowIso(), row.id);
      return res.json({ ok: true, data: { status: 'canceled' } });
    }
    if (row.status === 'running') {
      db.prepare(`UPDATE compute_runs SET error='cancel_requested' WHERE id=?`).run(row.id);
      return res.json({ ok: true, data: { status: 'cancel_requested' } });
    }
    res.status(409).json({ ok: false, error: 'not_cancelable', message: `run is already ${row.status}` });
  });
}

module.exports = {
  registerCloudComputeRoutes,
  getComputeDbUrl,
  // exported for the runner + tests
  computeAccess,
  sanitizeJob,
  applyManifest,
  computeTierShortfall,
  IMAGE_DIR,
  MANAGED_IMAGES,
};
