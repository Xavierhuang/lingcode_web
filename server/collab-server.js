'use strict';

const { WebSocketServer } = require('ws');
const Y = require('yjs');
const { setupWSConnection, setPersistence, docs: ywsDocs } = require('y-websocket/bin/utils');
const { getUserFromRequest } = require('./auth-helpers');

// ── Room key parsing ──────────────────────────────────────────────────────────

// Default fileId for legacy single-file collab sessions (before multi-file
// support landed). All historical rows in collab_ydoc_state / collab_history
// migrate to this fileId so legacy URLs and old clients keep working.
const LEGACY_FILE_ID = '_main';

// Composite-key separator used inside y-websocket's docName. POSIX file paths
// don't contain '::' and UUIDs don't contain ':', so this is safe to split on.
const DOC_NAME_SEP = '::';

const COLLAB_URL_RE = /^\/ws\/collab\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/([^/?]+))?(?:\?.*)?$/i;

/**
 * Parse a WS URL of either form:
 *   /ws/collab/<UUID>                 (legacy — fileId defaults to '_main')
 *   /ws/collab/<UUID>/<urlEncFileId>  (multi-file)
 *
 * Returns { prototypeId, fileId } or null when the URL doesn't match.
 * @param {string} urlPath
 */
function parseCollabRoomKey(urlPath) {
  if (typeof urlPath !== 'string' || urlPath.length === 0) return null;
  const m = urlPath.match(COLLAB_URL_RE);
  if (!m) return null;
  let fileId = LEGACY_FILE_ID;
  if (m[2]) {
    try { fileId = decodeURIComponent(m[2]); }
    catch (_) { return null; }
  }
  return { prototypeId: m[1], fileId };
}

/**
 * Pack a (prototypeId, fileId) pair into the docName y-websocket uses
 * internally. The same encoding is used as the room name for broadcastToRoom.
 */
function makeDocName(prototypeId, fileId) {
  return `${prototypeId}${DOC_NAME_SEP}${fileId || LEGACY_FILE_ID}`;
}

/**
 * Reverse of makeDocName. Legacy docNames (bare prototypeId, no separator)
 * map to fileId='_main' so the persistence layer can handle both forms
 * transparently during/after migration.
 */
function splitDocName(docName) {
  if (typeof docName !== 'string') return { prototypeId: '', fileId: LEGACY_FILE_ID };
  const i = docName.indexOf(DOC_NAME_SEP);
  if (i === -1) return { prototypeId: docName, fileId: LEGACY_FILE_ID };
  return { prototypeId: docName.slice(0, i), fileId: docName.slice(i + DOC_NAME_SEP.length) };
}

// ── Role helpers ──────────────────────────────────────────────────────────────

/** @param {string} userId @param {string} prototypeId @param {import('better-sqlite3').Database} db */
function getUserRole(userId, prototypeId, db) {
  const row = db.prepare('SELECT role FROM collab_members WHERE prototype_id = ? AND user_id = ?').get(prototypeId, userId);
  return row ? row.role : null;
}

// ── Persistence (SQLite-backed Y.Doc state) ───────────────────────────────────

// Per-room update batches for history: { prototypeId → { userId → Uint8Array[] } }
const pendingUpdates = new Map();
const HISTORY_FLUSH_MS = 2000;
const SNAPSHOT_DEBOUNCE_MS = 2000;

// Returns initials from a display name
function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Wire up SQLite persistence for y-websocket. Call once at startup (after db is ready).
 * @param {import('better-sqlite3').Database} db
 */
