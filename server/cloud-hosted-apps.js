'use strict';

// cloud-hosted-apps.js — owner-only CRUD + lifecycle for the LingCode Cloud
// HOSTED-APPS TIER (long-running Python HTTP apps behind Caddy at
// <slug>.apps.lingcode.dev). Sibling of cloud-functions-routes.js (serverless
// Deno) and cloud-compute.js (batch containers) — same auth/ownership shape,
// same account_backends gate, same {ok,data|error,message} contract.
//
// This module is the CONTROL PLANE ONLY: it owns HTTP routes, session
// auth, ownership + quota checks, tar-source intake, deploy-queue writes,
// and event-buffer/log SSE reads. It never spawns docker or touches Caddy
// directly — every state mutation is delegated to `runner` (the object
// returned by createHostedAppRunner()), which owns the docker/caddy
// substrate. Keeping that boundary sharp means the routes stay unit-testable
// with a stubbed runner (see cloud-hosted-apps.test.js) and the runner stays
// deployable independently.
//
// Table shapes come from migrate.js:migrateHostedAppsTables:
//   hosted_apps           — one row per app
//   hosted_app_deploys    — build queue + history (status: queued|building|running|failed|superseded)
//   hosted_app_events     — ring-buffered lifecycle events
//   hosted_app_uptime     — 5-min uptime/egress buckets (owned by the runner sweeper)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const tar = require('tar-stream');
const { Readable } = require('stream');
const { getUserFromRequest } = require('./auth-helpers');
const dataPlane = require('./cloud-data-plane');
const { limitsForTier } = require('./cloud-limits');
const buildpack = require('./cloud-hosted-app-buildpack');

// Slug regex — same posture as cloud-functions-routes.js (lowercase letter
// start, then [a-z0-9-]{0,40}). Doubles as the DNS-label + docker-tag alphabet
// so we never have to escape it downstream.
const SLUG_RE = /^[a-z][a-z0-9-]{0,40}$/;

// Where extracted source lives on disk. One dir per (app, deploy) so the runner
// can `docker build` straight against it, and so a mid-upload crash leaves at
// worst one orphaned subdir instead of corrupting an in-flight build.
const SOURCE_ROOT = process.env.HOSTED_APP_SOURCE_DIR || '/var/lib/lingcode-hosted-apps';

// Upload caps. Compressed cap is the "cheap early rejection" — we stop reading
// the socket once we hit it. Uncompressed cap is the buildpack contract and
// gates the extractor before it writes anything to disk.
const MAX_COMPRESSED_BYTES = 50 * 1024 * 1024;   // 50 MB gzipped
const MAX_UNCOMPRESSED_BYTES = buildpack.MAX_SOURCE_BYTES; // 100 MB from buildpack

// Events endpoint cap. Anything higher and a chatty app pins the console.
const MAX_EVENTS_PER_PAGE = 500;

function nowMs() { return Date.now(); }
function genId(prefix) { return `${prefix}-${crypto.randomBytes(12).toString('hex')}`; }

// Emit a lifecycle event row. Never throws — the ring buffer is best-effort
// telemetry, not the source of truth for state (that's hosted_apps.status).
function emitEvent(db, appId, kind, message) {
  try {
    db.prepare('INSERT INTO hosted_app_events (app_id, ts, kind, message) VALUES (?,?,?,?)')
      .run(appId, nowMs(), String(kind || ''), message == null ? null : String(message).slice(0, 2000));
  } catch (_) { /* best-effort */ }
}

// Derive a per-droplet unique subdomain from the human name. Format:
//   <name>-<first 8 of app id>
// The suffix guarantees uniqueness across ALL backends without depending on
// name collisions (two users can both name an app "hello" and both get a
// distinct subdomain). The DB's UNIQUE(subdomain) is the actual serialization
// point; this function's job is to propose a good candidate.
function subdomainFor(name, appId) {
  const suffix = String(appId || '').replace(/^[a-z]+-/, '').slice(0, 8);
  return suffix ? `${name}-${suffix}` : name;
}

