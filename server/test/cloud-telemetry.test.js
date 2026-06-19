// Tests for the user-level product-analytics layer: ingest (raw log +
// client_seen + params cap + prune) and the report computations
// (active-users / retention / funnel).

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  recordEvents, capParams,
  computeActiveUsers, computeRetention, computeFunnel, computeEngagement, resolveConfig,
} = require('../cloud-telemetry.js');

// Day string N days before today (UTC), matching the server's bucketing.
function dayAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function msAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.getTime();
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE backend_event_log (
      id TEXT PRIMARY KEY, backend_id TEXT, ts INTEGER, day TEXT, client_id TEXT,
      user_id TEXT, session_id TEXT, event_name TEXT, params_json TEXT,
      app_version TEXT, platform TEXT);
    CREATE TABLE backend_client_seen (
      backend_id TEXT, client_id TEXT, first_seen_day TEXT, last_seen_day TEXT,
      user_id TEXT, app_version TEXT, props_json TEXT, country TEXT, PRIMARY KEY (backend_id, client_id));
    CREATE TABLE backend_analytics_daily (
      backend_id TEXT, day TEXT, event_name TEXT, app_version TEXT DEFAULT 'unknown',
      count INTEGER DEFAULT 0, PRIMARY KEY (backend_id, day, event_name, app_version));
    CREATE TABLE backend_perf_daily (
      backend_id TEXT, day TEXT, metric_name TEXT, app_version TEXT DEFAULT 'unknown',
      count INTEGER DEFAULT 0, sum_ms REAL DEFAULT 0, max_ms REAL DEFAULT 0,
      PRIMARY KEY (backend_id, day, metric_name, app_version));
    CREATE TABLE backend_crashes (
      id TEXT PRIMARY KEY, backend_id TEXT, fingerprint TEXT, message TEXT, stack TEXT,
      app_version TEXT, platform TEXT, count INTEGER DEFAULT 1, first_seen TEXT, last_seen TEXT,
      UNIQUE (backend_id, fingerprint));
    CREATE TABLE backend_key_events (
      backend_id TEXT, event_name TEXT, created_at TEXT, PRIMARY KEY (backend_id, event_name));
    CREATE TABLE backend_experiments (
      id TEXT PRIMARY KEY, backend_id TEXT, param_key TEXT, variants_json TEXT,
      status TEXT DEFAULT 'running', created_at TEXT);
  `);
  return db;
}

// Seed a raw event_log row directly (bypasses ingest clamps for report tests).
let _seedN = 0;
function seed(db, be, client, day, name, ts) {
  db.prepare(`INSERT INTO backend_event_log (id, backend_id, ts, day, client_id, event_name, app_version, platform)
    VALUES (?, ?, ?, ?, ?, ?, '1.0', 'web')`).run(`seed-${++_seedN}`, be, ts, day, client, name);
}
function seedClient(db, be, client, firstDay, lastDay) {
  db.prepare(`INSERT INTO backend_client_seen (backend_id, client_id, first_seen_day, last_seen_day)
    VALUES (?, ?, ?, ?)`).run(be, client, firstDay, lastDay);
}
function seedClientProps(db, be, client, day, props) {
  db.prepare(`INSERT INTO backend_client_seen (backend_id, client_id, first_seen_day, last_seen_day, props_json)
    VALUES (?, ?, ?, ?, ?)`).run(be, client, day, day, props ? JSON.stringify(props) : null);
}
function seedEng(db, be, client, session, day, ms) {
  db.prepare(`INSERT INTO backend_event_log (id, backend_id, ts, day, client_id, session_id, event_name, params_json, app_version, platform)
    VALUES (?, ?, ?, ?, ?, ?, 'user_engagement', ?, '1.0', 'web')`).run('seedeng-' + (++_seedN), be, ms, day, client, session, JSON.stringify({ engagement_msec: ms }));
}

describe('recordEvents ingest', () => {
  let db;
  beforeEach(() => { db = makeDb(); });

  test('regular event writes raw log + daily aggregate + client_seen', () => {
    const ts = Date.now();
    recordEvents(db, 'b1', [{ type: 'event', name: 'view_profile', client_id: 'c1', session_id: 's1', ts, app_version: '2.0', params: { tab: 'photos' } }]);

    const log = db.prepare('SELECT * FROM backend_event_log WHERE backend_id = ?').all('b1');
    assert.equal(log.length, 1);
    assert.equal(log[0].event_name, 'view_profile');
    assert.equal(log[0].client_id, 'c1');
    assert.equal(log[0].session_id, 's1');
    assert.deepEqual(JSON.parse(log[0].params_json), { tab: 'photos' });

    const agg = db.prepare('SELECT count FROM backend_analytics_daily WHERE backend_id = ? AND event_name = ?').get('b1', 'view_profile');
    assert.equal(agg.count, 1);

    const seen = db.prepare('SELECT * FROM backend_client_seen WHERE backend_id = ? AND client_id = ?').get('b1', 'c1');
    assert.ok(seen);
    assert.equal(seen.first_seen_day, seen.last_seen_day);
  });

  test('first_seen_day is preserved; last_seen_day advances', () => {
    recordEvents(db, 'b1', [{ type: 'event', name: 'a', client_id: 'c1', ts: msAgo(3) }]);
    recordEvents(db, 'b1', [{ type: 'event', name: 'b', client_id: 'c1', ts: msAgo(1) }]);
    const seen = db.prepare('SELECT * FROM backend_client_seen WHERE backend_id = ? AND client_id = ?').get('b1', 'c1');
    assert.equal(seen.first_seen_day, dayAgo(3));
    assert.equal(seen.last_seen_day, dayAgo(1));
  });

  test('crash and perf events route to their own tables, not the raw log', () => {
    recordEvents(db, 'b1', [
      { type: 'crash', message: 'Boom', stack: 'x', client_id: 'c1' },
      { type: 'perf', name: 'load', value_ms: 120, client_id: 'c1' },
    ]);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM backend_crashes WHERE backend_id = ?').get('b1').n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM backend_perf_daily WHERE backend_id = ?').get('b1').n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM backend_event_log WHERE backend_id = ?').get('b1').n, 0);
  });

  test('prune drops raw rows older than 90 days on first ingest for a backend', () => {
    // Insert a 100-day-old row directly, then ingest one fresh event (first
    // call for this backend ⇒ prune runs).
    seed(db, 'b-prune', 'old', dayAgo(100), 'stale', Date.now() - 100 * 86400000);
    recordEvents(db, 'b-prune', [{ type: 'event', name: 'fresh', client_id: 'cNew', ts: Date.now() }]);
    const names = db.prepare('SELECT event_name FROM backend_event_log WHERE backend_id = ?').all('b-prune').map((r) => r.event_name);
    assert.deepEqual(names, ['fresh']); // stale pruned, fresh kept
  });

  test('events without a client_id still aggregate but skip client_seen', () => {
    recordEvents(db, 'b1', [{ type: 'event', name: 'anon_evt', ts: Date.now() }]);
    assert.equal(db.prepare('SELECT count FROM backend_analytics_daily WHERE backend_id=? AND event_name=?').get('b1', 'anon_evt').count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM backend_client_seen WHERE backend_id=?').get('b1').n, 0);
  });
});

describe('capParams', () => {
  test('caps to 25 keys, clamps values, drops null', () => {
    const big = {};
    for (let i = 0; i < 40; i++) big['k' + i] = 'v' + i;
    big.longval = 'x'.repeat(500);
    big.nullval = null;
    const parsed = JSON.parse(capParams(big));
    assert.ok(Object.keys(parsed).length <= 25);
    if (parsed.longval) assert.ok(parsed.longval.length <= 100);
    assert.ok(!('nullval' in parsed));
  });
  test('returns null for empty / non-object', () => {
    assert.equal(capParams(null), null);
    assert.equal(capParams({}), null);
  });
});

describe('computeActiveUsers', () => {
  test('DAU per day = distinct clients', () => {
    const db = makeDb();
    seed(db, 'b2', 'a', dayAgo(2), 'e', 1);
    seed(db, 'b2', 'b', dayAgo(2), 'e', 1);
    seed(db, 'b2', 'a', dayAgo(1), 'e', 1); // a returns
    seed(db, 'b2', 'c', dayAgo(1), 'e', 1);
    const out = computeActiveUsers(db, 'b2', 30);
    const byDay = Object.fromEntries(out.series.map((s) => [s.day, s.dau]));
    assert.equal(byDay[dayAgo(2)], 2);
    assert.equal(byDay[dayAgo(1)], 2);
    assert.equal(out.wau, 3); // a, b, c distinct in last 7d
  });
});

describe('computeRetention', () => {
  test('cohort retention at day-offset 1', () => {
    const db = makeDb();
    const d0 = dayAgo(5), d1 = dayAgo(4);
    ['c1', 'c2', 'c3'].forEach((c) => seedClient(db, 'b3', c, d0, d1));
    // all active on d0; only c1 and c3 active on d1
    ['c1', 'c2', 'c3'].forEach((c) => seed(db, 'b3', c, d0, 'e', 1));
    seed(db, 'b3', 'c1', d1, 'e', 2);
    seed(db, 'b3', 'c3', d1, 'e', 2);
    const out = computeRetention(db, 'b3', 365);
    const cohort = out.cohorts.find((c) => c.cohort === d0);
    assert.equal(cohort.size, 3);
    assert.equal(cohort.retention[1], 67); // 2/3 rounded
  });
});

describe('computeFunnel', () => {
  test('ordered first-occurrence funnel counts', () => {
    const db = makeDb();
    const d = dayAgo(1);
    // A: A,B,C in order | B: A,B | C: A,C (no B) | D: B then A (out of order)
    seed(db, 'b4', 'A', d, 'stepA', 1); seed(db, 'b4', 'A', d, 'stepB', 2); seed(db, 'b4', 'A', d, 'stepC', 3);
    seed(db, 'b4', 'B', d, 'stepA', 1); seed(db, 'b4', 'B', d, 'stepB', 2);
    seed(db, 'b4', 'C', d, 'stepA', 1); seed(db, 'b4', 'C', d, 'stepC', 2);
    seed(db, 'b4', 'D', d, 'stepB', 1); seed(db, 'b4', 'D', d, 'stepA', 2);
    const out = computeFunnel(db, 'b4', ['stepA', 'stepB', 'stepC'], 30);
    assert.deepEqual(out.map((s) => s.count), [4, 2, 1]);
    assert.equal(out[1].pct, 50); // 2/4
  });
  test('returns null for fewer than 2 steps', () => {
    assert.equal(computeFunnel(makeDb(), 'b4', ['only'], 30), null);
  });
});

describe('user properties + segments', () => {
  test('recordEvents stores latest user_props on client_seen', () => {
    const db = makeDb();
    recordEvents(db, 'bup', [{ type: 'event', name: 'a', client_id: 'c1', ts: Date.now(), user_props: { plan: 'pro', tier: 'gold' } }]);
    const seen = db.prepare('SELECT props_json FROM backend_client_seen WHERE backend_id=? AND client_id=?').get('bup', 'c1');
    assert.deepEqual(JSON.parse(seen.props_json), { plan: 'pro', tier: 'gold' });
  });

  test('prop segment filters reports to matching clients', () => {
    const db = makeDb();
    const d = dayAgo(1);
    seedClientProps(db, 'bseg', 'p1', d, { plan: 'pro' });
    seedClientProps(db, 'bseg', 'p2', d, { plan: 'free' });
    seed(db, 'bseg', 'p1', d, 'open', 1);
    seed(db, 'bseg', 'p2', d, 'open', 1);
    assert.equal(computeActiveUsers(db, 'bseg', 30).series.find((s) => s.day === d).dau, 2);
    assert.equal(computeActiveUsers(db, 'bseg', 30, 'prop:plan:pro').series.find((s) => s.day === d).dau, 1);
  });

  test('event segment filters to clients who fired the event', () => {
    const db = makeDb();
    const d = dayAgo(1);
    seed(db, 'bev', 'a', d, 'purchase', 1);
    seed(db, 'bev', 'a', d, 'open', 2);
    seed(db, 'bev', 'b', d, 'open', 1);
    assert.equal(computeActiveUsers(db, 'bev', 30, 'event:purchase').series.find((s) => s.day === d).dau, 1);
  });

  test('country: stored from CF header (valid only) + segments by country', () => {
    const db = makeDb();
    const ts = Date.now();
    recordEvents(db, 'bc', [{ type: 'event', name: 'a', client_id: 'us1', ts }], { country: 'US' });
    recordEvents(db, 'bc', [{ type: 'event', name: 'a', client_id: 'gb1', ts }], { country: 'GB' });
    recordEvents(db, 'bc', [{ type: 'event', name: 'a', client_id: 'x1', ts }], { country: 'XX' }); // CF unknown → rejected
    assert.equal(db.prepare('SELECT country FROM backend_client_seen WHERE client_id=?').get('us1').country, 'US');
    assert.equal(db.prepare('SELECT country FROM backend_client_seen WHERE client_id=?').get('x1').country, null);
    assert.equal(computeActiveUsers(db, 'bc', 30, 'country:US').series.reduce((a, s) => a + s.dau, 0), 1);
  });

  test('dormant segment filters to clients not seen in N days', () => {
    const db = makeDb();
    seedClient(db, 'bdorm', 'd1', dayAgo(20), dayAgo(10)); // last seen 10d ago → dormant for :7
    seedClient(db, 'bdorm', 'r1', dayAgo(5), dayAgo(1));   // last seen 1d ago → active
    seed(db, 'bdorm', 'd1', dayAgo(10), 'open', 1);
    seed(db, 'bdorm', 'r1', dayAgo(1), 'open', 1);
    const dorm = computeActiveUsers(db, 'bdorm', 30, 'dormant:7');
    assert.equal(dorm.series.reduce((a, s) => a + s.dau, 0), 1); // only d1
    assert.ok(dorm.series.find((s) => s.day === dayAgo(10)));
    assert.ok(!dorm.series.find((s) => s.day === dayAgo(1)));
  });
});

describe('resolveConfig (A/B + remote config)', () => {
  function makeExp(db, be, key, variants, status) {
    db.prepare("INSERT INTO backend_experiments (id, backend_id, param_key, variants_json, status, created_at) VALUES (?,?,?,?,?,?)")
      .run(be + '-' + key, be, key, JSON.stringify(variants), status || 'running', '2026-01-01');
  }

  test('deterministic: same client always gets the same variant', () => {
    const db = makeDb();
    makeExp(db, 'bx', 'color', [{ name: 'a', value: 'red', weight: 50 }, { name: 'b', value: 'blue', weight: 50 }]);
    const r1 = resolveConfig(db, 'bx', 'client_42');
    const r2 = resolveConfig(db, 'bx', 'client_42');
    assert.deepEqual(r1, r2);
    assert.equal(r1.assignments.length, 1);
    assert.ok(['red', 'blue'].includes(r1.configs.color));
    assert.equal(r1.assignments[0].param, 'color');
  });

  test('distribution roughly follows weights (80/20)', () => {
    const db = makeDb();
    makeExp(db, 'by', 'flag', [{ name: 'on', value: true, weight: 80 }, { name: 'off', value: false, weight: 20 }]);
    let on = 0;
    for (let i = 0; i < 1000; i++) if (resolveConfig(db, 'by', 'c' + i).configs.flag === true) on++;
    assert.ok(on > 720 && on < 880, `expected ~800 on, got ${on}`); // 80% ± tolerance
  });

  test('stopped experiments are not served', () => {
    const db = makeDb();
    makeExp(db, 'bz', 'k', [{ name: 'a', value: 1, weight: 1 }, { name: 'b', value: 2, weight: 1 }], 'stopped');
    assert.deepEqual(resolveConfig(db, 'bz', 'c1'), { configs: {}, assignments: [] });
  });
});

describe('computeEngagement', () => {
  test('avg engagement per user + engaged sessions (>=10s)', () => {
    const db = makeDb();
    const d = dayAgo(1);
    seedEng(db, 'beng', 'a', 's1', d, 8000);
    seedEng(db, 'beng', 'a', 's1', d, 4000); // s1 total 12000 → engaged
    seedEng(db, 'beng', 'b', 's2', d, 3000); // s2 total 3000 → not engaged
    const e = computeEngagement(db, 'beng', 30);
    assert.equal(e.series.find((s) => s.day === d).avg_engagement_sec, 8); // 15000ms / 2 clients / 1000
    assert.equal(e.engaged_sessions, 1);
    assert.equal(e.total_sessions, 2);
    assert.equal(e.engaged_rate, 50);
  });
});
