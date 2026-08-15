'use strict';

// Test suite for cloud-hosted-app-caddy.js. Spins up a real http.createServer
// as a stand-in Caddy admin API, records every request (method/path/body), and
// returns fixture responses per test. Zero external deps — node:test + assert
// only. Run with:  node --test cloud-hosted-app-caddy.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createCaddyClient } = require('../cloud-hosted-app-caddy');

// Boot a mock admin server. `handler(req, body) -> { status, body }` gets
// invoked per request; we also push every request into `recorded` so tests
// can assert on the exact wire shape sent by the client.
function startMock(handler) {
  const recorded = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      recorded.push({ method: req.method, url: req.url, headers: req.headers, body });
      let out;
      try { out = handler(req, body) || { status: 200, body: '' }; }
      catch (e) { out = { status: 500, body: String(e && e.message || e) }; }
      res.statusCode = out.status;
      if (out.headers) for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
      res.end(out.body == null ? '' : out.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        recorded,
        adminUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('upsertRoute writes exactly the spec payload shape', async () => {
  const mock = await startMock(() => ({ status: 200, body: '' }));
  try {
    const client = createCaddyClient({ adminUrl: mock.adminUrl, wildcardZone: 'apps.lingcode.dev' });
    await client.upsertRoute({ subdomain: 'demo', port: 5001 });

    assert.equal(mock.recorded.length, 1);
    const [req] = mock.recorded;
    assert.equal(req.method, 'PUT');
    assert.equal(req.url, '/id/hosted-app-demo');
    assert.match(req.headers['content-type'] || '', /application\/json/);

    const payload = JSON.parse(req.body);
    assert.deepEqual(payload, {
      '@id': 'hosted-app-demo',
      match: [{ host: ['demo.apps.lingcode.dev'] }],
      handle: [{
        handler: 'reverse_proxy',
        upstreams: [{ dial: '127.0.0.1:5001' }],
      }],
    });
  } finally { await mock.close(); }
});

test('upsertRoute is idempotent — two calls both PUT the same @id path', async () => {
  const mock = await startMock(() => ({ status: 200, body: '' }));
  try {
    const client = createCaddyClient({ adminUrl: mock.adminUrl });
    await client.upsertRoute({ subdomain: 'demo', port: 5001 });
    await client.upsertRoute({ subdomain: 'demo', port: 5001 });

    assert.equal(mock.recorded.length, 2);
    for (const r of mock.recorded) {
      assert.equal(r.method, 'PUT');
      assert.equal(r.url, '/id/hosted-app-demo');
    }
  } finally { await mock.close(); }
});

test('deleteRoute sends DELETE /id/hosted-app-<sub>', async () => {
  const mock = await startMock(() => ({ status: 200, body: '' }));
  try {
    const client = createCaddyClient({ adminUrl: mock.adminUrl });
    await client.deleteRoute({ subdomain: 'demo' });
    assert.equal(mock.recorded.length, 1);
    assert.equal(mock.recorded[0].method, 'DELETE');
    assert.equal(mock.recorded[0].url, '/id/hosted-app-demo');
  } finally { await mock.close(); }
});

test('deleteRoute treats 404 as success (already gone)', async () => {
  const mock = await startMock(() => ({ status: 404, body: '{"error":"not found"}' }));
  try {
    const client = createCaddyClient({ adminUrl: mock.adminUrl });
    const res = await client.deleteRoute({ subdomain: 'ghost' });
    assert.equal(res.ok, true);
    assert.equal(res.alreadyGone, true);
  } finally { await mock.close(); }
});

test('deleteRoute surfaces 5xx as error with status+body', async () => {
  const mock = await startMock(() => ({ status: 500, body: '{"error":"boom"}' }));
  try {
    const client = createCaddyClient({ adminUrl: mock.adminUrl });
    await assert.rejects(
      () => client.deleteRoute({ subdomain: 'demo' }),
      (e) => e.status === 500 && /boom/.test(e.body),
    );
  } finally { await mock.close(); }
});

test('listRoutes filters to @id prefix hosted-app-', async () => {
  const routes = [
    { '@id': 'hosted-app-alpha', match: [{ host: ['alpha.apps.lingcode.dev'] }] },
    { '@id': 'hosted-app-beta',  match: [{ host: ['beta.apps.lingcode.dev'] }] },
    { '@id': 'website-root',     match: [{ host: ['lingcode.dev'] }] },
    { match: [{ host: ['no-id.example'] }] },
    null,
  ];
  const mock = await startMock((req) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/config/apps/http/servers/srv0/routes');
    return { status: 200, body: JSON.stringify(routes), headers: { 'Content-Type': 'application/json' } };
  });
  try {
    const client = createCaddyClient({ adminUrl: mock.adminUrl });
    const got = await client.listRoutes();
    assert.equal(got.length, 2);
    assert.deepEqual(got.map((r) => r['@id']), ['hosted-app-alpha', 'hosted-app-beta']);
  } finally { await mock.close(); }
});

test('listRoutes tolerates empty/null config bodies', async () => {
  const mock = await startMock(() => ({ status: 200, body: 'null' }));
  try {
    const client = createCaddyClient({ adminUrl: mock.adminUrl });
    const got = await client.listRoutes();
    assert.deepEqual(got, []);
  } finally { await mock.close(); }
});

test('health() returns true on 200', async () => {
  const mock = await startMock((req) => {
    assert.equal(req.url, '/config/');
    return { status: 200, body: '{}' };
  });
  try {
    const client = createCaddyClient({ adminUrl: mock.adminUrl });
    assert.equal(await client.health(), true);
  } finally { await mock.close(); }
});

test('health() returns false when admin API is unreachable (ECONNREFUSED)', async () => {
  // Bind a port, immediately close it, then point the client at that dead port.
  const tmp = await startMock(() => ({ status: 200, body: '' }));
  const deadUrl = tmp.adminUrl;
  await tmp.close();
  const client = createCaddyClient({ adminUrl: deadUrl });
  assert.equal(await client.health(), false);
});

test('upsertRoute rejects invalid subdomains', async () => {
  const client = createCaddyClient({ adminUrl: 'http://127.0.0.1:1' });
  const bad = ['BadSub', '-lead', '', 'a'.repeat(80), '1leading-digit', 'has_underscore', 'has.dot'];
  for (const s of bad) {
    await assert.rejects(
      () => client.upsertRoute({ subdomain: s, port: 5001 }),
      (e) => e.code === 'invalid_subdomain',
      `expected invalid_subdomain for ${JSON.stringify(s)}`,
    );
  }
});

test('upsertRoute rejects invalid ports', async () => {
  const client = createCaddyClient({ adminUrl: 'http://127.0.0.1:1' });
  const bad = [80, 1023, 65536, -1, 0, 1.5, '5001', null, undefined, NaN];
  for (const p of bad) {
    await assert.rejects(
      () => client.upsertRoute({ subdomain: 'demo', port: p }),
      (e) => e.code === 'invalid_port',
      `expected invalid_port for ${p}`,
    );
  }
});

test('upsertRoute surfaces non-2xx (400) with status+body', async () => {
  const mock = await startMock(() => ({ status: 400, body: '{"error":"bad config"}' }));
  try {
    const client = createCaddyClient({ adminUrl: mock.adminUrl });
    await assert.rejects(
      () => client.upsertRoute({ subdomain: 'demo', port: 5001 }),
      (e) => e.status === 400 && /bad config/.test(e.body),
    );
  } finally { await mock.close(); }
});

test('upsertRoute surfaces non-2xx (500) with status+body', async () => {
  const mock = await startMock(() => ({ status: 500, body: 'internal explosion' }));
  try {
    const client = createCaddyClient({ adminUrl: mock.adminUrl });
    await assert.rejects(
      () => client.upsertRoute({ subdomain: 'demo', port: 5001 }),
      (e) => e.status === 500 && /explosion/.test(e.body),
    );
  } finally { await mock.close(); }
});

test('network failure tags error with caddy_admin_unreachable', async () => {
  const tmp = await startMock(() => ({ status: 200, body: '' }));
  const deadUrl = tmp.adminUrl;
  await tmp.close();
  const client = createCaddyClient({ adminUrl: deadUrl });
  await assert.rejects(
    () => client.upsertRoute({ subdomain: 'demo', port: 5001 }),
    (e) => e.code === 'caddy_admin_unreachable',
  );
});

test('createCaddyClient — two independent clients keep separate opts (no globals)', async () => {
  const mockA = await startMock(() => ({ status: 200, body: '' }));
  const mockB = await startMock(() => ({ status: 200, body: '' }));
  try {
    const a = createCaddyClient({ adminUrl: mockA.adminUrl, wildcardZone: 'apps.staging.dev' });
    const b = createCaddyClient({ adminUrl: mockB.adminUrl, wildcardZone: 'apps.lingcode.dev' });
    await a.upsertRoute({ subdomain: 'x', port: 4000 });
    await b.upsertRoute({ subdomain: 'x', port: 4000 });

    assert.equal(mockA.recorded.length, 1);
    assert.equal(mockB.recorded.length, 1);
    assert.match(mockA.recorded[0].body, /x\.apps\.staging\.dev/);
    assert.match(mockB.recorded[0].body, /x\.apps\.lingcode\.dev/);
  } finally {
    await mockA.close();
    await mockB.close();
  }
});

// ── mode: 'passthrough' — no-op client for external-routing topology ────────
//
// Used on droplets where Caddy is NOT co-located and routing is handled by an
// external edge (nginx + cloud-hosted-app-proxy.js dispatches by Host header
// to 127.0.0.1:<port>). Every method must succeed without making any HTTP
// call — otherwise the runner aborts every deploy with `caddy_upsert_failed`
// at cloud-hosted-app-runner.js:416.

test('passthrough: upsertRoute succeeds without hitting any admin API', async () => {
  const client = createCaddyClient({ mode: 'passthrough' });
  const r = await client.upsertRoute({ subdomain: 'demo', port: 5001 });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'hosted-app-demo');
  assert.equal(r.mode, 'passthrough');
});

