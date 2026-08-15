'use strict';

// Schema migration for the Preview hosted Python apps tier. Full design at
// docs/superpowers/specs/2026-08-13-python-app-hosting-design.md. This suite
// verifies the migration function only — routes, buildpack, and runner ship
// in subsequent commits.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  migrateUsersTable,
  migrateCloudBackendTables,
  migrateComputeTables,
  migrateHostedAppsTables,
} = require('../migrate');

// Build an in-memory DB with just the tables migrateHostedAppsTables needs
// as prerequisites: users (FK target) + backend_usage (target of the two
// ALTER TABLE ADD COLUMN calls). Bringing up the full server via
// migrateCloudBackendTables is overkill for a schema-only test, but the
// harness includes it so the ordering under real startup is exercised.
function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL DEFAULT 'free',
      created_at TEXT NOT NULL
    );
  `);
  migrateUsersTable(db);
  migrateCloudBackendTables(db);
  migrateComputeTables(db);
  migrateHostedAppsTables(db);
  return db;
}

const cols = (db, t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
const indexNames = (db, t) => db.prepare(
  "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?"
).all(t).map((r) => r.name);

test('all four hosted-app tables exist after migration', () => {
  const db = freshDb();
  const tables = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all().map((r) => r.name));
  for (const t of ['hosted_apps', 'hosted_app_deploys', 'hosted_app_events', 'hosted_app_uptime']) {
    assert.ok(tables.has(t), `missing table ${t}`);
  }
  db.close();
});

test('hosted_apps columns and defaults match spec', () => {
  const db = freshDb();
  const info = db.prepare('PRAGMA table_info(hosted_apps)').all();
  const byName = Object.fromEntries(info.map((c) => [c.name, c]));
  // Presence
  const required = ['id', 'backend_id', 'user_id', 'name', 'subdomain', 'kind', 'status',
    'current_deploy_id', 'procfile_web', 'runtime_version', 'healthcheck_path',
    'port', 'container_id', 'memory_mb', 'cpu_shares', 'restart_count',
    'restart_window_start', 'created_at', 'updated_at', 'paused_at'];
  for (const c of required) assert.ok(byName[c], `missing column ${c}`);
  // Defaults declared in the spec
  assert.equal(byName.kind.dflt_value, "'python-web'");
  assert.equal(byName.status.dflt_value, "'building'");
  assert.equal(byName.runtime_version.dflt_value, "'3.12'");
  assert.equal(byName.healthcheck_path.dflt_value, "'/'");
  assert.equal(byName.memory_mb.dflt_value, '256');
  assert.equal(byName.cpu_shares.dflt_value, '512');
  assert.equal(byName.restart_count.dflt_value, '0');
  // NOT NULL invariants
  assert.equal(byName.subdomain.notnull, 1);
  assert.equal(byName.status.notnull, 1);
  assert.equal(byName.runtime_version.notnull, 1);
  assert.equal(byName.healthcheck_path.notnull, 1);
  db.close();
});

test('backend_id has NO foreign key (avoids the two-parents trap)', () => {
  const db = freshDb();
  // The compute_jobs pattern documented in the spec: backend_id is a plain
  // column, referential integrity enforced at the application layer via
  // getAnyBackendById. Adding a FK to prototype_backends OR account_backends
  // silently breaks inserts for backends stored in the other table.
  for (const t of ['hosted_apps', 'hosted_app_deploys', 'hosted_app_events', 'hosted_app_uptime']) {
    const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(!fks.some((f) => f.from === 'backend_id'),
      `${t}.backend_id must not have an FK (see compute_jobs pattern)`);
    assert.ok(!fks.some((f) => f.table === 'prototype_backends' || f.table === 'account_backends'),
      `${t} must not reference prototype_backends or account_backends`);
  }
  db.close();
});

test('user_id FK to users(id) is present where declared', () => {
  const db = freshDb();
  for (const t of ['hosted_apps', 'hosted_app_deploys']) {
    const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all();
    assert.ok(fks.some((f) => f.from === 'user_id' && f.table === 'users'),
      `${t}.user_id → users(id) missing`);
  }
  db.close();
});

test('kind and status CHECK constraints reject invalid values', () => {
  const db = freshDb();
  const now = Date.now();
  const insert = (row) => db.prepare(`INSERT INTO hosted_apps
    (id, backend_id, user_id, name, subdomain, kind, status, created_at, updated_at)
    VALUES (?, 'be1', 'u1', ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.name, row.subdomain, row.kind, row.status, now, now);
  // Valid row
  db.prepare("INSERT INTO users (id, email, tier, created_at) VALUES ('u1', 'x@y', 'pro', 'now')").run();
  assert.doesNotThrow(() => insert({ id: 'a1', name: 'app1', subdomain: 'app1', kind: 'python-web', status: 'running' }));
  // Unknown kind
  assert.throws(() => insert({ id: 'a2', name: 'app2', subdomain: 'app2', kind: 'ruby-web', status: 'running' }),
    /CHECK constraint failed/);
  // Unknown status
  assert.throws(() => insert({ id: 'a3', name: 'app3', subdomain: 'app3', kind: 'python-web', status: 'exploded' }),
    /CHECK constraint failed/);
  db.close();
});