// Ownership gate — mirrors cloud-functions-routes.js:ownerBackend exactly.
// Returns { user, row } or writes the response + returns null.
function ownerBackendFactory(db) {
  return function ownerBackend(req, res) {
    if (!dataPlane.isConfigured()) { res.status(503).json({ ok: false, error: 'cloud_not_configured' }); return null; }
    const user = getUserFromRequest(db, req);
    if (!user) { res.status(401).json({ ok: false, error: 'unauthorized' }); return null; }
    const backendId = String(req.params.backendId || '');
    const row = db.prepare('SELECT * FROM account_backends WHERE id = ? AND user_id = ?').get(backendId, user.id);
    if (!row) { res.status(404).json({ ok: false, error: 'backend_not_found' }); return null; }
    return { user, row };
  };
}

// Resolve an app row scoped to a backend. Returns null + writes 404 on miss.
// Callers already passed ownerBackend, so app-not-found here means either
// wrong id or the app belongs to a *different* backend of the same owner —
// both are surfaced as hosted_app_not_found (never 403), so we don't leak
// which backend a given app id belongs to.
function findApp(db, backendId, appId, res) {
  const row = db.prepare('SELECT * FROM hosted_apps WHERE id = ? AND backend_id = ?').get(String(appId || ''), backendId);
  if (!row) { res.status(404).json({ ok: false, error: 'hosted_app_not_found' }); return null; }
  return row;
}

// ── Source-tarball intake ─────────────────────────────────────────────────────
// Read the raw request body up to MAX_COMPRESSED_BYTES, THEN gunzip in one shot
// and verify the uncompressed size before invoking the tar parser. The two-step
// (buffer → gunzip → tar-parse) is deliberate: we need the exact source_sha256
// of the compressed tarball for the deploy row (docker-build cache key hash),
// and we need to bound memory before spending a decompress cycle on hostile
// input. Stream-through would save one buffer copy but couldn't produce the
// sha or fail-fast on compression bombs.
function readCompressedBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; fn(arg); };
    req.on('data', (c) => {
      if (done) return;
      total += c.length;
      if (total > MAX_COMPRESSED_BYTES) {
        finish(reject, Object.assign(new Error('compressed payload exceeds cap'), {
          status: 413, code: 'hosted_app_invalid_source',
          detail: `max ${MAX_COMPRESSED_BYTES} bytes gzipped`,
        }));
        try { req.destroy(); } catch (_) {}
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks, total)));
    req.on('error', (e) => finish(reject, Object.assign(new Error('upload aborted'), {
      status: 400, code: 'invalid_request', detail: String(e && e.message || e),
    })));
  });
}

// Walk the gunzipped tar buffer via tar-stream. Returns {files, entries} where
// files[] mirrors buildpack.validateSourceTree's contract and `entries` is a
// [{relPath, buf}] list the caller writes to disk. Rejects with a structured
// error on traversal-y paths, per-file overflow, aggregate overflow, count
// overflow, or malformed archives.
function parseTarball(uncompressed) {
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    const files = [];
    const entries = [];
    let total = 0;
    let failed = null;
    const fail = (code, message) => { if (!failed) failed = { code, message }; };

    extract.on('entry', (header, stream, next) => {
      // Directory + symlink + longlink entries: drain and skip. The buildpack
      // only cares about regular files.
      if (failed || header.type !== 'file') { stream.on('end', next); stream.resume(); return; }
      // Normalize: reject absolute paths, `..` traversal, backslashes, and
      // any leading `./` noise. We keep the tar-stream default of forward
      // slashes so the buildpack's top-level-file checks (has app.py etc.)
      // work unmodified.
      let rel = String(header.name || '').replace(/\\/g, '/').replace(/^\.\//, '');
      if (!rel || rel.startsWith('/') || rel.includes('..') || rel.includes('\0')) {
        fail('hosted_app_invalid_source', `illegal path in archive: ${header.name}`);
        stream.on('end', next); stream.resume(); return;
      }
      // Also reject anything the extractor would resolve outside the deploy
      // root. path.normalize + posix semantics keeps us portable across the
      // dev-mac + linux runner.
      const norm = path.posix.normalize(rel);
      if (norm.startsWith('..') || path.posix.isAbsolute(norm)) {
        fail('hosted_app_invalid_source', `illegal normalized path: ${header.name}`);
        stream.on('end', next); stream.resume(); return;
      }
      rel = norm;

      const bufChunks = [];
      let len = 0;
      stream.on('data', (c) => {
        if (failed) return;
        len += c.length;
        if (len > buildpack.MAX_FILE_BYTES) {
          fail('hosted_app_invalid_source', `file ${rel} exceeds per-file cap of ${buildpack.MAX_FILE_BYTES} bytes`);
          return;
        }
        if (total + len > MAX_UNCOMPRESSED_BYTES) {
          fail('hosted_app_invalid_source', `source tree exceeds ${MAX_UNCOMPRESSED_BYTES} bytes uncompressed`);
          return;
        }
        bufChunks.push(c);
      });
      stream.on('error', () => { fail('hosted_app_invalid_source', `malformed archive entry: ${rel}`); next(); });
      stream.on('end', () => {
        if (failed) return next();
        total += len;
        files.push({ path: rel, size: len });
        entries.push({ relPath: rel, buf: Buffer.concat(bufChunks, len) });
        if (files.length > buildpack.MAX_SOURCE_FILES) {
          fail('hosted_app_invalid_source', `source tree exceeds ${buildpack.MAX_SOURCE_FILES} files`);
        }
        next();
      });
    });

    extract.on('finish', () => {
      if (failed) return reject(Object.assign(new Error(failed.message), { status: 422, code: failed.code }));
      resolve({ files, entries, totalBytes: total });
    });
    extract.on('error', () => reject(Object.assign(new Error('malformed tar archive'), {
      status: 422, code: 'hosted_app_invalid_source',
    })));

    // Feed the buffered bytes into tar-stream via a one-shot Readable. This
    // preserves the stream contract without re-piping through gunzip (the
    // caller already did that in-memory for size + sha).
    const feeder = Readable.from(uncompressed);
    feeder.on('error', () => fail('hosted_app_invalid_source', 'tar feed aborted'));
    feeder.pipe(extract);
  });
}

