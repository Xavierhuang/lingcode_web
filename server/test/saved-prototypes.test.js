'use strict';

// Smoke tests for /api/account/saved-prototypes/*. Spins a tiny Express
// app on port 0 against an in-memory sqlite, then drives it via fetch using
// Bearer-token auth (avoids the cookie-session ceremony).
//
// Run: cd website/server && npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');

const { migrateUsersTable, migrateSavedPrototypesTable, migrateCollabTables, migrateCloudBackendTables } = require('../migrate');
const { registerSavedPrototypeRoutes, registerPublicShareRoute, SAVE_CAP_PER_USER, _resetRateLimits } = require('../saved-prototypes');

function buildHarness() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL DEFAULT 'free',
      created_at TEXT NOT NULL,
      source TEXT DEFAULT ''
    );
  `);
  migrateUsersTable(db);
  migrateSavedPrototypesTable(db);
  migrateCollabTables(db); // saved-prototype routes touch collab_members (per-prototype rooms)
  migrateCloudBackendTables(db); // delete cascades into prototype_backends + backend_* tables

  const app = express();
  app.use(express.json({ limit: '128kb' }));
  registerSavedPrototypeRoutes(app, db);
  registerPublicShareRoute(app, db);

  // Bearer-token user. PUBLIC_ORIGIN unset → checkOrigin uses the request
  // host as the allowed host, so localhost requests pass naturally.
  const userId = 'user-' + crypto.randomBytes(4).toString('hex');
  const token = 'tok-' + crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO users (id, email, tier, created_at, api_access_token, email_verified)
    VALUES (?, ?, 'free', ?, ?, 1)
  `).run(userId, `${userId}@test.local`, new Date().toISOString(), token);

  // A second user to test cross-user isolation.
  const otherId = 'user-' + crypto.randomBytes(4).toString('hex');
  const otherToken = 'tok-' + crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO users (id, email, tier, created_at, api_access_token, email_verified)
    VALUES (?, ?, 'free', ?, ?, 1)
  `).run(otherId, `${otherId}@test.local`, new Date().toISOString(), otherToken);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        db, app, server, port, userId, token, otherId, otherToken,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

function authHeaders(token, extra = {}) {
  return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...extra };
}

async function jsonOf(r) {
  const text = await r.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

test('GET list — 401 when unauthenticated', async () => {
  const h = await buildHarness();
  try {
    const r = await fetch(`${h.baseUrl}/api/account/saved-prototypes`);
    assert.equal(r.status, 401);
    const j = await jsonOf(r);
    assert.equal(j.error, 'unauthorized');
  } finally { await h.close(); }
});

test('POST → list → get → patch → delete round-trip', async () => {
  const h = await buildHarness();
  _resetRateLimits();
  try {
    const create = await fetch(`${h.baseUrl}/api/account/saved-prototypes`, {
      method: 'POST', headers: authHeaders(h.token),
      body: JSON.stringify({
        title: 'My pitch deck',
        share_payload: 'PGh0bWw+aGk8L2h0bWw+',
        share_version: 1,
        source_prompt: 'Build me a deck',
        provider_id: 'claude',
      }),
    });
    assert.equal(create.status, 201);
    const { id } = await jsonOf(create);
    assert.match(id, /^[0-9a-f-]{36}$/i);

    const list = await jsonOf(await fetch(`${h.baseUrl}/api/account/saved-prototypes`, { headers: authHeaders(h.token) }));
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].title, 'My pitch deck');
    assert.equal(list.items[0].provider_id, 'claude');
    assert.equal(list.cap, SAVE_CAP_PER_USER);
    // List omits share_payload to keep the response small.
    assert.equal(list.items[0].share_payload, undefined);

    const got = await jsonOf(await fetch(`${h.baseUrl}/api/account/saved-prototypes/${id}`, { headers: authHeaders(h.token) }));
    assert.equal(got.item.title, 'My pitch deck');
    assert.equal(got.item.share_payload, 'PGh0bWw+aGk8L2h0bWw+');
    assert.match(got.item.share_url, /\/try\.html#p=PGh0bWw%2BaGk8L2h0bWw%2B$/);
    assert.ok(got.item.last_opened_at, 'last_opened_at is bumped');

    const renamed = await fetch(`${h.baseUrl}/api/account/saved-prototypes/${id}`, {
      method: 'PATCH', headers: authHeaders(h.token),
      body: JSON.stringify({ title: 'Renamed deck' }),
    });
    assert.equal(renamed.status, 200);
    const list2 = await jsonOf(await fetch(`${h.baseUrl}/api/account/saved-prototypes`, { headers: authHeaders(h.token) }));
    assert.equal(list2.items[0].title, 'Renamed deck');

    const del = await fetch(`${h.baseUrl}/api/account/saved-prototypes/${id}`, {
      method: 'DELETE', headers: authHeaders(h.token),
    });
    assert.equal(del.status, 200);
    const list3 = await jsonOf(await fetch(`${h.baseUrl}/api/account/saved-prototypes`, { headers: authHeaders(h.token) }));
    assert.equal(list3.items.length, 0);
  } finally { await h.close(); }
});

test('POST 51st → 409 cap_reached with oldest payload', async () => {
  const h = await buildHarness();
  _resetRateLimits();
  try {
    // Insert SAVE_CAP_PER_USER rows directly into the DB to bypass the
    // 60/hour rate limit.
    const insert = h.db.prepare(`
      INSERT INTO saved_prototypes (id, user_id, title, share_payload, share_version, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `);
    let oldestId = null;
    let oldestTitle = null;
    for (let i = 0; i < SAVE_CAP_PER_USER; i++) {
      const id = crypto.randomUUID();
      const title = `Saved ${i}`;
      const ts = Date.now() - (SAVE_CAP_PER_USER - i) * 1000;
      insert.run(id, h.userId, title, 'PGg+aDwvaD4=', ts);
      if (i === 0) { oldestId = id; oldestTitle = title; }
    }
    const create = await fetch(`${h.baseUrl}/api/account/saved-prototypes`, {
      method: 'POST', headers: authHeaders(h.token),
      body: JSON.stringify({ title: 'Overflow', share_payload: 'PGg+aDwvaD4=', share_version: 1 }),
    });
    assert.equal(create.status, 409);
    const j = await jsonOf(create);
    assert.equal(j.error, 'cap_reached');
    assert.equal(j.cap, SAVE_CAP_PER_USER);
    assert.equal(j.oldest.id, oldestId);
    assert.equal(j.oldest.title, oldestTitle);
  } finally { await h.close(); }
});

test('rate limit — POST > 60/hour returns 429', async () => {
  const h = await buildHarness();
  _resetRateLimits();
  try {
    let lastStatus = 0;
    for (let i = 0; i < 65; i++) {
      const r = await fetch(`${h.baseUrl}/api/account/saved-prototypes`, {
        method: 'POST', headers: authHeaders(h.token),
        body: JSON.stringify({ title: `t${i}`, share_payload: 'PGg+aDwvaD4=', share_version: 1 }),
      });
      lastStatus = r.status;
      // Drain body to avoid socket leaks.
      await r.text();
    }
    assert.equal(lastStatus, 429);
  } finally { await h.close(); }
});

test('cross-user GET-by-id returns 404 (no existence leak)', async () => {
  const h = await buildHarness();
  _resetRateLimits();
  try {
    const create = await fetch(`${h.baseUrl}/api/account/saved-prototypes`, {
      method: 'POST', headers: authHeaders(h.token),
      body: JSON.stringify({ title: 'mine', share_payload: 'PGg+aDwvaD4=', share_version: 1 }),
    });
    const { id } = await jsonOf(create);
    const r = await fetch(`${h.baseUrl}/api/account/saved-prototypes/${id}`, {
      headers: authHeaders(h.otherToken),
    });
    assert.equal(r.status, 404);
  } finally { await h.close(); }
});

test('400 on missing/invalid title or payload', async () => {
  const h = await buildHarness();
  _resetRateLimits();
  try {
    let r = await fetch(`${h.baseUrl}/api/account/saved-prototypes`, {
      method: 'POST', headers: authHeaders(h.token),
      body: JSON.stringify({ title: '', share_payload: 'PGg=' }),
    });
    assert.equal(r.status, 400);
    await r.text();

    r = await fetch(`${h.baseUrl}/api/account/saved-prototypes`, {
      method: 'POST', headers: authHeaders(h.token),
      body: JSON.stringify({ title: 'ok', share_payload: '' }),
    });
    assert.equal(r.status, 400);
    await r.text();

    // Title too long
    r = await fetch(`${h.baseUrl}/api/account/saved-prototypes`, {
      method: 'POST', headers: authHeaders(h.token),
      body: JSON.stringify({ title: 'x'.repeat(200), share_payload: 'PGg=' }),
    });
    assert.equal(r.status, 400);
  } finally { await h.close(); }
});

test('415 when POST without application/json content-type', async () => {
  const h = await buildHarness();
  _resetRateLimits();
  try {
    const r = await fetch(`${h.baseUrl}/api/account/saved-prototypes`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${h.token}`, 'Content-Type': 'text/plain' },
      body: 'plain text body',
    });
    assert.equal(r.status, 415);
  } finally { await h.close(); }
});

