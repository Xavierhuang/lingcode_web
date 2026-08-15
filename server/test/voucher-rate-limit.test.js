'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoucherLimiter } = require('../voucher-rate-limit');

test('six failures block both the account and network address', () => {
  const limiter = createVoucherLimiter({ windowMs: 60_000, maxEntries: 100 });
  for (let i = 0; i < 6; i += 1) {
    limiter.fail({ account: 'USER@example.com', ip: '203.0.113.4', now: i });
  }
  assert.deepEqual(limiter.check({ account: 'user@example.com', ip: '198.51.100.2', now: 10 }), {
    allowed: false,
    retryAfterMs: 1_995,
  });
  assert.equal(limiter.check({ account: 'other@example.com', ip: '203.0.113.4', now: 10 }).allowed, false);
});

test('continued failures double cooldown up to the configured cap', () => {
  const limiter = createVoucherLimiter({
    maxFailures: 2,
    baseDelayMs: 1_000,
    maxDelayMs: 4_000,
    windowMs: 60_000,
  });
  limiter.fail({ account: 'a@example.com', ip: '203.0.113.4', now: 0 });
  limiter.fail({ account: 'a@example.com', ip: '203.0.113.4', now: 1 });
  assert.equal(limiter.check({ account: 'a@example.com', ip: 'other', now: 1 }).retryAfterMs, 1_000);
  limiter.fail({ account: 'a@example.com', ip: '203.0.113.4', now: 2 });
  assert.equal(limiter.check({ account: 'a@example.com', ip: 'other', now: 2 }).retryAfterMs, 2_000);
  limiter.fail({ account: 'a@example.com', ip: '203.0.113.4', now: 3 });
  limiter.fail({ account: 'a@example.com', ip: '203.0.113.4', now: 4 });
  assert.equal(limiter.check({ account: 'a@example.com', ip: 'other', now: 4 }).retryAfterMs, 4_000);
});

test('successful redemption clears only the account bucket', () => {
  const limiter = createVoucherLimiter({ maxFailures: 1, windowMs: 60_000 });
  limiter.fail({ account: 'a@example.com', ip: '203.0.113.4', now: 0 });
  limiter.success({ account: 'A@example.com' });
  assert.equal(limiter.check({ account: 'a@example.com', ip: '198.51.100.2', now: 1 }).allowed, true);
  assert.equal(limiter.check({ account: 'b@example.com', ip: '203.0.113.4', now: 1 }).allowed, false);
});

test('expired entries disappear and attacker-created keys stay bounded', () => {
  const limiter = createVoucherLimiter({ maxFailures: 2, windowMs: 100, maxEntries: 4 });
  for (let i = 0; i < 20; i += 1) {
    limiter.fail({ account: `u${i}@example.com`, ip: `203.0.113.${i}`, now: i });
  }
  assert.ok(limiter.size() <= 4);
  assert.equal(limiter.check({ account: 'u19@example.com', ip: '203.0.113.19', now: 1_000 }).allowed, true);
  assert.equal(limiter.size(), 0);
});

test('limiter output never echoes account, address, or voucher material', () => {
  const limiter = createVoucherLimiter({ maxFailures: 1, baseDelayMs: 2_000, windowMs: 60_000 });
  limiter.fail({ account: 'secret@example.com', ip: '203.0.113.9', code: 'LC-PRO-SECRET', now: 10 });
  assert.deepEqual(limiter.check({ account: 'secret@example.com', ip: '203.0.113.9', now: 20 }), {
    allowed: false,
    retryAfterMs: 1_990,
  });
});