function initPersistence(db) {
  // Snapshot timers keyed by docName
  const snapshotTimers = new Map();
  // History flush timers keyed by docName
  const historyTimers = new Map();

  function scheduleSnapshot(docName, ydoc) {
    if (snapshotTimers.has(docName)) clearTimeout(snapshotTimers.get(docName));
    snapshotTimers.set(docName, setTimeout(() => {
      snapshotTimers.delete(docName);
      const { prototypeId, fileId } = splitDocName(docName);
      const state = Y.encodeStateAsUpdate(ydoc);
      db.prepare('INSERT OR REPLACE INTO collab_ydoc_state (prototype_id, file_id, state_blob, updated_at) VALUES (?, ?, ?, ?)')
        .run(prototypeId, fileId, Buffer.from(state), Date.now());
    }, SNAPSHOT_DEBOUNCE_MS));
  }

  function flushHistory(docName) {
    historyTimers.delete(docName);
    const room = pendingUpdates.get(docName);
    if (!room) return;
    pendingUpdates.delete(docName);
    const { prototypeId, fileId } = splitDocName(docName);
    const stmt = db.prepare('INSERT INTO collab_history (prototype_id, file_id, user_id, update_blob, server_ts) VALUES (?, ?, ?, ?, ?)');
    const insertMany = db.transaction((entries) => {
      for (const { userId, merged } of entries) {
        stmt.run(prototypeId, fileId, userId || null, Buffer.from(merged), Date.now());
      }
    });
    const entries = [];
    for (const [userId, updates] of Object.entries(room)) {
      const merged = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
      entries.push({ userId: userId === '_anon' ? null : userId, merged });
    }
    if (entries.length > 0) insertMany(entries);
  }

  function scheduleHistoryFlush(docName) {
    if (historyTimers.has(docName)) return; // already pending
    historyTimers.set(docName, setTimeout(() => flushHistory(docName), HISTORY_FLUSH_MS));
  }

  setPersistence({
    bindState: (docName, ydoc) => {
      const { prototypeId, fileId } = splitDocName(docName);
      // Load existing state from SQLite
      const row = db.prepare('SELECT state_blob FROM collab_ydoc_state WHERE prototype_id = ? AND file_id = ?').get(prototypeId, fileId);
      if (row && row.state_blob) {
        try {
          Y.applyUpdate(ydoc, new Uint8Array(row.state_blob));
        } catch (e) {
          console.error('[collab] Failed to apply persisted state for', docName, e.message);
        }
      }

      // On every update: batch into history + schedule snapshot
      ydoc.on('update', (update, origin) => {
        const userId = origin && origin._collabUserId ? origin._collabUserId : '_anon';
        let room = pendingUpdates.get(docName);
        if (!room) { room = {}; pendingUpdates.set(docName, room); }
        if (!room[userId]) room[userId] = [];
        room[userId].push(update);
        scheduleHistoryFlush(docName);
        scheduleSnapshot(docName, ydoc);
      });
    },

    writeState: (docName, ydoc) => {
      // Final write when all connections close
      if (snapshotTimers.has(docName)) {
        clearTimeout(snapshotTimers.get(docName));
        snapshotTimers.delete(docName);
      }
      if (historyTimers.has(docName)) {
        clearTimeout(historyTimers.get(docName));
        flushHistory(docName);
      }
      const { prototypeId, fileId } = splitDocName(docName);
      const state = Y.encodeStateAsUpdate(ydoc);
      try {
        db.prepare('INSERT OR REPLACE INTO collab_ydoc_state (prototype_id, file_id, state_blob, updated_at) VALUES (?, ?, ?, ?)')
          .run(prototypeId, fileId, Buffer.from(state), Date.now());
      } catch (e) {
        console.error('[collab] writeState failed for', docName, e.message);
      }
      return Promise.resolve();
    },
  });
}

// ── Broadcast ──────────────────────────────────────────────────────────────────

/**
 * Broadcast a JSON payload to all WebSocket connections in a single
 * (prototype, file) room. Note: with multi-file collab, callers that want a
 * prototype-wide broadcast must iterate ywsDocs themselves and filter by
 * splitDocName(name).prototypeId — this function targets one docName only.
 *
 * @param {string} docName - composite key from makeDocName(prototypeId, fileId)
 * @param {object} payload
 * @param {import('ws').WebSocket} [excludeWs]
 */
