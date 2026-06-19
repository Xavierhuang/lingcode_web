'use strict';

// cloud-telemetry.js — Backbone ① of the Firebase-parity push: the telemetry
// plane behind Analytics, Crashlytics, Performance, and Release Monitoring.
//
// Apps POST batches of events to /api/cloud/be/:backendId/telemetry (wired in
// cloud-backend.js, anon-key gated via proxyAuth). We fold them into daily
// aggregates (analytics counters, perf sum/max) + fingerprint-grouped crashes
// AND, for user-level analytics, a 90-day raw event log + per-client
// first/last-seen helper (the hybrid model behind DAU/MAU, retention, funnels,
// and param breakdowns). The raw log is pruned to 90 days so storage stays
// bounded. Owners read summaries from /api/cloud/account/backends/:id/telemetry/*.

const crypto = require('crypto');
const { getUserFromRequest } = require('./auth-helpers');

const MAX_EVENTS_PER_BATCH = 100;
const CRASH_CAP_PER_BACKEND = 500;
const NAME_MAX = 120;
const INGEST_PER_MIN = 600; // per backend

function today() { return new Date().toISOString().slice(0, 10); }
function clampName(s, n) { return String(s == null ? '' : s).slice(0, n || NAME_MAX); }
function sinceDay(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (Math.max(1, Math.min(365, Number(days) || 30))));
  return d.toISOString().slice(0, 10);
}
function fingerprint(message, stack) {
  const top = String(stack || '').split('\n').slice(0, 3).join('\n');
  return crypto.createHash('sha1').update(String(message || '') + '\n' + top).digest('hex').slice(0, 16);
}

const RAW_RETENTION_DAYS = 90;
const PARAM_MAX_KEYS = 25;

// Clamp dev-supplied event params: ≤25 keys, scalar values only, lengths
// bounded. Mirrors Firebase's param limits and keeps the raw log bounded.
// Returns a JSON string (≤2000 chars) or null. Params are dev-controlled; we
// never index their values as PII.
function capParams(params) {
  if (!params || typeof params !== 'object') return null;
  const out = {};
  let n = 0;
  for (const k of Object.keys(params)) {
    if (n >= PARAM_MAX_KEYS) break;
    const v = params[k];
    if (v == null) continue;
    const key = clampName(k, 40);
    if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
    else out[key] = clampName(String(v), 100);
    n++;
  }
  return Object.keys(out).length ? JSON.stringify(out).slice(0, 2000) : null;
}

function dayOf(ts) { return new Date(ts).toISOString().slice(0, 10); }

// Realtime / DebugView: an in-memory ring of recent events per backend (last
// ~200, last 30 min on read). Not persisted — resets on restart, by design.
const REALTIME_CAP = 200;
const REALTIME_WINDOW_MS = 30 * 60 * 1000;
const realtimeBuf = new Map();
function pushRealtime(backendId, ev) {
  let arr = realtimeBuf.get(backendId);
  if (!arr) { arr = []; realtimeBuf.set(backendId, arr); }
  arr.push(ev);
  if (arr.length > REALTIME_CAP) arr.splice(0, arr.length - REALTIME_CAP);
}
function getRealtime(backendId) {
  const cutoff = Date.now() - REALTIME_WINDOW_MS;
  return (realtimeBuf.get(backendId) || []).filter((e) => e.ts >= cutoff);
}

// Throttled prune of the raw log — at most once per backend per 10 min so it
// doesn't cost every batch. Aggregates (analytics_daily) are kept forever.
const _lastPrune = new Map();
function maybePruneRaw(db, backendId) {
  const now = Date.now();
  if (now - (_lastPrune.get(backendId) || 0) < 10 * 60 * 1000) return;
  _lastPrune.set(backendId, now);
  const cutoff = now - RAW_RETENTION_DAYS * 86400000;
  db.prepare('DELETE FROM backend_event_log WHERE backend_id = ? AND ts < ?').run(backendId, cutoff);
}

// ── Pure report computations (no HTTP — unit-testable) ────────────────

