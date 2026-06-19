'use strict';

// cloud-mcp.js — per-backend MCP server ("easy connect") for LingCode Cloud.
//
// Exposes each provisioned backend as a Model Context Protocol server so any
// MCP client (Claude Desktop, Cursor, the LingCode IDE, a /try app) can connect
// with ONE URL + the anon key and get the backend's data tools:
//
//   POST https://lingcode.dev/api/cloud/be/<backendId>/mcp
//   Authorization: Bearer <anon_key>
//
// Transport: MCP "Streamable HTTP" in STATELESS JSON mode — every JSON-RPC
// request gets an application/json response. No sessions/SSE because all tools
// are request/response (no server-initiated notifications). The tool logic is
// the existing data plane (RLS-scoped via _asTenant); this file is just the
// protocol wrapper + bearer auth (same posture as cloud-backend.js's proxyAuth).

const dataPlane = require('./cloud-data-plane');
const { getAnyBackendById, ownedPath, purchasedStorageBytesForBackend } = require('./cloud-backend');
const storage = require('./cloud-storage');
const { limitsForTier, computeCapabilities } = require('./cloud-limits');

const SERVER_INFO = { name: 'lingcode-backend', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

function cors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version');
}

// Verify the bearer anon/user key against this backend (mirrors proxyAuth in
// cloud-backend.js). Returns { backendId, userId } or sends the response + null.
function authBackend(req, res, db) {
  cors(res);
  if (!dataPlane.isConfigured()) { res.status(503).json({ error: 'cloud_not_configured' }); return null; }
  const backendId = String(req.params.backendId || '');
  const row = getAnyBackendById(db, backendId); // prototype- or account-owned
  if (!row || row.status !== 'live') { res.status(404).json({ error: 'backend_not_found' }); return null; }
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) { res.set('WWW-Authenticate', 'Bearer'); res.status(401).json({ error: 'missing_key' }); return null; }
  let claims;
  try { claims = dataPlane.verifyTenantJwt(backendId, token); }
  catch { res.status(403).json({ error: 'invalid_token' }); return null; }
  return { backendId, userId: claims.sub || null, tier: row.tier || 'free', db };
}