function broadcastToRoom(docName, payload, excludeWs) {
  const doc = ywsDocs.get(docName);
  if (!doc) return;
  const msg = JSON.stringify(payload);
  for (const conn of doc.conns.keys()) {
    if (conn === excludeWs) continue;
    if (conn.readyState === 1 /* OPEN */) {
      try { conn.send(msg); } catch (_) {}
    }
  }
}

/**
 * Broadcast a JSON payload to every WebSocket connection across all files
 * in a prototype's collab session. Use this for prototype-scoped events
 * (comments, member changes, etc.) that aren't tied to a single file.
 *
 * @param {string} prototypeId
 * @param {object} payload
 * @param {import('ws').WebSocket} [excludeWs]
 */
function broadcastToPrototype(prototypeId, payload, excludeWs) {
  const msg = JSON.stringify(payload);
  for (const [name, doc] of ywsDocs) {
    if (splitDocName(name).prototypeId !== prototypeId) continue;
    for (const conn of doc.conns.keys()) {
      if (conn === excludeWs) continue;
      if (conn.readyState === 1 /* OPEN */) {
        try { conn.send(msg); } catch (_) {}
      }
    }
  }
}

// ── Remote-coding serve tunnel ──────────────────────────────────────────────────
//
// Reuses this collab relay as the transport for the "easy remote coding" feature
// (docs/superpowers/specs/2026-06-18-easy-remote-coding-design.md). A Mac (or Cloud
// workspace) running `lingcode serve` joins a room's `__serve` file as the HOST and
// announces itself with `lc-serve-host-hello`. A web client in the same room sends
// `lc-serve-request` frames (a serve HTTP request); the host issues the call to its
// local 127.0.0.1 serve and streams the answer back as `lc-serve-response-*` frames.
//
// Routing is point-to-point by streamId (NOT room broadcast) so multiple clients /
// concurrent requests on one host never cross streams.

// docName → host ws (the connection that sent lc-serve-host-hello for that room).
// Self-contained (not derived from y-websocket internals) so routing is testable
// and decoupled. One host per room — a re-hello replaces a stale host.
const serveHosts = new Map();
// streamId → { ws: clientWs, docName }. docName lets us scope cleanup to one room
// so a host dropping in one tenant's room never touches another tenant's streams.
const serveStreamClients = new Map();
// docName → Set<clientWs>: clients in a room that are driving live-session mirroring
// (lc-agent-* frames). Host→client agent frames broadcast to this set; client→host
// route to the room's serve host. A client is added on its first lc-agent-* frame.
const agentClients = new Map();

/** The live host connection for a room, or null. */
function findServeHost(docName) {
  const host = serveHosts.get(docName);
  return host && host.readyState === 1 /* OPEN */ ? host : null;
}

/** True if a remote-coding host is currently connected for this host/room id. */
function isServeHostOnline(prototypeId) {
  return findServeHost(makeDocName(prototypeId, '__serve')) != null;
}

/** Forget streams/host owned by a closing connection — scoped to its own room. */
function cleanupServeStreamsFor(ws) {
  if (ws && ws._lcServeHost && ws._lcServeDoc) {
    const doc = ws._lcServeDoc;
    if (serveHosts.get(doc) === ws) serveHosts.delete(doc);
    // Host vanished: notify only the clients whose streams live in THIS room.
    for (const [streamId, entry] of serveStreamClients) {
      if (entry.docName !== doc) continue;
      try {
        entry.ws.send(JSON.stringify({ type: 'lc-serve-error', streamId, message: 'host disconnected' }));
      } catch (_) {}
      serveStreamClients.delete(streamId);
    }
    // Tell live-session (lc-agent) clients in this room the host is gone.
    const set = agentClients.get(doc);
    if (set) {
      for (const client of set) {
        if (client.readyState === 1 /* OPEN */) serveSendFrame(client, { type: 'lc-agent-error', message: 'host disconnected' });
      }
    }
    return;
  }
  for (const [streamId, entry] of serveStreamClients) {
    if (entry.ws === ws) serveStreamClients.delete(streamId);
  }
  // Remove a leaving client from its room's agent-client set.
  if (ws && ws._lcAgentDoc) {
    const set = agentClients.get(ws._lcAgentDoc);
    if (set) { set.delete(ws); if (set.size === 0) agentClients.delete(ws._lcAgentDoc); }
  }
}

