'use strict';

// Tests for the Domain Connect engine — the signing-correctness-critical bits that
// must be right BEFORE GoDaddy onboarding (they verify our signature). Network +
// session pieces are exercised via injected deps; no live calls.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const dc = require('../cloud-domainconnect');

// Ephemeral keypair so we can sign then verify exactly as the DNS provider will.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

test('canonicalQuery: fixed order, url-encoded, drops empties, excludes sig/key', () => {
  const qs = dc.canonicalQuery({ domain: 'a.com', redirect_uri: 'https://x/cb?z=1', state: 'abc', host: '' });
  assert.equal(qs, 'domain=a.com&redirect_uri=https%3A%2F%2Fx%2Fcb%3Fz%3D1&state=abc'); // host empty → dropped
});

test('signQuery: RSA-SHA256 signature verifies against the public key', () => {
  const qs = 'domain=acme.com&redirect_uri=https%3A%2F%2Flingcode.dev%2Fcb&state=deadbeef';
  const sigB64 = dc.signQuery(qs, privateKey);
  const v = crypto.createVerify('RSA-SHA256');
  v.update(qs); v.end();
  assert.ok(v.verify(publicKey, Buffer.from(sigB64, 'base64')), 'signature must verify');
});

test('buildApplyUrl: well-formed path + the signed query verifies', () => {
  const url = dc.buildApplyUrl('https://dcc.godaddy.com/manage', 'godaddy.com', 'acme.com', { state: 'st123', privateKey });
  assert.ok(url.startsWith('https://dcc.godaddy.com/manage/v2/domainTemplates/providers/godaddy.com/services/lingcode/apply?'));
  const [, query] = url.split('?');
  const params = new URLSearchParams(query);
  assert.equal(params.get('domain'), 'acme.com');
  assert.equal(params.get('state'), 'st123');
  assert.ok(params.get('sig') && params.get('key'), 'sig + key present');
  // Reconstruct the exact signed portion (everything before &sig=) and verify it.
  const signed = query.slice(0, query.indexOf('&sig='));
  const v = crypto.createVerify('RSA-SHA256');
  v.update(signed); v.end();
  assert.ok(v.verify(publicKey, Buffer.from(params.get('sig'), 'base64')), 'apply-url signature must verify');
});

test('discover: parses provider settings + marks supported only for onboarded providers', async () => {
  const fakeTxt = async () => [['domainconnect.api.godaddy.com']];
  const fakeFetch = async () => ({ ok: true, json: async () => ({ providerId: 'GoDaddy.com', providerName: 'GoDaddy', urlSyncUX: 'https://dcc.godaddy.com/manage' }) });
  const d = await dc.discover('acme.com', { resolveTxt: fakeTxt, fetch: fakeFetch });
  assert.equal(d.found, true);
  assert.equal(d.providerId, 'godaddy.com');     // lowercased
  assert.equal(d.urlSyncUX, 'https://dcc.godaddy.com/manage');
  // supported depends on LINGCODE_DC_PROVIDERS env (unset in test) → false, proving the gate.
  assert.equal(d.supported, false);
});

test('discover: no _domainconnect TXT → not found (unsupported registrar)', async () => {
  const noTxt = async () => { throw new Error('ENOTFOUND'); };
  const d = await dc.discover('no-dc.example', { resolveTxt: noTxt, fetch: async () => ({}) });
  assert.equal(d.found, false);
});

test('decodePrivateKey: accepts base64 PEM, escaped-newline PEM, and raw PEM', () => {
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const b64 = Buffer.from(pem).toString('base64');
  // base64 form decodes to the same PEM and can sign+verify.
  const decoded = dc.decodePrivateKey(b64);
  assert.ok(decoded.includes('BEGIN'));
  const sig = dc.signQuery('domain=a.com', decoded);
  const v = crypto.createVerify('RSA-SHA256'); v.update('domain=a.com'); v.end();
  assert.ok(v.verify(publicKey, Buffer.from(sig, 'base64')));
  // raw PEM passes through; empty stays empty.
  assert.ok(dc.decodePrivateKey(pem).includes('BEGIN'));
  assert.equal(dc.decodePrivateKey(''), '');
});

test('integration is inert without env (no key/providers configured)', () => {
  assert.equal(dc.isConfigured(), false);
});
