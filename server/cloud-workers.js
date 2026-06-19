'use strict';

// cloud-workers.js — "LingCode Cloud" white-label COMPUTE tier.
//
// Sibling of cloud-apps.js, but for full-stack / SSR apps (TanStack Start,
// Cloudflare Workers apps) instead of static sites. Each app runs as its own
// isolated Worker inside LingCode's Cloudflare Workers-for-Platforms dispatch
// namespace, fronted by the `lingcode-dispatch` router and served over HTTPS at
// <id>.run.lingcode.dev — all under LingCode's account, the user never sees
// Cloudflare (white-label, the Lovable model).
//
// Flow (proven end-to-end before this was written):
//   IDE builds the app on the user's Mac, tars dist/ (which contains the
//   build-generated dist/server/wrangler.json + dist/client assets), and uploads
//   the gzip'd tar here. We:
//     1. extract to a temp dir,
//     2. `wrangler deploy --config dist/server/wrangler.json
//         --dispatch-namespace <ns> --name <id>`  (wrangler handles the 9 modules
//         + static assets; no hand-rolled multipart),
//     3. attach <id>.run.lingcode.dev as a Worker Custom Domain on the dispatch
//        worker (free per-host cert),
//     4. record it.
//
// The CF API token lives ONLY here (server-side). It is never sent to the Mac —
// a client token can't be scoped to a single tenant script, so vending it would
// let one user overwrite another's Worker. Deploys are serialized (one wrangler
// at a time) so a small API box isn't swamped.
//
// The global express.json parser is SKIPPED for /api/account/cloud-workers in
// index.js so the upload route reads the raw gzip stream.

const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { getUserFromRequest } = require('./auth-helpers');
const { resolveResourceAccess, projectRole } = require('./project-access');
const express = require('express');
const dns = require('dns').promises;
const { readAllBackendSecrets, readAllWorkerSecrets, listWorkerSecretMeta, setWorkerSecret, deleteWorkerSecret, KEY_PATTERN } = require('./secrets-vault');
const { HOST_RE, siblingDomain } = require('./cloud-domains');
const { limitsForTier } = require('./cloud-limits');
const domainee = require('./cloud-domainee');

const EDGE_IP = '138.197.107.228';   // Caddy on-demand-TLS edge (customer A record target)

// ── Config (env, with the proven spike values as defaults) ────────────────
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CF_API_TOKEN  = process.env.CF_API_TOKEN  || process.env.CLOUDFLARE_API_TOKEN || '';
const DISPATCH_NS      = process.env.LINGCODE_DISPATCH_NS || 'lingcode-apps';
const DISPATCH_SERVICE = process.env.LINGCODE_DISPATCH_SERVICE || 'lingcode-dispatch';
const APPS_DOMAIN      = process.env.LINGCODE_APPS_DOMAIN || 'lingcode.app';   // prod apps domain (legacy: run.lingcode.dev)
const APPS_ZONE_ID     = process.env.LINGCODE_APPS_ZONE_ID || ''; // lingcode.app zone id
// CF Workers-KV namespace the out-of-repo lingcode-dispatch router reads per request
// to refuse suspended scripts. The API writes a key (= worker id) on suspend and
// deletes it on resume. Unset → suspend is recorded in the DB but not enforced at edge.
const SUSPENDED_KV_ID  = process.env.LINGCODE_SUSPENDED_KV_ID || '';
// `npx --yes wrangler@4` by default so prod needs no global install; override
// with LINGCODE_WRANGLER_BIN to point at a pinned/local wrangler for speed.
const WRANGLER = process.env.LINGCODE_WRANGLER_BIN || 'npx';
const WRANGLER_ARGS_PREFIX = process.env.LINGCODE_WRANGLER_BIN ? [] : ['--yes', 'wrangler@4'];
// wrangler writes config/cache/logs under $HOME, but the systemd service runs with
// HOME=/nonexistent → EACCES. Point it at a writable dir (override on prod with
// LINGCODE_WRANGLER_HOME for a persistent, cache-warm path).
const WRANGLER_HOME = process.env.LINGCODE_WRANGLER_HOME || path.join(os.tmpdir(), 'lc-wrangler-home');
try { require('fs').mkdirSync(WRANGLER_HOME, { recursive: true }); } catch (_) { /* best-effort */ }

// ── Limits ────────────────────────────────────────────────────────────────
const WORKER_CAP_PER_USER = 10;
const MAX_BUNDLE_BYTES = 60 * 1024 * 1024;     // built worker + assets; generous
const TITLE_MAX = 120;
const DEPLOY_RATE_WINDOW_MS = 60 * 60 * 1000;
const DEPLOY_RATE_MAX = 12;
// A deployed worker's id IS its dispatch-script name AND its subdomain label.
// System ids are `app-<hex>`; users may also pick a vanity label. LABEL_RE
// accepts both (any valid DNS label); validateSubdomain() guards what a user is
// allowed to *request* (the `app-` prefix + a reserved set are off-limits).
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;   // 1–40 chars, DNS-safe
const RESERVED_SUBDOMAINS = new Set([
  'www', 'api', 'app', 'apps', 'admin', 'dashboard', 'dispatch', 'router', 'cdn',
  'assets', 'static', 'mail', 'smtp', 'ftp', 'ns1', 'ns2', 'test', 'staging',
  'internal', 'status', 'docs', 'blog', 'help', 'support', 'account', 'billing',
  'stripe', 'webhook', 'lingcode',
]);