test('share_url uses #gp= for v2 rows, #p= for v1', async () => {
  const h = await buildHarness();
  _resetRateLimits();
  try {
    const v1 = await fetch(`${h.baseUrl}/api/account/saved-prototypes`, {
      method: 'POST', headers: authHeaders(h.token),
      body: JSON.stringify({ title: 'v1', share_payload: 'PGg+aDwvaD4=', share_version: 1 }),
    });
    const v1Id = (await jsonOf(v1)).id;
    const v2 = await fetch(`${h.baseUrl}/api/account/saved-prototypes`, {
      method: 'POST', headers: authHeaders(h.token),
      body: JSON.stringify({ title: 'v2', share_payload: 'H4sIAAAAAAAAAw==', share_version: 2 }),
    });
    const v2Id = (await jsonOf(v2)).id;
    const v1Got = await jsonOf(await fetch(`${h.baseUrl}/api/account/saved-prototypes/${v1Id}`, { headers: authHeaders(h.token) }));
    const v2Got = await jsonOf(await fetch(`${h.baseUrl}/api/account/saved-prototypes/${v2Id}`, { headers: authHeaders(h.token) }));
    assert.match(v1Got.item.share_url, /\/try\.html#p=/);
    assert.match(v2Got.item.share_url, /\/try\.html#gp=/);
    assert.equal(v1Got.item.share_version, 1);
    assert.equal(v2Got.item.share_version, 2);
  } finally { await h.close(); }
});

test('GET /p/:id — 200 inline-renders prototype in sandboxed iframe (v1 raw base64)', async () => {
  const h = await buildHarness();
  _resetRateLimits();
  try {
    // v1 = raw base64. "<h>h</h>" in base64.
    const create = await fetch(`${h.baseUrl}/api/account/saved-prototypes`, {
      method: 'POST', headers: authHeaders(h.token),
      body: JSON.stringify({ title: 'My deck', share_payload: 'PGg+aDwvaD4=', share_version: 1 }),
    });
    const { id } = await jsonOf(create);
    // No auth — public read, UUID is the secret.
    const r = await fetch(`${h.baseUrl}/p/${id}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    // URL stays at /p/<id> — no redirect to /try.html anywhere in the body.
    assert.ok(!body.includes('/try.html#'), 'body should not embed the long share URL');
    // Iframe is sandboxed and the decoded prototype is in srcdoc (escaped).
    assert.match(body, /<iframe\b[^>]*sandbox=/);
    assert.match(body, /srcdoc="&lt;h&gt;h&lt;\/h&gt;"/);
    // Title shows up in the page <title>.
    assert.match(body, /<title>My deck/);
  } finally { await h.close(); }
});

test('GET /p/:id — 200 inline-renders v2 (gzip+base64) prototype', async () => {
  const h = await buildHarness();
  _resetRateLimits();
  try {
    // Real gzip of "<html>hi</html>" → base64.
    const zlib = require('node:zlib');
    const payload = zlib.gzipSync(Buffer.from('<html>hi</html>', 'utf8')).toString('base64');
    const create = await fetch(`${h.baseUrl}/api/account/saved-prototypes`, {
      method: 'POST', headers: authHeaders(h.token),
      body: JSON.stringify({ title: 'gz', share_payload: payload, share_version: 2 }),
    });
    const { id } = await jsonOf(create);
    const r = await fetch(`${h.baseUrl}/p/${id}`);
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /<iframe\b[^>]*sandbox=/);
    // Decoded content lands in srcdoc (escaped).
    assert.match(body, /srcdoc="&lt;html&gt;hi&lt;\/html&gt;"/);
  } finally { await h.close(); }
});

test('GET /p/:id — v3 multi-file renders wrapper with embedded FILES + nav script', async () => {
  const h = await buildHarness();
  _resetRateLimits();
  try {
    const zlib = require('node:zlib');
    const files = {
      'index.html': '<html><body><h1>Home</h1><a href="about.html">About</a></body></html>',
      'about.html': '<html><body><h1>About</h1><a href="index.html">Home</a></body></html>',
    };
    const json = JSON.stringify({ files, initial: 'index.html' });
    const payload = zlib.gzipSync(Buffer.from(json, 'utf8')).toString('base64');
    const create = await fetch(`${h.baseUrl}/api/account/saved-prototypes`, {
      method: 'POST', headers: authHeaders(h.token),
      body: JSON.stringify({ title: 'multipage', share_payload: payload, share_version: 3 }),
    });
    const { id } = await jsonOf(create);
    const r = await fetch(`${h.baseUrl}/p/${id}`);
    assert.equal(r.status, 200);
    const body = await r.text();
    // Wrapper page contains an iframe with sandbox, the FILES JSON, and
    // the show() / postMessage navigation script.
    assert.match(body, /<iframe\b[^>]*sandbox=/);
    assert.match(body, /var FILES =/);
    assert.match(body, /lingcode-nav/);
    assert.match(body, /index\.html/);
    assert.match(body, /about\.html/);
    // Both file contents are embedded (escaped JSON) so internal nav can
    // swap srcdoc client-side without another server round-trip.
    assert.ok(body.includes('Home'), 'index.html content embedded');
    assert.ok(body.includes('About'), 'about.html content embedded');
    // No long /try.html#... share URL in the body.
    assert.ok(!body.includes('/try.html#'), 'wrapper must not embed the long share URL');
  } finally { await h.close(); }
});

test('GET /p/:id — 404 on unknown id and on bad uuid format', async () => {
  const h = await buildHarness();
  _resetRateLimits();
  try {
    const bad = await fetch(`${h.baseUrl}/p/not-a-uuid`);
    assert.equal(bad.status, 404);
    await bad.text();
    const missing = await fetch(`${h.baseUrl}/p/00000000-0000-0000-0000-000000000000`);
    assert.equal(missing.status, 404);
    await missing.text();
  } finally { await h.close(); }
});

test('GET /p/:id — bumps last_opened_at', async () => {
  const h = await buildHarness();
  _resetRateLimits();
  try {
    const create = await fetch(`${h.baseUrl}/api/account/saved-prototypes`, {
      method: 'POST', headers: authHeaders(h.token),
      body: JSON.stringify({ title: 'opened', share_payload: 'PGg+aDwvaD4=', share_version: 1 }),
    });
    const { id } = await jsonOf(create);
    const before = h.db.prepare('SELECT last_opened_at FROM saved_prototypes WHERE id = ?').get(id).last_opened_at;
    assert.equal(before, null);
    const r = await fetch(`${h.baseUrl}/p/${id}`);
    assert.equal(r.status, 200);
    await r.text();
    const after = h.db.prepare('SELECT last_opened_at FROM saved_prototypes WHERE id = ?').get(id).last_opened_at;
    assert.ok(typeof after === 'number' && after > 0, 'last_opened_at was bumped');
  } finally { await h.close(); }
});

test('thumbnail roundtrips on POST and shows up on GET list', async () => {
  const h = await buildHarness();
  _resetRateLimits();
  try {
    const thumb = 'data:image/webp;base64,UklGRiYAAABXRUJQVlA4IBoAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v3AgAA=';
    const create = await fetch(`${h.baseUrl}/api/account/saved-prototypes`, {
      method: 'POST', headers: authHeaders(h.token),
      body: JSON.stringify({
        title: 'with-thumb', share_payload: 'PGg+aDwvaD4=', share_version: 2,
        thumbnail: thumb,
      }),
    });
    assert.equal(create.status, 201);
    const list = await jsonOf(await fetch(`${h.baseUrl}/api/account/saved-prototypes`, { headers: authHeaders(h.token) }));
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].thumbnail, thumb);
  } finally { await h.close(); }
});

test('thumbnail rejected when not a data:image/* URL (silently dropped)', async () => {
  const h = await buildHarness();
  _resetRateLimits();
  try {
    const create = await fetch(`${h.baseUrl}/api/account/saved-prototypes`, {
      method: 'POST', headers: authHeaders(h.token),
      body: JSON.stringify({
        title: 'bad-thumb', share_payload: 'PGg+aDwvaD4=', share_version: 2,
        thumbnail: 'http://evil.example/exfil.gif',
      }),
    });
    assert.equal(create.status, 201);
    const list = await jsonOf(await fetch(`${h.baseUrl}/api/account/saved-prototypes`, { headers: authHeaders(h.token) }));
    assert.equal(list.items[0].thumbnail, null);
  } finally { await h.close(); }
});

test('400 on invalid uuid in :id', async () => {
  const h = await buildHarness();
  _resetRateLimits();
  try {
    const r = await fetch(`${h.baseUrl}/api/account/saved-prototypes/not-a-uuid`, {
      headers: authHeaders(h.token),
    });
    assert.equal(r.status, 400);
  } finally { await h.close(); }
});
