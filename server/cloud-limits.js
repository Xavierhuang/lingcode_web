'use strict';

// cloud-limits.js — per-tier quotas for LingCode Cloud backends (Phase 6).
// Mirrors the free/pro/max_pro tiering used elsewhere (app_config /
// paidTierCaps). Enforced by cloud-backend.js on provision, insert, migrate,
// storage upload, and user signup.
//
// The values below are DEFAULTS. Operators override any (tier, field) live from
// the admin dashboard ("Cloud backend limits" tile) — each override is one
// app_config row keyed `cloud_limit_<tier>_<field>`. An override wins over the
// default; clearing the row reverts to the default. No restart required.
//
// maxFunctionMs = wall-clock cap per serverless-function invocation (the Deno
// sandbox is SIGKILL'd past it). Scales with tier like every other quota.
//
// maxObjectBytes vs maxUploadBytes: maxObjectBytes caps the LEGACY base64-through-
// the-droplet upload path (/storage/upload) — small on purpose, it's a droplet-
// memory guard. maxUploadBytes caps the DIRECT-to-Spaces presigned-PUT path
// (/storage/create-upload-url → /storage/finalize), where bytes never transit the
// droplet, so it can be GB-scale (single-PUT ceiling is 5 GB; beyond needs multipart).
// maxStorageBytes = total bytes a single backend may store across ALL its objects
// (SUM(backend_objects.bytes)). Per-backend, like every other cap. Distinct from the
// per-object ceilings above: those bound one upload (413), this bounds the backend total (402).
// maxWorkers / maxCrons / maxWorkerRequestsPerDay govern the COMPUTE tier
// (cloud-workers.js): how many full-stack apps a user may deploy, how many
// scheduled jobs each may have, and the per-app daily request ceiling that
// auto-suspends an over-quota app. `free.maxWorkers: 10` preserves the prior
// hardcoded WORKER_CAP_PER_USER so existing free users see no regression.
const TIER_LIMITS = {
  free:    { maxTables: 10,  maxObjects: 50,   maxObjectBytes: 1 * 1024 * 1024, maxUploadBytes: 50 * 1024 * 1024,        maxUsers: 100,    maxFunctions: 2,  maxEmailsPerDay: 30,    maxFunctionMs: 3000,  maxStorageBytes: 500 * 1024 * 1024, maxWorkers: 10,  maxCrons: 2,   maxWorkerRequestsPerDay: 100000 },
  pro:     { maxTables: 50,  maxObjects: 1000, maxObjectBytes: 5 * 1024 * 1024, maxUploadBytes: 1 * 1024 * 1024 * 1024,  maxUsers: 10000,  maxFunctions: 10, maxEmailsPerDay: 1000,  maxFunctionMs: 10000, maxStorageBytes: 5 * 1024 * 1024 * 1024, maxWorkers: 25,  maxCrons: 20,  maxWorkerRequestsPerDay: 2000000 },
  max_pro: { maxTables: 200, maxObjects: 10000,maxObjectBytes: 10 * 1024 * 1024,maxUploadBytes: 5 * 1024 * 1024 * 1024,  maxUsers: 100000, maxFunctions: 50, maxEmailsPerDay: 10000, maxFunctionMs: 30000, maxStorageBytes: 20 * 1024 * 1024 * 1024, maxWorkers: 100, maxCrons: 100, maxWorkerRequestsPerDay: 20000000 },
};

const CLOUD_TIERS = ['free', 'pro', 'max_pro'];
const CLOUD_FIELDS = ['maxTables', 'maxObjects', 'maxObjectBytes', 'maxUploadBytes', 'maxUsers', 'maxFunctions', 'maxEmailsPerDay', 'maxFunctionMs', 'maxStorageBytes', 'maxWorkers', 'maxCrons', 'maxWorkerRequestsPerDay'];

// Flat allow-list of every editable app_config key. The admin endpoint rejects
// anything outside this set loudly, instead of silently bloating app_config.
const CLOUD_LIMIT_KEYS = [];
for (const t of CLOUD_TIERS) for (const f of CLOUD_FIELDS) CLOUD_LIMIT_KEYS.push(`cloud_limit_${t}_${f}`);

const CLOUD_LIMIT_KEY_RE = /^cloud_limit_(free|pro|max_pro)_([A-Za-z]+)$/;

// Module-global db so the hot enforcement path (limitsForTier / assertUnderLimit,
// called with just a tier) reads overrides without threading db through every
// call site. index.js calls setDb(db) once at startup.
let _db = null;
function setDb(db) { _db = db; }

