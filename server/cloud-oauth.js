'use strict';

// cloud-oauth.js — managed + BYO social sign-in for LingCode Cloud tenant
// backends. A generated app gets "Sign in with Google/GitHub/Apple" with ZERO
// setup: LingCode owns ONE shared OAuth client per provider (creds in env) that
// every app reuses. Advanced users can instead bring their OWN client per
// backend (BYO) so the consent screen shows THEIR app name — stored encrypted,
// looked up first, managed client is the fallback.
//
// Flow (per backend, per provider):
//   app → GET /api/cloud/be/:id/auth/oauth/:provider/start?redirect_url=<app>
//        → 302 to the provider's consent (state = signed {backendId, redirect, provider})
//   provider → GET|POST /api/cloud/auth/oauth/:provider/callback?code&state  (fixed)
//        → exchange code, read verified email, getOrCreateTenantUserByEmail,
//          mintUserJwt → 302 back to <app>?lc_session=<jwt>
//   (google keeps its original /auth/google/* paths as back-compat aliases.)
//
// Managed env (unset ⇒ that provider is just "unavailable", never crashes):
//   CLOUD_GOOGLE_OAUTH_CLIENT_ID/SECRET  (falls back to GOOGLE_OAUTH_* — but see
//     the TRAP in the platform login: those are the lingcode.dev account client)
//   CLOUD_GITHUB_OAUTH_CLIENT_ID/SECRET
//   CLOUD_APPLE_OAUTH_CLIENT_ID (Services ID), CLOUD_APPLE_TEAM_ID,
//     CLOUD_APPLE_KEY_ID, CLOUD_APPLE_PRIVATE_KEY (.p8 contents) — Apple's
//     client_secret is a generated ES256 JWT.
//   GOOGLE_OAUTH_ALLOWED_ORIGINS  extra app origins allowed as redirect targets
//   CLOUD_JWT_SECRET  signs the OAuth state AND derives the BYO-secret enc key

const crypto = require('crypto');
const express = require('express');
const dataPlane = require('./cloud-data-plane');
const { getAnyBackendById } = require('./cloud-backend');
const { getUserFromRequest } = require('./auth-helpers');

let _jwt = null;
function jwtLib() { return (_jwt = _jwt || require('jsonwebtoken')); }
function stateSecret() { return process.env.CLOUD_JWT_SECRET || ''; }

// ---- provider registry ------------------------------------------------
// Each provider differs only in: where to send the user, where to exchange the
// code, what scope, any extra auth params, and how to read the verified email.
const PROVIDERS = {
  google: {
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    authExtra: { access_type: 'online', prompt: 'select_account' },
    async email(tokenJson) {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { authorization: 'Bearer ' + tokenJson.access_token },
      });
      const info = await r.json().catch(() => null);
      if (!r.ok || !info || !info.email) return null;
      return { email: info.email, verified: info.email_verified !== false };
    },
  },
  github: {
    label: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    authExtra: { allow_signup: 'true' },
    tokenHeaders: { accept: 'application/json' },
    async email(tokenJson) {
      const r = await fetch('https://api.github.com/user/emails', {
        headers: {
          authorization: 'Bearer ' + tokenJson.access_token,
          accept: 'application/vnd.github+json',
          'user-agent': 'LingCode-Cloud',
        },
      });
      const list = await r.json().catch(() => null);
      if (!Array.isArray(list)) return null;
      const pick = list.find((e) => e.primary && e.verified) || list.find((e) => e.verified);
      return pick ? { email: pick.email, verified: true } : null;
    },
  },
  apple: {
    label: 'Apple',
    authUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    scope: 'email',
    // Apple POSTs the result (form_post) when a scope is requested.
    authExtra: { response_mode: 'form_post' },
    async email(tokenJson) {
      if (!tokenJson.id_token) return null;
      const payload = decodeJwtPayload(tokenJson.id_token);
      if (!payload || !payload.email) return null;
      const v = payload.email_verified;
      return { email: payload.email, verified: v === true || v === 'true' };
    },
  },
};

function decodeJwtPayload(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64').toString('utf8')); }
  catch (_) { return null; }
}