// Given the parsed file list, produce the top-level-file booleans the
// buildpack.validateSourceTree contract expects. Only inspects DEPTH-1
// (top-level) files; a nested app/app.py doesn't count as a "top-level app.py"
// per the buildpack's contract.
function topLevelFlags(files) {
  const top = new Set();
  for (const f of files) {
    const rel = f.path;
    if (!rel.includes('/')) top.add(rel);
  }
  return {
    hasRequirements: top.has('requirements.txt'),
    hasPyproject: top.has('pyproject.toml'),
    hasPy: [...top].some((n) => n.endsWith('.py')),
    hasAppPy: top.has('app.py'),
    hasMainPy: top.has('main.py'),
    hasProcfile: top.has('Procfile'),
  };
}

// Write the extracted entries to <SOURCE_ROOT>/<appId>/<deployId>/source/
// sync — the routes handler awaits before returning, so an EIO surfaces as a
// 500 to the caller instead of silently orphaning a queued deploy row.
function writeExtractedToDisk(appId, deployId, entries) {
  const dest = path.join(SOURCE_ROOT, appId, deployId, 'source');
  fs.mkdirSync(dest, { recursive: true });
  for (const e of entries) {
    const full = path.join(dest, e.relPath);
    // Defense-in-depth: after normalization on parse, still verify the joined
    // path doesn't escape the deploy dir. This catches any exotic prefix the
    // parse-time check might have missed (e.g. on windows dev boxes).
    const rel = path.relative(dest, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw Object.assign(new Error(`illegal write path: ${e.relPath}`), { status: 422, code: 'hosted_app_invalid_source' });
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, e.buf);
  }
  return dest;
}

