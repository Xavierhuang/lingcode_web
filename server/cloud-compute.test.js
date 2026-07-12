'use strict';

// Unit tests for the COMPUTE TIER control-plane logic (cloud-compute.js +
// cloud-compute-runner.js) that needs neither Docker nor Postgres: the job-queue
// migration, the atomic FIFO claim, the bounded log tail, and job sanitization.
// The Docker/Postgres end-to-end path is covered by compute-images/gates.sh on the
// VPC box.
//
//   node --test cloud-compute.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

const fs = require('node:fs');
const path = require('node:path');
const { migrateComputeTables, migrateCloudBackendTables } = require('./migrate');
const { claimNext, makeLogTail, meterRunSeconds } = require('./cloud-compute-runner');
const { sanitizeJob, applyManifest, computeTierShortfall } = require('./cloud-compute');
const { limitsForTier } = require('./cloud-limits');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF'); // parents (users, prototype_backends) live in the real DB
  migrateComputeTables(db);
  return db;
}

function seedJob(db, id = 'cjob-1', backend = 'be1') {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO compute_jobs (id,backend_id,user_id,name,image,cpu,memory_mb,timeout_sec,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,1,512,900,1,?,?)`).run(id, backend, 'u1', id, 'lingcode/compute-node:20', now, now);
}
function enqueue(db, id, job = 'cjob-1', backend = 'be1', queuedAt) {
  db.prepare(`INSERT INTO compute_runs (id,job_id,backend_id,status,trigger,queued_at) VALUES (?,?,?,'queued','manual',?)`)
    .run(id, job, backend, queuedAt);
}

test('migration creates the compute tables', () => {
  const db = freshDb();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'compute_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(names, ['compute_db_creds', 'compute_jobs', 'compute_runs', 'compute_schedules']);
});

test('claimNext is FIFO, flips status to running, and exhausts to null', () => {
  const db = freshDb();
  seedJob(db);
  enqueue(db, 'crun-a', 'cjob-1', 'be1', '2020-01-01T00:00:00Z');
  enqueue(db, 'crun-b', 'cjob-1', 'be1', '2020-01-01T00:00:01Z');

  const c1 = claimNext(db);
  assert.equal(c1.id, 'crun-a');
  assert.equal(db.prepare('SELECT status FROM compute_runs WHERE id=?').get('crun-a').status, 'running');
  assert.ok(db.prepare('SELECT worker_id, started_at FROM compute_runs WHERE id=?').get('crun-a').worker_id);

  const c2 = claimNext(db);
  assert.equal(c2.id, 'crun-b');
  assert.equal(claimNext(db), null); // queue drained
});

test('claimNext never double-claims a row', () => {
  const db = freshDb();
  seedJob(db);
  enqueue(db, 'crun-x', 'cjob-1', 'be1', '2020-01-01T00:00:00Z');
  const first = claimNext(db);
  const second = claimNext(db);
  assert.equal(first.id, 'crun-x');
  assert.equal(second, null);
});

test('makeLogTail keeps only the tail under the byte cap', () => {
  process.env.COMPUTE_LOG_TAIL_BYTES; // default 64KB
  const tail = makeLogTail();
  for (let i = 0; i < 4000; i++) tail.push(Buffer.from('y'.repeat(100) + '\n'));
  const out = tail.toString();
  assert.ok(Buffer.byteLength(out) <= 80 * 1024, 'tail capped near 64KB');
  assert.ok(out.endsWith('\n'), 'retains the most-recent lines');
});

test('sanitizeJob clamps resources to tier ceilings', () => {
  const lim = { maxComputeMemoryMb: 1024, maxComputeTimeoutSec: 1800 };
  const j = sanitizeJob({ name: 'classify-job', image: 'lingcode/compute-node:20', cpu: 99, memory_mb: 99999, timeout_sec: 99999 }, lim, 'abc123ff');
  assert.equal(j.cpu, 4);
  assert.equal(j.memory_mb, 1024);
  assert.equal(j.timeout_sec, 1800);
});

test('sanitizeJob filters env to valid keys only', () => {
  const lim = { maxComputeMemoryMb: 1024, maxComputeTimeoutSec: 1800 };
  const j = sanitizeJob({ name: 'x', image: 'lingcode/compute-node:20', env: { GOOD_KEY: 'a', '1bad': 'b', 'has-dash': 'c' } }, lim, 'abc123ff');
  assert.deepEqual(JSON.parse(j.env_json), { GOOD_KEY: 'a' });
});

test('sanitizeJob rejects bad names and disallowed images', () => {
  const lim = { maxComputeMemoryMb: 1024, maxComputeTimeoutSec: 1800 };
  assert.throws(() => sanitizeJob({ name: 'Bad_Name', image: 'lingcode/compute-node:20' }, lim, 'abc123ff'), /name must be/);
  assert.throws(() => sanitizeJob({ name: 'ok', image: 'evil/image:latest' }, lim, 'abc123ff'), /image must be/);
  // a backend's own uploaded tag IS allowed
  const j = sanitizeJob({ name: 'ok', image: 'lingcode-compute/abc123ff:ok' }, lim, 'abc123ff');
  assert.equal(j.image, 'lingcode-compute/abc123ff:ok');
  // the managed browser base IS allowed (SP3)
  assert.equal(sanitizeJob({ name: 'ok', image: 'lingcode/compute-browser:20' }, lim, 'abc123ff').image, 'lingcode/compute-browser:20');
});

test('sanitizeJob normalizes + validates the egress allow-list', () => {
  const lim = { maxComputeMemoryMb: 1024, maxComputeTimeoutSec: 1800 };
  const j = sanitizeJob({ name: 'x', image: 'lingcode/compute-node:20', egress_hosts: ['api.openai.com', 'API.Resend.com'] }, lim, 'abc123ff');
  assert.deepEqual(JSON.parse(j.egress_hosts), ['api.openai.com', 'api.resend.com']);
  assert.throws(() => sanitizeJob({ name: 'x', image: 'lingcode/compute-node:20', egress_hosts: ['bad host!'] }, lim, 'abc123ff'), /invalid egress host/);
  assert.throws(() => sanitizeJob({ name: 'x', image: 'lingcode/compute-node:20', egress_hosts: 'notarray' }, lim, 'abc123ff'), /must be an array/);
});

test('applyManifest upserts jobs + replaces schedules atomically', () => {
  const db = freshDb();
  const backend = { id: 'be1', user_id: 'u1' };
  const limits = { maxComputeMemoryMb: 1024, maxComputeTimeoutSec: 1800, maxComputeJobs: 50 };
  const manifest = {
    jobs: [
      { name: 'classify', image: 'lingcode/compute-node:20', timeout_sec: 300, env: { MODE: 'prod' } },
      { name: 'tm-feed', image: 'lingcode/compute-node:20', egress_hosts: ['app.ticketmaster.com'] },
    ],
    schedules: [
      { job: 'classify', schedule: '*/10 * * * *', overlap_policy: 'skip', max_retries: 2 },
      { job: 'tm-feed', schedule: '0 5 * * *', overlap_policy: 'queue' },
    ],
  };
  const r = applyManifest(db, backend, limits, manifest);
  assert.deepEqual(r, { jobs: 2, schedules: 2 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM compute_jobs WHERE backend_id=?').get('be1').n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM compute_schedules WHERE backend_id=?').get('be1').n, 2);

  // Re-apply with one job dropped + a schedule removed → declarative replace.
  const r2 = applyManifest(db, backend, limits, { jobs: [{ name: 'classify', image: 'lingcode/compute-node:20' }], schedules: [] });
  assert.deepEqual(r2, { jobs: 1, schedules: 0 });
  // classify's schedule is gone (replaced with none); tm-feed's job + schedule remain untouched.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM compute_schedules s JOIN compute_jobs j ON j.id=s.job_id WHERE j.name='classify'`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM compute_schedules s JOIN compute_jobs j ON j.id=s.job_id WHERE j.name='tm-feed'`).get().n, 1);
});

test('the real generated cliffslist manifest applies on max_pro, not on pro', () => {
  const backend = { id: 'be1', user_id: 'u1' };
  // The artifact ships with a REPLACE_BACKEND_ID placeholder in image tags (the
  // real apply flow substitutes the live id first) — do the same here.
  const raw = fs.readFileSync(path.join(__dirname, 'compute-images', 'examples', 'cliffslist.compute.json'), 'utf8').replace(/REPLACE_BACKEND_ID/g, backend.id);
  const manifest = JSON.parse(raw);
  // max_pro covers it (50 jobs / 200 schedules ≥ 36 / 86).
  const r = applyManifest(freshDb(), backend, limitsForTier('max_pro'), manifest);
  assert.equal(r.jobs, 36);
  assert.equal(r.schedules, 86);
  // pro's 10-job cap can't hold it → atomic quota failure.
  assert.throws(() => applyManifest(freshDb(), backend, limitsForTier('pro'), manifest), /job cap/);
});

test('applyManifest rejects a schedule naming an undeclared job', () => {
  const db = freshDb();
  const backend = { id: 'be1', user_id: 'u1' };
  const limits = { maxComputeMemoryMb: 1024, maxComputeTimeoutSec: 1800, maxComputeJobs: 50 };
  assert.throws(() => applyManifest(db, backend, limits, {
    jobs: [{ name: 'a', image: 'lingcode/compute-node:20' }],
    schedules: [{ job: 'ghost', schedule: '* * * * *' }],
  }), /unknown job/);
  // atomic: nothing was written
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM compute_jobs').get().n, 0);
});

test('computeTierShortfall reminds a transferred lower-tier owner to upgrade', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  // Seed 12 jobs (pro cap = 10), one of which needs 2048MB (pro cap = 1024).
  for (let i = 0; i < 12; i++) {
    db.prepare(`INSERT INTO compute_jobs (id,backend_id,user_id,name,image,cpu,memory_mb,timeout_sec,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,1,?,900,1,?,?)`).run(`cjob-${i}`, 'be1', 'u1', `job-${i}`, 'lingcode/compute-node:20', i === 0 ? 2048 : 512, now, now);
  }
  // Lower-tier (pro) owner → upgrade reminder pointing at max_pro.
  const sf = computeTierShortfall(db, 'be1', 'pro');
  assert.ok(sf && sf.needsUpgrade);
  assert.equal(sf.recommendedTier, 'max_pro');
  assert.match(sf.message, /upgrade/i);
  assert.ok(sf.reasons.some((r) => /jobs exceed/.test(r)) && sf.reasons.some((r) => /2048MB/.test(r)));
  // A free owner (compute tier off entirely) is also reminded.
  assert.ok(computeTierShortfall(db, 'be1', 'free').needsUpgrade);
  // An adequately-provisioned (max_pro) owner gets no reminder.
  assert.equal(computeTierShortfall(db, 'be1', 'max_pro'), null);
  // A project with NO compute config never nags.
  assert.equal(computeTierShortfall(freshDb(), 'be1', 'free'), null);
});

test('meterRunSeconds accumulates run-seconds per backend per UTC day', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  migrateCloudBackendTables(db); // creates backend_usage
  migrateComputeTables(db);      // adds compute_run_seconds
  meterRunSeconds(db, 'be1', 12.5);
  meterRunSeconds(db, 'be1', 7.5);
  meterRunSeconds(db, 'be1', 0); // no-op
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare('SELECT compute_run_seconds FROM backend_usage WHERE backend_id=? AND day=?').get('be1', day);
  assert.equal(row.compute_run_seconds, 20);
});
