// updates-push.js
//
// Real-time "a new app release shipped" push over SSE. Lets running LingCode
// instances re-check Sparkle within seconds of a release instead of waiting for
// their daily poll. The SSE event is only a *poke* — the app responds by running
// a Sparkle background check, and Sparkle does the real version comparison against
// the live appcast.xml, so pokes are idempotent and safe to send liberally.
//
//   GET  /api/updates/stream    public SSE; apps subscribe for the app's lifetime
//   POST /api/updates/announce  release-script only (Bearer RELEASE_ANNOUNCEMENT_TOKEN)
//
// SSE shape mirrors the realtime endpoints in cloud-backend.js (event-stream
// headers, `retry`, `: connected`, 25s `: ping` heartbeat, cleanup on close).

const { EventEmitter } = require('events');

// Module-level fan-out bus. setMaxListeners(0) — one listener per connected app,
// could be many. Same pattern as cloud-data-plane's realtimeBus.
const bus = new EventEmitter();
bus.setMaxListeners(0);

// Last announced release, replayed to apps that connect just after an announce
// (e.g. they reconnected mid-release) so they still catch up. In-memory only:
// resets on API restart, which is fine — the app's daily Sparkle poll is the
// durable backstop.
let lastAnnounced = null;

function registerUpdatePushRoutes(app) {
  // ── Public SSE stream ────────────────────────────────────────────────
  app.get('/api/updates/stream', (req, res) => {
    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache, no-transform');
    res.set('Connection', 'keep-alive');
    res.set('X-Accel-Buffering', 'no'); // disable nginx proxy buffering
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');

    // Replay the most recent announcement so a late/reconnecting app still pokes.
    if (lastAnnounced) {
      try { res.write(`event: update\ndata: ${JSON.stringify(lastAnnounced)}\n\n`); } catch (_) {}
    }

    const onUpdate = (payload) => {
      try { res.write(`event: update\ndata: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
    };
    bus.on('update', onUpdate);

    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
    const cleanup = () => { clearInterval(heartbeat); bus.removeListener('update', onUpdate); };
    req.on('close', cleanup);
    req.on('aborted', cleanup);
  });

  // ── Release announce (protected) ─────────────────────────────────────
  app.post('/api/updates/announce', (req, res) => {
    const token = process.env.RELEASE_ANNOUNCEMENT_TOKEN;
    if (!token) {
      return res.status(503).json({ ok: false, error: 'announce_disabled', detail: 'RELEASE_ANNOUNCEMENT_TOKEN not set on server' });
    }
    const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (provided !== token) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const body = req.body || {};
    const payload = {
      version: body.version ? String(body.version) : undefined,
      build: body.build ? String(body.build) : undefined,
      url: body.url ? String(body.url) : undefined,
      notes: body.notes ? String(body.notes) : undefined,
      at: new Date().toISOString(),
    };
    lastAnnounced = payload;
    bus.emit('update', payload);

    const clients = bus.listenerCount('update');
    console.log(`[updates-push] announced version=${payload.version} build=${payload.build} → ${clients} client(s)`);
    return res.json({ ok: true, clients });
  });
}

module.exports = { registerUpdatePushRoutes };
