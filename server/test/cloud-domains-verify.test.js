'use strict';

// Tests for the /api/cloud/domains/verify ask endpoint that gates on-demand
// TLS issuance on the custom-domain-edge droplet's Caddy. Two paths:
//   (1) Customer-owned custom domains (custom_domains status='active')
//   (2) LingCode-owned hosted-app subdomains (<slug>.apps.lingcode.dev where
//       <slug> matches hosted_apps.subdomain with status != 'deleted')
//
// Path (2) is the new behavior — added when the Python app-hosting tier's
// TLS ingress was wired to reuse the existing edge droplet's Caddy instead
// of spinning up a second Caddy that would conflict with nginx on :443.
//
// Also unit-tests the extractHostedAppSubdomain helper directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

const {
  registerCustomDomainRoutes,
  extractHostedAppSubdomain,
} = require('../cloud-domains');

function buildDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE custom_domains (
      domain TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE hosted_apps (
      id        TEXT PRIMARY KEY,
      subdomain TEXT NOT NULL UNIQUE,
      status    TEXT NOT NULL
    );
  `);
  return db;
}

async function buildServer(db) {
  const app = express();
  registerCustomDomainRoutes(app, db);
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function verify(url, domain) {
  const res = await fetch(`${url}/api/cloud/domains/verify?domain=${encodeURIComponent(domain)}`);
  return { status: res.status, body: (await res.text()).trim() };
}

// ── extractHostedAppSubdomain unit tests ────────────────────────────────

test('extractHostedAppSubdomain: happy path', () => {
  assert.equal(
    extractHostedAppSubdomain('alpha.apps.lingcode.dev', 'apps.lingcode.dev'),
    'alpha'
  );
});

test('extractHostedAppSubdomain: rejects the bare zone itself', () => {
  assert.equal(
    extractHostedAppSubdomain('apps.lingcode.dev', 'apps.lingcode.dev'),
    null
  );
});

test('extractHostedAppSubdomain: rejects nested subdomain (foo.bar.apps.lingcode.dev)', () => {
  assert.equal(
    extractHostedAppSubdomain('foo.bar.apps.lingcode.dev', 'apps.lingcode.dev'),
    null
  );
});

test('extractHostedAppSubdomain: rejects hostnames outside the zone', () => {
  assert.equal(
    extractHostedAppSubdomain('alpha.other.example.com', 'apps.lingcode.dev'),
    null
  );
  // Suffix-match-only guard: `notapps.lingcode.dev` must NOT accidentally
  // match `apps.lingcode.dev` because it ends with the same bytes.
  assert.equal(
    extractHostedAppSubdomain('alpha.notapps.lingcode.dev', 'apps.lingcode.dev'),
    null
  );
});

test('extractHostedAppSubdomain: rejects illegal characters', () => {
  assert.equal(extractHostedAppSubdomain('AL_PHA.apps.lingcode.dev', 'apps.lingcode.dev'), null);
  assert.equal(extractHostedAppSubdomain('-leading.apps.lingcode.dev', 'apps.lingcode.dev'), null);
  assert.equal(extractHostedAppSubdomain('trailing-.apps.lingcode.dev', 'apps.lingcode.dev'), null);
});

test('extractHostedAppSubdomain: null/empty guards', () => {
  assert.equal(extractHostedAppSubdomain('', 'apps.lingcode.dev'), null);
  assert.equal(extractHostedAppSubdomain(null, 'apps.lingcode.dev'), null);
  assert.equal(extractHostedAppSubdomain('alpha.apps.lingcode.dev', ''), null);
});

// ── HTTP endpoint tests ────────────────────────────────────────────────

test('verify: 403 on empty/missing domain', async () => {
  const db = buildDb();
  const s = await buildServer(db);
  try {
    assert.equal((await verify(s.url, '')).status, 403);
    const res = await fetch(`${s.url}/api/cloud/domains/verify`);
    assert.equal(res.status, 403);
  } finally { await s.close(); db.close(); }
});

test('verify: approves active custom domain (path 1, unchanged behavior)', async () => {
  const db = buildDb();
  db.prepare("INSERT INTO custom_domains VALUES ('myapp.com', 'active')").run();
  db.prepare("INSERT INTO custom_domains VALUES ('pending.com', 'pending')").run();
  const s = await buildServer(db);
  try {
    assert.deepEqual(await verify(s.url, 'myapp.com'), { status: 200, body: 'ok' });
    assert.deepEqual(await verify(s.url, 'pending.com'), { status: 403, body: 'not registered' });
    assert.deepEqual(await verify(s.url, 'unregistered.com'), { status: 403, body: 'not registered' });
  } finally { await s.close(); db.close(); }
});

test('verify: approves running hosted-app subdomain (path 2, new behavior)', async () => {
  const db = buildDb();
  db.prepare("INSERT INTO hosted_apps VALUES ('id-1', 'alpha', 'running')").run();
  const s = await buildServer(db);
  try {
    assert.deepEqual(await verify(s.url, 'alpha.apps.lingcode.dev'), { status: 200, body: 'ok' });
  } finally { await s.close(); db.close(); }
});

test('verify: approves all non-deleted hosted-app statuses', async () => {
  // building/running/paused/crashed should all get a cert so Caddy can serve
  // the placeholder handler ("this app is paused") instead of a TLS error.
  const db = buildDb();
  const rows = [
    ['id-b', 'buildingapp', 'building'],
    ['id-r', 'runningapp',  'running'],
    ['id-p', 'pausedapp',   'paused'],
    ['id-c', 'crashedapp',  'crashed'],
  ];
  const ins = db.prepare('INSERT INTO hosted_apps VALUES (?,?,?)');
  for (const r of rows) ins.run(...r);
  const s = await buildServer(db);
  try {
    for (const [, slug] of rows) {
      const res = await verify(s.url, `${slug}.apps.lingcode.dev`);
      assert.deepEqual(res, { status: 200, body: 'ok' }, `slug=${slug}`);
    }
  } finally { await s.close(); db.close(); }
});

test("verify: denies deleted hosted-app subdomain (anti-phishing)", async () => {
  // Deleted rows must NOT approve — otherwise a freed-up subdomain can have
  // its cert reissued and reused for phishing while wildcard DNS still
  // resolves to us.
  const db = buildDb();
  db.prepare("INSERT INTO hosted_apps VALUES ('id-x', 'gone', 'deleted')").run();
  const s = await buildServer(db);
  try {
    assert.deepEqual(await verify(s.url, 'gone.apps.lingcode.dev'), { status: 403, body: 'not registered' });
  } finally { await s.close(); db.close(); }
});

test('verify: denies unknown hosted-app subdomain', async () => {
  const db = buildDb();
  const s = await buildServer(db);
  try {
    assert.deepEqual(
      await verify(s.url, 'never-registered.apps.lingcode.dev'),
      { status: 403, body: 'not registered' }
    );
  } finally { await s.close(); db.close(); }
});

test('verify: denies nested subdomain even when the label matches', async () => {
  // `foo.alpha.apps.lingcode.dev` must NOT approve even though `alpha` is a
  // live hosted app. We only mint certs for the exact one-label form.
  const db = buildDb();
  db.prepare("INSERT INTO hosted_apps VALUES ('id-1', 'alpha', 'running')").run();
  const s = await buildServer(db);
  try {
    assert.deepEqual(
      await verify(s.url, 'foo.alpha.apps.lingcode.dev'),
      { status: 403, body: 'not registered' }
    );
  } finally { await s.close(); db.close(); }
});

test('verify: lowercases the incoming domain', async () => {
  // Caddy already normalizes SNI to lowercase before sending; belt+braces here.
  const db = buildDb();
  db.prepare("INSERT INTO hosted_apps VALUES ('id-1', 'alpha', 'running')").run();
  db.prepare("INSERT INTO custom_domains VALUES ('myapp.com', 'active')").run();
  const s = await buildServer(db);
  try {
    assert.equal((await verify(s.url, 'ALPHA.apps.lingcode.dev')).status, 200);
    assert.equal((await verify(s.url, 'MyApp.com')).status, 200);
  } finally { await s.close(); db.close(); }
});