// Resolve a segment string into a `<col> IN (subquery)` filter. Formats:
//   prop:<key>:<value> | version:<v> | platform:<p> | event:<name>
// Returns { clause: ' AND ...' (or ''), params: [...] } to splice into a query.
function segClause(backendId, seg, col) {
  col = col || 'client_id';
  if (!seg || typeof seg !== 'string' || seg.indexOf(':') < 0) return { clause: '', params: [] };
  const type = seg.slice(0, seg.indexOf(':'));
  const rest = seg.slice(seg.indexOf(':') + 1);
  if (type === 'prop') {
    const j = rest.indexOf(':');
    const key = clampName(rest.slice(0, j < 0 ? rest.length : j), 60);
    const val = clampName(j < 0 ? '' : rest.slice(j + 1), 120);
    return { clause: ` AND ${col} IN (SELECT client_id FROM backend_client_seen WHERE backend_id = ? AND json_extract(props_json, ?) = ?)`, params: [backendId, '$.' + key, val] };
  }
  if (type === 'version') return { clause: ` AND ${col} IN (SELECT client_id FROM backend_client_seen WHERE backend_id = ? AND app_version = ?)`, params: [backendId, clampName(rest, 60)] };
  if (type === 'platform') return { clause: ` AND ${col} IN (SELECT DISTINCT client_id FROM backend_event_log WHERE backend_id = ? AND platform = ?)`, params: [backendId, clampName(rest, 32)] };
  if (type === 'country') return { clause: ` AND ${col} IN (SELECT client_id FROM backend_client_seen WHERE backend_id = ? AND country = ?)`, params: [backendId, clampName(rest, 2)] };
  if (type === 'event') return { clause: ` AND ${col} IN (SELECT DISTINCT client_id FROM backend_event_log WHERE backend_id = ? AND event_name = ?)`, params: [backendId, clampName(rest, 120)] };
  if (type === 'dormant') {
    // Clients last seen before N days ago (a heuristic churn/at-risk segment).
    const cutoff = sinceDay(parseInt(rest, 10) || 14);
    return { clause: ` AND ${col} IN (SELECT client_id FROM backend_client_seen WHERE backend_id = ? AND last_seen_day < ?)`, params: [backendId, cutoff] };
  }
  return { clause: '', params: [] };
}

// DAU series + rolling WAU/MAU (distinct clients) over the raw log.
function computeActiveUsers(db, backendId, days, seg) {
  const since = sinceDay(days);
  const s = segClause(backendId, seg, 'client_id');
  const series = db.prepare(`SELECT day, COUNT(DISTINCT client_id) AS dau FROM backend_event_log
    WHERE backend_id = ? AND day >= ? AND client_id IS NOT NULL${s.clause} GROUP BY day ORDER BY day`).all(backendId, since, ...s.params);
  const distinct = (d) => db.prepare(`SELECT COUNT(DISTINCT client_id) AS n FROM backend_event_log
    WHERE backend_id = ? AND day >= ? AND client_id IS NOT NULL${s.clause}`).get(backendId, d, ...s.params).n;
  return { series, wau: distinct(sinceDay(7)), mau: distinct(sinceDay(30)) };
}

// Cohort retention: for each first-seen-day cohort, % still active at day-offset N.
function computeRetention(db, backendId, days, offsets, seg) {
  offsets = offsets || [1, 7, 30];
  const since = sinceDay(days);
  const sC = segClause(backendId, seg, 'client_id');
  const sJ = segClause(backendId, seg, 'cs.client_id');
  const cohorts = db.prepare(`SELECT first_seen_day AS cohort, COUNT(*) AS size
    FROM backend_client_seen WHERE backend_id = ? AND first_seen_day >= ?${sC.clause} GROUP BY first_seen_day ORDER BY first_seen_day`).all(backendId, since, ...sC.params);
  const rows = db.prepare(`SELECT cs.first_seen_day AS cohort,
      CAST(julianday(el.day) - julianday(cs.first_seen_day) AS INTEGER) AS off,
      COUNT(DISTINCT el.client_id) AS active
    FROM backend_client_seen cs
    JOIN backend_event_log el ON el.backend_id = cs.backend_id AND el.client_id = cs.client_id
    WHERE cs.backend_id = ? AND cs.first_seen_day >= ?${sJ.clause}
    GROUP BY cohort, off`).all(backendId, since, ...sJ.params);
  const byCohort = {};
  rows.forEach((x) => { (byCohort[x.cohort] = byCohort[x.cohort] || {})[x.off] = x.active; });
  const cohortData = cohorts.map((c) => {
    const ret = {};
    offsets.forEach((n) => {
      const active = (byCohort[c.cohort] || {})[n] || 0;
      ret[n] = c.size ? Math.round((active / c.size) * 100) : 0;
    });
    return { cohort: c.cohort, size: c.size, retention: ret };
  });
  return { offsets, cohorts: cohortData };
}

