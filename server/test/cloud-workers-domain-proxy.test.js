'use strict';

// Tests for installWorkerDomainProxy — the EARLY reverse-proxy that maps a
// customer custom domain to a hosted Worker's run.lingcode.dev origin. This is
// a global middleware on the apex request path, so the passthrough cases (apex
// + unknown host must call next() and never proxy) matter as much as the proxy.

const test = require('node:test');
const assert = require('node:assert');
const https = require('https');
const Database = require('better-sqlite3');
const { installWorkerDomainProxy } = require('../cloud-domains');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE custom_domains (domain TEXT PRIMARY KEY, prototype_id TEXT,
           app_id TEXT, worker_id TEXT, user_id TEXT, status TEXT, created_at TEXT)`);
  db.prepare("INSERT INTO custom_domains (domain, prototype_id, worker_id, status) VALUES (?, '', ?, 'active')")
    .run('api.customer.com', 'app-xyz123');
  // an app/prototype domain (worker_id NULL) must NOT be proxied here
  db.prepare("INSERT INTO custom_domains (domain, prototype_id, app_id, status) VALUES (?, '', ?, 'active')")
    .run('site.customer.com', 'cool-app');
  return db;
}

function getMiddleware(db) {
  let mw;
  installWorkerDomainProxy({ use: (fn) => { mw = fn; } }, db);
  return mw;
}

const fakeReq = (host) => ({ headers: { host }, url: '/v1/billing?x=1', method: 'POST', _piped: null, pipe(t) { this._piped = t; return t; } });
const fakeRes = () => ({ statusCode: 200, headersSent: false, writeHead() {}, end() { this.ended = true; } });

test('apex/site traffic passes through (never proxied, no DB-driven proxy)', () => {
  const mw = getMiddleware(makeDb());
  for (const host of ['lingcode.dev', 'app.lingcode.dev', 'localhost']) {
    let nexted = false;
    mw(fakeReq(host), fakeRes(), () => { nexted = true; });
    assert.equal(nexted, true, `${host} should pass through`);
  }
});

test('an unknown / non-worker custom host passes through', () => {
  const mw = getMiddleware(makeDb());
  for (const host of ['nope.example.com', 'site.customer.com' /* app domain, not worker */]) {
    let nexted = false;
    mw(fakeReq(host), fakeRes(), () => { nexted = true; });
    assert.equal(nexted, true, `${host} should pass through`);
  }
});

test('a worker custom domain reverse-proxies to its run.lingcode.dev origin (Host rewritten)', () => {
  const mw = getMiddleware(makeDb());
  const orig = https.request;
  let captured = null;
  https.request = (target, opts) => { captured = { target, opts }; return { on() { return this; } }; };
  try {
    const req = fakeReq('api.customer.com');
    let nexted = false;
    mw(req, fakeRes(), () => { nexted = true; });
    assert.equal(nexted, false, 'must terminate, not fall through to the apex app');
    assert.ok(captured, 'https.request was called');
    assert.equal(captured.target.host, 'app-xyz123.run.lingcode.dev');
    assert.equal(captured.target.pathname + captured.target.search, '/v1/billing?x=1');
    assert.equal(captured.opts.method, 'POST');
    assert.equal(captured.opts.headers.host, 'app-xyz123.run.lingcode.dev', 'Host header rewritten for dispatch routing');
    assert.ok(req._piped, 'raw request body piped to the upstream worker');
  } finally { https.request = orig; }
});
