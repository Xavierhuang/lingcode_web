'use strict';

// supabase-management.js — server-side proxy for the Supabase Management
// API (https://api.supabase.com). Phase 2 of the /try Lovable-parity
// plan. Every call from /try that touches a user's Supabase project goes
// through here; the AI never holds Management API tokens directly.
//
// What this module owns:
//   - Refresh-token → access-token exchange (Management tokens expire 1h)
//   - In-memory access-token cache, refreshed proactively at 80% TTL
//   - Token-bucket rate limiter (Supabase caps Management API ~60/min/org)
//   - 429 backoff with Retry-After, 401 single-retry after force-refresh
//   - Concurrency cap so we don't open hundreds of sockets per user
//   - Typed helpers for the operations the agent's tool dispatcher calls:
//     listOrganizations, createProject, getProject, getAnonKey,
//     applyMigration, query, listTables
//
// What this module does NOT own:
//   - The OAuth flow itself (lives in supabase-oauth.js, Phase 2 too)
//   - Refresh-token storage (the OAuth module persists those into data.db
//     and reads them back; this module receives the refresh-token string
//     as an argument)
//   - Per-user authorization (the express route handlers must look up the
//     refresh token for `req.user.id`, then call here)
//
// Test seam: call _setFetch(fn) and _setNow(fn) before any other call to
// inject a fake fetch + clock. _resetState() clears the token cache and
// rate-limit bucket. Both are intentionally namespaced with _ so a stray
// production import doesn't grab them.

const MANAGEMENT_BASE = 'https://api.supabase.com';
const TOKEN_URL = 'https://api.supabase.com/v1/oauth/token';

// Supabase Management API rate limits, conservatively under the published
// 60/min so we keep headroom for token refresh + retries.
const RATE_CAPACITY = 50;
const RATE_REFILL_PER_MS = 50 / 60000; // 50 tokens / 60s

// Concurrency cap — independent of rate limit. Prevents head-of-line
// blocking on a slow Management call (project create can take 10s+).
const MAX_CONCURRENT = 4;

// Access tokens come back with `expires_in` (seconds). Refresh proactively
// at 80% of TTL so a long-running tool call doesn't hit a 401 mid-flight.
const ACCESS_TOKEN_REFRESH_RATIO = 0.8;
const ACCESS_TOKEN_FALLBACK_TTL_MS = 55 * 60 * 1000; // 55 min if API doesn't return expires_in

// Backoff for 429s. Honors Retry-After when present; otherwise exponential.
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const MAX_RETRIES = 5;

// ---- injectable deps ---------------------------------------------------

let _fetch = (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
let _now = () => Date.now();

function _setFetch(fn) { _fetch = fn; }
function _setNow(fn) { _now = fn; }

// ---- token cache -------------------------------------------------------

// Keyed by refresh-token (so callers can supply different users without
// crossing token streams). Value: { accessToken, expiresAt, refreshAt }.
const _tokenCache = new Map();

function _resetState() {
  _tokenCache.clear();
  _bucket.tokens = RATE_CAPACITY;
  _bucket.lastRefill = _now();
  _inFlight = 0;
  _waitQueue.length = 0;
}

async function _exchangeRefreshToken(refreshToken, { clientId, clientSecret }) {
  if (!clientId || !clientSecret) {
    throw new Error('supabase-management: clientId/clientSecret required (set SUPABASE_OAUTH_CLIENT_ID and SUPABASE_OAUTH_CLIENT_SECRET).');
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }).toString();
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await _fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'authorization': `Basic ${auth}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Supabase OAuth refresh failed (${res.status}): ${text.slice(0, 200)}`);
    err.status = res.status;
    err.code = 'oauth_refresh_failed';
    throw err;
  }
  const json = await res.json();
  if (!json.access_token) {
    throw new Error('Supabase OAuth refresh: missing access_token in response');
  }
  const ttlMs = (typeof json.expires_in === 'number' && json.expires_in > 0)
    ? json.expires_in * 1000
    : ACCESS_TOKEN_FALLBACK_TTL_MS;
  const now = _now();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || refreshToken, // some OAuth providers rotate
    expiresAt: now + ttlMs,
    refreshAt: now + Math.floor(ttlMs * ACCESS_TOKEN_REFRESH_RATIO),
  };
}

async function _getAccessToken(refreshToken, oauthCreds, { force = false } = {}) {
  if (!refreshToken) throw new Error('supabase-management: refreshToken required');
  const cached = _tokenCache.get(refreshToken);
  if (!force && cached && _now() < cached.refreshAt) {
    return cached.accessToken;
  }
  const fresh = await _exchangeRefreshToken(refreshToken, oauthCreds);
  _tokenCache.set(refreshToken, fresh);
  // If the OAuth provider rotated the refresh token, callers need to know
  // so they can persist the new one. We surface it via the returned token
  // bag from listOrganizations etc., but most callers just want the access
  // token; for those, the rotated refresh-token quietly stays in the
  // cache map keyed by the *original* refresh-token, which is wrong on
  // the second refresh. Rotation is rare in practice (Supabase doesn't
  // currently rotate), but if/when it does this needs a callback.
  // Phase 2 OAuth wiring will add `onRefreshTokenRotated` for that.
  return fresh.accessToken;
}

