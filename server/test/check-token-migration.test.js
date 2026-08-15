'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migrateUsersTable } = require('../migrate');
const { migrateAccountTokens } = require('../account-tokens');
const { checkTokenMigration } = require('../scripts/check-token-migration');

const pepper = 'p'.repeat(48);

function fixture() {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,tier TEXT NOT NULL DEFAULT 'free',created_at TEXT NOT NULL,source TEXT DEFAULT '')");
  migrateUsersTable(db);
  db.exec(`CREATE TABLE scoped_tokens (
    token TEXT PRIMARY KEY,user_id TEXT NOT NULL,project_key TEXT NOT NULL,caps TEXT NOT NULL,
    created_at INTEGER NOT NULL,expires_at INTEGER,revoked_at INTEGER)`);
  db.prepare('INSERT INTO users (id,email,tier,created_at,email_verified,api_access_token) VALUES (?,?,?,?,1,?)')
    .run('u1', 'a@example.com', 'pro', new Date().toISOString(), 'legacy-account');
  db.prepare('INSERT INTO scoped_tokens VALUES (?,?,?,?,?,?,NULL)')
    .run('legacy-scoped', 'u1', 'p1', 'cloud+inference', 1_000, 99_000);
  return db;
}

test('migration report returns aggregate coverage counts only', () => {
  const db = fixture();
  migrateAccountTokens(db, { pepper, now: 2_000 });
  const report = checkTokenMigration(db, { pepper });
  assert.deepEqual(report, {
    legacyAccountRows: 1,
    legacyScopedRows: 1,
    digestRows: 2,
    missingDigestRows: 0,
    newPlaintextIssuerRows: 0,
  });
  assert.doesNotMatch(JSON.stringify(report), /legacy-account|legacy-scoped|[a-f0-9]{64}/);
});

test('migration report detects missing digest coverage and new-format plaintext', () => {
  const db = fixture();
  db.prepare('UPDATE users SET api_access_token=? WHERE id=?').run(`lcat_${'a'.repeat(64)}`, 'u1');
  const report = checkTokenMigration(db, { pepper });
  assert.equal(report.missingDigestRows, 2);
  assert.equal(report.newPlaintextIssuerRows, 1);
});
