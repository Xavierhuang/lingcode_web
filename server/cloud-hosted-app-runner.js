'use strict';

// cloud-hosted-app-runner.js — the HOSTED-APPS state machine (Phase B).
//
// Turns queued `hosted_app_deploys` rows into running Docker containers behind
// Caddy at <slug>.apps.lingcode.dev. One container per app; images baked once
// per deploy from an already-extracted source tree (routes.js wrote it under
// stateDir/<app-id>/<deploy-id>/source/). Companion to cloud-compute-runner.js
// (short-lived batch jobs) — this is the "long-running web process" tier.
//
// State moves (hosted_app_deploys.status):
//     queued → building → running          — happy path
//     queued → building → failed           — build/healthcheck failed
//     running → superseded                 — a newer deploy took over
// State moves (hosted_apps.status):
//     paused | running | crashed | deleted
//
// DEPLOYMENT: like cloud-compute-runner, this ships everywhere but only wakes
// up where HOSTED_APP_RUNNER_ENABLED=1 (droplets with Docker + Caddy). The API
// box leaves it dormant. Two internal timers when active:
//   * deploy poll   — every POLL_MS (default 2s), claims one queued deploy
//   * meter sweep   — every 5 min, uptime + egress rollup + quota check
// Restart-watchdog runs on its own 30 s cadence inside the poll loop.
//
// Docker calls are all child_process.spawn/spawnSync — no dockerode dep.
// Caddy calls go through ./cloud-hosted-app-caddy (CLI-less http admin API).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { spawn, spawnSync } = require('child_process');

const buildpack = require('./cloud-hosted-app-buildpack');
const caddyMod = require('./cloud-hosted-app-caddy');
// cloud-limits used for maxAppUptimeHrsPerMonth etc. Wrapped in try so the
// unit tests can `require` this file without a limits table.
let limitsMod = null;
try { limitsMod = require('./cloud-limits'); } catch (_) { limitsMod = null; }

// ── constants ────────────────────────────────────────────────────────────────

const PORT_MIN = 10000;
const PORT_MAX = 19999;
const POLL_MS = Math.max(500, Number(process.env.HOSTED_APP_POLL_MS || 2000));
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;
const HEALTH_POLL_MS = 2000;
const HEALTH_MAX_MS = 60 * 1000;
const OLD_STOP_GRACE_S = 5;
const RESTART_WATCH_MS = 30 * 1000;
const METER_MS = 5 * 60 * 1000;
const METER_TICK_S = 300;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const RESTART_LIMIT = 5;
const BUCKET_TTL_MS = 24 * 60 * 60 * 1000;
const WORKER_ID = process.env.HOSTED_APP_WORKER_ID || `${os.hostname()}:${process.pid}`;

const nowIso = () => new Date().toISOString();
const nowMs = () => Date.now();
const shortId = (id) => String(id || '').slice(0, 8);

// ── pure helpers (exported for direct unit testing) ──────────────────────────

// allocatePort — first port in [PORT_MIN, PORT_MAX] not already claimed by any
// hosted_apps row (regardless of app status; a "paused" app keeps its port so
// resume is a no-op). Returns null if the range is exhausted.
function allocatePort(db) {
  const rows = _safeAll(db, 'SELECT port FROM hosted_apps WHERE port IS NOT NULL');
  const taken = new Set();
  for (const r of rows) {
    const p = Number(r && r.port);
    if (Number.isInteger(p)) taken.add(p);
  }
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!taken.has(p)) return p;
  }
  return null;
}

// bakeStartCmdIntoDockerfile — splice a COPY that plants the resolved
// entrypoint into /lc/start-cmd. The base image's entrypoint.sh reads that
// file. We insert AFTER the last COPY (so `COPY . .` doesn't overwrite it
// mid-build) and BEFORE the USER / CMD lines (so root is still available to
// write into /lc). If neither anchor is found we simply append near the end.
//
// Continuation trap (2026-08-13): the buildpack's Dockerfile ends with a
// HEALTHCHECK directive whose args wrap onto a second line via `\`:
//
//   HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
//     CMD curl -fsS "http://127.0.0.1:${port}${HEALTHCHECK_PATH}" || exit 1
//   USER nobody-app
//   CMD ["/lc/entrypoint.sh"]
//
// The naive "first line whose trim() startsWith('CMD ')" scan matched the
// CONTINUATION of HEALTHCHECK — not a standalone CMD — and spliced the
// injection into the middle of the HEALTHCHECK args. Docker then parsed:
//
//   HEALTHCHECK --interval=... --retries=3 \
//   # lingcode: baked start command                ← swallowed as continuation
//   COPY lc-start-cmd /lc/start-cmd                ← treated as HEALTHCHECK arg
//     CMD curl -fsS ...
//
// and errored with `Unknown type "COPY" in HEALTHCHECK (try CMD)`. Deploy
// failed with error_code='build_failed'.
//
// Fix: track continuation state while scanning — a line is only a
// "standalone directive" if the previous non-empty line does NOT end with
// `\`. HEALTHCHECK's wrapped CMD is thereby skipped, and the anchor lands
// on the real `USER nobody-app` / `CMD ["/lc/entrypoint.sh"]` below.
function bakeStartCmdIntoDockerfile(baseDockerfile, resolvedCommand) {
  if (typeof baseDockerfile !== 'string') throw new Error('baseDockerfile must be string');
  if (typeof resolvedCommand !== 'string' || resolvedCommand.length === 0) {
    throw new Error('resolvedCommand must be non-empty string');
  }
  const lines = baseDockerfile.split('\n');
  const injection = [
    '# lingcode: baked start command',
    'COPY lc-start-cmd /lc/start-cmd',
  ];
  let anchor = -1;
  let prevContinues = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const l = raw.trim();
    // Skip continuation lines — their leading word belongs to the previous
    // directive, not to a new one. `#` comments are transparent to Docker's
    // continuation state (Docker treats them as line-oriented and does NOT
    // reset `\` on a comment), so we do the same.
    const isStandalone = !prevContinues;
    if (isStandalone && (l.startsWith('USER ') || l.startsWith('CMD ') || l === 'USER' || l === 'CMD')) {
      anchor = i; break;
    }
    // The `\` must be the LAST non-newline char to trigger continuation.
    // Empty lines reset continuation (Docker terminates the directive).
    prevContinues = l.length > 0 && raw.endsWith('\\');
  }
  if (anchor === -1) {
    // Preserve any trailing blank line.
    let insertAt = lines.length;
    while (insertAt > 0 && lines[insertAt - 1] === '') insertAt--;
    lines.splice(insertAt, 0, ...injection);
  } else {
    lines.splice(anchor, 0, ...injection);
  }
  return lines.join('\n');
}

