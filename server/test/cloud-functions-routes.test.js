'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

const cloudDataPlane = require('../cloud-data-plane');
const { registerCloudFunctionsRoutes } = require('../cloud-functions-routes');
const { computeCapabilities } = require('../cloud-limits');
const { migrateUsersTable, migrateCloudBackendTables } = require('../migrate');

async function buildHarness() {
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
    VALUES ('user-1', 'functions@test.local', 'free', ?, 'token-1', 1)
  `).run(now);
  db.prepare(`
    INSERT INTO account_backends
      (id, user_id, project_key, schema_name, status, tier, created_at, updated_at)
    VALUES ('backend-1', 'user-1', 'project-1', 'be_backend_1', 'live', 'free', ?, ?)
  `).run(now, now);

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

function seedFunction(db, slug) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO backend_functions
      (id, backend_id, slug, source, runtime, enabled, secrets, created_at, updated_at)
    VALUES (?, 'backend-1', ?, 'export default () => ({ ok: true })', 'deno-ts', 1, '[]', ?, ?)
  `).run(`function-${slug}`, slug, now, now);
}

test('free backend can save a third custom function', async () => {
  const h = await buildHarness();
  try {
    seedFunction(h.db, 'one');
    seedFunction(h.db, 'two');

    const response = await fetch(`${h.baseUrl}/api/cloud/account/backends/backend-1/functions/three`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer token-1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ source: 'export default () => ({ ok: true })' }),
    });

    assert.equal(response.status, 200);
    assert.equal(
      h.db.prepare('SELECT COUNT(*) AS n FROM backend_functions WHERE backend_id = ?').get('backend-1').n,
      3
    );
  } finally {
    await h.close();
  }
});

test('compute capabilities report unlimited saved function definitions', () => {
  for (const tier of ['free', 'pro', 'max_pro']) {
    const functions = computeCapabilities(tier).functions;
    assert.equal(functions.maxFunctions, null);
    assert.equal(functions.unlimitedSavedDefinitions, true);
  }
});
