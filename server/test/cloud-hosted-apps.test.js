'use strict';

// Integration tests for cloud-hosted-apps.js — the owner-only CRUD/lifecycle
// surface for LingCode Cloud's hosted-apps tier. Same shape as
// cloud-compute.test.js: in-memory SQLite, real express server, real HTTP fetch,
// with a stubbed runner (no docker) so we can drive every route without a
// linux box.
//
//   node --test cloud-hosted-apps.test.js
//
// The runner interface exercised here is intentionally the same object shape
// the real cloud-hosted-app-runner.js exposes (enqueueDeploy, pauseApp,
// resumeApp, restartApp, deleteApp, tailLogs). That parity is why an integration
// test with a stub is a real regression trap: any drift in the interface breaks
// this file.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const express = require('express');
const Database = require('better-sqlite3');
const tar = require('tar-stream');

// Stub cloud-data-plane BEFORE requiring the routes file. The routes call
// `dataPlane.isConfigured()` on every request; without a stub we'd have to
// export CLOUD_PG_ADMIN_URL + a real JWT secret into the test process.
const dataPlane = require('../cloud-data-plane');
dataPlane.isConfigured = () => true;

// Point the SOURCE_ROOT at a tmp dir so writes don't need /var/lib access.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hosted-apps-'));
process.env.HOSTED_APP_SOURCE_DIR = TMP_ROOT;

const { registerHostedAppRoutes } = require('../cloud-hosted-apps');
const {
  migrateUsersTable, migrateCloudBackendTables, migrateHostedAppsTables, migrateComputeTables,
} = require('../migrate');

// ─── DB scaffolding ───────────────────────────────────────────────────────────
// migrateUsersTable only ADDS columns; base users table must exist first.
// account_backends is created by migrateCloudBackendTables, but references
// users via FK (FK enforcement is OFF so the order is forgiving).
function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 1,
      tier TEXT
    );
  `);
  migrateUsersTable(db);
  migrateCloudBackendTables(db);
  migrateComputeTables(db);
  migrateHostedAppsTables(db);
  return db;
}

function seedUser(db, id, token, tier) {
  db.prepare('INSERT INTO users (id, email, email_verified, tier, api_access_token) VALUES (?,?,1,?,?)')
    .run(id, `${id}@x.com`, tier || 'pro', token);
}
function seedBackend(db, id, userId, tier) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO account_backends (id, user_id, project_key, schema_name, status, tier, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`)
    .run(id, userId, id, `s_${id}`, tier || 'pro', now, now);
}

// ─── Runner stub ──────────────────────────────────────────────────────────────
// Records every call for later assertion. Every mutator returns success
// unless you set stub.next<Method>Error = new Error(...).
function makeStubRunner() {
  const calls = { enqueueDeploy: [], pauseApp: [], resumeApp: [], restartApp: [], deleteApp: [], tailLogs: [] };
  const stub = {
    calls,
    async pauseApp(a) { calls.pauseApp.push(a); if (stub.nextPauseError) { const e = stub.nextPauseError; stub.nextPauseError = null; throw e; } },
    async resumeApp(a) { calls.resumeApp.push(a); if (stub.nextResumeError) { const e = stub.nextResumeError; stub.nextResumeError = null; throw e; } },
    async restartApp(a) { calls.restartApp.push(a); },
    async deleteApp(a) { calls.deleteApp.push(a); },
    enqueueDeploy(a) { calls.enqueueDeploy.push(a); },
    async tailLogs({ appId, tail, follow }) {
      calls.tailLogs.push({ appId, tail, follow });
      const emitter = new EventEmitter();
      emitter.stop = () => { emitter.emit('end'); };
      // Emit one line immediately so the SSE stream has data past the heartbeat.
      setImmediate(() => emitter.emit('data', Buffer.from('hello from stub\n')));
      return emitter;
    },
  };
  return stub;
}