test('subdomain is globally UNIQUE across the droplet', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, email, tier, created_at) VALUES ('u1', 'x@y', 'pro', 'now')").run();
  const now = Date.now();
  db.prepare(`INSERT INTO hosted_apps (id, backend_id, user_id, name, subdomain, created_at, updated_at)
    VALUES ('a1', 'be-alice', 'u1', 'chat', 'chat', ?, ?)`).run(now, now);
  // Different backend, same subdomain → must fail (subdomain is the Caddy route key)
  assert.throws(
    () => db.prepare(`INSERT INTO hosted_apps (id, backend_id, user_id, name, subdomain, created_at, updated_at)
      VALUES ('a2', 'be-bob', 'u1', 'chat', 'chat', ?, ?)`).run(now, now),
    /UNIQUE constraint failed/
  );
  db.close();
});

test('partial UNIQUE index on port lets many NULLs coexist but blocks duplicate ports', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, email, tier, created_at) VALUES ('u1', 'x@y', 'pro', 'now')").run();
  const now = Date.now();
  const insert = (id, subdomain, port) => db.prepare(`INSERT INTO hosted_apps
    (id, backend_id, user_id, name, subdomain, port, created_at, updated_at)
    VALUES (?, 'be', 'u1', ?, ?, ?, ?, ?)`).run(id, subdomain, subdomain, port, now, now);
  // Three paused/deleted apps with NULL port — allowed
  assert.doesNotThrow(() => insert('a1', 'a1', null));
  assert.doesNotThrow(() => insert('a2', 'a2', null));
  assert.doesNotThrow(() => insert('a3', 'a3', null));
  // Two apps holding the same port — blocked
  assert.doesNotThrow(() => insert('b1', 'b1', 10001));
  assert.throws(() => insert('b2', 'b2', 10001), /UNIQUE constraint failed/);
  // Distinct ports fine
  assert.doesNotThrow(() => insert('b3', 'b3', 10002));
  db.close();
});

test('UNIQUE(backend_id, name) scopes app names per backend', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, email, tier, created_at) VALUES ('u1', 'x@y', 'pro', 'now')").run();
  const now = Date.now();
  db.prepare(`INSERT INTO hosted_apps (id, backend_id, user_id, name, subdomain, created_at, updated_at)
    VALUES ('a1', 'be-alice', 'u1', 'api', 'alice-api', ?, ?)`).run(now, now);
  // Same name on a different backend → OK (subdomain must still be unique)
  assert.doesNotThrow(() => db.prepare(`INSERT INTO hosted_apps (id, backend_id, user_id, name, subdomain, created_at, updated_at)
    VALUES ('a2', 'be-bob', 'u1', 'api', 'bob-api', ?, ?)`).run(now, now));
  // Same name on the same backend → blocked
  assert.throws(() => db.prepare(`INSERT INTO hosted_apps (id, backend_id, user_id, name, subdomain, created_at, updated_at)
    VALUES ('a3', 'be-alice', 'u1', 'api', 'alice-api-2', ?, ?)`).run(now, now),
    /UNIQUE constraint failed/);
  db.close();
});