// Ordered funnel by first-occurrence: clients who fired steps in chronological
// order within the window. Returns per-step reached counts, or null if < 2 steps.
function computeFunnel(db, backendId, steps, days, seg) {
  steps = (steps || []).map((s) => clampName(String(s).trim())).filter(Boolean).slice(0, 8);
  if (steps.length < 2) return null;
  const since = sinceDay(days);
  const ph = steps.map(() => '?').join(',');
  const s = segClause(backendId, seg, 'client_id');
  const rows = db.prepare(`SELECT client_id, event_name, MIN(ts) AS t FROM backend_event_log
    WHERE backend_id = ? AND day >= ? AND client_id IS NOT NULL AND event_name IN (${ph})${s.clause}
    GROUP BY client_id, event_name`).all(backendId, since, ...steps, ...s.params);
  const perClient = {};
  rows.forEach((x) => { (perClient[x.client_id] = perClient[x.client_id] || {})[x.event_name] = x.t; });
  const counts = steps.map(() => 0);
  Object.keys(perClient).forEach((cid) => {
    const m = perClient[cid];
    let prev = -Infinity;
    for (let k = 0; k < steps.length; k++) {
      const t = m[steps[k]];
      if (t == null || t < prev) break;
      counts[k]++; prev = t;
    }
  });
  return steps.map((s, k) => ({ step: s, count: counts[k], pct: counts[0] ? Math.round((counts[k] / counts[0]) * 100) : 0 }));
}

// Engagement-time from user_engagement events' engagement_msec param:
// avg engagement/active-user per day + engaged sessions (>=10s, Firebase's bar).
function computeEngagement(db, backendId, days, seg) {
  const since = sinceDay(days);
  const s = segClause(backendId, seg, 'client_id');
  const rows = db.prepare(`SELECT day, client_id, session_id, params_json FROM backend_event_log
    WHERE backend_id = ? AND day >= ? AND event_name = 'user_engagement'${s.clause}`).all(backendId, since, ...s.params);
  const byDay = {};
  const sessionMs = {};
  rows.forEach((r) => {
    let ms = 0; try { ms = Number((JSON.parse(r.params_json) || {}).engagement_msec) || 0; } catch (e) { ms = 0; }
    const d = byDay[r.day] = byDay[r.day] || { ms: 0, clients: new Set() };
    d.ms += ms; if (r.client_id) d.clients.add(r.client_id);
    if (r.session_id) sessionMs[r.session_id] = (sessionMs[r.session_id] || 0) + ms;
  });
  const sids = Object.keys(sessionMs);
  const engaged = sids.filter((k) => sessionMs[k] >= 10000).length;
  const series = Object.keys(byDay).sort().map((d) => ({
    day: d,
    avg_engagement_sec: byDay[d].clients.size ? Math.round(byDay[d].ms / byDay[d].clients.size / 1000) : 0,
    total_engagement_min: Math.round(byDay[d].ms / 60000),
  }));
  return { series, engaged_sessions: engaged, total_sessions: sids.length, engaged_rate: sids.length ? Math.round((engaged / sids.length) * 100) : 0 };
}

// ── A/B testing + Remote Config ──────────────────────────────────────

// Deterministic 0..65535 bucket from clientId+expId → sticky variant assignment.
function expBucket(clientId, expId) {
  const h = crypto.createHash('sha1').update(String(clientId) + ':' + String(expId)).digest();
  return h[0] + (h[1] << 8);
}

