'use strict';

// cloud-compute-runner.js — the COMPUTE TIER executor (Sub-project 1).
//
// Polls the compute_runs queue (SQLite, see migrate.js), atomically claims a
// 'queued' row, and runs the job's container with `docker run`, handing it a
// privileged LINGCODE_DB_URL (cloud-compute.js → cloud-data-plane.js) so the job
// gets full SQL against its tenant schema. Captures a log tail, enforces the
// per-run wall-clock timeout, honours cancellation, and records the terminal
// status + exit code back into compute_runs.
//
// DEPLOYMENT: this code ships everywhere (index.js calls startComputeRunner), but
// only ACTIVATES where COMPUTE_RUNNER_ENABLED=1 — i.e. the worker droplet(s) in
// the VPC that have Docker and private-network reach to Postgres. The API box
// leaves it dormant, so wiring it in index.js is always safe.
//
// Concurrency: a single runner process executes up to COMPUTE_MAX_CONCURRENT
// containers at once. Per-backend concurrency is enforced at enqueue time
// (cloud-compute.js); the global slot count is the box's safety bound. Scale out
// by running this on more droplets — claims are atomic, so N runners share one
// queue without double-execution.

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { getComputeDbUrl, IMAGE_DIR } = require('./cloud-compute');
const vault = require('./secrets-vault');

const ENABLED = process.env.COMPUTE_RUNNER_ENABLED === '1';
const MAX_CONCURRENT = Math.max(1, Number(process.env.COMPUTE_MAX_CONCURRENT || 4));
const POLL_MS = Math.max(500, Number(process.env.COMPUTE_POLL_MS || 2000));
const DOCKER_BIN = process.env.COMPUTE_DOCKER_BIN || 'docker';
const DOCKER_NETWORK = process.env.COMPUTE_DOCKER_NETWORK || '';     // e.g. a VPC bridge network
const LOG_TAIL_BYTES = Math.max(8 * 1024, Number(process.env.COMPUTE_LOG_TAIL_BYTES || 64 * 1024));
const LOG_FLUSH_MS = 2000;
const WORKER_ID = process.env.COMPUTE_WORKER_ID || `${os.hostname()}:${process.pid}`;
// Container hardening (see COMPUTE_SECURITY_REVIEW.md F-7). On by default; the
// flag set is overridable for images that need more (the SP3 browser image adds
// back the seccomp/caps Chromium needs). pids-limit caps fork bombs; cap-drop +
// no-new-privileges + read-only rootfs shrink the escape surface; tmpfs restores
// a writable /tmp.
const HARDEN = process.env.COMPUTE_HARDEN !== '0';
const HARDEN_FLAGS = (process.env.COMPUTE_HARDEN_FLAGS
  || '--pids-limit=512 --cap-drop=ALL --security-opt=no-new-privileges --read-only --tmpfs=/tmp:rw,size=512m')
  .split(/\s+/).filter(Boolean);

const nowIso = () => new Date().toISOString();

// A bounded log buffer: keeps only the last LOG_TAIL_BYTES across all appended
// chunks (head-dropped), so a chatty job can't exhaust memory or the DB column.
function makeLogTail() {
  let chunks = [];
  let size = 0;
  return {
    push(buf) {
      chunks.push(buf); size += buf.length;
      while (size > LOG_TAIL_BYTES && chunks.length > 1) { size -= chunks[0].length; chunks.shift(); }
    },
    toString() {
      let s = Buffer.concat(chunks).toString('utf8');
      if (Buffer.byteLength(s, 'utf8') > LOG_TAIL_BYTES) s = '…(truncated)…\n' + s.slice(-LOG_TAIL_BYTES);
      return s;
    },
  };
}

// Atomically claim the oldest queued run. better-sqlite3 transactions are
// synchronous + serialized, so the SELECT-then-UPDATE can't race another claim in
// this process; the `AND status='queued'` guard makes it safe across processes too.
function claimNext(db) {
  const tx = db.transaction(() => {
    // `not_before` gates backoff-delayed retries and future-dated enqueues (ISO
    // strings sort lexically, so the comparison is correct for UTC timestamps).
    const row = db.prepare(
      `SELECT * FROM compute_runs WHERE status='queued' AND (not_before IS NULL OR not_before <= ?) ORDER BY queued_at LIMIT 1`
    ).get(nowIso());
    if (!row) return null;
    const r = db.prepare(`UPDATE compute_runs SET status='running', worker_id=?, started_at=? WHERE id=? AND status='queued'`)
      .run(WORKER_ID, nowIso(), row.id);
    return r.changes ? row : null;
  });
  return tx();
}

