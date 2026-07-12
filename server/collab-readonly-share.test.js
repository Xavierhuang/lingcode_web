'use strict';

// Unit tests for read-only (view-only share link) enforcement in collab-server.js.
// A connection tagged ws._readOnly may WATCH a session (list/attach/detach and
// receive host→client snapshots) but its control frames (lc-agent-cmd,
// lc-serve-request, lc-serve-stdin, lc-serve-host-hello) must be dropped — the
// host must never see them. Drives the REAL frame handlers with fake ws objects.
//
//   node --test collab-readonly-share.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const collab = require('./collab-server');

const { handleServeTunnelFrame, handleAgentFrame, _serveTunnelState } = collab;

function reset() {
  _serveTunnelState.serveHosts.clear();
  _serveTunnelState.serveStreamClients.clear();
  _serveTunnelState.agentClients.clear();
}

function fakeWs(readOnly) {
  return { readyState: 1, _readOnly: !!readOnly, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, on() {} };
}

function host(doc) {
  const h = fakeWs(false);
  handleServeTunnelFrame(h, doc, { type: 'lc-serve-host-hello' });
  h.sent.length = 0;
  return h;
}

test('read-only viewer: lc-agent-cmd is dropped, never reaches the host', () => {
  reset();
  const doc = 'p1::__serve';
  const h = host(doc);
  const viewer = fakeWs(true);

  handleAgentFrame(viewer, doc, { type: 'lc-agent-attach', documentId: 'tab-1' });
  handleAgentFrame(viewer, doc, { type: 'lc-agent-cmd', documentId: 'tab-1', cmd: 'send', text: 'hack' });

  // attach forwards (so the viewer can watch); cmd does NOT.
  assert.deepEqual(h.sent.map((f) => f.type), ['lc-agent-attach']);
});

test('read-only viewer still receives host->client snapshots', () => {
  reset();
  const doc = 'p1::__serve';
  const h = host(doc);
  const viewer = fakeWs(true);
  handleAgentFrame(viewer, doc, { type: 'lc-agent-attach', documentId: 'tab-1' });
  viewer.sent.length = 0;

  handleAgentFrame(h, doc, { type: 'lc-agent-state', documentId: 'tab-1', snapshot: { isStreaming: true } });

  assert.equal(viewer.sent.at(-1).type, 'lc-agent-state');
  assert.equal(viewer.sent.at(-1).snapshot.isStreaming, true);
});

test('read-only viewer: serve-tunnel control frames are dropped', () => {
  reset();
  const doc = 'p1::__serve';
  const h = host(doc);
  const viewer = fakeWs(true);

  handleServeTunnelFrame(viewer, doc, { type: 'lc-serve-request', streamId: 's1', method: 'POST', path: '/v1/agent/ask', body: {} });
  handleServeTunnelFrame(viewer, doc, { type: 'lc-serve-stdin', streamId: 's1', data: 'x' });

  assert.equal(h.sent.length, 0, 'host received no forwarded control frames from a read-only viewer');
  assert.equal(_serveTunnelState.serveStreamClients.has('s1'), false, 'no stream registered for a dropped request');
});

test('read-only viewer cannot register itself as a serve host', () => {
  reset();
  const doc = 'p1::__serve';
  const viewer = fakeWs(true);
  handleServeTunnelFrame(viewer, doc, { type: 'lc-serve-host-hello' });
  assert.equal(_serveTunnelState.serveHosts.has(doc), false, 'read-only hello did not register a host');
});

test('a normal (writable) client is unaffected — cmd still forwards', () => {
  reset();
  const doc = 'p1::__serve';
  const h = host(doc);
  const client = fakeWs(false);
  handleAgentFrame(client, doc, { type: 'lc-agent-cmd', documentId: 'tab-1', cmd: 'send', text: 'hi' });
  assert.deepEqual(h.sent.map((f) => f.type), ['lc-agent-cmd']);
  assert.equal(h.sent[0].text, 'hi');
});
