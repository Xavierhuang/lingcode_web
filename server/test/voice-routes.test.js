'use strict';

// voice-routes.test.js — the pure logic of the voice proxy.
//
// What's covered: the two things that silently break a voice demo.
//   1. extractAudio — vendors return either raw audio bytes or base64 inside
//      JSON. Get this wrong and the webview receives JSON, <audio> refuses it,
//      and the user just hears nothing with no error anywhere.
//   2. opaqueUpstreamError — the guarantee that no upstream failure leaks the
//      speech vendor's identity into anything a user can see.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ALLOWED_AUDIO, MAX_TTS_CHARS,
  opaqueUpstreamError, authHeader, extractAudio, sniffAudio, parseShaped,
} = require('../voice-routes');

// ── authHeader ─────────────────────────────────────────────────────────────

test('authHeader defaults to Bearer', () => {
  assert.deepEqual(authHeader('k'), { authorization: 'Bearer k' });
  assert.deepEqual(authHeader('k', ''), { authorization: 'Bearer k' });
});

test('authHeader honours Basic without re-encoding the key', () => {
  // Vendor keys are often already-base64 blobs. Re-encoding them silently 401s.
  const key = 'YWxyZWFkeS1iYXNlNjQ=';
  assert.deepEqual(authHeader(key, 'Basic'), { authorization: `Basic ${key}` });
});

test('authHeader omits the header entirely with no key', () => {
  assert.deepEqual(authHeader(''), {});
  assert.deepEqual(authHeader(null), {});
});

// ── sniffAudio ─────────────────────────────────────────────────────────────

test('sniffAudio identifies containers from magic bytes', () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(4)]);
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(16)]);
  const flac = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(16)]);
  const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.alloc(8)]);
  const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]);
  const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(16)]);

  assert.equal(sniffAudio(wav), 'audio/wav');
  assert.equal(sniffAudio(ogg), 'audio/ogg');
  assert.equal(sniffAudio(flac), 'audio/flac');
  assert.equal(sniffAudio(mp4), 'audio/mp4');
  assert.equal(sniffAudio(id3), 'audio/mpeg');
  assert.equal(sniffAudio(mp3), 'audio/mpeg');
});

test('sniffAudio falls back rather than throwing on a short buffer', () => {
  assert.equal(sniffAudio(Buffer.alloc(2)), 'audio/mpeg');
});

// ── extractAudio ───────────────────────────────────────────────────────────

test('extractAudio passes raw audio straight through', () => {
  const buf = Buffer.from('not really audio but the header says so');
  const got = extractAudio(buf, 'audio/mpeg');
  assert.equal(got.contentType, 'audio/mpeg');
  assert.equal(got.buf, buf);
});

test('extractAudio normalises the content-type case', () => {
  assert.equal(extractAudio(Buffer.from('x'), 'AUDIO/WAV').contentType, 'audio/wav');
});

test('extractAudio decodes base64 audio out of a JSON body', () => {
  // The shape that would otherwise reach <audio> as JSON and play nothing.
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(200)]);
  const body = Buffer.from(JSON.stringify({ audioContent: wav.toString('base64') }));
  const got = extractAudio(body, 'application/json');
  assert.ok(got, 'should have found audio');
  assert.equal(got.contentType, 'audio/wav');
  assert.deepEqual(got.buf, wav);
});

test('extractAudio accepts the alternate JSON key spellings', () => {
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200)]);
  for (const key of ['audioContent', 'audio_content', 'audioData', 'audio', 'data', 'content']) {
    const body = Buffer.from(JSON.stringify({ [key]: mp3.toString('base64') }));
    const got = extractAudio(body, 'application/json');
    assert.ok(got, `key ${key} should be recognised`);
    assert.deepEqual(got.buf, mp3, `key ${key} decoded wrong`);
  }
});

test('extractAudio looks one level into result{}', () => {
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200)]);
  const body = Buffer.from(JSON.stringify({ result: { audioContent: mp3.toString('base64') } }));
  assert.ok(extractAudio(body, 'application/json'));
});

test('extractAudio unwraps a data: URI', () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(200)]);
  const uri = `data:audio/wav;base64,${wav.toString('base64')}`;
  const body = Buffer.from(JSON.stringify({ audio: uri }));
  const got = extractAudio(body, 'application/json');
  assert.ok(got);
  assert.equal(got.contentType, 'audio/wav');
  assert.deepEqual(got.buf, wav);
});

test('extractAudio returns null when there is no audio to find', () => {
  assert.equal(extractAudio(Buffer.from(JSON.stringify({ error: 'nope' })), 'application/json'), null);
  assert.equal(extractAudio(Buffer.from('<html>error page</html>'), 'text/html'), null);
  // A short base64-ish string is not audio; the length guard prevents treating
  // an ordinary field like {"data":"ok"} as a 2-byte audio file.
  assert.equal(extractAudio(Buffer.from(JSON.stringify({ data: 'ok' })), 'application/json'), null);
});

