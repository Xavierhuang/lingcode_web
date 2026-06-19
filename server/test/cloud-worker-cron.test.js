'use strict';

// Tests for the COMPUTE-tier additions: cron evaluation, the daily-quota enforcer
// (auto-suspend/resume), the log ring buffer, and the secret/var kind split.
// In-memory DB, real encrypt/decrypt, no live Cloudflare.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.LINGCODE_VAULT_MASTER_KEY = crypto.randomBytes(32).toString('hex');

const Database = require('better-sqlite3');
const { parseCron, nextRunAfter } = require('../cloud-worker-cron');
const { migrateCloudAppsTables } = require('../migrate');

const BASE = Date.UTC(2026, 5, 11, 10, 32, 0); // 2026-06-11T10:32:00Z (Thursday)
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

test('cron: common schedules compute the right next run', () => {
  assert.equal(iso(nextRunAfter('* * * * *', BASE)), '2026-06-11T10:33:00.000Z');
  assert.equal(iso(nextRunAfter('*/15 * * * *', BASE)), '2026-06-11T10:45:00.000Z');
  assert.equal(iso(nextRunAfter('0 * * * *', BASE)), '2026-06-11T11:00:00.000Z');
  assert.equal(iso(nextRunAfter('0 0 * * *', BASE)), '2026-06-12T00:00:00.000Z');
  assert.equal(iso(nextRunAfter('0 12 * * 1-5', BASE)), '2026-06-11T12:00:00.000Z');
  assert.equal(iso(nextRunAfter('0 9 * * 0', BASE)), '2026-06-14T09:00:00.000Z'); // Sunday
  assert.equal(iso(nextRunAfter('0 9 * * 7', BASE)), '2026-06-14T09:00:00.000Z'); // 7 == Sunday
});

test('cron: dom+dow both restricted uses OR semantics', () => {
  // 1st of month OR any Monday → next Monday (Jun 15) precedes Jul 1.
  assert.equal(iso(nextRunAfter('0 0 1 * 1', BASE)), '2026-06-15T00:00:00.000Z');
});

test('cron: malformed and out-of-range expressions throw', () => {
  assert.throws(() => parseCron('bad'));
  assert.throws(() => parseCron('60 * * * *'));
  assert.throws(() => parseCron('0 9 * * 8'));
  assert.throws(() => parseCron('* * * *'));     // only 4 fields
});

function seedWorker(db, id, tier) {
  db.prepare('INSERT INTO users (id, tier) VALUES (?, ?)').run('u-' + id, tier);
  db.prepare('INSERT INTO cloud_workers (id, user_id, title, hostname, version, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, 'u-' + id, id, id + '.run.lingcode.dev', 1, 'active', 1, 1);
}

test('quota enforcer: auto-suspends over-limit and auto-resumes when back under', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, tier TEXT)');
  migrateCloudAppsTables(db);
  const usage = require('../cloud-worker-usage');
  seedWorker(db, 'app-q', 'free'); // free maxWorkerRequestsPerDay = 100000
  const today = usage.utcDay(Date.now());

  db.prepare('INSERT INTO worker_usage (worker_id, day, requests) VALUES (?,?,?)').run('app-q', today, 250000);
  usage.enforceQuotas(db);
  let st = db.prepare('SELECT status, status_reason FROM cloud_workers WHERE id = ?').get('app-q');
  assert.deepEqual(st, { status: 'suspended', status_reason: 'quota' });

  db.prepare('UPDATE worker_usage SET requests = 0 WHERE worker_id = ? AND day = ?').run('app-q', today);
  usage.enforceQuotas(db);
  st = db.prepare('SELECT status, status_reason FROM cloud_workers WHERE id = ?').get('app-q');
  assert.equal(st.status, 'active');
});

test('quota enforcer: never auto-resumes a manual suspension', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, tier TEXT)');
  migrateCloudAppsTables(db);
  const usage = require('../cloud-worker-usage');
  const { setWorkerStatus } = require('../cloud-workers');
  seedWorker(db, 'app-m', 'free');
  setWorkerStatus(db, 'app-m', 'suspended', 'manual');
  usage.enforceQuotas(db); // usage is 0, but reason is 'manual'
  const st = db.prepare('SELECT status, status_reason FROM cloud_workers WHERE id = ?').get('app-m');
  assert.deepEqual(st, { status: 'suspended', status_reason: 'manual' });
});

test('log ring buffer keeps only the newest 500 lines', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, tier TEXT)');
  migrateCloudAppsTables(db);
  const { appendLog } = require('../cloud-worker-logs');
  seedWorker(db, 'app-l', 'free');
  for (let i = 0; i < 600; i++) appendLog(db, 'app-l', 'info', 'line ' + i);
  const n = db.prepare('SELECT COUNT(*) AS n FROM worker_logs WHERE worker_id = ?').get('app-l').n;
  assert.equal(n, 500);
  const newest = db.prepare('SELECT message FROM worker_logs WHERE worker_id = ? ORDER BY id DESC LIMIT 1').get('app-l').message;
  assert.equal(newest, 'line 599');
});

test('vault kind: vars read back, true secrets do not, both mirror to env', () => {
  const db = new Database(':memory:');
  const { migrateCloudBackendTables } = require('../migrate');
  migrateCloudBackendTables(db);
  const v = require('../secrets-vault');
  v.setBackendSecret(db, 'be1', 'STRIPE_SECRET_KEY', 'sk_live_x');         // default secret
  v.setBackendSecret(db, 'be1', 'NODE_ENV', 'production', 'var');          // var
  assert.equal(v.readBackendVar(db, 'be1', 'NODE_ENV'), 'production');
  assert.equal(v.readBackendVar(db, 'be1', 'STRIPE_SECRET_KEY'), null);    // secret stays write-only
  const all = v.readAllBackendSecrets(db, 'be1');
  assert.equal(all.NODE_ENV, 'production');
  assert.equal(all.STRIPE_SECRET_KEY, 'sk_live_x');                        // both ship to c.env
});
