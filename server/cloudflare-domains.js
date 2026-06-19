'use strict';

// cloudflare-domains.js — Cloudflare DNS API wrapper.
//
// Two consumer scenarios this module is built for (BOTH unwired in v1):
//   1. Phase 7: User publishes Tier-2 app to Vercel/CF Pages → we
//      auto-CNAME `<chosen>.apps.lingcode.dev` to their deploy URL.
//      Single LingCode-owned zone, single CF token in env.
//   2. Phase 5b future: User connects their OWN domain. They paste a
//      Cloudflare API token (scope: Zone:DNS:Edit on their zone) into
//      the secrets vault; we use it to create the CNAME on their zone.
//
// v1 ships the wrapper + a migration table (prototype_domains). Routes
// and UI are deferred until Phase 7 lands a real deploy target — a
// "Connect domain" button that has nothing to point at would just be
// confusing.
//
// External setup (when wiring lands):
//   - CLOUDFLARE_API_TOKEN env var, scope: Zone:Read + Zone:DNS:Edit
//   - CLOUDFLARE_ZONE_ID env var (the zone for *.apps.lingcode.dev)
//
// Test seam: _setFetch / _resetState. Same shape as supabase-management.

const CLOUDFLARE_BASE = 'https://api.cloudflare.com/client/v4';

// Cloudflare's documented rate limits are 1200 req / 5min per token.
// We're nowhere close to that on a hobby workload, but stay polite.
const RATE_CAPACITY = 60;
const RATE_REFILL_PER_MS = 60 / 60000;
const MAX_CONCURRENT = 6;

const BACKOFF_BASE_MS = 500;
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
  while (_inFlight < MAX_CONCURRENT && _waitQueue.length > 0) {
    _waitQueue.shift().resolve();
  }
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

async function _request({ method, path, body, token }) {
  if (!token) throw new Error('cloudflare-domains: token required (typically process.env.CLOUDFLARE_API_TOKEN)');
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
      res = await _fetch(`${CLOUDFLARE_BASE}${path}`, init);
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
      const err = new Error(`Cloudflare ${method} ${path} failed (${res.status}): ${text.slice(0, 400)}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    if (res.status === 204) return null;
    const json = await res.json();
    // Cloudflare wraps every response in `{ success, errors, messages, result }`.
    // Surface logical errors (success=false) the same way as HTTP errors.
    if (json && json.success === false) {
      const msg = (json.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ');
      const err = new Error(`Cloudflare API error: ${msg || 'unknown'}`);
      err.status = 422;
      err.body = JSON.stringify(json);
      err.errors = json.errors;
      throw err;
    }
    return json && Object.prototype.hasOwnProperty.call(json, 'result') ? json.result : json;
  }
}

// ---- public API -------------------------------------------------------

async function listZones({ token, name }) {
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  const path = '/zones' + (params.toString() ? '?' + params.toString() : '');
  return _request({ method: 'GET', path, token });
}

async function getZoneByName({ token, name }) {
  if (!name) throw new Error('getZoneByName: name required');
  const list = await listZones({ token, name });
  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

async function listDnsRecords({ token, zoneId, type, name }) {
  if (!zoneId) throw new Error('listDnsRecords: zoneId required');
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (name) params.set('name', name);
  const path = `/zones/${encodeURIComponent(zoneId)}/dns_records` + (params.toString() ? '?' + params.toString() : '');
  return _request({ method: 'GET', path, token });
}

// Create a DNS record. For a custom-subdomain CNAME pointing at a
// deploy: { type: 'CNAME', name: 'myapp.apps.lingcode.dev', content: 'random.netlify.app', proxied: true, ttl: 1 }
// Cloudflare requires ttl=1 when proxied=true.
async function createDnsRecord({ token, zoneId, type, name, content, proxied = true, ttl, comment }) {
  if (!zoneId) throw new Error('createDnsRecord: zoneId required');
  if (!type || !name || !content) throw new Error('createDnsRecord: type, name, content required');
  const body = { type, name, content, proxied, ttl: ttl || (proxied ? 1 : 300) };
  if (comment) body.comment = comment;
  return _request({ method: 'POST', path: `/zones/${encodeURIComponent(zoneId)}/dns_records`, body, token });
}

async function updateDnsRecord({ token, zoneId, recordId, type, name, content, proxied, ttl, comment }) {
  if (!zoneId || !recordId) throw new Error('updateDnsRecord: zoneId + recordId required');
  const body = {};
  if (type) body.type = type;
  if (name) body.name = name;
  if (content) body.content = content;
  if (proxied !== undefined) body.proxied = proxied;
  if (ttl !== undefined) body.ttl = ttl;
  if (comment !== undefined) body.comment = comment;
  return _request({
    method: 'PATCH',
    path: `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
    body, token,
  });
}

async function deleteDnsRecord({ token, zoneId, recordId }) {
  if (!zoneId || !recordId) throw new Error('deleteDnsRecord: zoneId + recordId required');
  return _request({
    method: 'DELETE',
    path: `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
    token,
  });
}

// Verify a hostname resolves to the expected CNAME target via public DNS.
// Uses Cloudflare's own DoH endpoint so we don't depend on the Node
// runtime having a working `dns` module config. Returns a structured
// `{ ok, observed, expected, propagated, raw }` object — never throws on
// "not yet propagated"; throws only for protocol errors.
async function verifyDnsCNAME({ hostname, expectedTarget }) {
  if (!hostname || !expectedTarget) throw new Error('verifyDnsCNAME: hostname + expectedTarget required');
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=CNAME`;
  const res = await _fetch(url, { headers: { accept: 'application/dns-json' } });
  if (!res.ok) {
    return { ok: false, propagated: false, observed: null, expected: expectedTarget, error: `DoH lookup failed (${res.status})` };
  }
  const json = await res.json();
  const answers = (json.Answer || []).filter((a) => a.type === 5); // 5 = CNAME
  // Cloudflare's DoH API returns CNAME values with a trailing dot. Normalize.
  const observed = answers.map((a) => String(a.data || '').replace(/\.$/, '').toLowerCase());
  const expected = String(expectedTarget).replace(/\.$/, '').toLowerCase();
  const propagated = observed.some((v) => v === expected);
  return { ok: true, propagated, observed, expected, raw: json };
}

module.exports = {
  // public API
  listZones,
  getZoneByName,
  listDnsRecords,
  createDnsRecord,
  updateDnsRecord,
  deleteDnsRecord,
  verifyDnsCNAME,
  // test seams
  _setFetch,
  _setNow,
  _resetState,
  _request,
};
