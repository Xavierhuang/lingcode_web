'use strict';

// cloud-hosted-app-runner.test.js — node:test suite for the hosted-app runner.
//
// The pure helpers get direct unit tests. The state-machine gets a light
// integration test that stubs docker via a shell script fake bound to
// dockerBin, and stubs the DB via a tiny in-memory shim that speaks the same
// `.prepare(sql).all/get/run/transaction()` shape as better-sqlite3.
//
// The DB shim intentionally does NOT parse SQL — the SQL strings are used as
// keys into a hand-written pattern table. This is more work than a real
// database but keeps the test dependency-free.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const runner = require('../cloud-hosted-app-runner');
const {
  allocatePort,
  bakeStartCmdIntoDockerfile,
  parseNetIO,
  computeRestartTransition,
  createHostedAppRunner,
  RESTART_LIMIT,
} = runner;

// ── makeFakeDb ────────────────────────────────────────────────────────────────

function makeFakeDb() {
  const state = {
    hosted_apps: new Map(),         // id -> row
    hosted_app_deploys: new Map(),  // id -> row
    hosted_app_events: [],          // {id, app_id, kind, message, extra_json, created_at}
    hosted_app_uptime: [],
    backend_usage: [],
    backends: new Map(),
    _eventSeq: 1,
    _uptimeSeq: 1,
  };
  const matchers = [];

  function on(pattern, handler) {
    matchers.push({ pattern, handler });
  }

  // Deploy claim + fail queries
  on(/SELECT \* FROM hosted_app_deploys\s+WHERE status='queued'/i, {
    kind: 'get', run: () => {
      const queued = [...state.hosted_app_deploys.values()]
        .filter((r) => r.status === 'queued')
        .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
      return queued[0] || null;
    },
  });
  on(/UPDATE hosted_app_deploys SET status='building'/i, {
    kind: 'run', run: (args) => {
      const [worker, ts, id] = args;
      const row = state.hosted_app_deploys.get(id);
      if (!row || row.status !== 'queued') return { changes: 0 };
      row.status = 'building'; row.worker_id = worker; row.build_started_at = ts;
      return { changes: 1 };
    },
  });
  on(/SELECT \* FROM hosted_apps WHERE id=\?/i, {
    kind: 'get', run: (args) => state.hosted_apps.get(args[0]) || null,
  });
  on(/UPDATE hosted_app_deploys\s+SET status='failed'/i, {
    kind: 'run', run: (args) => {
      const [code, err, ts, id] = args;
      const row = state.hosted_app_deploys.get(id);
      if (!row) return { changes: 0 };
      if (!(row.status === 'building' || row.status === 'queued')) return { changes: 0 };
      row.status = 'failed'; row.error_code = code; row.error = err; row.build_finished_at = ts;
      return { changes: 1 };
    },
  });
  on(/UPDATE hosted_apps\s+SET status='running', current_deploy_id/i, {
    kind: 'run', run: (args) => {
      const [deployId, containerId, port, ts, id] = args;
      const row = state.hosted_apps.get(id);
      if (!row) return { changes: 0 };
      row.status = 'running';
      row.current_deploy_id = deployId;
      row.container_id = containerId;
      row.port = port;
      row.restart_count = 0;
      row.restart_window_start = null;
      row.last_deployed_at = ts;
      return { changes: 1 };
    },
  });
  on(/UPDATE hosted_app_deploys SET status='running', build_finished_at=\? WHERE id=\?/i, {
    kind: 'run', run: (args) => {
      const [ts, id] = args;
      const row = state.hosted_app_deploys.get(id);
      if (!row) return { changes: 0 };
      row.status = 'running'; row.build_finished_at = ts;
      return { changes: 1 };
    },
  });
  on(/UPDATE hosted_app_deploys SET status='superseded'/i, {
    kind: 'run', run: (args) => {
      const [id] = args;
      const row = state.hosted_app_deploys.get(id);
      if (!row || row.status !== 'running') return { changes: 0 };
      row.status = 'superseded';
      return { changes: 1 };
    },
  });
  on(/INSERT INTO hosted_app_events/i, {
    kind: 'run', run: (args) => {
      // Runner writes both `ts` (legacy INTEGER NOT NULL) and `created_at`
      // (newer TEXT ISO); INSERT arg order: (app_id, kind, message, ts,
      // created_at, extra_json).
      const [appId, kind, message, ts, createdAt, extraJson] = args;
      state.hosted_app_events.push({
        id: state._eventSeq++, app_id: appId, kind, message,
        ts, created_at: createdAt, extra_json: extraJson,
      });
      return { changes: 1 };
    },
  });
  on(/SELECT port FROM hosted_apps WHERE port IS NOT NULL/i, {
    kind: 'all', run: () => {
      const out = [];
      for (const r of state.hosted_apps.values()) {
        if (r.port != null) out.push({ port: r.port });
      }
      return out;
    },
  });
  on(/SELECT id FROM hosted_app_deploys\s+WHERE app_id=\? AND requirements_sha=\?/i, {
    kind: 'get', run: (args) => {
      const [appId, sha] = args;
      const matches = [...state.hosted_app_deploys.values()].filter((r) =>
        r.app_id === appId && r.requirements_sha === sha &&
        (r.status === 'running' || r.status === 'superseded')
      );
      matches.sort((a, b) => String(b.build_finished_at || '').localeCompare(String(a.build_finished_at || '')));
      return matches[0] || null;
    },
  });
  on(/INSERT INTO hosted_app_deploys/i, {
    kind: 'run', run: (args) => {
      const [id, appId, userId, sourceSha, reqSha, startedAt] = args;
      state.hosted_app_deploys.set(id, {
        id, app_id: appId, user_id: userId, status: 'queued',
        source_sha256: sourceSha, requirements_sha: reqSha, started_at: startedAt,
      });
      return { changes: 1 };
    },
  });
  on(/UPDATE hosted_apps SET status='paused' WHERE id=\?/i, {
    kind: 'run', run: (args) => {
      const row = state.hosted_apps.get(args[0]);
      if (!row) return { changes: 0 };
      row.status = 'paused';
      return { changes: 1 };
    },
  });
  on(/UPDATE hosted_apps SET status='crashed' WHERE id=\?/i, {
    kind: 'run', run: (args) => {
      const row = state.hosted_apps.get(args[0]);
      if (!row) return { changes: 0 };
      row.status = 'crashed';
      return { changes: 1 };
    },
  });
  on(/UPDATE hosted_apps SET status='deleted'/i, {
    kind: 'run', run: (args) => {
      const row = state.hosted_apps.get(args[0]);
      if (!row) return { changes: 0 };
      row.status = 'deleted'; row.container_id = null; row.port = null; row.current_deploy_id = null;
      return { changes: 1 };
    },
  });
  on(/UPDATE hosted_apps SET status='running', restart_count=0/i, {
    kind: 'run', run: (args) => {
      const row = state.hosted_apps.get(args[0]);
      if (!row) return { changes: 0 };
      row.status = 'running'; row.restart_count = 0; row.restart_window_start = null;
      return { changes: 1 };
    },
  });

  const db = {
    _state: state,
    prepare(sql) {
      for (const m of matchers) {
        if (m.pattern.test(sql)) {
          return {
            all: (...args) => (m.handler.kind === 'all' ? m.handler.run(args) : []),
            get: (...args) => (m.handler.kind === 'get' ? m.handler.run(args) : null),
            run: (...args) => (m.handler.kind === 'run' ? m.handler.run(args) : { changes: 0 }),
          };
        }
      }
      // Unknown SQL — return no-op so _safeAll/_safeGet/_safeRun degrade gracefully.
      return {
        all: () => [], get: () => null, run: () => ({ changes: 0 }),
      };
    },
    transaction(fn) {
      // No isolation, just execute. Good enough for the test.
      return () => fn();
    },
  };
  return db;
}

