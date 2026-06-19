// Validates the home-grown TOTP against the RFC 6238 SHA1 test vectors and
// checks base32 round-tripping + the drift window. If these pass, the MFA
// factor verification is RFC-correct without an external otp library.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const totp = require('../cloud-totp.js');

// RFC 6238 Appendix B uses the ASCII seed "12345678901234567890" for SHA1.
const SEED_ASCII = '12345678901234567890';
const SECRET = totp.base32Encode(Buffer.from(SEED_ASCII, 'ascii'));

describe('base32', () => {
  test('round-trips arbitrary bytes', () => {
    const buf = Buffer.from([0, 1, 2, 250, 255, 128, 64]);
    assert.deepEqual(totp.base32Decode(totp.base32Encode(buf)), buf);
  });
  test('decodes the RFC seed back to ASCII', () => {
    assert.equal(totp.base32Decode(SECRET).toString('ascii'), SEED_ASCII);
  });
});

describe('TOTP — RFC 6238 vectors (SHA1, 6 digits)', () => {
  // Time (s) → 8-digit code; the 6-digit code is the last 6 digits.
  const VECTORS = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [secs, eight] of VECTORS) {
    test(`t=${secs}`, () => {
      const code = totp.totp(SECRET, { time: secs * 1000 });
      assert.equal(code, eight.slice(-6));
    });
  }
});

describe('verifyTotp', () => {
  test('accepts the current code', () => {
    const t = 1111111109 * 1000;
    assert.equal(totp.verifyTotp(SECRET, totp.totp(SECRET, { time: t }), { time: t }), true);
  });
  test('accepts a code one step in the past (drift window)', () => {
    const t = 1111111109 * 1000;
    const prev = totp.totp(SECRET, { time: t - 30000 });
    assert.equal(totp.verifyTotp(SECRET, prev, { time: t }), true);
  });
  test('rejects a code outside the window', () => {
    const t = 1111111109 * 1000;
    const far = totp.totp(SECRET, { time: t - 120000 });
    assert.equal(totp.verifyTotp(SECRET, far, { time: t }), false);
  });
  test('rejects garbage', () => {
    assert.equal(totp.verifyTotp(SECRET, 'abc', {}), false);
    assert.equal(totp.verifyTotp(SECRET, '', {}), false);
  });
});

describe('otpauthUrl', () => {
  test('encodes secret + issuer', () => {
    const url = totp.otpauthUrl({ secret: SECRET, label: 'a@b.com', issuer: 'LingCode' });
    assert.match(url, /^otpauth:\/\/totp\/LingCode:a%40b\.com\?/);
    assert.match(url, /secret=/);
    assert.match(url, /issuer=LingCode/);
  });
});
