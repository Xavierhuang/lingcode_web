'use strict';

// cloud-push.js — push notifications for LingCode Cloud backends.
//
// Primary path: W3C Web Push (VAPID) — the native fit for the web apps /try
// ships. Each backend gets its own VAPID keypair (generated lazily, private key
// encrypted at rest). The SDK's client.push.subscribe() registers the service
// worker, subscribes via the browser PushManager, and POSTs the subscription to
// /push/subscribe (route in cloud-backend.js). Owners send from the console.
//
// Secondary path: BYO FCM relay for customers who also ship a native Android
// app — they paste a Firebase service-account JSON (stored encrypted); we mint
// an OAuth token and send via FCM HTTP v1. APNs (native iOS) is not yet wired —
// /try doesn't produce native iOS apps, so it's deferred (subscribe with
// kind:'apns' is accepted and stored, but send returns a clear 'not enabled').

const crypto = require('crypto');
const { getUserFromRequest } = require('./auth-helpers');
const dataPlane = require('./cloud-data-plane');

// ── BYO credential encryption (AES-256-GCM; own domain label) ──────────
// Mirrors cloud-oauth.js's scheme with a distinct label so push creds and
// OAuth creds never share a derived key.
function encKey() { return crypto.createHash('sha256').update('lc-push-byo|' + (process.env.CLOUD_JWT_SECRET || '')).digest(); }
function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}
function decryptSecret(blob) {
  try {
    if (!blob || !String(blob).startsWith('v1:')) return null;
    const raw = Buffer.from(String(blob).slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch (_) { return null; }
}

let _wp = null, _wpTried = false;
function webpush() {
  if (_wpTried) return _wp;
  _wpTried = true;
  try { _wp = require('web-push'); } catch (_) { _wp = null; }
  return _wp;
}
function isAvailable() { return !!webpush(); }

// Lazily create (and persist) the backend's VAPID keypair. Returns
// { publicKey, privateKey } or null when the web-push lib isn't installed.
function ensureVapid(db, backendId) {
  const row = db.prepare('SELECT vapid_public, vapid_private_enc FROM backend_push_config WHERE backend_id = ?').get(backendId);
  if (row && row.vapid_public && row.vapid_private_enc) {
    const priv = decryptSecret(row.vapid_private_enc);
    if (priv) return { publicKey: row.vapid_public, privateKey: priv };
  }
  const wp = webpush(); if (!wp) return null;
  const keys = wp.generateVAPIDKeys();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO backend_push_config (backend_id, vapid_public, vapid_private_enc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(backend_id) DO UPDATE SET vapid_public=excluded.vapid_public, vapid_private_enc=excluded.vapid_private_enc, updated_at=excluded.updated_at`)
    .run(backendId, keys.publicKey, encryptSecret(keys.privateKey), now, now);
  return keys;
}

function vapidPublic(db, backendId) { const k = ensureVapid(db, backendId); return k ? k.publicKey : null; }

// Store (or refresh) a push subscription. Web Push subscriptions carry
// { endpoint, keys:{p256dh,auth} }; FCM/APNs device tokens come as { token }.
function saveSubscription(db, backendId, userId, sub) {
  if (!sub || typeof sub !== 'object') throw new Error('subscription required');
  const kind = sub.kind || 'webpush';
  let endpoint, p256dh = null, auth = null;
  if (kind === 'webpush') {
    endpoint = sub.endpoint;
    p256dh = sub.keys && sub.keys.p256dh; auth = sub.keys && sub.keys.auth;
    if (!endpoint || !p256dh || !auth) throw new Error('web push subscription must include endpoint + keys.p256dh + keys.auth');
  } else {
    endpoint = sub.token || sub.endpoint;
    if (!endpoint) throw new Error('device token required');
  }
  db.prepare(`INSERT INTO backend_push_subscriptions (id, backend_id, user_id, kind, endpoint, p256dh, auth, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(backend_id, endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`)
    .run(crypto.randomUUID(), backendId, userId || null, kind, endpoint, p256dh, auth, new Date().toISOString());
  return { kind };
}

// ── FCM HTTP v1 (BYO service account) ──────────────────────────────────
const _fcmToken = new Map(); // backendId -> { token, exp(seconds) }
async function fcmAccessToken(backendId, sa) {
  const jwt = require('jsonwebtoken');
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = _fcmToken.get(backendId);
  if (cached && cached.exp > nowSec + 60) return cached.token;
  const assertion = jwt.sign(
    { scope: 'https://www.googleapis.com/auth/firebase.messaging' },
    sa.private_key,
    { algorithm: 'RS256', issuer: sa.client_email, subject: sa.client_email, audience: 'https://oauth2.googleapis.com/token', expiresIn: 3600 }
  );
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(assertion),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.access_token) { const e = new Error('FCM auth failed'); e.statusCode = 502; throw e; }
  _fcmToken.set(backendId, { token: j.access_token, exp: nowSec + (j.expires_in || 3600) });
  return j.access_token;
}
async function sendFcm(backendId, sa, deviceToken, msg) {
  const token = await fcmAccessToken(backendId, sa);
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { token: deviceToken, notification: { title: msg.title, body: msg.body }, data: stringifyData(msg.data) } }),
  });
  if (!r.ok) { const e = new Error('FCM send failed'); e.statusCode = r.status; throw e; }
}
// FCM data values must be strings.
function stringifyData(data) {
  const out = {}; if (data && typeof data === 'object') for (const k of Object.keys(data)) out[k] = typeof data[k] === 'string' ? data[k] : JSON.stringify(data[k]);
  return out;
}

// Fan a notification out to a backend's subscribers (optionally one user).
// Prunes dead Web Push subscriptions (404/410). Returns delivery counts.
async function sendPush(db, backendId, msg) {
  const subs = msg.user_id
    ? db.prepare('SELECT * FROM backend_push_subscriptions WHERE backend_id = ? AND user_id = ?').all(backendId, msg.user_id)
    : db.prepare('SELECT * FROM backend_push_subscriptions WHERE backend_id = ?').all(backendId);
  if (!subs.length) return { sent: 0, pruned: 0, failed: 0, total: 0 };

  const payload = JSON.stringify({ title: msg.title || 'Notification', body: msg.body || '', url: msg.url || '/', icon: msg.icon, data: msg.data || {} });
  const cfg = db.prepare('SELECT * FROM backend_push_config WHERE backend_id = ?').get(backendId) || {};
  let sa = null;
  if (cfg.fcm_key_enc) { try { sa = JSON.parse(decryptSecret(cfg.fcm_key_enc)); } catch (_) { sa = null; } }

  let sent = 0, pruned = 0, failed = 0;
  for (const s of subs) {
    try {
      if (s.kind === 'webpush') {
        const wp = webpush(); const vapid = ensureVapid(db, backendId);
        if (!wp || !vapid) { failed++; continue; }
        await wp.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { vapidDetails: { subject: 'mailto:push@lingcode.dev', publicKey: vapid.publicKey, privateKey: vapid.privateKey } }
        );
        sent++;
      } else if (s.kind === 'fcm') {
        if (!sa) { failed++; continue; }
        await sendFcm(backendId, sa, s.endpoint, msg); sent++;
      } else { failed++; /* apns deferred */ }
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) { db.prepare('DELETE FROM backend_push_subscriptions WHERE backend_id = ? AND endpoint = ?').run(backendId, s.endpoint); pruned++; }
      else failed++;
    }
  }
  return { sent, pruned, failed, total: subs.length };
}

function registerCloudPushRoutes(app, db) {
  function ownerBackend(req, res) {
    if (!dataPlane.isConfigured()) { res.status(503).json({ ok: false, error: 'cloud_not_configured' }); return null; }
    const user = getUserFromRequest(db, req);
    if (!user) { res.status(401).json({ ok: false, error: 'unauthorized' }); return null; }
    const backendId = String(req.params.backendId || '');
    const row = db.prepare('SELECT * FROM account_backends WHERE id = ? AND user_id = ?').get(backendId, user.id);
    if (!row) { res.status(404).json({ ok: false, error: 'backend_not_found' }); return null; }
    return { user, row };
  }

  // Owner: push status (is the runtime available, is a keypair minted, is BYO FCM set).
  app.get('/api/cloud/account/backends/:backendId/push/config', (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const cfg = db.prepare('SELECT vapid_public, fcm_key_enc, updated_at FROM backend_push_config WHERE backend_id = ?').get(ctx.row.id) || {};
    const subs = db.prepare('SELECT COUNT(*) AS n FROM backend_push_subscriptions WHERE backend_id = ?').get(ctx.row.id).n;
    res.json({ ok: true, data: { available: isAvailable(), vapid_public: cfg.vapid_public || vapidPublic(db, ctx.row.id), fcm_configured: !!cfg.fcm_key_enc, subscriber_count: subs } });
  });

  // Owner: set / clear BYO FCM service account (paste the JSON). {} clears it.
  app.put('/api/cloud/account/backends/:backendId/push/config', (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const now = new Date().toISOString();
    let fcmEnc = undefined;
    const raw = req.body && req.body.fcm_service_account;
    if (raw === null || raw === '') { fcmEnc = null; }
    else if (raw) {
      let sa; try { sa = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return res.status(400).json({ ok: false, error: 'invalid_request', message: 'fcm_service_account must be valid JSON' }); }
      if (!sa.client_email || !sa.private_key || !sa.project_id) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'service account needs client_email, private_key, project_id' });
      fcmEnc = encryptSecret(JSON.stringify(sa));
    }
    // Ensure a row exists (also mints VAPID) then patch FCM if provided.
    ensureVapid(db, ctx.row.id);
    if (fcmEnc !== undefined) db.prepare('UPDATE backend_push_config SET fcm_key_enc = ?, updated_at = ? WHERE backend_id = ?').run(fcmEnc, now, ctx.row.id);
    _fcmToken.delete(ctx.row.id);
    const cfg = db.prepare('SELECT vapid_public, fcm_key_enc FROM backend_push_config WHERE backend_id = ?').get(ctx.row.id) || {};
    res.json({ ok: true, data: { vapid_public: cfg.vapid_public, fcm_configured: !!cfg.fcm_key_enc } });
  });

  // Owner: send a notification to all subscribers (or one user_id).
  app.post('/api/cloud/account/backends/:backendId/push/send', async (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    if (!isAvailable()) return res.status(503).json({ ok: false, error: 'push_not_available', message: 'The push runtime is not installed on this server.' });
    const body = req.body || {};
    if (!body.title && !body.body) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'title or body required' });
    try {
      const result = await sendPush(db, ctx.row.id, { title: body.title, body: body.body, url: body.url, data: body.data, user_id: body.user_id });
      res.json({ ok: true, data: result });
    } catch (err) { res.status(err.status || 500).json({ ok: false, error: 'push_send_failed', message: err.message }); }
  });
}

module.exports = { registerCloudPushRoutes, sendPush, ensureVapid, vapidPublic, saveSubscription, isAvailable };
