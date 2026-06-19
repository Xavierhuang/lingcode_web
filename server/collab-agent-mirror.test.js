'use strict';

// Unit tests for the live-session mirror routing (lc-agent-*) in collab-server.js.
// Drives the REAL handleAgentFrame / handleServeTunnelFrame / cleanupServeStreamsFor
// with fake ws objects — no y-websocket / HTTP stack needed.
//
//   node --test collab-agent-mirror.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const collab = require('./collab-server');

const { handleServeTunnelFrame, handleAgentFrame, cleanupServeStreamsFor, _serveTunnelState } = collab;

function reset() {
  _serveTunnelState.serveHosts.clear();
  _serveTunnelState.serveStreamClients.clear();
  _serveTunnelState.agentClients.clear();
}

function fakeWs() {
  return { readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, on() {} };
}

/** Register a host for `doc` and return its fake ws (clears the hello-ack). */
function host(doc) {
  const h = fakeWs();
  handleServeTunnelFrame(h, doc, { type: 'lc-serve-host-hello' });
  h.sent.length = 0;
  return h;
}

test('client agent frames forward to the room host; client is tracked', () => {
  reset();
  const doc = 'p1::__serve';
  const h = host(doc);
  const client = fakeWs();

  handleAgentFrame(client, doc, { type: 'lc-agent-list' });
  handleAgentFrame(client, doc, { type: 'lc-agent-attach', documentId: 'tab-1' });
  handleAgentFrame(client, doc, { type: 'lc-agent-cmd', documentId: 'tab-1', cmd: 'send', text: 'hi' });

  assert.deepEqual(h.sent.map((f) => f.type), ['lc-agent-list', 'lc-agent-attach', 'lc-agent-cmd']);
  assert.equal(h.sent[2].text, 'hi');
  assert.ok(_serveTunnelState.agentClients.get(doc).has(client));
});

test('host state/list-result broadcast to attached clients, not back to host', () => {
  reset();
  const doc = 'p1::__serve';
  const h = host(doc);
  const c1 = fakeWs(), c2 = fakeWs();
  handleAgentFrame(c1, doc, { type: 'lc-agent-attach', documentId: 'tab-1' });
  handleAgentFrame(c2, doc, { type: 'lc-agent-attach', documentId: 'tab-1' });
  h.sent.length = 0;

  handleAgentFrame(h, doc, { type: 'lc-agent-state', documentId: 'tab-1', snapshot: { isStreaming: true } });

  assert.equal(c1.sent.at(-1).type, 'lc-agent-state');
  assert.equal(c2.sent.at(-1).type, 'lc-agent-state');
  assert.equal(c1.sent.at(-1).snapshot.isStreaming, true);
  assert.equal(h.sent.length, 0, 'host does not receive its own broadcast');
});

test('agent frame with no host returns host offline to the client', () => {
  reset();
  const doc = 'p2::__serve';
  const client = fakeWs();
  handleAgentFrame(client, doc, { type: 'lc-agent-attach', documentId: 'x' });
  assert.equal(client.sent.at(-1).type, 'lc-agent-error');
  assert.match(client.sent.at(-1).message, /offline/);
});

test('host disconnect notifies attached agent clients (room-scoped)', () => {
  reset();
  const dA = 'a::__serve', dB = 'b::__serve';
  const hA = host(dA), hB = host(dB);
  const cA = fakeWs(), cB = fakeWs();
  handleAgentFrame(cA, dA, { type: 'lc-agent-attach', documentId: 't' });
  handleAgentFrame(cB, dB, { type: 'lc-agent-attach', documentId: 't' });

  cleanupServeStreamsFor(hA); // room A host drops

  assert.equal(cA.sent.at(-1).type, 'lc-agent-error', 'room A client notified');
  assert.ok(!cB.sent.some((f) => f.type === 'lc-agent-error'), 'room B client untouched');
  assert.equal(_serveTunnelState.serveHosts.has(dA), false);
  assert.equal(_serveTunnelState.serveHosts.has(dB), true);
});

test('client disconnect removes it from the room agent set', () => {
  reset();
  const doc = 'p3::__serve';
  const h = host(doc);
  const c1 = fakeWs(), c2 = fakeWs();
  handleAgentFrame(c1, doc, { type: 'lc-agent-attach', documentId: 't' });
  handleAgentFrame(c2, doc, { type: 'lc-agent-attach', documentId: 't' });

  cleanupServeStreamsFor(c1);

  const set = _serveTunnelState.agentClients.get(doc);
  assert.ok(!set.has(c1));
  assert.ok(set.has(c2));
  // A subsequent host broadcast reaches only c2.
  handleAgentFrame(h, doc, { type: 'lc-agent-state', documentId: 't', snapshot: {} });
  assert.equal(c2.sent.at(-1).type, 'lc-agent-state');
});