// Apple's client_secret is a short-lived ES256 JWT signed with the team's .p8
// key. Returns null if any piece is missing or signing fails.
function signAppleSecret({ teamId, keyId, clientId, privateKey }) {
  if (!teamId || !keyId || !clientId || !privateKey) return null;
  const key = String(privateKey).replace(/\\n/g, '\n'); // PEM may carry escaped newlines
  try {
    return jwtLib().sign({}, key, {
      algorithm: 'ES256', keyid: keyId, issuer: teamId,
      subject: clientId, audience: 'https://appleid.apple.com', expiresIn: '180d',
    });
  } catch (_) { return null; }
}
// Managed (env-configured) Apple secret.
function appleClientSecret() {
  return signAppleSecret({
    teamId: process.env.CLOUD_APPLE_TEAM_ID || '',
    keyId: process.env.CLOUD_APPLE_KEY_ID || '',
    clientId: process.env.CLOUD_APPLE_OAUTH_CLIENT_ID || '',
    privateKey: process.env.CLOUD_APPLE_PRIVATE_KEY || '',
  });
}

// Managed (LingCode-owned, shared) client for a provider, from env.
function managedClient(provider) {
  if (provider === 'apple') {
    return { clientId: process.env.CLOUD_APPLE_OAUTH_CLIENT_ID || '', clientSecret: appleClientSecret() || '' };
  }
  const P = provider.toUpperCase();
  let id = process.env[`CLOUD_${P}_OAUTH_CLIENT_ID`] || '';
  let secret = process.env[`CLOUD_${P}_OAUTH_CLIENT_SECRET`] || '';
  if (provider === 'google') {
    id = id || process.env.GOOGLE_OAUTH_CLIENT_ID || '';
    secret = secret || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
  }
  return { clientId: id, clientSecret: secret };
}

// The fixed callback URL we register in each provider's console. Google keeps
// its legacy path so its existing registered redirect URI keeps working.
function callbackUrl(provider) {
  if (provider === 'google') return process.env.GOOGLE_OAUTH_CALLBACK_URL || 'https://lingcode.dev/api/cloud/auth/google/callback';
  const base = process.env.CLOUD_OAUTH_CALLBACK_BASE || 'https://lingcode.dev/api/cloud/auth/oauth';
  return `${base}/${provider}/callback`;
}

// ---- BYO secret encryption (AES-256-GCM, key from CLOUD_JWT_SECRET) ----
function encKey() { return crypto.createHash('sha256').update('lc-oauth-byo|' + (process.env.CLOUD_JWT_SECRET || '')).digest(); }
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

// Resolve the OAuth client for (backend, provider): a backend's BYO override
// wins, else the managed shared client. null ⇒ provider unavailable here.
function resolveClient(db, backendId, provider) {
  try {
    const row = db.prepare('SELECT client_id, client_secret, team_id, key_id, enabled FROM backend_oauth_providers WHERE backend_id = ? AND provider = ?').get(backendId, provider);
    if (row && row.enabled && row.client_id) {
      const secret = decryptSecret(row.client_secret); // for apple this is the .p8
      if (provider === 'apple') {
        const jwt = signAppleSecret({ teamId: row.team_id, keyId: row.key_id, clientId: row.client_id, privateKey: secret });
        if (jwt) return { clientId: row.client_id, clientSecret: jwt, source: 'byo' };
      } else if (secret) {
        return { clientId: row.client_id, clientSecret: secret, source: 'byo' };
      }
    }
  } catch (_) { /* table may not exist pre-migration */ }
  const m = managedClient(provider);
  if (m.clientId && m.clientSecret) return { clientId: m.clientId, clientSecret: m.clientSecret, source: 'managed' };
  return null;
}

// The Apple bundle id a backend accepts for NATIVE identity-token verification
// (the `aud` of an on-device Sign in with Apple token). BYO-configured.
function appleBundleId(db, backendId) {
  try {
    const row = db.prepare('SELECT bundle_id FROM backend_oauth_providers WHERE backend_id = ? AND provider = ? AND enabled = 1').get(backendId, 'apple');
    return (row && row.bundle_id) || process.env.CLOUD_APPLE_BUNDLE_ID || '';
  } catch (_) { return process.env.CLOUD_APPLE_BUNDLE_ID || ''; }
}

