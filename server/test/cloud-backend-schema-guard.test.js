// Schema guard: no backend child table may declare its parent FK against
// `prototype_backends`.
//
// WHY THIS EXISTS. A backend can live in EITHER `prototype_backends` (created
// from a /try prototype) or `account_backends` (created from the IDE for a
// project) — `getAnyBackendById` resolves across both. Writing
// `FOREIGN KEY(backend_id) REFERENCES prototype_backends(id)` is the natural
// thing to type, and it is silently wrong: better-sqlite3 enforces FKs, so every
// write for an ACCOUNT backend dies on "FOREIGN KEY constraint failed".
//
// That shipped, and it broke OTP, magic-link and send-email (all of which bump
// `backend_usage` first) plus the entire compute tier for 31 backends across 15
// users for ~8 weeks. Password signup kept working, which is why it went
// unnoticed — it never sends email, so it never touched a broken table. Nothing
// logged the failure either, because `backend_logs` had the same constraint.
//
// SQLite cannot express "FK to either of two tables" and cannot reference a
// view, so parent integrity is enforced at the application layer instead.
//
// WHAT THIS ACTUALLY CATCHES (verified by reintroducing the bug both ways):
//   - A NEW table declared with the bad FK -> FAILS here, naming the table.
//     This is the real risk, and the case the migration cannot self-heal.
//   - The FK re-added to a table already in migrate.js's BACKEND_CHILD_TABLES
//     -> does NOT fail, because migrateBackendParentFKs strips it during boot.
//     That is intended: those tables self-repair, so the mistake is harmless.
// If you add a backend child table, either omit the FK or add it to
// BACKEND_CHILD_TABLES — otherwise this test tells you, loudly.
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const m = require('../migrate');

// Only the migrations that create backend child tables, in index.js's order.
// The rest of the boot sequence is irrelevant here, and `migrate*Table` helpers
// like migrateUsersTable are ALTER-style — they assume index.js already created
// the base table — so running the full list would just fail on `no such table`.
// `users` is stubbed because the cloud tables reference it.
function freshlyMigratedDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT)');
  m.migrateCloudBackendTables(db);
  m.migrateComputeTables(db);
  m.migrateBackendParentFKs(db);
  return db;
}

test('no table FKs prototype_backends on backend_id', () => {
  const db = freshlyMigratedDb();
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all().map((r) => r.name);

  const offenders = [];
  for (const t of tables) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${t}")`).all()) {
      if (fk.table === 'prototype_backends' && fk.from === 'backend_id') offenders.push(t);
    }
  }

  assert.deepEqual(offenders, [],
    `These tables FK prototype_backends on backend_id, so every write for an ` +
    `account backend will fail:\n  ${offenders.join('\n  ')}\n\n` +
    `Drop the FOREIGN KEY clause — a backend may live in account_backends ` +
    `instead. If the table is genuinely prototype-only, rename the column so ` +
    `it does not read as a generic backend reference.`);
  db.close();
});

// The guard above is only meaningful if the fixture actually creates the tables
// it is supposed to police — an empty DB would pass vacuously.
test('guard is not vacuous — the backend child tables really exist', () => {
  const db = freshlyMigratedDb();
  const names = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).all().map((r) => r.name));

  for (const t of ['backend_usage', 'backend_logs', 'backend_magic_links',
                   'backend_email_verifications', 'backend_signing_secrets',
                   'compute_jobs', 'compute_runs', 'compute_schedules', 'compute_db_creds']) {
    assert.ok(names.has(t), `${t} missing from the migrated schema — fixture is stale`);
  }
  assert.ok(names.has('account_backends') && names.has('prototype_backends'),
    'both backend parent tables should exist');
  db.close();
});

test('an account backend can be metered end-to-end on a fresh schema', () => {
  const db = freshlyMigratedDb();
  const day = '2026-07-26';
  const now = new Date().toISOString();
  // account_backends FKs users(id) — a legitimate single-parent constraint.
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'u1@example.com');
  db.prepare(
    `INSERT INTO account_backends (id, user_id, project_key, schema_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('acct_be', 'u1', 'proj_test', 'be_acct_be', now, now);

  // The exact statement that was throwing in production (assertEmailQuotaAndBump).
  assert.doesNotThrow(() => {
    db.prepare(
      `INSERT INTO backend_usage (backend_id, day, emails_sent) VALUES (?, ?, 1)
       ON CONFLICT(backend_id, day) DO UPDATE SET emails_sent = emails_sent + 1`
    ).run('acct_be', day);
  }, 'account backend must be meterable — this is the OTP/magic-link/send-email path');

  assert.equal(
    db.prepare('SELECT emails_sent FROM backend_usage WHERE backend_id = ? AND day = ?')
      .get('acct_be', day).emails_sent, 1);
  db.close();
});