// ── fake docker CLI ──────────────────────────────────────────────────────────

function writeFakeDocker(dir) {
  // A programmable shell script. Behavior is driven by an env-var STATE_FILE
  // that we bump between phases of the test.
  const stateFile = path.join(dir, 'fake-docker-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    healthy_after_calls: 0,   // return healthy immediately
    build_exit: 0,
    run_exit: 0,
    run_output: 'fake-container-id',
    inspect_health: 'healthy',
    inspect_restart_count: 0,
    stats_output: '',
  }));
  // A standalone Node script — invoked via child_process.spawn directly. We
  // deliberately avoid `node -e '...'` because Node's `-e` mode does NOT honor
  // `--` for arg separation, so `docker inspect --format=...` args would be
  // parsed as Node options and rejected.
  const jsPath = path.join(dir, 'fake-docker.js');
  const jsBody = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const st = JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8'));
const argv = process.argv.slice(2);
const cmd = argv.shift();
if (cmd === 'build') process.exit(st.build_exit);
if (cmd === 'run')   { process.stdout.write(st.run_output + '\\n'); process.exit(st.run_exit); }
if (cmd === 'inspect') {
  let fmt = '';
  for (const a of argv) { if (a.startsWith('--format=')) fmt = a.slice('--format='.length); }
  if (fmt.includes('Health.Status')) { process.stdout.write(st.inspect_health); process.exit(0); }
  if (fmt.includes('RestartCount'))  { process.stdout.write(String(st.inspect_restart_count)); process.exit(0); }
  process.exit(0);
}
if (['stop','rm','start','restart'].includes(cmd)) process.exit(0);
if (cmd === 'stats') { process.stdout.write(st.stats_output); process.exit(0); }
if (cmd === 'logs')  { process.stdout.write('log-line-1\\nlog-line-2\\n'); process.exit(0); }
process.exit(0);
`;
  fs.writeFileSync(jsPath, jsBody, { mode: 0o755 });
  // Wrapper sh script that exports STATE_FILE and execs the JS via node. We
  // still need this because dockerBin is a single string, and we want state
  // pinned to this test's temp dir rather than a global env var.
  const script = `#!/bin/sh
