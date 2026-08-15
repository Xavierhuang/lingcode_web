'use strict';

// cloud-hosted-app-proxy.js — Host-header dispatcher for the Python app-hosting
// tier. Incoming requests to `<slug>.apps.lingcode.dev` arrive here via the
// nginx :8081 VPC listener (see /etc/nginx/sites-enabled/lingcode-apps-edge),
// which reverse-proxies over the private network from the Caddy edge on the
// custom-domain droplet. We look up the container port from `hosted_apps` and
// stream-proxy the request to `127.0.0.1:<port>` where the app's Docker
// container publishes its port (see cloud-hosted-app-runner.js — every
// container runs with `-p 127.0.0.1:<port>:8080`).
//
// Ordering (CRITICAL): install this BEFORE any body-parser or session
// middleware in index.js. If body-parsing runs first, the request body has
// already been consumed and cannot be piped upstream — POST/PUT with a
// request body would arrive empty at the container.
//
// Ordering (CRITICAL, second reason): install this BEFORE
// installCustomDomainMiddleware. The custom-domain middleware rewrites
// hostnames it recognizes into `/p/<prototype_id>` paths for the public
// share-link renderer; hosted-app subdomains must not go through that
// rewrite.
//
// Non-goals for MVP (per the design spec — docs/superpowers/specs/
// 2026-08-13-python-app-hosting-design.md "Non-goals"): WebSocket upgrades
// (requires app.on('upgrade')), zero-downtime container swap (~1s drop on
// deploy), scale-to-zero. All deferred to v2.

const http = require('http');

// Same env var + default as cloud-domains.js and cloud-hosted-app-caddy.js.
// Kept in ONE place would be nicer, but that requires a shared constants
// module and the three files evolved independently — the risk of the three
// falling out of sync is low (all three read the same env var, all three
// default to the same string, verified by grep).
const HOSTED_APPS_ZONE = (process.env.HOSTED_APP_WILDCARD_ZONE || 'apps.lingcode.dev').toLowerCase();

// Hop-by-hop headers that MUST NOT be forwarded per RFC 7230 §6.1. Downstream
// intermediaries treat these as their own; forwarding them causes broken
// connection reuse, keep-alive leaks, and (with `Upgrade`) accidental
// WebSocket-adjacent behavior we don't support in MVP.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

function stripHopByHop(headers) {
  const out = {};
  for (const k of Object.keys(headers || {})) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = headers[k];
  }
  return out;
}

// Parse `<slug>.<zone>` out of a Host header (which may include :port). Rejects
// the bare zone, nested subdomains (`foo.bar.<zone>`), suffix-match traps
// (`notapps.lingcode.dev` when zone is `apps.lingcode.dev`), and illegal DNS
// labels. Returns the slug in lowercase, or null.
//
// Kept as a separate exported helper so tests can hit it directly and any
// future migration can reuse the exact same parser.
function extractHostedAppSubdomain(hostHeader, zone) {
  if (!hostHeader || !zone) return null;
  const host = String(hostHeader).split(':')[0].trim().toLowerCase();
  const suffix = '.' + zone;
  if (!host.endsWith(suffix)) return null;
  const slug = host.slice(0, host.length - suffix.length);
  if (!slug || slug.includes('.')) return null;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) return null;
  return slug;
}

// Minimal HTML placeholder for the not-live states. Kept small + inlined so
// there's no template dependency and no filesystem hit on the hot path. The
// Cache-Control: no-store is important — Cloudflare/browsers should NOT cache
// a "still building" page for a slug whose real app is coming online.
function respondPlaceholder(res, statusCode, subject, message) {
  if (res.headersSent) return;
  const html =
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${escapeHtml(subject)} · LingCode Cloud</title>` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
    'max-width:640px;margin:64px auto;padding:0 20px;color:#111;line-height:1.5}' +
    'h1{font-size:1.5rem;margin:0 0 12px}p{color:#555}</style></head><body>' +
    `<h1>${escapeHtml(subject)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(html);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Install the middleware on `app`. Uses a prepared statement — better-sqlite3
// caches the plan and this is O(1) per request. The middleware short-circuits
// (returns without calling next()) once it has decided the request is for a
// hosted app; otherwise it hands off to the rest of the chain so lingcode.dev
// traffic is unaffected.
function installHostedAppProxy(app, db, opts) {
  const zone = ((opts && opts.zone) || HOSTED_APPS_ZONE).toLowerCase();
  const lookup = db.prepare(
    "SELECT id, subdomain, status, port FROM hosted_apps WHERE subdomain = ? AND status != 'deleted'"
  );

  app.use((req, res, next) => {
    const slug = extractHostedAppSubdomain(req.headers.host, zone);
    if (!slug) return next(); // Not a hosted-app hostname — normal traffic.

    const row = lookup.get(slug);
    if (!row) {
      // The Caddy ask endpoint (cloud-domains.js /api/cloud/domains/verify)
      // should have 403'd this before minting a cert, so seeing an unknown
      // slug HERE means either (a) an in-flight window between DELETE and
      // ask-cache expiry, or (b) a bug. Either way, a clean 404 is safe.
      return respondPlaceholder(res, 404, 'App not found',
        'No LingCode Cloud hosted app is registered at this subdomain.');
    }

    switch (row.status) {
      case 'building':
        return respondPlaceholder(res, 503, 'Building',
          'This app is still building its first deploy. Refresh in a moment.');
      case 'paused':
        return respondPlaceholder(res, 503, 'Paused',
          'This app is paused by its owner.');
      case 'crashed':
        return respondPlaceholder(res, 502, 'Crashed',
          'This app crashed and is being restarted. Refresh in a moment.');
      case 'running':
        break;
      default:
        return respondPlaceholder(res, 500, 'Unknown state',
          'This app is in an unexpected state.');
    }

    if (!row.port) {
      // Runner sets `port` synchronously with the container start; a running
      // app with a null port is a schema-invariant violation.
      return respondPlaceholder(res, 503, 'Not ready',
        'This app is running but has no port allocated yet.');
    }

    // Reverse-proxy. Native Node http.request — no extra dependency.
    const upstream = http.request({
      host: '127.0.0.1',
      port: row.port,
      method: req.method,
      // Use req.url (native) not req.originalUrl (Express-specific) — this
      // middleware runs before Express router mounts, so they're identical.
      path: req.url,
      headers: stripHopByHop(req.headers),
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, stripHopByHop(upstreamRes.headers));
      upstreamRes.pipe(res);
    });

    upstream.on('error', (err) => {
      // ECONNREFUSED = container is down (crash between our lookup + this
      // connect). ETIMEDOUT = container hung. Give the caller something
      // more informative than an opaque 502.
      const code = err && err.code ? String(err.code) : 'unknown';
      if (res.headersSent) {
        try { res.destroy(); } catch (_) {}
        return;
      }
      respondPlaceholder(res, 502, 'Bad gateway',
        `Cannot reach the app container (${code}). The runner will restart it shortly.`);
    });

    // Client disconnect → tear down upstream so we don't leak sockets.
    req.on('aborted', () => { try { upstream.destroy(); } catch (_) {} });

    req.pipe(upstream);
  });
}

module.exports = {
  installHostedAppProxy,
  extractHostedAppSubdomain,
};
