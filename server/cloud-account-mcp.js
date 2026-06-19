'use strict';

// cloud-account-mcp.js — ACCOUNT-level MCP server for the IDE / CLI / external
// MCP clients (no /try prototype). One MCP connection per project:
//
//   POST https://lingcode.dev/api/cloud/account/mcp
//   Authorization: Bearer <users.api_access_token>      (the user's account)
//   X-LingCode-Project: <project key>                    (binds to one backend)
//
// The connection is bound to the user's STANDALONE backend for that project key
// (account_backends). Tools operate on it implicitly — provision it, migrate it,
// and read/write data, all owner-scoped (full access; no RLS user pin). Stateless
// JSON-RPC over HTTP (same transport shape as cloud-mcp.js, owner auth instead of
// anon key). Delegates to the existing data plane + provisionBackend.

const dataPlane = require('./cloud-data-plane');
const { getUserFromRequest } = require('./auth-helpers');
const { provisionBackend, getAccountBackend, purchasedStorageBytesForBackend } = require('./cloud-backend');
const { roleAtLeast } = require('./project-access');
const cloudOAuth = require('./cloud-oauth');
const storage = require('./cloud-storage');
const { limitsForTier, computeCapabilities } = require('./cloud-limits');
const { recordSchemaMigration } = require('./cloud-audit');
const { nextRunAfter } = require('./cloud-worker-cron');
const crypto = require('crypto');

const SERVER_INFO = { name: 'lingcode-cloud', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

function cors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-LingCode-Project, X-LingCode-Project-Id, Mcp-Protocol-Version');
}

// Auth: user Bearer token + project headers. Returns { user, projectKey, projectId }
// or sends the response + null. The canonical projectId (from the repo-local
// .lingcode/project.json manifest) is preferred for resolving a SHARED backend
// across users; the legacy path-hash projectKey is the solo fallback.
function authAccount(req, res, db) {
  cors(res);
  if (!dataPlane.isConfigured()) { res.status(503).json({ error: 'cloud_not_configured' }); return null; }
  const user = getUserFromRequest(db, req);
  if (!user) { res.set('WWW-Authenticate', 'Bearer'); res.status(401).json({ error: 'unauthorized' }); return null; }
  const projectKey = String(req.headers['x-lingcode-project'] || 'default').slice(0, 200);
  const projectId = String(req.headers['x-lingcode-project-id'] || '').slice(0, 64) || null;
  return { user, projectKey, projectId };
}