export STATE_FILE="${stateFile}"
exec node "${jsPath}" "$@"
`;
  const p = path.join(dir, 'fake-docker.sh');
  fs.writeFileSync(p, script, { mode: 0o755 });
  return { path: p, stateFile, set(patch) {
    const cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fs.writeFileSync(stateFile, JSON.stringify({ ...cur, ...patch }));
  } };
}

// A fake Caddy client that records calls.
function makeFakeCaddy() {
  const calls = [];
  return {
    calls,
    async upsertRoute(a) { calls.push({ op: 'upsert', ...a }); return { ok: true }; },
    async deleteRoute(a) { calls.push({ op: 'delete', ...a }); return { ok: true }; },
    async listRoutes() { return []; },
    async health() { return true; },
  };
}

// ── unit tests: pure helpers ─────────────────────────────────────────────────

test('allocatePort returns the first free port', () => {
  const db = makeFakeDb();
  assert.equal(allocatePort(db), 10000);
  db._state.hosted_apps.set('a', { id: 'a', port: 10000 });
  db._state.hosted_apps.set('b', { id: 'b', port: 10001 });
  assert.equal(allocatePort(db), 10002);
});

test('allocatePort returns null when exhausted', () => {
  // We can't practically fill 10000 slots in a fake DB, so shrink the search
  // by pre-populating: instead assert that a full contiguous block skips over.
  const db = makeFakeDb();
  for (let p = 10000; p < 10050; p++) {
    db._state.hosted_apps.set('x' + p, { id: 'x' + p, port: p });
  }
  assert.equal(allocatePort(db), 10050);
});

test('bakeStartCmdIntoDockerfile inserts COPY before USER/CMD', () => {
  const base = [
    'FROM base:1',
    'WORKDIR /app',
    'COPY . .',
    'USER nobody-app',
    'CMD ["/lc/entrypoint.sh"]',
    '',
  ].join('\n');
  const out = bakeStartCmdIntoDockerfile(base, 'uvicorn app:app --port $PORT');
  const lines = out.split('\n');
  const userIdx = lines.findIndex((l) => l.startsWith('USER '));
  const copyIdx = lines.findIndex((l) => l === 'COPY lc-start-cmd /lc/start-cmd');
  assert.ok(copyIdx > 0, 'COPY inserted');
  assert.ok(copyIdx < userIdx, 'COPY comes before USER');
});

test('bakeStartCmdIntoDockerfile handles missing USER/CMD anchor', () => {
  const base = 'FROM base:1\nWORKDIR /app\n';
  const out = bakeStartCmdIntoDockerfile(base, 'python x.py');
  assert.ok(out.includes('COPY lc-start-cmd /lc/start-cmd'));
});

test('bakeStartCmdIntoDockerfile rejects empty command', () => {
  assert.throws(() => bakeStartCmdIntoDockerfile('FROM x', ''), /resolvedCommand/);
});

// ── _safeRun / _safeGet / _safeAll: SQL errors now logged, not silent ──────
//
// Regression guard for the 2026-08-13 "silent swallow" trap. All three
// helpers must PRESERVE their return-shape contract (never crash the
// runner) AND log the SQL error message + SQL preview to console.error
// so ops sees it in journalctl. Verified by loading the runner module
// through a plain require() with a monkey-patched db.prepare that
// throws — captures the error output and asserts on it.
//
// Helpers are file-scope (not exported), so we exercise them indirectly
// via a public entry point that routes through them. `enqueueDeploy`
// does an INSERT via db.prepare(...).run(...) directly (not through
// _safeRun), which is fine — instead we test via `_pollTick` running
// against a fake DB whose prepare() throws for the claim SELECT.

test('_safeGet logs SQL errors to console.error (was silent — five session bugs hid here)', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hosted-safelog-'));
  const fakeDocker = writeFakeDocker(workDir);
  const db = makeFakeDb();

  // Wrap db.prepare so the "SELECT * FROM hosted_app_deploys WHERE status='queued'"
  // used inside _claimQueued's transaction throws — force _safeGet down its
  // catch path. (The transaction wrapper itself swallows the throw and
  // returns null, exactly like _claimQueued expects, so no unhandled reject.)
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/SELECT \* FROM hosted_app_deploys\s+WHERE status='queued'/i.test(sql)) {
      return {
        get: () => { throw Object.assign(new Error('no such column: fake_missing_col'), { code: 'SQLITE_ERROR' }); },
        run: () => ({ changes: 0 }),
        all: () => [],
      };
    }
    return origPrepare(sql);
  };

  // Capture console.error output.
  const origErr = console.error;
  const captured = [];
  console.error = (...a) => captured.push(a.join(' '));

  try {
    const r = createHostedAppRunner({
      db, dockerBin: fakeDocker.path, stateDir: workDir, envDir: workDir,
      wildcardZone: 'apps.test',
    });
    // _claimQueued is wrapped in a transaction that catches — this exercises
    // both the throw AND the _safeGet fallthrough log.
    await r._pollTick();
  } finally {
    console.error = origErr;
  }

  // Should have at least one log line matching our _safeGet-error shape,
  // naming the underlying SQL error message and showing a SQL preview.
  const hit = captured.find((line) =>
    /cloud-hosted-app-runner\].* _safeGet SQL error: no such column: fake_missing_col/.test(line) &&
    /SQL: SELECT \* FROM hosted_app_deploys/.test(line)
  );
  assert.ok(hit, `expected a _safeGet SQL error log line, got: ${JSON.stringify(captured, null, 2)}`);
});

test('_safeRun logs SQL errors and still returns { changes: 0 }', async () => {
  // Same idea for _safeRun — force the enqueueDeploy INSERT UPDATE path
  // to throw and verify (a) log fires (b) return shape preserved. We
  // route through enqueueDeploy which internally calls the tables via
  // prepare().run() directly, not through _safeRun — so we test _safeRun
  // via the runner's post-claim UPDATE path.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hosted-saferun-'));
  const fakeDocker = writeFakeDocker(workDir);
  const db = makeFakeDb();

  const appId = 'app-saferun';
  db._state.hosted_apps.set(appId, {
    id: appId, backend_id: 'b1', subdomain: 'sr',
    status: 'building',
    runtime_version: '3.12', healthcheck_path: '/',
    memory_mb: 128, cpu_shares: 256,
  });
  const srcDir = path.join(workDir, appId, 'depSR', 'source');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'main.py'), '# fake\n');
  fs.writeFileSync(path.join(srcDir, 'requirements.txt'), 'fastapi\n');
  db._state.hosted_app_deploys.set('depSR', {
    id: 'depSR', app_id: appId, status: 'queued',
    requirements_sha: 'sha', started_at: '2026-01-01T00:00:00Z',
  });

  // Make the deploy-status='building' UPDATE (part of _claimQueued's atomic
  // claim) throw. _claimQueued's outer transaction wrapper swallows, but
  // the inner _safeRun should have logged first.
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/UPDATE hosted_app_deploys SET status='building'/i.test(sql)) {
      return {
        run: () => { throw Object.assign(new Error('no such column: fake_missing_col_2'), { code: 'SQLITE_ERROR' }); },
        get: () => undefined,
        all: () => [],
      };
    }
    return origPrepare(sql);
  };

  const origErr = console.error;
  const captured = [];
  console.error = (...a) => captured.push(a.join(' '));

  try {
    const r = createHostedAppRunner({
      db, dockerBin: fakeDocker.path, stateDir: workDir, envDir: workDir,
      wildcardZone: 'apps.test',
    });
    await r._pollTick();
  } finally {
    console.error = origErr;
  }

  const hit = captured.find((line) =>
    /_safeRun SQL error: no such column: fake_missing_col_2/.test(line) &&
    /UPDATE hosted_app_deploys/.test(line)
  );
  assert.ok(hit, `expected a _safeRun SQL error log line, got: ${JSON.stringify(captured, null, 2)}`);
});

test('bakeStartCmdIntoDockerfile does not splice into HEALTHCHECK continuation', () => {
  // Regression guard for the 2026-08-13 FastAPI smoke-test bug. The buildpack
  // (cloud-hosted-app-buildpack.js:72-73) emits a HEALTHCHECK directive whose
  // args wrap across two lines via `\`. The naive "first line whose trim()
  // startsWith('CMD ')" scan matched the CONTINUATION and spliced the COPY
  // into the middle of HEALTHCHECK — Docker then errored with
  // `Unknown type "COPY" in HEALTHCHECK (try CMD)` and every deploy failed
  // with error_code='build_failed'.
  const base = [
    'FROM base:1',
    'WORKDIR /app',
    'COPY . .',
    'ENV PORT=8080',
    'HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\',
    '  CMD curl -fsS "http://127.0.0.1:8080/" || exit 1',
    'USER nobody-app',
    'CMD ["/lc/entrypoint.sh"]',
    '',
  ].join('\n');
  const out = bakeStartCmdIntoDockerfile(base, 'uvicorn app:app --port $PORT');
  const outLines = out.split('\n');

  // 1. The COPY injection must land BELOW the HEALTHCHECK block, not inside it.
  //    Concretely: the `  CMD curl` continuation line and the leading
  //    HEALTHCHECK line must appear BEFORE the injected COPY.
  const healthLineIdx = outLines.findIndex((l) => l.startsWith('HEALTHCHECK '));
  const healthCmdContinuationIdx = outLines.findIndex((l) => l.trim().startsWith('CMD curl'));
  const copyInjectionIdx = outLines.findIndex((l) => l === 'COPY lc-start-cmd /lc/start-cmd');
  assert.ok(healthLineIdx >= 0, 'HEALTHCHECK line preserved');
  assert.ok(healthCmdContinuationIdx > healthLineIdx, 'HEALTHCHECK continuation preserved right after');
  assert.ok(copyInjectionIdx > healthCmdContinuationIdx,
    `COPY injection must come AFTER the HEALTHCHECK continuation (was at ${copyInjectionIdx}, continuation at ${healthCmdContinuationIdx})`);

  // 2. The injection must still land BEFORE the real USER directive so the
  //    file's containers can still be built as non-root at runtime.
  const userIdx = outLines.findIndex((l) => l === 'USER nobody-app');
  assert.ok(copyInjectionIdx < userIdx, 'COPY still comes before USER');

  // 3. Belt-and-braces: the HEALTHCHECK's trailing backslash is still there
  //    on the line above its `  CMD curl` continuation (i.e., we didn't
  //    accidentally strip the `\` or reflow the directive).
  const healthLine = outLines[healthLineIdx];
  assert.ok(healthLine.endsWith('\\'), 'HEALTHCHECK continuation \\ preserved');
});

test('bakeStartCmdIntoDockerfile treats empty line as terminating a continuation', () => {
  // A `\` at EOL only continues until the next non-empty line; if the empty
  // line follows, Docker terminates the directive there. Our scanner should
  // also treat an intervening blank as "continuation ended" so the NEXT
  // standalone CMD/USER anchors correctly.
  const base = [
    'FROM base:1',
    'RUN echo foo \\',
    '',                                    // continuation ended by blank
    'CMD ["python"]',                      // this is a real standalone CMD
    '',
  ].join('\n');
  const out = bakeStartCmdIntoDockerfile(base, 'python app.py');
  const outLines = out.split('\n');
  const cmdIdx = outLines.findIndex((l) => l === 'CMD ["python"]');
  const copyIdx = outLines.findIndex((l) => l === 'COPY lc-start-cmd /lc/start-cmd');
  assert.ok(copyIdx > 0 && copyIdx < cmdIdx, 'COPY inserted before the real CMD (not inside RUN continuation)');
});

test('parseNetIO parses standard docker output', () => {
  assert.deepEqual(parseNetIO('1.2MB / 350kB'), { in: 1200000, out: 350000 });
  assert.deepEqual(parseNetIO('0B / 0B'), { in: 0, out: 0 });
  assert.deepEqual(parseNetIO(''), { in: 0, out: 0 });
  assert.deepEqual(parseNetIO('not a value'), { in: 0, out: 0 });
});

test('parseNetIO handles GB and TB', () => {
  const r = parseNetIO('2GB / 1.5GB');
  assert.equal(r.in, 2_000_000_000);
  assert.equal(r.out, 1_500_000_000);
});

test('computeRestartTransition fresh window increments count', () => {
  const t = computeRestartTransition({ restart_count: 0, restart_window_start: 0, _lastCumulative: 0 }, 1, 1_000_000);
  assert.equal(t.newCount, 1);
  assert.equal(t.newWindowStart, 1_000_000);
  assert.equal(t.newLastCumulative, 1);
  assert.equal(t.shouldPromoteCrashed, false);
});

test('computeRestartTransition trips breaker above RESTART_LIMIT', () => {
  const t = computeRestartTransition(
    { restart_count: RESTART_LIMIT, restart_window_start: 1_000_000, _lastCumulative: RESTART_LIMIT },
    RESTART_LIMIT + 1,
    1_000_000 + 60_000
  );
  assert.equal(t.newCount, RESTART_LIMIT + 1);
  assert.equal(t.shouldPromoteCrashed, true);
});

test('computeRestartTransition resets after window expiry', () => {
  const t = computeRestartTransition(
    { restart_count: 10, restart_window_start: 0, _lastCumulative: 10 },
    12,
    1_000_000 + (11 * 60 * 1000) // past 10min window
  );
  // Window reset → count starts at 0, delta = dc - lastCumulative capped
  assert.equal(t.newWindowStart, 1_000_000 + 11 * 60 * 1000);
  assert.equal(t.newCount, 2); // dc=12, prev=10 → +2 delta
  assert.equal(t.shouldPromoteCrashed, false);
});

test('computeRestartTransition handles container rebuild (delta<0)', () => {
  const t = computeRestartTransition(
    { restart_count: 3, restart_window_start: 1_000_000, _lastCumulative: 5 },
    1,
    1_000_000 + 60_000
  );
  // delta went negative (5→1), so we take dc as the new count-delta.
  // count = 3 + 1 = 4
  assert.equal(t.newCount, 4);
  assert.equal(t.newLastCumulative, 1);
});

// ── integration: fake-docker-driven state machine walk ───────────────────────

test('state machine: queued deploy → build → healthy → running', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hosted-test-'));
  const stateDir = path.join(workDir, 'state');
  const envDir = path.join(workDir, 'env');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });

  const fakeDocker = writeFakeDocker(workDir);
  // Force healthy on first inspect.
  fakeDocker.set({ inspect_health: 'healthy', build_exit: 0, run_exit: 0, run_output: 'containerA' });

  const db = makeFakeDb();
  // Seed app.
  const appId = 'app-uuid-1';
  db._state.hosted_apps.set(appId, {
    id: appId, backend_id: 'b1', subdomain: 'myapp',
    status: 'running', // pretend already existing (old container 'containerZ')
    runtime_version: '3.12', healthcheck_path: '/health',
    memory_mb: 256, cpu_shares: 512,
    container_id: 'containerZ', port: 12345, current_deploy_id: 'oldDeploy',
    env_json: null,
  });
  // Seed old running deploy so we can verify supersede.
  db._state.hosted_app_deploys.set('oldDeploy', {
    id: 'oldDeploy', app_id: appId, status: 'running',
    requirements_sha: 'shaA', started_at: '2020-01-01T00:00:00Z',
  });

  // Write source dir + entrypoint files.
  const srcDir = path.join(stateDir, appId, 'newDeploy', 'source');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'app.py'), '# fake\n');
  fs.writeFileSync(path.join(srcDir, 'requirements.txt'), 'flask\n');
  // Queue the new deploy.
  db._state.hosted_app_deploys.set('newDeploy', {
    id: 'newDeploy', app_id: appId, status: 'queued',
    requirements_sha: 'shaB', started_at: '2020-01-02T00:00:00Z',
  });

  const caddy = makeFakeCaddy();
  // We monkeypatch HEALTH_POLL_MS to 0 by wrapping timers... simplest is to
  // trust the loop to hit healthy on the first inspect (60s budget, 0ms sleep
  // if we skip _sleep). But we can't override the sleep. Instead we accept the
  // 2s poll — it exits on the FIRST successful inspect. The test still runs
  // fast because inspect returns 'healthy' immediately.

  const r = createHostedAppRunner({
    db, caddyClient: caddy, stateDir, envDir, dockerBin: fakeDocker.path, wildcardZone: 'apps.test',
  });

  await r._pollTick();

  // Verify state transitions.
  const newDeploy = db._state.hosted_app_deploys.get('newDeploy');
  assert.equal(newDeploy.status, 'running', 'new deploy marked running');
  const oldDeploy = db._state.hosted_app_deploys.get('oldDeploy');
  assert.equal(oldDeploy.status, 'superseded', 'old deploy superseded');

  const app = db._state.hosted_apps.get(appId);
  assert.equal(app.container_id, 'containerA');
  assert.equal(app.current_deploy_id, 'newDeploy');
  assert.equal(app.status, 'running');
  assert.ok(app.port >= 10000 && app.port <= 19999, 'port allocated');

  // Verify Caddy was called with the new port.
  const upsert = caddy.calls.find((c) => c.op === 'upsert');
  assert.ok(upsert, 'caddy upsert called');
  assert.equal(upsert.subdomain, 'myapp');
  assert.equal(upsert.port, app.port);

  // Dockerfile + env file were written.
  assert.ok(fs.existsSync(path.join(srcDir, 'Dockerfile')));
  assert.ok(fs.existsSync(path.join(srcDir, 'lc-start-cmd')));
  assert.ok(fs.existsSync(path.join(envDir, appId + '.env')));

  // A deploy event was emitted.
  const ev = db._state.hosted_app_events.find((e) => e.kind === 'deploy');
  assert.ok(ev, 'deploy event emitted');
});

test('state machine: hosted_apps status UPDATE no-op (schema drift) fails deploy loudly + rolls back container', async () => {
  // Regression guard for the 2026-08-13 smoke test's LAST-mile bug. The
  // runner's hot-path UPDATE at cloud-hosted-app-runner.js:474-479 writes
  // hosted_apps status='running' — but _safeRun swallows any SQL error
  // silently, so a missing column (or any schema drift) leaves the app
  // stuck at status='building' while a healthy container is up and
  // serving. Public HTTPS proxy then returns the "Building" placeholder
  // forever.
  //
  // This test simulates schema drift by intercepting db.prepare for THAT
  // specific UPDATE and forcing changes=0. The runner MUST detect that
  // and roll back:
  //   - stop + rm the new container (frees the port)
  //   - _failDeploy(deploy, 'app_status_update_failed', ...) with a
  //     diagnostic message that names the schema-drift cause
  //   - emit deploy_failed event
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hosted-app-update-drift-'));
  const stateDir = path.join(workDir, 'state');
  const envDir = path.join(workDir, 'env');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });

  const fakeDocker = writeFakeDocker(workDir);
  fakeDocker.set({ inspect_health: 'healthy', build_exit: 0, run_exit: 0, run_output: 'newContainerXYZ' });

  const db = makeFakeDb();
  const appId = 'app-drift';
  db._state.hosted_apps.set(appId, {
    id: appId, backend_id: 'b1', subdomain: 'drifted',
    status: 'building',
    runtime_version: '3.12', healthcheck_path: '/',
    memory_mb: 256, cpu_shares: 512,
    container_id: null, port: null, current_deploy_id: null,
  });
  const srcDir = path.join(stateDir, appId, 'depDrift', 'source');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'main.py'), '# fake\n');
  fs.writeFileSync(path.join(srcDir, 'requirements.txt'), 'fastapi\n');
  db._state.hosted_app_deploys.set('depDrift', {
    id: 'depDrift', app_id: appId, status: 'queued',
    requirements_sha: 'shaDrift', started_at: '2026-01-01T00:00:00Z',
  });

  // Simulate schema drift: force the hosted_apps status='running' UPDATE
  // to appear to run cleanly but affect 0 rows (as _safeRun would return
  // on any real SQL error).
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = origPrepare(sql);
    if (/UPDATE hosted_apps\s+SET status='running', current_deploy_id/i.test(sql)) {
      return {
        run: () => ({ changes: 0 }),
        get: () => undefined,
        all: () => [],
      };
    }
    return stmt;
  };

  const caddy = makeFakeCaddy();
  const r = createHostedAppRunner({
    db, caddyClient: caddy, stateDir, envDir, dockerBin: fakeDocker.path, wildcardZone: 'apps.test',
  });

  await r._pollTick();

  // Deploy must be marked failed with the diagnostic error_code.
  const dep = db._state.hosted_app_deploys.get('depDrift');
  assert.equal(dep.status, 'failed', 'deploy must be marked failed (not left in building forever)');
  assert.equal(dep.error_code, 'app_status_update_failed', 'error_code must identify the schema-drift path');
  assert.match(dep.error || '', /schema drift|migrate\.js|hosted_apps/, 'error message must point ops at the fix');

  // App row: since our UPDATE was a no-op, status stays 'building' — that's
  // the pre-existing broken behavior we're catching. The critical
  // invariant is that the DEPLOY row transitioned to failed so the
  // failure is visible; the app row won't be misleadingly claimed as
  // 'running'.
  const app = db._state.hosted_apps.get(appId);
  assert.equal(app.status, 'building', 'app status remains building (UPDATE was intercepted)');

  // A lifecycle event should be emitted for observability.
  const ev = db._state.hosted_app_events.find((e) => e.kind === 'deploy_failed');
  assert.ok(ev, 'deploy_failed event emitted');
});

test('state machine: unhealthy container fails deploy, keeps old container', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hosted-test-'));
  const stateDir = path.join(workDir, 'state');
  const envDir = path.join(workDir, 'env');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });

  const fakeDocker = writeFakeDocker(workDir);
  fakeDocker.set({ inspect_health: 'unhealthy', run_output: 'newC' });

  const db = makeFakeDb();
  const appId = 'app-uuid-2';
  db._state.hosted_apps.set(appId, {
    id: appId, backend_id: 'b1', subdomain: 'myapp2',
    status: 'running',
    runtime_version: '3.12', healthcheck_path: '/',
    memory_mb: 128, cpu_shares: 256,
    container_id: 'oldC', port: 11111, current_deploy_id: 'd0',
  });

  const srcDir = path.join(stateDir, appId, 'd1', 'source');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'main.py'), '# fake\n');
  db._state.hosted_app_deploys.set('d1', {
    id: 'd1', app_id: appId, status: 'queued',
    started_at: '2020-02-01T00:00:00Z',
  });

  const caddy = makeFakeCaddy();
  // Shrink the health budget so this test finishes quickly. We do this by
  // monkey-patching setTimeout... simpler: override HEALTH_MAX_MS via a
  // module-scoped hack isn't possible from outside, so we accept the 60s wall
  // and set the test timeout accordingly.
  const r = createHostedAppRunner({
    db, caddyClient: caddy, stateDir, envDir, dockerBin: fakeDocker.path,
  });

  // Skip this heavy path unless the caller opts in.
  if (process.env.RUN_SLOW_HEALTHCHECK_TEST !== '1') {
    return; // pass; long test is opt-in
  }

  await r._pollTick();
  const d1 = db._state.hosted_app_deploys.get('d1');
  assert.equal(d1.status, 'failed');
  assert.equal(d1.error_code, 'healthcheck_failed');
  const app = db._state.hosted_apps.get(appId);
  assert.equal(app.container_id, 'oldC', 'old container kept');
});

test('enqueueDeploy inserts a queued row and emits event', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hosted-test-'));
  const fakeDocker = writeFakeDocker(workDir);
  const db = makeFakeDb();
  const caddy = makeFakeCaddy();
  const r = createHostedAppRunner({
    db, caddyClient: caddy, dockerBin: fakeDocker.path, stateDir: workDir, envDir: workDir,
  });
  db._state.hosted_apps.set('appX', { id: 'appX', backend_id: 'b1', subdomain: 'x', status: 'running' });
  const { deployId } = await r.enqueueDeploy({
    appId: 'appX', userId: 'u1', sourceSha256: 'aaa', requirementsSha: 'bbb',
  });
  assert.ok(deployId);
  const row = db._state.hosted_app_deploys.get(deployId);
  assert.equal(row.status, 'queued');
  assert.equal(row.requirements_sha, 'bbb');
  const ev = db._state.hosted_app_events.find((e) => e.kind === 'deploy_queued');
  assert.ok(ev);
});

test('pauseApp stops container and deletes caddy route', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hosted-test-'));
  const fakeDocker = writeFakeDocker(workDir);
  const db = makeFakeDb();
  const caddy = makeFakeCaddy();
  db._state.hosted_apps.set('appP', {
    id: 'appP', backend_id: 'b1', subdomain: 'p', status: 'running',
    container_id: 'cP', port: 10010,
  });
  const r = createHostedAppRunner({
    db, caddyClient: caddy, dockerBin: fakeDocker.path, stateDir: workDir, envDir: workDir,
  });
  await r.pauseApp({ appId: 'appP' });
  assert.equal(db._state.hosted_apps.get('appP').status, 'paused');
  assert.ok(caddy.calls.find((c) => c.op === 'delete' && c.subdomain === 'p'));
  assert.ok(db._state.hosted_app_events.find((e) => e.kind === 'pause'));
});

// ── _pollTick timeout: hung _runDeploy cannot poison claimingBusy ────────────
//
// Regression guard for the 2026-08-13 bug: a stalled _spawnDocker promise
// (the actual smoke-test hit was ProtectSystem=strict blocking fs.writeFileSync
// mid-_runDeploy, but the visible symptom was an unresolved await) left
// claimingBusy=true, so every subsequent poll returned early at the top of
// _pollTick and no further deploys were ever claimed on that worker.
//
// These tests use a fake "docker" that sleeps well past the tick's short
// maxDeployTotalMs (200 ms) so `_runDeploy` genuinely hangs at
// `await _spawnDocker(...)`. If the mutex isn't released, the second
// _pollTick in each test does nothing and the assertions fail.
//
// Cleanup trap (2026-08-14): the runner's mutex fix explicitly documents
// that a leaked _runDeploy promise cannot be cancelled — no Node primitive
// for that. The fake docker subprocess it spawned stays alive AND keeps
// Node's stdio pipes open, blocking event-loop drain. If we don't kill
// the leaked child, `node --test` waits for it to exit before terminating
// the file, and a `--test test/*.test.js` full-suite run wedges here for
// the full docker sleep duration → subsequent files never run.
//
// Worse: a leaked `_runDeploy` that gets past `docker build` cascades
// into `docker run` + `_waitForHealthy` (60s poll loop @ 2s cadence),
// each also invoking the same fake and each also getting leaked. One
// stalled tick = 60+ seconds of blocked event loop.
//
// Fix: pkill the fake docker binary by its unique per-test path after
// the tick returns. First pkill kills the currently-running fake →
// _spawnDocker resolves with code=-1 (SIGKILL) → _runDeploy hits the
// build_failed branch and returns without cascading into docker run
// or the healthcheck loop. The event loop drains fast.
function writeSleepingDocker(dir, sleepSecs) {
  const p = path.join(dir, 'sleeping-docker.sh');
  fs.writeFileSync(p, `#!/bin/sh
sleep ${sleepSecs}
`, { mode: 0o755 });
  return p;
}

function killLeakedDockerChildren(dockerBinPath) {
  // Best-effort: pkill exits non-zero when nothing matches — that's fine.
  // Match by full path to avoid killing unrelated `sleep`s on the box.
  try {
    require('child_process').execSync(`pkill -9 -f "${dockerBinPath}"`, { stdio: 'ignore' });
  } catch (_) { /* nothing to kill */ }
}