/**
 * Handle one serve-tunnel frame. Returns true if it was a tunnel frame (and thus
 * fully handled here), false otherwise so the caller can fall through to other types.
 * @param {import('ws').WebSocket} ws  the sending connection
 * @param {string} docName             this connection's room
 * @param {object} parsed              the decoded JSON frame
 */
function handleServeTunnelFrame(ws, docName, parsed) {
  switch (parsed.type) {
    case 'lc-serve-host-hello':
      ws._lcServeHost = true;
      ws._lcServeDoc = docName;
      serveHosts.set(docName, ws);
      serveSendFrame(ws, { type: 'lc-serve-host-ack' });
      return true;

    case 'lc-serve-request': {
      const streamId = parsed.streamId;
      if (typeof streamId !== 'string' || !streamId) return true;
      const host = findServeHost(docName);
      if (!host) {
        serveSendFrame(ws, { type: 'lc-serve-error', streamId, message: 'host offline' });
        return true;
      }
      serveStreamClients.set(streamId, { ws, docName });
      serveSendFrame(host, parsed);
      return true;
    }

    case 'lc-serve-stdin': {
      // client → host keystrokes (Stage 3 PTY); forward to host as-is.
      const host = findServeHost(docName);
      if (host) serveSendFrame(host, parsed);
      return true;
    }

    case 'lc-serve-response-head':
    case 'lc-serve-response-chunk':
    case 'lc-serve-close':
    case 'lc-serve-error': {
      // host → client; route to the client that opened this streamId.
      const streamId = parsed.streamId;
      const entry = serveStreamClients.get(streamId);
      if (entry && entry.ws.readyState === 1 /* OPEN */) serveSendFrame(entry.ws, parsed);
      if (parsed.type === 'lc-serve-close' || parsed.type === 'lc-serve-error') {
        serveStreamClients.delete(streamId);
      }
      return true;
    }

    default:
      return false;
  }
}

/**
 * Send a tunnel frame as a BINARY WebSocket frame. Critical: y-websocket clients
 * (the Mac bridge) run new Uint8Array(event.data) on every message; a *text* JSON
 * frame is mis-decoded as a Yjs sync message and throws "Unexpected end of array".
 * A binary frame whose first byte is '{' (0x7b) is an unknown Yjs messageType that
 * the decoder ignores, while our 0x7b custom handlers still pick it up.
 */
function serveSendFrame(ws, obj) {
  try { ws.send(Buffer.from(JSON.stringify(obj))); } catch (_) {}
}

/**
 * Live-session mirror frames (lc-agent-*) for the "Live Sessions" remote view.
 * Client→host (list/attach/detach/cmd) forward to the room's serve host; host→client
 * (list-result/state/detached/error) broadcast to the room's attached agent clients.
 * Reuses the same per-room serve host as the serve tunnel. Returns true if handled.
 * @param {import('ws').WebSocket} ws
 * @param {string} docName
 * @param {object} parsed
 */
function handleAgentFrame(ws, docName, parsed) {
  switch (parsed.type) {
    case 'lc-agent-list':
    case 'lc-agent-attach':
    case 'lc-agent-detach':
    case 'lc-agent-cmd': {
      let set = agentClients.get(docName);
      if (!set) { set = new Set(); agentClients.set(docName, set); }
      set.add(ws);
      ws._lcAgentDoc = docName;
      const host = findServeHost(docName);
      if (host) serveSendFrame(host, parsed);
      else serveSendFrame(ws, { type: 'lc-agent-error', message: 'host offline' });
      return true;
    }

    case 'lc-agent-list-result':
    case 'lc-agent-state':
    case 'lc-agent-detached':
    case 'lc-agent-error': {
      const set = agentClients.get(docName);
      if (set) {
        for (const client of set) {
          if (client === ws) continue;
          if (client.readyState === 1 /* OPEN */) serveSendFrame(client, parsed);
        }
      }
      return true;
    }

    default:
      return false;
  }
}

