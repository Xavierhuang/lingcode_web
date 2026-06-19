'use strict';

// supabase-oauth.js — OAuth 2.0 + PKCE flow for connecting a user's
// Supabase account to /try. Phase 2 of the Lovable-parity plan.
//
// Flow:
//   1. User clicks "Connect Supabase" → frontend opens popup at /api/supabase/oauth/start
//   2. We generate state + PKCE verifier, redirect to api.supabase.com/v1/oauth/authorize
//   3. Supabase bounces back to /api/supabase/callback with code + state
//   4. We exchange code (with the PKCE verifier) for refresh_token + access_token
//   5. Refresh token is persisted in supabase_oauth_tokens (1:1 with user)
//   6. Callback page postMessages 'supabase-connected' to opener and closes
//   7. supabase-management.js takes over for all Management API calls,
//      reading the refresh token from this module's persistence
//
// External setup (REQUIRED before this module does anything useful):
//   - Register an OAuth app at supabase.com → org settings → OAuth Apps
//   - Set env vars: SUPABASE_OAUTH_CLIENT_ID, SUPABASE_OAUTH_CLIENT_SECRET
//   - Register the redirect URI as <origin>/api/supabase/callback
//
// Wiring (one-time, after env is set):
//   const { migrateSupabaseTables } = require('./migrate');
//   const { registerSupabaseRoutes } = require('./supabase-oauth');
//   migrateSupabaseTables(db);                // alongside other migrations
//   registerSupabaseRoutes(app, db);          // alongside registerGithubRoutes

const crypto = require('crypto');
const { getUserFromRequest } = require('./auth-helpers');

const AUTHORIZE_URL = 'https://api.supabase.com/v1/oauth/authorize';
const TOKEN_URL = 'https://api.supabase.com/v1/oauth/token';

// Scope philosophy: Supabase Management API OAuth scopes are coarse — we
// need read+write on projects, organizations, databases, and api keys to
// drive Phase 2 + 3 (auto-provision project, apply migrations, fetch anon
// key, list tables). `all` is the simplest path; if Supabase later
// introduces granular scopes we can tighten this without breaking
// existing connections (refresh tokens carry the original scope grant).
const OAUTH_SCOPE = 'all';

function isConfigured() {
  return !!process.env.SUPABASE_OAUTH_CLIENT_ID && !!process.env.SUPABASE_OAUTH_CLIENT_SECRET;
}

function envOrThrow(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

// PKCE helpers — RFC 7636. We use the S256 method (SHA256 of the verifier,
// base64url-encoded). The verifier is 43-128 chars from the unreserved set;
// we pick 64 chars from a base64url alphabet via crypto.randomBytes.
function generateCodeVerifier() {
  return crypto.randomBytes(48).toString('base64url'); // 64 chars, all unreserved
}

function codeChallengeFromVerifier(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
function registerSupabaseRoutes(app, db) {
  // ---- Status ----
  app.get('/api/supabase/status', (req, res) => {
    if (!isConfigured()) return res.status(503).json({ ok: false, error: 'supabase_not_configured' });
    const user = getUserFromRequest(db, req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const row = db.prepare('SELECT scope, connected_at, last_refreshed_at FROM supabase_oauth_tokens WHERE user_id = ?').get(user.id);
    res.json({
      ok: true,
      connected: !!row,
      scope: row?.scope || null,
      connected_at: row?.connected_at || null,
      last_refreshed_at: row?.last_refreshed_at || null,
    });
  });

  // ---- Disconnect (clears the local token; user can revoke fully at supabase.com) ----
  app.post('/api/supabase/disconnect', (req, res) => {
    const user = getUserFromRequest(db, req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    db.prepare('DELETE FROM supabase_oauth_tokens WHERE user_id = ?').run(user.id);
    // NOTE: Supabase's OAuth revoke endpoint exists but is not yet stable;
    // we deliberately don't call it from here so a transient revoke failure
    // doesn't leave the local DB out of sync. Users can revoke fully at
    // supabase.com → org settings → OAuth Apps → revoke for their org.
    res.json({ ok: true });
  });

  // ---- Step 1: redirect to Supabase authorize ----
  app.get('/api/supabase/oauth/start', (req, res) => {
    if (!isConfigured()) return res.status(503).send('Supabase OAuth not configured on server');
    const user = getUserFromRequest(db, req);
    if (!user) {
      const next = encodeURIComponent('/api/supabase/oauth/start');
      return res.redirect(`/signin.html?next=${next}`);
    }
    const state = crypto.randomBytes(24).toString('hex');
    const verifier = generateCodeVerifier();
    req.session.supabase_oauth_state = state;
    req.session.supabase_oauth_uid = user.id;
    req.session.supabase_oauth_verifier = verifier;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: envOrThrow('SUPABASE_OAUTH_CLIENT_ID'),
      redirect_uri: redirectUri(req),
      state,
      scope: OAUTH_SCOPE,
      code_challenge: codeChallengeFromVerifier(verifier),
      code_challenge_method: 'S256',
    });
    res.redirect(`${AUTHORIZE_URL}?${params.toString()}`);
  });

  // ---- Step 2: Supabase returns here with code ----
  app.get('/api/supabase/callback', async (req, res) => {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const expectedState = req.session?.supabase_oauth_state;
    const uid = req.session?.supabase_oauth_uid;
    const verifier = req.session?.supabase_oauth_verifier;
    delete req.session.supabase_oauth_state;
    delete req.session.supabase_oauth_uid;
    delete req.session.supabase_oauth_verifier;

    if (!code || !state || !expectedState || state !== expectedState) {
      return res.status(400).send(callbackHtml(false, 'state mismatch — please retry'));
    }
    if (!uid || !verifier) {
      return res.status(401).send(callbackHtml(false, 'session expired — please retry'));
    }

    // Exchange code → refresh_token (and a short-lived access_token we
    // intentionally discard; supabase-management.js will mint its own
    // from the refresh_token on first call).
    let tokenJson;
    try {
      const auth = Buffer.from(`${envOrThrow('SUPABASE_OAUTH_CLIENT_ID')}:${envOrThrow('SUPABASE_OAUTH_CLIENT_SECRET')}`).toString('base64');
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(req),
        code_verifier: verifier,
      }).toString();
      const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'authorization': `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      tokenJson = await tokenRes.json();
      if (!tokenRes.ok) {
        return res.status(400).send(callbackHtml(false, tokenJson?.error_description || tokenJson?.error || 'token exchange failed'));
      }
    } catch {
      return res.status(502).send(callbackHtml(false, 'Supabase token exchange failed'));
    }
    const refreshToken = tokenJson?.refresh_token;
    if (!refreshToken) {
      return res.status(400).send(callbackHtml(false, 'no refresh_token returned'));
    }
    const scope = tokenJson?.scope || OAUTH_SCOPE;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO supabase_oauth_tokens (user_id, refresh_token, scope, connected_at, last_refreshed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        refresh_token = excluded.refresh_token,
        scope = excluded.scope,
        last_refreshed_at = excluded.last_refreshed_at
    `).run(uid, refreshToken, scope, now, now);

    res.send(callbackHtml(true));
  });
}