// Derive a DNS-safe vanity label from an app title (validated separately by
// validateSubdomain). Empty if nothing usable remains.
function slugifyWorkerLabel(title) {
  return String(title || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

// Returns null if `name` is an acceptable, available vanity subdomain, else an
// error { code, error, message } the route can send straight back.
function validateSubdomain(db, name) {
  if (!LABEL_RE.test(name) || name.length < 3) {
    return { code: 400, error: 'invalid_subdomain', message: 'Use 3–40 chars: lowercase letters, digits, and hyphens; no leading/trailing hyphen.' };
  }
  if (name.startsWith('app-')) {
    return { code: 400, error: 'reserved_subdomain', message: 'The "app-" prefix is reserved for system-generated names.' };
  }
  if (RESERVED_SUBDOMAINS.has(name)) {
    return { code: 409, error: 'reserved_subdomain', message: `"${name}" is reserved.` };
  }
  if (db.prepare('SELECT 1 FROM cloud_workers WHERE id = ?').get(name)) {
    return { code: 409, error: 'subdomain_taken', message: `"${name}" is already taken.` };
  }
  return null;
}

const deployBuckets = new Map();
function allowDeploy(userId) {
  const now = Date.now();
  let b = deployBuckets.get(userId);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + DEPLOY_RATE_WINDOW_MS }; deployBuckets.set(userId, b); }
  b.count += 1;
  return b.count <= DEPLOY_RATE_MAX;
}

function appUrl(id) { return `https://${id}.${APPS_DOMAIN}/`; }
function decodeHeader(v) { try { return typeof v === 'string' ? decodeURIComponent(v) : ''; } catch (_) { return String(v || ''); } }
function isConfigured() { return !!(CF_ACCOUNT_ID && CF_API_TOKEN && APPS_ZONE_ID); }

// ── Serial deploy queue (protect a small box: one wrangler at a time) ──────
let deployChain = Promise.resolve();
function serialize(task) {
  const run = deployChain.then(task, task);
  // keep the chain alive regardless of individual outcome
  deployChain = run.then(() => {}, () => {});
  return run;
}

// Stream the raw gzip request body to a temp .tgz, capped at MAX_BUNDLE_BYTES.
function receiveTarball(req, tgzPath) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const out = fs.createWriteStream(tgzPath);
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BUNDLE_BYTES) {
        req.destroy();
        out.destroy();
        reject(Object.assign(new Error('bundle_too_large'), { code: 413, error: 'bundle_too_large' }));
      }
    });
    req.on('error', (e) => { out.destroy(); reject(e); });
    out.on('error', reject);
    out.on('finish', () => resolve(bytes));
    req.pipe(out);
  });
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Deploy the extracted build into the dispatch namespace as <id>.
async function wranglerDeploy(workdir, id) {
  const cfg = path.join(workdir, 'dist', 'server', 'wrangler.json');
  if (!fs.existsSync(cfg)) {
    throw Object.assign(new Error('no_build_config'), {
      code: 400, error: 'no_build_config',
      message: 'Bundle is missing dist/server/wrangler.json — build the app first (the Cloudflare Vite plugin emits it).',
    });
  }
  const args = [...WRANGLER_ARGS_PREFIX, 'deploy',
    '--config', cfg,
    '--dispatch-namespace', DISPATCH_NS,
    '--name', id];
  await run(WRANGLER, args, {
    cwd: workdir,
    env: { ...process.env, HOME: WRANGLER_HOME, CLOUDFLARE_API_TOKEN: CF_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID, WRANGLER_SEND_METRICS: 'false' },
    timeout: 5 * 60 * 1000,
  });
}

// Apps are served by the `*.lingcode.app/*` Worker route + the free Universal
// `*.lingcode.app` cert (set up 2026-06-13). The dispatch worker routes by
// subdomain label, so a deployed script at <id> is reachable at <id>.lingcode.app
// the instant it lands in the namespace — NO per-hostname custom domain, NO
// per-host cert to provision (which used to stall and leave apps dark). We no
// longer attach per-hostname custom domains on deploy; `deleteVanityDomains`
// below still cleans up the legacy ones (and BYO domains) on delete.

// True once the app's public HTTPS URL answers at all (any HTTP status means the
// edge TLS cert is live). A connection/TLS failure → false.
async function urlAnswers(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: ctl.signal });
    return r.status > 0;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// Remove every vanity custom domain attached to the dispatch worker whose label
// (first DNS segment) matches this app id, on any zone. Used by delete so a
// removed app leaves no dangling hostname behind, and clears the legacy
// per-hostname domains that predate the wildcard route. Best-effort, never throws.
async function deleteVanityDomains(id) {
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/domains?service=${DISPATCH_SERVICE}`,
      { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } });
    const body = await res.json().catch(() => ({}));
    const mine = (body.result || []).filter((d) => String(d.hostname || '').split('.')[0] === id);
    for (const d of mine) {
      if (!d.id) continue;
      await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/domains/${d.id}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${CF_API_TOKEN}` } }).catch(() => {});
    }
  } catch (_) { /* best-effort */ }
}