// ---- token bucket + concurrency queue ---------------------------------

const _bucket = { tokens: RATE_CAPACITY, lastRefill: _now() };
let _inFlight = 0;
const _waitQueue = []; // [{ resolve, kind: 'rate'|'concurrency' }]

function _refillBucket() {
  const now = _now();
  const delta = now - _bucket.lastRefill;
  if (delta <= 0) return;
  _bucket.tokens = Math.min(RATE_CAPACITY, _bucket.tokens + delta * RATE_REFILL_PER_MS);
  _bucket.lastRefill = now;
}

async function _acquireSlot() {
  // Wait for a rate-limit token first.
  while (true) {
    _refillBucket();
    if (_bucket.tokens >= 1) { _bucket.tokens -= 1; break; }
    const waitMs = Math.max(50, Math.ceil((1 - _bucket.tokens) / RATE_REFILL_PER_MS));
    await new Promise((r) => setTimeout(r, waitMs));
  }
  // Then for a concurrency slot.
  if (_inFlight < MAX_CONCURRENT) {
    _inFlight += 1;
    return;
  }
  await new Promise((resolve) => _waitQueue.push({ resolve, kind: 'concurrency' }));
  _inFlight += 1;
}

function _releaseSlot() {
  _inFlight = Math.max(0, _inFlight - 1);
  while (_inFlight < MAX_CONCURRENT && _waitQueue.length > 0) {
    const next = _waitQueue.shift();
    next.resolve();
  }
}

// ---- request core ------------------------------------------------------

async function _sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function _retryAfterMs(res) {
  const ra = res.headers.get && res.headers.get('retry-after');
  if (!ra) return null;
  const asInt = parseInt(ra, 10);
  if (Number.isFinite(asInt) && asInt >= 0) return asInt * 1000;
  const asDate = Date.parse(ra);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - _now());
  return null;
}