// ── Route registration ────────────────────────────────────────────────────────
function registerHostedAppRoutes(app, db, runner) {
  const ownerBackend = ownerBackendFactory(db);
  const base = '/api/cloud/account/backends/:backendId/apps';

  // POST / — create app row. No source, no deploy yet; those come via
  // PUT /:id/source. Enforces the tier's maxHostedApps cap and rejects on
  // slug collisions within the backend + globally (via the subdomain UNIQUE).
  app.post(base, (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const body = req.body || {};
    const name = String(body.name || '').trim().toLowerCase();
    if (!SLUG_RE.test(name) || name.length > 40) {
      return res.status(400).json({ ok: false, error: 'invalid_slug', message: 'name must be lowercase letters/digits/dashes, starting with a letter, ≤40 chars' });
    }
    const runtimeVersion = String(body.runtimeVersion || '3.12');
    if (!buildpack.SUPPORTED_RUNTIME_VERSIONS.includes(runtimeVersion)) {
      return res.status(400).json({ ok: false, error: 'invalid_request', message: `runtimeVersion must be one of: ${buildpack.SUPPORTED_RUNTIME_VERSIONS.join(', ')}` });
    }
    const healthcheckPath = String(body.healthcheckPath || '/');
    if (!healthcheckPath.startsWith('/') || healthcheckPath.length > 200) {
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'healthcheckPath must start with "/" and be ≤200 chars' });
    }

    // Per-tier cap. Free tier's maxHostedApps=0 → every create returns 403.
    const tier = ctx.row.tier || 'free';
    const lim = limitsForTier(tier);
    const cap = Number(lim.maxHostedApps || 0);
    const count = db.prepare("SELECT COUNT(*) AS n FROM hosted_apps WHERE backend_id = ? AND status != 'deleted'").get(ctx.row.id).n;
    if (count >= cap) {
      return res.status(403).json({
        ok: false, error: 'hosted_app_quota_exceeded',
        message: `Tier ${tier} allows ${cap} hosted apps; you have ${count}`,
      });
    }

    // Name collision inside this backend (matches UNIQUE(backend_id, name)).
    const existing = db.prepare('SELECT id FROM hosted_apps WHERE backend_id = ? AND name = ?').get(ctx.row.id, name);
    if (existing) {
      return res.status(409).json({ ok: false, error: 'hosted_app_subdomain_taken', message: `an app named "${name}" already exists on this backend` });
    }

    const id = genId('happ');
    const subdomain = subdomainFor(name, id);
    // Sanity: no reserved subdomain, and the droplet-wide UNIQUE will catch
    // any race we didn't. This tries-on-conflict without a transaction because
    // SQLite serializes writes; the UNIQUE trip surfaces as an insert error.
    const now = nowMs();
    const memMb = Math.min(Number(lim.maxAppMemoryMb) || 256, 512);
    const cpu = Math.min(Number(lim.maxAppCpuShares) || 512, 1024);
    try {
      db.prepare(`INSERT INTO hosted_apps
          (id, backend_id, user_id, name, subdomain, kind, status, procfile_web, runtime_version, healthcheck_path, memory_mb, cpu_shares, created_at, updated_at)
          VALUES (?,?,?,?,?, 'python-web', 'building', NULL, ?, ?, ?, ?, ?, ?)`)
        .run(id, ctx.row.id, ctx.user.id, name, subdomain, runtimeVersion, healthcheckPath, memMb, cpu, now, now);
    } catch (e) {
      if (String(e && e.message || '').includes('UNIQUE') && String(e.message).includes('subdomain')) {
        return res.status(409).json({ ok: false, error: 'hosted_app_subdomain_taken', message: 'subdomain already taken on this droplet' });
      }
      return res.status(500).json({ ok: false, error: 'invalid_request', message: String(e && e.message || e).slice(0, 500) });
    }

    emitEvent(db, id, 'created', `name=${name} subdomain=${subdomain} runtime=${runtimeVersion}`);
    res.json({ ok: true, data: { id, name, subdomain, status: 'building', runtimeVersion, healthcheckPath } });
  });

  // GET / — list apps on this backend. `status != 'deleted'` mirrors the
  // create-count filter so the console sees a consistent tally.
  app.get(base, (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const rows = db.prepare(`SELECT id, name, subdomain, status, runtime_version, healthcheck_path, port,
        current_deploy_id, memory_mb, cpu_shares, restart_count, created_at, updated_at, paused_at
        FROM hosted_apps WHERE backend_id = ? AND status != 'deleted' ORDER BY name`).all(ctx.row.id);
    const tier = ctx.row.tier || 'free';
    const lim = limitsForTier(tier);
    res.json({ ok: true, data: {
      apps: rows,
      quota: { used: rows.length, max: Number(lim.maxHostedApps || 0), tier },
    } });
  });

  // GET /:id — detail. Includes recent deploys + current-quota tally so the
  // web console can render the app page without a round-trip storm.
  app.get(`${base}/:id`, (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const row = findApp(db, ctx.row.id, req.params.id, res); if (!row) return;
    const deploys = db.prepare(`SELECT id, source_sha256, requirements_sha, image_tag, status, error, started_at, finished_at
        FROM hosted_app_deploys WHERE app_id = ? ORDER BY started_at DESC LIMIT 20`).all(row.id);
    const tier = ctx.row.tier || 'free';
    const lim = limitsForTier(tier);
    // Include the active-count quota so the UI can show "1 of 5 apps used".
    const activeCount = db.prepare("SELECT COUNT(*) AS n FROM hosted_apps WHERE backend_id = ? AND status != 'deleted'").get(ctx.row.id).n;
    res.json({ ok: true, data: {
      app: row,
      deploys,
      quota: { used: activeCount, max: Number(lim.maxHostedApps || 0), tier },
    } });
  });

  // PUT /:id/source — gzipped tarball upload. Bypasses express.json (default
  // 100 KB) by attaching NO body-parser middleware to this route. `express`
  // will pass the raw stream through to our handler.
  //
  // Contract: on success we (a) write extracted files to disk, (b) INSERT a
  // status='queued' hosted_app_deploys row (this is the deploy commit point —
  // POST /:id/deploy is idempotent against it), and (c) call
  // runner.enqueueDeploy so a live scheduler can pick it up instantly instead
  // of waiting for the next tick.
  app.put(`${base}/:id/source`, async (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const row = findApp(db, ctx.row.id, req.params.id, res); if (!row) return;
    if (row.status === 'deleted') return res.status(404).json({ ok: false, error: 'hosted_app_not_found' });

    let compressed;
    try { compressed = await readCompressedBody(req); }
    catch (e) { return res.status(e.status || 400).json({ ok: false, error: e.code || 'invalid_request', message: e.detail || String(e.message || e) }); }
    if (!compressed || compressed.length === 0) {
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'empty upload' });
    }

    // Gunzip sync — MAX_COMPRESSED already bounded the input to 50 MB, and
    // node's zlib.gunzipSync internally caps output at the runtime's
    // maxOutputLength (which we set explicitly here to catch a 100:1 bomb).
    let uncompressed;
    try {
      uncompressed = zlib.gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES + 1 });
    } catch (e) {
      return res.status(422).json({ ok: false, error: 'hosted_app_invalid_source', message: 'body is not valid gzip or exceeds uncompressed cap' });
    }
    if (uncompressed.length > MAX_UNCOMPRESSED_BYTES) {
      return res.status(422).json({ ok: false, error: 'hosted_app_invalid_source', message: `source exceeds ${MAX_UNCOMPRESSED_BYTES} bytes uncompressed` });
    }

    let parsed;
    try { parsed = await parseTarball(uncompressed); }
    catch (e) { return res.status(e.status || 422).json({ ok: false, error: e.code || 'hosted_app_invalid_source', message: String(e.message || e).slice(0, 500) }); }

    // Semantic validation via the buildpack's pure verdict. Aggregates ALL
    // errors so the UI can display every problem in one round-trip.
    const flags = topLevelFlags(parsed.files);
    const verdict = buildpack.validateSourceTree({
      files: parsed.files,
      hasRequirements: flags.hasRequirements,
      hasPyproject: flags.hasPyproject,
      hasPy: flags.hasPy,
    });
    if (!verdict.ok) {
      return res.status(422).json({ ok: false, error: 'hosted_app_invalid_source', message: verdict.errors.join('; '), errors: verdict.errors });
    }

    // Extract the Procfile web line so the runner doesn't have to re-parse
    // the tree at build time. Empty/null → runner falls back to app.py / main.py.
    let procfileWeb = null;
    if (flags.hasProcfile) {
      const pf = parsed.entries.find((e) => e.relPath === 'Procfile');
      if (pf) procfileWeb = buildpack.parseProcfileWebLine(pf.buf.toString('utf8'));
    }

    // Idempotency: if there's already a queued deploy for this app, replace
    // its source and reuse the same row. Multiple back-to-back PUTs (e.g. a
    // click-happy user or a retrying client) MUST NOT stack N deploy rows.
    const now = nowMs();
    const sha = crypto.createHash('sha256').update(compressed).digest('hex');
    let deployId;
    const existingQueued = db.prepare("SELECT id FROM hosted_app_deploys WHERE app_id = ? AND status = 'queued' ORDER BY started_at DESC LIMIT 1").get(row.id);
    if (existingQueued) {
      deployId = existingQueued.id;
      db.prepare('UPDATE hosted_app_deploys SET source_sha256 = ?, started_at = ? WHERE id = ?').run(sha, now, deployId);
    } else {
      deployId = genId('hdep');
      db.prepare(`INSERT INTO hosted_app_deploys (id, app_id, source_sha256, status, started_at, user_id) VALUES (?, ?, ?, 'queued', ?, ?)`)
        .run(deployId, row.id, sha, now, ctx.user.id);
    }

    // Write extraction AFTER the deploy row so the deployId directory name
    // is stable. On disk-write failure, mark the row failed and 500 — the
    // deploy row is otherwise a lie.
    let sourceDir;
    try { sourceDir = writeExtractedToDisk(row.id, deployId, parsed.entries); }
    catch (e) {
      db.prepare("UPDATE hosted_app_deploys SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
        .run(String(e && e.message || e).slice(0, 500), now, deployId);
      const status = e && e.status ? e.status : 500;
      const code = e && e.code ? e.code : 'invalid_request';
      return res.status(status).json({ ok: false, error: code, message: String(e && e.message || e).slice(0, 500) });
    }

    // Store the resolved procfile web line on the app row so the runner
    // (which builds the image) can inject it as the entrypoint without
    // re-walking the source dir.
    if (procfileWeb !== undefined) {
      db.prepare('UPDATE hosted_apps SET procfile_web = ?, updated_at = ? WHERE id = ?').run(procfileWeb, now, row.id);
    }

    emitEvent(db, row.id, 'source_uploaded', `deploy=${deployId} files=${parsed.files.length} bytes=${parsed.totalBytes}`);

    // Ping the runner so it dispatches this build now. The runner's own
    // polling loop would eventually pick it up; this is the low-latency path.
    // The runner MUST be idempotent against being pinged for a deploy it has
    // already claimed (it looks the deploy up by id and no-ops if not queued).
    if (runner && typeof runner.enqueueDeploy === 'function') {
      try { runner.enqueueDeploy({ appId: row.id, deployId, sourceDir }); }
      catch (_) { /* runner errors are transport-level; the queue row is the source of truth */ }
    }

    res.json({ ok: true, data: { deployId, filesCount: parsed.files.length, uncompressedBytes: parsed.totalBytes } });
  });

  // POST /:id/deploy — idempotent confirmation. Since PUT /source already
  // inserted a queued row, this is a no-op that either (a) surfaces the
  // existing queue row, or (b) 400s with 'invalid_request' if the user calls
  // deploy before any source was ever uploaded. This keeps ONE source of
  // truth for the deploy queue (the PUT /source handler).
  app.post(`${base}/:id/deploy`, (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const row = findApp(db, ctx.row.id, req.params.id, res); if (!row) return;
    const queued = db.prepare("SELECT id FROM hosted_app_deploys WHERE app_id = ? AND status = 'queued' ORDER BY started_at DESC LIMIT 1").get(row.id);
    if (queued) {
      // Nudge the runner (idempotent) and return the same id every call.
      if (runner && typeof runner.enqueueDeploy === 'function') {
        try { runner.enqueueDeploy({ appId: row.id, deployId: queued.id }); } catch (_) {}
      }
      return res.json({ ok: true, data: { deployId: queued.id, status: 'queued' } });
    }
    // Nothing queued. If there's a currently-building deploy, surface that.
    const building = db.prepare("SELECT id FROM hosted_app_deploys WHERE app_id = ? AND status = 'building' ORDER BY started_at DESC LIMIT 1").get(row.id);
    if (building) return res.json({ ok: true, data: { deployId: building.id, status: 'building' } });
    // Otherwise: nothing to deploy — the user needs to upload source first.
    return res.status(400).json({ ok: false, error: 'invalid_request', message: 'no source uploaded — PUT /:id/source first' });
  });

  // POST /:id/pause — docker stop + Caddy route delete via runner. The runner
  // is authoritative for the "paused" state transition; we only surface its
  // result. On success we bump paused_at + status locally.
  app.post(`${base}/:id/pause`, async (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const row = findApp(db, ctx.row.id, req.params.id, res); if (!row) return;
    if (row.status === 'deleted') return res.status(404).json({ ok: false, error: 'hosted_app_not_found' });
    if (row.status === 'paused') return res.json({ ok: true, data: { status: 'paused' } });
    try {
      if (runner && typeof runner.pauseApp === 'function') await runner.pauseApp({ appId: row.id });
      const now = nowMs();
      db.prepare("UPDATE hosted_apps SET status = 'paused', paused_at = ?, updated_at = ? WHERE id = ?").run(now, now, row.id);
      emitEvent(db, row.id, 'paused', 'owner-initiated');
      res.json({ ok: true, data: { status: 'paused' } });
    } catch (e) {
      const { status, code, message } = runnerError(e, 'hosted_app_paused');
      res.status(status).json({ ok: false, error: code, message });
    }
  });

  // POST /:id/resume — docker start + Caddy route upsert. Symmetrical to pause.
  app.post(`${base}/:id/resume`, async (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const row = findApp(db, ctx.row.id, req.params.id, res); if (!row) return;
    if (row.status === 'deleted') return res.status(404).json({ ok: false, error: 'hosted_app_not_found' });
    if (row.status === 'running' || row.status === 'building') return res.json({ ok: true, data: { status: row.status } });
    try {
      if (runner && typeof runner.resumeApp === 'function') await runner.resumeApp({ appId: row.id });
      const now = nowMs();
      db.prepare("UPDATE hosted_apps SET status = 'running', paused_at = NULL, updated_at = ? WHERE id = ?").run(now, row.id);
      emitEvent(db, row.id, 'resumed', 'owner-initiated');
      res.json({ ok: true, data: { status: 'running' } });
    } catch (e) {
      const { status, code, message } = runnerError(e, 'hosted_app_paused');
      res.status(status).json({ ok: false, error: code, message });
    }
  });

  // POST /:id/restart — docker restart + reset restart_count so the crash
  // debounce window starts fresh. The runner does the actual container work.
  app.post(`${base}/:id/restart`, async (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const row = findApp(db, ctx.row.id, req.params.id, res); if (!row) return;
    if (row.status === 'deleted') return res.status(404).json({ ok: false, error: 'hosted_app_not_found' });
    if (row.status === 'paused') return res.status(409).json({ ok: false, error: 'hosted_app_paused', message: 'app is paused; resume before restarting' });
    try {
      if (runner && typeof runner.restartApp === 'function') await runner.restartApp({ appId: row.id });
      const now = nowMs();
      db.prepare("UPDATE hosted_apps SET status = 'running', restart_count = 0, restart_window_start = NULL, updated_at = ? WHERE id = ?").run(now, row.id);
      emitEvent(db, row.id, 'restarted', 'owner-initiated');
      res.json({ ok: true, data: { status: 'running' } });
    } catch (e) {
      const { status, code, message } = runnerError(e, 'invalid_request');
      res.status(status).json({ ok: false, error: code, message });
    }
  });

  // DELETE /:id — stop container, drop image, delete rows. We drop children
  // (deploys/events/uptime) INSIDE the same SQLite transaction as the app row
  // so a mid-delete crash leaves nothing orphaned. The runner's deleteApp is
  // called BEFORE the DB delete so a runner failure can be surfaced without
  // stranding a container.
  app.delete(`${base}/:id`, async (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const row = findApp(db, ctx.row.id, req.params.id, res); if (!row) return;
    try {
      if (runner && typeof runner.deleteApp === 'function') await runner.deleteApp({ appId: row.id });
    } catch (e) {
      const { status, code, message } = runnerError(e, 'invalid_request');
      return res.status(status).json({ ok: false, error: code, message });
    }
    emitEvent(db, row.id, 'deleted', 'owner-initiated');
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM hosted_app_uptime WHERE app_id = ?').run(row.id);
      db.prepare('DELETE FROM hosted_app_deploys WHERE app_id = ?').run(row.id);
      db.prepare('DELETE FROM hosted_app_events WHERE app_id = ?').run(row.id);
      db.prepare('DELETE FROM hosted_apps WHERE id = ?').run(row.id);
    });
    tx();
    res.json({ ok: true, data: { status: 'deleted' } });
  });

  // GET /:id/logs?tail=N&follow=1 — SSE stream of docker logs. Delegates to
  // runner.tailLogs, which returns an async iterable / stream of chunks. We
  // add a 15 s heartbeat comment so proxies (nginx, Caddy) don't idle-close
  // the connection during quiet periods.
  app.get(`${base}/:id/logs`, async (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const row = findApp(db, ctx.row.id, req.params.id, res); if (!row) return;

    const tail = Math.min(Math.max(parseInt(req.query.tail, 10) || 200, 1), 5000);
    const follow = String(req.query.follow || '') === '1';

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: disable proxy buffering
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    // Prime the stream so the client fires 'open' immediately instead of
    // waiting for the first log line.
    res.write(': connected\n\n');

    const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) {} }, 15000);
    // Unref so a lingering keepalive can't hold the process open in tests.
    if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();

    // The runner returns { stop, on } — `on('data'|'end'|'error', fn)`. Any
    // failure to spin the stream is surfaced as a single SSE event so the
    // client sees SOMETHING before the socket closes.
    let stream;
    try {
      if (!runner || typeof runner.tailLogs !== 'function') throw Object.assign(new Error('runner tailLogs not available'), { code: 'hosted_app_runtime_unavailable' });
      stream = await runner.tailLogs({ appId: row.id, tail, follow });
    } catch (e) {
      const code = (e && e.code) || 'hosted_app_runtime_unavailable';
      const msg = String((e && e.message) || e).slice(0, 500);
      try { res.write(`event: error\ndata: ${JSON.stringify({ error: code, message: msg })}\n\n`); } catch (_) {}
      clearInterval(heartbeat);
      try { res.end(); } catch (_) {}
      return;
    }

    const onData = (chunk) => {
      // SSE is line-oriented; encode each newline as its own `data:` field so
      // the browser EventSource dispatches per-line without merging.
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      if (!text) return;
      const encoded = text.split(/\r?\n/).map((l) => `data: ${l}`).join('\n');
      try { res.write(`${encoded}\n\n`); } catch (_) {}
    };
    const onEnd = () => { clearInterval(heartbeat); try { res.write('event: end\ndata: {}\n\n'); res.end(); } catch (_) {} };
    const onErr = (err) => {
      const msg = String((err && err.message) || err).slice(0, 500);
      try { res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`); } catch (_) {}
      clearInterval(heartbeat);
      try { res.end(); } catch (_) {}
    };
    if (stream && typeof stream.on === 'function') {
      stream.on('data', onData);
      stream.on('end', onEnd);
      stream.on('error', onErr);
    }
    req.on('close', () => {
      clearInterval(heartbeat);
      try { if (stream && typeof stream.stop === 'function') stream.stop(); } catch (_) {}
    });
  });

  // GET /:id/events?since=<id> — straight ring-buffer read. Descending order
  // matches how the console renders (newest at top) and avoids a second sort
  // client-side. `since` is inclusive-exclusive: rows with id > since.
  app.get(`${base}/:id/events`, (req, res) => {
    const ctx = ownerBackend(req, res); if (!ctx) return;
    const row = findApp(db, ctx.row.id, req.params.id, res); if (!row) return;
    const since = Math.max(parseInt(req.query.since, 10) || 0, 0);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), MAX_EVENTS_PER_PAGE);
    const rows = db.prepare('SELECT id, ts, kind, message FROM hosted_app_events WHERE app_id = ? AND id > ? ORDER BY id DESC LIMIT ?')
      .all(row.id, since, limit);
    res.json({ ok: true, data: rows });
  });
}

// Translate a runner-thrown Error into our HTTP contract. The runner puts
// `code` on errors it wants the routes to surface verbatim (build_failed,
// healthcheck_failed, port_exhausted, runtime_unavailable) — anything else is
// bucketed as `fallback` at 500.
function runnerError(e, fallback) {
  const CODE_TO_STATUS = {
    hosted_app_build_failed: 422,
    hosted_app_healthcheck_failed: 422,
    hosted_app_port_exhausted: 503,
    hosted_app_runtime_unavailable: 503,
    hosted_app_paused: 409,
    hosted_app_subdomain_taken: 409,
    hosted_app_invalid_source: 422,
    invalid_request: 400,
  };
  const code = (e && e.code) || fallback || 'invalid_request';
  const status = CODE_TO_STATUS[code] || 500;
  const message = String((e && e.message) || e || 'runner failure').slice(0, 500);
  return { status, code, message };
}

module.exports = { registerHostedAppRoutes };
