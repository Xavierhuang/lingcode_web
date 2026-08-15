// Regression: backend child tables referenced `prototype_backends` only, so any
// backend created from the IDE (which lives in `account_backends`) hit
// "FOREIGN KEY constraint failed" on every write. Live symptom: password signup
// worked while OTP, magic-link and managed email all 500'd, with no error log
// written because `backend_logs` was broken the same way.
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { migrateBackendParentFKs, stripBackendParentFK } = require('../migrate');

// The pre-fix schema, verbatim in shape: two possible parents, child FK to one.
function legacyDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE prototype_backends (id TEXT PRIMARY KEY, tier TEXT);
    CREATE TABLE account_backends   (id TEXT PRIMARY KEY, tier TEXT);
    CREATE TABLE backend_usage (
      backend_id  TEXT NOT NULL,
      day         TEXT NOT NULL,
      emails_sent INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (backend_id, day),
      FOREIGN KEY(backend_id) REFERENCES prototype_backends(id)
    );
    CREATE INDEX idx_usage_day ON backend_usage(day);
    CREATE TABLE backend_logs (
      id         TEXT PRIMARY KEY,
      backend_id TEXT NOT NULL,
      message    TEXT,
      FOREIGN KEY(backend_id) REFERENCES prototype_backends(id)
    );
  `);
  db.prepare('INSERT INTO prototype_backends (id, tier) VALUES (?, ?)').run('proto_be', 'free');
  db.prepare('INSERT INTO account_backends (id, tier) VALUES (?, ?)').run('acct_be', 'pro');
  return db;
}

const bumpEmail = (db, id) => db.prepare(
  `INSERT INTO backend_usage (backend_id, day, emails_sent) VALUES (?, ?, 1)
   ON CONFLICT(backend_id, day) DO UPDATE SET emails_sent = emails_sent + 1`
).run(id, '2026-07-26');

test('reproduces the pre-fix failure for an account backend', () => {
  const db = legacyDb();
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'FKs enforced by default');
  bumpEmail(db, 'proto_be');   // prototype backend is fine
  assert.throws(() => bumpEmail(db, 'acct_be'), /FOREIGN KEY constraint failed/);
  db.close();
});

test('migration lets account backends write, and preserves existing rows', () => {
  const db = legacyDb();
  bumpEmail(db, 'proto_be');
  bumpEmail(db, 'proto_be');   // emails_sent = 2, must survive the rebuild

  migrateBackendParentFKs(db);

  assert.doesNotThrow(() => bumpEmail(db, 'acct_be'), 'account backend can now be metered');
  assert.equal(
    db.prepare('SELECT emails_sent FROM backend_usage WHERE backend_id = ?').get('proto_be').emails_sent,
    2, 'pre-existing usage rows survived the table rebuild'
  );
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'FK enforcement restored afterwards');
  db.close();
});

test('rebuild keeps primary key, defaults and indexes', () => {
  const db = legacyDb();
  migrateBackendParentFKs(db);

  // PK still composite → the ON CONFLICT upsert above still resolves.
  const pk = db.prepare('PRAGMA table_info(backend_usage)').all().filter((c) => c.pk > 0).map((c) => c.name);
  assert.deepEqual(pk.sort(), ['backend_id', 'day']);
  // Index survived.
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='backend_usage'").all();
  assert.ok(idx.some((r) => r.name === 'idx_usage_day'), 'index recreated after rebuild');
  // And the offending constraint is actually gone from both tables.
  for (const t of ['backend_usage', 'backend_logs']) {
    const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => f.table === 'prototype_backends'), `${t} no longer FKs prototype_backends`);
  }
  db.close();
});

test('is idempotent and leaves an already-migrated db untouched', () => {
  const db = legacyDb();
  migrateBackendParentFKs(db);
  bumpEmail(db, 'acct_be');
  migrateBackendParentFKs(db);   // second run must be a no-op, not a data wipe
  assert.equal(
    db.prepare('SELECT emails_sent FROM backend_usage WHERE backend_id = ?').get('acct_be').emails_sent, 1
  );
  db.close();
});

test('stripBackendParentFK handles the clause last or mid-list, and leaves other FKs', () => {
  const last = `CREATE TABLE t (a TEXT, backend_id TEXT,\n  FOREIGN KEY(backend_id) REFERENCES prototype_backends(id)\n)`;
  assert.ok(!/prototype_backends/.test(stripBackendParentFK(last)));

  const mid = `CREATE TABLE t (a TEXT, backend_id TEXT, user_id TEXT,\n  FOREIGN KEY(backend_id) REFERENCES prototype_backends(id),\n  FOREIGN KEY(user_id) REFERENCES users(id)\n)`;
  const out = stripBackendParentFK(mid);
  assert.ok(!/prototype_backends/.test(out), 'target FK removed');
  assert.ok(/REFERENCES users\(id\)/.test(out), 'unrelated FK preserved');
});
