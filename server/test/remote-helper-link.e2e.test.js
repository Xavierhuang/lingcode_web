'use strict';

// "Invite a helper", end to end over real WebSockets through the real relay:
// a host (as the Windows/Mac app connects), the owner's browser, a helper with
// a drive link and a watcher with a view link. The unit tests call the frame
// handlers directly; this one goes through the HTTP upgrade, where the share
// token decides who may do what.
//
//   node --test test/remote-helper-link.e2e.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const { migrateRemoteHostsTable, migrateCollabTables } = require('../migrate');
const { registerRemoteRoutes } = require('../remote-routes');
const { initCollabServer } = require('../collab-server');

function setup() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, api_access_token TEXT)');
  db.prepare("INSERT INTO users VALUES ('owner', 'o@x.com', 'owner-token'), ('stranger', 's@x.com', 'stranger-token')").run();
  migrateCollabTables(db);
  migrateRemoteHostsTable(db);
  const app = express();
  app.use(express.json());
  registerRemoteRoutes(app, db);
  const server = http.createServer(app);
  initCollabServer(server, db, (req, res, next) => next());
  return new Promise((resolve) => server.listen(0, () => resolve({ db, server, port: server.address().port })));
}

async function rest(port, method, path, token, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// A JSON-frame client: collects frames, resolves waiters by predicate.
function client(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames = [];
    const waiters = [];
    ws.on('message', (data) => {
      const text = data.toString();
      if (!text.startsWith('{')) return;
      const f = JSON.parse(text);
      frames.push(f);
      for (const w of waiters.slice()) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); }
    });
    ws.on('open', () => resolve({
      ws, frames,
      send: (f) => ws.send(JSON.stringify(f)),
      next: (pred, ms = 2000) => new Promise((res, rej) => {
        const hit = frames.find(pred);
        if (hit) { frames.splice(frames.indexOf(hit), 1); return res(hit); }
        const t = setTimeout(() => rej(new Error('timeout waiting for frame')), ms);
        waiters.push({ pred, resolve: (f) => { clearTimeout(t); frames.splice(frames.indexOf(f), 1); res(f); } });
      }),
    }));
    ws.on('unexpected-response', (_req, res) => reject(new Error('HTTP ' + res.statusCode)));
    ws.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a helper link drives the agent chat; a view link only watches; strangers and revoked links are refused', async () => {
  const { server, port } = await setup();
  const base = `ws://127.0.0.1:${port}`;
  const opened = [];
  try {
    const host = (await rest(port, 'POST', '/api/remote/hosts', 'owner-token', { name: 'Client PC' })).json.host;
    const room = `${base}/ws/collab/${host.id}/__serve`;

    // The app connects with the account token and says hello.
    const app = await client(`${room}?token=owner-token`); opened.push(app);
    app.send({ type: 'lc-serve-host-hello' });
    await app.next((f) => f.type === 'lc-serve-host-ack');

    // A stranger's own token cannot reach someone else's PC.
    await assert.rejects(client(`${room}?token=stranger-token`), /HTTP 403/);

    const drive = (await rest(port, 'POST', `/api/remote/hosts/${host.id}/share`, 'owner-token', { permission: 'drive' })).json;
    const view = (await rest(port, 'POST', `/api/remote/hosts/${host.id}/share`, 'owner-token')).json;

    const helper = await client(`${room}?share=${encodeURIComponent(drive.token)}`); opened.push(helper);
    const watcher = await client(`${room}?share=${encodeURIComponent(view.token)}`); opened.push(watcher);

    // Both can list and see the session.
    helper.send({ type: 'lc-agent-list' });
    await app.next((f) => f.type === 'lc-agent-list');
    app.send({ type: 'lc-agent-list-result', sessions: [{ documentId: 'lingcodebaby-chat', displayName: 'AURA', isStreaming: false, needsInput: false, provider: 'claude' }] });
    assert.equal((await helper.next((f) => f.type === 'lc-agent-list-result')).sessions[0].displayName, 'AURA');

    // The helper's message reaches the app…
    helper.send({ type: 'lc-agent-cmd', documentId: 'lingcodebaby-chat', cmd: 'send', text: 'run my app' });
    assert.equal((await app.next((f) => f.type === 'lc-agent-cmd')).text, 'run my app');

    // …the watcher's does not, and neither does the helper's terminal input.
    watcher.send({ type: 'lc-agent-attach', documentId: 'lingcodebaby-chat' });
    await app.next((f) => f.type === 'lc-agent-attach');
    watcher.send({ type: 'lc-agent-cmd', documentId: 'lingcodebaby-chat', cmd: 'send', text: 'from watcher' });
    helper.send({ type: 'lc-term-input', terminalId: 't', dataB64: 'ZGly' });
    helper.send({ type: 'lc-serve-host-hello' });
    await sleep(200);
    assert.deepEqual(app.frames.filter((f) => ['lc-agent-cmd', 'lc-term-input'].includes(f.type)), []);

    // Snapshots reach both.
    app.send({ type: 'lc-agent-state', documentId: 'lingcodebaby-chat', provider: 'claude', snapshot: { isStreaming: true, messages: [] } });
    await helper.next((f) => f.type === 'lc-agent-state');
    await watcher.next((f) => f.type === 'lc-agent-state');

    // Stop sharing: new connections with the old links are refused.
    await rest(port, 'DELETE', `/api/remote/hosts/${host.id}/shares`, 'owner-token');
    await assert.rejects(client(`${room}?share=${encodeURIComponent(drive.token)}`), /HTTP 403/);
  } finally {
    for (const c of opened) { try { c.ws.terminate(); } catch (_) {} }
    server.close();
  }
});