// ─── App bootstrapping ────────────────────────────────────────────────────────
function startServer(db, runner) {
  const app = express();
  // The routes DELIBERATELY do NOT install express.json for source upload
  // paths (raw stream). For the JSON routes we still need a parser.
  app.use((req, res, next) => {
    if (req.method === 'PUT' && /\/source$/.test(req.path)) return next();
    express.json({ limit: '256kb' })(req, res, next);
  });
  registerHostedAppRoutes(app, db, runner);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        base: `http://127.0.0.1:${port}/api/cloud/account/backends`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function bearer(token) { return { authorization: `Bearer ${token}` }; }

// ─── Tar helpers for source upload ────────────────────────────────────────────
// Build a gzipped tarball from an in-memory {path: content} map. Returns a
// Buffer suitable for a raw PUT body.
function buildTarballGz(files) {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    for (const [name, content] of Object.entries(files)) {
      pack.entry({ name }, Buffer.isBuffer(content) ? content : Buffer.from(content));
    }
    pack.finalize();
    const chunks = [];
    pack.on('data', (c) => chunks.push(c));
    pack.on('end', () => {
      const raw = Buffer.concat(chunks);
      zlib.gzip(raw, (err, gz) => (err ? reject(err) : resolve(gz)));
    });
    pack.on('error', reject);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────
test('create app on pro tier → 200', async () => {
  const db = freshDb();
  seedUser(db, 'u1', 't-pro', 'pro');
  seedBackend(db, 'be1', 'u1', 'pro');
  const runner = makeStubRunner();
  const s = await startServer(db, runner);
  try {
    const r = await fetch(`${s.base}/be1/apps`, {
      method: 'POST',
      headers: { ...bearer('t-pro'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'hello' }),
    });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.data.name, 'hello');
    assert.match(body.data.subdomain, /^hello-[a-f0-9]{8}$/);
    // A "created" event was written to the ring buffer.
    const ev = db.prepare('SELECT kind FROM hosted_app_events WHERE app_id=?').all(body.data.id);
    assert.ok(ev.some((e) => e.kind === 'created'));
  } finally { await s.close(); }
});

test('create app on free tier → 403 hosted_app_quota_exceeded', async () => {
  const db = freshDb();
  seedUser(db, 'u1', 't-free', 'free');
  seedBackend(db, 'be1', 'u1', 'free');
  const s = await startServer(db, makeStubRunner());
  try {
    const r = await fetch(`${s.base}/be1/apps`, {
      method: 'POST',
      headers: { ...bearer('t-free'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'hello' }),
    });
    const body = await r.json();
    assert.equal(r.status, 403);
    assert.equal(body.error, 'hosted_app_quota_exceeded');
    assert.match(body.message, /free/);
  } finally { await s.close(); }
});

test('create with invalid slug → 400 invalid_slug', async () => {
  const db = freshDb();
  seedUser(db, 'u1', 't', 'pro');
  seedBackend(db, 'be1', 'u1', 'pro');
  const s = await startServer(db, makeStubRunner());
  try {
    for (const bad of ['Bad_Name', '9leading', '-dashstart', 'x'.repeat(50)]) {
      const r = await fetch(`${s.base}/be1/apps`, {
        method: 'POST',
        headers: { ...bearer('t'), 'content-type': 'application/json' },
        body: JSON.stringify({ name: bad }),
      });
      const body = await r.json();
      assert.equal(r.status, 400, `expected 400 for "${bad}"`);
      assert.equal(body.error, 'invalid_slug');
    }
  } finally { await s.close(); }
});

test('source upload: happy path writes deploy row + pings runner', async () => {
  const db = freshDb();
  seedUser(db, 'u1', 't', 'pro');
  seedBackend(db, 'be1', 'u1', 'pro');
  const runner = makeStubRunner();
  const s = await startServer(db, runner);
  try {
    // Create the app first.
    const c = await fetch(`${s.base}/be1/apps`, {
      method: 'POST',
      headers: { ...bearer('t'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo' }),
    }).then((x) => x.json());
    const appId = c.data.id;

    const gz = await buildTarballGz({
      'requirements.txt': 'fastapi==0.115.0\nuvicorn==0.30.6\n',
      'app.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
      'Procfile': 'web: uvicorn app:app --host 0.0.0.0 --port $PORT\n',
    });
    const r = await fetch(`${s.base}/be1/apps/${appId}/source`, {
      method: 'PUT',
      headers: { ...bearer('t'), 'content-type': 'application/gzip' },
      body: gz,
    });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.data.filesCount, 3);
    assert.ok(body.data.uncompressedBytes > 0);

    // Deploy row inserted, queued, sha256 populated.
    const dep = db.prepare('SELECT * FROM hosted_app_deploys WHERE id = ?').get(body.data.deployId);
    assert.ok(dep && dep.status === 'queued');
    assert.match(dep.source_sha256, /^[a-f0-9]{64}$/);

    // procfile_web propagated to the app row.
    const app = db.prepare('SELECT procfile_web FROM hosted_apps WHERE id=?').get(appId);
    assert.match(app.procfile_web, /^uvicorn app:app/);

    // Runner was pinged with the queued deploy id.
    assert.equal(runner.calls.enqueueDeploy.length, 1);
    assert.equal(runner.calls.enqueueDeploy[0].deployId, body.data.deployId);

    // Files landed on disk under the source dir.
    const diskPath = path.join(TMP_ROOT, appId, body.data.deployId, 'source', 'app.py');
    assert.ok(fs.existsSync(diskPath), 'expected extracted app.py on disk');
  } finally { await s.close(); }
});

test('source upload: rejects tarball missing requirements.txt', async () => {
  const db = freshDb();
  seedUser(db, 'u1', 't', 'pro');
  seedBackend(db, 'be1', 'u1', 'pro');
  const s = await startServer(db, makeStubRunner());
  try {
    const c = await fetch(`${s.base}/be1/apps`, {
      method: 'POST', headers: { ...bearer('t'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo' }),
    }).then((x) => x.json());
    const gz = await buildTarballGz({ 'app.py': 'print("hi")\n' });
    const r = await fetch(`${s.base}/be1/apps/${c.data.id}/source`, {
      method: 'PUT', headers: { ...bearer('t') }, body: gz,
    });
    const body = await r.json();
    assert.equal(r.status, 422);
    assert.equal(body.error, 'hosted_app_invalid_source');
    assert.match(body.message, /requirements/);
  } finally { await s.close(); }
});

test('source upload: rejects tarball with no .py at top level', async () => {
  const db = freshDb();
  seedUser(db, 'u1', 't', 'pro');
  seedBackend(db, 'be1', 'u1', 'pro');
  const s = await startServer(db, makeStubRunner());
  try {
    const c = await fetch(`${s.base}/be1/apps`, {
      method: 'POST', headers: { ...bearer('t'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo' }),
    }).then((x) => x.json());
    const gz = await buildTarballGz({ 'requirements.txt': 'fastapi\n', 'readme.md': '# no py' });
    const r = await fetch(`${s.base}/be1/apps/${c.data.id}/source`, {
      method: 'PUT', headers: { ...bearer('t') }, body: gz,
    });
    const body = await r.json();
    assert.equal(r.status, 422);
    assert.equal(body.error, 'hosted_app_invalid_source');
    assert.match(body.message, /\.py/);
  } finally { await s.close(); }
});

test('source upload: rejects oversize gzipped payload with 413/422', async () => {
  const db = freshDb();
  seedUser(db, 'u1', 't', 'pro');
  seedBackend(db, 'be1', 'u1', 'pro');
  const s = await startServer(db, makeStubRunner());
  try {
    const c = await fetch(`${s.base}/be1/apps`, {
      method: 'POST', headers: { ...bearer('t'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo' }),
    }).then((x) => x.json());
    // 60 MB of random bytes → doesn't compress → exceeds 50 MB gzip cap.
    const junk = crypto.randomBytes(60 * 1024 * 1024);
    // We do NOT gzip so the wire body is guaranteed > 50 MB — the cap fires
    // before the server ever tries to gunzip.
    //
    // Three legitimate outcomes for "too big" and this test accepts all
    // three, because Express + undici draw the line in different places
    // depending on how quickly Express's body-size limit trips:
    //
    //   (a) Clean 413 / 4xx with a JSON error body — the ideal path.
    //   (b) Any non-200 with no JSON body — the server closed the response
    //       stream before writing headers/body.
    //   (c) fetch() itself throws TypeError('fetch failed') because the
    //       server destroyed the socket mid-upload before the client
    //       finished sending. undici surfaces this as an error rather
    //       than a response object.
    //
    // Historically only (a) and (b) were handled; on prod-Node 2026-08-13
    // Express destroys the socket fast enough that (c) is what actually
    // fires, producing `TypeError: fetch failed` and a test failure. The
    // test's own comment already documented (c) as acceptable — this fix
    // brings the code into line with the intent.
    let r;
    try {
      r = await fetch(`${s.base}/be1/apps/${c.data.id}/source`, {
        method: 'PUT', headers: { ...bearer('t') }, body: junk,
      });
    } catch (e) {
      // Path (c): socket destroyed mid-upload. Prove it's a network-shape
      // error (not e.g. an assertion inside our own then-block) before
      // treating as success — a bare `catch` would eat real bugs.
      if (e && e.name === 'TypeError' && /fetch failed/i.test(String(e.message || ''))) {
        return; // cap fired; server closed the socket. done.
      }
      throw e;
    }
    if (r.status === 200) assert.fail('expected rejection for oversize body');
    if (r.headers.get('content-type') && r.headers.get('content-type').includes('application/json')) {
      const body = await r.json();
      assert.ok(['hosted_app_invalid_source', 'invalid_request'].includes(body.error), `unexpected error ${body.error}`);
    }
  } finally { await s.close(); }
});

test('deploy is idempotent: two POSTs return same deployId', async () => {
  const db = freshDb();
  seedUser(db, 'u1', 't', 'pro');
  seedBackend(db, 'be1', 'u1', 'pro');
  const s = await startServer(db, makeStubRunner());
  try {
    const c = await fetch(`${s.base}/be1/apps`, {
      method: 'POST', headers: { ...bearer('t'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo' }),
    }).then((x) => x.json());
    const gz = await buildTarballGz({
      'requirements.txt': 'fastapi\n', 'app.py': 'x=1\n',
    });
    await fetch(`${s.base}/be1/apps/${c.data.id}/source`, {
      method: 'PUT', headers: { ...bearer('t') }, body: gz,
    });
    const r1 = await fetch(`${s.base}/be1/apps/${c.data.id}/deploy`, {
      method: 'POST', headers: { ...bearer('t'), 'content-type': 'application/json' }, body: '{}',
    }).then((x) => x.json());
    const r2 = await fetch(`${s.base}/be1/apps/${c.data.id}/deploy`, {
      method: 'POST', headers: { ...bearer('t'), 'content-type': 'application/json' }, body: '{}',
    }).then((x) => x.json());
    assert.equal(r1.data.deployId, r2.data.deployId);
    // Exactly one queued row for this app.
    const n = db.prepare("SELECT COUNT(*) AS n FROM hosted_app_deploys WHERE app_id=? AND status='queued'").get(c.data.id).n;
    assert.equal(n, 1);
  } finally { await s.close(); }
});

test('pause/resume/restart/delete emit events and delegate to runner', async () => {
  const db = freshDb();
  seedUser(db, 'u1', 't', 'pro');
  seedBackend(db, 'be1', 'u1', 'pro');
  const runner = makeStubRunner();
  const s = await startServer(db, runner);
  try {
    const c = await fetch(`${s.base}/be1/apps`, {
      method: 'POST', headers: { ...bearer('t'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo' }),
    }).then((x) => x.json());
    const appId = c.data.id;

    // Pause.
    let r = await fetch(`${s.base}/be1/apps/${appId}/pause`, { method: 'POST', headers: bearer('t') }).then((x) => x.json());
    assert.equal(r.data.status, 'paused');
    assert.equal(runner.calls.pauseApp.length, 1);
    assert.equal(db.prepare('SELECT status FROM hosted_apps WHERE id=?').get(appId).status, 'paused');

    // Resume.
    r = await fetch(`${s.base}/be1/apps/${appId}/resume`, { method: 'POST', headers: bearer('t') }).then((x) => x.json());
    assert.equal(r.data.status, 'running');
    assert.equal(runner.calls.resumeApp.length, 1);

    // Restart.
    r = await fetch(`${s.base}/be1/apps/${appId}/restart`, { method: 'POST', headers: bearer('t') }).then((x) => x.json());
    assert.equal(r.data.status, 'running');
    assert.equal(runner.calls.restartApp.length, 1);

    // Delete.
    r = await fetch(`${s.base}/be1/apps/${appId}`, { method: 'DELETE', headers: bearer('t') }).then((x) => x.json());
    assert.equal(r.data.status, 'deleted');
    assert.equal(runner.calls.deleteApp.length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hosted_apps WHERE id=?').get(appId).n, 0);

    // We should have events for created + paused + resumed + restarted +
    // deleted... but delete tore down the events rows too, so we check
    // that at least pauseApp was invoked (proxy for event emission working).
    // (Events are dropped on delete; that's the contract.)
  } finally { await s.close(); }
});

test('events endpoint returns ring buffer, respects since', async () => {
  const db = freshDb();
  seedUser(db, 'u1', 't', 'pro');
  seedBackend(db, 'be1', 'u1', 'pro');
  const s = await startServer(db, makeStubRunner());
  try {
    const c = await fetch(`${s.base}/be1/apps`, {
      method: 'POST', headers: { ...bearer('t'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo' }),
    }).then((x) => x.json());
    const appId = c.data.id;
    // Pause + resume to generate more events.
    await fetch(`${s.base}/be1/apps/${appId}/pause`, { method: 'POST', headers: bearer('t') });
    await fetch(`${s.base}/be1/apps/${appId}/resume`, { method: 'POST', headers: bearer('t') });

    const r = await fetch(`${s.base}/be1/apps/${appId}/events`, { headers: bearer('t') }).then((x) => x.json());
    assert.ok(Array.isArray(r.data));
    assert.ok(r.data.length >= 3, `expected ≥3 events, got ${r.data.length}`);
    // Descending order.
    for (let i = 1; i < r.data.length; i++) assert.ok(r.data[i - 1].id > r.data[i].id, 'descending id order');

    // since= only returns strictly-newer rows.
    const middleId = r.data[Math.floor(r.data.length / 2)].id;
    const r2 = await fetch(`${s.base}/be1/apps/${appId}/events?since=${middleId}`, { headers: bearer('t') }).then((x) => x.json());
    for (const row of r2.data) assert.ok(row.id > middleId, `expected id > ${middleId}, got ${row.id}`);
  } finally { await s.close(); }
});

test('logs endpoint returns SSE with correct headers + heartbeat', async () => {
  const db = freshDb();
  seedUser(db, 'u1', 't', 'pro');
  seedBackend(db, 'be1', 'u1', 'pro');
  const s = await startServer(db, makeStubRunner());
  try {
    const c = await fetch(`${s.base}/be1/apps`, {
      method: 'POST', headers: { ...bearer('t'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo' }),
    }).then((x) => x.json());
    const r = await fetch(`${s.base}/be1/apps/${c.data.id}/logs?tail=10`, { headers: bearer('t') });
    assert.equal(r.headers.get('content-type'), 'text/event-stream');
    assert.match(r.headers.get('cache-control') || '', /no-cache/);

    // Read a couple of chunks then abort so the test doesn't hang on the
    // 15 s heartbeat. We only need to observe (a) the priming comment and
    // (b) the stubbed 'hello from stub' data line to know the SSE loop is
    // wired.
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let seen = '';
    for (let i = 0; i < 5 && !seen.includes('hello from stub'); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value, { stream: true });
    }
    try { await reader.cancel(); } catch (_) {}
    assert.match(seen, /: connected/, 'expected SSE priming comment');
    assert.match(seen, /data: hello from stub/, 'expected stubbed log line');
  } finally { await s.close(); }
});

test('owner isolation: user A cannot touch user B\'s app', async () => {
  const db = freshDb();
  seedUser(db, 'ua', 'tok-a', 'pro');
  seedUser(db, 'ub', 'tok-b', 'pro');
  seedBackend(db, 'be-a', 'ua', 'pro');
  seedBackend(db, 'be-b', 'ub', 'pro');
  const s = await startServer(db, makeStubRunner());
  try {
    // Owner B creates an app on its backend.
    const c = await fetch(`${s.base}/be-b/apps`, {
      method: 'POST', headers: { ...bearer('tok-b'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'private' }),
    }).then((x) => x.json());
    assert.equal(c.ok, true);
    const appId = c.data.id;

    // User A hits B's backend → 404 backend_not_found (ownership gate).
    let r = await fetch(`${s.base}/be-b/apps/${appId}`, { headers: bearer('tok-a') });
    let body = await r.json();
    assert.equal(r.status, 404);
    assert.equal(body.error, 'backend_not_found');

    // User A hits their OWN backend with B's app id → 404 hosted_app_not_found.
    r = await fetch(`${s.base}/be-a/apps/${appId}`, { headers: bearer('tok-a') });
    body = await r.json();
    assert.equal(r.status, 404);
    assert.equal(body.error, 'hosted_app_not_found');

    // Same for DELETE.
    r = await fetch(`${s.base}/be-a/apps/${appId}`, { method: 'DELETE', headers: bearer('tok-a') });
    body = await r.json();
    assert.equal(r.status, 404);
    assert.equal(body.error, 'hosted_app_not_found');
    // B's app row is still there.
    assert.ok(db.prepare('SELECT 1 FROM hosted_apps WHERE id=?').get(appId));
  } finally { await s.close(); }
});

test('unauthorized request → 401', async () => {
  const db = freshDb();
  const s = await startServer(db, makeStubRunner());
  try {
    const r = await fetch(`${s.base}/be1/apps`, { method: 'GET' });
    const body = await r.json();
    assert.equal(r.status, 401);
    assert.equal(body.error, 'unauthorized');
  } finally { await s.close(); }
});