// Tools. Each resolves the project's live backend first (or, for provision,
// creates it). Owner access — no RLS user pin (userId: null) so the owner sees
// all rows from their tools.
const TOOLS = [
  {
    name: 'provision_backend',
    description: "Create this project's managed Postgres backend (built-in email/password & magic-link auth, storage, email — no external keys). Call FIRST before apply_migration when the app needs to persist data or have user accounts. Idempotent. Returns the backend URL + anon key to use in app code.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    needsBackend: false,
    run: async (ctx) => provisionBackend(ctx.db, { userId: ctx.user.id, tier: ctx.user.tier, gatewayBase: ctx.gatewayBase, projectKey: ctx.projectKey }),
  },
  {
    name: 'apply_migration',
    description: 'Run a CREATE/ALTER/DROP SQL migration to set up the tables this project needs. Do this before writing app code that reads/writes them.',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'], additionalProperties: false },
    needsBackend: true, minRole: 'editor',
    run: async (ctx, a) => {
      const sql = String((a && a.sql) || '');
      try {
        const data = await dataPlane.applyMigration(ctx.backendId, sql);
        recordSchemaMigration(ctx.db, { backendId: ctx.backendId, userId: ctx.user && ctx.user.id, sql, status: 'applied' });
        return data;
      } catch (err) {
        recordSchemaMigration(ctx.db, { backendId: ctx.backendId, userId: ctx.user && ctx.user.id, sql, status: 'failed', error: (err && err.message) || String(err) });
        throw err;
      }
    },
  },
  {
    name: 'list_tables',
    description: "List the project backend's tables and columns.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    needsBackend: true, minRole: 'viewer',
    run: (ctx) => dataPlane.listTables(ctx.backendId),
  },
  {
    name: 'query',
    description: 'Run a read-only SQL SELECT/WITH and return rows. Writes are rejected — use insert/update/delete.',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'], additionalProperties: false },
    needsBackend: true, minRole: 'viewer',
    run: (ctx, a) => {
      const sql = String((a && a.sql) || '');
      const trimmed = sql.trim().replace(/^\(\s*/, '');
      if (!/^(select|with)\s/i.test(trimmed)) { const e = new Error('query is read-only — use insert/update/delete or apply_migration'); e.status = 400; throw e; }
      return dataPlane.runReadOnlyQuery(ctx.backendId, sql);
    },
  },
  {
    name: 'select',
    description: 'Select rows from ONE table — NO JOINs (fetch separately and join in app code; for multi-table/aggregate queries make a VIEW via apply_migration or use the query tool). Returns at most 200 rows; page with limit/offset. Optional where (filter), order, limit, offset. where ops: {col:value}=eq, {col:{gt|gte|lt|lte|neq|like|ilike:v}}, {col:{in:[...]}}, {col:{is:"not_null"}}, {col:null}.',
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, where: { type: 'object' }, order: {}, limit: { type: 'number' }, offset: { type: 'number' } }, required: ['table'], additionalProperties: false },
    needsBackend: true, minRole: 'viewer',
    run: (ctx, a) => dataPlane.proxySelect(ctx.backendId, String((a && a.table) || ''), { where: a && a.where, order: a && a.order, limit: a && a.limit, offset: a && a.offset, userId: null }),
  },
  {
    name: 'insert',
    description: 'Insert a row into ONE table. Returns the inserted row. No upsert / ON CONFLICT — on a duplicate-key error, fetch the row then update instead.',
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, row: { type: 'object' } }, required: ['table', 'row'], additionalProperties: false },
    needsBackend: true, minRole: 'editor',
    run: (ctx, a) => dataPlane.proxyInsert(ctx.backendId, String((a && a.table) || ''), a && a.row, { userId: null }),
  },
  {
    name: 'update',
    description: 'Update rows matching where with patch. where REQUIRED. Returns updated rows.',
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, where: { type: 'object' }, patch: { type: 'object' } }, required: ['table', 'where', 'patch'], additionalProperties: false },
    needsBackend: true, minRole: 'editor',
    run: (ctx, a) => dataPlane.proxyUpdate(ctx.backendId, String((a && a.table) || ''), { where: a && a.where, patch: a && a.patch, userId: null }),
  },
  {
    name: 'delete',
    description: 'Delete rows matching where. where REQUIRED. Returns deleted rows.',
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, where: { type: 'object' } }, required: ['table', 'where'], additionalProperties: false },
    needsBackend: true, minRole: 'editor',
    run: (ctx, a) => dataPlane.proxyDelete(ctx.backendId, String((a && a.table) || ''), { where: a && a.where, userId: null }),
  },
  {
    name: 'vector_search',
    description: 'Semantic / similarity search over a pgvector column. First apply_migration a table with a vector(N) column (e.g. embedding vector(1536)) and insert rows with the embedding as a [..] literal. metric: cosine (default), l2, or ip. Returns rows ordered by closeness with a _distance field.',
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, column: { type: 'string' }, embedding: { type: 'array', items: { type: 'number' } }, limit: { type: 'number' }, metric: { type: 'string', enum: ['cosine', 'l2', 'ip'] } }, required: ['table', 'column', 'embedding'], additionalProperties: false },
    needsBackend: true, minRole: 'viewer',
    run: (ctx, a) => dataPlane.vectorSearch(ctx.backendId, { table: String((a && a.table) || ''), column: String((a && a.column) || ''), embedding: a && a.embedding, limit: a && a.limit, metric: a && a.metric, userId: null }),
  },
  {
    name: 'list_functions',
    description: "List the built-in serverless function templates available on EVERY backend (no deploy needed) — call one via window.lingcode.functions.invoke(slug, input) or POST /api/cloud/be/<id>/functions/<slug>. Includes send-email, elevenlabs-tts, stripe-checkout, http-fetch, twilio-sms, resend-byo. The owner sets any required secret in the backend Secrets first. (A wrong slug returns unknown_function — that means wrong name, NOT that functions are unavailable.)",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    needsBackend: false,   // templates are a global registry; no live backend required
    run: () => require('./cloud-functions').listTemplates(),
  },
  {
    name: 'set_auth_provider',
    description: "Optional: give this backend its OWN OAuth client for a social provider so the consent screen shows YOUR app's name instead of LingCode. google/github: client_id + client_secret. apple (Firebase-style BYO — Apple has no shared client): client_id = Services ID, client_secret = the .p8 private key contents, plus team_id, key_id, and (for native iOS) bundle_id. Returns a redirect_uri to register in your provider console. Skip this to use LingCode's managed client (google/github only). Sign-in is built in — apps open <backend_url>/auth/oauth/<provider>/start, or for native iOS POST the Apple identity token to <backend_url>/auth/apple/native.",
    inputSchema: { type: 'object', properties: { provider: { type: 'string', enum: ['google', 'github', 'apple'] }, client_id: { type: 'string' }, client_secret: { type: 'string' }, team_id: { type: 'string' }, key_id: { type: 'string' }, bundle_id: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['provider', 'client_id', 'client_secret'], additionalProperties: false },
    needsBackend: true, minRole: 'owner',
    run: (ctx, a) => cloudOAuth.upsertBackendProvider(ctx.db, {
      backendId: ctx.backendId, provider: String((a && a.provider) || ''),
      clientId: String((a && a.client_id) || ''), clientSecret: String((a && a.client_secret) || ''),
      teamId: a && a.team_id ? String(a.team_id) : undefined,
      keyId: a && a.key_id ? String(a.key_id) : undefined,
      bundleId: a && a.bundle_id ? String(a.bundle_id) : undefined,
      enabled: !(a && a.enabled === false),
    }),
  },
  {
    name: 'describe_backend',
    description: "Describe this project backend's capabilities and quotas. Covers the SERVER-SIDE COMPUTE TIER (compute): an encrypted secrets vault, built-in + custom serverless functions with their per-tier timeout, and full-stack Worker/SSR app hosting — so secrets, Stripe, email, and most server logic can run on LingCode Cloud WITHOUT an external server (don't tell users to keep a separate host without checking this). Also covers file-storage caps (maxObjectBytes for the inline base64 upload path, maxUploadBytes for the direct-to-Spaces presigned-PUT path, maxObjects, maxStorageBytes for the backend's total stored bytes across all objects), the public/private storage buckets, whether direct upload is available, and the other per-tier limits (tables/users/functions/emails). Call this to learn what the backend can actually do — e.g. whether a large file fits, or whether server code can move here — instead of guessing.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    needsBackend: true, minRole: 'viewer',
    run: (ctx) => {
      const lim = limitsForTier(ctx.user.tier);
      const purchased = purchasedStorageBytesForBackend(ctx.db, ctx.backendId);
      return {
        tier: ctx.user.tier,
        storage: {
          directUpload: storage.isConfigured(),
          buckets: ['public', 'private'],
          maxObjectBytes: lim.maxObjectBytes,   // inline base64 path (/storage/upload)
          maxUploadBytes: lim.maxUploadBytes,    // direct-to-Spaces path (create-upload-url → finalize)
          maxObjects: lim.maxObjects,
          maxStorageBytes: lim.maxStorageBytes,  // tier total bytes across all objects (per backend)
          purchasedStorageBytes: purchased,      // à-la-carte add-on (Model B)
          effectiveStorageBytes: lim.maxStorageBytes + purchased, // what's actually enforced
          perUserIsolation: 'private bucket is namespaced + access-gated per signed-in app user; public bucket is shared/world-readable',
        },
        compute: computeCapabilities(ctx.user.tier),
        limits: lim,
      };
    },
  },
  {
    name: 'storage_list',
    description: 'List stored files (objects) in this project backend: bucket, path, content_type, bytes, created_at. Up to 500, newest first.',
    inputSchema: { type: 'object', properties: { bucket: { type: 'string' } }, additionalProperties: false },
    needsBackend: true, minRole: 'viewer',
    run: (ctx, a) => {
      const bucket = a && a.bucket ? String(a.bucket) : null;
      const rows = bucket
        ? ctx.db.prepare('SELECT bucket, path, content_type, bytes, created_at FROM backend_objects WHERE backend_id=? AND bucket=? ORDER BY created_at DESC LIMIT 500').all(ctx.backendId, bucket)
        : ctx.db.prepare('SELECT bucket, path, content_type, bytes, created_at FROM backend_objects WHERE backend_id=? ORDER BY created_at DESC LIMIT 500').all(ctx.backendId);
      return { objects: rows };
    },
  },
  {
    name: 'storage_create_upload_url',
    description: "Mint a short-lived presigned PUT URL so app code uploads a file's bytes DIRECTLY to object storage (bypassing the size limit of the inline base64 path — this is how GB-scale files like video/audio recordings work). Returns { uploadUrl, method, headers, bucket, path }: the app PUTs the file to uploadUrl with exactly those headers, then calls /api/cloud/be/<id>/storage/finalize (bucket, path) to register it. Requires object storage to be configured.",
    inputSchema: { type: 'object', properties: { bucket: { type: 'string' }, path: { type: 'string' }, content_type: { type: 'string' } }, required: ['path'], additionalProperties: false },
    needsBackend: true, minRole: 'editor',
    run: async (ctx, a) => {
      if (!storage.isConfigured()) { const e = new Error('object storage not configured; use the base64 storage/upload path'); e.status = 409; throw e; }
      const bucket = (a && a.bucket) ? String(a.bucket) : 'public';
      const path = String((a && a.path) || '');
      const signed = await storage.presignPut(ctx.backendId, bucket, path, a && a.content_type);
      return { uploadUrl: signed.url, method: 'PUT', headers: signed.headers, bucket, path, finalizeWith: `POST /api/cloud/be/${ctx.backendId}/storage/finalize { bucket, path }` };
    },
  },
  {
    name: 'storage_remove',
    description: 'Delete a stored file (object) by bucket + path. Removes it from object storage and its metadata row.',
    inputSchema: { type: 'object', properties: { bucket: { type: 'string' }, path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    needsBackend: true, minRole: 'editor',
    run: async (ctx, a) => {
      const bucket = (a && a.bucket) ? String(a.bucket) : 'public';
      const path = String((a && a.path) || '');
      if (storage.isConfigured()) { try { await storage.removeObject(ctx.backendId, bucket, path); } catch (_) { /* metadata delete still proceeds */ } }
      ctx.db.prepare('DELETE FROM backend_objects WHERE backend_id=? AND bucket=? AND path=?').run(ctx.backendId, bucket, path);
      return { removed: true, bucket, path };
    },
  },
  {
    name: 'schedule_function',
    description: "Run one of this backend's custom serverless functions on a recurring CRON schedule (5 fields 'min hour dom month dow', UTC) — for digests, cleanup, polling, etc. The function (slug) must already exist (author it in the IDE/console). On each tick it runs server-side with full ctx (ctx.db / ctx.storage / ctx.secrets); its input is { scheduled:true, time, ...input }. Returns the schedule id + next_run_at.",
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, cron: { type: 'string' }, input: { type: 'object' } }, required: ['slug', 'cron'], additionalProperties: false },
    needsBackend: true, minRole: 'editor',
    run: (ctx, a) => {
      const slug = String((a && a.slug) || '').toLowerCase();
      const cron = String((a && a.cron) || '').trim();
      if (!/^[a-z][a-z0-9-]{0,40}$/.test(slug)) { const e = new Error('invalid slug'); e.status = 400; throw e; }
      const fn = ctx.db.prepare('SELECT 1 FROM backend_functions WHERE backend_id = ? AND slug = ?').get(ctx.backendId, slug);
      if (!fn) { const e = new Error(`no function '${slug}' on this backend — create it first`); e.status = 404; throw e; }
      try { nextRunAfter(cron, Date.now()); } catch (e2) { const e = new Error('invalid cron: ' + String((e2 && e2.message) || e2)); e.status = 400; throw e; }
      const max = limitsForTier(ctx.user.tier).maxCrons ?? 0;
      const count = ctx.db.prepare('SELECT COUNT(*) AS n FROM backend_function_schedules WHERE backend_id = ?').get(ctx.backendId).n;
      if (count >= max) { const e = new Error(`scheduled-function limit reached (${max}) for this plan`); e.status = 402; throw e; }
      let inputJson = null; if (a && a.input !== undefined) { try { inputJson = JSON.stringify(a.input).slice(0, 8192); } catch (_) {} }
      const id = crypto.randomUUID(); const now = Date.now(); const next = nextRunAfter(cron, now);
      ctx.db.prepare(`INSERT INTO backend_function_schedules (id, backend_id, slug, schedule, input_json, enabled, next_run_at, created_at)
                      VALUES (?,?,?,?,?,1,?,?)`).run(id, ctx.backendId, slug, cron, inputJson, next, now);
      return { id, slug, cron, enabled: true, next_run_at: next };
    },
  },
  {
    name: 'list_function_schedules',
    description: "List this backend's scheduled-function CRON entries (id, slug, cron, enabled, last/next run, last status).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    needsBackend: true, minRole: 'viewer',
    run: (ctx) => ({ schedules: ctx.db.prepare('SELECT id, slug, schedule AS cron, enabled, last_run_at, last_status, next_run_at FROM backend_function_schedules WHERE backend_id = ? ORDER BY created_at DESC').all(ctx.backendId) }),
  },
  {
    name: 'unschedule_function',
    description: 'Delete a scheduled-function CRON entry by its id (from list_function_schedules).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    needsBackend: true, minRole: 'editor',
    run: (ctx, a) => {
      const r = ctx.db.prepare('DELETE FROM backend_function_schedules WHERE id = ? AND backend_id = ?').run(String((a && a.id) || ''), ctx.backendId);
      if (!r.changes) { const e = new Error('schedule not found'); e.status = 404; throw e; }
      return { removed: true };
    },
  },
];

