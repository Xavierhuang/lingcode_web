'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  migrateAccountTokens,
  issueToken,
  resolveToken,
  revokeToken,
  revokeUserTokens,
} = require('../account-tokens');

const pepper = 'p'.repeat(48);

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'free',
      email_verified INTEGER DEFAULT 1,
      api_access_token TEXT
    );
    CREATE TABLE scoped_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_key TEXT NOT NULL,
      caps TEXT NOT NULL DEFAULT 'cloud+inference',
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER
    );
  `);
  db.prepare('INSERT INTO users (id,email,tier,email_verified) VALUES (?,?,?,1)')
    .run('user-1', 'a@example.com', 'pro');
  return db;
}

function seedLegacyTokens(db) {
  db.prepare('UPDATE users SET api_access_token=? WHERE id=?').run('legacy-account-token', 'user-1');
  db.prepare(`INSERT INTO scoped_tokens
    (token,user_id,project_key,caps,created_at,expires_at,revoked_at)
    VALUES (?,?,?,?,?,?,NULL)`)
    .run('legacy-project-token', 'user-1', 'project-1', 'cloud+inference', 100, 20_000);
}

test('backfill preserves existing raw account and scoped credentials', () => {
  const db = fixtureDb();
  seedLegacyTokens(db);
  const report = migrateAccountTokens(db, { pepper, now: 1_000 });
  assert.deepEqual(report, { legacyAccountBackfilled: 1, legacyScopedBackfilled: 1 });
  assert.equal(resolveToken(db, 'legacy-account-token', { pepper, now: 2_000 }).user.id, 'user-1');
  assert.deepEqual(resolveToken(db, 'legacy-project-token', { pepper, now: 2_000 }).tokenScope, {
    projectKey: 'project-1', caps: 'cloud+inference'
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM account_tokens WHERE digest_version='h1'").get().n, 2);
  assert.equal(db.prepare('SELECT api_access_token FROM users WHERE id=?').get('user-1').api_access_token, 'legacy-account-token');
});

test('new token stores only a digest and resolves in constant shape', () => {
  const db = fixtureDb();
  migrateAccountTokens(db, { pepper });
  const issued = issueToken(db, 'user-1', { pepper, scope: 'account', now: 1_000 });
  const serialized = JSON.stringify(db.prepare('SELECT * FROM account_tokens WHERE id=?').get(issued.id));
  assert.equal(serialized.includes(issued.token), false);
  assert.match(issued.token, /^lcat_[0-9a-f]{64}$/);
  assert.equal(resolveToken(db, issued.token, { pepper, now: 2_000 }).user.id, 'user-1');
  assert.equal(resolveToken(db, issued.token, { pepper: 'wrong-pepper', now: 2_000 }), null);
  assert.equal(resolveToken(db, 'not-a-token', { pepper, now: 2_000 }), null);
});

test('expired and revoked tokens do not authenticate', () => {
  const db = fixtureDb();
  migrateAccountTokens(db, { pepper });
  const issued = issueToken(db, 'user-1', { pepper, expiresAt: 2_000, now: 1_000 });
  assert.equal(resolveToken(db, issued.token, { pepper, now: 2_001 }), null);
  const active = issueToken(db, 'user-1', { pepper, now: 3_000 });
  assert.equal(revokeToken(db, active.id, 'user-1', { now: 4_000 }), true);
  assert.equal(resolveToken(db, active.token, { pepper, now: 4_001 }), null);
});

test('migration is idempotent and last use is write-throttled', () => {
  const db = fixtureDb();
  seedLegacyTokens(db);
  migrateAccountTokens(db, { pepper, now: 1_000 });
  assert.deepEqual(migrateAccountTokens(db, { pepper, now: 2_000 }), {
    legacyAccountBackfilled: 0, legacyScopedBackfilled: 0
  });
  resolveToken(db, 'legacy-account-token', { pepper, now: 10_000 });
  const first = db.prepare("SELECT last_used_at FROM account_tokens WHERE scope='account'").get().last_used_at;
  resolveToken(db, 'legacy-account-token', { pepper, now: 10_001 });
  assert.equal(db.prepare("SELECT last_used_at FROM account_tokens WHERE scope='account'").get().last_used_at, first);
  resolveToken(db, 'legacy-account-token', { pepper, now: 311_000 });
  assert.equal(db.prepare("SELECT last_used_at FROM account_tokens WHERE scope='account'").get().last_used_at, 311_000);
});

test('account token cap and family revocation keep legacy credentials compatible', () => {
  const db = fixtureDb();
  seedLegacyTokens(db);
  migrateAccountTokens(db, { pepper, now: 1_000 });
  const issued = [];
  for (let i = 0; i < 12; i += 1) issued.push(issueToken(db, 'user-1', { pepper, now: 2_000 + i }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM account_tokens WHERE scope='account' AND revoked_at IS NULL AND legacy_source IS NULL").get().n, 10);
  assert.ok(resolveToken(db, 'legacy-account-token', { pepper, now: 3_000 }));
  assert.equal(revokeUserTokens(db, 'user-1', { scope: 'account', now: 4_000 }), 11);
  assert.equal(resolveToken(db, issued.at(-1).token, { pepper, now: 4_001 }), null);
});
