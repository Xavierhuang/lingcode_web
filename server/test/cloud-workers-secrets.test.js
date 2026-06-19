'use strict';

// Tests for syncWorkerSecrets — mirroring a linked backend's vault into a
// hosted Worker's Cloudflare secret bindings (c.env.X). Uses an in-memory DB
// (real encrypt/decrypt) and a stubbed global.fetch (no live Cloudflare).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// Vault master key MUST be set before secrets-vault is required.
process.env.LINGCODE_VAULT_MASTER_KEY = crypto.randomBytes(32).toString('hex');

const Database = require('better-sqlite3');
const { setBackendSecret } = require('../secrets-vault');
const { syncWorkerSecrets } = require('../cloud-workers');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE cloud_workers   (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE account_backends(id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE backend_secrets (backend_id TEXT, key TEXT, encrypted_value TEXT,
                                  kind TEXT NOT NULL DEFAULT 'secret',
                                  created_at TEXT, updated_at TEXT, UNIQUE(backend_id, key));
  `);
  return db;
}

// Stub global.fetch for the Cloudflare WfP secrets API. `existing` is the list
// of secret names CF currently reports for the script.
function stubFetch(existing) {
  const calls = { get: 0, put: [], del: [] };
  const orig = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const m = (opts.method || 'GET').toUpperCase();
    if (u.endsWith('/secrets') && m === 'GET') {
      calls.get++;
      return { ok: true, json: async () => ({ result: existing.map((name) => ({ name, type: 'secret_text' })) }) };
    }
    if (u.endsWith('/secrets') && m === 'PUT') {
      calls.put.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ success: true }) };
    }
    if (m === 'DELETE') {
      calls.del.push(decodeURIComponent(u.split('/secrets/')[1] || ''));
      return { ok: true, json: async () => ({ success: true }) };
    }
    return { ok: false, json: async () => ({}) };
  };
  return { calls, restore: () => { global.fetch = orig; } };
}

test('mirrors the linked backend vault: pushes current keys (decrypted), deletes stale', async () => {
  const db = makeDb();
  db.prepare('INSERT INTO cloud_workers (id, project_id) VALUES (?,?)').run('app-aaa', 'P1');
  db.prepare('INSERT INTO account_backends (id, project_id) VALUES (?,?)').run('be-1', 'P1');
  setBackendSecret(db, 'be-1', 'STRIPE_SECRET_KEY', 'sk_test_123');
  setBackendSecret(db, 'be-1', 'ANTHROPIC_API_KEY', 'sk-ant-xyz');

  // CF already has STRIPE_SECRET_KEY (will be re-put) + OLD_KEY (stale → delete)
  const { calls, restore } = stubFetch(['STRIPE_SECRET_KEY', 'OLD_KEY']);
  try {
    const res = await syncWorkerSecrets(db, 'app-aaa');
    assert.deepEqual(res, { synced: 2, removed: 1 });

    const put = Object.fromEntries(calls.put.map((p) => [p.name, p]));
    assert.deepEqual(Object.keys(put).sort(), ['ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY']);
    assert.equal(put.STRIPE_SECRET_KEY.text, 'sk_test_123');   // decrypted from vault
    assert.equal(put.STRIPE_SECRET_KEY.type, 'secret_text');
    assert.equal(put.ANTHROPIC_API_KEY.text, 'sk-ant-xyz');
    assert.deepEqual(calls.del, ['OLD_KEY']);                  // removed-from-vault deleted
  } finally { restore(); }
});

test('skips when the worker has no linked project', async () => {
  const db = makeDb();
  db.prepare('INSERT INTO cloud_workers (id, project_id) VALUES (?,?)').run('app-bbb', null);
  const { restore } = stubFetch([]);
  try {
    assert.deepEqual(await syncWorkerSecrets(db, 'app-bbb'), { skipped: 'no_linked_project' });
  } finally { restore(); }
});

test('skips when the project has no managed backend', async () => {
  const db = makeDb();
  db.prepare('INSERT INTO cloud_workers (id, project_id) VALUES (?,?)').run('app-ccc', 'P2');
  const { restore } = stubFetch([]);
  try {
    assert.deepEqual(await syncWorkerSecrets(db, 'app-ccc'), { skipped: 'no_backend' });
  } finally { restore(); }
});

test('an empty vault deletes all previously-synced secrets', async () => {
  const db = makeDb();
  db.prepare('INSERT INTO cloud_workers (id, project_id) VALUES (?,?)').run('app-ddd', 'P3');
  db.prepare('INSERT INTO account_backends (id, project_id) VALUES (?,?)').run('be-3', 'P3');
  const { calls, restore } = stubFetch(['LEFTOVER_A', 'LEFTOVER_B']);
  try {
    const res = await syncWorkerSecrets(db, 'app-ddd');
    assert.deepEqual(res, { synced: 0, removed: 2 });
    assert.deepEqual(calls.put, []);
    assert.deepEqual(calls.del.sort(), ['LEFTOVER_A', 'LEFTOVER_B']);
  } finally { restore(); }
});