// Load a job's uploaded image tarball into the local docker registry if its tag
// isn't already present. Managed-base images are pulled by docker on demand, so
// this only applies to `lingcode-compute/<backend>:<name>` tags.
async function ensureImage(job) {
  if (!String(job.image).startsWith('lingcode-compute/')) return; // managed base → docker pulls
  const present = await runDocker(['image', 'inspect', job.image], 5000).then((r) => r.code === 0).catch(() => false);
  if (present) return;
  const tar = path.join(IMAGE_DIR, `${job.backend_id}__${job.name}.tar.gz`);
  if (!fs.existsSync(tar)) { const e = new Error(`image tarball missing for ${job.image} (${tar})`); e.code = 'image_missing'; throw e; }
  const loaded = await runDocker(['load', '-i', tar], 120000);
  if (loaded.code !== 0) { const e = new Error(`docker load failed: ${loaded.out.slice(0, 300)}`); e.code = 'image_load_failed'; throw e; }
}

// Small promise wrapper for short-lived docker control commands (inspect/load/kill).
function runDocker(args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(DOCKER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.stderr.on('data', (d) => { out += d.toString('utf8'); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
    p.on('error', (err) => { clearTimeout(t); resolve({ code: -1, out: String(err.message || err) }); });
  });
}

// SP4 metering: accumulate compute run-seconds per backend per UTC day in the
// shared backend_usage table (one row per backend/day, like every other metric).
// Best-effort — a metering failure must never fail the run.
function meterRunSeconds(db, backendId, seconds) {
  if (!(seconds > 0)) return;
  const day = new Date().toISOString().slice(0, 10);
  try {
    db.prepare(`INSERT INTO backend_usage (backend_id, day, compute_run_seconds) VALUES (?, ?, ?)
                ON CONFLICT(backend_id, day) DO UPDATE SET compute_run_seconds = compute_run_seconds + excluded.compute_run_seconds`)
      .run(backendId, day, seconds);
  } catch (_) { /* metering is best-effort */ }
}

// Execute one claimed run end-to-end and record its terminal status.
async function execRun(db, run) {
  const job = db.prepare('SELECT * FROM compute_jobs WHERE id = ?').get(run.job_id);
  const tail = makeLogTail();
  const startedMs = Date.now();
  const finish = (status, exitCode, error) => {
    const runSeconds = Math.round((Date.now() - startedMs) / 100) / 10; // 0.1s precision
    db.prepare(`UPDATE compute_runs SET status=?, exit_code=?, error=?, logs=?, run_seconds=?, finished_at=? WHERE id=?`)
      .run(status, exitCode == null ? null : exitCode, error || null, tail.toString(), runSeconds, nowIso(), run.id);
    meterRunSeconds(db, run.backend_id, runSeconds); // SP4 billing rollup
  };

  let envFile = null;
  try {
    if (!job) { finish('failed', null, 'job no longer exists'); return; }
    await ensureImage(job);

    // Build the job environment. The DB URL + vault secrets go in a 0600 env-file
    // (NOT -e flags) so they never appear in `docker inspect` or the host process
    // table. Precedence (low→high): vault secrets → job-declared non-secret env
    // (can't shadow a vault key) → reserved platform vars (always win). So a job
    // gets the backend's keys (OPENAI_API_KEY, RESEND_API_KEY, …) with zero
    // hardcoding (SP3), and can't accidentally clobber LINGCODE_DB_URL.
    const dbUrl = await getComputeDbUrl(db, run.backend_id);
    const env = {};
    try { Object.assign(env, vault.readAllBackendSecrets(db, run.backend_id)); } catch (_) {}
    if (job.env_json) { try { const je = JSON.parse(job.env_json); for (const [k, v] of Object.entries(je)) if (!(k in env)) env[k] = v; } catch (_) {} }
    env.LINGCODE_DB_URL = dbUrl;
    env.LINGCODE_BACKEND_ID = run.backend_id;
    env.LINGCODE_RUN_ID = run.id;
    if (run.input_json) env.LINGCODE_INPUT = run.input_json;
    // Declared egress allow-list (SP3). Informational for the job; the box enforces
    // it at the network layer (default-deny firewall / network policy).
    if (job.egress_hosts) env.LINGCODE_EGRESS_HOSTS = job.egress_hosts;
    envFile = path.join(os.tmpdir(), `lcrun-${run.id}-${crypto.randomBytes(4).toString('hex')}.env`);
    fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`).join('\n'), { mode: 0o600 });

    const cname = `lcrun-${run.id}`;
    const args = ['run', '--rm', '--name', cname,
      `--cpus=${job.cpu}`, `--memory=${job.memory_mb}m`,
      '--env-file', envFile];
    // Container hardening for arbitrary owner code (COMPUTE_SECURITY_REVIEW.md F-7).
    // Defaults on; a job needing extra caps (e.g. the SP3 Chromium image) sets
    // COMPUTE_HARDEN_FLAGS to a looser set. tmpfs gives a writable /tmp under a
    // read-only rootfs.
    if (HARDEN) {
      args.push(...HARDEN_FLAGS);
    }
    if (DOCKER_NETWORK) args.push('--network', DOCKER_NETWORK);
    args.push(job.image);
    if (job.entrypoint) { try { args.push(...JSON.parse(job.entrypoint).map(String)); } catch (_) {} }

    await new Promise((resolve) => {
      const p = spawn(DOCKER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let settled = false;
      const done = (status, code, error) => { if (settled) return; settled = true; clearTimers(); finish(status, code, error); resolve(); };

      // Periodic log flush so a long run is observable while in flight.
      const flush = setInterval(() => {
        try { db.prepare('UPDATE compute_runs SET logs=? WHERE id=?').run(tail.toString(), run.id); } catch (_) {}
      }, LOG_FLUSH_MS);
      // Wall-clock timeout → kill the container.
      const killTimer = setTimeout(async () => {
        tail.push(Buffer.from(`\n[runner] timeout after ${job.timeout_sec}s — killing container\n`));
        await runDocker(['kill', cname], 10000).catch(() => {});
        done('timed_out', null, `exceeded timeout_sec=${job.timeout_sec}`);
      }, job.timeout_sec * 1000);
      // Cancellation poll: the route sets error='cancel_requested' on a running row.
      const cancelTimer = setInterval(async () => {
        const cur = db.prepare('SELECT error FROM compute_runs WHERE id=?').get(run.id);
        if (cur && cur.error === 'cancel_requested') {
          tail.push(Buffer.from('\n[runner] cancel requested — killing container\n'));
          await runDocker(['kill', cname], 10000).catch(() => {});
          done('canceled', null, 'canceled by request');
        }
      }, 1500);
      const clearTimers = () => { clearInterval(flush); clearTimeout(killTimer); clearInterval(cancelTimer); };

      p.stdout.on('data', (d) => tail.push(Buffer.from(d)));
      p.stderr.on('data', (d) => tail.push(Buffer.from(d)));
      p.on('error', (err) => done('failed', -1, `spawn error: ${String(err.message || err)}`));
      p.on('close', (code) => done(code === 0 ? 'succeeded' : 'failed', code, code === 0 ? null : `container exited ${code}`));
    });
  } catch (err) {
    finish('failed', null, String((err && err.message) || err).slice(0, 500));
  } finally {
    if (envFile) { try { fs.unlinkSync(envFile); } catch (_) {} }
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────
function startComputeRunner(db) {
  if (!ENABLED) {
    try { console.log('[cloud-compute-runner] dormant (COMPUTE_RUNNER_ENABLED != 1)'); } catch (_) {}
    return null;
  }
  // Sweep env-files orphaned by a prior crash (they're 0600, but don't leave
  // credentials on disk — F-3). Each is deleted right after the container spawns
  // in normal operation; this catches the abnormal exit case.
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (/^lcrun-.*\.env$/.test(f)) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_) {} }
    }
  } catch (_) {}
  let active = 0;
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      while (active < MAX_CONCURRENT) {
        const run = claimNext(db);
        if (!run) break;
        active++;
        // Fire-and-forget; the slot frees when execRun settles.
        execRun(db, run).catch(() => {}).finally(() => { active--; });
      }
    } catch (e) {
      try { console.error('[cloud-compute-runner] tick error:', e && e.message); } catch (_) {}
    } finally {
      ticking = false;
    }
  };
  const handle = setInterval(tick, POLL_MS);
  if (handle.unref) handle.unref();
  try { console.log(`[cloud-compute-runner] active worker ${WORKER_ID} (max ${MAX_CONCURRENT}, poll ${POLL_MS}ms)`); } catch (_) {}
  return handle;
}

module.exports = { startComputeRunner, claimNext, makeLogTail, meterRunSeconds, WORKER_ID };