// parseNetIO — Docker's `{{.NetIO}}` template returns e.g. "1.2MB / 350kB".
// Both sides may be omitted (empty) on fresh containers; return zeros then.
// Unit suffixes are IEC-ish per Docker convention: B, kB, MB, GB, TB (SI-1000).
function parseNetIO(str) {
  if (typeof str !== 'string' || str.length === 0) return { in: 0, out: 0 };
  const parts = str.split('/');
  if (parts.length < 2) return { in: 0, out: 0 };
  return { in: _parseHumanBytes(parts[0]), out: _parseHumanBytes(parts[1]) };
}

function _parseHumanBytes(raw) {
  const s = String(raw || '').trim();
  if (!s) return 0;
  const m = /^([0-9]*\.?[0-9]+)\s*([kKmMgGtTpP]?[iI]?[bB]?)$/.exec(s);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = m[2].toLowerCase().replace('b', '').replace('i', '');
  // Docker's docs say SI (kB=1000). Real practice is inconsistent; use SI to
  // match the CLI's own default output.
  const mult = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12, p: 1e15 }[unit] || 1;
  return Math.round(n * mult);
}

// computeRestartTransition — given a hosted_apps row's { restart_count,
// restart_window_start } and the current .RestartCount from docker inspect,
// decide (a) whether to promote the app to status='crashed', (b) the new
// counter, (c) the new window-start timestamp (ms epoch).
//
// Semantics: RESTART_LIMIT+1 within RESTART_WINDOW_MS trips the breaker.
// If the window has expired, reset it. If dockerCount hasn't advanced, don't
// double-count (idempotent when the watchdog polls faster than restarts).
function computeRestartTransition(row, dockerCount, now) {
  const r = row || {};
  const prevCount = Number(r.restart_count) || 0;
  const prevWindowStart = Number(r.restart_window_start) || 0;
  const dc = Math.max(0, Number(dockerCount) || 0);
  const t = Number(now) || nowMs();

  // Expired window → fresh cycle starts now.
  let windowStart = prevWindowStart;
  let count = prevCount;
  if (!windowStart || (t - windowStart) > RESTART_WINDOW_MS) {
    windowStart = t;
    count = 0;
  }

  // Delta since we last polled. dc is the docker cumulative RestartCount, not
  // strictly a "since this app row was created" number, so we track the last
  // observed cumulative in `count` and add the delta.
  // For the first observation in a window, prevCount is 0 and dc > 0 would
  // over-count; the caller writes the cumulative into `count`. To keep this
  // helper pure we accept a `_lastCumulative` on the row.
  const lastCumulative = Number(r._lastCumulative) || 0;
  let delta = dc - lastCumulative;
  if (delta < 0) delta = dc; // container was rebuilt; reset baseline
  count += delta;

  const shouldPromoteCrashed = count > RESTART_LIMIT;
  return {
    shouldPromoteCrashed,
    newCount: count,
    newWindowStart: windowStart,
    newLastCumulative: dc,
  };
}

// ── db helpers (all wrapped so a missing/renamed table never crashes the loop)

// Runner-local safe SQL helpers.
//
// Return shape is intentionally identical to better-sqlite3's own
// prepare().run() / .get() / .all() (`{changes, lastInsertRowid}` /
// row object / row array) so the runner never sees a thrown exception
// from a stray SQL error and crash-loop the whole hosted-apps subsystem.
//
// Historical trap (2026-08-13): these helpers ORIGINALLY swallowed
// errors silently with a bare `catch (_)`. Combined with five separate
// migration-drift bugs that added columns to UPDATEs without ever
// declaring them (worker_id, build_started_at, build_finished_at,
// error_code, last_deployed_at), the swallow made every symptom
// invisible:
//   - _claimQueued's UPDATE silently no-op'd → runner appeared dead
//   - _failDeploy's UPDATE silently no-op'd → failures never surfaced
//   - Success-path hosted_apps UPDATE silently no-op'd → app stuck at
//     'building' while a healthy container ran on its port
// Every one of those bugs would have been caught in seconds by a
// SINGLE `console.error` line. Cost of always logging: ~zero (SQL
// errors on the hot path should be exceedingly rare — schema is
// stable, the runner writes to a small fixed set of tables).
//
// Kept as narrow SQL-preview logs (first 120 chars, whitespace-
// normalized) so they don't flood journalctl with full multi-line
// prepared statements. The exception `.message` alone is usually
// enough to identify the column/constraint at fault ("no such
// column: X", "CHECK constraint failed", etc.).

