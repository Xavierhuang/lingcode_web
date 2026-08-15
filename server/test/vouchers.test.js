'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migrateVoucherTables } = require('../migrate');
const {
  normalizeVoucherCode,
  generateVoucherCode,
  digestVoucherCode,
  digestCardFingerprint,
  prepareVoucherBatch,
  insertPreparedBatch,
  reserveVoucher,
  bindCheckoutSession,
  releaseReservation,
  finalizeRedemption,
  blockRedemption,
  revokeVoucher,
  revokeBatch,
  voucherStatusForUser,
  batchSummary,
} = require('../vouchers');

const NOW = 1_786_291_200_000;
const YEAR = 365 * 24 * 60 * 60 * 1000;
const SECRET = 'voucher-secret-material-that-is-long-enough';

function fixtureDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL DEFAULT 'free',
      email_verified INTEGER NOT NULL DEFAULT 1,
      subscription_status TEXT
    );
    INSERT INTO users (id, email, tier, email_verified, subscription_status) VALUES
      ('admin-1', 'admin@example.com', 'free', 1, NULL),
      ('user-1', 'one@example.com', 'free', 1, NULL),
      ('user-2', 'two@example.com', 'free', 1, NULL),
      ('paid-1', 'paid@example.com', 'pro', 1, 'active'),
      ('unverified-1', 'wait@example.com', 'free', 0, NULL);
  `);
  migrateVoucherTables(db);
  return db;
}

function prepareBatch(overrides = {}, options = {}) {
  return prepareVoucherBatch({
    name: 'LingCode Pro Promotion 2026',
    quantity: 3,
    benefitDays: 30,
    redeemBy: NOW + YEAR,
    createdBy: 'admin-1',
    ...overrides,
  }, { secret: SECRET, now: NOW, ...options });
}

function issueBatch(db, overrides = {}, options = {}) {
  const prepared = prepareBatch(overrides, options);
  insertPreparedBatch(db, prepared);
  return prepared;
}

test('normalizes formatting but rejects malformed or ambiguous codes', () => {
  assert.equal(
    normalizeVoucherCode(' lc-pro-k7m2-9q2x-w4tr-a8df '),
    'LCPROK7M29Q2XW4TRA8DF'
  );
  for (const malformed of ['LC-PRO-INVALID-0O1I', 'LC-PRO-ABCD', '', null]) {
    assert.throws(() => normalizeVoucherCode(malformed), /invalid_voucher_code/);
  }
});

test('generated codes contain exactly 16 symbols from a 32-character alphabet', () => {
  const code = generateVoucherCode();
  assert.match(code, /^LC-PRO-[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){3}$/);
  assert.equal(code.replace(/^LC-PRO-/, '').replaceAll('-', '').length, 16);
});

test('voucher and card digests are deterministic and domain separated', () => {
  const code = 'LC-PRO-K7M2-9Q2X-W4TR-A8DF';
  assert.equal(digestVoucherCode(code, SECRET), digestVoucherCode(code.toLowerCase(), SECRET));
  assert.notEqual(digestVoucherCode(code, SECRET), digestCardFingerprint(normalizeVoucherCode(code), SECRET));
  assert.match(digestVoucherCode(code, SECRET), /^h1:[a-f0-9]{64}$/);
});

test('prepares and inserts 500 unique vouchers without storing raw codes', () => {
  const db = fixtureDb();
  const prepared = prepareBatch({ quantity: 500 });
  insertPreparedBatch(db, prepared);

  assert.equal(prepared.codes.length, 500);
  assert.equal(new Set(prepared.codes.map((item) => item.code)).size, 500);
  assert.deepEqual(prepared.codes.map((item) => item.serialNumber), Array.from({ length: 500 }, (_, i) => i + 1));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM promotion_vouchers').get().count, 500);
  assert.equal(db.prepare('SELECT benefit_days FROM voucher_batches').get().benefit_days, 30);

  const stored = JSON.stringify({
    batches: db.prepare('SELECT * FROM voucher_batches').all(),
    vouchers: db.prepare('SELECT * FROM promotion_vouchers').all(),
  });
  for (const item of prepared.codes) assert.equal(stored.includes(item.code), false);
  db.close();
});

test('batch preparation validates issuance boundaries before writing', () => {
  for (const quantity of [0, 501, 1.5]) {
    assert.throws(() => prepareBatch({ quantity }), /invalid_quantity/);
  }
  assert.throws(() => prepareBatch({ benefitDays: 0 }), /invalid_benefit_days/);
  assert.throws(() => prepareBatch({ redeemBy: NOW }), /invalid_redeem_by/);
  assert.throws(() => prepareBatch({ name: '   ' }), /invalid_batch_name/);
});

test('batch preparation retries an in-batch random-code collision', () => {
  let calls = 0;
  const bytes = [
    Buffer.alloc(16, 0),
    Buffer.alloc(16, 0),
    Buffer.alloc(16, 1),
  ];
  const prepared = prepareBatch({ quantity: 2 }, {
    randomBytes: () => bytes[calls++],
  });
  assert.equal(prepared.codes.length, 2);
  assert.equal(new Set(prepared.codes.map((item) => item.code)).size, 2);
  assert.equal(calls, 3);
});

test('prepared insertion is atomic when a stored digest conflicts', () => {
  const db = fixtureDb();
  const first = prepareBatch({ quantity: 1 });
  insertPreparedBatch(db, first);
  const second = prepareBatch({ quantity: 2 });
  second.storedRows[1].codeDigest = first.storedRows[0].codeDigest;

  assert.throws(() => insertPreparedBatch(db, second), /UNIQUE constraint failed/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM voucher_batches').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM promotion_vouchers').get().count, 1);

  const third = prepareBatch({ quantity: 2 });
  assert.throws(() => insertPreparedBatch(db, third, {
    afterInsert: () => { throw new Error('audit failed'); },
  }), /audit failed/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM voucher_batches').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM promotion_vouchers').get().count, 1);
  db.close();
});

test('reservation is atomic, same-user idempotent, and safe to audit', () => {
  const db = fixtureDb();
  const prepared = issueBatch(db, { quantity: 1 });
  const code = prepared.codes[0].code;
  const voucherId = prepared.storedRows[0].id;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get('user-1');

  const first = reserveVoucher(db, { code, user }, { secret: SECRET, now: NOW });
  assert.equal(first.ok, true);
  assert.equal(first.voucher.id, voucherId);
  assert.equal(first.voucher.reservedUntil, NOW + 30 * 60 * 1000);
  assert.equal(JSON.stringify(first).includes('code_digest'), false);
  assert.equal(JSON.stringify(first).includes(code), false);

  const again = reserveVoucher(db, { code, user }, { secret: SECRET, now: NOW + 1 });
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);

  const other = db.prepare('SELECT * FROM users WHERE id = ?').get('user-2');
  assert.deepEqual(
    reserveVoucher(db, { code, user: other }, { secret: SECRET, now: NOW + 2 }),
    { ok: false, error: 'unavailable' }
  );

  const audit = JSON.stringify(db.prepare('SELECT * FROM voucher_audit_events').all());
  assert.equal(audit.includes(code), false);
  assert.equal(audit.includes(prepared.storedRows[0].codeDigest), false);
  db.close();
});

test('reservation rejects unverified, paid, expired, and previously redeemed accounts', () => {
  const db = fixtureDb();
  const unavailable = issueBatch(db, { quantity: 4 });
  const paid = db.prepare('SELECT * FROM users WHERE id = ?').get('paid-1');
  const unverified = db.prepare('SELECT * FROM users WHERE id = ?').get('unverified-1');
  const user1 = db.prepare('SELECT * FROM users WHERE id = ?').get('user-1');

  assert.deepEqual(
    reserveVoucher(db, { code: unavailable.codes[0].code, user: unverified }, { secret: SECRET, now: NOW }),
    { ok: false, error: 'unverified' }
  );
  assert.deepEqual(
    reserveVoucher(db, { code: unavailable.codes[1].code, user: paid }, { secret: SECRET, now: NOW }),
    { ok: false, error: 'ineligible' }
  );

  const expiring = issueBatch(db, { quantity: 1, redeemBy: NOW + 10 });
  assert.deepEqual(
    reserveVoucher(db, { code: expiring.codes[0].code, user: user1 }, { secret: SECRET, now: NOW + 11 }),
    { ok: false, error: 'unavailable' }
  );

  const first = reserveVoucher(db, { code: unavailable.codes[2].code, user: user1 }, { secret: SECRET, now: NOW });
  assert.equal(bindCheckoutSession(db, {
    voucherId: first.voucher.id,
    userId: user1.id,
    checkoutSessionId: 'cs_first',
  }), true);
  assert.equal(finalizeRedemption(db, {
    voucherId: first.voucher.id,
    userId: user1.id,
    checkoutSessionId: 'cs_first',
    subscriptionId: 'sub_first',
    cardFingerprintDigest: digestCardFingerprint('fp_first', SECRET),
  }, { now: NOW + 100 }).ok, true);

  assert.deepEqual(
    reserveVoucher(db, { code: unavailable.codes[3].code, user: user1 }, { secret: SECRET, now: NOW + 101 }),
    { ok: false, error: 'ineligible' }
  );
  db.close();
});

test('checkout binding requires reservation ownership and is exact-session idempotent', () => {
  const db = fixtureDb();
  const prepared = issueBatch(db, { quantity: 1 });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get('user-1');
  const reserved = reserveVoucher(db, { code: prepared.codes[0].code, user }, { secret: SECRET, now: NOW });

  assert.equal(bindCheckoutSession(db, {
    voucherId: reserved.voucher.id,
    userId: 'user-2',
    checkoutSessionId: 'cs_wrong',
  }), false);
  assert.equal(bindCheckoutSession(db, {
    voucherId: reserved.voucher.id,
    userId: user.id,
    checkoutSessionId: 'cs_right',
  }), true);
  assert.equal(bindCheckoutSession(db, {
    voucherId: reserved.voucher.id,
    userId: user.id,
    checkoutSessionId: 'cs_right',
  }), true);
  assert.equal(bindCheckoutSession(db, {
    voucherId: reserved.voucher.id,
    userId: user.id,
    checkoutSessionId: 'cs_changed',
  }), false);
  db.close();
});

test('finalization requires the exact reservation and is replay-idempotent', () => {
  const db = fixtureDb();
  const prepared = issueBatch(db, { quantity: 1 });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get('user-1');
  const reserved = reserveVoucher(db, { code: prepared.codes[0].code, user }, { secret: SECRET, now: NOW });
  bindCheckoutSession(db, { voucherId: reserved.voucher.id, userId: user.id, checkoutSessionId: 'cs_exact' });
  const input = {
    voucherId: reserved.voucher.id,
    userId: user.id,
    checkoutSessionId: 'cs_exact',
    subscriptionId: 'sub_exact',
    cardFingerprintDigest: digestCardFingerprint('fp_exact', SECRET),
  };

  assert.deepEqual(finalizeRedemption(db, { ...input, checkoutSessionId: 'cs_other' }, { now: NOW + 1 }), {
    ok: false,
    error: 'reservation_mismatch',
  });
  assert.deepEqual(finalizeRedemption(db, input, { now: NOW + 2 }), { ok: true, idempotent: false });
  assert.deepEqual(finalizeRedemption(db, input, { now: NOW + 3 }), { ok: true, idempotent: true });
  assert.deepEqual(finalizeRedemption(db, { ...input, subscriptionId: 'sub_changed' }, { now: NOW + 4 }), {
    ok: false,
    error: 'redemption_mismatch',
  });
  assert.equal(voucherStatusForUser(db, { checkoutSessionId: 'cs_exact', userId: user.id }), 'active');
  assert.equal(voucherStatusForUser(db, { checkoutSessionId: 'cs_exact', userId: 'user-2' }), null);
  db.close();
});

test('finalization detects duplicate account and card before unique constraints fire', () => {
  const db = fixtureDb();
  const firstBatch = issueBatch(db, { quantity: 1 });
  const secondBatch = issueBatch(db, { quantity: 2 });
  const user1 = db.prepare('SELECT * FROM users WHERE id = ?').get('user-1');
  const user2 = db.prepare('SELECT * FROM users WHERE id = ?').get('user-2');
  const cardDigest = digestCardFingerprint('shared-fingerprint', SECRET);

  const first = reserveVoucher(db, { code: firstBatch.codes[0].code, user: user1 }, { secret: SECRET, now: NOW });
  bindCheckoutSession(db, { voucherId: first.voucher.id, userId: user1.id, checkoutSessionId: 'cs_1' });
  assert.equal(finalizeRedemption(db, {
    voucherId: first.voucher.id,
    userId: user1.id,
    checkoutSessionId: 'cs_1',
    subscriptionId: 'sub_1',
    cardFingerprintDigest: cardDigest,
  }, { now: NOW + 1 }).ok, true);

  const second = reserveVoucher(db, { code: secondBatch.codes[0].code, user: user2 }, { secret: SECRET, now: NOW + 2 });
  bindCheckoutSession(db, { voucherId: second.voucher.id, userId: user2.id, checkoutSessionId: 'cs_2' });
  assert.deepEqual(finalizeRedemption(db, {
    voucherId: second.voucher.id,
    userId: user2.id,
    checkoutSessionId: 'cs_2',
    subscriptionId: 'sub_2',
    cardFingerprintDigest: cardDigest,
  }, { now: NOW + 3 }), { ok: false, error: 'duplicate_card' });

  assert.deepEqual(finalizeRedemption(db, {
    voucherId: second.voucher.id,
    userId: user1.id,
    checkoutSessionId: 'cs_2',
    subscriptionId: 'sub_3',
    cardFingerprintDigest: digestCardFingerprint('other-fingerprint', SECRET),
  }, { now: NOW + 4 }), { ok: false, error: 'reservation_mismatch' });
  db.close();
});

test('bound reservations release only after confirmed incomplete or expired Checkout', () => {
  const db = fixtureDb();
  const prepared = issueBatch(db, { quantity: 3 });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get('user-1');
  const bound = reserveVoucher(db, { code: prepared.codes[0].code, user }, { secret: SECRET, now: NOW });
  bindCheckoutSession(db, { voucherId: bound.voucher.id, userId: user.id, checkoutSessionId: 'cs_bound' });

  assert.equal(releaseReservation(db, {
    voucherId: bound.voucher.id,
    userId: user.id,
    checkoutSessionId: 'cs_bound',
    checkoutStatus: 'complete',
  }, { now: NOW + 31 * 60 * 1000 }), false);
  assert.equal(releaseReservation(db, {
    voucherId: bound.voucher.id,
    userId: user.id,
    checkoutSessionId: 'cs_bound',
    checkoutStatus: 'expired',
  }, { now: NOW + 31 * 60 * 1000 }), true);

  const unbound = reserveVoucher(db, { code: prepared.codes[1].code, user }, { secret: SECRET, now: NOW });
  assert.equal(releaseReservation(db, {
    voucherId: unbound.voucher.id,
    userId: user.id,
  }, { now: NOW + 29 * 60 * 1000 }), false);
  assert.equal(releaseReservation(db, {
    voucherId: unbound.voucher.id,
    userId: user.id,
  }, { now: NOW + 31 * 60 * 1000 }), true);

  const failedCreate = reserveVoucher(db, { code: prepared.codes[2].code, user }, { secret: SECRET, now: NOW });
  assert.equal(releaseReservation(db, {
    voucherId: failedCreate.voucher.id,
    userId: user.id,
    creationFailed: true,
  }, { now: NOW + 1 }), true);
  db.close();
});

test('blocking, revocation, and batch summaries preserve safe lifecycle state', () => {
  const db = fixtureDb();
  const prepared = issueBatch(db, { quantity: 3 });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get('user-1');
  const blocked = reserveVoucher(db, { code: prepared.codes[0].code, user }, { secret: SECRET, now: NOW });
  bindCheckoutSession(db, { voucherId: blocked.voucher.id, userId: user.id, checkoutSessionId: 'cs_block' });
  assert.equal(blockRedemption(db, {
    voucherId: blocked.voucher.id,
    userId: user.id,
    checkoutSessionId: 'cs_block',
    reasonCode: 'duplicate_card',
  }, { now: NOW + 1 }), true);
  assert.equal(voucherStatusForUser(db, { checkoutSessionId: 'cs_block', userId: user.id }), 'blocked');

  assert.equal(revokeVoucher(db, {
    voucherId: prepared.storedRows[1].id,
    actorUserId: 'admin-1',
  }, { now: NOW + 2 }), true);
  assert.equal(revokeBatch(db, {
    batchId: prepared.batch.id,
    actorUserId: 'admin-1',
  }, { now: NOW + 3 }), 1);

  assert.deepEqual(batchSummary(db, prepared.batch.id), {
    id: prepared.batch.id,
    name: prepared.batch.name,
    quantity: 3,
    benefitDays: 30,
    redeemBy: NOW + YEAR,
    status: 'revoked',
    createdBy: 'admin-1',
    createdAt: NOW,
    counts: { available: 0, reserved: 0, redeemed: 0, blocked: 1, revoked: 2 },
  });
  db.close();
});
