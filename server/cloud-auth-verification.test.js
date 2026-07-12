'use strict';

// Control-plane tests for password-signup email verification (the SQLite parts the
// /auth/verify-email + /auth/signup handlers depend on). The Postgres bits
// (auth_users.email_verified, createTenantUser{verified}, setTenantUserEmailVerified)
// verify on a provisioned backend — these cover schema + token mechanics + setting.
//
//   node --test cloud-auth-verification.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { migrateCloudBackendTables } = require('./migrate');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  migrateCloudBackendTables(db);
  return db;
}
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

test('migration creates the verification table + the require_email_verification setting', () => {
  const db = freshDb();
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backend_email_verifications'").get());
  const cols = new Set(db.prepare('PRAGMA table_info(backend_auth_settings)').all().map((c) => c.name));
  assert.ok(cols.has('require_email_verification'));
});

test('require_email_verification defaults off and can be toggled (preserving mfa)', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  // default: no row → treated as off
  let row = db.prepare('SELECT require_email_verification FROM backend_auth_settings WHERE backend_id=?').get('be1');
  assert.equal(row, undefined);
  // turn it on while leaving mfa as-is (the PUT route's upsert shape)
  db.prepare(`INSERT INTO backend_auth_settings (backend_id, mfa_required, require_email_verification, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(backend_id) DO UPDATE SET require_email_verification=excluded.require_email_verification, updated_at=excluded.updated_at`)
    .run('be1', 0, 1, now);
  row = db.prepare('SELECT mfa_required, require_email_verification FROM backend_auth_settings WHERE backend_id=?').get('be1');
  assert.equal(row.require_email_verification, 1);
  assert.equal(row.mfa_required, 0);
});

test('verification token: insert → valid lookup → single-use → expiry (mirrors the handler queries)', () => {
  const db = freshDb();
  const now = new Date();
  const token = crypto.randomBytes(32).toString('base64url');
  const insert = (tok, expISO) => db.prepare(`INSERT INTO backend_email_verifications (id, backend_id, email, token_hash, expires_at, created_at)
    VALUES (?,?,?,?,?,?)`).run(crypto.randomUUID(), 'be1', 'u@x.com', sha(tok), expISO, now.toISOString());
  const lookup = (tok) => db.prepare('SELECT id, email, expires_at, used_at FROM backend_email_verifications WHERE backend_id=? AND token_hash=?').get('be1', sha(tok));

  // valid, unexpired, unused
  insert(token, new Date(now.getTime() + 24 * 3600 * 1000).toISOString());
  let row = lookup(token);
  assert.ok(row && !row.used_at && new Date(row.expires_at).getTime() > Date.now(), 'token is valid');

  // mark used → a second verify must be rejected
  db.prepare('UPDATE backend_email_verifications SET used_at=? WHERE id=?').run(now.toISOString(), row.id);
  row = lookup(token);
  assert.ok(row.used_at, 'token is now single-use-consumed');

  // an expired token is rejected by the same guard
  const stale = crypto.randomBytes(32).toString('base64url');
  insert(stale, new Date(now.getTime() - 1000).toISOString());
  const sr = lookup(stale);
  assert.ok(new Date(sr.expires_at).getTime() < Date.now(), 'token is expired');

  // an unknown token finds nothing
  assert.equal(lookup('never-issued'), undefined);
});