// Performs a single Management API request. Handles:
//   - access-token fetch (with cache)
//   - rate-limit + concurrency wait
//   - 429 with backoff (Retry-After honored, capped exponential fallback)
//   - 401 single retry after forced token refresh
//   - request body JSON serialization
// Returns parsed JSON. Throws an Error with .status set on non-2xx.
async function _request({ method, path, body, refreshToken, oauthCreds }) {
  let triedForceRefresh = false;
  let attempt = 0;
  while (true) {
    await _acquireSlot();
    let res;
    try {
      const accessToken = await _getAccessToken(refreshToken, oauthCreds, { force: triedForceRefresh });
      const url = `${MANAGEMENT_BASE}${path}`;
      const init = {
        method,
        headers: {
          'authorization': `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      res = await _fetch(url, init);
    } finally {
      _releaseSlot();
    }

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = _retryAfterMs(res);
      const backoff = retryAfter !== null
        ? retryAfter
        : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 250));
      await _sleep(backoff);
      attempt += 1;
      continue;
    }

    if (res.status === 401 && !triedForceRefresh) {
      // One free retry after forcing a token refresh — covers the rare case
      // where our cache thought the token was still good but the API
      // disagreed (clock drift, revocation, rotation).
      triedForceRefresh = true;
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Supabase Management ${method} ${path} failed (${res.status}): ${text.slice(0, 400)}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }

    if (res.status === 204) return null;
    return res.json();
  }
}

// ---- public API --------------------------------------------------------

// `oauthCreds` everywhere is `{ clientId, clientSecret }`. Passed in
// rather than read from process.env so tests don't need to monkey with
// the environment, and so a future per-deployment OAuth-app rotation
// can swap creds without restarting the process.

async function listOrganizations({ refreshToken, oauthCreds }) {
  return _request({ method: 'GET', path: '/v1/organizations', refreshToken, oauthCreds });
}

async function listProjects({ refreshToken, oauthCreds }) {
  return _request({ method: 'GET', path: '/v1/projects', refreshToken, oauthCreds });
}

async function getProject({ refreshToken, oauthCreds, projectRef }) {
  if (!projectRef) throw new Error('getProject: projectRef required');
  return _request({ method: 'GET', path: `/v1/projects/${encodeURIComponent(projectRef)}`, refreshToken, oauthCreds });
}

// Region must be one of Supabase's supported regions. The AI should pick
// the closest to the user's locale; we default to us-east-1 for safety.
async function createProject({
  refreshToken, oauthCreds,
  organizationId, name, region = 'us-east-1',
  dbPass, // required by the API; caller should generate a strong random one
  plan = 'free',
}) {
  if (!organizationId) throw new Error('createProject: organizationId required');
  if (!name) throw new Error('createProject: name required');
  if (!dbPass) throw new Error('createProject: dbPass required (use crypto.randomUUID() or similar)');
  return _request({
    method: 'POST',
    path: '/v1/projects',
    body: { organization_id: organizationId, name, region, db_pass: dbPass, plan },
    refreshToken, oauthCreds,
  });
}

// Returns the project's anon (public) key. Safe to expose to the browser.
// The service-role key is intentionally not surfaced through this module
// because it should never leave the server.
async function getAnonKey({ refreshToken, oauthCreds, projectRef }) {
  if (!projectRef) throw new Error('getAnonKey: projectRef required');
  const keys = await _request({
    method: 'GET',
    path: `/v1/projects/${encodeURIComponent(projectRef)}/api-keys`,
    refreshToken, oauthCreds,
  });
  if (!Array.isArray(keys)) return null;
  const anon = keys.find((k) => k && (k.name === 'anon' || k.name === 'anon_key'));
  return anon ? (anon.api_key || anon.key || null) : null;
}

// Applies arbitrary SQL to the project's database via the Management API
// query endpoint. Returns the resulting rows (or empty array on DDL).
// CALLERS: prefer applyMigration over query when emitting CREATE/ALTER —
// migrations get logged and become diff-able; ad-hoc queries don't.
async function query({ refreshToken, oauthCreds, projectRef, sql }) {
  if (!projectRef) throw new Error('query: projectRef required');
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('query: sql required');
  return _request({
    method: 'POST',
    path: `/v1/projects/${encodeURIComponent(projectRef)}/database/query`,
    body: { query: sql },
    refreshToken, oauthCreds,
  });
}

// applyMigration writes the SQL into supabase/migrations history (so the
// user's project keeps a real audit trail) and applies it. Use for
// CREATE TABLE, ALTER TABLE, CREATE POLICY, etc.
async function applyMigration({ refreshToken, oauthCreds, projectRef, name, sql }) {
  if (!projectRef) throw new Error('applyMigration: projectRef required');
  if (!name) throw new Error('applyMigration: name required (becomes the migration filename)');
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('applyMigration: sql required');
  return _request({
    method: 'POST',
    path: `/v1/projects/${encodeURIComponent(projectRef)}/database/migrations`,
    body: { name, query: sql },
    refreshToken, oauthCreds,
  });
}

async function listTables({ refreshToken, oauthCreds, projectRef, schema = 'public' }) {
  if (!projectRef) throw new Error('listTables: projectRef required');
  const params = new URLSearchParams({ included_schemas: schema, include_columns: 'true' });
  return _request({
    method: 'GET',
    path: `/v1/projects/${encodeURIComponent(projectRef)}/database/tables?${params.toString()}`,
    refreshToken, oauthCreds,
  });
}

// Bulk-set Edge Function secrets. `secrets` is an array of {name, value}
// objects; the Management API merges with existing secrets, so this is
// safe to call repeatedly to update individual values without overwriting
// unrelated ones.
async function setProjectSecrets({ refreshToken, oauthCreds, projectRef, secrets }) {
  if (!projectRef) throw new Error('setProjectSecrets: projectRef required');
  if (!Array.isArray(secrets) || secrets.length === 0) {
    throw new Error('setProjectSecrets: secrets must be a non-empty array of {name, value}');
  }
  for (const s of secrets) {
    if (!s || typeof s.name !== 'string' || typeof s.value !== 'string') {
      throw new Error('setProjectSecrets: each entry must have string name + string value');
    }
  }
  return _request({
    method: 'POST',
    path: `/v1/projects/${encodeURIComponent(projectRef)}/secrets`,
    body: secrets,
    refreshToken, oauthCreds,
  });
}

// Deploy or update an Edge Function. `slug` is the URL-safe identifier
// (lowercase + dashes); `body` is the function source as a string. The
// `verifyJwt` flag controls whether Supabase auto-verifies the caller's
// Authorization header — set false for public webhook endpoints
// (Stripe webhooks, signed callbacks) where the source verifies its
// own request signature.
async function deployEdgeFunction({ refreshToken, oauthCreds, projectRef, slug, name, body, verifyJwt = true }) {
  if (!projectRef) throw new Error('deployEdgeFunction: projectRef required');
  if (!slug) throw new Error('deployEdgeFunction: slug required (e.g. "stripe-checkout")');
  if (typeof body !== 'string' || !body.trim()) throw new Error('deployEdgeFunction: body source required');
  return _request({
    method: 'POST',
    path: `/v1/projects/${encodeURIComponent(projectRef)}/functions`,
    body: { slug, name: name || slug, body, verify_jwt: verifyJwt },
    refreshToken, oauthCreds,
  });
}

async function listEdgeFunctions({ refreshToken, oauthCreds, projectRef }) {
  if (!projectRef) throw new Error('listEdgeFunctions: projectRef required');
  return _request({
    method: 'GET',
    path: `/v1/projects/${encodeURIComponent(projectRef)}/functions`,
    refreshToken, oauthCreds,
  });
}

module.exports = {
  // public API
  listOrganizations,
  listProjects,
  getProject,
  createProject,
  getAnonKey,
  query,
  applyMigration,
  listTables,
  setProjectSecrets,
  deployEdgeFunction,
  listEdgeFunctions,
  // test seams (intentionally underscored — do not import in production)
  _setFetch,
  _setNow,
  _resetState,
  _request,
  _getAccessToken,
};