// Upsert a backend's BYO client for a provider (shared by REST + MCP).
// google/github: { clientId, clientSecret }. apple (Firebase-style BYO):
// { clientId=ServicesID, clientSecret=.p8 private key, teamId, keyId, bundleId? }.
function upsertBackendProvider(db, { backendId, provider, clientId, clientSecret, teamId, keyId, bundleId, enabled = true }) {
  if (!PROVIDERS[provider]) { const e = new Error('unknown provider'); e.status = 400; throw e; }
  if (provider === 'apple') {
    if (!clientId || !clientSecret || !teamId || !keyId) {
      const e = new Error('Apple needs client_id (Services ID), client_secret (.p8 private key), team_id, and key_id'); e.status = 400; throw e;
    }
    if (!signAppleSecret({ teamId, keyId, clientId, privateKey: clientSecret })) {
      const e = new Error('Apple private key is invalid (could not sign with it)'); e.status = 400; throw e;
    }
  } else if (!clientId || !clientSecret) {
    const e = new Error('client_id and client_secret are required'); e.status = 400; throw e;
  }
  db.prepare(`INSERT INTO backend_oauth_providers (backend_id, provider, client_id, client_secret, team_id, key_id, bundle_id, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(backend_id, provider) DO UPDATE SET
      client_id = excluded.client_id, client_secret = excluded.client_secret,
      team_id = excluded.team_id, key_id = excluded.key_id, bundle_id = excluded.bundle_id,
      enabled = excluded.enabled, updated_at = excluded.updated_at`)
    .run(backendId, provider, clientId, encryptSecret(clientSecret), teamId || null, keyId || null, bundleId || null, enabled ? 1 : 0, new Date().toISOString());
  return { provider, enabled: !!enabled, redirect_uri: callbackUrl(provider) };
}

// ---- native Apple identity-token verify (for on-device Sign in with Apple) --
// An iOS app signs in natively (its own bundle id + Apple capability) and POSTs
// the resulting identity token; we verify it against Apple's public keys and the
// backend's configured bundle id, then mint a tenant session. No callback, no
// domain verification — LingCode holds no Apple credentials for this path.
let _appleKeys = null; let _appleKeysAt = 0;
async function appleJwks() {
  // cache 1h (can't use Date.now in workflow scripts, but this is server code)
  if (_appleKeys && (Date.now() - _appleKeysAt) < 3600_000) return _appleKeys;
  const r = await fetch('https://appleid.apple.com/auth/keys');
  const j = await r.json();
  if (!r.ok || !j || !Array.isArray(j.keys)) throw new Error('apple_jwks_unavailable');
  _appleKeys = j.keys; _appleKeysAt = Date.now();
  return _appleKeys;
}
async function verifyAppleIdentityToken(token, expectedAud) {
  if (!token || !expectedAud) { const e = new Error('token and bundle id required'); e.status = 400; throw e; }
  let header;
  try { header = JSON.parse(Buffer.from(String(token).split('.')[0], 'base64').toString('utf8')); }
  catch (_) { const e = new Error('malformed token'); e.status = 400; throw e; }
  const keys = await appleJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { const e = new Error('unknown signing key'); e.status = 401; throw e; }
  const pem = crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ format: 'pem', type: 'spki' });
  let payload;
  try {
    payload = jwtLib().verify(token, pem, { algorithms: ['RS256'], issuer: 'https://appleid.apple.com', audience: expectedAud });
  } catch (_) { const e = new Error('token verification failed'); e.status = 401; throw e; }
  if (!payload.email) { const e = new Error('no email in token'); e.status = 400; throw e; }
  if (payload.email_verified === false || payload.email_verified === 'false') { const e = new Error('email not verified'); e.status = 401; throw e; }
  return { email: String(payload.email).toLowerCase(), sub: payload.sub };
}