// Resolve running experiments for a client →
// { configs: { param_key: value }, assignments: { expId: variantName } }.
function resolveConfig(db, backendId, clientId) {
  const exps = db.prepare("SELECT id, param_key, variants_json FROM backend_experiments WHERE backend_id = ? AND status = 'running'").all(backendId);
  const configs = {}, assignments = [];
  for (const e of exps) {
    let variants;
    try { variants = JSON.parse(e.variants_json); } catch (_) { continue; }
    if (!Array.isArray(variants) || !variants.length) continue;
    const weights = variants.map((v) => Math.max(0, Number(v.weight) || 0));
    let total = weights.reduce((a, w) => a + w, 0);
    if (total <= 0) { for (let i = 0; i < weights.length; i++) weights[i] = 1; total = variants.length; }
    const pick = clientId ? (expBucket(clientId, e.id) % total) : 0;
    let acc = 0, chosen = variants[0];
    for (let i = 0; i < variants.length; i++) { acc += weights[i]; if (pick < acc) { chosen = variants[i]; break; } }
    configs[e.param_key] = chosen.value;
    assignments.push({ experiment: e.id, param: e.param_key, variant: String(chosen.name || 'control') });
  }
  return { configs, assignments };
}

// Per-backend ingest rate limit (in-memory token bucket, same shape as elsewhere).
const buckets = new Map();
function allowIngest(backendId) {
  const now = Date.now();
  let b = buckets.get(backendId);
  if (!b || now > b.resetAt) { b = { n: 0, resetAt: now + 60000 }; buckets.set(backendId, b); }
  b.n += 1;
  return b.n <= INGEST_PER_MIN;
}