// Tear down a deployed Worker completely: dependent DB rows, then the Worker
// script in the dispatch namespace + its vanity/custom domains. Shared by the
// worker DELETE route and the project-delete cascade (project-routes.js).
//
// The CF script delete is AWAITED and checked — the old fire-and-forget,
// errors-swallowed version is exactly why a deleted project's <id>.lingcode.app
// could stay live. Returns { ok, cfDeleted, error }; ok=false means the script
// may still be serving and the caller should warn + allow a retry.
async function teardownWorker(db, id) {
  try {
    for (const r of db.prepare('SELECT domainee_id FROM custom_domains WHERE worker_id = ? AND domainee_id IS NOT NULL').all(id)) {
      domainee.deleteConnection(r.domainee_id).catch(() => {});
    }
  } catch (_) { /* best-effort */ }
  // Dependent rows BEFORE the parent (worker_* carry a FK → cloud_workers(id)).
  db.transaction(() => {
    db.prepare('DELETE FROM worker_usage   WHERE worker_id = ?').run(id);
    db.prepare('DELETE FROM worker_crons   WHERE worker_id = ?').run(id);
    db.prepare('DELETE FROM worker_logs    WHERE worker_id = ?').run(id);
    db.prepare('DELETE FROM worker_secrets WHERE worker_id = ?').run(id);
    db.prepare('DELETE FROM custom_domains WHERE worker_id = ?').run(id);
    db.prepare('DELETE FROM cloud_workers  WHERE id = ?').run(id);
  })();
  // Serialized (one CF op at a time) AND awaited, so failures surface.
  return serialize(async () => {
    let cfDeleted = false;
    let error = null;
    try {
      const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/dispatch/namespaces/${DISPATCH_NS}/scripts/${id}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${CF_API_TOKEN}` } });
      cfDeleted = resp.ok || resp.status === 404; // 404 = already gone
      if (!cfDeleted) {
        const body = await resp.text().catch(() => '');
        error = `CF script delete failed (${resp.status}): ${String(body).slice(0, 300)}`;
        console.error('[cloud-workers] teardownWorker', id, error);
      }
    } catch (e) {
      error = `CF script delete error: ${(e && e.message) || e}`;
      console.error('[cloud-workers] teardownWorker', id, error);
    }
    try { await deleteVanityDomains(id); } catch (_) { /* best-effort */ }
    return { ok: cfDeleted, cfDeleted, error };
  });
}

// Wait for the app's public URL to actually serve before reporting success.
// Served by the wildcard route + Universal cert, so it comes up as soon as the
// script propagates in the dispatch namespace (seconds) — we just confirm it so
// we never report success on a dead link. Best-effort: never throws.
async function ensureUrlLive(id) {
  const url = appUrl(id);
  const start = Date.now();
  while (Date.now() - start < 60000) {
    if (await urlAnswers(url)) return true;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return urlAnswers(url);
}

// ── Secrets: mirror the linked backend's vault into the Worker's env ────────
// A deployed Worker reads its keys as c.env.STRIPE_SECRET_KEY etc. Cloudflare
// stores these as encrypted secret_text bindings on the dispatch script — never
// in the bundle, never sent to the client. We resolve worker → its project →
// that project's managed backend → the vault, then make the script's secrets
// EXACTLY mirror the vault (push current keys, delete ones removed from the
// vault). Best-effort: a sync failure never rolls back an already-live deploy;
// it's surfaced in the deploy response so the IDE can warn. Re-runs on every
// (re)deploy, so rotating a key in the vault + redeploying updates the app.
function scriptsBase() {
  return `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/dispatch/namespaces/${DISPATCH_NS}/scripts`;
}

async function cfListSecretNames(id) {
  const res = await fetch(`${scriptsBase()}/${id}/secrets`, { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } });
  if (!res.ok) return [];
  const body = await res.json().catch(() => ({}));
  return Array.isArray(body.result) ? body.result.map((s) => s.name) : [];
}

async function cfPutSecret(id, name, text) {
  const res = await fetch(`${scriptsBase()}/${id}/secrets`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, text, type: 'secret_text' }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`secret ${name}: ${JSON.stringify(body.errors || res.status)}`);
  }
}

async function cfDeleteSecret(id, name) {
  await fetch(`${scriptsBase()}/${id}/secrets/${encodeURIComponent(name)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
  }).catch(() => {});
}

// Mirror a worker's suspended state into the CF KV namespace the dispatch router
// reads (PUT key on suspend, DELETE on resume). Best-effort: a KV glitch never
// blocks the DB status change — the edge just lags until the next toggle.
// No-op when SUSPENDED_KV_ID isn't configured (status is then DB-only / advisory).
async function cfSetSuspendedKV(id, suspended) {
  if (!SUSPENDED_KV_ID) return;
  const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${SUSPENDED_KV_ID}/values/${encodeURIComponent(id)}`;
  try {
    if (suspended) {
      await fetch(base, { method: 'PUT', headers: { Authorization: `Bearer ${CF_API_TOKEN}` }, body: '1' });
    } else {
      await fetch(base, { method: 'DELETE', headers: { Authorization: `Bearer ${CF_API_TOKEN}` } });
    }
  } catch (_) { /* edge lags until next toggle; DB remains source of truth */ }
}

// Flip a worker's status ('active' | 'suspended') in the control-plane DB and
// mirror it to the edge KV. `reason` ('manual' | 'quota' | null) records WHO
// suspended it so the usage poller only auto-resumes its own 'quota' suspensions.
// Shared by the suspend/resume routes and the usage quota enforcer. Returns false
// if the worker doesn't exist.
function setWorkerStatus(db, id, status, reason = null) {
  const r = db.prepare('UPDATE cloud_workers SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?')
    .run(status, status === 'suspended' ? reason : null, Date.now(), id);
  if (!r.changes) return false;
  cfSetSuspendedKV(id, status === 'suspended').catch(() => {});
  return true;
}

// ── Custom-domain helpers (apex↔www auto-pairing) ──────────────────────────
function domainDns(domain) {
  return { cname: { name: domain, value: 'apps.lingcode.dev' }, a: { name: domain, value: EDGE_IP } };
}

// siblingDomain (apex↔www auto-pair) is shared from cloud-domains.js so all three
// attach surfaces (worker/app/prototype) use one source of truth — imported above.

// Attach one domain row to a worker. Returns 'added' | 'taken' | 'invalid'.
// Pure DB + validation; callers decide how hard a failure is (primary add errors
// to the client, a sibling add silently no-ops).
function attachWorkerDomain(db, workerId, userId, domain, domaineeId = null) {
  if (!HOST_RE.test(domain) || domain === 'lingcode.dev' || domain.endsWith('.lingcode.dev')) return 'invalid';
  if (db.prepare('SELECT 1 FROM custom_domains WHERE domain = ?').get(domain)) return 'taken';
  db.prepare("INSERT INTO custom_domains (domain, prototype_id, worker_id, user_id, status, created_at, domainee_id) VALUES (?, '', ?, ?, 'active', ?, ?)")
    .run(domain, workerId, userId, new Date().toISOString(), domaineeId);
  return 'added';
}

// Returns { synced, removed } on success, { skipped: <reason> } when there's
// nothing to sync (no linked project/backend), or throws on a CF API error.
async function syncWorkerSecrets(db, id) {
  // Bind the Worker's c.env from TWO sources, so secrets work with OR without a
  // managed backend: (1) the linked project's backend vault, if any; (2) per-Worker
  // secrets set directly on this Worker. Worker-level keys win on collision.
  const vault = {};
  const w = db.prepare('SELECT project_id FROM cloud_workers WHERE id = ?').get(id);
  if (w && w.project_id) {
    const be = db.prepare('SELECT id FROM account_backends WHERE project_id = ?').get(w.project_id);
    if (be) Object.assign(vault, readAllBackendSecrets(db, be.id));
  }
  Object.assign(vault, readAllWorkerSecrets(db, id));   // direct Worker secrets override
  const want = Object.keys(vault);
  const have = await cfListSecretNames(id);
  for (const name of want) await cfPutSecret(id, name, vault[name]);
  const stale = have.filter((n) => !want.includes(n));
  for (const name of stale) await cfDeleteSecret(id, name);
  return { synced: want.length, removed: stale.length };
}

// In-memory async-deploy job store. The Mac client polls
// GET /api/account/cloud-workers/jobs/:jobId because a synchronous wrangler
// deploy (minutes on a 512MB box) blows past Cloudflare's 100s edge timeout (524).
const deployJobs = new Map();   // jobId -> { status:'running'|'success'|'failed', userId, id, url, message, secrets, createdAt }
const DEPLOY_JOB_TTL_MS = 30 * 60 * 1000;
function pruneDeployJobs() {
  const now = Date.now();
  for (const [k, v] of deployJobs) if (now - v.createdAt > DEPLOY_JOB_TTL_MS) deployJobs.delete(k);
}

async function handleDeploy(db, req, res, mode /* 'create' | 'update' */) {
  const u = getUserFromRequest(db, req);
  if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!isConfigured()) {
    return res.status(503).json({ ok: false, error: 'cloud_unconfigured', message: 'LingCode Cloud compute is not configured on this server.' });
  }
  if (!allowDeploy(u.id)) return res.status(429).json({ ok: false, error: 'rate_limited', message: `Limit ${DEPLOY_RATE_MAX} deploys/hour.` });

  // App title — names the worker AND (when no explicit subdomain is sent) seeds
  // a friendly vanity label.
  const title = (decodeHeader(req.headers['x-app-title']) || 'Untitled app').slice(0, TITLE_MAX);

  let id, existing = null, creating = (mode !== 'update');
  if (mode === 'update') {
    const reqId = String(req.params.id || '');
    if (LABEL_RE.test(reqId)) {
      // Editor+ may redeploy a shared worker (legacy → direct ownership fallback).
      const access = resolveResourceAccess(db, { resourceTable: 'cloud_workers', resourceId: reqId, userId: u.id, minRole: 'editor' });
      if (access.ok) { id = reqId; existing = access.row; }
      else if (access.code === 'forbidden') return res.status(403).json({ ok: false, error: 'forbidden' });
      // else: the worker was deleted out from under the client (stale stored id).
    }
    // Couldn't resolve an existing worker → SELF-HEAL by creating a fresh one, so
    // the IDE isn't trapped in a "deploy → App not found" loop against a worker
    // that's been deleted. The new one is named after the app title.
    if (!existing) creating = true;
  }
  if (creating) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM cloud_workers WHERE user_id = ?').get(u.id).n;
    const cap = limitsForTier(u.tier || 'free').maxWorkers ?? WORKER_CAP_PER_USER;
    if (count >= cap) return res.status(409).json({ ok: false, error: 'cap_reached', cap });
    // Prefer the IDE's chosen subdomain (X-App-Slug; legacy X-App-Subdomain),
    // else derive one from the app title, else a random id.
    const requested = decodeHeader(req.headers['x-app-slug'] || req.headers['x-app-subdomain'] || '').toLowerCase().trim();
    let candidate = requested || slugifyWorkerLabel(title);
    if (candidate) {
      const bad = validateSubdomain(db, candidate);
      if (bad) {
        if (requested) return res.status(bad.code).json({ ok: false, error: bad.error, message: bad.message });
        candidate = '';   // a derived label that's invalid/taken → fall back to random
      }
    }
    id = candidate || ('app-' + crypto.randomBytes(8).toString('hex'));   // DNS-safe label
  }

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lc-worker-'));
  const tgz = path.join(tmpRoot, 'bundle.tgz');
  const workdir = path.join(tmpRoot, 'src');

  // Receive + extract the upload SYNCHRONOUSLY — the request body must be consumed
  // before we respond. Bounded by the (small) built-bundle size.
  try {
    await receiveTarball(req, tgz);
    await fsp.mkdir(workdir, { recursive: true });
    await run('/usr/bin/tar', ['-xzf', tgz, '-C', workdir]);
  } catch (e) {
    fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    const detail = (e && (e.stderr || e.message)) || 'upload failed';
    return res.status((e && e.code) || 500).json({ ok: false, error: 'upload_failed', message: String(detail).slice(0, 1500) });
  }

  // Respond 202 + jobId NOW, then run the multi-minute `wrangler deploy` in the
  // BACKGROUND. A synchronous wait exceeds Cloudflare's 100s edge timeout → 524.
  // The Mac client polls GET /api/account/cloud-workers/jobs/:jobId.
  pruneDeployJobs();
  const jobId = crypto.randomUUID();
  deployJobs.set(jobId, { status: 'running', userId: u.id, id, url: null, message: null, secrets: null, createdAt: Date.now() });
  res.status(202).json({ ok: true, id, jobId });

  ;(async () => {
    try {
      // Serialize the heavy step so concurrent deploys don't swamp the box.
      // No custom-domain attach: the `*.lingcode.app/*` wildcard route + Universal
      // cert serve <id>.lingcode.app the moment the script lands in the namespace.
      await serialize(async () => {
        await wranglerDeploy(workdir, id);
      });
      const now = Date.now();
      if (existing) {   // not `mode` — a self-healed deploy is mode:'update' but has no existing row
        db.prepare('UPDATE cloud_workers SET title=?, version=version+1, updated_at=? WHERE id=?').run(title, now, id);
      } else {
        db.prepare(`INSERT INTO cloud_workers (id, user_id, title, hostname, version, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?)`).run(id, u.id, title, `${id}.${APPS_DOMAIN}`, 1, now, now);
      }
      // Attach to the IDE's project (if it sent one) so the worker is co-managed.
      maybeLinkWorkerToProject(db, req, id, u.id);
      // Mirror the linked backend's vault into the Worker's env (c.env.X). Best-
      // effort: a secrets glitch must not fail an already-live deploy.
      let secrets;
      try { secrets = await syncWorkerSecrets(db, id); }
      catch (e) { secrets = { error: String((e && e.message) || e).slice(0, 300) }; }
      // Confirm the public URL actually serves before reporting success — and
      // auto-reissue a stuck per-hostname cert. Without this a cert that never
      // provisions leaves the app dark while the deploy claims success (the bug
      // that made sprint-studio-ai.lingcode.app fail silently). Best-effort.
      const live = await ensureUrlLive(id).catch(() => false);
      const job = deployJobs.get(jobId);
      if (job) {
        job.status = 'success';
        job.url = appUrl(id);
        job.secrets = secrets;
        if (!live) job.message = 'Deployed. The HTTPS certificate is still provisioning — your URL should come online within a few minutes.';
      }
    } catch (e) {
      const detail = (e && (e.stderr || e.message)) || 'deploy failed';
      const job = deployJobs.get(jobId);
      if (job) { job.status = 'failed'; job.message = String(detail).slice(0, 1500); }
    } finally {
      fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  })();
}

// Membership-aware access gate for a worker. Returns { user, row, role } or
// sends 404/403 and returns null. minRole is fail-closed (default owner).
function workerAccess(db, req, res, minRole = 'owner') {
  const u = getUserFromRequest(db, req);
  if (!u) { res.status(401).json({ ok: false, error: 'unauthorized' }); return null; }
  const id = String(req.params.id || '');
  const access = resolveResourceAccess(db, { resourceTable: 'cloud_workers', resourceId: id, userId: u.id, minRole });
  if (!access.ok) {
    if (access.code === 'forbidden') { res.status(403).json({ ok: false, error: 'forbidden' }); return null; }
    res.status(404).json({ ok: false, error: 'app_not_found' }); return null;
  }
  return { user: u, row: access.row, role: access.role };
}

// Attach a freshly-deployed worker to the project named by the IDE's
// X-LingCode-Project-Id header (editor+ only, not already linked), and record
// the project's git remote (X-LingCode-Git-Remote, once) so collaborators who
// clone the repo can be matched back to this project by remote. Best-effort.
function maybeLinkWorkerToProject(db, req, id, userId) {
  const projectId = String(req.headers['x-lingcode-project-id'] || '').slice(0, 64);
  if (!projectId) return;
  const remote = String(req.headers['x-lingcode-git-remote'] || '').trim().slice(0, 500);
  try {
    const role = projectRole(db, projectId, userId);
    if (role !== 'owner' && role !== 'editor') return;
    if (remote) {
      db.prepare("UPDATE projects SET git_remote = ? WHERE id = ? AND (git_remote IS NULL OR git_remote = '')").run(remote, projectId);
    }
    const row = db.prepare('SELECT project_id FROM cloud_workers WHERE id = ?').get(id);
    if (row && !row.project_id) {
      db.prepare('UPDATE cloud_workers SET project_id = ? WHERE id = ?').run(projectId, id);
    }
  } catch (_) { /* best-effort */ }
}

function registerCloudWorkerRoutes(app, db) {
  app.post('/api/account/cloud-workers', (req, res) => {
    handleDeploy(db, req, res, 'create').catch((e) => res.status(500).json({ ok: false, error: 'server_error', message: e && e.message }));
  });
  app.put('/api/account/cloud-workers/:id', (req, res) => {
    handleDeploy(db, req, res, 'update').catch((e) => res.status(500).json({ ok: false, error: 'server_error', message: e && e.message }));
  });

  // Live subdomain availability for the IDE deploy form. Uses the SAME rules as
  // a real deploy (validateSubdomain), so a user learns a name is taken/reserved/
  // invalid BEFORE building + uploading — an explicit-slug collision is otherwise
  // a hard 409 only after the (multi-minute) upload completes. `exclude` lets a
  // project re-deploying its own worker treat its current subdomain as available.
  // Registered before /:id so the literal "check" segment can't be eaten by a
  // future GET /:id route.
  app.get('/api/account/cloud-workers/check', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const slug = String(req.query.slug || '').toLowerCase().trim();
    const exclude = String(req.query.exclude || '').toLowerCase().trim();
    if (!slug) return res.json({ ok: true, slug: '', available: false, reason: 'empty' });
    const bad = validateSubdomain(db, slug);
    if (bad && bad.error === 'subdomain_taken' && slug === exclude) {
      return res.json({ ok: true, slug, available: true, reason: 'current' });
    }
    if (bad) return res.json({ ok: true, slug, available: false, reason: bad.error, message: bad.message });
    return res.json({ ok: true, slug, available: true });
  });

  // Async-deploy status poll (registered before the /:id routes). Returns the
  // status strings the Mac client expects: running | success | failed.
  app.get('/api/account/cloud-workers/jobs/:jobId', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const job = deployJobs.get(String(req.params.jobId || ''));
    if (!job || job.userId !== u.id) return res.status(404).json({ ok: false, error: 'job_not_found' });
    if (job.status === 'success') return res.json({ ok: true, status: 'success', id: job.id, url: job.url, secrets: job.secrets });
    if (job.status === 'failed') return res.json({ ok: true, status: 'failed', message: job.message });
    return res.json({ ok: true, status: 'running' });
  });

  // ── Per-Worker env secrets — set directly, no managed backend required ────
  // Stored encrypted AND pushed live to the running Worker (binds as c.env.<KEY>
  // immediately, and re-binds on every deploy via syncWorkerSecrets).
  const secretsJson = express.json({ limit: '64kb' });

  app.get('/api/account/cloud-workers/:id/secrets', (req, res) => {
    const ctx = workerAccess(db, req, res, 'editor'); if (!ctx) return;
    res.json({ ok: true, data: listWorkerSecretMeta(db, ctx.row.id).map((s) => ({ key: s.key, updated_at: s.updated_at })) });
  });

  app.put('/api/account/cloud-workers/:id/secrets', secretsJson, async (req, res) => {
    const ctx = workerAccess(db, req, res, 'editor'); if (!ctx) return;
    const id = ctx.row.id;
    // Accept { key, value } OR { secrets: { KEY: value, ... } }.
    const pairs = (req.body && req.body.secrets && typeof req.body.secrets === 'object')
      ? req.body.secrets
      : (req.body && typeof req.body.key === 'string' ? { [req.body.key]: req.body.value } : null);
    if (!pairs || !Object.keys(pairs).length) return res.status(400).json({ ok: false, error: 'no_secrets', message: 'Provide { key, value } or { secrets: {…} }.' });
    const set = [];
    for (const [key, value] of Object.entries(pairs)) {
      if (!KEY_PATTERN.test(key)) return res.status(400).json({ ok: false, error: 'invalid_key', message: `"${key}" is not a valid env var name (A–Z, 0–9, _).` });
      if (typeof value !== 'string') return res.status(400).json({ ok: false, error: 'invalid_value', message: `"${key}" value must be a string.` });
      setWorkerSecret(db, id, key, value);
      try { await cfPutSecret(id, key, value); } catch (_) { /* stored; will bind on next deploy */ }
      set.push(key);
    }
    res.json({ ok: true, set });
  });

  app.delete('/api/account/cloud-workers/:id/secrets/:key', async (req, res) => {
    const ctx = workerAccess(db, req, res, 'editor'); if (!ctx) return;
    const id = ctx.row.id;
    const key = String(req.params.key || '');
    deleteWorkerSecret(db, id, key);
    try { await cfDeleteSecret(id, key); } catch (_) {}
    res.json({ ok: true });
  });

  app.get('/api/account/cloud-workers', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    // Owned workers PLUS workers in projects the user is a member of (shared).
    const rows = db.prepare(`
      SELECT DISTINCT cw.id, cw.title, cw.hostname, cw.version, cw.status, cw.updated_at, cw.created_at, cw.project_id,
        COALESCE(pm.role, CASE WHEN cw.user_id = @uid THEN 'owner' END) AS role
      FROM cloud_workers cw
      LEFT JOIN project_members pm ON cw.project_id = pm.project_id AND pm.user_id = @uid
      WHERE cw.user_id = @uid OR pm.user_id IS NOT NULL
      ORDER BY cw.created_at DESC
    `).all({ uid: u.id });
    const cap = limitsForTier(u.tier || 'free').maxWorkers ?? WORKER_CAP_PER_USER;
    // URL from the STORED hostname, not appUrl(id) — legacy apps live on
    // run.lingcode.dev, and recomputing from the current APPS_DOMAIN produced a
    // dead lingcode.app link in the console for those.
    res.json({ ok: true, cap, items: rows.map((r) => ({
      ...r,
      status: r.status || 'active',
      role: r.role || 'owner',
      url: r.hostname ? `https://${r.hostname}/` : appUrl(r.id),
    })) });
  });

  // Find-or-create the project that backs a deployed worker, so the account-page
  // "Share / Transfer" button always has a project to land on — even for workers
  // deployed before projects existed (project_id NULL). Owner-only.
  app.post('/api/account/cloud-workers/:id/ensure-project', (req, res) => {
    const ctx = workerAccess(db, req, res, 'owner'); if (!ctx) return;
    if (ctx.row.project_id) return res.json({ ok: true, project_id: ctx.row.project_id });
    const pid = crypto.randomUUID();
    const now = Date.now();
    db.transaction(() => {
      const name = String(ctx.row.title || ctx.row.id).slice(0, 120) || 'Project';
      db.prepare('INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(pid, ctx.user.id, name, now, now);
      db.prepare('INSERT INTO project_members (id, project_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), pid, ctx.user.id, 'owner', ctx.user.id, now);
      db.prepare('UPDATE cloud_workers SET project_id = ? WHERE id = ?').run(pid, ctx.row.id);
    })();
    res.status(201).json({ ok: true, project_id: pid });
  });

  app.delete('/api/account/cloud-workers/:id', async (req, res) => {
    const ctx = workerAccess(db, req, res, 'owner'); if (!ctx) return;
    const result = await teardownWorker(db, ctx.row.id);
    // ok:true keeps the historical contract (the DB rows are always gone); the
    // `cf` field tells the client whether the live script was actually removed.
    res.json({ ok: true, cf: result });
  });

  // ── Kill-switch: suspend / resume a deployed worker ───────────────────────
  // Suspended apps are refused at the edge by the lingcode-dispatch router (it
  // reads the CF KV mirror written by setWorkerStatus). Owner or admin may toggle;
  // the quota enforcer (cloud-worker-usage.js) suspends over-limit apps via the
  // same module-level helper.
  app.post('/api/account/cloud-workers/:id/suspend', (req, res) => {
    const ctx = workerAccess(db, req, res, 'owner'); if (!ctx) return;
    setWorkerStatus(db, ctx.row.id, 'suspended', 'manual');
    res.json({ ok: true, id: ctx.row.id, status: 'suspended' });
  });

  app.post('/api/account/cloud-workers/:id/resume', (req, res) => {
    const ctx = workerAccess(db, req, res, 'owner'); if (!ctx) return;
    setWorkerStatus(db, ctx.row.id, 'active');
    res.json({ ok: true, id: ctx.row.id, status: 'active' });
  });

  // ── Customer-owned custom domains for a worker (api.yoursite.com) ──────────
  // Paths match the account.html "Custom domains" manager (.../domains[, /:domain
  // [, /check]]). Reuses the shared custom_domains table + the Caddy on-demand-TLS
  // /api/cloud/domains/verify gate; the request itself is reverse-proxied to the
  // worker by installWorkerDomainProxy (cloud-domains.js). DNS: A → 138.197.107.228
  // (or CNAME apps.lingcode.dev).
  app.get('/api/account/cloud-workers/:id/domains', (req, res) => {
    const ctx = workerAccess(db, req, res, 'editor'); if (!ctx) return;
    const rows = db.prepare("SELECT domain, status, created_at, domainee_id FROM custom_domains WHERE worker_id = ? ORDER BY created_at DESC").all(ctx.row.id);
    // Per-row CNAME target so the UI shows the right record: Domainee's edge for
    // Domainee-managed domains, our own edge otherwise.
    res.json({ ok: true, data: rows.map((r) => ({
      domain: r.domain, status: r.status, created_at: r.created_at,
      provider: r.domainee_id ? 'domainee' : 'edge',
      cname: r.domainee_id ? 'edge.domainee.dev' : 'apps.lingcode.dev',
    })) });
  });

  app.post('/api/account/cloud-workers/:id/domains', express.json({ limit: '16kb' }), async (req, res) => {
    const ctx = workerAccess(db, req, res, 'owner'); if (!ctx) return;
    const domain = String((req.body && req.body.domain) || '').trim().toLowerCase().replace(/\.$/, '');
    if (!HOST_RE.test(domain)) return res.status(400).json({ ok: false, error: 'invalid_domain', message: 'Enter a valid domain like api.yoursite.com' });
    if (domain === 'lingcode.dev' || domain.endsWith('.lingcode.dev')) return res.status(400).json({ ok: false, error: 'reserved_domain' });
    if (db.prepare('SELECT 1 FROM custom_domains WHERE domain = ?').get(domain)) {
      return res.status(409).json({ ok: false, error: 'domain_taken', message: 'That domain is already attached.' });
    }

    // Domainee path: route the customer domain through Domainee's edge → this app's
    // worker URL. One CNAME, auto Let's Encrypt, white-label. No apex/www auto-pair
    // here (Domainee can't CNAME an apex; redirectWww handles the redirect once both
    // resolve). Falls back to our own Caddy edge + auto-pair when Domainee is unset.
    if (domainee.isConfigured()) {
      try {
        const originUrl = appUrl(ctx.row.id).replace(/\/$/, '');
        const conn = await domainee.createConnection(domain, originUrl);
        attachWorkerDomain(db, ctx.row.id, ctx.user.id, domain, conn.id);
        const sum = domainee.summarize(conn);
        return res.json({ ok: true, data: { domain, status: sum.status, provider: 'domainee', dns: { cname: { name: domain, value: sum.cname } }, also: [] } });
      } catch (e) {
        return res.status(502).json({ ok: false, error: 'domainee_failed', message: String((e && e.message) || e).slice(0, 200) });
      }
    }

    attachWorkerDomain(db, ctx.row.id, ctx.user.id, domain);   // primary (already validated above)
    // Convenience (own-edge path only): also attach the apex↔www sibling so both
    // forms work from one add. Best-effort — taken/invalid sibling silently no-ops.
    const sib = siblingDomain(domain);
    const also = [];
    if (sib && attachWorkerDomain(db, ctx.row.id, ctx.user.id, sib) === 'added') {
      also.push({ domain: sib, status: 'active', dns: domainDns(sib) });
    }
    res.json({ ok: true, data: { domain, status: 'active', provider: 'edge', dns: domainDns(domain), also: also } });
  });

  // Status the UI polls. Domainee-managed domains ask Domainee (cert/edge live?);
  // own-edge domains resolve DNS against our edge IP (cert issues on first HTTPS hit).
  app.get('/api/account/cloud-workers/:id/domains/:domain/check', async (req, res) => {
    const ctx = workerAccess(db, req, res, 'viewer'); if (!ctx) return;
    const domain = String(req.params.domain || '').trim().toLowerCase();
    const row = db.prepare('SELECT domainee_id FROM custom_domains WHERE domain = ? AND worker_id = ?').get(domain, ctx.row.id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    if (row.domainee_id) {
      try {
        const sum = domainee.summarize(await domainee.checkDomain(row.domainee_id));
        return res.json({ ok: true, domain, status: sum.status, provider: 'domainee', cname: sum.cname });
      } catch (_) {
        return res.json({ ok: true, domain, status: 'pending', provider: 'domainee', cname: 'edge.domainee.dev' });
      }
    }
    let addresses = [];
    try { addresses = await dns.resolve4(domain); } catch (_) { addresses = []; }
    const pointed = addresses.includes(EDGE_IP);
    res.json({ ok: true, domain, status: pointed ? 'active' : 'pending', provider: 'edge', pointed, addresses, expected: EDGE_IP });
  });

  app.delete('/api/account/cloud-workers/:id/domains/:domain', (req, res) => {
    const ctx = workerAccess(db, req, res, 'owner'); if (!ctx) return;
    const domain = String(req.params.domain || '').trim().toLowerCase();
    const row = db.prepare('SELECT domainee_id FROM custom_domains WHERE domain = ? AND worker_id = ?').get(domain, ctx.row.id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    if (row.domainee_id) domainee.deleteConnection(row.domainee_id).catch(() => {});   // best-effort teardown
    db.prepare('DELETE FROM custom_domains WHERE domain = ? AND worker_id = ?').run(domain, ctx.row.id);
    res.json({ ok: true });
  });
}

module.exports = { registerCloudWorkerRoutes, teardownWorker, syncWorkerSecrets, validateSubdomain, setWorkerStatus, workerAccess, APPS_DOMAIN, siblingDomain, attachWorkerDomain };