// ── opaqueUpstreamError ────────────────────────────────────────────────────

test('opaqueUpstreamError maps status classes to actionable codes', () => {
  assert.equal(opaqueUpstreamError(401), 'voice_service_unavailable');
  assert.equal(opaqueUpstreamError(403), 'voice_service_unavailable');
  assert.equal(opaqueUpstreamError(429), 'voice_rate_limited');
  assert.equal(opaqueUpstreamError(500), 'voice_service_unavailable');
  assert.equal(opaqueUpstreamError(503), 'voice_service_unavailable');
  assert.equal(opaqueUpstreamError(400), 'voice_request_failed');
  assert.equal(opaqueUpstreamError(418), 'voice_request_failed');
});

test('every error code comes from the fixed set', () => {
  // An allow-list, not a block-list of vendor names: block-listing would mean
  // writing the vendor's name into the repo to test that it never appears.
  // Mirrored by the same assertion in the Rust client.
  const allowed = new Set([
    'voice_service_unavailable', 'voice_rate_limited', 'voice_request_failed',
  ]);
  for (const status of [200, 400, 401, 403, 404, 418, 429, 500, 502, 503]) {
    const code = opaqueUpstreamError(status);
    assert.ok(allowed.has(code), `status ${status} produced an unexpected code: ${code}`);
    assert.match(code, /^voice_[a-z_]+$/, `status ${status} is off-pattern: ${code}`);
  }
});

// ── contract constants ─────────────────────────────────────────────────────

test('the accepted audio set covers what WebView2 actually records', () => {
  // The spike reports the chosen MediaRecorder mime type; WebView2 lands on
  // webm/opus, so that one is load-bearing.
  assert.ok(ALLOWED_AUDIO.has('audio/webm'), 'audio/webm must be accepted');
  assert.ok(ALLOWED_AUDIO.has('audio/ogg'));
  assert.ok(ALLOWED_AUDIO.has('audio/mp4'));
});

test('the TTS character cap matches the Rust client', () => {
  // src-tauri/src/voice.rs asserts the same number. If they drift, the server
  // 413s and the user hears silence with no visible error.
  assert.equal(MAX_TTS_CHARS, 1200);
});

// ── parseShaped ────────────────────────────────────────────────────────────

test('parseShaped reads clean JSON', () => {
  const got = parseShaped('{"prompt":"Add email OTP login","summary":"Switching login to email codes"}', 'raw');
  assert.equal(got.prompt, 'Add email OTP login');
  assert.equal(got.summary, 'Switching login to email codes');
  assert.ok(!got.degraded);
});

test('parseShaped survives a fenced code block', () => {
  // The single most common real-world shape.
  const reply = 'Sure!\n```json\n{"prompt":"Do X","summary":"Doing X"}\n```\nHope that helps.';
  const got = parseShaped(reply, 'raw');
  assert.equal(got.prompt, 'Do X');
  assert.equal(got.summary, 'Doing X');
});

test('parseShaped handles braces and escaped quotes inside strings', () => {
  const reply = '{"prompt":"Replace {a} with \\"b\\" in config","summary":"Swap a for b"}';
  const got = parseShaped(reply, 'raw');
  assert.equal(got.prompt, 'Replace {a} with "b" in config');
  assert.equal(got.summary, 'Swap a for b');
});

test('parseShaped handles a nested object without truncating early', () => {
  const reply = '{"prompt":"Do X","summary":"Doing X","meta":{"a":{"b":1}}}';
  assert.equal(parseShaped(reply, 'raw').prompt, 'Do X');
});

test('parseShaped falls back to the transcript rather than losing the turn', () => {
  for (const bad of ['', '   ', 'no json here', '{"broken":', null, undefined, 42,
                     '{"summary":"only a summary"}']) {
    const got = parseShaped(bad, 'what I said');
    assert.equal(got.prompt, 'what I said', `bad input ${JSON.stringify(bad)} lost the prompt`);
    assert.ok(got.degraded, 'fallback must be flagged degraded');
  }
});

test('parseShaped defaults a missing summary to the prompt', () => {
  const got = parseShaped('{"prompt":"Do X"}', 'raw');
  assert.equal(got.prompt, 'Do X');
  assert.equal(got.summary, 'Do X');
});

test('parseShaped clamps a spoken summary to a listenable length', () => {
  const long = 'x'.repeat(400);
  const got = parseShaped(JSON.stringify({ prompt: 'p', summary: long }), 'raw');
  assert.ok(got.summary.length <= 201, `summary too long to speak: ${got.summary.length}`);
  assert.ok(got.summary.endsWith('…'));
});