// Helper that other server modules (e.g. an `apply_rls_template` route in
// inference-anthropic.js) can use to fetch a user's refresh token before
// calling supabase-management.js. Returns null if the user hasn't
// connected; supabase-management throws clearly when given a null token.
function getRefreshTokenForUser(db, userId) {
  if (!userId) return null;
  const row = db.prepare('SELECT refresh_token FROM supabase_oauth_tokens WHERE user_id = ?').get(userId);
  return row?.refresh_token || null;
}

function getOauthCredsFromEnv() {
  return {
    clientId: process.env.SUPABASE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.SUPABASE_OAUTH_CLIENT_SECRET || '',
  };
}

// ---- Helpers ----

function redirectUri(req) {
  // Supabase's OAuth app config locks the redirect URI to an exact match.
  // Register https://lingcode.dev/api/supabase/callback in production;
  // localhost overrides happen via x-forwarded-host on the dev proxy.
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/supabase/callback`;
}

function callbackHtml(success, errorMsg = '') {
  // Tiny self-contained popup page that postMessages the parent and
  // closes. Mirrors github-oauth.js's callbackHtml so the frontend can
  // listen for either kind generically.
  const status = success ? 'supabase-connected' : 'supabase-error';
  const safeErr = (errorMsg || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${success ? 'Connected' : 'Error'}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0b0b0e; color: #fff; margin: 0; height: 100vh; display: grid; place-items: center; }
  .box { text-align: center; padding: 32px; }
  .ok { color: #4ade80; font-size: 32px; margin: 0 0 8px; }
  .err { color: #f87171; font-size: 22px; margin: 0 0 8px; }
  .sub { color: #aaa; font-size: 14px; }
</style></head>
<body>
  <div class="box">
    ${success
      ? `<h1 class="ok">⚡ Connected</h1><p class="sub">Supabase is now linked. You can close this window.</p>`
      : `<h1 class="err">✗ Error</h1><p class="sub">${safeErr}</p>`}
  </div>
  <script>
    try { if (window.opener) window.opener.postMessage({ kind: '${status}' }, '*'); } catch (e) {}
    setTimeout(function () { try { window.close(); } catch (e) {} }, ${success ? 600 : 4000});
  </script>
</body></html>`;
}

module.exports = {
  registerSupabaseRoutes,
  isConfigured,
  getRefreshTokenForUser,
  getOauthCredsFromEnv,
  // exported for tests
  _generateCodeVerifier: generateCodeVerifier,
  _codeChallengeFromVerifier: codeChallengeFromVerifier,
};
