'use strict';

const DEFAULTS = Object.freeze({
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  baseDelayMs: 1_000,
  maxDelayMs: 15 * 60 * 1000,
  maxEntries: 20_000,
});

function createLoginLimiter(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const buckets = new Map();

  function keys(account, ip) {
    return [
      `account:${String(account || '').trim().toLowerCase()}`,
      `ip:${String(ip || 'unknown')}`,
    ];
  }

  function prune(now) {
    for (const [key, entry] of buckets) {
      if (now - entry.firstAt >= config.windowMs && entry.blockedUntil <= now) {
        buckets.delete(key);
      }
    }
    while (buckets.size > config.maxEntries) {
      let oldestKey = null;
      let oldestTouchedAt = Infinity;
      for (const [key, entry] of buckets) {
        if (entry.touchedAt < oldestTouchedAt) {
          oldestKey = key;
          oldestTouchedAt = entry.touchedAt;
        }
      }
      if (oldestKey == null) break;
      buckets.delete(oldestKey);
    }
  }

  function check({ account, ip, now = Date.now() }) {
    prune(now);
    let retryAfterMs = 0;
    for (const key of keys(account, ip)) {
      const entry = buckets.get(key);
      if (entry && entry.blockedUntil > now) {
        retryAfterMs = Math.max(retryAfterMs, entry.blockedUntil - now);
      }
    }
    return retryAfterMs > 0
      ? { allowed: false, retryAfterMs }
      : { allowed: true, retryAfterMs: 0 };
  }

  function fail({ account, ip, now = Date.now() }) {
    prune(now);
    for (const key of keys(account, ip)) {
      let entry = buckets.get(key);
      if (!entry || now - entry.firstAt >= config.windowMs) {
        entry = { failures: 0, firstAt: now, blockedUntil: 0, touchedAt: now };
      }
      entry.failures += 1;
      entry.touchedAt = now;
      if (entry.failures >= config.maxFailures) {
        const exponent = entry.failures - config.maxFailures;
        const delay = Math.min(config.maxDelayMs, config.baseDelayMs * (2 ** exponent));
        entry.blockedUntil = Math.max(entry.blockedUntil, now + delay);
      }
      buckets.set(key, entry);
    }
    prune(now);
  }

  function success({ account }) {
    buckets.delete(`account:${String(account || '').trim().toLowerCase()}`);
  }

  return { check, fail, success, size: () => buckets.size };
}

module.exports = { createLoginLimiter };
