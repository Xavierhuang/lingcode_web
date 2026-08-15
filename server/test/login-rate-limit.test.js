'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoginLimiter } = require('../login-rate-limit');

test('blocks after five failures for either account or address', () => {
  const limiter = createLoginLimiter({ maxFailures: 5, windowMs: 60_000, maxEntries: 100 });
  for (let i = 0; i < 5; i += 1) limiter.fail({ account: 'a@example.com', ip: '203.0.113.4', now: i });
  assert.equal(limiter.check({ account: 'a@example.com', ip: '198.51.100.2', now: 10 }).allowed, false);
  assert.equal(limiter.check({ account: 'other@example.com', ip: '203.0.113.4', now: 10 }).allowed, false);
});

test('success clears only the account bucket', () => {
  const limiter = createLoginLimiter({ maxFailures: 2, windowMs: 60_000 });
  limiter.fail({ account: 'a@example.com', ip: '203.0.113.4', now: 0 });
  limiter.success({ account: 'a@example.com' });
  assert.equal(limiter.check({ account: 'a@example.com', ip: '198.51.100.2', now: 1 }).allowed, true);
  assert.equal(limiter.check({ account: 'b@example.com', ip: '203.0.113.4', now: 1 }).allowed, true);
});

test('expired buckets are removed and memory remains bounded', () => {
  const limiter = createLoginLimiter({ maxFailures: 2, windowMs: 100, maxEntries: 4 });
  for (let i = 0; i < 20; i += 1) limiter.fail({ account: `u${i}@example.com`, ip: `203.0.113.${i}`, now: i });
  assert.ok(limiter.size() <= 4);
  assert.equal(limiter.check({ account: 'u19@example.com', ip: '203.0.113.19', now: 1_000 }).allowed, true);
});

test('blocked response exposes only a combined retry interval', () => {
  const limiter = createLoginLimiter({ maxFailures: 1, baseDelayMs: 2_000, windowMs: 60_000 });
  limiter.fail({ account: 'a@example.com', ip: '203.0.113.4', now: 10 });
  assert.deepEqual(limiter.check({ account: 'a@example.com', ip: '198.51.100.2', now: 20 }), {
    allowed: false,
    retryAfterMs: 1_990,
  });
});
