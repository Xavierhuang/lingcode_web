'use strict';

// metrics.js — Prometheus metrics for the admin API. prom-client is OPTIONAL:
// if it isn't installed (e.g. npm install hasn't run yet) the whole module
// degrades to no-ops so the server still boots — same posture as the lazy
// pg/bcrypt/jwt requires elsewhere.
//
// Exposed at GET /metrics (token-gated by METRICS_TOKEN). Prometheus scrapes it
// over the private VPC; nginx must NOT expose /metrics publicly.

let client = null;
try { client = require('prom-client'); } catch (_) { client = null; }

const TOKEN = process.env.METRICS_TOKEN || '';
const SLOW_QUERY_MS = Number(process.env.CLOUD_PG_SLOW_MS || 500);

let registry = null, httpDuration = null, httpTotal = null, queryDuration = null;
let poolGaugesRegistered = false;

if (client) {
  registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry }); // process cpu/mem/eventloop
  httpDuration = new client.Histogram({
    name: 'lingcode_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.025, 0.1, 0.3, 1, 3, 10],
    registers: [registry],
  });
  httpTotal = new client.Counter({
    name: 'lingcode_http_requests_total',
    help: 'HTTP requests total',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });
  queryDuration = new client.Histogram({
    name: 'lingcode_cloud_query_duration_seconds',
    help: 'Cloud data-plane query duration in seconds',
    labelNames: ['op'],
    buckets: [0.005, 0.025, 0.1, 0.3, 1, 3, 10],
    registers: [registry],
  });
}

function enabled() { return !!client; }

// Low-cardinality route label: the Express route PATTERN (e.g.
// /api/cloud/account/backends/:backendId/functions), never the raw URL (which
// carries ids/slugs and would explode cardinality). Unmatched → a fixed bucket.
function routeLabel(req) {
  if (req.route && req.route.path) return (req.baseUrl || '') + req.route.path;
  return '(unmatched)';
}

// Express middleware: time every request, record on response finish.
function middleware() {
  if (!client) return function (req, res, next) { next(); };
  return function (req, res, next) {
    const start = process.hrtime.bigint();
    res.on('finish', function () {
      try {
        const labels = { method: req.method, route: routeLabel(req), status: String(res.statusCode) };
        const dur = Number(process.hrtime.bigint() - start) / 1e9;
        httpDuration.observe(labels, dur);
        httpTotal.inc(labels);
      } catch (_) { /* metrics must never break a request */ }
    });
    next();
  };
}

// Record a cloud data-plane query duration (seconds). op = 'tenant' | 'admin' | …
function observeQuery(op, seconds) {
  if (!client) return;
  try { queryDuration.observe({ op: op || 'tenant' }, seconds); } catch (_) {}
}

const slowQueryMs = () => SLOW_QUERY_MS;

// Register pg pool gauges, sourced from a stats fn ({ total, idle, waiting }).
// Called once from index.js with dataPlane.poolStats so this module stays
// decoupled from cloud-data-plane.
function registerPoolGauges(getStats) {
  if (!client || poolGaugesRegistered || typeof getStats !== 'function') return;
  poolGaugesRegistered = true;
  const mk = (name, help, pick) => new client.Gauge({
    name, help, registers: [registry],
    collect() { try { this.set(Number(pick(getStats()) || 0)); } catch (_) {} },
  });
  mk('lingcode_cloud_pg_pool_total', 'pg pool total clients', (s) => s.total);
  mk('lingcode_cloud_pg_pool_idle', 'pg pool idle clients', (s) => s.idle);
  mk('lingcode_cloud_pg_pool_waiting', 'pg pool requests queued for a client', (s) => s.waiting);
}

// GET /metrics handler — token-gated (Bearer header or ?token=). When no token
// is configured (local dev) it serves openly; prod sets METRICS_TOKEN and nginx
// keeps /metrics off the public vhost.
async function handler(req, res) {
  if (!client) return res.status(503).type('text/plain').send('# metrics disabled (prom-client not installed)\n');
  if (TOKEN) {
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const q = (req.query && req.query.token) || '';
    if (bearer !== TOKEN && q !== TOKEN) return res.status(401).type('text/plain').send('unauthorized\n');
  }
  try {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (err) {
    res.status(500).type('text/plain').send('metrics error\n');
  }
}

module.exports = { enabled, middleware, handler, observeQuery, registerPoolGauges, slowQueryMs };
