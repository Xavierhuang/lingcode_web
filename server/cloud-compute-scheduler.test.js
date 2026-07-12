'use strict';

// Unit tests for the compute scheduler (cloud-compute-scheduler.js): due-detection
// + enqueue, the three overlap policies, and retry-with-backoff. Pure SQLite — no
// Docker/Postgres/HTTP.
//
//   node --test cloud-compute-scheduler.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

const { migrateComputeTables } = require('./migrate');
const { enqueueDue, retrySweep } = require('./cloud-compute-scheduler');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  migrateComputeTables(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO compute_jobs (id,backend_id,user_id,name,image,cpu,memory_mb,timeout_sec,enabled,created_at,updated_at)
    VALUES ('cjob-1','be1','u1','classify','lingcode/compute-node:20',1,512,900,1,?,?)`).run(now, now);
  return db;
}
function addSchedule(db, { id = 'csch-1', overlap = 'skip', maxRetries = 0, backoff = 60, nextRunAt }) {
  db.prepare(`INSERT INTO compute_schedules (id,job_id,backend_id,schedule,overlap_policy,max_retries,retry_backoff_sec,enabled,next_run_at,created_at)
    VALUES (?,?,?,?,?,?,?,1,?,?)`).run(id, 'cjob-1', 'be1', '*/5 * * * *', overlap, maxRetries, backoff, nextRunAt, new Date().toISOString());
}
const activeCount = (db) => db.prepare(`SELECT COUNT(*) AS n FROM compute_runs WHERE status IN ('queued','running')`).get().n;

test('enqueueDue enqueues a due schedule and advances next_run_at', () => {
  const db = freshDb();
  const now = Date.now();
  addSchedule(db, { nextRunAt: now - 1000 }); // due
  const r = enqueueDue(db, now);
  assert.equal(r.enqueued, 1);
  const run = db.prepare(`SELECT * FROM compute_runs WHERE schedule_id='csch-1'`).get();
  assert.equal(run.trigger, 'schedule');
  assert.equal(run.status, 'queued');
  const s = db.prepare('SELECT * FROM compute_schedules WHERE id=?').get('csch-1');
  assert.equal(s.last_status, 'enqueued');
  assert.ok(s.next_run_at > now, 'next_run_at advanced into the future');
});

test('a not-yet-due schedule does nothing', () => {
  const db = freshDb();
  const now = Date.now();
  addSchedule(db, { nextRunAt: now + 60_000 }); // future
  const r = enqueueDue(db, now);
  assert.equal(r.enqueued, 0);
  assert.equal(activeCount(db), 0);
});

test('overlap=skip skips when the job already has an active run', () => {
  const db = freshDb();
  const now = Date.now();
  addSchedule(db, { overlap: 'skip', nextRunAt: now - 1000 });
  // an in-flight run for the same job
  db.prepare(`INSERT INTO compute_runs (id,job_id,backend_id,status,trigger,queued_at) VALUES ('crun-live','cjob-1','be1','running','schedule',?)`).run(new Date().toISOString());
  const before = activeCount(db);
  const r = enqueueDue(db, now);
  assert.equal(r.skipped, 1);
  assert.equal(r.enqueued, 0);
  assert.equal(activeCount(db), before, 'no new run enqueued');
  assert.equal(db.prepare('SELECT last_status FROM compute_schedules WHERE id=?').get('csch-1').last_status, 'skipped');
});

test('overlap=allow enqueues even with an active run', () => {
  const db = freshDb();
  const now = Date.now();
  addSchedule(db, { overlap: 'allow', nextRunAt: now - 1000 });
  db.prepare(`INSERT INTO compute_runs (id,job_id,backend_id,status,trigger,queued_at) VALUES ('crun-live','cjob-1','be1','running','schedule',?)`).run(new Date().toISOString());
  const r = enqueueDue(db, now);
  assert.equal(r.enqueued, 1);
});

test('retrySweep re-enqueues a failed scheduled run once, with future backoff', () => {
  const db = freshDb();
  const now = Date.now();
  addSchedule(db, { maxRetries: 2, backoff: 30, nextRunAt: now + 60_000 });
  // a failed scheduled run, attempt 0 of max 2
  db.prepare(`INSERT INTO compute_runs (id,job_id,backend_id,status,trigger,schedule_id,attempt,max_attempts,retry_scheduled,queued_at)
    VALUES ('crun-f','cjob-1','be1','failed','schedule','csch-1',0,2,0,?)`).run(new Date(now - 5000).toISOString());

  const r1 = retrySweep(db, now);
  assert.equal(r1.retried, 1);
  const retry = db.prepare(`SELECT * FROM compute_runs WHERE trigger='retry'`).get();
  assert.equal(retry.attempt, 1);
  assert.equal(retry.status, 'queued');
  assert.ok(retry.not_before > new Date(now).toISOString(), 'backoff sets a future not_before');
  assert.equal(db.prepare('SELECT retry_scheduled FROM compute_runs WHERE id=?').get('crun-f').retry_scheduled, 1);

  // Idempotent: a second sweep does not re-enqueue.
  const r2 = retrySweep(db, now);
  assert.equal(r2.retried, 0);
});

test('enqueueDue blocks an over-tier backend (transfer/downgrade) and flags it', () => {
  const db = freshDb(); // seeds cjob-1 on be1
  // Minimal owner-tier lookup tables (ownerTier joins these).
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, tier TEXT)');
  db.exec('CREATE TABLE prototype_backends (id TEXT PRIMARY KEY, user_id TEXT)');
  db.prepare("INSERT INTO users VALUES ('u1','pro')").run();
  db.prepare("INSERT INTO prototype_backends VALUES ('be1','u1')").run();
  // Push be1's job count over the pro cap (10) so the project is over-tier.
  const now = new Date().toISOString();
  for (let i = 0; i < 12; i++) {
    db.prepare(`INSERT INTO compute_jobs (id,backend_id,user_id,name,image,cpu,memory_mb,timeout_sec,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,1,512,900,1,?,?)`).run(`extra-${i}`, 'be1', 'u1', `extra-${i}`, 'lingcode/compute-node:20', now, now);
  }
  addSchedule(db, { nextRunAt: Date.now() - 1000 }); // due

  const r = enqueueDue(db, Date.now());
  assert.equal(r.blocked, 1);
  assert.equal(r.enqueued, 0);
  assert.equal(db.prepare('SELECT last_status FROM compute_schedules WHERE id=?').get('csch-1').last_status, 'blocked_tier');

  // Upgrade the owner to max_pro → the same due schedule now runs.
  db.prepare("UPDATE users SET tier='max_pro' WHERE id='u1'").run();
  db.prepare('UPDATE compute_schedules SET next_run_at=? WHERE id=?').run(Date.now() - 1000, 'csch-1');
  const r2 = enqueueDue(db, Date.now());
  assert.equal(r2.enqueued, 1);
  assert.equal(r2.blocked, 0);
});

test('enqueueDue does not enforce when owner tier is unresolvable (partial DB)', () => {
  const db = freshDb(); // no users/prototype_backends tables at all
  addSchedule(db, { nextRunAt: Date.now() - 1000 });
  const r = enqueueDue(db, Date.now());
  assert.equal(r.enqueued, 1); // degrades to allow, never blocks on missing data
  assert.equal(r.blocked, 0);
});

test('retrySweep stops once attempts are exhausted', () => {
  const db = freshDb();
  const now = Date.now();
  addSchedule(db, { maxRetries: 2, backoff: 30, nextRunAt: now + 60_000 });
  db.prepare(`INSERT INTO compute_runs (id,job_id,backend_id,status,trigger,schedule_id,attempt,max_attempts,retry_scheduled,queued_at)
    VALUES ('crun-x','cjob-1','be1','failed','retry','csch-1',2,2,0,?)`).run(new Date(now - 5000).toISOString());
  const r = retrySweep(db, now);
  assert.equal(r.retried, 0, 'attempt == max_attempts → no retry');
});
