'use strict';

// End-to-end test of the remote-coding serve tunnel:
//   web client  →  real relay routing (collab-server handleServeTunnelFrame)
//               →  real collab-bridge.mjs subprocess (host)
//               →  mock local `lingcode serve` (SSE)
// and back. Proves the wire format + bridge fetch/stream + relay routing together.
//
//   node --test collab-serve-tunnel.e2e.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocketServer, WebSocket } = require('ws');
const { setupWSConnection } = require('y-websocket/bin/utils');
const collab = require('./collab-server');

function waitFor(cond, ms = 5000, label = 'condition') {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let ok = false;
      try { ok = cond(); } catch (_) {}
      if (ok) { clearInterval(iv); res(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout waiting for ' + label)); }
    }, 20);
  });
}

test('tunnelled SSE request flows client → relay → bridge → local serve and back', async () => {
  collab._serveTunnelState.serveHosts.clear();
  collab._serveTunnelState.serveStreamClients.clear();

  // 1. Mock local `lingcode serve` — answers /v1/agent/ask with an SSE stream.
  const serve = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/agent/ask') {
      assert.equal(req.headers.authorization, 'Bearer testtok', 'bridge injects the local bearer token');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: assistant_text\ndata: {"text":"hi"}\n\n');
      res.write('event: query_finished\ndata: {}\n\n');
      res.end();
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((r) => serve.listen(0, r));
  const servePort = serve.address().port;

  // 2. Relay that uses the REAL routing from collab-server.js.
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws, req) => {
    const docName = req.url.split('?')[0];
    // Mirror the real handler: y-websocket owns the Yjs sync protocol so the
    // bridge's WebsocketProvider syncs cleanly; our custom frames ride alongside.
    setupWSConnection(ws, req, { docName, gc: true });
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length === 0 || buf[0] !== 0x7b /* '{' */) return; // skip Yjs binary
      let parsed; try { parsed = JSON.parse(buf.toString('utf8')); } catch { return; }
      if (!parsed || typeof parsed.type !== 'string') return;
      collab.handleServeTunnelFrame(ws, docName, parsed);
    });
    ws.on('close', () => collab.cleanupServeStreamsFor(ws));
  });
  await new Promise((r) => httpServer.listen(0, r));
  const relayPort = httpServer.address().port;
  const uuid = '00000000-0000-4000-8000-000000000000';
  const base = `ws://localhost:${relayPort}/ws/collab`;

  // 3. Spawn the real collab-bridge as the host.
  const bridgePath = path.resolve(__dirname, '../../LingCode/collab-bridge/bridge.mjs');
  const bridge = spawn('node', [bridgePath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [];
  let acc = '';
  bridge.stdout.on('data', (d) => {
    acc += d.toString();
    let i;
    while ((i = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, i); acc = acc.slice(i + 1);
      if (line.trim()) { try { events.push(JSON.parse(line)); } catch (_) {} }
    }
  });
  const sendCmd = (o) => bridge.stdin.write(JSON.stringify(o) + '\n');

  try {
    // The bridge emits `ready` at the END of init, so send init first.
    sendCmd({ type: 'init', roomId: uuid, serverUrl: `${base}/${uuid}`, token: 'x', userId: 'u', displayName: 'Host' });
    await waitFor(() => events.some((e) => e.type === 'ready'), 5000, 'bridge ready');
    sendCmd({ type: 'open_serve_host', servePort, serveToken: 'testtok' });

    // Host should register with the relay (host-hello routed through real routing).
    await waitFor(() => collab._serveTunnelState.serveHosts.size >= 1, 6000, 'host registered');

    // 4. Web client joins the same room and drives a request.
    const client = new WebSocket(`ws://localhost:${relayPort}/ws/collab/${uuid}/__serve`);
    const frames = [];
    await new Promise((res, rej) => { client.on('open', res); client.on('error', rej); });
    client.on('message', (data) => {
      const b = Buffer.from(data);
      if (b.length === 0 || b[0] !== 0x7b) return;
      try { frames.push(JSON.parse(b.toString('utf8'))); } catch (_) {}
    });
    client.send(JSON.stringify({
      type: 'lc-serve-request', streamId: 's1', method: 'POST',
      path: '/v1/agent/ask', body: { prompt: 'hi' },
    }));

    await waitFor(() => frames.some((f) => f.type === 'lc-serve-close'), 6000, 'stream close');

    const head = frames.find((f) => f.type === 'lc-serve-response-head');
    assert.ok(head, 'got response head');
    assert.equal(head.status, 200);
    const text = frames.filter((f) => f.type === 'lc-serve-response-chunk').map((f) => f.text).join('');
    assert.match(text, /assistant_text/, 'SSE body streamed through');
    assert.match(text, /query_finished/);

    client.close();
  } finally {
    sendCmd({ type: 'shutdown' });
    await new Promise((r) => { bridge.on('exit', r); setTimeout(() => { try { bridge.kill(); } catch (_) {} r(); }, 2000); });
    wss.close(); httpServer.close(); serve.close();
  }
});