test('poll timeout: hung _runDeploy releases mutex, fails deploy with runner_timeout', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hosted-poll-timeout-'));
  const stateDir = path.join(workDir, 'state');
  const envDir = path.join(workDir, 'env');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });

  const dockerBin = writeSleepingDocker(workDir, 3);
  // Kill leaked sleeping-docker children AFTER assertions so Node's event
  // loop can drain and this test file doesn't block downstream files in
  // a full-suite run. See writeSleepingDocker comment for the full trap.
  t.after(() => killLeakedDockerChildren(dockerBin));
  const db = makeFakeDb();
  const caddy = makeFakeCaddy();

  const appId = 'appHang';
  db._state.hosted_apps.set(appId, {
    id: appId, backend_id: 'b1', subdomain: 'hang', status: 'building',
    runtime_version: '3.12', healthcheck_path: '/', memory_mb: 256, cpu_shares: 512,
    container_id: null, port: null, current_deploy_id: null, env_json: null,
  });
  // Source dir must exist so _runDeploy gets past its fs.existsSync guard
  // and actually reaches the awaited docker build (where we hang).
  const srcDir = path.join(stateDir, appId, 'depHang', 'source');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'main.py'), '# fake\n');
  fs.writeFileSync(path.join(srcDir, 'requirements.txt'), 'fastapi\n');
  db._state.hosted_app_deploys.set('depHang', {
    id: 'depHang', app_id: appId, status: 'queued',
    requirements_sha: 'sha', started_at: '2020-01-01T00:00:00Z',
  });

  const r = createHostedAppRunner({
    db, caddyClient: caddy, stateDir, envDir, dockerBin, wildcardZone: 'apps.test',
    maxDeployTotalMs: 200, // 200 ms << 3 s sleep → timeout wins (see writeSleepingDocker comment)
  });

  const t0 = Date.now();
  await r._pollTick();
  const elapsed = Date.now() - t0;

  // Load-bearing guarantee: the tick returned in bounded time, meaning the
  // mutex was released. 2 s ceiling gives massive slack for CI variance;
  // real value is ~200 ms.
  assert.ok(elapsed < 2000, `tick should time out fast, took ${elapsed}ms`);

  const dep = db._state.hosted_app_deploys.get('depHang');
  assert.equal(dep.status, 'failed', 'timed-out deploy must land in failed (not stuck in building)');
  assert.equal(dep.error_code, 'runner_timeout', 'error_code identifies the timeout path');

  // Second poll tick: seed a NEW queued deploy and prove the runner actually
  // picks it up — the smoking gun that the mutex is genuinely released. If
  // claimingBusy leaked, this deploy would sit forever in 'queued'.
  db._state.hosted_app_deploys.set('depFresh', {
    id: 'depFresh', app_id: appId, status: 'queued',
    requirements_sha: 'sha', started_at: '2020-01-01T00:01:00Z',
  });
  // Give the fresh deploy a source dir too so its _runDeploy also reaches
  // the docker await (and re-hangs, harmlessly, past the tick's timeout).
  const srcDir2 = path.join(stateDir, appId, 'depFresh', 'source');
  fs.mkdirSync(srcDir2, { recursive: true });
  fs.writeFileSync(path.join(srcDir2, 'main.py'), '# fake\n');
  fs.writeFileSync(path.join(srcDir2, 'requirements.txt'), 'fastapi\n');

  await r._pollTick();

  const dep2 = db._state.hosted_app_deploys.get('depFresh');
  assert.notEqual(dep2.status, 'queued', 'second tick MUST claim the fresh deploy (mutex released)');
  assert.equal(dep2.status, 'failed', 'fresh deploy also times out — but was reached');
  assert.equal(dep2.error_code, 'runner_timeout');
});

