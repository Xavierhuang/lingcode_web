'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrateUsersTable } = require('../migrate');
const { migrateAccountTokens, issueToken, resolveToken, revokeUserTokens } = require('../account-tokens');

const pepper = 'p'.repeat(48);

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,tier TEXT NOT NULL DEFAULT 'free',created_at TEXT NOT NULL,source TEXT DEFAULT '')");
  migrateUsersTable(db);
  db.prepare('INSERT INTO users (id,email,tier,created_at,email_verified) VALUES (?,?,?,?,1)')
    .run('u1', 'user@example.com', 'pro', new Date().toISOString());
  migrateAccountTokens(db, { pepper });
  return db;
}

test('per-device issuance preserves earlier clients without plaintext storage', () => {
  const db = fixtureDb();
  const first = issueToken(db, 'u1', { pepper, scope: 'account', now: 1_000 });
  const second = issueToken(db, 'u1', { pepper, scope: 'account', now: 2_000 });
  assert.ok(resolveToken(db, first.token, { pepper, now: 3_000 }));
  assert.ok(resolveToken(db, second.token, { pepper, now: 3_000 }));
  const stored = JSON.stringify(db.prepare('SELECT * FROM account_tokens').all());
  assert.equal(stored.includes(first.token), false);
  assert.equal(stored.includes(second.token), false);
});

test('explicit rotation revokes the account family and returns one replacement', () => {
  const db = fixtureDb();
  const first = issueToken(db, 'u1', { pepper, scope: 'account', now: 1_000 });
  let replacement;
  db.transaction(() => {
    revokeUserTokens(db, 'u1', { scope: 'account', now: 2_000 });
    replacement = issueToken(db, 'u1', { pepper, scope: 'account', now: 2_001 });
  })();
  assert.equal(resolveToken(db, first.token, { pepper, now: 3_000 }), null);
  assert.ok(resolveToken(db, replacement.token, { pepper, now: 3_000 }));
});

test('production routes contain no new plaintext account or scoped-token issuer', () => {
  const root = path.join(__dirname, '..');
  const files = ['index.js', 'cloud-account-mcp.js', 'remote-routes.js', 'collab-routes.js'];
  const source = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert.doesNotMatch(source, /UPDATE users SET api_access_token\s*=\s*\?/i);
  assert.doesNotMatch(source, /INSERT INTO scoped_tokens/i);
  assert.doesNotMatch(source, /SELECT api_access_token FROM users/i);
});