// ── Connection handler ─────────────────────────────────────────────────────────

/**
 * Count unique users currently connected to ANY file in this prototype's
 * collab session. With multi-file, one human opens several WS connections
 * (one per file), so we dedupe by _collabUserId.
 *
 * @param {string} prototypeId
 */
function countPrototypeMembers(prototypeId) {
  const seen = new Set();
  for (const [name, doc] of ywsDocs) {
    if (splitDocName(name).prototypeId !== prototypeId) continue;
    for (const conn of doc.conns.keys()) {
      const uid = conn._collabUserId;
      if (uid) seen.add(uid);
    }
  }
  return seen.size;
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {import('http').IncomingMessage} req
 * @param {{ id: string, email: string, [k: string]: any }} user
 * @param {'owner'|'editor'|'viewer'} role
 * @param {string} prototypeId
 * @param {string} fileId
 */
function handleCollabConnection(ws, req, user, role, prototypeId, fileId) {
  // Tag the connection with userId so the update handler can attribute
  // history, and fileId so any future per-file broadcast logic can target it.
  ws._collabUserId = user.id;
  ws._collabFileId = fileId;
  ws._collabProtoId = prototypeId;

  const docName = makeDocName(prototypeId, fileId);

  // Let y-websocket handle the Yjs sync + awareness protocol
  setupWSConnection(ws, req, { docName, gc: true });

  // Viewer write guard: wrap the y-websocket message listener to block client
  // sync-update messages (outer type 0, inner sub-type 2 in the sync protocol).
  // Awareness (outer type 1) is always allowed so presence still works.
  if (role === 'viewer') {
    const listeners = ws.rawListeners('message');
    const ywsListener = listeners[listeners.length - 1];
    ws.removeAllListeners('message');
    ws.on('message', (msg) => {
      const buf = Buffer.from(msg instanceof ArrayBuffer ? msg : msg);
      // Outer type byte 0 = sync; inner byte 0=step1, 1=step2, 2=update
      if (buf[0] === 0 && buf[1] === 2) return; // drop update from viewer
      ywsListener.call(ws, msg);
    });
  }

  // Member count is prototype-wide (dedup'd by userId), not per-file —
  // matches the legacy semantic the Mac app expects in lc-collab-meta.
  const memberCount = Math.max(1, countPrototypeMembers(prototypeId));

  // Send role + per-file metadata to this client
  try {
    ws.send(JSON.stringify({ type: 'lc-collab-meta', role, memberCount, fileId }));
  } catch (_) {}

  // Handle custom JSON messages from this client (cursor + forwarded events).
  // lc-cursor is broadcast per-file; legacy single-file callers still get the
  // expected behaviour because docName collapses to the same per-file room.
  ws.on('message', (rawMsg) => {
    let text;
    try {
      const buf = Buffer.from(rawMsg instanceof ArrayBuffer ? rawMsg : rawMsg);
      if (buf[0] !== 0x7b) return; // not JSON
      text = buf.toString('utf8');
    } catch { return; }

    let parsed;
    try { parsed = JSON.parse(text); } catch { return; }

    if (!parsed || typeof parsed.type !== 'string') return;

    // Remote-coding serve tunnel frames are routed point-to-point by streamId.
    if (handleServeTunnelFrame(ws, docName, parsed)) return;
    // Live-session mirror (lc-agent-*) frames.
    if (handleAgentFrame(ws, docName, parsed)) return;

    switch (parsed.type) {
      case 'lc-cursor':
        broadcastToRoom(docName, {
          type: 'lc-cursor-broadcast',
          userId: user.id,
          fileId,
          selector: parsed.selector ?? null,
        }, ws);
        break;
      case 'lc-debug-envelope':
        broadcastToRoom(docName, {
          type: 'lc-debug-envelope-broadcast',
          fileId,
          fromClientId: parsed.fromClientId,
          envelope: parsed.envelope,
        }, ws);
        break;
      // Other custom message types can be added here
    }
  });

  // Drop any serve-tunnel streams this connection owned (client streams, or all
  // streams if the host vanished — clients are notified in that case).
  ws.on('close', () => cleanupServeStreamsFor(ws));
}

// ── Server init ───────────────────────────────────────────────────────────────

/**
 * @param {import('http').Server} httpServer
 * @param {import('better-sqlite3').Database} db
 * @param {import('express-session').RequestHandler} sessionMiddleware
 */
function initCollabServer(httpServer, db, sessionMiddleware) {
  // WAL mode is set earlier in index.js (right after db open) so it's already
  // active by the time we get here.
  initPersistence(db);

  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    const {
      _collabUser: user,
      _collabRole: role,
      _collabProtoId: prototypeId,
      _collabFileId: fileId,
    } = req;
    handleCollabConnection(ws, req, user, role, prototypeId, fileId);
  });

  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws/collab/')) return;

    const key = parseCollabRoomKey(req.url);
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const { prototypeId, fileId } = key;

    // Native clients (Mac app collab-bridge) cannot set custom WS handshake
    // headers. Promote ?token=... into Authorization so getUserFromRequest can
    // see the Bearer token. Cookie-based sessions still work unchanged.
    try {
      const queryString = req.url.includes('?') ? req.url.split('?').slice(1).join('?') : '';
      if (queryString) {
        const params = new URLSearchParams(queryString);
        const qToken = params.get('token');
        if (qToken && !req.headers.authorization) {
          req.headers.authorization = `Bearer ${qToken}`;
        }
      }
    } catch (_) { /* ignore malformed query */ }

    // Parse session cookie via the Express session middleware.
    // We pass a minimal fake response since we only need req.session populated.
    const fakeRes = {
      getHeader: () => undefined,
      setHeader: () => {},
      end: () => {},
    };

    sessionMiddleware(req, fakeRes, () => {
      const user = getUserFromRequest(db, req);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      let role = getUserRole(user.id, prototypeId, db);
      if (!role) {
        // Remote-coding host room: the id is a remote_hosts row, owner-only.
        // (No collab_members row exists for these — they aren't prototypes.)
        try {
          const host = db.prepare('SELECT owner_id FROM remote_hosts WHERE id = ?').get(prototypeId);
          if (host && host.owner_id === user.id) role = 'owner';
        } catch (_) { /* table may not exist on very old DBs — fall through to 403 */ }
      }
      if (!role) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      req._collabUser = user;
      req._collabRole = role;
      req._collabProtoId = prototypeId;
      req._collabFileId = fileId;

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
  });

  // Prune collab_history rows older than 90 days — run daily
  const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const HISTORY_TTL_MS = 90 * PRUNE_INTERVAL_MS;
  setInterval(() => {
    try {
      db.prepare('DELETE FROM collab_history WHERE server_ts < ?').run(Date.now() - HISTORY_TTL_MS);
    } catch (_) {}
  }, PRUNE_INTERVAL_MS).unref();
}

module.exports = {
  initCollabServer,
  broadcastToRoom,
  broadcastToPrototype,
  getUserRole,
  getInitials,
  parseCollabRoomKey,
  makeDocName,
  splitDocName,
  LEGACY_FILE_ID,
  // Serve-tunnel routing — exported for unit testing (see collab-serve-tunnel.test.js)
  // and for the remote-host REST routes (isServeHostOnline).
  handleServeTunnelFrame,
  handleAgentFrame,
  cleanupServeStreamsFor,
  findServeHost,
  isServeHostOnline,
  _serveTunnelState: { serveHosts, serveStreamClients, agentClients },
};
