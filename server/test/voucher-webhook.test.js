'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migrateVoucherTables } = require('../migrate');
const {
  prepareVoucherBatch,
  insertPreparedBatch,
  reserveVoucher,
  bindCheckoutSession,
} = require('../vouchers');
const { handleStripeEvent, finalizeVoucherCheckout } = require('../stripe-webhook');

const NOW = 1_786_291_200_000;
const NOW_SECONDS = Math.floor(NOW / 1000);
const SECRET = 'voucher-secret-material-that-is-long-enough';
const PRICE = 'price_pro_monthly';

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
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      subscription_current_period_end TEXT,
      billing_interval TEXT,
      purchased_storage_bytes INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO users (id, email, tier, email_verified) VALUES
      ('user-1', 'one@example.com', 'free', 1),
      ('user-2', 'two@example.com', 'free', 1),
      ('ordinary-1', 'ordinary@example.com', 'free', 1);
  `);
  migrateVoucherTables(db);
  return db;
}

function makeStripe(subscriptions) {
  const calls = { retrieve: [], cancel: [] };
  return {
    calls,
    subscriptions: {
      retrieve: async (id, params) => {
        calls.retrieve.push({ id, params });
        if (!subscriptions[id]) throw new Error(`missing subscription ${id}`);
        return subscriptions[id];
      },
      cancel: async (id) => {
        calls.cancel.push(id);
        return { ...subscriptions[id], status: 'canceled' };
      },
    },
  };
}

function subscription(id, userId, voucherId, batchId, overrides = {}) {
  return {
    id,
    status: 'trialing',
    customer: `cus_${userId}`,
    trial_start: NOW_SECONDS,
    trial_end: NOW_SECONDS + 30 * 24 * 60 * 60,
    current_period_end: NOW_SECONDS + 30 * 24 * 60 * 60,
    default_payment_method: { id: `pm_${id}`, card: { fingerprint: 'fp_shared' } },
    items: { data: [{ price: { id: PRICE, recurring: { interval: 'month' } }, quantity: 1 }] },
    metadata: {
      flow: 'promotion_voucher',
      voucher_id: voucherId,
      batch_id: batchId,
      user_id: userId,
    },
    ...overrides,
  };
}

function reserve(db, { userId, sessionId, quantity = 1 }) {
  const prepared = prepareVoucherBatch({
    name: `Test ${sessionId}`,
    quantity,
    benefitDays: 30,
    redeemBy: NOW + 365 * 24 * 60 * 60 * 1000,
  }, { secret: SECRET, now: NOW });
  insertPreparedBatch(db, prepared);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const result = reserveVoucher(db, { code: prepared.codes[0].code, user }, { secret: SECRET, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(bindCheckoutSession(db, {
    voucherId: result.voucher.id,
    userId,
    checkoutSessionId: sessionId,
  }, { now: NOW }), true);
  return { prepared, voucher: result.voucher };
}

function checkoutEvent(session) {
  return { type: 'checkout.session.completed', data: { object: session } };
}

function voucherSession(id, userId, voucherId, batchId, subscriptionId, overrides = {}) {
  return {
    id,
    client_reference_id: userId,
    customer: `cus_${userId}`,
    subscription: subscriptionId,
    metadata: {
      flow: 'promotion_voucher',
      voucher_id: voucherId,
      batch_id: batchId,
      user_id: userId,
    },
    ...overrides,
  };
}

const voucherOptions = { hmacSecret: SECRET, proMonthlyPriceId: PRICE, now: () => NOW };

test('signed voucher Checkout finalizes the exact trial and is replay-idempotent', async () => {
  const db = fixtureDb();
  const held = reserve(db, { userId: 'user-1', sessionId: 'cs_exact' });
  const sub = subscription('sub_exact', 'user-1', held.voucher.id, held.prepared.batch.id);
  const stripe = makeStripe({ sub_exact: sub });
  const session = voucherSession('cs_exact', 'user-1', held.voucher.id, held.prepared.batch.id, 'sub_exact');

  await handleStripeEvent(stripe, db, checkoutEvent(session), voucherOptions);
  await handleStripeEvent(stripe, db, checkoutEvent(session), voucherOptions);

  assert.deepEqual(stripe.calls.retrieve, [
    { id: 'sub_exact', params: { expand: ['default_payment_method'] } },
    { id: 'sub_exact', params: { expand: ['default_payment_method'] } },
  ]);
  assert.deepEqual(stripe.calls.cancel, []);
  const voucher = db.prepare('SELECT * FROM promotion_vouchers WHERE id = ?').get(held.voucher.id);
  assert.equal(voucher.status, 'redeemed');
  assert.equal(voucher.redeemed_by, 'user-1');
  assert.equal(voucher.stripe_subscription_id, 'sub_exact');
  assert.match(voucher.card_fingerprint_digest, /^h1:[a-f0-9]{64}$/);
  const user = db.prepare('SELECT tier, subscription_status, stripe_subscription_id FROM users WHERE id = ?').get('user-1');
  assert.deepEqual(user, { tier: 'pro', subscription_status: 'trialing', stripe_subscription_id: 'sub_exact' });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM voucher_audit_events WHERE event_type = 'redeemed'").get().count, 1);
  const audits = JSON.stringify(db.prepare('SELECT * FROM voucher_audit_events').all());
  assert.equal(audits.includes(held.prepared.codes[0].code), false);
  assert.equal(audits.includes('fp_shared'), false);
  db.close();
});

test('voucher finalization cancels and blocks altered metadata', async () => {
  const db = fixtureDb();
  const held = reserve(db, { userId: 'user-1', sessionId: 'cs_tampered' });
  const sub = subscription('sub_tampered', 'user-1', held.voucher.id, held.prepared.batch.id);
  const stripe = makeStripe({ sub_tampered: sub });
  const session = voucherSession('cs_tampered', 'user-1', 'different-voucher', held.prepared.batch.id, 'sub_tampered');

  assert.deepEqual(await finalizeVoucherCheckout(stripe, db, session, voucherOptions), {
    handled: true,
    status: 'blocked',
  });
  assert.deepEqual(stripe.calls.cancel, ['sub_tampered']);
  assert.equal(db.prepare('SELECT status FROM promotion_vouchers WHERE id = ?').get(held.voucher.id).status, 'blocked');
  assert.equal(db.prepare('SELECT tier FROM users WHERE id = ?').get('user-1').tier, 'free');
  db.close();
});

test('voucher finalization rejects the wrong price or trial shape', async () => {
  const db = fixtureDb();
  const held = reserve(db, { userId: 'user-1', sessionId: 'cs_wrong_price' });
  const wrong = subscription('sub_wrong_price', 'user-1', held.voucher.id, held.prepared.batch.id, {
    items: { data: [{ price: { id: 'price_other', recurring: { interval: 'month' } }, quantity: 1 }] },
    trial_end: NOW_SECONDS + 7 * 24 * 60 * 60,
  });
  const stripe = makeStripe({ sub_wrong_price: wrong });
  const session = voucherSession('cs_wrong_price', 'user-1', held.voucher.id, held.prepared.batch.id, 'sub_wrong_price');

  assert.deepEqual(await finalizeVoucherCheckout(stripe, db, session, voucherOptions), {
    handled: true,
    status: 'blocked',
  });
  assert.deepEqual(stripe.calls.cancel, ['sub_wrong_price']);
  assert.equal(db.prepare('SELECT blocked_reason FROM promotion_vouchers WHERE id = ?').get(held.voucher.id).blocked_reason, 'invalid_subscription');
  db.close();
});

test('duplicate card finalization cancels the second trial and grants no Pro', async () => {
  const db = fixtureDb();
  const first = reserve(db, { userId: 'user-1', sessionId: 'cs_first' });
  const second = reserve(db, { userId: 'user-2', sessionId: 'cs_second' });
  const sub1 = subscription('sub_first', 'user-1', first.voucher.id, first.prepared.batch.id);
  const sub2 = subscription('sub_second', 'user-2', second.voucher.id, second.prepared.batch.id);
  const stripe = makeStripe({ sub_first: sub1, sub_second: sub2 });

  await handleStripeEvent(stripe, db, checkoutEvent(voucherSession(
    'cs_first', 'user-1', first.voucher.id, first.prepared.batch.id, 'sub_first'
  )), voucherOptions);
  await handleStripeEvent(stripe, db, checkoutEvent(voucherSession(
    'cs_second', 'user-2', second.voucher.id, second.prepared.batch.id, 'sub_second'
  )), voucherOptions);

  assert.deepEqual(stripe.calls.cancel, ['sub_second']);
  assert.equal(db.prepare('SELECT status FROM promotion_vouchers WHERE id = ?').get(second.voucher.id).status, 'blocked');
  assert.deepEqual(db.prepare('SELECT tier, stripe_subscription_id FROM users WHERE id = ?').get('user-2'), {
    tier: 'free',
    stripe_subscription_id: null,
  });
  db.close();
});

test('ordinary Checkout completion keeps the existing subscription sync path', async () => {
  const db = fixtureDb();
  const ordinary = subscription('sub_ordinary', 'ordinary-1', 'unused', 'unused', {
    status: 'active',
    metadata: { user_id: 'ordinary-1' },
    default_payment_method: null,
  });
  const stripe = makeStripe({ sub_ordinary: ordinary });
  await handleStripeEvent(stripe, db, checkoutEvent({
    id: 'cs_ordinary',
    client_reference_id: 'ordinary-1',
    customer: 'cus_ordinary',
    subscription: 'sub_ordinary',
    metadata: { user_id: 'ordinary-1' },
  }), voucherOptions);
  assert.deepEqual(db.prepare('SELECT tier, stripe_subscription_id FROM users WHERE id = ?').get('ordinary-1'), {
    tier: 'pro',
    stripe_subscription_id: 'sub_ordinary',
  });
  db.close();
});

test('stale subscription deletion cannot clear a newer subscription', async () => {
  const db = fixtureDb();
  db.prepare(`
    UPDATE users SET tier = 'pro', stripe_customer_id = 'cus_user-1',
      stripe_subscription_id = 'sub_new', subscription_status = 'active'
    WHERE id = 'user-1'
  `).run();
  const stripe = makeStripe({});
  await handleStripeEvent(stripe, db, {
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_old', customer: 'cus_user-1', status: 'canceled' } },
  }, voucherOptions);
  assert.deepEqual(db.prepare('SELECT tier, stripe_subscription_id FROM users WHERE id = ?').get('user-1'), {
    tier: 'pro',
    stripe_subscription_id: 'sub_new',
  });
  await handleStripeEvent(stripe, db, {
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_new', customer: 'cus_user-1', status: 'canceled' } },
  }, voucherOptions);
  assert.deepEqual(db.prepare('SELECT tier, stripe_subscription_id, purchased_storage_bytes FROM users WHERE id = ?').get('user-1'), {
    tier: 'free',
    stripe_subscription_id: null,
    purchased_storage_bytes: 0,
  });
  db.close();
});