// Fold a batch of events into the aggregates. Returns { accepted }.
function recordEvents(db, backendId, events, opts) {
  if (!Array.isArray(events) || !events.length) return { accepted: 0 };
  const day = today();
  const now = new Date().toISOString();
  const nowMs = Date.now();
  // Country-only geo from Cloudflare's CF-IPCountry (no IP / precise location).
  // Reject CF's non-country sentinels: XX = unknown, T1 = Tor.
  const cc = (opts && typeof opts.country === 'string' && /^[A-Z]{2}$/.test(opts.country) && opts.country !== 'XX' && opts.country !== 'T1') ? opts.country : null;
  const upA = db.prepare(`INSERT INTO backend_analytics_daily (backend_id, day, event_name, app_version, count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(backend_id, day, event_name, app_version) DO UPDATE SET count = count + 1`);
  const upP = db.prepare(`INSERT INTO backend_perf_daily (backend_id, day, metric_name, app_version, count, sum_ms, max_ms)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(backend_id, day, metric_name, app_version) DO UPDATE SET count = count + 1, sum_ms = sum_ms + excluded.sum_ms, max_ms = MAX(max_ms, excluded.max_ms)`);
  const findCrash = db.prepare('SELECT id FROM backend_crashes WHERE backend_id = ? AND fingerprint = ?');
  const bumpCrash = db.prepare('UPDATE backend_crashes SET count = count + 1, last_seen = ?, app_version = ? WHERE id = ?');
  const insCrash = db.prepare(`INSERT INTO backend_crashes (id, backend_id, fingerprint, message, stack, app_version, platform, count, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
  const insLog = db.prepare(`INSERT INTO backend_event_log
    (id, backend_id, ts, day, client_id, user_id, session_id, event_name, params_json, app_version, platform)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upSeen = db.prepare(`INSERT INTO backend_client_seen (backend_id, client_id, first_seen_day, last_seen_day, user_id, app_version, props_json, country)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(backend_id, client_id) DO UPDATE SET
      last_seen_day = excluded.last_seen_day,
      user_id = COALESCE(excluded.user_id, backend_client_seen.user_id),
      app_version = excluded.app_version,
      props_json = COALESCE(excluded.props_json, backend_client_seen.props_json),
      country = COALESCE(excluded.country, backend_client_seen.country)`);

  let accepted = 0;
  const tx = db.transaction((evs) => {
    const n = Math.min(evs.length, MAX_EVENTS_PER_BATCH);
    for (let i = 0; i < n; i++) {
      const e = evs[i] || {};
      const ver = clampName(e.app_version || 'unknown', 60);
      if (e.type === 'crash') {
        const fp = fingerprint(e.message, e.stack);
        const ex = findCrash.get(backendId, fp);
        if (ex) bumpCrash.run(now, ver, ex.id);
        else insCrash.run(crypto.randomUUID(), backendId, fp, clampName(e.message || 'Error', 500), String(e.stack || '').slice(0, 4000), ver, clampName(e.platform || 'web', 32), now, now);
      } else if (e.type === 'perf') {
        const ms = Math.max(0, Number(e.value_ms) || 0);
        upP.run(backendId, day, clampName(e.name || 'trace'), ver, ms, ms);
      } else {
        // Regular analytics event → daily counter (top-line) + raw log
        // (funnels/params/retention) + client first/last-seen (DAU/cohorts).
        const name = clampName(e.name || e.event || 'event');
        let ets = Number(e.ts);
        // Clamp client timestamp; fall back to ingest time + i to keep
        // intra-batch order. Bounds reject clock-skew / spoofed values.
        if (!Number.isFinite(ets) || ets < nowMs - 30 * 86400000 || ets > nowMs + 86400000) ets = nowMs + i;
        const eday = dayOf(ets);
        const cid = e.client_id ? clampName(e.client_id, 64) : null;
        const uid = e.user_id ? clampName(e.user_id, 128) : null;
        const sid = e.session_id ? clampName(e.session_id, 64) : null;
        const plat = clampName(e.platform || 'web', 32);
        const props = capParams(e.user_props);
        upA.run(backendId, eday, name, ver);
        insLog.run(crypto.randomUUID(), backendId, ets, eday, cid, uid, sid, name, capParams(e.params), ver, plat);
        if (cid) upSeen.run(backendId, cid, eday, eday, uid, ver, props, cc);
        pushRealtime(backendId, { name: name, ts: ets, client_id: cid, user_id: uid, platform: plat, params: e.params || null });
      }
      accepted++;
    }
    // Keep crash table bounded — prune the oldest beyond the cap.
    const c = db.prepare('SELECT COUNT(*) AS n FROM backend_crashes WHERE backend_id = ?').get(backendId).n;
    if (c > CRASH_CAP_PER_BACKEND) {
      db.prepare(`DELETE FROM backend_crashes WHERE id IN (
        SELECT id FROM backend_crashes WHERE backend_id = ? ORDER BY last_seen ASC LIMIT ?)`).run(backendId, c - CRASH_CAP_PER_BACKEND);
    }
  });
  tx(events);
  maybePruneRaw(db, backendId);
  return { accepted };
}

// Owner-facing dashboards (session/bearer auth + ownership).
function registerTelemetryOwnerRoutes(app, db) {
  function owner(req, res) {
    const u = getUserFromRequest(db, req);
    if (!u) { res.status(401).json({ ok: false, error: 'unauthorized' }); return null; }
    const id = String(req.params.backendId || '');
    const row = db.prepare('SELECT id FROM account_backends WHERE id = ? AND user_id = ?').get(id, u.id);
    if (!row) { res.status(404).json({ ok: false, error: 'backend_not_found' }); return null; }
    return row;
  }

  // Analytics — top events + a daily total series.
  app.get('/api/cloud/account/backends/:backendId/telemetry/analytics', (req, res) => {
    const r = owner(req, res); if (!r) return;
    const since = sinceDay(req.query.days);
    const top = db.prepare('SELECT event_name, SUM(count) AS total FROM backend_analytics_daily WHERE backend_id = ? AND day >= ? GROUP BY event_name ORDER BY total DESC LIMIT 50').all(r.id, since);
    const series = db.prepare('SELECT day, SUM(count) AS total FROM backend_analytics_daily WHERE backend_id = ? AND day >= ? GROUP BY day ORDER BY day').all(r.id, since);
    res.json({ ok: true, data: { top, series } });
  });

  // Performance — per-metric count / avg / max.
  app.get('/api/cloud/account/backends/:backendId/telemetry/performance', (req, res) => {
    const r = owner(req, res); if (!r) return;
    const since = sinceDay(req.query.days);
    const rows = db.prepare('SELECT metric_name, SUM(count) AS n, SUM(sum_ms) AS s, MAX(max_ms) AS mx FROM backend_perf_daily WHERE backend_id = ? AND day >= ? GROUP BY metric_name ORDER BY n DESC LIMIT 50').all(r.id, since);
    res.json({ ok: true, data: rows.map((x) => ({ metric: x.metric_name, count: x.n, avg_ms: x.n ? Math.round(x.s / x.n) : 0, max_ms: Math.round(x.mx || 0) })) });
  });

  // Crashlytics — fingerprint-grouped crash list, most-recent first.
  app.get('/api/cloud/account/backends/:backendId/telemetry/crashes', (req, res) => {
    const r = owner(req, res); if (!r) return;
    const rows = db.prepare('SELECT fingerprint, message, app_version, platform, count, first_seen, last_seen FROM backend_crashes WHERE backend_id = ? ORDER BY last_seen DESC LIMIT 100').all(r.id);
    res.json({ ok: true, data: rows });
  });

  // Release Monitoring — events + crashes grouped by app_version.
  app.get('/api/cloud/account/backends/:backendId/telemetry/releases', (req, res) => {
    const r = owner(req, res); if (!r) return;
    const since = sinceDay(req.query.days);
    const events = db.prepare('SELECT app_version, SUM(count) AS events FROM backend_analytics_daily WHERE backend_id = ? AND day >= ? GROUP BY app_version').all(r.id, since);
    const crashes = db.prepare('SELECT app_version, SUM(count) AS crashes FROM backend_crashes WHERE backend_id = ? GROUP BY app_version').all(r.id);
    const map = {};
    events.forEach((e) => { map[e.app_version] = { app_version: e.app_version, events: e.events, crashes: 0 }; });
    crashes.forEach((c) => { (map[c.app_version] = map[c.app_version] || { app_version: c.app_version, events: 0, crashes: 0 }).crashes = c.crashes; });
    res.json({ ok: true, data: Object.keys(map).map((k) => map[k]).sort((a, b) => b.events - a.events) });
  });

  // ── Product analytics (user-level): active users, retention, funnels,
  // param breakdowns, conversions — all over the 90-day raw log + client_seen.

  // Active users — DAU series + rolling WAU / MAU (distinct clients).
  app.get('/api/cloud/account/backends/:backendId/telemetry/active-users', (req, res) => {
    const r = owner(req, res); if (!r) return;
    res.json({ ok: true, data: computeActiveUsers(db, r.id, req.query.days, req.query.seg) });
  });

  // Engagement-time — avg engagement/user + engaged sessions.
  app.get('/api/cloud/account/backends/:backendId/telemetry/engagement', (req, res) => {
    const r = owner(req, res); if (!r) return;
    res.json({ ok: true, data: computeEngagement(db, r.id, req.query.days, req.query.seg) });
  });

  // Realtime / DebugView — recent events (in-memory, last 30 min) + live user count.
  app.get('/api/cloud/account/backends/:backendId/telemetry/realtime', (req, res) => {
    const r = owner(req, res); if (!r) return;
    const events = getRealtime(r.id).slice(-100).reverse();
    const active = new Set(events.map((e) => e.client_id).filter(Boolean)).size;
    res.json({ ok: true, data: { events, active, window_min: 30 } });
  });

  // Available segment dimensions — powers the segment dropdown in the console.
  app.get('/api/cloud/account/backends/:backendId/telemetry/segments', (req, res) => {
    const r = owner(req, res); if (!r) return;
    const since = sinceDay(30);
    const versions = db.prepare('SELECT DISTINCT app_version FROM backend_client_seen WHERE backend_id = ? AND app_version IS NOT NULL LIMIT 50').all(r.id).map((x) => x.app_version);
    const platforms = db.prepare('SELECT DISTINCT platform FROM backend_event_log WHERE backend_id = ? AND day >= ? AND platform IS NOT NULL LIMIT 20').all(r.id, since).map((x) => x.platform);
    const countries = db.prepare('SELECT DISTINCT country FROM backend_client_seen WHERE backend_id = ? AND country IS NOT NULL LIMIT 60').all(r.id).map((x) => x.country);
    const events = db.prepare('SELECT event_name, SUM(count) AS t FROM backend_analytics_daily WHERE backend_id = ? AND day >= ? GROUP BY event_name ORDER BY t DESC LIMIT 30').all(r.id, since).map((x) => x.event_name);
    const propRows = db.prepare('SELECT props_json FROM backend_client_seen WHERE backend_id = ? AND props_json IS NOT NULL LIMIT 5000').all(r.id);
    const tally = {};
    propRows.forEach((row) => {
      let p; try { p = JSON.parse(row.props_json); } catch (e) { return; }
      if (!p || typeof p !== 'object') return;
      Object.keys(p).forEach((k) => { const v = String(p[k]).slice(0, 80); const b = (tally[k] = tally[k] || {}); b[v] = (b[v] || 0) + 1; });
    });
    const props = {};
    Object.keys(tally).slice(0, 20).forEach((k) => { props[k] = Object.keys(tally[k]).sort((a, b) => tally[k][b] - tally[k][a]).slice(0, 20); });
    res.json({ ok: true, data: { versions, platforms, countries, events, props } });
  });

  // Raw event export (CSV) — direct access to the raw log (the self-hosted
  // stand-in for a BigQuery export). Capped at 50k rows; downloads in-browser.
  app.get('/api/cloud/account/backends/:backendId/telemetry/export', (req, res) => {
    const r = owner(req, res); if (!r) return;
    const since = sinceDay(req.query.days);
    const cols = ['ts', 'day', 'event_name', 'client_id', 'user_id', 'session_id', 'app_version', 'platform', 'params_json'];
    const rows = db.prepare(`SELECT ${cols.join(', ')} FROM backend_event_log
      WHERE backend_id = ? AND day >= ? ORDER BY ts DESC LIMIT 50000`).all(r.id, since);
    const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    let csv = cols.join(',') + '\n';
    for (const row of rows) csv += cols.map((c) => cell(row[c])).join(',') + '\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="events-${r.id}.csv"`);
    res.send(csv);
  });

  // Retention — cohort grid by first-seen day × % returning on day-offset.
  app.get('/api/cloud/account/backends/:backendId/telemetry/retention', (req, res) => {
    const r = owner(req, res); if (!r) return;
    res.json({ ok: true, data: computeRetention(db, r.id, req.query.days, null, req.query.seg) });
  });

  // Funnel — clients who fired ?steps=a,b,c in chronological (first-occurrence) order.
  app.get('/api/cloud/account/backends/:backendId/telemetry/funnel', (req, res) => {
    const r = owner(req, res); if (!r) return;
    const f = computeFunnel(db, r.id, String(req.query.steps || '').split(','), req.query.days, req.query.seg);
    if (!f) { res.status(400).json({ ok: false, error: 'need_2_steps' }); return; }
    res.json({ ok: true, data: f });
  });

  // Event detail — param value breakdown for one event (top values per key).
  app.get('/api/cloud/account/backends/:backendId/telemetry/events/:name', (req, res) => {
    const r = owner(req, res); if (!r) return;
    const since = sinceDay(req.query.days);
    const name = clampName(req.params.name);
    const rows = db.prepare(`SELECT params_json FROM backend_event_log
      WHERE backend_id = ? AND event_name = ? AND day >= ? AND params_json IS NOT NULL
      ORDER BY ts DESC LIMIT 5000`).all(r.id, name, since);
    const total = db.prepare('SELECT COUNT(*) AS n FROM backend_event_log WHERE backend_id = ? AND event_name = ? AND day >= ?').get(r.id, name, since).n;
    const tally = {};
    rows.forEach((row) => {
      let p; try { p = JSON.parse(row.params_json); } catch (e) { return; }
      if (!p || typeof p !== 'object') return;
      Object.keys(p).forEach((k) => {
        const v = String(p[k]).slice(0, 80);
        const bucket = (tally[k] = tally[k] || {});
        bucket[v] = (bucket[v] || 0) + 1;
      });
    });
    const params = {};
    Object.keys(tally).slice(0, 25).forEach((k) => {
      params[k] = Object.keys(tally[k]).map((v) => ({ value: v, count: tally[k][v] }))
        .sort((a, b) => b.count - a.count).slice(0, 10);
    });
    res.json({ ok: true, data: { event: name, total, sampled: rows.length, params } });
  });

  // Conversions — list key events + conversion rates (distinct converters / clients).
  app.get('/api/cloud/account/backends/:backendId/telemetry/conversions', (req, res) => {
    const r = owner(req, res); if (!r) return;
    const since = sinceDay(req.query.days);
    const keys = db.prepare('SELECT event_name FROM backend_key_events WHERE backend_id = ?').all(r.id).map((x) => x.event_name);
    const totalClients = db.prepare(`SELECT COUNT(DISTINCT client_id) AS n FROM backend_event_log
      WHERE backend_id = ? AND day >= ? AND client_id IS NOT NULL`).get(r.id, since).n;
    const data = keys.map((ev) => {
      const conv = db.prepare(`SELECT COUNT(DISTINCT client_id) AS n FROM backend_event_log
        WHERE backend_id = ? AND event_name = ? AND day >= ? AND client_id IS NOT NULL`).get(r.id, ev, since).n;
      return { event_name: ev, converters: conv, total_clients: totalClients, rate: totalClients ? Math.round((conv / totalClients) * 100) : 0 };
    });
    res.json({ ok: true, data: { conversions: data, total_clients: totalClients } });
  });

  // Mark / unmark a key (conversion) event.
  app.put('/api/cloud/account/backends/:backendId/telemetry/conversions', (req, res) => {
    const r = owner(req, res); if (!r) return;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const ev = clampName(body.event_name || '');
    if (!ev) { res.status(400).json({ ok: false, error: 'event_name_required' }); return; }
    if (body.is_key === false) {
      db.prepare('DELETE FROM backend_key_events WHERE backend_id = ? AND event_name = ?').run(r.id, ev);
    } else {
      db.prepare('INSERT OR IGNORE INTO backend_key_events (backend_id, event_name, created_at) VALUES (?, ?, ?)').run(r.id, ev, new Date().toISOString());
    }
    res.json({ ok: true });
  });

  // Experiments (A/B + Remote Config) — list / upsert / delete.
  app.get('/api/cloud/account/backends/:backendId/experiments', (req, res) => {
    const r = owner(req, res); if (!r) return;
    const rows = db.prepare('SELECT id, param_key, variants_json, status, created_at FROM backend_experiments WHERE backend_id = ? ORDER BY created_at DESC').all(r.id);
    res.json({ ok: true, data: rows.map((x) => { let v; try { v = JSON.parse(x.variants_json); } catch (_) { v = []; } return { id: x.id, param_key: x.param_key, variants: v, status: x.status, created_at: x.created_at }; }) });
  });
  app.put('/api/cloud/account/backends/:backendId/experiments', (req, res) => {
    const r = owner(req, res); if (!r) return;
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const key = clampName(b.param_key || '', 80);
    const variants = Array.isArray(b.variants)
      ? b.variants.slice(0, 10).map((v) => ({ name: clampName(v && v.name ? v.name : 'v', 40), value: v ? v.value : null, weight: Math.max(0, Number(v && v.weight) || 1) }))
      : [];
    if (!key || variants.length < 2) { res.status(400).json({ ok: false, error: 'need_key_and_2_variants' }); return; }
    const status = b.status === 'stopped' ? 'stopped' : 'running';
    if (b.id) {
      const id = clampName(b.id, 64);
      const ex = db.prepare('SELECT id FROM backend_experiments WHERE id = ? AND backend_id = ?').get(id, r.id);
      if (!ex) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      db.prepare('UPDATE backend_experiments SET param_key = ?, variants_json = ?, status = ? WHERE id = ? AND backend_id = ?').run(key, JSON.stringify(variants), status, id, r.id);
      res.json({ ok: true, id });
    } else {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO backend_experiments (id, backend_id, param_key, variants_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, r.id, key, JSON.stringify(variants), status, new Date().toISOString());
      res.json({ ok: true, id });
    }
  });
  app.delete('/api/cloud/account/backends/:backendId/experiments/:expId', (req, res) => {
    const r = owner(req, res); if (!r) return;
    db.prepare('DELETE FROM backend_experiments WHERE backend_id = ? AND id = ?').run(r.id, clampName(req.params.expId, 64));
    res.json({ ok: true });
  });
}

module.exports = {
  recordEvents, registerTelemetryOwnerRoutes, allowIngest, MAX_EVENTS_PER_BATCH,
  computeActiveUsers, computeRetention, computeFunnel, computeEngagement, capParams, segClause,
  resolveConfig,
};