/**
 * Effective limits for every tier: defaults with any app_config overrides
 * applied. One query for all overrides.
 * @param {import('better-sqlite3').Database|null} db
 */
function loadCloudLimits(db) {
  const out = {
    free: { ...TIER_LIMITS.free },
    pro: { ...TIER_LIMITS.pro },
    max_pro: { ...TIER_LIMITS.max_pro },
  };
  if (!db) return out;
  try {
    const rows = db.prepare("SELECT key, value FROM app_config WHERE key LIKE 'cloud_limit_%'").all();
    for (const r of rows) {
      const m = CLOUD_LIMIT_KEY_RE.exec(r.key);
      if (!m) continue;
      const tier = m[1], field = m[2];
      if (!out[tier] || !(field in out[tier])) continue;
      const n = parseInt(String(r.value).trim(), 10);
      if (Number.isFinite(n) && n >= 0) out[tier][field] = n;
    }
  } catch (_) { /* table may not exist on first boot — use defaults */ }
  return out;
}

function limitsForTier(tier) {
  const all = loadCloudLimits(_db);
  return all[tier] || all.free;
}

// computeCapabilities(tier) — the server-side compute story, tier-aware, for
// describe_backend / get_backend_info so AI agents know the backend is more
// than a database. LingCode Cloud holds secrets, runs serverless functions, and
// hosts full-stack apps — none of which the data-plane tools reveal, which is
// why agents wrongly tell users to keep an external server. Honest about the
// constraints (V8-not-Node, ~30s, deploy is a Mac-app action) so agents neither
// under-claim nor over-promise.
function computeCapabilities(tier) {
  const lim = limitsForTier(tier);
  return {
    secretsVault: 'AES-256-GCM encrypted, server-side. Store vendor keys (STRIPE_SECRET_KEY, RESEND_API_KEY, ELEVENLABS_API_KEY, ANTHROPIC_API_KEY, …) here and read them from functions (ctx.secrets) OR — in a DEPLOYED Worker app — as c.env.<NAME> environment bindings (set a key in Secrets, redeploy, then read e.g. c.env.STRIPE_SECRET_KEY). Never ship keys in client code; no external server is needed to hold them.',
    functions: {
      builtins: ['echo', 'send-email', 'elevenlabs-tts', 'twilio-sms', 'resend-byo', 'stripe-checkout', 'http-fetch'],
      builtinsNeedNoDeploy: true,
      // Reflect the actual runtime, not a hardcoded promise: custom functions need
      // the Deno sandbox, which may not be installed on every box. isAvailable()
      // caches a cheap `deno --version` probe. Lazy require avoids any load-order
      // coupling and never probes at boot (cloud-functions-runtime only pulls in
      // child_process, so there's no import cycle back to cloud-limits).
      custom: require('./cloud-functions-runtime').isAvailable(),
      maxFunctions: lim.maxFunctions,
      maxFunctionMs: lim.maxFunctionMs,
      genericApiProxy: 'To integrate ANY third-party API with a server-side secret, use the http-fetch builtin — invoke it with { url, method, headers: { Authorization: "Bearer {{SECRET_NAME}}" }, body }. No per-vendor function needed; the key stays server-side. The owner allow-lists the host first (Settings → Allowed fetch hosts).',
      invoke: 'POST /api/cloud/be/<backendId>/functions/<slug> — or window.lingcode.functions.invoke(slug, input) from app code',
      // Custom functions are now full backend endpoints, not just compute — so most
      // server logic runs here instead of on an external host.
      dbAccess: 'ctx.db.query(sql, params) runs arbitrary parameterized SQL — JOINs, aggregations, multi-row transactions — as the tenant role under RLS, returning { rows, rowCount, fields }. ctx.db.queryRead(sql, params) for read-only. This is how a function does logic the CRUD API can\'t express.',
      storageAccess: 'ctx.storage.uploadUrl(path, {contentType}) / url(path) / remove(path) read & write file storage from inside a function.',
      httpHandler: 'ctx.request = { method, headers, query, rawBody, path } — a function is a real HTTP endpoint and webhook receiver (verify Stripe/GitHub signatures off rawBody). Return { __http: true, status, headers, body } to send a raw HTTP response instead of the default JSON envelope.',
      scheduled: 'A custom function can run on a 5-field CRON schedule (digests, cleanup, polling) — managed in the IDE/console, no external scheduler needed.',
      note: 'Builtins are live on EVERY backend with no deploy step — just set any required secret in Secrets first, then invoke by slug (a wrong slug returns unknown_function; that means wrong name, NOT "functions unavailable"). CUSTOM functions are authored in the Cloud console / IDE, sandboxed Deno, ≤ maxFunctionMs wall-clock per invocation, and (per above) can touch the DB + storage, handle raw HTTP/webhooks, and run on a schedule. Not a persistent long-running process.',
    },
    appHosting: {
      available: true,
      url: '*.run.lingcode.dev',
      customDomains: true,
      secretsAsEnv: 'A deployed Worker app AUTOMATICALLY receives the linked backend\'s vault secrets as c.env.<NAME> environment bindings on every deploy (e.g. c.env.STRIPE_SECRET_KEY) — keys never ship in the bundle. So a full app with billing/AI/third-party keys runs entirely on LingCode Cloud — no external host (Render/Fly/Railway) needed.',
      customDomainsHow: 'A chosen vanity subdomain at deploy, OR BYO domain (api.yoursite.com): attach in the account console, then point DNS A → 138.197.107.228 (or CNAME apps.lingcode.dev); on-demand TLS. Raw webhook bodies (e.g. Stripe signature verification) forward intact.',
      runtime: 'Cloudflare Workers (V8 isolate — NOT Node). A plain Node server won\'t run as-is, but deploy AUTO-DETECTS the framework and builds it for Workers — no manual porting.',
      frameworks: 'Deploy auto-detects and builds: Next.js (via OpenNext), SvelteKit, Nuxt, Astro (SSR), Remix/React Router 7, TanStack Start, plus plain static sites. SSR pages, API routes, server actions and server components all run on the Workers tier.',
      deployVia: 'LingCode Mac app → "Deploy to LingCode Cloud" (auto-detects the framework). No MCP/agent tool yet — set up secrets/functions/data here, then tell the user to click Deploy for the full-stack tier.',
    },
    notSuitableFor: 'Long-running processes, persistent WebSocket servers, a single request over ~30s, or a non-JS backend (Python/Django, Rails, Go). Those stay on a server you run. NOTE: short scheduled/cron jobs ARE supported — both on deployed Worker apps (see maxCrons) and as scheduled custom functions on the managed backend.',
  };
}

