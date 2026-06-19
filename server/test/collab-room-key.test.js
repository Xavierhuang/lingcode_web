'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCollabRoomKey } = require('../collab-server.js');

test('legacy /ws/collab/<protoId> parses with default fileId="_main"', () => {
  const r = parseCollabRoomKey('/ws/collab/3fa85f64-5717-4562-b3fc-2c963f66afa6');
  assert.ok(r, 'expected a result');
  assert.equal(r.prototypeId, '3fa85f64-5717-4562-b3fc-2c963f66afa6');
  assert.equal(r.fileId, '_main');
});

test('legacy URL with query string keeps default fileId', () => {
  const r = parseCollabRoomKey('/ws/collab/3fa85f64-5717-4562-b3fc-2c963f66afa6?token=abc');
  assert.ok(r);
  assert.equal(r.prototypeId, '3fa85f64-5717-4562-b3fc-2c963f66afa6');
  assert.equal(r.fileId, '_main');
});

test('new /ws/collab/<protoId>/<fileId> parses both, URL-decodes fileId', () => {
  const r = parseCollabRoomKey('/ws/collab/3fa85f64-5717-4562-b3fc-2c963f66afa6/src%2Ffoo.swift');
  assert.ok(r);
  assert.equal(r.prototypeId, '3fa85f64-5717-4562-b3fc-2c963f66afa6');
  assert.equal(r.fileId, 'src/foo.swift');
});

test('new URL form with query string still works', () => {
  const r = parseCollabRoomKey('/ws/collab/3fa85f64-5717-4562-b3fc-2c963f66afa6/README.md?token=xyz');
  assert.ok(r);
  assert.equal(r.prototypeId, '3fa85f64-5717-4562-b3fc-2c963f66afa6');
  assert.equal(r.fileId, 'README.md');
});

test('non-UUID prototypeId is rejected', () => {
  assert.equal(parseCollabRoomKey('/ws/collab/not-a-uuid'), null);
  assert.equal(parseCollabRoomKey('/ws/collab/not-a-uuid/foo.swift'), null);
});

test('non-matching path returns null', () => {
  assert.equal(parseCollabRoomKey('/ws/other'), null);
  assert.equal(parseCollabRoomKey('/api/foo'), null);
  assert.equal(parseCollabRoomKey(''), null);
});
