'use strict';

// cloud-totp.js — RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30s step) plus RFC 4648
// base32, implemented on Node's `crypto` alone so MFA needs no extra npm
// dependency (matching the lazy-required bcrypt/jwt philosophy of the data
// plane, but with zero install footprint). Verified against the RFC 6238
// test vectors in test/cloud-totp.test.js.

const crypto = require('crypto');

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32 character');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

// A new random base32 secret (default 20 bytes = 160 bits, the RFC SHA1 size).
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

// HOTP(secret, counter) — RFC 4226 dynamic truncation.
function hotp(secretBase32, counter, digits = 6) {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) |
              (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % (10 ** digits)).padStart(digits, '0');
}

// TOTP for a given time (ms). Defaults to the standard 30s step / 6 digits.
function totp(secretBase32, { time = Date.now(), step = 30, digits = 6 } = {}) {
  return hotp(secretBase32, Math.floor(time / 1000 / step), digits);
}

// Verify a code with ±window steps of clock-drift tolerance (default ±1 step).
// Constant-time string compare to avoid timing leaks on the code.
function verifyTotp(secretBase32, code, { time = Date.now(), step = 30, digits = 6, window = 1 } = {}) {
  const c = String(code || '').trim();
  if (!/^\d+$/.test(c)) return false;
  const counter = Math.floor(time / 1000 / step);
  for (let w = -window; w <= window; w++) {
    const expected = hotp(secretBase32, counter + w, digits);
    if (expected.length === c.length &&
        crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return true;
  }
  return false;
}

// otpauth:// URI for authenticator-app QR codes.
function otpauthUrl({ secret, label, issuer }) {
  const params = new URLSearchParams({ secret, algorithm: 'SHA1', digits: '6', period: '30' });
  if (issuer) params.set('issuer', issuer);
  const prefix = issuer ? encodeURIComponent(issuer) + ':' : '';
  return `otpauth://totp/${prefix}${encodeURIComponent(label || 'user')}?${params.toString()}`;
}

module.exports = { base32Encode, base32Decode, generateSecret, hotp, totp, verifyTotp, otpauthUrl };
