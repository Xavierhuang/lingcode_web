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

module.exports = { validateProductionSecurity, securityHeaders };
