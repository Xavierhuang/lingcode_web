'use strict';

// Integration tests for the Preview Python-runtime save + test paths in
// cloud-functions-routes.js. We do NOT actually spawn firejail here (that
// would need a real Linux host with firejail installed and the API's env
// vars wired up) — the runtime module is stubbed so tests exercise route
// logic: the preview-flag gate, the runtime enum validation, the schema
// round-trip, and the availability probe.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

const cloudDataPlane = require('../cloud-data-plane');
const pythonRuntime = require('../cloud-python-runtime');
const { registerCloudFunctionsRoutes } = require('../cloud-functions-routes');
const { migrateUsersTable, migrateCloudBackendTables } = require('../migrate');

async function buildHarness({ pythonEnabled = false } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL DEFAULT 'free',
      created_at TEXT NOT NULL,
      source TEXT DEFAULT ''
    )
  `);
  migrateUsersTable(db);
  migrateCloudBackendTables(db);

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, email, tier, created_at, api_access_token, email_verified)
    VALUES ('user-1', 'pyfn@test.local', 'free', ?, 'token-1', 1)
  `).run(now);
  db.prepare(`
    INSERT INTO account_backends
      (id, user_id, project_key, schema_name, status, tier, python_runtime_enabled, created_at, updated_at)
    VALUES ('backend-1', 'user-1', 'project-1', 'be_backend_1', 'live', 'free', ?, ?, ?)
  `).run(pythonEnabled ? 1 : 0, now, now);

  const originalIsConfigured = cloudDataPlane.isConfigured;
  cloudDataPlane.isConfigured = () => true;

  const app = express();
  app.use(express.json());
  registerCloudFunctionsRoutes(app, db);

  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.on('error', reject);
  });
  const port = server.address().port;

  return {
    db,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.close(() => {
        cloudDataPlane.isConfigured = originalIsConfigured;
        db.close();
        resolve();
      });
    }),
  };
}

test('save without runtime defaults to deno-ts (back-compat)', async () => {
  const h = await buildHarness();
  try {
    const r = await fetch(`${h.baseUrl}/api/cloud/account/backends/backend-1/functions/legacy`, {
      method: 'PUT',
      headers: { authorization: 'Bearer token-1', 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'export default () => ({ ok: true })' }),
    });
    assert.equal(r.status, 200);
    const row = h.db.prepare('SELECT runtime FROM backend_functions WHERE slug = ?').get('legacy');
    assert.equal(row.runtime, 'deno-ts');
  } finally { await h.close(); }
});

test('save with runtime=python is rejected 403 when preview flag is off', async () => {
  const h = await buildHarness({ pythonEnabled: false });
  try {
    const r = await fetch(`${h.baseUrl}/api/cloud/account/backends/backend-1/functions/py-fn`, {
      method: 'PUT',
      headers: { authorization: 'Bearer token-1', 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'python', source: 'def handler(i, c): return {"ok": True}' }),
    });
    assert.equal(r.status, 403);
    const body = await r.json();
    assert.equal(body.error, 'python_runtime_not_enabled');
    // Nothing was written.
    const row = h.db.prepare('SELECT slug FROM backend_functions WHERE slug = ?').get('py-fn');
    assert.equal(row, undefined);
  } finally { await h.close(); }
});

test('save with runtime=python succeeds when preview flag is on', async () => {
  const h = await buildHarness({ pythonEnabled: true });
  try {
    const r = await fetch(`${h.baseUrl}/api/cloud/account/backends/backend-1/functions/py-fn`, {
      method: 'PUT',
      headers: { authorization: 'Bearer token-1', 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'python', source: 'def handler(i, c): return {"ok": True}' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.data.runtime, 'python');
    const row = h.db.prepare('SELECT runtime, source FROM backend_functions WHERE slug = ?').get('py-fn');
    assert.equal(row.runtime, 'python');
    assert.match(row.source, /def handler/);
  } finally { await h.close(); }
});

test('save with unknown runtime is rejected 400', async () => {
  const h = await buildHarness({ pythonEnabled: true });
  try {
    const r = await fetch(`${h.baseUrl}/api/cloud/account/backends/backend-1/functions/bad-rt`, {
      method: 'PUT',
      headers: { authorization: 'Bearer token-1', 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'ruby', source: 'puts "hi"' }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error, 'invalid_runtime');
  } finally { await h.close(); }
});

test('list surfaces python_runtime_available + python_runtime_enabled', async () => {
  const h = await buildHarness({ pythonEnabled: true });
  try {
    const r = await fetch(`${h.baseUrl}/api/cloud/account/backends/backend-1/functions`, {
      headers: { authorization: 'Bearer token-1' },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(typeof body.data.python_runtime_available, 'boolean');
    assert.equal(body.data.python_runtime_enabled, true);
  } finally { await h.close(); }
});

test('test route returns 503 python_runtime_unavailable when runtime not installed', async () => {
  const h = await buildHarness({ pythonEnabled: true });
  const originalIsAvailable = pythonRuntime.isAvailable;
  pythonRuntime.isAvailable = () => false;
  try {
    // Seed a python function first (bypassing the runtime probe path by writing
    // directly — the save route doesn't gate on isAvailable, only the test/invoke does).
    const now = new Date().toISOString();
    h.db.prepare(`
      INSERT INTO backend_functions (id, backend_id, slug, source, runtime, enabled, secrets, created_at, updated_at)
      VALUES ('fn-1', 'backend-1', 'py-fn', 'def handler(i, c): return 1', 'python', 1, '[]', ?, ?)
    `).run(now, now);

    const r = await fetch(`${h.baseUrl}/api/cloud/account/backends/backend-1/functions/py-fn/test`, {
      method: 'POST',
      headers: { authorization: 'Bearer token-1', 'content-type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    });
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.error, 'python_runtime_unavailable');
  } finally {
    pythonRuntime.isAvailable = originalIsAvailable;
    await h.close();
  }
});

test('save updates runtime on an existing slug (upsert path)', async () => {
  const h = await buildHarness({ pythonEnabled: true });
  try {
    // First save as deno-ts.
    let r = await fetch(`${h.baseUrl}/api/cloud/account/backends/backend-1/functions/shared`, {
      method: 'PUT',
      headers: { authorization: 'Bearer token-1', 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'export default () => 1' }),
    });
    assert.equal(r.status, 200);
    assert.equal(h.db.prepare('SELECT runtime FROM backend_functions WHERE slug = ?').get('shared').runtime, 'deno-ts');

    // Now overwrite as python — upsert should flip the runtime column.
    r = await fetch(`${h.baseUrl}/api/cloud/account/backends/backend-1/functions/shared`, {
      method: 'PUT',
      headers: { authorization: 'Bearer token-1', 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'python', source: 'def handler(i, c): return 1' }),
    });
    assert.equal(r.status, 200);
    assert.equal(h.db.prepare('SELECT runtime FROM backend_functions WHERE slug = ?').get('shared').runtime, 'python');
  } finally { await h.close(); }
});