test('passthrough: deleteRoute succeeds', async () => {
  const client = createCaddyClient({ mode: 'passthrough' });
  const r = await client.deleteRoute({ subdomain: 'demo' });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'passthrough');
});

test('passthrough: listRoutes returns empty array', async () => {
  const client = createCaddyClient({ mode: 'passthrough' });
  const r = await client.listRoutes();
  assert.deepEqual(r, []);
});

test('passthrough: health returns true even with no Caddy running', async () => {
  const client = createCaddyClient({ mode: 'passthrough' });
  assert.equal(await client.health(), true);
});

test('passthrough: still validates inputs (bad subdomain/port reject with the same codes)', async () => {
  // Keep validation on to match the real client's shape — regressions from
  // callers passing garbage should still surface cleanly.
  const client = createCaddyClient({ mode: 'passthrough' });
  await assert.rejects(
    () => client.upsertRoute({ subdomain: 'INVALID_CAPS', port: 5001 }),
    (e) => e.code === 'invalid_subdomain',
  );
  await assert.rejects(
    () => client.upsertRoute({ subdomain: 'ok', port: 42 }),
    (e) => e.code === 'invalid_port',
  );
});

test('passthrough: never opens a socket (proven by ignoring an unreachable adminUrl)', async () => {
  // If passthrough silently fell back to admin-api behavior this would fail
  // with caddy_admin_unreachable (port 1 is guaranteed-closed on Linux).
  const client = createCaddyClient({
    mode: 'passthrough',
    adminUrl: 'http://127.0.0.1:1',
  });
  const r = await client.upsertRoute({ subdomain: 'demo', port: 5001 });
  assert.equal(r.ok, true);
});

test('default mode remains "admin-api" (backward compat)', async () => {
  // A client with no `mode` opt must still behave like the original admin-API
  // client — proven by observing it TRIES to hit the URL and fails.
  const client = createCaddyClient({ adminUrl: 'http://127.0.0.1:1' });
  await assert.rejects(
    () => client.upsertRoute({ subdomain: 'demo', port: 5001 }),
    (e) => e.code === 'caddy_admin_unreachable',
  );
});

test('unknown mode throws with invalid_mode code (typo protection)', () => {
  assert.throws(
    () => createCaddyClient({ mode: 'passthough' }), // note typo
    (e) => e.code === 'invalid_mode',
  );
});
