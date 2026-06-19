// SSRF-guard tests for safe-fetch.js. These are the security-critical checks:
// private/loopback/link-local/metadata addresses, IP-literal hosts, non-https,
// allow-list enforcement, and redirect-to-internal via DNS must all be refused.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { assertSafeUrl, isPrivateIp, hostAllowed } = require('../safe-fetch.js');

describe('isPrivateIp', () => {
  const priv = ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.1', '192.168.1.1',
    '127.0.0.1', '0.0.0.0', '169.254.169.254', '100.64.0.1', '224.0.0.1',
    '::1', 'fe80::1', 'fc00::1', 'fd12::34', '::ffff:127.0.0.1', '::ffff:10.0.0.1'];
  const pub = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '13.107.42.14',
    '2606:4700:4700::1111', '::ffff:8.8.8.8'];
  for (const ip of priv) test(`private: ${ip}`, () => assert.equal(isPrivateIp(ip), true));
  for (const ip of pub) test(`public: ${ip}`, () => assert.equal(isPrivateIp(ip), false));
});

describe('hostAllowed', () => {
  test('exact + subdomain match', () => {
    assert.equal(hostAllowed('api.elevenlabs.io', ['api.elevenlabs.io']), true);
    assert.equal(hostAllowed('api.elevenlabs.io', ['elevenlabs.io']), true); // subdomain of allowed
    assert.equal(hostAllowed('API.ElevenLabs.io.', ['elevenlabs.io']), true); // case + trailing dot
  });
  test('rejects non-matching + tricky suffixes', () => {
    assert.equal(hostAllowed('evil.com', ['elevenlabs.io']), false);
    assert.equal(hostAllowed('elevenlabs.io.evil.com', ['elevenlabs.io']), false);
    assert.equal(hostAllowed('notelevenlabs.io', ['elevenlabs.io']), false);
    assert.equal(hostAllowed('api.elevenlabs.io', []), false); // empty allow-list denies
  });
});

describe('assertSafeUrl', () => {
  const ALLOW = ['elevenlabs.io', 'api.openai.com'];
  const lookupPublic = async () => [{ address: '8.8.8.8', family: 4 }];
  const lookupPrivate = async () => [{ address: '10.0.0.5', family: 4 }];

  test('allows an https, allow-listed, public-resolving host', async () => {
    const u = await assertSafeUrl('https://api.elevenlabs.io/v1/tts', ALLOW, { lookup: lookupPublic });
    assert.equal(u.hostname, 'api.elevenlabs.io');
  });
  test('rejects http://', async () => {
    await assert.rejects(() => assertSafeUrl('http://api.elevenlabs.io', ALLOW, { lookup: lookupPublic }), /only https/);
  });
  test('rejects host not on the allow-list', async () => {
    await assert.rejects(() => assertSafeUrl('https://evil.com', ALLOW, { lookup: lookupPublic }), /not allow-listed/);
  });
  test('rejects IP-literal host', async () => {
    await assert.rejects(() => assertSafeUrl('https://169.254.169.254/latest/meta-data', ['169.254.169.254'], { lookup: lookupPublic }), /IP-literal/);
  });
  test('rejects allow-listed host that RESOLVES to a private IP (DNS-rebind defense)', async () => {
    await assert.rejects(() => assertSafeUrl('https://api.elevenlabs.io/x', ALLOW, { lookup: lookupPrivate }), /non-public address/);
  });
  test('rejects when one of several resolved IPs is private', async () => {
    const mixed = async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }];
    await assert.rejects(() => assertSafeUrl('https://api.openai.com/v1', ALLOW, { lookup: mixed }), /non-public address/);
  });
  test('rejects a malformed URL', async () => {
    await assert.rejects(() => assertSafeUrl('not a url', ALLOW, { lookup: lookupPublic }), /invalid URL/);
  });
});