test('hosted_app_deploys.status CHECK covers the full queue lifecycle', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, email, tier, created_at) VALUES ('u1', 'x@y', 'pro', 'now')").run();
  const now = Date.now();
  const insert = (id, status) => db.prepare(`INSERT INTO hosted_app_deploys
    (id, app_id, source_sha256, status, started_at, user_id)
    VALUES (?, 'a1', 'sha', ?, ?, 'u1')`).run(id, status, now);
  for (const s of ['queued', 'building', 'running', 'failed', 'superseded']) {
    assert.doesNotThrow(() => insert(`d-${s}`, s), `${s} must be a valid deploy status`);
  }
  assert.throws(() => insert('d-bad', 'purple'), /CHECK constraint failed/);
  db.close();
});

test('hosted_app_deploys has the four runner-lifecycle columns cloud-hosted-app-runner.js writes to', () => {
  // Regression guard: prior to 2026-08-13, migrateHostedAppsTables did not
  // declare worker_id / build_started_at / build_finished_at / error_code.
  // cloud-hosted-app-runner.js writes to all four (_claimQueued sets the
  // first two; the terminal-state UPDATEs at :440 and _failDeploy at :459
  // set the last two). _safeRun swallowed the "no such column" SQL error,
  // so every deploy stalled in `building` forever with no `failed`
  // fallback and no journalctl trace. Adding these columns is the actual
  // unblocker for Python app hosting.
  const db = freshDb();
  const cols = new Set(db.prepare('PRAGMA table_info(hosted_app_deploys)').all().map((c) => c.name));
  for (const name of ['worker_id', 'build_started_at', 'build_finished_at', 'error_code']) {
    assert.ok(cols.has(name), `hosted_app_deploys missing column: ${name}`);
  }
  db.close();
});

test('runner-lifecycle columns accept the values the runner actually writes', () => {
  // End-to-end shape check: reproduce the exact UPDATE + INSERT shapes from
  // cloud-hosted-app-runner.js so a future rename of one of these columns
  // fails HERE (in a fast in-memory test) rather than silently on prod
  // where _safeRun's error-swallowing hides the failure.
  const db = freshDb();
  db.prepare("INSERT INTO users (id, email, tier, created_at) VALUES ('u1', 'x@y', 'pro', 'now')").run();
  db.prepare(`INSERT INTO hosted_app_deploys (id, app_id, source_sha256, status, started_at, user_id)
              VALUES ('d1', 'a1', 'sha', 'queued', ?, 'u1')`).run(Date.now());

  // _claimQueued shape (cloud-hosted-app-runner.js:268).
  const claimRes = db.prepare(
    `UPDATE hosted_app_deploys SET status='building', worker_id=?, build_started_at=?
     WHERE id=? AND status='queued'`
  ).run('host:12345', new Date().toISOString(), 'd1');
  assert.equal(claimRes.changes, 1, '_claimQueued UPDATE must affect the row');

  // Terminal running (cloud-hosted-app-runner.js:440).
  const runRes = db.prepare(
    "UPDATE hosted_app_deploys SET status='running', build_finished_at=? WHERE id=?"
  ).run(new Date().toISOString(), 'd1');
  assert.equal(runRes.changes, 1, 'terminal running UPDATE must affect the row');

  // _failDeploy shape (cloud-hosted-app-runner.js:459). Reset status to
  // 'building' first so the WHERE clause matches — this mirrors the runner's
  // actual flow (claim → attempt → fail).
  db.prepare("UPDATE hosted_app_deploys SET status='building' WHERE id='d1'").run();
  const failRes = db.prepare(
    `UPDATE hosted_app_deploys
       SET status='failed', error_code=?, error=?, build_finished_at=?
     WHERE id=? AND status IN ('building','queued')`
  ).run('build_failed', 'docker build exit 1', new Date().toISOString(), 'd1');
  assert.equal(failRes.changes, 1, '_failDeploy UPDATE must affect the row');

  const row = db.prepare('SELECT * FROM hosted_app_deploys WHERE id=?').get('d1');
  assert.equal(row.status, 'failed');
  assert.equal(row.error_code, 'build_failed');
  assert.equal(row.error, 'docker build exit 1');
  assert.ok(row.worker_id, 'worker_id persisted');
  assert.ok(row.build_started_at, 'build_started_at persisted');
  assert.ok(row.build_finished_at, 'build_finished_at persisted');
  db.close();
});

