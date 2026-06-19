'use strict';

// deploy-vercel.js — Vercel deployment client. Phase 7 of the
// Lovable-parity plan.
//
// Two consumer paths:
//   1. Tier-1 (current): user clicks "Deploy" on a published prototype
//      → we wrap the single HTML in a deploy and push (replaces or
//      augments the existing Netlify zip path).
//   2. Tier-2 (Phase 1+7): WebContainer runs `npm run build`, we push
//      the resulting `dist/` directory.
//
// Auth: bearer token. Two policy choices for the caller:
//   (a) Per-user Vercel token, stored in the secrets vault
//       (key VERCEL_API_TOKEN). Lets users see their own deployments
//       in their Vercel dashboard. Recommended.
//   (b) Single LingCode-owned token in env. Simpler v1; users see
//       LingCode's account in the deploy URL. Not recommended for prod.
// Either way the route handler decides where the token comes from
// before calling this module — no env reads here.
//
// Test seam: _setFetch / _setNow / _resetState. Same shape as the rest
// of the server-side clients.

const VERCEL_BASE = 'https://api.vercel.com';

// Vercel's published rate limits are token-tier dependent (free tier
// ~100/min on most endpoints). Stay polite; the smoke-test suite
// confirms backoff fires correctly.
const RATE_CAPACITY = 60;
const RATE_REFILL_PER_MS = 60 / 60000;
const MAX_CONCURRENT = 4;

const BACKOFF_BASE_MS = 750;
const BACKOFF_MAX_MS = 30_000;
const MAX_RETRIES = 5;

