'use strict';

// Integration test for the remote-host REST routes against a real express app
// + in-memory sqlite + the real getUserFromRequest (Bearer api_access_token).
//
//   node --test remote-routes.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const Database = require('better-sqlite3');
const { migrateRemoteHostsTable } = require('../migrate');
const { registerRemoteRoutes } = require('../remote-routes');
const { resolveToken } = require('../account-tokens');

function makeServer() {
  const db = new Database(':memory:');
  // Minimal users table — getUserFromRequest only needs id + api_access_token.
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, api_access_token TEXT)');
  db.prepare('INSERT INTO users (id, email, api_access_token) VALUES (?, ?, ?)')
    .run('u1', 'wei@example.com', 'tok123');
  migrateRemoteHostsTable(db);

  const app = express();
  app.use(express.json());
  registerRemoteRoutes(app, db);
  return { db, app };
}

function listen(app) {
  return new Promise((res) => { const s = app.listen(0, () => res(s)); });
}

async function call(server, method, path, { token, body } = {}) {
  const port = server.address().port;
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => null);
  return { status: r.status, json };
}

test('remote-host REST lifecycle: create → list → room → delete, with auth gating', async () => {
  const { app, db } = makeServer();
  const server = await listen(app);
  try {
    // Unauthenticated create is rejected.
    const noauth = await call(server, 'POST', '/api/remote/hosts', { body: { name: 'X' } });
    assert.equal(noauth.status, 401);

    // Create a host.
    const created = await call(server, 'POST', '/api/remote/hosts', { token: 'tok123', body: { name: 'Wei MacBook' } });
    assert.equal(created.status, 200);
    assert.equal(created.json.ok, true);
    assert.ok(created.json.host.id, 'host id returned');
    assert.match(created.json.wsUrl, /\/ws\/collab\/[0-9a-f-]+\?token=lct_[0-9a-f]{64}$/);
    const hostId = created.json.host.id;
    const createdToken = new URL(created.json.wsUrl).searchParams.get('token');
    const createdCredential = resolveToken(db, createdToken);
    assert.deepEqual(createdCredential.tokenScope, { projectKey: `remote:${hostId}`, caps: 'remote' });
    const createdStored = db.prepare('SELECT * FROM account_tokens WHERE id=?').get(createdCredential.tokenId);
    assert.equal(JSON.stringify(createdStored).includes(createdToken), false);
    assert.ok(createdStored.expires_at <= Date.now() + 60 * 60 * 1000);

    // List shows it, offline (no live tunnel in this test).
    const listed = await call(server, 'GET', '/api/remote/hosts', { token: 'tok123' });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.hosts.length, 1);
    assert.equal(listed.json.hosts[0].name, 'Wei MacBook');
    assert.equal(listed.json.hosts[0].online, false);

    // Room info for the web client → wsUrl points at /__serve with the token.
    const room = await call(server, 'GET', `/api/remote/hosts/${hostId}/room`, { token: 'tok123' });
    assert.equal(room.status, 200);
    assert.match(room.json.wsUrl, new RegExp(`/ws/collab/${hostId}/__serve\\?token=lct_[0-9a-f]{64}$`));
    assert.equal(room.json.online, false);

    // A different account cannot see this host's room.
    const other = await call(server, 'GET', `/api/remote/hosts/${hostId}/room`, { token: 'wrongtoken' });
    assert.equal(other.status, 401, 'unknown token unauthorized');

    // Delete.
    const del = await call(server, 'DELETE', `/api/remote/hosts/${hostId}`, { token: 'tok123' });
    assert.equal(del.status, 200);
    assert.equal(del.json.deleted, 1);
    const empty = await call(server, 'GET', '/api/remote/hosts', { token: 'tok123' });
    assert.equal(empty.json.hosts.length, 0);
  } finally {
    server.close();
  }
});

test('share links: view by default (24 h, read-only), drive for a helper (2 h, not read-only), revocable', async () => {
  const { app } = makeServer();
  const server = await listen(app);
  try {
    const host = (await call(server, 'POST', '/api/remote/hosts', { token: 'tok123', body: { name: 'PC' } })).json.host;
    const view = await call(server, 'POST', `/api/remote/hosts/${host.id}/share`, { token: 'tok123' });
    assert.equal(view.json.permission, 'view');
    const drive = await call(server, 'POST', `/api/remote/hosts/${host.id}/share`, { token: 'tok123', body: { permission: 'drive' } });
    assert.equal(drive.json.permission, 'drive');
    const hours = (ms) => Math.round((ms - Date.now()) / 3600e3);
    assert.equal(hours(view.json.expires_at), 24);
    assert.equal(hours(drive.json.expires_at), 2);

    const v = await call(server, 'GET', `/api/remote/share/${view.json.token}`);
    assert.equal(v.json.readOnly, true);
    const d = await call(server, 'GET', `/api/remote/share/${drive.json.token}`);
    assert.equal(d.json.readOnly, false);
    assert.equal(d.json.permission, 'drive');
    assert.match(d.json.wsUrl, /__serve\?share=/);

    // Only the owner can mint one.
    const other = await call(server, 'POST', `/api/remote/hosts/${host.id}/share`, { token: 'nope', body: { permission: 'drive' } });
    assert.equal(other.status, 401);

    await call(server, 'DELETE', `/api/remote/hosts/${host.id}/shares`, { token: 'tok123' });
    assert.equal((await call(server, 'GET', `/api/remote/share/${drive.json.token}`)).status, 404, 'revoked');
  } finally { server.close(); }
});
