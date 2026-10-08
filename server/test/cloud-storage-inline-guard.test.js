'use strict';

// Prod ran without SPACES_* and silently stored 2.3 GB of app uploads as base64
// in data.db, filling the disk (2026-10-08). Production must refuse instead of
// falling back; CLOUD_STORAGE_ALLOW_INLINE=1 is the explicit escape hatch.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const cloudStorage = require('../cloud-storage');
const { persistObject } = require('../cloud-backend');

const b64 = Buffer.alloc(1000, 1).toString('base64');

async function withSpacesMissing(env, fn) {
  const vars = { CLOUD_OPS_ALERT_EMAIL: '', ...env };
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  const original = cloudStorage.isConfigured;
  cloudStorage.isConfigured = () => false; // as on prod before 2026-10-08
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE backend_objects (
    id TEXT PRIMARY KEY, backend_id TEXT NOT NULL, bucket TEXT NOT NULL DEFAULT 'public',
    path TEXT NOT NULL, content_type TEXT, bytes INTEGER NOT NULL DEFAULT 0,
    data_b64 TEXT NOT NULL, created_at TEXT NOT NULL, spaces_key TEXT, etag TEXT, owner_user_id TEXT,
    UNIQUE(backend_id, bucket, path)
  )`);
  try {
    await fn(db, () => db.prepare('SELECT COUNT(*) AS n FROM backend_objects').get().n);
  } finally {
    cloudStorage.isConfigured = original;
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    db.close();
  }
}

test('production without Spaces refuses the upload with storage_unavailable and stores nothing', async () => {
  await withSpacesMissing({ NODE_ENV: 'production' }, async (db, count) => {
    await assert.rejects(
      persistObject(db, 'be1', 'public', 'a.jpg', 'image/jpeg', b64, 1000, null),
      (err) => err.status === 503 && err.code === 'storage_unavailable');
    assert.equal(count(), 0);
  });
});

test('CLOUD_STORAGE_ALLOW_INLINE=1 keeps the inline fallback in production', async () => {
  await withSpacesMissing({ NODE_ENV: 'production', CLOUD_STORAGE_ALLOW_INLINE: '1' }, async (db, count) => {
    await persistObject(db, 'be1', 'public', 'a.jpg', 'image/jpeg', b64, 1000, null);
    assert.equal(count(), 1);
  });
});

test('outside production the inline fallback still works (dev and tests)', async () => {
  await withSpacesMissing({ NODE_ENV: 'test' }, async (db, count) => {
    await persistObject(db, 'be1', 'public', 'a.jpg', 'image/jpeg', b64, 1000, null);
    assert.equal(count(), 1);
  });
});