// Throws a 402 error when `count` is at/over the limit for `key`.
function assertUnderLimit(tier, key, count) {
  const max = limitsForTier(tier)[key];
  if (typeof max === 'number' && count >= max) {
    const e = new Error(`Plan limit reached for ${key} (${max}). Upgrade for more.`);
    e.status = 402;
    e.code = 'quota_exceeded';
    throw e;
  }
}

// Total bytes currently stored by a backend (SUM over backend_objects). 0 if the
// table doesn't exist yet or on any read error — never blocks a write spuriously.
function storageUsedBytes(db, backendId) {
  try {
    const row = db.prepare('SELECT COALESCE(SUM(bytes),0) AS b FROM backend_objects WHERE backend_id = ?').get(backendId);
    return (row && row.b) || 0;
  } catch (_) { return 0; }
}

// Throws 402 if adding `addBytes` would push the backend over its total-storage cap.
// `addBytes` is the NET delta the caller intends to add (for replace-in-place: new − old),
// so overwriting a same-or-smaller object never trips the cap.
// `bonusBytes` is à-la-carte storage the owner purchased (Model B add-on); it stacks on top
// of the tier's maxStorageBytes. Defaults to 0 so existing 4-arg callers are unaffected.
function assertStorageRoom(db, backendId, tier, addBytes, bonusBytes = 0) {
  const base = limitsForTier(tier).maxStorageBytes;
  if (typeof base !== 'number') return;
  const max = base + (bonusBytes > 0 ? bonusBytes : 0);
  const used = storageUsedBytes(db, backendId);
  if (used + Math.max(0, addBytes) > max) {
    const e = new Error(`Storage quota reached (${Math.floor(max / 1024 / 1024)} MB). Upgrade or free up space.`);
    e.status = 402;
    e.code = 'quota_exceeded';
    throw e;
  }
}

// null | 'warn' (>=80%) | 'critical' (>=95%) — the near-limit signal for UI + emails.
function storageWarningLevel(used, max) {
  if (typeof max !== 'number' || max <= 0) return null;
  const r = used / max;
  if (r >= 0.95) return 'critical';
  if (r >= 0.80) return 'warn';
  return null;
}

module.exports = {
  limitsForTier, computeCapabilities, assertUnderLimit, TIER_LIMITS,
  loadCloudLimits, setDb, CLOUD_LIMIT_KEYS, CLOUD_TIERS, CLOUD_FIELDS,
  storageUsedBytes, assertStorageRoom, storageWarningLevel,
};