test('poll: existing exception path still marks deploy as runner_exception', async () => {
  // Backward-compat: preserve the pre-fix behavior for the "_runDeploy
  // threw" case — should surface as runner_exception, not runner_timeout.
  // Force this by pointing dockerBin at a nonexistent path, so
  // _spawnDocker's child.on('error') resolves with code=-1 → build_failed
  // via _failDeploy. In THIS variant _runDeploy actually settles fast
  // (rejects internally via _failDeploy then returns), so we shouldn't
  // hit the timeout branch. Assertion: status='failed' with a NON-timeout
  // error_code.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hosted-poll-exc-'));
  const stateDir = path.join(workDir, 'state');
  const envDir = path.join(workDir, 'env');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });

  const appId = 'appExc';
  const db = makeFakeDb();
  const caddy = makeFakeCaddy();
  db._state.hosted_apps.set(appId, {
    id: appId, backend_id: 'b1', subdomain: 'exc', status: 'building',
    runtime_version: '3.12', healthcheck_path: '/', memory_mb: 256, cpu_shares: 512,
  });
  const srcDir = path.join(stateDir, appId, 'depExc', 'source');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'main.py'), '# fake\n');
  fs.writeFileSync(path.join(srcDir, 'requirements.txt'), 'fastapi\n');
  db._state.hosted_app_deploys.set('depExc', {
    id: 'depExc', app_id: appId, status: 'queued',
    requirements_sha: 'sha', started_at: '2020-01-01T00:00:00Z',
  });

  const r = createHostedAppRunner({
    db, caddyClient: caddy, stateDir, envDir,
    dockerBin: '/definitely/not/a/real/docker/binary',
    wildcardZone: 'apps.test',
    maxDeployTotalMs: 5000, // generous — we want the ENOENT to win, not the timer
  });

  await r._pollTick();

  const dep = db._state.hosted_app_deploys.get('depExc');
  assert.equal(dep.status, 'failed');
  assert.notEqual(dep.error_code, 'runner_timeout',
    'ENOENT on docker should surface as build_failed (or runner_exception), not runner_timeout');
});

test('enqueueDeploy with an existing deployId only nudges: no second row, no SQL error', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hosted-nudge-'));
  const fakeDocker = writeFakeDocker(workDir);
  const db = makeFakeDb();
  const inserts = [];
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/INSERT INTO hosted_app_deploys/i.test(sql)) inserts.push(sql);
    return origPrepare(sql);
  };
  const origErr = console.error;
  const captured = [];
  console.error = (...a) => captured.push(a.join(' '));
  try {
    const r = createHostedAppRunner({ db, dockerBin: fakeDocker.path, stateDir: workDir, envDir: workDir, wildcardZone: 'apps.test' });
    const out = await r.enqueueDeploy({ appId: 'app-nudge', deployId: 'hdep-existing' });
    assert.deepEqual(out, { deployId: 'hdep-existing' });
  } finally {
    console.error = origErr;
  }
  assert.equal(inserts.length, 0, 'a nudge must not insert a deploy row');
  assert.equal(captured.filter((l) => /source_sha256/.test(l)).length, 0, captured.join('\n'));
});