test('hosted_app_events has created_at + extra_json for the runner _emitEvent shape', () => {
  // Regression guard for the 2026-08-13 bug (surfaced by PR #40's log
  // — the 6th silent SQL-drop pattern this session). cloud-hosted-app-
  // runner.js:_emitEvent writes to `created_at` (ISO text) and
  // `extra_json` (JSON payload) — columns the original CREATE TABLE
  // never declared. `_safeRun` swallowed the failure so every deploy /
  // pause / resume / crash event was silently dropped, gutting
  // observability across the entire hosted-apps subsystem.
  const db = freshDb();
  const cols = new Set(db.prepare('PRAGMA table_info(hosted_app_events)').all().map((c) => c.name));
  for (const name of ['created_at', 'extra_json']) {
    assert.ok(cols.has(name), `hosted_app_events missing column: ${name}`);
  }
  // Legacy `ts INTEGER NOT NULL` intentionally preserved — the runner
  // fills it with Date.now() so no table rebuild is required to relax
  // the NOT NULL. Dropping ts is a future migration.
  assert.ok(cols.has('ts'), 'ts column preserved (runner still fills it for the NOT NULL invariant)');
  db.close();
});

test('_emitEvent INSERT shape (runner) works against the migrated schema', () => {
  // End-to-end shape check: run the exact INSERT the runner uses at
  // cloud-hosted-app-runner.js:_emitEvent. A future rename or missing
  // column fails HERE (in-memory) rather than silently on prod with
  // _safeRun's swallow (or, post-PR-#40, as a journalctl line nobody
  // watches).
  const db = freshDb();
  const res = db.prepare(
    `INSERT INTO hosted_app_events (app_id, kind, message, ts, created_at, extra_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('a1', 'deploy', 'test message', Date.now(), new Date().toISOString(), '{"deploy_id":"d1"}');
  assert.equal(res.changes, 1);
  const row = db.prepare("SELECT * FROM hosted_app_events WHERE app_id='a1'").get();
  assert.equal(row.kind, 'deploy');
  assert.equal(row.message, 'test message');
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T/, 'created_at is ISO text');
  assert.equal(row.extra_json, '{"deploy_id":"d1"}');
  db.close();
});

test('migrateHostedAppsTables is idempotent for the new columns too', () => {
  // The existing "migration is idempotent" test only asserts no error on the
  // second call. Explicitly re-check that after two runs each of the four new
  // columns appears exactly once (SQLite would raise "duplicate column name"
  // on a second unguarded ALTER TABLE ADD COLUMN if the PRAGMA table_info
  // guard regressed).
  const db = freshDb();
  migrateHostedAppsTables(db); // second time
  const cols = db.prepare('PRAGMA table_info(hosted_app_deploys)').all().map((c) => c.name);
  const counts = {};
  for (const c of cols) counts[c] = (counts[c] || 0) + 1;
  for (const name of ['worker_id', 'build_started_at', 'build_finished_at', 'error_code']) {
    assert.equal(counts[name], 1, `${name} must exist exactly once, not ${counts[name] || 0}`);
  }
  db.close();
});

test('hosted_app_events autoincrement + newest-first index', () => {
  const db = freshDb();
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    db.prepare("INSERT INTO hosted_app_events (app_id, ts, kind, message) VALUES ('a1', ?, 'start', ?)")
      .run(now + i, `evt-${i}`);
  }
  const ids = db.prepare("SELECT id FROM hosted_app_events WHERE app_id = 'a1' ORDER BY id DESC").all().map((r) => r.id);
  assert.equal(ids.length, 3);
  assert.ok(ids[0] > ids[1] && ids[1] > ids[2], 'ids autoincrement');
  db.close();
});

test('hosted_app_uptime composite PK aggregates per (app, hour)', () => {
  const db = freshDb();
  const bucket = Math.floor(Date.now() / 3600000) * 3600;
  // First insert
  db.prepare(`INSERT INTO hosted_app_uptime (app_id, window_start, uptime_seconds, egress_bytes)
    VALUES ('a1', ?, 300, 1024) ON CONFLICT(app_id, window_start) DO UPDATE SET
    uptime_seconds = uptime_seconds + excluded.uptime_seconds,
    egress_bytes = egress_bytes + excluded.egress_bytes`).run(bucket);
  // Second insert into the same bucket
  db.prepare(`INSERT INTO hosted_app_uptime (app_id, window_start, uptime_seconds, egress_bytes)
    VALUES ('a1', ?, 300, 2048) ON CONFLICT(app_id, window_start) DO UPDATE SET
    uptime_seconds = uptime_seconds + excluded.uptime_seconds,
    egress_bytes = egress_bytes + excluded.egress_bytes`).run(bucket);
  const row = db.prepare('SELECT uptime_seconds, egress_bytes FROM hosted_app_uptime WHERE app_id = ? AND window_start = ?')
    .get('a1', bucket);
  assert.equal(row.uptime_seconds, 600);
  assert.equal(row.egress_bytes, 3072);
  db.close();
});

test('backend_usage gains app_uptime_seconds and app_egress_bytes with default 0', () => {
  const db = freshDb();
  const c = cols(db, 'backend_usage');
  assert.ok(c.has('app_uptime_seconds'), 'app_uptime_seconds column missing');
  assert.ok(c.has('app_egress_bytes'), 'app_egress_bytes column missing');
  // Also verify: compute_run_seconds (from migrateComputeTables) still there,
  // proving my migration didn't accidentally break the sibling meter.
  assert.ok(c.has('compute_run_seconds'), 'compute_run_seconds must survive alongside');
  // Defaults land as 0 on a fresh insert that omits both meters.
  db.prepare("INSERT INTO backend_usage (backend_id, day, emails_sent) VALUES ('be1', '2026-08-13', 0)").run();
  const row = db.prepare("SELECT app_uptime_seconds, app_egress_bytes FROM backend_usage WHERE backend_id = 'be1'").get();
  assert.equal(row.app_uptime_seconds, 0);
  assert.equal(row.app_egress_bytes, 0);
  db.close();
});

test('migration is idempotent — running twice does not error or duplicate columns', () => {
  const db = freshDb();
  // Second pass over an already-migrated DB is a no-op.
  assert.doesNotThrow(() => migrateHostedAppsTables(db));
  const c = cols(db, 'backend_usage');
  // Column count didn't double.
  const uptimeCount = [...c].filter((n) => n === 'app_uptime_seconds').length;
  assert.equal(uptimeCount, 1);
  db.close();
});

test('all required indexes exist', () => {
  const db = freshDb();
  const appsIdx = new Set(indexNames(db, 'hosted_apps'));
  assert.ok(appsIdx.has('idx_hosted_apps_backend'), 'idx_hosted_apps_backend missing');
  assert.ok(appsIdx.has('idx_hosted_apps_port'), 'idx_hosted_apps_port missing');
  const deployIdx = new Set(indexNames(db, 'hosted_app_deploys'));
  assert.ok(deployIdx.has('idx_hosted_app_deploys_app'), 'idx_hosted_app_deploys_app missing');
  assert.ok(deployIdx.has('idx_hosted_app_deploys_claim'), 'idx_hosted_app_deploys_claim missing');
  const eventsIdx = new Set(indexNames(db, 'hosted_app_events'));
  assert.ok(eventsIdx.has('idx_hosted_app_events'), 'idx_hosted_app_events missing');
  db.close();
});