function redirectAllowed(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (_) { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost')) return true;
  if (host === 'lingcode.dev' || host.endsWith('.lingcode.dev')) return true;
  const extra = (process.env.GOOGLE_OAUTH_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return extra.some((o) => { try { return new URL(o).hostname.toLowerCase() === host; } catch (_) { return false; } });
}

function withParam(urlStr, key, value) {
  try { const u = new URL(urlStr); u.searchParams.set(key, value); return u.toString(); }
  catch (_) { const sep = urlStr.indexOf('?') === -1 ? '?' : '&'; return urlStr + sep + key + '=' + encodeURIComponent(value); }
}

// Back-compat: Google-only availability flag.
function isConfigured() { const m = managedClient('google'); return !!(m.clientId && m.clientSecret); }

function registerCloudOAuthRoutes(app, db) {
  const cors = (res) => res.set('Access-Control-Allow-Origin', '*');

  // ── Which providers can THIS backend offer? (apps render buttons from this) ─
  const providersHandler = (req, res) => {
    cors(res);
    const backendId = String(req.params.backendId || '');
    const out = {};
    for (const name of Object.keys(PROVIDERS)) {
      const c = resolveClient(db, backendId, name);
      out[name] = { available: !!(c && c.clientId && c.clientSecret), source: c ? c.source : null };
    }
    res.json({ ok: true, providers: out });
  };
  app.get('/api/cloud/be/:backendId/auth/providers', providersHandler);
  // Google back-compat: boolean availability probe.
  const googleAvail = (req, res) => { cors(res); const c = resolveClient(db, String(req.params.backendId || ''), 'google'); res.json({ ok: true, available: !!(c && c.clientId && c.clientSecret) }); };
  app.get('/api/cloud/auth/google/available', (req, res) => { cors(res); res.json({ ok: true, available: isConfigured() && !!stateSecret() }); });
  app.get('/api/cloud/be/:backendId/auth/google/available', googleAvail);

  // ── Start: redirect the user to the provider ─────────────────────────
  const start = (req, res) => {
    if (!dataPlane.isConfigured()) return res.status(503).json({ ok: false, error: 'cloud_not_configured' });
    if (!stateSecret()) return res.status(503).json({ ok: false, error: 'state_secret_missing' });
    const provider = String(req.params.provider || 'google');
    const P = PROVIDERS[provider];
    if (!P) return res.status(404).json({ ok: false, error: 'unknown_provider' });
    const backendId = String(req.params.backendId || '');
    const row = getAnyBackendById(db, backendId);
    if (!row || row.status !== 'live') return res.status(404).json({ ok: false, error: 'backend_not_found' });
    const client = resolveClient(db, backendId, provider);
    if (!client) return res.status(503).json({ ok: false, error: provider + '_not_configured', message: `${P.label} sign-in is not configured for this backend.` });
    const redirectUrl = String((req.query && req.query.redirect_url) || '');
    if (!redirectUrl || !redirectAllowed(redirectUrl)) {
      return res.status(400).json({ ok: false, error: 'invalid_redirect', message: 'redirect_url is required and must be an allowed origin.' });
    }
    const state = jwtLib().sign({ b: backendId, r: redirectUrl, p: provider, n: crypto.randomBytes(8).toString('hex') }, stateSecret(), { algorithm: 'HS256', expiresIn: '10m' });
    const u = new URL(P.authUrl);
    u.searchParams.set('client_id', client.clientId);
    u.searchParams.set('redirect_uri', callbackUrl(provider));
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', P.scope);
    u.searchParams.set('state', state);
    for (const [k, v] of Object.entries(P.authExtra || {})) u.searchParams.set(k, v);
    res.redirect(302, u.toString());
  };
  app.get('/api/cloud/be/:backendId/auth/oauth/:provider/start', start);
  app.get('/api/cloud/be/:backendId/auth/google/start', (req, res) => { req.params.provider = 'google'; start(req, res); });

  // ── Callback: provider → us. Resolve email → tenant session, bounce back ─
  const callback = async (req, res) => {
    const params = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    let claim = null;
    try { claim = jwtLib().verify(String(params.state || ''), stateSecret()); }
    catch (_) { return res.status(400).send('Invalid or expired sign-in state. Start again.'); }
    const provider = claim.p || String(req.params.provider || 'google');
    const P = PROVIDERS[provider];
    const backendId = claim.b;
    const redirectUrl = claim.r;
    const fail = (code) => res.redirect(302, withParam(redirectUrl, 'lc_error', code));
    try {
      if (!P) return fail('unknown_provider');
      if (params.error) return fail(String(params.error));
      const code = String(params.code || '');
      if (!code) return fail('no_code');
      const client = resolveClient(db, backendId, provider);
      if (!client) return fail(provider + '_not_configured');

      const tokenRes = await fetch(P.tokenUrl, {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/x-www-form-urlencoded' }, P.tokenHeaders || {}),
        body: new URLSearchParams({
          code, client_id: client.clientId, client_secret: client.clientSecret,
          redirect_uri: callbackUrl(provider), grant_type: 'authorization_code',
        }).toString(),
      });
      const tokenJson = await tokenRes.json().catch(() => null);
      if (!tokenRes.ok || !tokenJson || (!tokenJson.access_token && !tokenJson.id_token)) return fail('token_exchange_failed');

      const got = await P.email(tokenJson);
      if (!got || !got.email) return fail('email_unavailable');
      if (got.verified === false) return fail('email_unverified');

      const row = getAnyBackendById(db, backendId);
      if (!row || row.status !== 'live') return fail('backend_not_found');

      const user = await dataPlane.getOrCreateTenantUserByEmail(backendId, String(got.email).toLowerCase());
      const session = dataPlane.mintUserJwt(backendId, user);
      return res.redirect(302, withParam(redirectUrl, 'lc_session', session));
    } catch (_) { return fail('signin_failed'); }
  };
  app.get('/api/cloud/auth/google/callback', callback); // back-compat
  app.get('/api/cloud/auth/oauth/:provider/callback', callback);
  // Apple uses form_post → parse urlencoded body just for this route.
  app.post('/api/cloud/auth/oauth/:provider/callback', express.urlencoded({ extended: false }), callback);

  // ── BYO config (owner-authed; account/standalone backends) ───────────
  function ownerBackend(req, res) {
    const user = getUserFromRequest(db, req);
    if (!user) { res.status(401).json({ ok: false, error: 'unauthorized' }); return null; }
    const backendId = String(req.params.backendId || '');
    const row = db.prepare('SELECT * FROM account_backends WHERE id = ? AND user_id = ?').get(backendId, user.id);
    if (!row) { res.status(404).json({ ok: false, error: 'backend_not_found' }); return null; }
    return { user, row };
  }

  app.get('/api/cloud/account/backends/:backendId/auth/providers', (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const rows = db.prepare('SELECT provider, client_id, enabled, updated_at FROM backend_oauth_providers WHERE backend_id = ?').all(ctx.row.id);
    const byo = {};
    rows.forEach((r) => { byo[r.provider] = { client_id: r.client_id, enabled: !!r.enabled, updated_at: r.updated_at }; }); // never return the secret
    const managed = {};
    Object.keys(PROVIDERS).forEach((name) => { const m = managedClient(name); managed[name] = !!(m.clientId && m.clientSecret); });
    res.json({ ok: true, data: { byo, managed, callback_base: 'https://lingcode.dev/api/cloud/auth/oauth' } });
  });

  app.put('/api/cloud/account/backends/:backendId/auth/providers/:provider', (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    try {
      const data = upsertBackendProvider(db, {
        backendId: ctx.row.id, provider: String(req.params.provider || ''),
        clientId: String((req.body && req.body.client_id) || '').trim(),
        clientSecret: String((req.body && req.body.client_secret) || '').trim(),
        teamId: req.body && req.body.team_id ? String(req.body.team_id).trim() : undefined,
        keyId: req.body && req.body.key_id ? String(req.body.key_id).trim() : undefined,
        bundleId: req.body && req.body.bundle_id ? String(req.body.bundle_id).trim() : undefined,
        enabled: !(req.body && req.body.enabled === false),
      });
      res.json({ ok: true, data });
    } catch (err) { res.status(err.status || 500).json({ ok: false, error: 'byo_failed', message: err.message }); }
  });

  app.delete('/api/cloud/account/backends/:backendId/auth/providers/:provider', (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    db.prepare('DELETE FROM backend_oauth_providers WHERE backend_id = ? AND provider = ?').run(ctx.row.id, String(req.params.provider || ''));
    res.json({ ok: true });
  });
}

module.exports = { registerCloudOAuthRoutes, isConfigured, upsertBackendProvider, callbackUrl, PROVIDERS, verifyAppleIdentityToken, appleBundleId };
