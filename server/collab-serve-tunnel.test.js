'use strict';

// Unit tests for the remote-coding serve-tunnel routing in collab-server.js.
// Drives the REAL handleServeTunnelFrame / cleanupServeStreamsFor with fake ws
// objects — no y-websocket / HTTP stack needed.
//
//   node --test collab-serve-tunnel.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const collab = require('./collab-server');

const { handleServeTunnelFrame, cleanupServeStreamsFor, _serveTunnelState } = collab;

function reset() {
  _serveTunnelState.serveHosts.clear();
  _serveTunnelState.serveStreamClients.clear();
}

function fakeWs() {
  return {
    readyState: 1, // OPEN
    sent: [],
    send(s) { this.sent.push(JSON.parse(s)); },
    on() {}, // close handler is wired by handleCollabConnection, not exercised here
  };
}

test('host hello registers host and acks', () => {
  reset();
  const doc = 'p1::__serve';
  const host = fakeWs();
  const handled = handleServeTunnelFrame(host, doc, { type: 'lc-serve-host-hello' });
  assert.equal(handled, true);
  assert.equal(_serveTunnelState.serveHosts.get(doc), host);
  assert.equal(host._lcServeHost, true);
  assert.equal(host._lcServeDoc, doc);
  assert.deepEqual(host.sent, [{ type: 'lc-serve-host-ack' }]);
});

test('request forwards to host; responses route back to the originating client; close clears stream', () => {
  reset();
  const doc = 'p1::__serve';
  const host = fakeWs();
  const client = fakeWs();
  handleServeTunnelFrame(host, doc, { type: 'lc-serve-host-hello' });
  host.sent.length = 0;

  handleServeTunnelFrame(client, doc, {
    type: 'lc-serve-request', streamId: 's1', method: 'POST',
    path: '/v1/agent/ask', body: { prompt: 'hi' },
  });
  assert.equal(host.sent.length, 1, 'host receives forwarded request');
  assert.equal(host.sent[0].type, 'lc-serve-request');
  assert.equal(host.sent[0].streamId, 's1');
  assert.equal(_serveTunnelState.serveStreamClients.get('s1').ws, client);

  handleServeTunnelFrame(host, doc, { type: 'lc-serve-response-head', streamId: 's1', status: 200 });
  handleServeTunnelFrame(host, doc, { type: 'lc-serve-response-chunk', streamId: 's1', text: 'event: assistant_text\n' });
  handleServeTunnelFrame(host, doc, { type: 'lc-serve-close', streamId: 's1' });

  assert.deepEqual(client.sent.map((f) => f.type),
    ['lc-serve-response-head', 'lc-serve-response-chunk', 'lc-serve-close']);
  assert.equal(_serveTunnelState.serveStreamClients.has('s1'), false, 'stream cleaned up on close');
});

test('request with no host returns host offline error', () => {
  reset();
  const doc = 'p2::__serve';
  const client = fakeWs();
  handleServeTunnelFrame(client, doc, { type: 'lc-serve-request', streamId: 'x', method: 'GET', path: '/v1/ping' });
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].type, 'lc-serve-error');
  assert.match(client.sent[0].message, /offline/);
});

test('host disconnect is room-scoped: other tenants untouched', () => {
  reset();
  const dA = 'a::__serve', dB = 'b::__serve';
  const hA = fakeWs(), cA = fakeWs(), hB = fakeWs(), cB = fakeWs();
  handleServeTunnelFrame(hA, dA, { type: 'lc-serve-host-hello' });
  handleServeTunnelFrame(hB, dB, { type: 'lc-serve-host-hello' });
  handleServeTunnelFrame(cA, dA, { type: 'lc-serve-request', streamId: 'a1', method: 'GET', path: '/' });
  handleServeTunnelFrame(cB, dB, { type: 'lc-serve-request', streamId: 'b1', method: 'GET', path: '/' });

  cleanupServeStreamsFor(hA); // room A host drops

  assert.ok(cA.sent.some((f) => f.type === 'lc-serve-error'), 'room A client notified');
  assert.equal(_serveTunnelState.serveStreamClients.has('a1'), false, 'room A stream cleared');
  assert.equal(_serveTunnelState.serveStreamClients.has('b1'), true, 'room B stream untouched');
  assert.equal(_serveTunnelState.serveHosts.has(dA), false, 'room A host removed');
  assert.equal(_serveTunnelState.serveHosts.has(dB), true, 'room B host intact');
});

test('client disconnect drops only its own streams', () => {
  reset();
  const doc = 'p3::__serve';
  const host = fakeWs(), c1 = fakeWs(), c2 = fakeWs();
  handleServeTunnelFrame(host, doc, { type: 'lc-serve-host-hello' });
  handleServeTunnelFrame(c1, doc, { type: 'lc-serve-request', streamId: 'one', method: 'GET', path: '/' });
  handleServeTunnelFrame(c2, doc, { type: 'lc-serve-request', streamId: 'two', method: 'GET', path: '/' });

  cleanupServeStreamsFor(c1);

  assert.equal(_serveTunnelState.serveStreamClients.has('one'), false);
  assert.equal(_serveTunnelState.serveStreamClients.has('two'), true);
  assert.equal(_serveTunnelState.serveHosts.get(doc), host, 'host unaffected by a client leaving');
});
