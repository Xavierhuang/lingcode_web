'use strict';

// REST routes for "easy remote coding" host records (Stage 1).
// A host is a Mac (or Cloud workspace) the user can attach to from the web.
// The host id doubles as the collab room id; host + web client meet at
// /ws/collab/<id>/__serve and the serve tunnel rides that room.
// See docs/superpowers/specs/2026-06-18-easy-remote-coding-design.md.

const crypto = require('crypto');
const { getUserFromRequest } = require('./auth-helpers');
const { isServeHostOnline } = require('./collab-server');

const NAME_MAX = 120;

function wsBaseOrigin() {
  const publicOrigin = String(process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '') || 'https://lingcode.dev';
  return publicOrigin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

function apiTokenFor(db, userId) {
  const row = db.prepare('SELECT api_access_token FROM users WHERE id = ?').get(userId);
  return row && row.api_access_token ? row.api_access_token : null;
}

/**
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
function registerRemoteRoutes(app, db) {
  function requireUser(req, res) {
    const u = getUserFromRequest(db, req);
    if (!u) { res.status(401).json({ ok: false, error: 'unauthorized' }); return null; }
    return u;
  }

  // POST /api/remote/hosts — register a host for this account (the Mac calls this
  // when "Enable Remote Coding" is turned on). Returns the id + a wsUrl the
  // collab-bridge can init against. Body: { name }.
  app.post('/api/remote/hosts', (req, res) => {
    const u = requireUser(req, res);
    if (!u) return;
    const name = String((req.body && req.body.name) || '').trim().slice(0, NAME_MAX) || 'My Mac';
    const now = Date.now();
    // Reuse the client's existing host row (if it sent an id it owns) so toggling
    // Remote Coding on/off updates one row instead of piling up duplicates.
    const providedId = String((req.body && req.body.id) || '').trim();
    let id = '';
    if (providedId) {
      const existing = db.prepare('SELECT id FROM remote_hosts WHERE id = ? AND owner_id = ?').get(providedId, u.id);
      if (existing) {
        id = providedId;
        db.prepare('UPDATE remote_hosts SET name = ?, last_seen_at = ? WHERE id = ?').run(name, now, id);
      }
    }
    if (!id) {
      id = crypto.randomUUID();
      db.prepare('INSERT INTO remote_hosts (id, owner_id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, u.id, name, now, now);
    }

    const apiToken = apiTokenFor(db, u.id);
    const wsBase = wsBaseOrigin();
    const wsUrl = apiToken
      ? `${wsBase}/ws/collab/${id}?token=${encodeURIComponent(apiToken)}`
      : `${wsBase}/ws/collab/${id}`;
    res.json({ ok: true, host: { id, name, created_at: now }, wsUrl });
  });

  // GET /api/remote/hosts — list this account's hosts with live online status.
  app.get('/api/remote/hosts', (req, res) => {
    const u = requireUser(req, res);
    if (!u) return;
    const rows = db.prepare('SELECT id, name, created_at, last_seen_at FROM remote_hosts WHERE owner_id = ? ORDER BY created_at DESC').all(u.id);
    const hosts = rows.map((r) => ({
      id: r.id,
      name: r.name,
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
      online: isServeHostOnline(r.id),
    }));
    res.json({ ok: true, hosts });
  });

  // GET /api/remote/hosts/:id/room — connection info for the web client about to
  // attach. Owner-only. Returns the wsUrl (to /__serve) + online status.
  app.get('/api/remote/hosts/:id/room', (req, res) => {
    const u = requireUser(req, res);
    if (!u) return;
    const host = db.prepare('SELECT id, name, owner_id FROM remote_hosts WHERE id = ?').get(req.params.id);
    if (!host || host.owner_id !== u.id) return res.status(404).json({ ok: false, error: 'not_found' });

    const apiToken = apiTokenFor(db, u.id);
    const wsBase = wsBaseOrigin();
    const wsUrl = apiToken
      ? `${wsBase}/ws/collab/${host.id}/__serve?token=${encodeURIComponent(apiToken)}`
      : `${wsBase}/ws/collab/${host.id}/__serve`;
    res.json({ ok: true, host: { id: host.id, name: host.name }, wsUrl, online: isServeHostOnline(host.id) });
  });

  // DELETE /api/remote/hosts/:id — forget a host (owner-only).
  app.delete('/api/remote/hosts/:id', (req, res) => {
    const u = requireUser(req, res);
    if (!u) return;
    const r = db.prepare('DELETE FROM remote_hosts WHERE id = ? AND owner_id = ?').run(req.params.id, u.id);
    res.json({ ok: true, deleted: r.changes });
  });
}

module.exports = { registerRemoteRoutes };
