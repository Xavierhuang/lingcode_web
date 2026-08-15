'use strict';

// cloud-hosted-app-caddy.js — Thin client for Caddy's admin API, scoped to the
// LingCode Cloud "hosted-apps" surface. The runner uses this to attach and
// detach a running app container's port from the wildcard subdomain
// `<slug>.apps.lingcode.dev` at runtime.
//
// Design context: the wildcard cert + Caddy is already terminated on the
// droplet. Each hosted app is a route object pinned by @id="hosted-app-<slug>"
// under /config/apps/http/servers/srv0/routes. Because we address routes by
// @id, `PUT /id/<@id>` is naturally idempotent — Caddy replaces the object in
// place. That is the ONLY primitive we need to attach a slug→port mapping.
//
// Deliberately zero deps: Node's built-in http suffices, matches the style of
// cloud-python-runtime.js (CommonJS, 'use strict', terse-but-commented). Every
// call to createCaddyClient(opts) closes over its own opts — no global state,
// so a single process may hold both staging and prod clients.

const http = require('http');
const { URL } = require('url');

// A slug becomes part of a DNS label AND part of a URL path Caddy uses to
// address the route object. Constrain to the safe intersection: leading
// lowercase letter, then lowercase-alnum-or-hyphen, 1..63 chars total (DNS
// label limit). The runner is expected to have already normalized user input,
// but we validate defensively — the alternative is a puzzling Caddy 400.
const SUBDOMAIN_RE = /^[a-z][a-z0-9-]{0,62}$/;

function _err(message, extra) {
  const e = new Error(message);
  if (extra) Object.assign(e, extra);
  return e;
}

function _validateSubdomain(sub) {
  if (typeof sub !== 'string' || !SUBDOMAIN_RE.test(sub)) {
    throw _err(`invalid subdomain: ${JSON.stringify(sub)}`, { code: 'invalid_subdomain' });
  }
}

function _validatePort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw _err(`invalid port: ${port}`, { code: 'invalid_port' });
  }
}

// Minimal http.request wrapper returning { status, body }. Body is buffered as
// a utf-8 string — Caddy admin responses are always small JSON (or empty). We
// tag connection failures (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, socket hangup)
// with code='caddy_admin_unreachable' so the runner can distinguish "Caddy is
// down / not listening on 2019" from "Caddy said 400".
function _request(adminUrl, method, path, bodyObj) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(path, adminUrl); }
    catch (e) { return reject(_err(`bad adminUrl or path: ${e.message}`, { code: 'invalid_admin_url' })); }

    const bodyBuf = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const req = http.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      method,
      path: u.pathname + (u.search || ''),
      headers: Object.assign(
        { 'Accept': 'application/json' },
        bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {},
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => {
      // ECONNREFUSED / ENOTFOUND / ETIMEDOUT / socket hang up → admin API is unreachable.
      const netCodes = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET'];
      if (netCodes.includes(e.code) || /socket hang up/i.test(String(e.message))) {
        return reject(_err(`caddy admin unreachable: ${e.message}`, { code: 'caddy_admin_unreachable', cause: e }));
      }
      reject(e);
    });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// Build the route object exactly as pinned in the spec. The @id is the primary
// key Caddy uses to address the object under /id/<@id>; keeping it in the
// payload lets a raw config dump round-trip cleanly.
function _buildRoute(subdomain, port, wildcardZone) {
  return {
    '@id': `hosted-app-${subdomain}`,
    match: [{ host: [`${subdomain}.${wildcardZone}`] }],
    handle: [{
      handler: 'reverse_proxy',
      upstreams: [{ dial: `127.0.0.1:${port}` }],
    }],
  };
}

