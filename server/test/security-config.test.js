'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProductionSecurity, securityHeaders } = require('../security-config');

function production(overrides = {}) {
  return {
    NODE_ENV: 'production',
    SESSION_SECRET: 's'.repeat(48),
    LINGCODE_TOKEN_PEPPER: 'p'.repeat(48),
    CLOUD_PG_ADMIN_URL: '',
    CLOUD_JWT_SECRET: '',
    LINGCODE_VAULT_MASTER_KEY: '',
    VOUCHERS_ENABLED: '0',
    ...overrides,
  };
}

test('disabled vouchers do not require billing configuration', () => {
  assert.doesNotThrow(() => validateProductionSecurity(production({
    VOUCHERS_ENABLED: '0',
    LINGCODE_VOUCHER_HMAC_SECRET: '',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    STRIPE_PRICE_PRO_MONTHLY: '',
  })));
});

test('enabled vouchers fail closed without each required billing value', () => {
  const configured = {
    VOUCHERS_ENABLED: '1',
    LINGCODE_VOUCHER_HMAC_SECRET: 'v'.repeat(48),
    STRIPE_SECRET_KEY: 'sk_live_example',
    STRIPE_WEBHOOK_SECRET: 'whsec_example',
    STRIPE_PRICE_PRO_MONTHLY: 'price_monthly',
  };
  for (const key of [
    'LINGCODE_VOUCHER_HMAC_SECRET',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PRICE_PRO_MONTHLY',
  ]) {
    assert.throws(
      () => validateProductionSecurity(production({ ...configured, [key]: '' })),
      new RegExp(key)
    );
  }
});

test('enabled vouchers reject a short voucher HMAC secret', () => {
  assert.throws(() => validateProductionSecurity(production({
    VOUCHERS_ENABLED: '1',
    LINGCODE_VOUCHER_HMAC_SECRET: 'too-short',
    STRIPE_SECRET_KEY: 'sk_live_example',
    STRIPE_WEBHOOK_SECRET: 'whsec_example',
    STRIPE_PRICE_PRO_MONTHLY: 'price_monthly',
  })), /LINGCODE_VOUCHER_HMAC_SECRET/);
});

test('development may use local-only defaults', () => {
  assert.doesNotThrow(() => validateProductionSecurity({ NODE_ENV: 'development' }));
});

test('production rejects missing or predictable session and token secrets', () => {
  assert.throws(() => validateProductionSecurity(production({ SESSION_SECRET: '' })), /SESSION_SECRET/);
  assert.throws(() => validateProductionSecurity(production({ SESSION_SECRET: 'set-SESSION_SECRET-in-production' })), /SESSION_SECRET/);
  assert.throws(() => validateProductionSecurity(production({ LINGCODE_TOKEN_PEPPER: 'short' })), /LINGCODE_TOKEN_PEPPER/);
});

test('configured Cloud requires a strong compatibility JWT secret', () => {
  assert.throws(() => validateProductionSecurity(production({ CLOUD_PG_ADMIN_URL: 'postgres://db', CLOUD_JWT_SECRET: '' })), /CLOUD_JWT_SECRET/);
  assert.doesNotThrow(() => validateProductionSecurity(production({ CLOUD_PG_ADMIN_URL: 'postgres://db', CLOUD_JWT_SECRET: 'j'.repeat(48) })));
});

test('configured vault key must decode to 32 bytes', () => {
  assert.throws(() => validateProductionSecurity(production({ LINGCODE_VAULT_MASTER_KEY: 'bad' })), /LINGCODE_VAULT_MASTER_KEY/);
  assert.doesNotThrow(() => validateProductionSecurity(production({ LINGCODE_VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') })));
});

test('security middleware sets a shared safe header baseline', () => {
  const headers = new Map();
  const res = { setHeader: (key, value) => headers.set(key.toLowerCase(), value) };
  let called = false;
  securityHeaders()({}, res, () => { called = true; });
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(called, true);
});
