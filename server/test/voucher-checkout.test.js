'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const express = require('express');
const { migrateVoucherTables } = require('../migrate');
const { prepareVoucherBatch, insertPreparedBatch } = require('../vouchers');
const { createVoucherLimiter } = require('../voucher-rate-limit');
const { registerVoucherRoutes, voucherConfigFromEnv } = require('../voucher-routes');

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
      ('user-1', 'one@example.com', 'free', 1, NULL, 'cus_existing'),
      ('user-2', 'two@example.com', 'free', 1, NULL, NULL),
      ('paid-1', 'paid@example.com', 'pro', 1, 'active', 'cus_paid'),
      ('unverified-1', 'wait@example.com', 'free', 0, NULL, NULL);
  `);
  migrateVoucherTables(db);
  return db;
}

async function createFixture(options = {}) {
  const db = fixtureDb();
  const prepared = prepareVoucherBatch({
    name: 'Test promotion',
    quantity: options.quantity || 2,
    benefitDays: 30,
    redeemBy: NOW + 365 * 24 * 60 * 60 * 1000,
    createdBy: null,
  }, { secret: SECRET, now: NOW });
  insertPreparedBatch(db, prepared);

  const calls = { create: [], expire: [] };
  const stripe = options.stripe === null ? null : {
    checkout: {
      sessions: {
        create: async (params) => {
          calls.create.push(params);
          if (options.createError) throw new Error('stripe unavailable');
          return { id: options.sessionId || 'cs_test', url: 'https://checkout.stripe.test/session', status: 'open' };
        },
        expire: async (id) => {
          calls.expire.push(id);
          return { id, status: 'expired' };
        },
      },
    },
  };
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.get('x-test-user');
    req.session = userId ? { account: { userId } } : {};
    next();
  });
  registerVoucherRoutes(app, {
    db,
    stripe,
    publicOrigin: ORIGIN,
    proMonthlyPriceId: options.priceId === undefined ? 'price_pro_monthly' : options.priceId,
    enabled: options.enabled !== false,
    hmacSecret: options.hmacSecret === undefined ? SECRET : options.hmacSecret,
    limiter: options.limiter || createVoucherLimiter(),
    now: () => NOW,
    logger: { error() {} },
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(pathname, init = {}) {
    return fetch(`${base}${pathname}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    });
  }
  return {
    db, prepared, calls, request,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

test('voucher config enables only an exact, complete environment', () => {
  assert.deepEqual(voucherConfigFromEnv({ VOUCHERS_ENABLED: '0' }), { enabled: false });
  assert.deepEqual(voucherConfigFromEnv({
    VOUCHERS_ENABLED: '1',
    LINGCODE_VOUCHER_HMAC_SECRET: SECRET,
    STRIPE_PRICE_PRO_MONTHLY: ' price_123 ',
  }), {
    enabled: true,
    hmacSecret: SECRET,
    proMonthlyPriceId: 'price_123',
  });
  assert.deepEqual(voucherConfigFromEnv({
    VOUCHERS_ENABLED: '1',
    LINGCODE_VOUCHER_HMAC_SECRET: '',
    STRIPE_PRICE_PRO_MONTHLY: 'price_123',
  }), { enabled: false });
});

test('Checkout reserves the code and creates an exact card-required trial subscription', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const response = await fixture.request('/api/vouchers/checkout', {
    method: 'POST',
    headers: { 'x-test-user': 'user-1' },
    body: JSON.stringify({ code: fixture.prepared.codes[0].code, renewalAcknowledged: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, private');
  assert.deepEqual(await response.json(), { ok: true, url: 'https://checkout.stripe.test/session' });
  assert.deepEqual(fixture.calls.create, [{
    mode: 'subscription',
    line_items: [{ price: 'price_pro_monthly', quantity: 1 }],
    payment_method_collection: 'always',
    success_url: `${ORIGIN}/redeem/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${ORIGIN}/redeem/?canceled=1`,
    client_reference_id: 'user-1',
    expires_at: Math.floor((NOW + 30 * 60 * 1000) / 1000),
    customer: 'cus_existing',
    metadata: {
      flow: 'promotion_voucher',
      voucher_id: fixture.prepared.storedRows[0].id,
      batch_id: fixture.prepared.batch.id,
      user_id: 'user-1',
    },
    subscription_data: {
      trial_period_days: 30,
      metadata: {
        flow: 'promotion_voucher',
        voucher_id: fixture.prepared.storedRows[0].id,
        batch_id: fixture.prepared.batch.id,
        user_id: 'user-1',
      },
    },
  }]);
  const stored = fixture.db.prepare('SELECT status, reserved_by, checkout_session_id FROM promotion_vouchers WHERE id = ?')
    .get(fixture.prepared.storedRows[0].id);
  assert.deepEqual(stored, { status: 'reserved', reserved_by: 'user-1', checkout_session_id: 'cs_test' });
  const reservedAudit = fixture.db.prepare("SELECT metadata_json FROM voucher_audit_events WHERE event_type = 'reserved'").get();
  assert.deepEqual(JSON.parse(reservedAudit.metadata_json), {
    reserved_until: NOW + 30 * 60 * 1000,
    terms_version: 'voucher-terms-2026-08-09',
    terms_accepted_at: NOW,
  });
  assert.equal(JSON.stringify(fixture.calls).includes(fixture.prepared.codes[0].code), false);
});

test('Checkout uses customer email only when no Stripe customer exists', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const response = await fixture.request('/api/vouchers/checkout', {
    method: 'POST',
    headers: { 'x-test-user': 'user-2' },
    body: JSON.stringify({ code: fixture.prepared.codes[0].code, renewalAcknowledged: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(fixture.calls.create[0].customer_email, 'two@example.com');
  assert.equal(Object.hasOwn(fixture.calls.create[0], 'customer'), false);
});

test('Checkout rejects disabled, signed-out, unverified, paid, and unacknowledged requests', async (t) => {
  const disabled = await createFixture({ enabled: false });
  const enabled = await createFixture();
  t.after(disabled.close);
  t.after(enabled.close);
  const code = enabled.prepared.codes[0].code;
  const cases = [
    [disabled, null, { code: disabled.prepared.codes[0].code, renewalAcknowledged: true }, 503],
    [enabled, null, { code, renewalAcknowledged: true }, 401],
    [enabled, 'unverified-1', { code, renewalAcknowledged: true }, 403],
    [enabled, 'paid-1', { code, renewalAcknowledged: true }, 409],
    [enabled, 'user-1', { code, renewalAcknowledged: false }, 400],
  ];
  for (const [fixture, userId, body, status] of cases) {
    const response = await fixture.request('/api/vouchers/checkout', {
      method: 'POST',
      headers: userId ? { 'x-test-user': userId } : {},
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status);
  }
  assert.equal(enabled.calls.create.length, 0);
});

test('all unavailable voucher states use one public response and consume limiter failures', async (t) => {
  const limiter = createVoucherLimiter({ maxFailures: 1, baseDelayMs: 2_000, windowMs: 60_000 });
  const fixture = await createFixture({ limiter });
  t.after(fixture.close);
  const first = await fixture.request('/api/vouchers/checkout', {
    method: 'POST',
    headers: { 'x-test-user': 'user-1', 'x-forwarded-for': '203.0.113.4' },
    body: JSON.stringify({ code: 'LC-PRO-2222-2222-2222-2222', renewalAcknowledged: true }),
  });
  assert.equal(first.status, 400);
  assert.deepEqual(await first.json(), { error: 'voucher_unavailable' });
  const second = await fixture.request('/api/vouchers/checkout', {
    method: 'POST',
    headers: { 'x-test-user': 'user-1', 'x-forwarded-for': '203.0.113.4' },
    body: JSON.stringify({ code: fixture.prepared.codes[0].code, renewalAcknowledged: true }),
  });
  assert.equal(second.status, 429);
  assert.equal(Number(second.headers.get('retry-after')) >= 1, true);
  assert.deepEqual(await second.json(), { error: 'voucher_unavailable' });
});

test('definitive Stripe Session creation failure immediately releases the unbound code', async (t) => {
  const fixture = await createFixture({ createError: true });
  t.after(fixture.close);
  const response = await fixture.request('/api/vouchers/checkout', {
    method: 'POST',
    headers: { 'x-test-user': 'user-1' },
    body: JSON.stringify({ code: fixture.prepared.codes[0].code, renewalAcknowledged: true }),
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'checkout_unavailable' });
  const stored = fixture.db.prepare('SELECT status, reserved_by, checkout_session_id FROM promotion_vouchers WHERE id = ?')
    .get(fixture.prepared.storedRows[0].id);
  assert.deepEqual(stored, { status: 'available', reserved_by: null, checkout_session_id: null });
});

test('status polling is private to the reserving browser account', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  await fixture.request('/api/vouchers/checkout', {
    method: 'POST',
    headers: { 'x-test-user': 'user-1' },
    body: JSON.stringify({ code: fixture.prepared.codes[0].code, renewalAcknowledged: true }),
  });
  const pending = await fixture.request('/api/vouchers/status/cs_test', {
    headers: { 'x-test-user': 'user-1' },
  });
  assert.equal(pending.status, 200);
  assert.equal(pending.headers.get('cache-control'), 'no-store, private');
  assert.deepEqual(await pending.json(), { status: 'pending' });
  const other = await fixture.request('/api/vouchers/status/cs_test', {
    headers: { 'x-test-user': 'user-2' },
  });
  assert.equal(other.status, 404);
  assert.deepEqual(await other.json(), { error: 'not_found' });
});

test('public voucher pages disclose renewal and keep codes out of URLs', (t) => {
  // Marketing HTML lives at website/redeem/index.html and website/voucher-terms/index.html
  // — SIBLINGS of website/server/. These paths are correct for the repo
  // layout, but the deploy pipeline (`deploy-api.sh`) only rsyncs
  // `website/server/` to `/opt/lingcode-api/` — so on any prod-shape
  // tree the fixture files won't be reachable via `../../`. Skip
  // cleanly (with a reason) rather than failing, so the test:
  //   - runs and asserts on the real HTML when invoked from the repo
  //     (or any tree where redeem/ + voucher-terms/ are siblings of
  //     server/), which is the whole point of the check;
  //   - gracefully no-ops when invoked from a deployed-tree location
  //     (e.g. /opt/lingcode-api/test/ during the ops-driven
  //     `rsync test/ && node --test` verification workflow).
  const redeemPath = path.join(__dirname, '../../redeem/index.html');
  const termsPath = path.join(__dirname, '../../voucher-terms/index.html');
  if (!fs.existsSync(redeemPath) || !fs.existsSync(termsPath)) {
    t.skip(`marketing HTML fixtures missing (${redeemPath} or ${termsPath}). ` +
      `Expected when tests run from a deployed tree that doesn't include the ` +
      `redeem/ + voucher-terms/ siblings — deploy-api.sh only ships website/server/.`);
    return;
  }
  const redeem = fs.readFileSync(redeemPath, 'utf8');
  const terms = fs.readFileSync(termsPath, 'utf8');
  assert.match(redeem, /30 days free, then \$20\/month automatically unless canceled/i);
  assert.match(redeem, /scan the QR.*prefill/i);
  assert.match(redeem, /sessionStorage/);
  assert.match(redeem, /src="\/redeem\/voucher-prefill\.js"/);
  assert.doesNotMatch(redeem, /searchParams\.get\(['"]code['"]\)/);
  assert.match(redeem, /type="checkbox"/);
  assert.doesNotMatch(redeem, /type="checkbox"[^>]*\schecked(?:\s|>)/);
  for (const phrase of [
    'payment card is required',
    '30-day trial',
    '$20 per month',
    'cancel before the trial ends',
    'one voucher per account and payment card',
    'no cash value',
  ]) {
    assert.match(terms.toLowerCase(), new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
