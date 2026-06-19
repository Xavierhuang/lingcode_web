'use strict';

// cloud-worker-usage.js — metering + daily request-quota enforcement for the
// COMPUTE tier (cloud-workers.js).
//
// Rather than count requests inside each tenant Worker (runtime overhead, and we
// don't control tenant code), we PULL aggregates from Cloudflare's GraphQL
// Analytics API on a schedule. `workersInvocationsAdaptiveGroups` is grouped by
// scriptName (= our worker id) + date, so one query covers every deployed app for
// a day. Results upsert into `worker_usage` (mirrors backend_usage's daily shape).
//
// After refreshing today's counts we enforce per-tier `maxWorkerRequestsPerDay`:
// an over-quota app is auto-suspended with reason 'quota' (setWorkerStatus →
// edge KV). Because suspended apps are refused at the edge they stop accruing
// requests, so at UTC day rollover the new day's count is 0 and the poller
// auto-resumes them (only 'quota' suspensions — never an owner's 'manual' one).
//
// All best-effort: a CF API hiccup logs and skips; it never throws out of the tick
// and never suspends on missing data (fail-open).

const { limitsForTier } = require('./cloud-limits');
const { setWorkerStatus } = require('./cloud-workers');

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CF_API_TOKEN  = process.env.CF_API_TOKEN  || process.env.CLOUDFLARE_API_TOKEN || '';
const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const POLL_MS = 15 * 60 * 1000;   // every 15 min; CF analytics lags a few minutes anyway

function isConfigured() { return !!(CF_ACCOUNT_ID && CF_API_TOKEN); }

// YYYY-MM-DD for a UTC instant.
function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

// Query CF for per-script per-day sums between two YYYY-MM-DD dates (inclusive).
// Returns [{ scriptName, date, requests, errors, cpuMs }] — [] on any error.
async function fetchUsage(sinceDay, untilDay) {
  const query = `
    query($accountTag: string!, $since: string!, $until: string!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            limit: 10000,
            filter: { date_geq: $since, date_leq: $until }
          ) {
            sum { requests errors }
            quantiles { cpuTimeP50 }
            dimensions { scriptName date }
          }
        }
      }
    }`;
  let body;
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { accountTag: CF_ACCOUNT_ID, since: sinceDay, until: untilDay } }),
    });
    body = await res.json();
  } catch (e) {
    console.warn('[worker-usage] CF GraphQL fetch failed:', e && e.message);
    return [];
  }
  if (body && body.errors && body.errors.length) {
    console.warn('[worker-usage] CF GraphQL errors:', JSON.stringify(body.errors).slice(0, 300));
    return [];
  }
  const groups = body?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
  if (!Array.isArray(groups)) return [];
  return groups.map((g) => {
    const requests = (g.sum && g.sum.requests) || 0;
    const errors = (g.sum && g.sum.errors) || 0;
    // cpuTimeP50 is the median microseconds per request; total ms ≈ p50_us * requests / 1000 (approx).
    const p50CpuUs = (g.quantiles && g.quantiles.cpuTimeP50) || 0;
    const cpuMs = Math.round((p50CpuUs * requests) / 1000);
    return { scriptName: g.dimensions && g.dimensions.scriptName, date: g.dimensions && g.dimensions.date, requests, errors, cpuMs };
  }).filter((r) => r.scriptName && r.date);
}

function upsertUsage(db, workerId, day, requests, errors, cpuMs) {
  db.prepare(`
    INSERT INTO worker_usage (worker_id, day, requests, errors, cpu_ms)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(worker_id, day) DO UPDATE SET
      requests = excluded.requests, errors = excluded.errors, cpu_ms = excluded.cpu_ms
  `).run(workerId, day, requests, errors, cpuMs);
}

// Tier (owner) for a worker id — joins to users.tier. 'free' if unknown.
function ownerTier(db, workerId) {
  const row = db.prepare('SELECT u.tier AS tier FROM cloud_workers cw JOIN users u ON u.id = cw.user_id WHERE cw.id = ?').get(workerId);
  return (row && row.tier) || 'free';
}

// After today's counts are fresh, suspend over-quota apps and auto-resume any that
// dropped back under (only 'quota'-reason suspensions).
function enforceQuotas(db) {
  const today = utcDay(Date.now());
  const workers = db.prepare('SELECT id, status, status_reason FROM cloud_workers').all();
  for (const w of workers) {
    const max = limitsForTier(ownerTier(db, w.id)).maxWorkerRequestsPerDay;
    if (typeof max !== 'number' || max <= 0) continue;
    const used = (db.prepare('SELECT requests FROM worker_usage WHERE worker_id = ? AND day = ?').get(w.id, today) || {}).requests || 0;
    if (w.status === 'active' && used >= max) {
      setWorkerStatus(db, w.id, 'suspended', 'quota');
      try { require('./cloud-worker-logs').appendLog(db, w.id, 'warn', `Auto-suspended: exceeded ${max} requests/day (used ${used}).`); } catch (_) {}
      console.warn(`[worker-usage] suspended ${w.id} (over daily quota ${used}/${max})`);
    } else if (w.status === 'suspended' && w.status_reason === 'quota' && used < max) {
      setWorkerStatus(db, w.id, 'active');
      console.log(`[worker-usage] auto-resumed ${w.id} (under quota ${used}/${max})`);
    }
  }
}

let _polling = false;
async function poll(db) {
  if (_polling || !isConfigured()) return;
  _polling = true;
  try {
    const now = Date.now();
    const since = utcDay(now - 24 * 60 * 60 * 1000);   // yesterday (catches late-arriving data)
    const until = utcDay(now);
    const rows = await fetchUsage(since, until);
    // Only record usage for workers we actually own (ignore foreign scripts in the namespace).
    const known = new Set(db.prepare('SELECT id FROM cloud_workers').all().map((r) => r.id));
    for (const r of rows) {
      if (!known.has(r.scriptName)) continue;
      upsertUsage(db, r.scriptName, r.date, r.requests, r.errors, r.cpuMs);
    }
    enforceQuotas(db);
  } catch (e) {
    console.warn('[worker-usage] poll failed:', e && e.message);
  } finally {
    _polling = false;
  }
}

function startWorkerUsagePoller(db) {
  if (!isConfigured()) { console.log('[worker-usage] CF not configured — metering disabled'); return null; }
  poll(db); // prime once at boot
  const handle = setInterval(() => { poll(db); }, POLL_MS);
  if (handle.unref) handle.unref();
  return handle;
}

// ── Usage route ──────────────────────────────────────────────────────────────
function registerWorkerUsageRoutes(app, db) {
  const { workerAccess } = require('./cloud-workers');
  app.get('/api/account/cloud-workers/:id/usage', (req, res) => {
    const ctx = workerAccess(db, req, res, 'viewer'); if (!ctx) return;
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || '30'), 10) || 30));
    const rows = db.prepare('SELECT day, requests, errors, cpu_ms FROM worker_usage WHERE worker_id = ? ORDER BY day DESC LIMIT ?').all(ctx.row.id, days);
    const tier = ownerTier(db, ctx.row.id);
    res.json({ ok: true, data: rows, limit: limitsForTier(tier).maxWorkerRequestsPerDay, status: ctx.row.status || 'active', status_reason: ctx.row.status_reason || null });
  });
}

module.exports = {
  startWorkerUsagePoller,
  registerWorkerUsageRoutes,
  // exported for tests / manual triggers
  poll, enforceQuotas, fetchUsage, utcDay,
};