// Tool registry — each delegates to an existing data-plane fn (RLS-scoped).
const TOOLS = [
  {
    name: 'list_tables',
    description: "List the backend's tables and their columns.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (be) => dataPlane.listTables(be.backendId),
  },
  {
    name: 'query',
    description: 'Run a read-only SQL SELECT (or WITH) and return rows. Writes are rejected — use insert/update/delete.',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'], additionalProperties: false },
    run: (be, a) => {
      const sql = String((a && a.sql) || '');
      const trimmed = sql.trim().replace(/^\(\s*/, '');
      if (!/^(select|with)\s/i.test(trimmed)) { const e = new Error('query is read-only — use insert/update/delete for writes'); e.status = 400; throw e; }
      return dataPlane.runReadOnlyQuery(be.backendId, sql);
    },
  },
  {
    name: 'select',
    description: 'Select rows from ONE table — NO JOINs (fetch tables separately and join in app code; for multi-table or aggregate queries create a VIEW via apply_migration, or use the read-only query tool). Returns at most 200 rows; page with limit/offset. Optional: where (filter), order, limit, offset. where ops: {col:value}=eq, {col:{gt|gte|lt|lte|neq|like|ilike:v}}, {col:{in:[...]}}, {col:{is:"not_null"}}, {col:null}, {col:{not:{...}}}, {col:{cs|cd:[...] }} (array/jsonb contains/contained), {col:{fts:"query"}} (full-text), {or:[{...},{...}]}.',
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, where: { type: 'object' }, order: {}, limit: { type: 'number' }, offset: { type: 'number' } }, required: ['table'], additionalProperties: false },
    run: (be, a) => dataPlane.proxySelect(be.backendId, String((a && a.table) || ''), { where: a && a.where, order: a && a.order, limit: a && a.limit, offset: a && a.offset, userId: be.userId }),
  },
  {
    name: 'insert',
    description: 'Insert a row into ONE table. Returns the inserted row. No upsert / ON CONFLICT — on a duplicate-key error, fetch the row then update instead.',
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, row: { type: 'object' } }, required: ['table', 'row'], additionalProperties: false },
    run: (be, a) => dataPlane.proxyInsert(be.backendId, String((a && a.table) || ''), a && a.row, { userId: be.userId }),
  },
  {
    name: 'update',
    description: 'Update rows matching where with patch. where is REQUIRED (refuses to update all rows). Returns updated rows.',
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, where: { type: 'object' }, patch: { type: 'object' } }, required: ['table', 'where', 'patch'], additionalProperties: false },
    run: (be, a) => dataPlane.proxyUpdate(be.backendId, String((a && a.table) || ''), { where: a && a.where, patch: a && a.patch, userId: be.userId }),
  },
  {
    name: 'delete',
    description: 'Delete rows matching where. where is REQUIRED (refuses to delete all rows). Returns deleted rows.',
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, where: { type: 'object' } }, required: ['table', 'where'], additionalProperties: false },
    run: (be, a) => dataPlane.proxyDelete(be.backendId, String((a && a.table) || ''), { where: a && a.where, userId: be.userId }),
  },
  {
    name: 'list_functions',
    description: 'List the backend\'s built-in serverless function templates (call one from app code via client.functions.invoke(slug, input)). Includes send-email, elevenlabs-tts (text→speech; needs an ELEVENLABS_API_KEY secret), stripe-checkout (create a Stripe Checkout Session → { url }; needs a STRIPE_SECRET_KEY secret), and http-fetch (call an allow-listed external API with a {{SECRET}} header). The owner sets secrets + the http-fetch allow-list in the backend console.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => require('./cloud-functions').listTemplates(),
  },
  {
    name: 'text_search',
    description: 'Full-text search: rank rows of a table by relevance to a query against a text column. Set is_tsvector:true if column is already a generated tsvector column.',
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, column: { type: 'string' }, query: { type: 'string' }, is_tsvector: { type: 'boolean' }, limit: { type: 'number' } }, required: ['table', 'column', 'query'], additionalProperties: false },
    run: (be, a) => dataPlane.textSearch(be.backendId, { table: String((a && a.table) || ''), column: String((a && a.column) || ''), query: String((a && a.query) || ''), isTsvector: !!(a && a.is_tsvector), limit: a && a.limit, userId: be.userId }),
  },
  {
    name: 'hybrid_search',
    description: 'Hybrid search: fuse full-text and vector similarity with reciprocal rank fusion. Requires both a text query and its precomputed embedding (array of numbers). text_column is a text column; vector_column is a vector(N) column.',
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, text_column: { type: 'string' }, vector_column: { type: 'string' }, query: { type: 'string' }, embedding: { type: 'array', items: { type: 'number' } }, id_column: { type: 'string' }, text_is_tsvector: { type: 'boolean' }, metric: { type: 'string' }, limit: { type: 'number' } }, required: ['table', 'text_column', 'vector_column', 'query', 'embedding'], additionalProperties: false },
    run: (be, a) => dataPlane.hybridSearch(be.backendId, { table: String((a && a.table) || ''), textColumn: String((a && a.text_column) || ''), vectorColumn: String((a && a.vector_column) || ''), query: String((a && a.query) || ''), embedding: a && a.embedding, idColumn: (a && a.id_column) || null, textIsTsvector: !!(a && a.text_is_tsvector), metric: a && a.metric, limit: a && a.limit, userId: be.userId }),
  },
  {
    name: 'describe_backend',
    description: "Describe this backend's capabilities and quotas. Covers the SERVER-SIDE COMPUTE TIER (compute): an encrypted secrets vault, built-in + custom serverless functions with their per-tier timeout, and full-stack Worker/SSR app hosting — so secrets, Stripe, email, and most server logic can run on LingCode Cloud WITHOUT an external server (don't tell users to keep a separate host without checking this). Also covers the file-storage caps (maxObjectBytes for the inline base64 upload path, maxUploadBytes for the direct-to-Spaces presigned-PUT path, maxObjects, maxStorageBytes for the backend's total stored bytes across all objects), the public/private storage buckets, whether direct upload is available, and the other per-tier limits (tables/users/functions/emails). Call this to learn what the backend can actually do — e.g. whether a large file fits, or whether server code can move here — instead of guessing.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (be) => {
      const lim = limitsForTier(be.tier);
      const purchased = purchasedStorageBytesForBackend(be.db, be.backendId);
      return {
        tier: be.tier,
        storage: {
          directUpload: storage.isConfigured(),
          buckets: ['public', 'private'],
          maxObjectBytes: lim.maxObjectBytes,   // inline base64 path (/storage/upload)
          maxUploadBytes: lim.maxUploadBytes,    // direct-to-Spaces path (create-upload-url → finalize)
          maxObjects: lim.maxObjects,
          maxStorageBytes: lim.maxStorageBytes,  // tier total bytes across all objects (per backend)
          purchasedStorageBytes: purchased,      // à-la-carte add-on (Model B)
          effectiveStorageBytes: lim.maxStorageBytes + purchased, // what's actually enforced
          perUserIsolation: 'private bucket is namespaced + access-gated per signed-in user; public bucket is shared/world-readable',
        },
        compute: computeCapabilities(be.tier),
        limits: lim,
      };
    },
  },
  {
    name: 'storage_list',
    description: 'List stored files (objects) visible to the signed-in user (their own private files + shared/public files): bucket, path, content_type, bytes, created_at. Up to 500, newest first.',
    inputSchema: { type: 'object', properties: { bucket: { type: 'string' } }, additionalProperties: false },
    run: (be, a) => {
      const bucket = a && a.bucket ? String(a.bucket) : null;
      // Owner-scope: a signed-in user sees their own objects + shared (owner NULL).
      const rows = bucket
        ? be.db.prepare('SELECT bucket, path, content_type, bytes, created_at FROM backend_objects WHERE backend_id=? AND bucket=? AND (owner_user_id IS ? OR owner_user_id IS NULL) ORDER BY created_at DESC LIMIT 500').all(be.backendId, bucket, be.userId)
        : be.db.prepare('SELECT bucket, path, content_type, bytes, created_at FROM backend_objects WHERE backend_id=? AND (owner_user_id IS ? OR owner_user_id IS NULL) ORDER BY created_at DESC LIMIT 500').all(be.backendId, be.userId);
      // Present logical paths (strip the per-user u_<userId>/ prefix).
      const prefix = be.userId ? `u_${be.userId}/` : null;
      return { objects: rows.map((r) => (prefix && r.bucket !== 'public' && r.path.startsWith(prefix)) ? { ...r, path: r.path.slice(prefix.length) } : r) };
    },
  },
  {
    name: 'storage_create_upload_url',
    description: "Mint a short-lived presigned PUT URL so app code uploads a file's bytes DIRECTLY to object storage (bypassing the size limit of the inline base64 path — this is how GB-scale files like video/audio recordings work). Private-bucket uploads are isolated to the signed-in user. Returns { uploadUrl, method, headers, bucket, path }: the app PUTs the file to uploadUrl with exactly those headers, then calls /api/cloud/be/<id>/storage/finalize (bucket, path) to register it. Requires object storage to be configured.",
    inputSchema: { type: 'object', properties: { bucket: { type: 'string' }, path: { type: 'string' }, content_type: { type: 'string' } }, required: ['path'], additionalProperties: false },
    run: async (be, a) => {
      if (!storage.isConfigured()) { const e = new Error('object storage not configured; use the base64 storage/upload path'); e.status = 409; throw e; }
      const bucket = (a && a.bucket) ? String(a.bucket) : 'public';
      const path = String((a && a.path) || '');
      const signed = await storage.presignPut(be.backendId, bucket, ownedPath(bucket, be.userId, path), a && a.content_type);
      return { uploadUrl: signed.url, method: 'PUT', headers: signed.headers, bucket, path, finalizeWith: `POST /api/cloud/be/${be.backendId}/storage/finalize { bucket, path }` };
    },
  },
  {
    name: 'storage_remove',
    description: 'Delete a stored file (object) by bucket + path (your own, for private files). Removes it from object storage and its metadata row.',
    inputSchema: { type: 'object', properties: { bucket: { type: 'string' }, path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    run: async (be, a) => {
      const bucket = (a && a.bucket) ? String(a.bucket) : 'public';
      const path = String((a && a.path) || '');
      const stored = ownedPath(bucket, be.userId, path);
      if (storage.isConfigured()) { try { await storage.removeObject(be.backendId, bucket, stored); } catch (_) { /* metadata delete still proceeds */ } }
      be.db.prepare('DELETE FROM backend_objects WHERE backend_id=? AND bucket=? AND path=?').run(be.backendId, bucket, stored);
      return { removed: true, bucket, path };
    },
  },
];

// Handle one JSON-RPC message. Returns a response object, or null for
// notifications (which get no response).
async function handleRpc(msg, be) {
  const id = msg.id;
  const isNotification = (id === undefined || id === null);
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const rpcErr = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  const method = msg.method;

  if (method === 'initialize') {
    return ok({
      protocolVersion: (msg.params && msg.params.protocolVersion) || DEFAULT_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'ping') return ok({});
  if (typeof method === 'string' && method.startsWith('notifications/')) return null; // notifications: no reply
  if (method === 'tools/list') {
    return ok({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcErr(-32602, `unknown tool: ${name}`);
    try {
      const data = await tool.run(be, args);
      return ok({ content: [{ type: 'text', text: JSON.stringify(data) }] });
    } catch (e) {
      // MCP convention: tool failures come back as an isError result (so the
      // model sees the error), not a transport-level JSON-RPC error.
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
function registerCloudMcpRoutes(app, db) {
  app.options('/api/cloud/be/:backendId/mcp', (_req, res) => { cors(res); res.sendStatus(204); });

  // Stateless: no GET/SSE stream, no sessions.
  app.get('/api/cloud/be/:backendId/mcp', (_req, res) => {
    cors(res);
    res.status(405).json({ error: 'method_not_allowed', message: 'POST JSON-RPC only; SSE/sessions not supported.' });
  });

  app.post('/api/cloud/be/:backendId/mcp', async (req, res) => {
    const be = authBackend(req, res, db); if (!be) return;
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
      try { r = await handleRpc(m, be); }
      catch (e) { r = (m.id == null) ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String((e && e.message) || e) } }; }
      if (r) responses.push(r);
    }
    if (!responses.length) { res.status(202).end(); return; } // batch of only notifications
    res.json(batch ? responses : responses[0]);
  });
}

module.exports = { registerCloudMcpRoutes };