async function handleRpc(msg, baseCtx, db) {
  const id = msg.id;
  const isNotification = (id === undefined || id === null);
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const rpcErr = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  const method = msg.method;

  if (method === 'initialize') {
    return ok({ protocolVersion: (msg.params && msg.params.protocolVersion) || DEFAULT_PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
  }
  if (method === 'ping') return ok({});
  if (typeof method === 'string' && method.startsWith('notifications/')) return null;
  if (method === 'tools/list') {
    return ok({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcErr(-32602, `unknown tool: ${name}`);
    try {
      const ctx = { ...baseCtx, db };
      if (tool.needsBackend) {
        // Prefer the canonical projectId (resolves a SHARED backend via project
        // membership); fall back to the legacy (user, projectKey) solo lookup.
        let be = null, role = 'owner';
        if (baseCtx.projectId) {
          be = db.prepare('SELECT * FROM account_backends WHERE project_id = ?').get(baseCtx.projectId);
          if (be) {
            const m = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(baseCtx.projectId, baseCtx.user.id);
            if (!m) be = null;        // not a member → ignore, fall back to own
            else role = m.role;
          }
        }
        if (!be) { be = getAccountBackend(db, baseCtx.user.id, baseCtx.projectKey); role = 'owner'; }
        if (!be || be.status !== 'live') { return ok({ content: [{ type: 'text', text: 'No backend yet for this project — call provision_backend first.' }], isError: true }); }
        if (tool.minRole && !roleAtLeast(role, tool.minRole)) {
          return ok({ content: [{ type: 'text', text: `Forbidden: this tool needs ${tool.minRole} access on this shared project (you are ${role}).` }], isError: true });
        }
        ctx.backendId = be.id;
        ctx.role = role;
      }
      const data = await tool.run(ctx, args);
      return ok({ content: [{ type: 'text', text: JSON.stringify(data) }] });
    } catch (e) {
      return ok({ content: [{ type: 'text', text: String((e && e.message) || e) }], isError: true });
    }
  }
  if (isNotification) return null;
  return rpcErr(-32601, `method not found: ${method}`);
}

/**
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
function registerCloudAccountMcpRoutes(app, db) {
  app.options('/api/cloud/account/mcp', (_req, res) => { cors(res); res.sendStatus(204); });
  app.get('/api/cloud/account/mcp', (_req, res) => { cors(res); res.status(405).json({ error: 'method_not_allowed', message: 'POST JSON-RPC only.' }); });

  app.post('/api/cloud/account/mcp', async (req, res) => {
    const auth = authAccount(req, res, db); if (!auth) return;
    const baseCtx = { user: auth.user, projectKey: auth.projectKey, gatewayBase: `${req.protocol}://${req.get('host')}/api/cloud/be` };
    const body = req.body;
    const batch = Array.isArray(body);
    const msgs = batch ? body : [body];
    const responses = [];
    for (const m of msgs) {
      if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
        responses.push({ jsonrpc: '2.0', id: (m && m.id != null) ? m.id : null, error: { code: -32600, message: 'invalid request' } });
        continue;
      }
      let r;
      try { r = await handleRpc(m, baseCtx, db); }
      catch (e) { r = (m.id == null) ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String((e && e.message) || e) } }; }
      if (r) responses.push(r);
    }
    if (!responses.length) { res.status(202).end(); return; }
    res.json(batch ? responses : responses[0]);
  });
}

module.exports = { registerCloudAccountMcpRoutes };
