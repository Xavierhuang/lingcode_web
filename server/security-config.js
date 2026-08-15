'use strict';

const DEFAULT_SESSION_SECRET = 'set-SESSION_SECRET-in-production';

function fail(name) {
  const error = new Error(`Unsafe production security configuration: ${name}`);
  error.code = 'unsafe_security_configuration';
  throw error;
}

function decodesTo32Bytes(raw) {
  if (!raw) return false;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex').length === 32;
  try {
    return Buffer.from(raw, 'base64').length === 32;
  } catch (_) {
    return false;
  }
}

function validateProductionSecurity(env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  if (!env.SESSION_SECRET
    || env.SESSION_SECRET === DEFAULT_SESSION_SECRET
    || Buffer.byteLength(env.SESSION_SECRET) < 32) fail('SESSION_SECRET');
  if (!env.LINGCODE_TOKEN_PEPPER || Buffer.byteLength(env.LINGCODE_TOKEN_PEPPER) < 32) {
    fail('LINGCODE_TOKEN_PEPPER');
  }
  if (env.CLOUD_PG_ADMIN_URL
    && (!env.CLOUD_JWT_SECRET || Buffer.byteLength(env.CLOUD_JWT_SECRET) < 32)) {
    fail('CLOUD_JWT_SECRET');
  }
  if (env.LINGCODE_VAULT_MASTER_KEY && !decodesTo32Bytes(env.LINGCODE_VAULT_MASTER_KEY)) {
    fail('LINGCODE_VAULT_MASTER_KEY');
  }
  if (env.VOUCHERS_ENABLED === '1') {
    if (!env.LINGCODE_VOUCHER_HMAC_SECRET
      || Buffer.byteLength(env.LINGCODE_VOUCHER_HMAC_SECRET) < 32) {
      fail('LINGCODE_VOUCHER_HMAC_SECRET');
    }
    for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_PRO_MONTHLY']) {
      if (!env[name] || !String(env[name]).trim()) fail(name);
    }
  }
}

function securityHeaders(options = {}) {
  const production = options.production == null
    ? process.env.NODE_ENV === 'production'
    : Boolean(options.production);
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-Frame-Options', 'DENY');
    if (production) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

// Correlation id for every request. Audit rows, error logs and support requests
// all carry the same value so one user-reported symptom can be traced across
// them — SOC 2 CC7.2 wants events to be reconstructable, which is impossible
// when nothing ties log lines to each other.
//
// An inbound X-Request-Id is honoured (so a proxy or the SDK can thread its own
// id through) but sanitised first: it lands in audit_log and gets echoed back in
// a response header, so untrusted input must not carry header-splitting bytes or
// unbounded length. Anything unusable is replaced with a fresh uuid.
const crypto = require('crypto');

const REQUEST_ID_MAX = 64;
const REQUEST_ID_SAFE = /^[A-Za-z0-9._-]+$/;

function requestId() {
  return (req, res, next) => {
    const inbound = String(req.headers['x-request-id'] || '').trim();
    req.requestId = inbound.length && inbound.length <= REQUEST_ID_MAX && REQUEST_ID_SAFE.test(inbound)
      ? inbound
      : crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  };
}

module.exports = { validateProductionSecurity, securityHeaders, requestId };
