'use strict';

// domainconnect-keygen.js — one-off generator for the Domain Connect signing
// keypair. Prints (a) the PRIVATE key for LINGCODE_DC_PRIVATE_KEY in .env, and
// (b) the public-key TXT record value to publish at <KEY_ID>.<PUBKEY_DOMAIN>.
//
// Usage:  node domainconnect-keygen.js [keyId]
// The provider (GoDaddy) fetches the public key from DNS to verify our signed
// apply requests, so the TXT must be live before the flow works.

const crypto = require('crypto');

const keyId = process.argv[2] || '1';
const pubDomain = process.env.LINGCODE_DC_PUBKEY_DOMAIN || '_dck.lingcode.dev';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Domain Connect public-key TXT: p=<seq>,a=RS256,d=<base64 SPKI DER>
const txtValue = `p=1,a=RS256,d=${Buffer.from(publicKey).toString('base64')}`;

// base64 single-line is systemd/.env-safe (no newlines); the app decodes it.
const privB64 = Buffer.from(privateKey).toString('base64');
console.log('=== 1) PRIVATE KEY — put in /opt/lingcode-api/.env as LINGCODE_DC_PRIVATE_KEY ===');
console.log('(base64, single line — the server decodes it automatically)');
console.log(`LINGCODE_DC_PRIVATE_KEY=${privB64}`);
console.log('\n=== 2) PUBLIC KEY TXT RECORD — publish in DNS ===');
console.log(`name:  ${keyId}.${pubDomain}`);
console.log(`type:  TXT`);
console.log(`value: ${txtValue}`);
console.log('\n=== 3) matching .env hints ===');
console.log(`LINGCODE_DC_KEY_ID=${keyId}`);
console.log(`LINGCODE_DC_PUBKEY_DOMAIN=${pubDomain}`);