// Passthrough client — every method is a validated no-op that returns success.
// Purpose: on deployments where Caddy is NOT co-located with the API (routing
// is handled by an external edge — nginx + cloud-hosted-app-proxy.js dispatch
// by Host header to 127.0.0.1:<port> without ever needing an in-process route
// injection), the runner still calls upsertRoute/deleteRoute in the deploy
// flow. Under this topology those calls must succeed without doing anything;
// otherwise the runner's upsertRoute failure path aborts every deploy with
// `caddy_upsert_failed`.
//
// Validation is preserved so a caller passing bad inputs still fails fast
// with the same error codes it would get from the admin-api path — matches
// the shape of the real client and keeps regressions detectable.
function _passthroughClient() {
  return {
    async upsertRoute({ subdomain, port } = {}) {
      _validateSubdomain(subdomain);
      _validatePort(port);
      return { ok: true, id: `hosted-app-${subdomain}`, mode: 'passthrough' };
    },
    async deleteRoute({ subdomain } = {}) {
      _validateSubdomain(subdomain);
      return { ok: true, alreadyGone: false, mode: 'passthrough' };
    },
    async listRoutes() { return []; },
    async health() { return true; },
  };
}

function createCaddyClient(opts) {
  // Explicit `mode` opt selects behavior; default preserves original
  // admin-API contract for backward compat with the co-located-Caddy setup
  // described in scripts/bootstrap-hosted-apps.sh.
  const mode = (opts && opts.mode) || 'admin-api';
  if (mode === 'passthrough') return _passthroughClient();
  if (mode !== 'admin-api') {
    throw _err(`unknown caddy client mode: ${JSON.stringify(mode)}`, { code: 'invalid_mode' });
  }

  const adminUrl = (opts && opts.adminUrl) || 'http://127.0.0.1:2019';
  const wildcardZone = (opts && opts.wildcardZone) || 'apps.lingcode.dev';

  // PUT /id/hosted-app-<sub> — idempotent by construction (Caddy replaces the
  // object in place when addressed by @id). We validate inputs, then surface
  // any non-2xx from the admin API as an Error with .status/.body attached so
  // the runner can log the actual Caddy complaint (usually a config schema
  // error) rather than a generic "upsert failed".
  async function upsertRoute({ subdomain, port } = {}) {
    _validateSubdomain(subdomain);
    _validatePort(port);
    const payload = _buildRoute(subdomain, port, wildcardZone);
    const { status, body } = await _request(adminUrl, 'PUT', `/id/hosted-app-${subdomain}`, payload);
    if (status < 200 || status >= 300) {
      throw _err(`caddy upsert failed (${status})`, { status, body });
    }
    return { ok: true, id: payload['@id'] };
  }

  // DELETE /id/hosted-app-<sub> — 404 means "already gone", which is what the
  // caller wanted. Any other non-2xx surfaces as an error with status+body.
  async function deleteRoute({ subdomain } = {}) {
    _validateSubdomain(subdomain);
    const { status, body } = await _request(adminUrl, 'DELETE', `/id/hosted-app-${subdomain}`);
    if (status === 404) return { ok: true, alreadyGone: true };
    if (status < 200 || status >= 300) {
      throw _err(`caddy delete failed (${status})`, { status, body });
    }
    return { ok: true };
  }

  // GET the srv0 routes array and filter to entries this client owns (@id
  // prefixed hosted-app-). We deliberately do NOT invent new admin API paths
  // for a "list" — the config tree IS the list. If srv0 or the routes slot is
  // missing (fresh install), Caddy returns null / an empty array; either way
  // we normalize to [].
  async function listRoutes() {
    const { status, body } = await _request(adminUrl, 'GET', '/config/apps/http/servers/srv0/routes');
    if (status < 200 || status >= 300) {
      throw _err(`caddy list failed (${status})`, { status, body });
    }
    let arr = [];
    try { arr = JSON.parse(body || 'null') || []; } catch (_) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    return arr.filter((r) => r && typeof r['@id'] === 'string' && r['@id'].startsWith('hosted-app-'));
  }

  // Cheap admin API liveness probe — any 2xx from /config/ means Caddy is up
  // and admin is listening. Connection-level failures return false (rather
  // than throwing) because health() is expected on hot paths (readiness, k8s
  // liveness) where callers just want a bool.
  async function health() {
    try {
      const { status } = await _request(adminUrl, 'GET', '/config/');
      return status >= 200 && status < 300;
    } catch (_) {
      return false;
    }
  }

  return { upsertRoute, deleteRoute, listRoutes, health };
}

module.exports = { createCaddyClient };
