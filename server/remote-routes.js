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
const SHARE_TTL_MS = 24 * 60 * 60 * 1000; // view-only share links auto-expire in 24h

function publicOrigin() {
  return String(process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '') || 'https://lingcode.dev';
}

function wsBaseOrigin() {
  return publicOrigin().replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
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

  // POST /api/remote/hosts/:id/share — owner mints a read-only "view-only" link.
  // The token is an unguessable bearer credential the relay validates on connect
  // and pins to a read-only viewer role. Auto-expires in 24h; revocable.
  app.post('/api/remote/hosts/:id/share', (req, res) => {
    const u = requireUser(req, res);
    if (!u) return;
    const host = db.prepare('SELECT id, owner_id FROM remote_hosts WHERE id = ?').get(req.params.id);
    if (!host || host.owner_id !== u.id) return res.status(404).json({ ok: false, error: 'not_found' });
    const token = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    const expiresAt = now + SHARE_TTL_MS;
    db.prepare('INSERT INTO remote_host_shares (token, host_id, owner_id, permission, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .run(token, host.id, u.id, 'view', now, expiresAt);
    res.json({ ok: true, token, url: `${publicOrigin()}/remote/?share=${encodeURIComponent(token)}`, expires_at: expiresAt });
  });

  // GET /api/remote/share/:token — redeem a share link. NO auth: the token IS the
  // credential. Returns the read-only wsUrl + host name + online status.
  app.get('/api/remote/share/:token', (req, res) => {
    const token = String(req.params.token || '');
    const sh = db.prepare('SELECT host_id, expires_at, revoked FROM remote_host_shares WHERE token = ?').get(token);
    if (!sh || sh.revoked) return res.status(404).json({ ok: false, error: 'invalid_token' });
    if (sh.expires_at && Date.now() > sh.expires_at) return res.status(410).json({ ok: false, error: 'expired' });
    const host = db.prepare('SELECT id, name FROM remote_hosts WHERE id = ?').get(sh.host_id);
    if (!host) return res.status(404).json({ ok: false, error: 'not_found' });
    const wsBase = wsBaseOrigin();
    const wsUrl = `${wsBase}/ws/collab/${host.id}/__serve?share=${encodeURIComponent(token)}`;
    res.json({ ok: true, host: { id: host.id, name: host.name }, wsUrl, readOnly: true, online: isServeHostOnline(host.id) });
  });

  // DELETE /api/remote/hosts/:id/shares — revoke all view-only links (owner-only).
  app.delete('/api/remote/hosts/:id/shares', (req, res) => {
    const u = requireUser(req, res);
    if (!u) return;
    const host = db.prepare('SELECT id, owner_id FROM remote_hosts WHERE id = ?').get(req.params.id);
    if (!host || host.owner_id !== u.id) return res.status(404).json({ ok: false, error: 'not_found' });
    const r = db.prepare('UPDATE remote_host_shares SET revoked = 1 WHERE host_id = ? AND revoked = 0').run(host.id);
    res.json({ ok: true, revoked: r.changes });
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