let _fetch = (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
let _now = () => Date.now();

function _setFetch(fn) { _fetch = fn; }
function _setNow(fn) { _now = fn; }

const _bucket = { tokens: RATE_CAPACITY, lastRefill: _now() };
let _inFlight = 0;
const _waitQueue = [];

function _resetState() {
  _bucket.tokens = RATE_CAPACITY;
  _bucket.lastRefill = _now();
  _inFlight = 0;
  _waitQueue.length = 0;
}

function _refillBucket() {
  const now = _now();
  const delta = now - _bucket.lastRefill;
  if (delta <= 0) return;
  _bucket.tokens = Math.min(RATE_CAPACITY, _bucket.tokens + delta * RATE_REFILL_PER_MS);
  _bucket.lastRefill = now;
}

async function _acquireSlot() {
  while (true) {
    _refillBucket();
    if (_bucket.tokens >= 1) { _bucket.tokens -= 1; break; }
    const waitMs = Math.max(50, Math.ceil((1 - _bucket.tokens) / RATE_REFILL_PER_MS));
    await new Promise((r) => setTimeout(r, waitMs));
  }
  if (_inFlight < MAX_CONCURRENT) { _inFlight += 1; return; }
  await new Promise((resolve) => _waitQueue.push({ resolve }));
  _inFlight += 1;
}

function _releaseSlot() {
  _inFlight = Math.max(0, _inFlight - 1);
  while (_inFlight < MAX_CONCURRENT && _waitQueue.length > 0) _waitQueue.shift().resolve();
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

async function _request({ method, path, body, token, queryParams }) {
  if (!token) throw new Error('deploy-vercel: token required');
  let url = `${VERCEL_BASE}${path}`;
  if (queryParams) {
    const qp = new URLSearchParams(queryParams).toString();
    if (qp) url += (path.includes('?') ? '&' : '?') + qp;
  }
  let attempt = 0;
  while (true) {
    await _acquireSlot();
    let res;
    try {
      const init = {
        method,
        headers: {
          'authorization': `Bearer ${token}`,
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
      await new Promise((r) => setTimeout(r, backoff));
      attempt += 1;
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Vercel ${method} ${path} failed (${res.status}): ${text.slice(0, 400)}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }
}

// ---- file conversion --------------------------------------------------

// Vercel's create-deployment endpoint takes files as an array of
//   { file: '<relative-path>', data: '<utf-8 or base64 string>', encoding?: 'base64' }
// We accept the project as a flat `{path: contents}` map (same as
// scaffold-manifest.js's loadScaffold) and convert. Strings ship as
// utf-8; Buffers ship as base64.
function flatToVercelFiles(files) {
  const out = [];
  for (const path of Object.keys(files)) {
    const v = files[path];
    if (typeof v === 'string') {
      out.push({ file: path, data: v });
    } else if (Buffer.isBuffer(v)) {
      out.push({ file: path, data: v.toString('base64'), encoding: 'base64' });
    } else if (v && typeof v === 'object' && typeof v.data === 'string') {
      // Pre-shaped entry; trust the caller
      out.push({ file: path, data: v.data, encoding: v.encoding });
    } else {
      throw new Error(`flatToVercelFiles: file "${path}" must be a string, Buffer, or {data, encoding}`);
    }
  }
  return out;
}

// ---- public API -------------------------------------------------------

/**
 * Create a deployment from a flat `{path: contents}` map.
 *
 * @param {object} args
 * @param {string} args.token       Bearer token
 * @param {string} args.name        Project name (slug; max 100 chars, [a-z0-9-_])
 * @param {Record<string,string>} args.files  Flat path→contents map
 * @param {string=} args.target     'production' (default) or 'preview'
 * @param {string=} args.teamId     For team-scoped tokens
 * @param {string=} args.projectId  Existing project to attach to; omit to auto-create
 * @param {object=} args.projectSettings  e.g. { framework: 'vite' } or null for static
 * @returns {Promise<{id, url, readyState, ...}>}
 */
async function createDeployment({ token, name, files, target = 'production', teamId, projectId, projectSettings }) {
  if (!name) throw new Error('createDeployment: name required');
  if (!files || typeof files !== 'object') throw new Error('createDeployment: files required');
  const fileEntries = flatToVercelFiles(files);
  if (fileEntries.length === 0) throw new Error('createDeployment: at least one file required');
  const body = {
    name,
    files: fileEntries,
    target,
    projectSettings: projectSettings || { framework: null }, // static site
  };
  if (projectId) body.project = projectId;
  return _request({
    method: 'POST',
    path: '/v13/deployments',
    body,
    token,
    queryParams: teamId ? { teamId } : null,
  });
}

async function getDeployment({ token, deploymentId, teamId }) {
  if (!deploymentId) throw new Error('getDeployment: deploymentId required');
  return _request({
    method: 'GET',
    path: `/v13/deployments/${encodeURIComponent(deploymentId)}`,
    token,
    queryParams: teamId ? { teamId } : null,
  });
}

async function listDeployments({ token, projectId, teamId, limit = 20 }) {
  const queryParams = { limit: String(limit) };
  if (projectId) queryParams.projectId = projectId;
  if (teamId) queryParams.teamId = teamId;
  const data = await _request({ method: 'GET', path: '/v6/deployments', token, queryParams });
  return data && data.deployments ? data.deployments : data;
}

/**
 * Convenience: create + poll until terminal state. Returns the final
 * deployment object. Terminal states are READY (success), ERROR
 * (build failed), CANCELED (user/system canceled).
 *
 * Vercel build times for trivial static deployments are typically
 * 5-15s; trivial Vite builds 20-60s. Default timeout is 5 minutes.
 */
async function deployAndWaitUntilReady(args) {
  const { token, teamId, pollIntervalMs = 4000, timeoutMs = 5 * 60 * 1000, onStatus } = args;
  onStatus?.('Uploading files…');
  const created = await createDeployment(args);
  const id = created?.id;
  if (!id) throw new Error('createDeployment returned no id');
  onStatus?.(`Deploying ${id}…`);
  const start = _now();
  while (true) {
    const cur = await getDeployment({ token, deploymentId: id, teamId });
    const state = cur?.readyState || cur?.status;
    if (state === 'READY') { onStatus?.('Deploy ready.'); return cur; }
    if (state === 'ERROR' || state === 'CANCELED') {
      throw new Error(`Vercel deploy ${state.toLowerCase()}: ${cur?.errorMessage || cur?.errorCode || 'unknown'}`);
    }
    if (_now() - start > timeoutMs) throw new Error(`Vercel deploy timed out after ${Math.round((_now() - start) / 1000)}s`);
    onStatus?.(`Building (${state || 'queued'}, ${Math.round((_now() - start) / 1000)}s)`);
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

module.exports = {
  // public API
  createDeployment,
  getDeployment,
  listDeployments,
  deployAndWaitUntilReady,
  // helpers
  flatToVercelFiles,
  // test seams
  _setFetch,
  _setNow,
  _resetState,
  _request,
};