function _sqlPreview(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function _logSqlError(op, e, sql) {
  try {
    // eslint-disable-next-line no-console
    console.error(`[cloud-hosted-app-runner] ${op} SQL error: ${e && e.message ? e.message : String(e)} — SQL: ${_sqlPreview(sql)}`);
  } catch (_) { /* logging is best-effort */ }
}

function _safeAll(db, sql, ...args) {
  try { return db.prepare(sql).all(...args); }
  catch (e) { _logSqlError('_safeAll', e, sql); return []; }
}
function _safeGet(db, sql, ...args) {
  try { return db.prepare(sql).get(...args); }
  catch (e) { _logSqlError('_safeGet', e, sql); return null; }
}
function _safeRun(db, sql, ...args) {
  try { return db.prepare(sql).run(...args); }
  catch (e) { _logSqlError('_safeRun', e, sql); return { changes: 0 }; }
}

function _emitEvent(db, appId, kind, message, extra) {
  // `ts` is the ORIGINAL migration's column (INTEGER millis, NOT NULL).
  // `created_at` is the newer TEXT ISO column the runner + `listEvents`
  // reader actually use. We write BOTH so:
  //   (a) the NOT NULL invariant on `ts` is satisfied (avoids a full
  //       table rebuild to relax it), and
  //   (b) any query that still sorts / filters on `ts` keeps working.
  // Column additions for created_at + extra_json are declared in the
  // guarded ALTER block in migrate.js (search "hosted_app_events").
  _safeRun(
    db,
    `INSERT INTO hosted_app_events (app_id, kind, message, ts, created_at, extra_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    appId, kind, message || '', Date.now(), nowIso(),
    extra ? JSON.stringify(extra) : null
  );
}

// ── docker CLI wrappers ──────────────────────────────────────────────────────

function _spawnDocker(bin, args, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 30000;
  const cwd = (opts && opts.cwd) || undefined;
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.stderr.on('data', (d) => { err += d.toString('utf8'); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e.message || e) }); });
  });
}

function _spawnDockerSync(bin, args, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 5000;
  const r = spawnSync(bin, args, { timeout: timeoutMs, encoding: 'utf8' });
  return {
    code: r.status == null ? -1 : r.status,
    out: r.stdout || '',
    err: r.stderr || (r.error ? String(r.error.message || r.error) : ''),
  };
}

// ── factory ──────────────────────────────────────────────────────────────────

function createHostedAppRunner(opts) {
  const o = opts || {};
  const db = o.db;
  if (!db) throw new Error('createHostedAppRunner: db is required');
  const stateDir = o.stateDir || '/var/lib/lingcode-hosted-apps';
  const envDir = o.envDir || '/run/lingcode/hosted-app-envs';
  const dockerBin = o.dockerBin || 'docker';
  const wildcardZone = o.wildcardZone || 'apps.lingcode.dev';
  // Callers can inject a caddy client (tests do); otherwise construct one.
  const caddyClient = o.caddyClient || caddyMod.createCaddyClient({ wildcardZone });
  // Optional secrets vault for env injection (Phase B design). Best-effort.
  const secretsVault = o.secretsVault || null;
  // Wall-clock ceiling for a single _runDeploy call, INCLUDING any hung
  // await inside it (see _pollTick comment for the leak this bounds).
  // Default 15 min is well above the sum of per-step timeouts
  // (BUILD_TIMEOUT_MS 5m + docker run 60s + healthcheck 60s ≈ 7m) so a
  // legitimate FastAPI-with-heavy-deps build never trips it. Tests set
  // this to a small value to exercise the timeout path deterministically.
  const maxDeployTotalMs = Number.isFinite(o.maxDeployTotalMs) && o.maxDeployTotalMs > 0
    ? o.maxDeployTotalMs
    : 15 * 60 * 1000;

  let pollHandle = null;
  let meterHandle = null;
  let watchHandle = null;
  let stopping = false;
  let claimingBusy = false;

  // ── deploy claim + execute ─────────────────────────────────────────────────

  function _claimQueued() {
    const tx = db.transaction(() => {
      const row = _safeGet(
        db,
        `SELECT * FROM hosted_app_deploys
         WHERE status='queued'
         ORDER BY started_at LIMIT 1`
      );
      if (!row) return null;
      const r = _safeRun(
        db,
        `UPDATE hosted_app_deploys SET status='building', worker_id=?, build_started_at=?
         WHERE id=? AND status='queued'`,
        WORKER_ID, nowIso(), row.id
      );
      return (r && r.changes) ? row : null;
    });
    try { return tx(); } catch (_) { return null; }
  }

  async function _runDeploy(deploy) {
    const appId = deploy.app_id;
    const deployId = deploy.id;
    const app = _safeGet(db, 'SELECT * FROM hosted_apps WHERE id=?', appId);
    if (!app) {
      _failDeploy(deployId, 'app_not_found', 'hosted_apps row disappeared');
      return;
    }
    if (app.status === 'deleted') {
      _failDeploy(deployId, 'app_deleted', 'app was deleted before build');
      return;
    }

    const sourceDir = path.join(stateDir, appId, deployId, 'source');
    if (!fs.existsSync(sourceDir)) {
      _failDeploy(deployId, 'source_missing', `expected ${sourceDir}`);
      return;
    }

    // 1. Buildpack: Dockerfile + resolved start command.
    let dockerfile, resolvedCmd;
    try {
      const base = buildpack.generateDockerfile({
        runtimeVersion: app.runtime_version || '3.12',
        healthcheckPath: app.healthcheck_path || '/',
        port: 8080, // fixed inside the container; host maps to the app's chosen port
      });
      const procPath = path.join(sourceDir, 'Procfile');
      let webLine = null;
      if (fs.existsSync(procPath)) {
        try { webLine = buildpack.parseProcfileWebLine(fs.readFileSync(procPath, 'utf8')); }
        catch (_) { webLine = null; }
      }
      const entry = buildpack.resolveEntrypoint({
        hasProcfile: !!webLine,
        procfileWebLine: webLine,
        hasAppPy: fs.existsSync(path.join(sourceDir, 'app.py')),
        hasMainPy: fs.existsSync(path.join(sourceDir, 'main.py')),
      });
      if (entry.error) {
        _failDeploy(deployId, 'entrypoint_unresolved', entry.error);
        return;
      }
      resolvedCmd = entry.command;
      dockerfile = bakeStartCmdIntoDockerfile(base, resolvedCmd);
    } catch (e) {
      _failDeploy(deployId, 'buildpack_failed', String(e.message || e));
      return;
    }

    // Write Dockerfile + start-cmd sidecar into the source dir.
    try {
      fs.writeFileSync(path.join(sourceDir, 'Dockerfile'), dockerfile, 'utf8');
      fs.writeFileSync(path.join(sourceDir, 'lc-start-cmd'), resolvedCmd + '\n', { mode: 0o644 });
    } catch (e) {
      _failDeploy(deployId, 'write_dockerfile_failed', String(e.message || e));
      return;
    }

    // 2. Build. Reuse prior image layers if requirements_sha matches the prev
    // deploy — routes.js sets that column when it hashes the tarball.
    const imageTag = `hosted-app:${appId}-${deployId}`;
    const cacheFrom = _findCacheFromImage(appId, deploy.requirements_sha);
    const buildArgs = ['build', '-t', imageTag];
    if (cacheFrom) buildArgs.push('--cache-from', cacheFrom);
    buildArgs.push('.');
    const buildRes = await _spawnDocker(dockerBin, buildArgs, {
      cwd: sourceDir, timeoutMs: BUILD_TIMEOUT_MS,
    });
    if (buildRes.code !== 0) {
      _failDeploy(deployId, 'build_failed',
        (buildRes.err || buildRes.out || `docker build exit ${buildRes.code}`).slice(0, 4000));
      return;
    }

    // 3. Run. Allocate port, write env file, spawn container.
    const port = allocatePort(db);
    if (port == null) {
      _failDeploy(deployId, 'no_port_available', `range ${PORT_MIN}-${PORT_MAX} exhausted`);
      return;
    }

    // Env file (0600) with platform-required + backend-vault secrets.
    try { fs.mkdirSync(envDir, { recursive: true }); } catch (_) {}
    const envFile = path.join(envDir, `${appId}.env`);
    const envMap = _buildEnvMap(app, port);
    if (secretsVault && typeof secretsVault.readAllBackendSecrets === 'function') {
      try {
        const sec = secretsVault.readAllBackendSecrets(db, app.backend_id) || {};
        for (const [k, v] of Object.entries(sec)) if (!(k in envMap)) envMap[k] = v;
      } catch (_) {}
    }
    try {
      fs.writeFileSync(envFile, _formatEnvFile(envMap), { mode: 0o600 });
    } catch (e) {
      _failDeploy(deployId, 'envfile_write_failed', String(e.message || e));
      return;
    }

    const cname = `lc-hosted-${appId}-${shortId(deployId)}`;
    const runArgs = [
      'run', '-d', '--name', cname,
      '--network', 'bridge',
      '--publish', `127.0.0.1:${port}:8080`,
      '--cap-drop=ALL',
      '--read-only',
      '--tmpfs', '/tmp',
      '--user', '65534:65534',
      '--pids-limit=256',
      `--memory=${_mem(app)}m`,
      `--memory-swap=${_mem(app)}m`,
      `--cpu-shares=${_cpu(app)}`,
      '--cgroup-parent=lingcode-hosted-apps.slice',
      '--restart=on-failure:5',
      '--env-file', envFile,
      imageTag,
    ];
    const runRes = await _spawnDocker(dockerBin, runArgs, { timeoutMs: 60000 });
    if (runRes.code !== 0) {
      _failDeploy(deployId, 'run_failed',
        (runRes.err || runRes.out || `docker run exit ${runRes.code}`).slice(0, 4000));
      return;
    }
    const newContainer = (runRes.out || '').trim().split('\n').pop() || cname;

    // 4. Wait for healthy.
    const healthy = await _waitForHealthy(newContainer);
    if (!healthy) {
      // Stop the NEW container, keep the OLD one running.
      await _spawnDocker(dockerBin, ['stop', '-t', '1', newContainer], { timeoutMs: 10000 }).catch(() => {});
      await _spawnDocker(dockerBin, ['rm', '-f', newContainer], { timeoutMs: 10000 }).catch(() => {});
      _failDeploy(deployId, 'healthcheck_failed', 'container did not become healthy within 60s');
      _emitEvent(db, appId, 'deploy_failed', 'healthcheck_failed', { deploy_id: deployId });
      return;
    }

    // 5. Swap Caddy + stop old container.
    const oldContainer = app.container_id || null;
    try {
      await caddyClient.upsertRoute({ subdomain: app.subdomain, port });
    } catch (e) {
      await _spawnDocker(dockerBin, ['stop', '-t', '1', newContainer], { timeoutMs: 10000 }).catch(() => {});
      await _spawnDocker(dockerBin, ['rm', '-f', newContainer], { timeoutMs: 10000 }).catch(() => {});
      _failDeploy(deployId, 'caddy_upsert_failed', String(e.message || e));
      return;
    }

    if (oldContainer && oldContainer !== newContainer) {
      await _spawnDocker(dockerBin, ['stop', '-t', String(OLD_STOP_GRACE_S), oldContainer], { timeoutMs: 15000 }).catch(() => {});
      await _spawnDocker(dockerBin, ['rm', '-f', oldContainer], { timeoutMs: 10000 }).catch(() => {});
    }

    const prevDeployId = app.current_deploy_id || null;
    // Load-bearing UPDATE: this is what flips the app from `building` →
    // `running` in the DB and — critically — is what cloud-hosted-app-
    // proxy.js reads to route incoming HTTPS requests to the container.
    // If this write silently no-ops (which _safeRun does on ANY SQL error
    // — schema drift, missing row, etc.), the container is up + healthy
    // but every public request returns the "Building" placeholder
    // indefinitely.
    //
    // We hit exactly this failure five times this session — each time a
    // column the runner wrote to was missing from migrate.js (worker_id,
    // build_started_at, build_finished_at, error_code, last_deployed_at),
    // and each time _safeRun's silent swallow hid the failure until an
    // engineer read the SQL by hand. Wrap this specific hot-path write
    // in a fail-loud check that rolls back the container and marks the
    // deploy as failed if it doesn't affect exactly the one row we
    // targeted. The `_safeRun` swallow itself is documented as a
    // separate cleanup follow-on.
    const appUpdate = _safeRun(
      db,
      `UPDATE hosted_apps
         SET status='running', current_deploy_id=?, container_id=?, port=?,
             restart_count=0, restart_window_start=NULL, last_deployed_at=?
       WHERE id=?`,
      deployId, newContainer, port, nowIso(), appId
    );
    if (!appUpdate || appUpdate.changes !== 1) {
      // Roll back: stop + rm the new container so its port is freed and
      // ops don't have an orphan container the DB doesn't know about.
      // We deliberately do NOT try to restore the old container — it was
      // already stopped above (line ~467), and re-starting a stopped
      // container in this rare failure path adds risk without much value.
      // The next queued deploy for this app will provision a fresh
      // container from scratch.
      await _spawnDocker(dockerBin, ['stop', '-t', '1', newContainer], { timeoutMs: 10000 }).catch(() => {});
      await _spawnDocker(dockerBin, ['rm', '-f', newContainer], { timeoutMs: 10000 }).catch(() => {});
      const affected = appUpdate ? String(appUpdate.changes) : 'null';
      const msg = `hosted_apps status='running' UPDATE affected ${affected} rows (expected 1) ` +
        `for app_id=${appId}. Most likely schema drift — check migrate.js for a column ` +
        `referenced in the UPDATE that's missing from hosted_apps. Container was stopped + removed.`;
      _failDeploy(deployId, 'app_status_update_failed', msg);
      try { console.error(`[cloud-hosted-app-runner] deploy ${deployId} rolled back: ${msg}`); } catch (_) {}
      _emitEvent(db, appId, 'deploy_failed', 'app_status_update_failed', { deploy_id: deployId, affected });
      return;
    }
    _safeRun(
      db,
      `UPDATE hosted_app_deploys SET status='running', build_finished_at=? WHERE id=?`,
      nowIso(), deployId
    );
    if (prevDeployId && prevDeployId !== deployId) {
      _safeRun(
        db,
        `UPDATE hosted_app_deploys SET status='superseded' WHERE id=? AND status='running'`,
        prevDeployId
      );
    }
    _emitEvent(db, appId, 'deploy', `deploy ${shortId(deployId)} running on :${port}`, {
      deploy_id: deployId, port, container_id: newContainer, image: imageTag,
    });
  }

  function _failDeploy(deployId, code, message) {
    _safeRun(
      db,
      `UPDATE hosted_app_deploys
         SET status='failed', error_code=?, error=?, build_finished_at=?
       WHERE id=? AND status IN ('building','queued')`,
      code || 'unknown', (message || '').slice(0, 4000), nowIso(), deployId
    );
  }

  function _findCacheFromImage(appId, requirementsSha) {
    if (!requirementsSha) return null;
    const prev = _safeGet(
      db,
      `SELECT id FROM hosted_app_deploys
        WHERE app_id=? AND requirements_sha=? AND status IN ('running','superseded')
        ORDER BY build_finished_at DESC LIMIT 1`,
      appId, requirementsSha
    );
    return prev ? `hosted-app:${appId}-${prev.id}` : null;
  }

  function _mem(app) {
    const m = Number(app && app.memory_mb);
    return Number.isFinite(m) && m > 0 ? Math.floor(m) : 256;
  }
  function _cpu(app) {
    const c = Number(app && app.cpu_shares);
    return Number.isFinite(c) && c > 0 ? Math.floor(c) : 512;
  }

  function _buildEnvMap(app, port) {
    const env = {
      PORT: '8080',
      HEALTHCHECK_PATH: app.healthcheck_path || '/',
      LINGCODE_BACKEND_ID: app.backend_id || '',
      LINGCODE_APP_ID: app.id,
      PYTHONUNBUFFERED: '1',
    };
    if (process.env.LINGCODE_DB_URL_TEMPLATE) {
      env.LINGCODE_DB_URL = process.env.LINGCODE_DB_URL_TEMPLATE.replace('{backend}', app.backend_id || '');
    }
    // Extra declared env-vars pinned on the app row (JSON).
    if (app.env_json) {
      try {
        const je = JSON.parse(app.env_json);
        for (const [k, v] of Object.entries(je)) if (!(k in env)) env[k] = String(v);
      } catch (_) {}
    }
    return env;
  }

  function _formatEnvFile(map) {
    return Object.entries(map)
      .map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`)
      .join('\n') + '\n';
  }

  async function _waitForHealthy(container) {
    const deadline = nowMs() + HEALTH_MAX_MS;
    while (nowMs() < deadline) {
      const r = await _spawnDocker(dockerBin, [
        'inspect', "--format={{.State.Health.Status}}", container,
      ], { timeoutMs: 5000 });
      const status = (r.out || '').trim();
      if (status === 'healthy') return true;
      // If the container is gone or errored, no point polling further.
      if (r.code !== 0 && (r.err || '').toLowerCase().includes('no such')) return false;
      await _sleep(HEALTH_POLL_MS);
    }
    return false;
  }

  // ── restart-watchdog (30 s) ────────────────────────────────────────────────

  async function _restartWatchTick() {
    if (stopping) return;
    const rows = _safeAll(db,
      `SELECT id, container_id, subdomain, restart_count, restart_window_start,
              _last_docker_restart_cumulative AS _lastCumulative
         FROM hosted_apps
        WHERE status='running' AND container_id IS NOT NULL`
    );
    for (const row of rows) {
      const r = await _spawnDocker(dockerBin, [
        'inspect', "--format={{.RestartCount}}", row.container_id,
      ], { timeoutMs: 5000 });
      if (r.code !== 0) continue;
      const dc = parseInt((r.out || '').trim(), 10);
      if (!Number.isFinite(dc)) continue;

      const t = computeRestartTransition(row, dc, nowMs());
      _safeRun(db,
        `UPDATE hosted_apps
            SET restart_count=?, restart_window_start=?, _last_docker_restart_cumulative=?
          WHERE id=?`,
        t.newCount, t.newWindowStart, t.newLastCumulative, row.id
      );
      if (t.shouldPromoteCrashed) {
        await _spawnDocker(dockerBin, ['stop', '-t', '1', row.container_id], { timeoutMs: 10000 }).catch(() => {});
        _safeRun(db,
          `UPDATE hosted_apps SET status='crashed' WHERE id=?`, row.id
        );
        try { await caddyClient.deleteRoute({ subdomain: row.subdomain }); } catch (_) {}
        _emitEvent(db, row.id, 'crashed', `restart-loop breaker tripped (${t.newCount} restarts)`, {
          restart_count: t.newCount,
        });
      }
    }
  }

  // ── metering sweeper (5 min) ───────────────────────────────────────────────

  async function _meterTick() {
    if (stopping) return;
    const hour = new Date().toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
    const running = _safeAll(db,
      `SELECT id, backend_id, container_id FROM hosted_apps
        WHERE status='running' AND container_id IS NOT NULL`
    );

    // 1. Add uptime for each running app.
    for (const app of running) {
      _safeRun(db,
        `INSERT INTO hosted_app_uptime (app_id, backend_id, hour_bucket, uptime_seconds, egress_bytes)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(app_id, hour_bucket) DO UPDATE SET uptime_seconds = uptime_seconds + ?`,
        app.id, app.backend_id, hour, METER_TICK_S, METER_TICK_S
      );
    }

    // 2. Egress: docker stats --no-stream one-shot, parse per-container NetIO.
    const stats = await _spawnDocker(dockerBin, [
      'stats', '--no-stream', '--format', '{{.Container}} {{.NetIO}}',
    ], { timeoutMs: 15000 });
    if (stats.code === 0 && stats.out) {
      const lines = stats.out.split('\n').filter(Boolean);
      const byName = new Map();
      for (const app of running) byName.set(app.container_id, app);
      for (const line of lines) {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx <= 0) continue;
        const cid = line.slice(0, spaceIdx).trim();
        const rest = line.slice(spaceIdx + 1).trim();
        // The `docker stats` `.Container` field is the container NAME by
        // default; match against container_id which we store as the name too.
        const app = byName.get(cid);
        if (!app) continue;
        const { in: netIn, out: netOut } = parseNetIO(rest);
        const total = (netIn || 0) + (netOut || 0);
        // Compute delta vs the last cumulative we recorded (also on hosted_apps).
        const prevRow = _safeGet(db,
          `SELECT _last_egress_cumulative AS c FROM hosted_apps WHERE id=?`, app.id
        );
        const prevC = Number(prevRow && prevRow.c) || 0;
        let delta = total - prevC;
        if (delta < 0) delta = total; // container restarted; reset baseline
        _safeRun(db,
          `UPDATE hosted_apps SET _last_egress_cumulative=? WHERE id=?`, total, app.id
        );
        if (delta > 0) {
          _safeRun(db,
            `INSERT INTO hosted_app_uptime (app_id, backend_id, hour_bucket, uptime_seconds, egress_bytes)
             VALUES (?, ?, ?, 0, ?)
             ON CONFLICT(app_id, hour_bucket) DO UPDATE SET egress_bytes = egress_bytes + ?`,
            app.id, app.backend_id, hour, delta, delta
          );
        }
      }
    }

    // 3. Roll buckets older than 24 h into backend_usage.
    const cutoff = new Date(nowMs() - BUCKET_TTL_MS).toISOString().slice(0, 13);
    const stale = _safeAll(db,
      `SELECT id, app_id, backend_id, hour_bucket, uptime_seconds, egress_bytes
         FROM hosted_app_uptime
        WHERE hour_bucket < ?`,
      cutoff
    );
    for (const s of stale) {
      const day = (s.hour_bucket || '').slice(0, 10);
      _safeRun(db,
        `INSERT INTO backend_usage (backend_id, day, app_uptime_seconds, app_egress_bytes)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(backend_id, day) DO UPDATE SET
           app_uptime_seconds = app_uptime_seconds + excluded.app_uptime_seconds,
           app_egress_bytes   = app_egress_bytes   + excluded.app_egress_bytes`,
        s.backend_id, day, s.uptime_seconds || 0, s.egress_bytes || 0
      );
      _safeRun(db, `DELETE FROM hosted_app_uptime WHERE id=?`, s.id);
    }

    // 4. Quota check per backend (monthly uptime).
    await _enforceMonthlyQuotas();
  }

  async function _enforceMonthlyQuotas() {
    // Sum this month's app_uptime_seconds per backend.
    const monthPrefix = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
    const buckets = _safeAll(db,
      `SELECT backend_id, SUM(uptime_seconds) AS s
         FROM hosted_app_uptime
        WHERE hour_bucket LIKE ?
        GROUP BY backend_id`,
      monthPrefix + '%'
    );
    const rolled = _safeAll(db,
      `SELECT backend_id, SUM(app_uptime_seconds) AS s
         FROM backend_usage
        WHERE day LIKE ?
        GROUP BY backend_id`,
      monthPrefix + '%'
    );
    const totals = new Map();
    for (const r of buckets) totals.set(r.backend_id, (totals.get(r.backend_id) || 0) + (r.s || 0));
    for (const r of rolled)  totals.set(r.backend_id, (totals.get(r.backend_id) || 0) + (r.s || 0));

    for (const [backendId, secs] of totals.entries()) {
      const tierRow = _safeGet(db, `SELECT tier FROM backends WHERE id=?`, backendId);
      const tier = (tierRow && tierRow.tier) || 'free';
      const cap = _hoursCap(tier);
      if (cap <= 0) continue;
      if (secs > cap * 3600) {
        const apps = _safeAll(db,
          `SELECT id FROM hosted_apps WHERE backend_id=? AND status='running'`,
          backendId
        );
        for (const a of apps) {
          await _pauseInternal(a.id, 'quota_pause', `monthly uptime ${Math.round(secs / 3600)}h > ${cap}h`);
        }
      }
    }
  }

  function _hoursCap(tier) {
    if (limitsMod && typeof limitsMod.limitsForTier === 'function') {
      try {
        const v = limitsMod.limitsForTier(tier).maxAppUptimeHrsPerMonth;
        return Number.isFinite(v) ? v : 0;
      } catch (_) {}
    }
    return 0;
  }

  // ── lifecycle: pause / resume / restart / delete ───────────────────────────

  async function _pauseInternal(appId, kind, message) {
    const app = _safeGet(db, `SELECT * FROM hosted_apps WHERE id=?`, appId);
    if (!app) return;
    if (app.status === 'paused' || app.status === 'deleted') return;
    if (app.container_id) {
      await _spawnDocker(dockerBin, ['stop', '-t', String(OLD_STOP_GRACE_S), app.container_id], { timeoutMs: 15000 }).catch(() => {});
    }
    try { await caddyClient.deleteRoute({ subdomain: app.subdomain }); } catch (_) {}
    _safeRun(db, `UPDATE hosted_apps SET status='paused' WHERE id=?`, appId);
    _emitEvent(db, appId, kind || 'pause', message || 'paused', null);
  }

  async function pauseApp({ appId } = {}) {
    if (!appId) throw new Error('appId required');
    await _pauseInternal(appId, 'pause', 'paused by user');
    return { ok: true };
  }

  async function resumeApp({ appId } = {}) {
    if (!appId) throw new Error('appId required');
    const app = _safeGet(db, `SELECT * FROM hosted_apps WHERE id=?`, appId);
    if (!app) throw new Error('app not found');
    if (app.status === 'deleted') throw new Error('app is deleted');
    if (app.status === 'running') return { ok: true, alreadyRunning: true };
    if (!app.container_id) {
      // Nothing to start — the caller should redeploy.
      return { ok: false, reason: 'no container; redeploy required' };
    }
    await _spawnDocker(dockerBin, ['start', app.container_id], { timeoutMs: 20000 }).catch(() => {});
    if (app.port) {
      try { await caddyClient.upsertRoute({ subdomain: app.subdomain, port: app.port }); } catch (_) {}
    }
    _safeRun(db,
      `UPDATE hosted_apps SET status='running', restart_count=0, restart_window_start=NULL WHERE id=?`,
      appId
    );
    _emitEvent(db, appId, 'resume', 'resumed by user', null);
    return { ok: true };
  }

  async function restartApp({ appId } = {}) {
    if (!appId) throw new Error('appId required');
    const app = _safeGet(db, `SELECT * FROM hosted_apps WHERE id=?`, appId);
    if (!app) throw new Error('app not found');
    if (!app.container_id) return { ok: false, reason: 'no container' };
    await _spawnDocker(dockerBin, ['restart', app.container_id], { timeoutMs: 30000 }).catch(() => {});
    _safeRun(db,
      `UPDATE hosted_apps SET restart_count=0, restart_window_start=NULL WHERE id=?`,
      appId
    );
    _emitEvent(db, appId, 'restart', 'restarted by user', null);
    return { ok: true };
  }

  async function deleteApp({ appId } = {}) {
    if (!appId) throw new Error('appId required');
    const app = _safeGet(db, `SELECT * FROM hosted_apps WHERE id=?`, appId);
    if (!app) return { ok: true, alreadyGone: true };
    if (app.container_id) {
      await _spawnDocker(dockerBin, ['stop', '-t', '1', app.container_id], { timeoutMs: 10000 }).catch(() => {});
      await _spawnDocker(dockerBin, ['rm', '-f', app.container_id], { timeoutMs: 10000 }).catch(() => {});
    }
    try { await caddyClient.deleteRoute({ subdomain: app.subdomain }); } catch (_) {}
    // Remove env file (contains secrets).
    try { fs.unlinkSync(path.join(envDir, `${appId}.env`)); } catch (_) {}
    _safeRun(db,
      `UPDATE hosted_apps SET status='deleted', container_id=NULL, port=NULL, current_deploy_id=NULL WHERE id=?`,
      appId
    );
    _emitEvent(db, appId, 'delete', 'deleted by user', null);
    return { ok: true };
  }

  async function enqueueDeploy({ appId, userId, sourceSha256, requirementsSha } = {}) {
    if (!appId) throw new Error('appId required');
    const deployId = _uuid();
    _safeRun(db,
      `INSERT INTO hosted_app_deploys
         (id, app_id, user_id, status, source_sha256, requirements_sha, started_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
      deployId, appId, userId || null, sourceSha256 || null, requirementsSha || null, nowIso()
    );
    _emitEvent(db, appId, 'deploy_queued', `deploy ${shortId(deployId)} queued`, { deploy_id: deployId });
    return { deployId };
  }

  // ── logs + events tail ────────────────────────────────────────────────────

  async function tailLogs({ appId, tailLines = 200, follow = false } = {}) {
    if (!appId) throw new Error('appId required');
    const app = _safeGet(db, `SELECT container_id FROM hosted_apps WHERE id=?`, appId);
    if (!app || !app.container_id) {
      // Return an already-ended stream so the caller can pipe uniformly.
      const s = new Readable({ read() { this.push(null); } });
      return s;
    }
    const args = ['logs', '--tail', String(Math.max(1, Number(tailLines) || 200))];
    if (follow) args.push('-f');
    args.push(app.container_id);
    const p = spawn(dockerBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Merge stderr into stdout for the caller's convenience; frame as SSE data:
    const readable = new Readable({ read() {} });
    const write = (buf) => {
      const text = buf.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue;
        readable.push('data: ' + line + '\n\n');
      }
    };
    p.stdout.on('data', write);
    p.stderr.on('data', write);
    p.on('close', () => { readable.push(null); });
    p.on('error', (e) => { readable.push('data: [runner-error] ' + String(e.message || e) + '\n\n'); readable.push(null); });
    // Ensure the child dies if the consumer disconnects.
    readable.on('close', () => { try { p.kill('SIGTERM'); } catch (_) {} });
    return readable;
  }

  async function listEvents({ appId, sinceId = 0, limit = 200 } = {}) {
    if (!appId) throw new Error('appId required');
    const cap = Math.min(1000, Math.max(1, Number(limit) || 200));
    return _safeAll(db,
      `SELECT id, app_id, kind, message, extra_json, created_at
         FROM hosted_app_events
        WHERE app_id=? AND id > ?
        ORDER BY id ASC LIMIT ?`,
      appId, Number(sinceId) || 0, cap
    );
  }

  // ── poll loop ─────────────────────────────────────────────────────────────

  async function _pollTick() {
    if (stopping || claimingBusy) return;
    claimingBusy = true;
    try {
      // One at a time: this runner's scope is small (single-node hosted-apps
      // droplet). Multiple runners can share the queue safely via the atomic
      // claim UPDATE.
      const claimed = _claimQueued();
      if (claimed) {
        // Wall-clock ceiling for the ENTIRE _runDeploy call, including any
        // hung await inside it. Historical bug (2026-08-13): a stalled
        // _spawnDocker promise would never settle, so `await _runDeploy(...)`
        // never returned, the outer `finally` never ran, `claimingBusy`
        // stayed true, and EVERY subsequent poll returned early at the top
        // of this function — the runner appeared "alive" (poll timer still
        // firing) but couldn't claim any new deploys. From the outside this
        // looked identical to a dead runner: no logs, no docker subprocess,
        // no deploy state change. Race the deploy against a hard timeout
        // so a hung await can never leak the mutex.
        //
        // On timeout we also try to fail the deploy row so observability
        // (SQL) and reality (mutex freed) agree — best-effort courtesy;
        // freeing the mutex is the load-bearing guarantee.
        //
        // Note: we cannot cancel the still-running _runDeploy promise —
        // Node has no primitive for that. The leaked promise resolves or
        // rejects into the void. The swallow-catch on the raw promise
        // prevents an unhandledRejection log on eventual settlement.
        const raw = _runDeploy(claimed);
        raw.catch(() => {}); // swallow eventual settlement of the leaked promise
        let timeoutHandle = null;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            const e = new Error(`runner tick exceeded ${maxDeployTotalMs}ms wall clock`);
            e.code = 'runner_timeout';
            reject(e);
          }, maxDeployTotalMs);
          if (timeoutHandle.unref) timeoutHandle.unref();
        });
        try {
          await Promise.race([raw, timeoutPromise]);
        } catch (e) {
          const code = (e && e.code === 'runner_timeout') ? 'runner_timeout' : 'runner_exception';
          try { _failDeploy(claimed.id, code, String((e && e.message) || e)); } catch (_) {}
          try { console.error(`[cloud-hosted-app-runner] deploy ${claimed.id} aborted (${code}): ${(e && e.message) || e}`); } catch (_) {}
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      }
    } finally {
      claimingBusy = false;
    }
  }

  function start() {
    if (pollHandle) return; // idempotent
    stopping = false;
    pollHandle = setInterval(() => { _pollTick().catch(() => {}); }, POLL_MS);
    watchHandle = setInterval(() => { _restartWatchTick().catch(() => {}); }, RESTART_WATCH_MS);
    meterHandle = setInterval(() => { _meterTick().catch(() => {}); }, METER_MS);
    if (pollHandle.unref)  pollHandle.unref();
    if (watchHandle.unref) watchHandle.unref();
    if (meterHandle.unref) meterHandle.unref();
    try { console.log(`[cloud-hosted-app-runner] active worker ${WORKER_ID} (poll ${POLL_MS}ms)`); } catch (_) {}
  }

  function stop() {
    stopping = true;
    if (pollHandle)  { clearInterval(pollHandle);  pollHandle  = null; }
    if (watchHandle) { clearInterval(watchHandle); watchHandle = null; }
    if (meterHandle) { clearInterval(meterHandle); meterHandle = null; }
  }

  return {
    start, stop,
    enqueueDeploy,
    pauseApp, resumeApp, restartApp, deleteApp,
    tailLogs, listEvents,
    // Exposed for tests / diagnostics; not for external callers.
    _pollTick, _restartWatchTick, _meterTick, _runDeploy, _claimQueued,
  };
}

// ── misc ─────────────────────────────────────────────────────────────────────

function _uuid() {
  // crypto.randomUUID is stable since Node 14.17.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  createHostedAppRunner,
  // Named helper exports for direct unit testing:
  allocatePort,
  bakeStartCmdIntoDockerfile,
  parseNetIO,
  computeRestartTransition,
  // Constants callers occasionally need:
  PORT_MIN,
  PORT_MAX,
  RESTART_LIMIT,
  RESTART_WINDOW_MS,
  BUILD_TIMEOUT_MS,
  HEALTH_MAX_MS,
  WORKER_ID,
};
