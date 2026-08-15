'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const express = require('express');
const { migrateVoucherTables } = require('../migrate');
const {
  prepareVoucherBatch,
  insertPreparedBatch,
  reserveVoucher,
  bindCheckoutSession,
} = require('../vouchers');
const { registerVoucherRoutes } = require('../voucher-routes');

const NOW = 1_786_291_200_000;
const SECRET = 'voucher-secret-material-that-is-long-enough';
const ORIGIN = 'https://lingcode.dev';

function fixtureDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL DEFAULT 'free',
      email_verified INTEGER NOT NULL DEFAULT 1,
      subscription_status TEXT,
      stripe_customer_id TEXT
    );
    INSERT INTO users VALUES
      ('admin-1', 'admin@example.com', 'free', 1, NULL, NULL),
      ('user-1', 'one@example.com', 'free', 1, NULL, NULL);
  `);
  migrateVoucherTables(db);
  return db;
}

async function createFixture(options = {}) {
  const db = fixtureDb();
  let checkoutStatus = options.checkoutStatus || 'expired';
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (id) => ({ id, status: checkoutStatus }),
      },
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = req.get('x-admin') === '1' ? { admin: true } : {};
    next();
  });
  function requireAdmin(req, res, next) {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    next();
  }
  registerVoucherRoutes(app, {
    db,
    stripe,
    publicOrigin: ORIGIN,
    proMonthlyPriceId: 'price_pro_monthly',
    enabled: options.enabled !== false,
    hmacSecret: SECRET,
    requireAdmin,
    now: () => NOW,
    logger: { error() {} },
    createArtifact: options.createArtifact || (async () => Buffer.from('synthetic-zip')),
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(pathname, init = {}) {
    const headers = { ...(init.headers || {}) };
    if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
    return fetch(`${base}${pathname}`, { ...init, headers });
  }
  return {
    db,
    request,
    setCheckoutStatus(value) { checkoutStatus = value; },
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

function adminHeaders(overrides = {}) {
  return { 'x-admin': '1', origin: ORIGIN, ...overrides };
}

function createBody(overrides = {}) {
  return {
    name: 'LingCode Pro Promotion 2026',
    quantity: 500,
    benefitDays: 30,
    redeemBy: NOW + 365 * 24 * 60 * 60 * 1000,
    confirmation: 'CREATE 500 VOUCHERS',
    ...overrides,
  };
}

test('admin voucher routes reject signed-out and cross-origin mutations', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const signedOut = await fixture.request('/api/admin/vouchers/batches');
  assert.equal(signedOut.status, 401);
  const crossOrigin = await fixture.request('/api/admin/vouchers/batches', {
    method: 'POST',
    headers: adminHeaders({ origin: 'https://attacker.example' }),
    body: JSON.stringify(createBody()),
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM voucher_batches').get().count, 0);
});

test('batch creation inserts exactly 500 digest-only vouchers and returns a one-time ZIP', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const response = await fixture.request('/api/admin/vouchers/batches', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(createBody()),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('cache-control'), 'no-store, private');
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="LingCode-Pro-Vouchers-/);
  assert.equal(await response.text(), 'synthetic-zip');
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM promotion_vouchers').get().count, 500);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM voucher_audit_events WHERE event_type = 'batch_created'").get().count, 1);
  const stored = JSON.stringify(fixture.db.prepare('SELECT * FROM promotion_vouchers').all());
  assert.equal(stored.includes('LC-PRO-'), false);

  const detail = await fixture.request('/api/admin/vouchers/batches/' + fixture.db.prepare('SELECT id FROM voucher_batches').get().id, {
    headers: adminHeaders(),
  });
  const detailText = await detail.text();
  assert.equal(detail.status, 200);
  assert.equal(detailText.includes('LC-PRO-'), false);
  assert.equal(detailText.includes('code_digest'), false);

  const redownload = await fixture.request('/api/admin/vouchers/batches/' + fixture.db.prepare('SELECT id FROM voucher_batches').get().id + '/download', {
    headers: adminHeaders(),
  });
  assert.equal(redownload.status, 404);
});

test('disabled issuance still allows redacted listing and revocation', async (t) => {
  const fixture = await createFixture({ enabled: false });
  t.after(fixture.close);
  const prepared = prepareVoucherBatch({
    name: 'Existing campaign', quantity: 2, benefitDays: 30, redeemBy: NOW + 100_000,
  }, { secret: SECRET, now: NOW });
  insertPreparedBatch(fixture.db, prepared);

  const create = await fixture.request('/api/admin/vouchers/batches', {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify(createBody()),
  });
  assert.equal(create.status, 503);
  const list = await fixture.request('/api/admin/vouchers/batches', { headers: adminHeaders() });
  assert.equal(list.status, 200);
  const payload = await list.json();
  assert.equal(payload.batches[0].counts.available, 2);
  assert.equal(JSON.stringify(payload).includes('LC-PRO-'), false);

  const revoke = await fixture.request(`/api/admin/vouchers/${prepared.storedRows[0].id}/revoke`, {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ confirmation: 'REVOKE VOUCHER' }),
  });
  assert.equal(revoke.status, 200);
  const replay = await fixture.request(`/api/admin/vouchers/${prepared.storedRows[0].id}/revoke`, {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ confirmation: 'REVOKE VOUCHER' }),
  });
  assert.equal(replay.status, 200);
  assert.equal(fixture.db.prepare('SELECT status FROM promotion_vouchers WHERE id = ?').get(prepared.storedRows[0].id).status, 'revoked');
});

test('batch revocation changes only available vouchers and records aggregate state', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const prepared = prepareVoucherBatch({
    name: 'Revoke campaign', quantity: 2, benefitDays: 30, redeemBy: NOW + 100_000,
  }, { secret: SECRET, now: NOW });
  insertPreparedBatch(fixture.db, prepared);
  const user = fixture.db.prepare('SELECT * FROM users WHERE id = ?').get('user-1');
  reserveVoucher(fixture.db, { code: prepared.codes[0].code, user }, { secret: SECRET, now: NOW });

  const response = await fixture.request(`/api/admin/vouchers/batches/${prepared.batch.id}/revoke`, {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ confirmation: 'REVOKE BATCH' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, revoked: 1 });
  const statuses = fixture.db.prepare('SELECT status FROM promotion_vouchers ORDER BY serial_number').all().map((row) => row.status);
  assert.deepEqual(statuses, ['reserved', 'revoked']);
});

test('manual release requires Stripe to confirm the bound Session is expired', async (t) => {
  const fixture = await createFixture({ checkoutStatus: 'open' });
  t.after(fixture.close);
  const prepared = prepareVoucherBatch({
    name: 'Release campaign', quantity: 1, benefitDays: 30, redeemBy: NOW + 100_000,
  }, { secret: SECRET, now: NOW });
  insertPreparedBatch(fixture.db, prepared);
  const user = fixture.db.prepare('SELECT * FROM users WHERE id = ?').get('user-1');
  const held = reserveVoucher(fixture.db, { code: prepared.codes[0].code, user }, { secret: SECRET, now: NOW });
  bindCheckoutSession(fixture.db, { voucherId: held.voucher.id, userId: user.id, checkoutSessionId: 'cs_release' });

  const open = await fixture.request(`/api/admin/vouchers/${held.voucher.id}/release`, {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ confirmation: 'RELEASE RESERVATION' }),
  });
  assert.equal(open.status, 409);
  assert.equal(fixture.db.prepare('SELECT status FROM promotion_vouchers WHERE id = ?').get(held.voucher.id).status, 'reserved');
  fixture.setCheckoutStatus('expired');
  const expired = await fixture.request(`/api/admin/vouchers/${held.voucher.id}/release`, {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ confirmation: 'RELEASE RESERVATION' }),
  });
  assert.equal(expired.status, 200);
  assert.equal(fixture.db.prepare('SELECT status FROM promotion_vouchers WHERE id = ?').get(held.voucher.id).status, 'available');
});

test('invalid batch inputs and missing one-time confirmation create no rows', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  for (const body of [
    createBody({ quantity: 501, confirmation: 'CREATE 501 VOUCHERS' }),
    createBody({ benefitDays: 7 }),
    createBody({ redeemBy: NOW }),
    createBody({ confirmation: '' }),
  ]) {
    const response = await fixture.request('/api/admin/vouchers/batches', {
      method: 'POST', headers: adminHeaders(), body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM voucher_batches').get().count, 0);
});
