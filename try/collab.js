// collab.js — Real-time collaboration core for /try.
// Connects to the server's WebSocket collab room (one room = one saved prototype).
// Uses Yjs + y-websocket for CRDT-based sync of inline edits, knowledge files,
// and site-config. Awareness protocol handles live presence.

// Self-hosted bundle (esm.sh's ?external=yjs failed to dedupe transitively;
// the page ended up loading yjs@13.6.18 alongside yjs@13.6.30 via the
// non-externalized y-websocket variant). y-bundle.js is built locally with
// esbuild from the same yjs/y-websocket versions pinned in server/package.json,
// guaranteeing a single Yjs instance. Rebuild with the script in
// server/build-y-bundle.sh after upgrading yjs or y-websocket.
import { Y, WebsocketProvider } from './lib/y-bundle.js?v=20260602d';

const WS_BASE = window.location.protocol === 'https:'
  ? `wss://${window.location.host}`
  : `ws://${window.location.host}`;

let _ydoc = null;
let _provider = null;
let _myRole = null;
let _roomEventListeners = [];
let _ws = null; // underlying WebSocket from provider
let _statusBadge = null;

// ── Connection status badge ──────────────────────────────────────────────────
// Small floating pill in the top-right corner that surfaces WS state. Hidden
// when connected; shows "Reconnecting…" / "Connecting…" otherwise. Yjs queues
// edits during a disconnect and replays on reconnect, so users keep editing —
// the badge just lets them know why presence/comments may be momentarily stale.

function ensureStatusBadge() {
  if (_statusBadge) return _statusBadge;
  _statusBadge = document.createElement('div');
  _statusBadge.id = 'lc-collab-status';
  _statusBadge.style.cssText = [
    'position:fixed', 'top:14px', 'right:14px',
    'background:#fff', 'border:1px solid #e5e7eb', 'border-radius:20px',
    'padding:5px 12px', 'font-size:11px', 'font-weight:600',
    'font-family:system-ui,sans-serif', 'color:#374151',
    'box-shadow:0 2px 8px rgba(0,0,0,.08)', 'z-index:10000',
    'display:none', 'align-items:center', 'gap:6px',
  ].join(';');
  document.body.appendChild(_statusBadge);
  return _statusBadge;
}

function showStatus(text, color) {
  const el = ensureStatusBadge();
  el.style.display = 'flex';
  el.innerHTML = `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};"></span><span>${text}</span>`;
}

function hideStatus() {
  if (_statusBadge) _statusBadge.style.display = 'none';
}

/**
 * Connect to the collab room for a saved prototype.
 * Returns a promise that resolves once the room role is received.
 * @param {string} prototypeId
 * @returns {Promise<'owner'|'editor'|'viewer'>}
 */
export function initCollab(prototypeId) {
  disconnectCollab();

  _ydoc = new Y.Doc();
  _provider = new WebsocketProvider(
    `${WS_BASE}/ws/collab`,
    prototypeId,
    _ydoc,
    { connect: true }
  );

  // The provider exposes the underlying WebSocket via _provider.ws
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) reject(new Error('collab: connection timeout'));
    }, 10000);

    function onMessage(evt) {
      if (typeof evt.data !== 'string') return;
      let parsed;
      try { parsed = JSON.parse(evt.data); } catch { return; }
      if (!parsed || parsed.type !== 'lc-collab-meta') return;

      _myRole = parsed.role;
      // Relay to room event listeners too
      _roomEventListeners.forEach((cb) => cb(parsed));

      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(parsed.role);
      }
    }

    function attachMessageListener() {
      const ws = _provider.ws;
      if (!ws) return;
      _ws = ws;
      ws.addEventListener('message', onMessage);

      // Forward custom JSON room events to listeners
      ws.addEventListener('message', (evt) => {
        if (typeof evt.data !== 'string') return;
        let parsed;
        try { parsed = JSON.parse(evt.data); } catch { return; }
        if (!parsed || parsed.type === 'lc-collab-meta') return; // already handled above
        _roomEventListeners.forEach((cb) => cb(parsed));
      });
    }

    // WebsocketProvider may connect immediately or after a tick
    if (_provider.ws && _provider.ws.readyState !== WebSocket.CLOSED) {
      attachMessageListener();
    } else {
      _provider.once('status', ({ status }) => {
        if (status === 'connected') attachMessageListener();
      });
    }

    _provider.on('status', ({ status }) => {
      if (status === 'connected') {
        if (!_ws) attachMessageListener();
        hideStatus();
      } else if (status === 'connecting') {
        showStatus('Connecting…', '#9ca3af');
      } else if (status === 'disconnected') {
        showStatus('Reconnecting…', '#f59e0b');
      }
    });
  });
}

/** @returns {Y.Doc|null} */
export function getYDoc() { return _ydoc; }

/** @returns {import('y-protocols/awareness').Awareness|null} */
export function getAwareness() { return _provider ? _provider.awareness : null; }

/** @returns {'owner'|'editor'|'viewer'|null} */
export function getMyRole() { return _myRole; }

/** @returns {boolean} */
export function isEditor() { return _myRole === 'owner' || _myRole === 'editor'; }

/**
 * Register a listener for custom room events (comment broadcasts, cursor events, etc.)
 * @param {function(object): void} callback
 */
export function onRoomEvent(callback) {
  _roomEventListeners.push(callback);
}

/**
 * Send a custom JSON message through the collab WebSocket.
 * @param {object} payload
 */
export function sendRoomEvent(payload) {
  const ws = _provider && _provider.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(payload)); } catch (_) {}
}

/** Tear down the collab session. */
export function disconnectCollab() {
  _roomEventListeners = [];
  _myRole = null;
  _ws = null;
  if (_provider) {
    try { _provider.disconnect(); } catch (_) {}
    _provider = null;
  }
  if (_ydoc) {
    _ydoc.destroy();
    _ydoc = null;
  }
  if (_statusBadge && _statusBadge.parentElement) {
    _statusBadge.parentElement.removeChild(_statusBadge);
  }
  _statusBadge = null;
}
