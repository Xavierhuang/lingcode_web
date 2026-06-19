'use strict';

// cloud-data-plane.js — control-plane client for the LingCode Cloud data
// plane (website/cloud-infra/). Mirrors the method shapes of
// supabase-management.js, but instead of proxying Supabase SaaS it talks
// directly to our OWN Postgres as the `cloud_admin` role to provision
// schemas + roles, and runs tenant queries as the per-tenant role.
//
// Isolation: each backend = a Postgres schema `be_<id>` + a NOLOGIN role
// `trole_<id>` with USAGE on that schema only. Tenant data access runs
// `SET LOCAL ROLE trole_<id>` so it can never reach another schema. The
// per-tenant anon JWT (HS256, signed with CLOUD_JWT_SECRET) carries
// `{ role: 'trole_<id>' }`.
//
// Config (env, see website/cloud-infra/README.md):
//   CLOUD_PG_ADMIN_URL   postgres://cloud_admin:...@host:5544/lingcloud
//   CLOUD_JWT_SECRET     >= 32 chars, also configured on PostgREST (Phase 2)
//   CLOUD_POSTGREST_URL  Phase-2 gateway base (unused on the Phase-1 path)
//
// Service credentials (the admin connection string, the JWT secret) live
// only here. Nothing in this module returns them to a caller.

const crypto = require('crypto');
const EventEmitter = require('events');

// ---- realtime change bus ---------------------------------------------
// In-process pub/sub that SSE subscribers attach to. Every write path
// (REST + MCP) funnels through proxyInsert/Update/Delete below, so we catch ALL
// mutations regardless of how they arrived.
//
// CROSS-PROCESS: the bus is fed by Postgres LISTEN/NOTIFY, not by emitting
// locally. emitChange() issues NOTIFY; a dedicated LISTEN connection in EVERY
// API process receives it and re-emits onto its local realtimeBus, so a write
// handled by process A reaches SSE subscribers on process B. This is what makes
// the API safe to run multi-process (which connection pooling unblocked).
const realtimeBus = new EventEmitter();
realtimeBus.setMaxListeners(0); // unbounded SSE subscribers

const REALTIME_CHANNEL = 'lingcloud_change';
// Postgres NOTIFY caps the payload at 8000 bytes; leave headroom for the JSON
// envelope. Rows bigger than this are notified without their body (oversized).
const NOTIFY_MAX = 7900;

let _listenClient = null;
let _listenStarted = false;
let _listenReconnectTimer = null;

// Bring up the dedicated LISTEN connection (idempotent). Called when a process
// first writes (emitChange) or first gains an SSE subscriber. A process with no
// subscribers and no writes never needs it.
function ensureRealtimeListener() {
  if (_listenStarted) return;
  if (!process.env.CLOUD_PG_DIRECT_URL && !process.env.CLOUD_PG_ADMIN_URL) return;
  _listenStarted = true;
  _startRealtimeListen();
}

function _startRealtimeListen() {
  let Client;
  try { ({ Client } = require('pg')); } catch (_) { _listenStarted = false; return; }
  // LISTEN needs a stable, session-scoped connection. CLOUD_PG_ADMIN_URL may
  // point at PgBouncer (transaction pooling), which silently breaks LISTEN —
  // so prefer CLOUD_PG_DIRECT_URL (straight to Postgres). Falls back to the
  // admin URL for local dev, where it already points directly at Postgres.
  const connectionString = process.env.CLOUD_PG_DIRECT_URL || process.env.CLOUD_PG_ADMIN_URL;
  const client = new Client({ connectionString, keepAlive: true });
  _listenClient = client;
  client.on('notification', (msg) => {
    if (msg.channel !== REALTIME_CHANNEL || !msg.payload) return;
    let ev; try { ev = JSON.parse(msg.payload); } catch (_) { return; }
    try {
      realtimeBus.emit('change', {
        backendId: ev.b, table: ev.t, type: ev.y,
        row: (ev.r === undefined ? null : ev.r),
        oversized: !!ev.o,
      });
    } catch (_) {}
  });
  client.on('error', (err) => _scheduleRealtimeReconnect('error', err));
  client.on('end', () => _scheduleRealtimeReconnect('end'));
  client.connect()
    .then(() => client.query(`LISTEN ${REALTIME_CHANNEL}`))
    .then(() => { try { console.log('[cloud-data-plane] realtime LISTEN active'); } catch (_) {} })
    .catch((err) => _scheduleRealtimeReconnect('connect', err));
}

function _scheduleRealtimeReconnect(why, err) {
  if (_listenReconnectTimer) return; // already pending
  try { console.error(`[cloud-data-plane] realtime listener ${why}:`, err && err.message); } catch (_) {}
  const dead = _listenClient; _listenClient = null;
  try { if (dead) { dead.removeAllListeners(); dead.end().catch(() => {}); } } catch (_) {}
  _listenReconnectTimer = setTimeout(() => { _listenReconnectTimer = null; _startRealtimeListen(); }, 2000);
}

// emitChange keeps its signature (callers unchanged). It now publishes via
// NOTIFY instead of emitting locally; the LISTEN connection above re-emits onto
// realtimeBus — including in THIS process, so local subscribers still get it.
function emitChange(backendId, table, type, rows) {
  if (!rows || !rows.length) return;
  ensureRealtimeListener();
  let pool; try { pool = getPool(); } catch (_) { return; }
  for (const row of rows) {
    let payload = JSON.stringify({ b: backendId, t: table, y: type, r: row });
    if (payload.length > NOTIFY_MAX) {
      // Too big for one NOTIFY. Send a body-less, oversized-flagged event:
      // owner subscribers get a refetch signal; RLS (app) subscribers drop it
      // because canTenantSeeRow needs the row to probe visibility.
      try { console.warn(`[cloud-data-plane] realtime row oversized (${payload.length}B) ${table}/${type}; sending refetch signal`); } catch (_) {}
      payload = JSON.stringify({ b: backendId, t: table, y: type, o: 1 });
    }
    pool.query('SELECT pg_notify($1, $2)', [REALTIME_CHANNEL, payload])
      .catch((err) => { try { console.error('[cloud-data-plane] pg_notify failed:', err && err.message); } catch (_) {} });
  }
}

// Heavy deps (jsonwebtoken, bcrypt, pg) are lazy-required so the API server
// still boots when LingCode Cloud is unconfigured or its npm deps aren't
// installed yet. They're only pulled in when a Cloud operation actually runs.
let _jwt = null;
function jwtLib() { return (_jwt = _jwt || require('jsonwebtoken')); }
let _bcrypt = null;
function bcryptLib() { return (_bcrypt = _bcrypt || require('bcrypt')); }

let _Pool = null;
let _pool = null;

function isConfigured() {
  return !!(process.env.CLOUD_PG_ADMIN_URL && getJwtSecretOrNull());
}

function getJwtSecretOrNull() {
  const s = process.env.CLOUD_JWT_SECRET;
  return (typeof s === 'string' && s.length >= 32) ? s : null;
}

// Per-statement wall-clock cap (ms) for tenant data queries, applied as a
// transaction-local SET LOCAL in the wrappers below. Keeps a wedged user query
// from holding a pooled server connection open forever. 0 disables.
const STATEMENT_TIMEOUT_MS = Number(process.env.CLOUD_PG_STATEMENT_TIMEOUT_MS || 30000);

function getPool() {
  if (_pool) return _pool;
  if (!process.env.CLOUD_PG_ADMIN_URL) throw new Error('CLOUD_PG_ADMIN_URL not set');
  if (!_Pool) {
    // Lazy require so the server still boots without `pg` installed when the
    // Cloud feature is unconfigured.
    _Pool = require('pg').Pool;
  }
  // CLOUD_PG_ADMIN_URL points at PgBouncer (transaction pooling), so the real
  // client fan-in lives in PgBouncer — keep this per-process pool small. Cap
  // acquisition + idle lifetime so a process can't sit on connections or block
  // a request forever waiting for one.
  _pool = new _Pool({
    connectionString: process.env.CLOUD_PG_ADMIN_URL,
    max: Number(process.env.CLOUD_PG_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.CLOUD_PG_IDLE_MS || 30000),
    connectionTimeoutMillis: Number(process.env.CLOUD_PG_CONN_TIMEOUT_MS || 10000),
  });
  // A pooled connection that errors out-of-band must not crash the process.
  _pool.on('error', (err) => {
    try { console.error('[cloud-data-plane] idle pg client error:', err && err.message); } catch (_) {}
  });
  return _pool;
}

// Pool snapshot for /api/health/deep + Prometheus gauges. Safe before the pool
// exists (returns zeros) so it can be wired at boot.
function poolStats() {
  return _pool
    ? { total: _pool.totalCount, idle: _pool.idleCount, waiting: _pool.waitingCount }
    : { total: 0, idle: 0, waiting: 0 };
}

// Readiness probe: acquire a connection and SELECT 1. Throws if the data plane
// (PgBouncer/Postgres) is unreachable. Returns pool stats on success.
async function probe() {
  const pool = getPool();
  const client = await pool.connect();
  try { await client.query('SELECT 1'); }
  finally { client.release(); }
  return { ok: true, pool: poolStats() };
}

// Lazy, optional metrics hook — no-op if prom-client/metrics.js is unavailable.
// metrics.js does NOT require this module, so there's no require cycle.
let _metrics; // undefined = not yet tried, null = unavailable
function metricsLib() {
  if (_metrics === undefined) { try { _metrics = require('./metrics'); } catch (_) { _metrics = null; } }
  return _metrics;
}
// Record a tenant/admin query duration and warn when slow. Called from the
// transaction wrappers around the caller's actual query work.
function recordQuery(op, startMs) {
  const ms = Date.now() - startMs;
  const m = metricsLib();
  if (m) { try { m.observeQuery(op, ms / 1000); } catch (_) {} }
  const slow = m && typeof m.slowQueryMs === 'function' ? m.slowQueryMs() : 500;
  if (ms >= slow) { try { console.warn(`[cloud-data-plane] slow ${op} query: ${ms}ms`); } catch (_) {} }
}

// backendId is generated as lowercase hex by the control plane; validate
// defensively so it can only ever produce safe SQL identifiers.
function assertBackendId(backendId) {
  if (!/^[a-f0-9]{8,40}$/.test(String(backendId || ''))) {
    throw new Error('invalid backend id');
  }
}
function schemaName(backendId) { assertBackendId(backendId); return `be_${backendId}`; }
function roleName(backendId) { assertBackendId(backendId); return `trole_${backendId}`; }

// Names are validated to [a-z0-9_] so simple double-quoting is safe.
function qIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

function badRequest(message) { const e = new Error(message); e.status = 400; return e; }

// ---- safe filter builder (WHERE / ORDER BY for the data proxy) ---------
// Compiles a filter object into a parameterized WHERE clause. The three
// injection-safety invariants: column names go through qIdent() (validated
// identifiers, double-quoted); operators are looked up in this fixed allow-list
// (never interpolated from input); every value is a $n placeholder. No user
// value is ever concatenated into the SQL string.
const FILTER_OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' };
const CONTAINS_OPS = { cs: '@>', cd: '<@' }; // contains / contained-by (array + jsonb)

// Compile a single { op: val } condition on an already-quoted column `c` into a
// SQL clause string, pushing bound values into ctx.values and advancing ctx.i.
// Operators come only from the fixed allow-lists above (never interpolated),
// values are always $n placeholders — the same injection-safety invariants as
// buildWhere. Mirrors PostgREST's operator vocabulary.
function compileOp(c, op, val, ctx) {
  if (op === 'not') {
    // Negation wrapper: { not: { in: [...] } } → NOT ("col" = ANY($n))
    if (!val || typeof val !== 'object' || Array.isArray(val)) throw badRequest('"not" expects a condition object');
    const inner = Object.entries(val).map(([o, v]) => compileOp(c, o, v, ctx));
    return `NOT (${inner.join(' AND ')})`;
  }
  if (op === 'is') {
    if (val === null) return `${c} IS NULL`;
    if (val === 'not_null') return `${c} IS NOT NULL`;
    throw badRequest(`unsupported "is" value: ${val}`);
  }
  if (op === 'in') {
    if (!Array.isArray(val)) throw badRequest('"in" expects an array');
    ctx.values.push(val); return `${c} = ANY($${++ctx.i})`;
  }
  if (op === 'fts') {
    // Full-text match against a text column (dedicated text/hybridSearch handle
    // pre-built tsvector columns). websearch_to_tsquery parses Google-style input.
    if (typeof val !== 'string') throw badRequest('"fts" expects a string query');
    ctx.values.push(val); return `to_tsvector(${c}::text) @@ websearch_to_tsquery($${++ctx.i})`;
  }
  if (CONTAINS_OPS[op]) {
    // A plain object is treated as a jsonb operand; arrays/scalars bind as-is
    // (node-postgres serialises JS arrays to Postgres array literals).
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      ctx.values.push(JSON.stringify(val)); return `${c} ${CONTAINS_OPS[op]} $${++ctx.i}::jsonb`;
    }
    ctx.values.push(val); return `${c} ${CONTAINS_OPS[op]} $${++ctx.i}`;
  }
  const sqlOp = FILTER_OPS[op];
  if (!sqlOp) throw badRequest(`unsupported operator: ${op}`);
  ctx.values.push(val); return `${c} ${sqlOp} $${++ctx.i}`;
}

// Compile a filter object into an array of AND-joined clause strings, sharing
// ctx ({ values, i }) so placeholder numbering stays correct across recursion
// (used by the `or` branch below). Top-level keys are columns, except the
// reserved `or` key which groups sub-filters with OR.
function buildClauses(filters, ctx) {
  if (typeof filters !== 'object' || Array.isArray(filters)) throw badRequest('where must be an object');
  const clauses = [];
  for (const [key, cond] of Object.entries(filters)) {
    if (key === 'or') {
      if (!Array.isArray(cond) || !cond.length) throw badRequest('"or" expects a non-empty array of filter objects');
      const branches = cond.map((branch) => {
        const inner = buildClauses(branch, ctx);
        if (!inner.length) throw badRequest('"or" branch must contain at least one condition');
        return inner.length > 1 ? `(${inner.join(' AND ')})` : inner[0];
      });
      clauses.push(`(${branches.join(' OR ')})`);
      continue;
    }
    const c = qIdent(key); // validates the column identifier (throws on anything unsafe)
    if (cond === null) { clauses.push(`${c} IS NULL`); continue; }
    if (typeof cond !== 'object' || Array.isArray(cond)) {
      ctx.values.push(cond); clauses.push(`${c} = $${++ctx.i}`); continue; // shorthand eq
    }
    for (const [op, val] of Object.entries(cond)) clauses.push(compileOp(c, op, val, ctx));
  }
  return clauses;
}

// filters (PostgREST-style subset):
//   { col: value }                   → "col" = $n            (shorthand eq)
//   { col: null }                    → "col" IS NULL
//   { col: { gte: 5, lt: 10 } }      → "col" >= $n AND "col" < $n
//   { col: { in: [1, 2] } }          → "col" = ANY($n)
//   { col: { is: null | 'not_null' } } → "col" IS [NOT] NULL
//   { col: { not: { in: [1,2] } } }  → NOT ("col" = ANY($n))
//   { col: { cs: [1,2] } }           → "col" @> $n           (contains; array/jsonb)
//   { col: { cd: {...} } }           → "col" <@ $n::jsonb    (contained by)
//   { col: { fts: 'foo bar' } }      → to_tsvector("col"::text) @@ websearch_to_tsquery($n)
//   { or: [ {a:1}, {b:2} ] }         → (("a" = $n) OR ("b" = $n))
// Returns { sql: '' | 'WHERE …', values, nextIdx }. nextIdx lets callers (UPDATE)
// reserve $1..$k for the SET list before the WHERE placeholders begin.
function buildWhere(filters, startIdx = 0) {
  if (filters == null) return { sql: '', values: [], nextIdx: startIdx };
  if (typeof filters !== 'object' || Array.isArray(filters)) throw badRequest('where must be an object');
  const ctx = { values: [], i: startIdx };
  const clauses = buildClauses(filters, ctx);
  return { sql: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', values: ctx.values, nextIdx: ctx.i };
}

// order: 'col' | { column, ascending } | array of either → "ORDER BY …".
function buildOrder(order) {
  if (!order) return '';
  const items = Array.isArray(order) ? order : [order];
  const parts = items.map((o) => {
    const col = typeof o === 'string' ? o : (o && o.column);
    if (!col) throw badRequest('order requires a column');
    const dir = (typeof o === 'object' && o.ascending === false) ? 'DESC' : 'ASC';
    return `${qIdent(col)} ${dir}`;
  });
  return parts.length ? 'ORDER BY ' + parts.join(', ') : '';
}

// ---- provisioning -----------------------------------------------------

async function provisionBackend(backendId) {
  const schema = schemaName(backendId);
  const role = roleName(backendId);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${qIdent(schema)}`);
    // Roles are cluster-global; CREATE ROLE has no IF NOT EXISTS, so guard.
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
        EXECUTE 'CREATE ROLE ${qIdent(role)} NOLOGIN';
      END IF;
    END $$;`);
    await client.query(`GRANT USAGE ON SCHEMA ${qIdent(schema)} TO ${qIdent(role)}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${qIdent(schema)} TO ${qIdent(role)}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${qIdent(schema)} TO ${qIdent(role)}`);
    // Future tables/sequences created in this schema auto-grant to the role.
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${qIdent(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${qIdent(role)}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${qIdent(schema)} GRANT USAGE, SELECT ON SEQUENCES TO ${qIdent(role)}`);
    // Auth (Phase 3): a per-tenant users table the control plane manages.
    // Owned by admin; the tenant role gets no direct grants (signup/signin
    // run server-side), so app code can't read password hashes.
    await client.query(`CREATE TABLE IF NOT EXISTS ${qIdent(schema)}.auth_users (
      id            uuid PRIMARY KEY,
      email         text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    )`);
    // Refresh tokens (rotation + reuse detection) and MFA factors. Admin-owned
    // like auth_users — the tenant role gets no grants, so app code can never
    // read a token hash or a TOTP secret. (ensureAuthTables backfills these for
    // backends provisioned before this shipped.)
    await client.query(`CREATE TABLE IF NOT EXISTS ${qIdent(schema)}.auth_refresh_tokens (
      id          uuid PRIMARY KEY,
      user_id     uuid NOT NULL,
      family_id   uuid NOT NULL,
      token_hash  text UNIQUE NOT NULL,
      parent_id   uuid,
      revoked     boolean NOT NULL DEFAULT false,
      created_at  timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS auth_rt_user_idx ON ${qIdent(schema)}.auth_refresh_tokens (user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS auth_rt_family_idx ON ${qIdent(schema)}.auth_refresh_tokens (family_id)`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${qIdent(schema)}.auth_mfa_factors (
      id          uuid PRIMARY KEY,
      user_id     uuid NOT NULL,
      type        text NOT NULL DEFAULT 'totp',
      secret      text NOT NULL,
      verified    boolean NOT NULL DEFAULT false,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS auth_mfa_user_idx ON ${qIdent(schema)}.auth_mfa_factors (user_id)`);
    // Let PostgREST's authenticator SET ROLE into this tenant (Phase 2). The
    // admin (superuser) can already SET ROLE without an explicit grant.
    await client.query(`DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
        EXECUTE 'GRANT ${qIdent(role)} TO authenticator';
      END IF;
    END $$;`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { schema, role };
}

async function dropBackend(backendId) {
  const schema = schemaName(backendId);
  const role = roleName(backendId);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${qIdent(schema)} CASCADE`);
    await client.query(`DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
        EXECUTE 'DROP ROLE ${qIdent(role)}';
      END IF;
    END $$;`);
  } finally {
    client.release();
  }
}

// ---- JWT --------------------------------------------------------------

function mintAnonJwt(backendId) {
  const secret = getJwtSecretOrNull();
  if (!secret) throw new Error('CLOUD_JWT_SECRET not set');
  // No expiry: anon key is public-by-design and long-lived (rotate in Phase 2).
  return jwtLib().sign({ role: roleName(backendId) }, secret, { algorithm: 'HS256' });
}

// User JWT: same tenant role (schema isolation) + a `sub` (user id) + email,
// so the data proxy can pin app.user_id for RLS. `aal` (authenticator assurance
// level) is 'aal1' after password/OTP sign-in and 'aal2' once a TOTP factor is
// verified this session.
//
// Lifetime is CLOUD_ACCESS_TOKEN_TTL. The default stays at the historical 7d so
// shipping refresh-token rotation can NOT log out apps still running the older
// cached SDK (which has no refresh logic). Once the refresh-capable SDK has
// propagated, set CLOUD_ACCESS_TOKEN_TTL='1h' to get genuinely short-lived
// access tokens — the SDK then refreshes transparently.
function accessTokenTtl() {
  const t = process.env.CLOUD_ACCESS_TOKEN_TTL;
  return (typeof t === 'string' && t.trim()) ? t.trim() : '7d';
}
function mintUserJwt(backendId, user, { aal = 'aal1' } = {}) {
  const secret = getJwtSecretOrNull();
  if (!secret) throw new Error('CLOUD_JWT_SECRET not set');
  return jwtLib().sign(
    { role: roleName(backendId), sub: user.id, email: user.email, aal },
    secret, { algorithm: 'HS256', expiresIn: accessTokenTtl() });
}

// Verifies a token (anon OR user) and confirms its `role` matches this
// backend's tenant role. Returns the full payload (with optional sub/email).
function verifyTenantJwt(backendId, token) {
  const secret = getJwtSecretOrNull();
  if (!secret) throw new Error('CLOUD_JWT_SECRET not set');
  const payload = jwtLib().verify(token, secret, { algorithms: ['HS256'] });
  if (!payload || payload.role !== roleName(backendId)) {
    const e = new Error('token does not match backend');
    e.status = 403;
    throw e;
  }
  return payload;
}

// ---- tenant auth (Phase 3) --------------------------------------------

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function createTenantUser(backendId, email, password) {
  const schema = schemaName(backendId);
  if (!EMAIL_RE.test(String(email || ''))) { const e = new Error('invalid email'); e.status = 400; throw e; }
  if (typeof password !== 'string' || password.length < 6) { const e = new Error('password too short (min 6)'); e.status = 400; throw e; }
  const id = crypto.randomUUID();
  const hash = await bcryptLib().hash(password, 10);
  const pool = getPool();
  try {
    await pool.query(`INSERT INTO ${qIdent(schema)}.auth_users (id, email, password_hash) VALUES ($1, $2, $3)`, [id, email, hash]);
  } catch (err) {
    if (/duplicate key/i.test(err.message)) { const e = new Error('email already registered'); e.status = 409; throw e; }
    throw err;
  }
  return { id, email };
}

async function verifyTenantUser(backendId, email, password) {
  const schema = schemaName(backendId);
  const pool = getPool();
  const r = await pool.query(`SELECT id, email, password_hash FROM ${qIdent(schema)}.auth_users WHERE email = $1`, [email]);
  const row = r.rows[0];
  if (!row || !(await bcryptLib().compare(String(password || ''), row.password_hash))) {
    const e = new Error('invalid credentials'); e.status = 401; throw e;
  }
  return { id: row.id, email: row.email };
}

async function listTenantUsers(backendId) {
  const schema = schemaName(backendId);
  const pool = getPool();
  const r = await pool.query(`SELECT id, email, created_at FROM ${qIdent(schema)}.auth_users ORDER BY created_at DESC LIMIT 500`);
  return r.rows;
}

async function getTenantUserById(backendId, userId) {
  const schema = schemaName(backendId);
  const r = await getPool().query(`SELECT id, email FROM ${qIdent(schema)}.auth_users WHERE id = $1`, [userId]);
  return r.rows[0] || null;
}

async function deleteTenantUser(backendId, userId) {
  const schema = schemaName(backendId);
  const pool = getPool();
  await pool.query(`DELETE FROM ${qIdent(schema)}.auth_users WHERE id = $1`, [userId]);
  return { ok: true };
}

// Find a tenant user by email, or create a passwordless one — for magic-link
// sign-in, where there may be no password. New users get a random, unusable
// bcrypt hash so password sign-in can never match them.
async function getOrCreateTenantUserByEmail(backendId, email) {
  const schema = schemaName(backendId);
  if (!EMAIL_RE.test(String(email || ''))) { const e = new Error('invalid email'); e.status = 400; throw e; }
  const pool = getPool();
  const found = await pool.query(`SELECT id, email FROM ${qIdent(schema)}.auth_users WHERE email = $1`, [email]);
  if (found.rows[0]) return { id: found.rows[0].id, email: found.rows[0].email };
  const id = crypto.randomUUID();
  const hash = await bcryptLib().hash(crypto.randomBytes(24).toString('hex'), 10);
  try {
    await pool.query(`INSERT INTO ${qIdent(schema)}.auth_users (id, email, password_hash) VALUES ($1, $2, $3)`, [id, email, hash]);
  } catch (err) {
    // Lost a race with a concurrent create — re-read and return the existing row.
    if (/duplicate key/i.test(err.message)) {
      const r = await pool.query(`SELECT id, email FROM ${qIdent(schema)}.auth_users WHERE email = $1`, [email]);
      if (r.rows[0]) return { id: r.rows[0].id, email: r.rows[0].email };
    }
    throw err;
  }
  return { id, email };
}

// ---- refresh tokens + MFA (auth hardening) ----------------------------
// Borrows GoTrue's patterns (not its Go code): short-lived access JWTs backed
// by rotating opaque refresh tokens with reuse detection, plus TOTP MFA. Token
// hashes and TOTP secrets live in admin-owned tables the tenant role can't read.

const _totp = require('./cloud-totp');
function _hashToken(raw) { return crypto.createHash('sha256').update(String(raw)).digest('hex'); }
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Idempotently create the auth-hardening tables for a backend provisioned
// before this shipped. Memoised so it costs one round-trip per backend.
const _authTablesReady = new Set();
async function ensureAuthTables(backendId) {
  if (_authTablesReady.has(backendId)) return;
  const s = qIdent(schemaName(backendId));
  // Multiple statements in one parameter-free query — pg simple-query protocol.
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS ${s}.auth_refresh_tokens (
       id uuid PRIMARY KEY, user_id uuid NOT NULL, family_id uuid NOT NULL,
       token_hash text UNIQUE NOT NULL, parent_id uuid,
       revoked boolean NOT NULL DEFAULT false,
       created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL);
     CREATE INDEX IF NOT EXISTS auth_rt_user_idx ON ${s}.auth_refresh_tokens (user_id);
     CREATE INDEX IF NOT EXISTS auth_rt_family_idx ON ${s}.auth_refresh_tokens (family_id);
     CREATE TABLE IF NOT EXISTS ${s}.auth_mfa_factors (
       id uuid PRIMARY KEY, user_id uuid NOT NULL, type text NOT NULL DEFAULT 'totp',
       secret text NOT NULL, verified boolean NOT NULL DEFAULT false,
       created_at timestamptz NOT NULL DEFAULT now());
     CREATE INDEX IF NOT EXISTS auth_mfa_user_idx ON ${s}.auth_mfa_factors (user_id);`);
  _authTablesReady.add(backendId);
}

// Mint a new opaque refresh token in `familyId` (a fresh family if omitted).
// Returns the RAW token (only the sha256 is stored).
async function issueRefreshToken(backendId, userId, { familyId = null, parentId = null } = {}) {
  await ensureAuthTables(backendId);
  const s = qIdent(schemaName(backendId));
  const raw = crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  const fam = familyId || crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();
  await getPool().query(
    `INSERT INTO ${s}.auth_refresh_tokens (id, user_id, family_id, token_hash, parent_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`, [id, userId, fam, _hashToken(raw), parentId, expiresAt]);
  return { token: raw, id, familyId: fam, expiresAt };
}

// Rotate-on-use: revoke the presented token and issue its successor in the same
// family. If a token that was ALREADY revoked is presented, that's a replay —
// revoke the entire family (defends against a stolen-then-rotated token).
async function rotateRefreshToken(backendId, rawToken) {
  await ensureAuthTables(backendId);
  const s = qIdent(schemaName(backendId));
  const pool = getPool();
  const r = await pool.query(
    `SELECT id, user_id, family_id, revoked, expires_at FROM ${s}.auth_refresh_tokens WHERE token_hash = $1`,
    [_hashToken(rawToken)]);
  const row = r.rows[0];
  if (!row) { const e = new Error('invalid refresh token'); e.status = 401; throw e; }
  if (row.revoked) {
    await pool.query(`UPDATE ${s}.auth_refresh_tokens SET revoked = true WHERE family_id = $1`, [row.family_id]);
    const e = new Error('refresh token reuse detected'); e.status = 401; throw e;
  }
  if (new Date(row.expires_at).getTime() < Date.now()) { const e = new Error('refresh token expired'); e.status = 401; throw e; }
  await pool.query(`UPDATE ${s}.auth_refresh_tokens SET revoked = true WHERE id = $1`, [row.id]);
  const next = await issueRefreshToken(backendId, row.user_id, { familyId: row.family_id, parentId: row.id });
  return { userId: row.user_id, token: next.token, familyId: row.family_id, expiresAt: next.expiresAt };
}

// Revoke a single refresh token (sign-out of one session).
async function revokeRefreshToken(backendId, rawToken) {
  await ensureAuthTables(backendId);
  const s = qIdent(schemaName(backendId));
  await getPool().query(`UPDATE ${s}.auth_refresh_tokens SET revoked = true WHERE token_hash = $1`, [_hashToken(rawToken)]);
  return { ok: true };
}

// Revoke every live refresh token for a user (sign-out everywhere).
async function revokeRefreshTokens(backendId, userId) {
  await ensureAuthTables(backendId);
  const s = qIdent(schemaName(backendId));
  await getPool().query(`UPDATE ${s}.auth_refresh_tokens SET revoked = true WHERE user_id = $1 AND revoked = false`, [userId]);
  return { ok: true };
}

// Enroll a TOTP factor (unverified until the first verifyTotp). Returns the
// secret + otpauth URL for the authenticator-app QR; the secret is shown ONCE.
async function enrollTotp(backendId, userId, { label = null, issuer = 'LingCode' } = {}) {
  await ensureAuthTables(backendId);
  const s = qIdent(schemaName(backendId));
  const secret = _totp.generateSecret();
  const id = crypto.randomUUID();
  await getPool().query(
    `INSERT INTO ${s}.auth_mfa_factors (id, user_id, type, secret, verified) VALUES ($1, $2, 'totp', $3, false)`,
    [id, userId, secret]);
  return { factorId: id, type: 'totp', secret, otpauthUrl: _totp.otpauthUrl({ secret, label: label || userId, issuer }) };
}

// Verify a TOTP code. On the first successful verify the factor is marked
// verified (completes enrollment). Throws 401 on a bad code.
async function verifyTotp(backendId, userId, code, { factorId = null } = {}) {
  await ensureAuthTables(backendId);
  const s = qIdent(schemaName(backendId));
  const pool = getPool();
  const q = factorId
    ? await pool.query(`SELECT id, secret, verified FROM ${s}.auth_mfa_factors WHERE id = $1 AND user_id = $2 AND type = 'totp'`, [factorId, userId])
    : await pool.query(`SELECT id, secret, verified FROM ${s}.auth_mfa_factors WHERE user_id = $1 AND type = 'totp' ORDER BY verified DESC, created_at DESC LIMIT 1`, [userId]);
  const row = q.rows[0];
  if (!row) { const e = new Error('no TOTP factor enrolled'); e.status = 404; throw e; }
  if (!_totp.verifyTotp(row.secret, code)) { const e = new Error('invalid code'); e.status = 401; throw e; }
  if (!row.verified) await pool.query(`UPDATE ${s}.auth_mfa_factors SET verified = true WHERE id = $1`, [row.id]);
  return { ok: true, factorId: row.id };
}

// List a user's factors WITHOUT secrets (for the account UI).
async function listMfaFactors(backendId, userId) {
  await ensureAuthTables(backendId);
  const s = qIdent(schemaName(backendId));
  const r = await getPool().query(
    `SELECT id, type, verified, created_at FROM ${s}.auth_mfa_factors WHERE user_id = $1 ORDER BY created_at`, [userId]);
  return r.rows;
}

// Remove a factor (disable MFA for the user / drop one device).
async function deleteMfaFactor(backendId, userId, factorId) {
  await ensureAuthTables(backendId);
  const s = qIdent(schemaName(backendId));
  await getPool().query(`DELETE FROM ${s}.auth_mfa_factors WHERE id = $1 AND user_id = $2`, [factorId, userId]);
  return { ok: true };
}

async function userHasVerifiedMfa(backendId, userId) {
  await ensureAuthTables(backendId);
  const s = qIdent(schemaName(backendId));
  const r = await getPool().query(
    `SELECT 1 FROM ${s}.auth_mfa_factors WHERE user_id = $1 AND verified = true LIMIT 1`, [userId]);
  return r.rowCount > 0;
}

// ---- introspection + queries ------------------------------------------

async function listTables(backendId) {
  const schema = schemaName(backendId);
  const pool = getPool();
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`, [schema]);
  const cols = await pool.query(
    `SELECT table_name, column_name, data_type, ordinal_position
     FROM information_schema.columns WHERE table_schema = $1
     ORDER BY table_name, ordinal_position`, [schema]);
  const byTable = new Map();
  for (const t of tables.rows) byTable.set(t.table_name, { name: t.table_name, columns: [] });
  for (const c of cols.rows) {
    const t = byTable.get(c.table_name);
    if (t) t.columns.push({ name: c.column_name, type: c.data_type });
  }
  return [...byTable.values()];
}

async function tableExists(backendId, table) {
  const schema = schemaName(backendId);
  const pool = getPool();
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]);
  return r.rowCount > 0;
}

// Run a block as the tenant role with search_path pinned to its schema.
// `readOnly` wraps in a READ ONLY transaction (belt-and-braces for the SQL
// editor). Returns { rows, fields }.
async function _asTenant(backendId, fn, { readOnly = false, userId = null } = {}) {
  const schema = schemaName(backendId);
  const role = roleName(backendId);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    if (STATEMENT_TIMEOUT_MS > 0) await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET LOCAL ROLE ${qIdent(role)}`);
    await client.query(`SET LOCAL search_path = ${qIdent(schema)}, extensions, pg_temp`);
    // Expose the authenticated user id to RLS via current_setting('app.user_id', true).
    if (userId) await client.query(`SELECT set_config('app.user_id', $1, true)`, [String(userId)]);
    const _q = Date.now();
    const result = await fn(client);
    recordQuery('tenant', _q);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Run a block as cloud_admin (the table owner) pinned to the tenant schema —
// RLS is BYPASSED. Only the owner's admin console uses this (Supabase's table
// editor does the same with the service role). Never reachable with an anon key.
async function _asAdminSchema(backendId, fn, { readOnly = false } = {}) {
  const schema = schemaName(backendId);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    if (STATEMENT_TIMEOUT_MS > 0) await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET LOCAL search_path = ${qIdent(schema)}, extensions, pg_temp`);
    const _q = Date.now();
    const result = await fn(client);
    recordQuery('admin', _q);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Pick the execution scope: admin (RLS bypassed, owner console) or tenant
// (RLS enforced, app traffic). Keeps proxy* identical for both callers.
function _asScope(backendId, fn, { userId = null, admin = false, readOnly = false } = {}) {
  return admin ? _asAdminSchema(backendId, fn, { readOnly }) : _asTenant(backendId, fn, { userId, readOnly });
}

async function listRows(backendId, table, { limit = 50, offset = 0 } = {}) {
  if (!(await tableExists(backendId, table))) { const e = new Error('table not found'); e.status = 404; throw e; }
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  return _asTenant(backendId, async (client) => {
    const r = await client.query(`SELECT * FROM ${qIdent(table)} LIMIT ${lim} OFFSET ${off}`);
    return { rows: r.rows, fields: r.fields.map((f) => f.name) };
  });
}

// Read-only SQL editor. The READ ONLY transaction + tenant role mean a
// stray write or cross-schema reference fails at the DB, not just the guard.
async function runReadOnlyQuery(backendId, sql) {
  return _asTenant(backendId, async (client) => {
    const r = await client.query(sql);
    const rows = Array.isArray(r.rows) ? r.rows.slice(0, 1000) : [];
    return { rows, fields: (r.fields || []).map((f) => f.name), rowCount: r.rowCount };
  }, { readOnly: true });
}

// Arbitrary PARAMETERIZED SQL as the tenant role (RLS enforced, search_path
// pinned to the tenant schema). Powers `ctx.db` inside serverless functions —
// JOINs, aggregations and multi-statement transactions within the tenant's OWN
// schema that the CRUD proxy can't express. Isolation is the same as the anon
// data path: the tenant role can only touch its schema, and RLS still applies.
async function execAsTenant(backendId, sql, params = [], { userId = null, readOnly = false } = {}) {
  if (typeof sql !== 'string' || !sql.trim()) { const e = new Error('sql (string) required'); e.status = 400; throw e; }
  return _asTenant(backendId, async (client) => {
    const r = await client.query(sql, Array.isArray(params) ? params : []);
    return { rows: Array.isArray(r.rows) ? r.rows.slice(0, 1000) : [], rowCount: r.rowCount, fields: (r.fields || []).map((f) => f.name) };
  }, { userId, readOnly });
}

// Migrations run as admin with search_path pinned to the tenant schema, then
// re-grant on any newly created objects so the tenant role can use them.
async function applyMigration(backendId, sql) {
  const schema = schemaName(backendId);
  const role = roleName(backendId);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path = ${qIdent(schema)}, extensions, pg_temp`);
    await client.query(sql);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${qIdent(schema)} TO ${qIdent(role)}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${qIdent(schema)} TO ${qIdent(role)}`);
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- data proxy (Phase-1 data path for generated apps) ----------------

// Minimal stand-in for PostgREST: select rows / insert a row as the tenant
// role. Phase 2 replaces this with the real gateway → PostgREST.
async function proxySelect(backendId, table, { where = null, order = null, limit = 50, offset = 0, userId = null, admin = false } = {}) {
  if (!(await tableExists(backendId, table))) { const e = new Error('table not found'); e.status = 404; throw e; }
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const w = buildWhere(where, 0);
  const orderSql = buildOrder(order);
  return _asScope(backendId, async (client) => {
    const r = await client.query(
      `SELECT * FROM ${qIdent(table)} ${w.sql} ${orderSql} LIMIT ${lim} OFFSET ${off}`, w.values);
    return { rows: r.rows, fields: r.fields.map((f) => f.name) };
  }, { userId, admin });
}

// UPDATE rows matching `where` with the columns in `patch`. A non-empty `where`
// is REQUIRED — we refuse to update every row in the table.
async function proxyUpdate(backendId, table, { where = null, patch = null, userId = null, admin = false } = {}) {
  if (!(await tableExists(backendId, table))) { const e = new Error('table not found'); e.status = 404; throw e; }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
    throw badRequest('patch object required');
  }
  if (!where || typeof where !== 'object' || Array.isArray(where) || !Object.keys(where).length) {
    throw badRequest('where required (refusing to update every row)');
  }
  const setKeys = Object.keys(patch);
  for (const k of setKeys) qIdent(k); // validate SET column identifiers
  const setSql = setKeys.map((k, idx) => `${qIdent(k)} = $${idx + 1}`).join(', ');
  const setVals = setKeys.map((k) => patch[k]);
  const w = buildWhere(where, setKeys.length); // WHERE placeholders continue after the SET list
  const out = await _asScope(backendId, async (client) => {
    const r = await client.query(
      `UPDATE ${qIdent(table)} SET ${setSql} ${w.sql} RETURNING *`, [...setVals, ...w.values]);
    return { rows: r.rows };
  }, { userId, admin });
  emitChange(backendId, table, 'UPDATE', out.rows);
  return out;
}

// DELETE rows matching `where`. A non-empty `where` is REQUIRED — we refuse to
// delete every row in the table.
async function proxyDelete(backendId, table, { where = null, userId = null, admin = false } = {}) {
  if (!(await tableExists(backendId, table))) { const e = new Error('table not found'); e.status = 404; throw e; }
  if (!where || typeof where !== 'object' || Array.isArray(where) || !Object.keys(where).length) {
    throw badRequest('where required (refusing to delete every row)');
  }
  const w = buildWhere(where, 0);
  const out = await _asScope(backendId, async (client) => {
    const r = await client.query(`DELETE FROM ${qIdent(table)} ${w.sql} RETURNING *`, w.values);
    return { rows: r.rows };
  }, { userId, admin });
  emitChange(backendId, table, 'DELETE', out.rows);
  return out;
}

async function proxyInsert(backendId, table, row, { userId = null, admin = false } = {}) {
  if (!(await tableExists(backendId, table))) { const e = new Error('table not found'); e.status = 404; throw e; }
  if (!row || typeof row !== 'object' || Array.isArray(row)) { const e = new Error('row object required'); e.status = 400; throw e; }
  const keys = Object.keys(row);
  if (!keys.length) { const e = new Error('row has no columns'); e.status = 400; throw e; }
  for (const k of keys) qIdent(k); // validate column identifiers
  const colSql = keys.map(qIdent).join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const values = keys.map((k) => row[k]);
  const out = await _asScope(backendId, async (client) => {
    const r = await client.query(
      `INSERT INTO ${qIdent(table)} (${colSql}) VALUES (${placeholders}) RETURNING *`, values);
    return { rows: r.rows };
  }, { userId, admin });
  emitChange(backendId, table, 'INSERT', out.rows);
  return out;
}

// ---- realtime visibility filter ---------------------------------------
// A realtime subscriber must never receive a row it couldn't SELECT. We
// re-check each change against the table's RLS as the tenant role before
// delivering it. INSERT/UPDATE: confirm the row is still visible via a
// primary-key existence probe (respects whatever RLS policy exists — user-
// scoped OR public). DELETE: the row is gone, so fall back to the common
// `user_id = auth.uid()` pattern carried on the row itself.
const _pkCache = new Map(); // `${backendId}:${table}` -> string[] pk columns
async function primaryKeyColumns(backendId, table) {
  const key = `${backendId}:${table}`;
  if (_pkCache.has(key)) return _pkCache.get(key);
  const schema = schemaName(backendId);
  const r = await getPool().query(
    `SELECT a.attname AS col
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass
        AND i.indisprimary`,
    [schema, table]);
  const cols = r.rows.map((x) => x.col);
  _pkCache.set(key, cols);
  return cols;
}

async function canTenantSeeRow(backendId, table, type, row, userId) {
  if (!row || typeof row !== 'object') return false;
  if (type === 'DELETE') {
    // Row no longer exists — can't probe. Use the user_id ownership heuristic.
    if (!('user_id' in row)) return true;          // public table → broadcast
    return userId != null && String(row.user_id) === String(userId);
  }
  let pk = [];
  try { pk = await primaryKeyColumns(backendId, table); } catch (_) { pk = []; }
  if (!pk.length) {
    if (!('user_id' in row)) return true;
    return userId != null && String(row.user_id) === String(userId);
  }
  const conds = pk.map((c, i) => `${qIdent(c)} = $${i + 1}`).join(' AND ');
  const vals = pk.map((c) => row[c]);
  try {
    return await _asTenant(backendId, async (client) => {
      const r = await client.query(`SELECT 1 FROM ${qIdent(table)} WHERE ${conds} LIMIT 1`, vals);
      return r.rowCount > 0;
    }, { userId, readOnly: true });
  } catch (_) { return false; }
}

// ---- pgvector similarity search ---------------------------------------
// ORDER BY a vector column's distance to a query embedding. metric: cosine
// (<=>), l2 (<->), ip (negative inner product, <#>). RLS applies via the tenant
// role + userId, so a signed-in user only searches rows they may read.
const VECTOR_OPS = { cosine: '<=>', l2: '<->', ip: '<#>' };
async function vectorSearch(backendId, { table, column, embedding, limit = 10, metric = 'cosine', userId = null, admin = false } = {}) {
  if (!(await tableExists(backendId, table))) { const e = new Error('table not found'); e.status = 404; throw e; }
  qIdent(table); qIdent(column); // validate identifiers
  const op = VECTOR_OPS[metric] || VECTOR_OPS.cosine;
  const vec = Array.isArray(embedding) ? '[' + embedding.map(Number).join(',') + ']' : String(embedding || '');
  if (!/^\[/.test(vec)) throw badRequest('embedding must be an array of numbers (or a [..] vector literal)');
  const lim = Math.max(1, Math.min(200, Number(limit) || 10));
  // admin (owner console) bypasses RLS to search all rows; app traffic stays tenant-scoped.
  return _asScope(backendId, async (client) => {
    const r = await client.query(
      `SELECT *, (${qIdent(column)} ${op} $1::vector) AS _distance
       FROM ${qIdent(table)}
       ORDER BY ${qIdent(column)} ${op} $1::vector
       LIMIT ${lim}`, [vec]);
    return { rows: r.rows, fields: r.fields.map((f) => f.name) };
  }, { userId, admin, readOnly: true });
}

// ---- full-text + hybrid search ----------------------------------------
// Borrowed from Supabase's docs search (FTS ranking + reciprocal-rank fusion),
// generalised to operate on one tenant table with caller-named columns. RLS
// applies via _asScope (tenant role + userId) for app traffic; the owner
// console passes admin:true. Query text + embedding are always $n placeholders.

// A column reference for full-text: either an existing tsvector column used
// directly, or a text column wrapped in to_tsvector(). Returns a SQL fragment
// built only from a qIdent-validated identifier (no user value interpolated).
function ftsRef(column, isTsvector) {
  const c = qIdent(column);
  return isTsvector ? c : `to_tsvector(${c}::text)`;
}

// FTS: rank rows by ts_rank against websearch_to_tsquery($1). `isTsvector`
// true means `column` is already a tsvector (e.g. a generated+indexed column).
async function textSearch(backendId, { table, column, query, isTsvector = false, limit = 10, userId = null, admin = false } = {}) {
  if (!(await tableExists(backendId, table))) { const e = new Error('table not found'); e.status = 404; throw e; }
  if (typeof query !== 'string' || !query.trim()) throw badRequest('query (text) required');
  const ref = ftsRef(column, isTsvector);
  const lim = Math.max(1, Math.min(200, Number(limit) || 10));
  return _asScope(backendId, async (client) => {
    const r = await client.query(
      `SELECT *, ts_rank(${ref}, websearch_to_tsquery($1)) AS _rank
       FROM ${qIdent(table)}
       WHERE ${ref} @@ websearch_to_tsquery($1)
       ORDER BY _rank DESC
       LIMIT ${lim}`, [query]);
    return { rows: r.rows, fields: r.fields.map((f) => f.name) };
  }, { userId, admin, readOnly: true });
}

// Hybrid: fuse FTS and vector rankings with reciprocal rank fusion (RRF), the
// pattern from supabase/migrations/...hybrid_search.sql. Needs a single-column
// row identity to join the two ranked candidate sets — `idColumn` (defaults to
// the table's primary key; composite PKs are unsupported, pass idColumn).
async function hybridSearch(backendId, {
  table, textColumn, vectorColumn, query, embedding, idColumn = null,
  textIsTsvector = false, metric = 'cosine', limit = 10,
  fullTextWeight = 1, semanticWeight = 1, rrfK = 50, userId = null, admin = false,
} = {}) {
  if (!(await tableExists(backendId, table))) { const e = new Error('table not found'); e.status = 404; throw e; }
  if (typeof query !== 'string' || !query.trim()) throw badRequest('query (text) required');
  const vec = Array.isArray(embedding) ? '[' + embedding.map(Number).join(',') + ']' : String(embedding || '');
  if (!/^\[/.test(vec)) throw badRequest('embedding must be an array of numbers (or a [..] vector literal)');
  // Resolve the id column: explicit, else the single primary-key column.
  let idCol = idColumn;
  if (!idCol) {
    const pk = await primaryKeyColumns(backendId, table);
    if (pk.length !== 1) throw badRequest('hybrid search needs a single-column id; pass idColumn');
    idCol = pk[0];
  }
  const id = qIdent(idCol);
  const tbl = qIdent(table);
  const ref = ftsRef(textColumn, textIsTsvector);
  const op = VECTOR_OPS[metric] || VECTOR_OPS.cosine;
  const lim = Math.max(1, Math.min(200, Number(limit) || 10));
  const pool = Math.min(lim, 30) * 2;            // candidate pool per ranker
  const k = Math.max(1, Number(rrfK) || 50);
  const ftw = Number(fullTextWeight); const smw = Number(semanticWeight);
  // $1 query text, $2 embedding, $3 ftw, $4 smw — pool/k/lim are integers we
  // clamp ourselves, so they're safe to inline (PG forbids $ params in LIMIT
  // of some positions and in the rrf arithmetic constants here).
  return _asScope(backendId, async (client) => {
    const r = await client.query(
      `WITH q AS (SELECT websearch_to_tsquery($1) AS tsq, $2::vector AS emb),
       ft AS (
         SELECT t.${id} AS _id,
                row_number() OVER (ORDER BY ts_rank(${ref}, q.tsq) DESC) AS rank_ix
         FROM ${tbl} t, q
         WHERE ${ref} @@ q.tsq
         LIMIT ${pool}
       ),
       sem AS (
         SELECT t.${id} AS _id,
                row_number() OVER (ORDER BY t.${qIdent(vectorColumn)} ${op} q.emb) AS rank_ix
         FROM ${tbl} t, q
         ORDER BY t.${qIdent(vectorColumn)} ${op} q.emb
         LIMIT ${pool}
       ),
       rrf AS (
         SELECT COALESCE(ft._id, sem._id) AS _id,
                COALESCE(1.0 / (${k} + ft.rank_ix), 0.0) * $3 +
                COALESCE(1.0 / (${k} + sem.rank_ix), 0.0) * $4 AS score
         FROM ft FULL OUTER JOIN sem ON ft._id = sem._id
       )
       SELECT t.*, rrf.score AS _score
       FROM rrf JOIN ${tbl} t ON t.${id} = rrf._id
       WHERE rrf.score > 0
       ORDER BY rrf.score DESC
       LIMIT ${lim}`, [query, vec, ftw, smw]);
    return { rows: r.rows, fields: r.fields.map((f) => f.name) };
  }, { userId, admin, readOnly: true });
}

// Build the migration SQL to add a generated, GIN-indexed tsvector column so
// FTS / hybrid search are fast (borrowed from the docs FTS migration's
// `tsvector generated always as (...) stored` + gin index pattern). Pure
// string builder (DB-free testable); apply via applyMigration. `sourceColumns`
// are concatenated; identifiers validated, language pinned to an allow-list.
const FTS_LANGUAGES = new Set(['simple', 'english', 'spanish', 'french', 'german', 'portuguese', 'italian', 'dutch', 'russian']);
function buildFtsColumnSql({ table, column = 'fts', sourceColumns, language = 'english' } = {}) {
  if (!Array.isArray(sourceColumns) || !sourceColumns.length) throw badRequest('sourceColumns (non-empty array) required');
  if (!FTS_LANGUAGES.has(language)) throw badRequest(`unsupported language: ${language}`);
  const tbl = qIdent(table);
  const col = qIdent(column);
  const expr = sourceColumns.map((c) => `coalesce(${qIdent(c)}::text, '')`).join(" || ' ' || ");
  const idx = qIdent(`${table}_${column}_idx`);
  return `ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS ${col} tsvector ` +
    `GENERATED ALWAYS AS (to_tsvector('${language}', ${expr})) STORED;\n` +
    `CREATE INDEX IF NOT EXISTS ${idx} ON ${tbl} USING gin(${col});`;
}

// Exact row count for the admin table editor (RLS bypassed, own schema).
async function countRows(backendId, table) {
  if (!(await tableExists(backendId, table))) return 0;
  return _asAdminSchema(backendId, async (client) => {
    const r = await client.query(`SELECT count(*)::int AS n FROM ${qIdent(table)}`);
    return r.rows[0] ? r.rows[0].n : 0;
  }, { readOnly: true });
}

// Column metadata for the schema editor + typed input widgets. `udt` exposes the
// underlying type name (e.g. 'vector', 'uuid', 'bool', 'timestamptz') so the UI
// can pick the right input and detect pgvector columns. RLS-irrelevant (reads
// information_schema), but we pin search_path so unqualified names resolve.
async function columnsOf(backendId, table) {
  const schema = schemaName(backendId);
  qIdent(table); // validate identifier
  const pool = getPool();
  const r = await pool.query(
    `SELECT column_name, data_type, udt_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`, [schema, table]);
  return r.rows.map((c) => ({
    column: c.column_name,
    type: c.data_type,
    udt: c.udt_name,
    nullable: c.is_nullable === 'YES',
    default: c.column_default,
  }));
}

// ---- richer schema introspection (pg_catalog) -------------------------
// Powers the owner admin console's schema/table editor. These read pg_catalog
// as cloud_admin (the schema owner / superuser) — RLS is irrelevant to catalog
// reads, and the schema/table are passed as bound values, never interpolated.
// SQL adapted from Supabase's pg-meta (columns/policies/indexes/foreign-keys).

// Full column metadata: identity, generated, uniqueness, CHECK definition,
// enum labels, and comments — everything the schema editor needs to render a
// table and pick the right input widget. Adapted from pg-meta COLUMNS_SQL.
async function tableColumns(backendId, table) {
  const schema = schemaName(backendId);
  qIdent(table);
  const r = await getPool().query(
    `SELECT
       a.attnum AS ordinal_position,
       a.attname AS name,
       CASE WHEN a.atthasdef THEN pg_get_expr(ad.adbin, ad.adrelid) ELSE NULL END AS default_value,
       CASE
         WHEN t.typtype = 'd' THEN CASE
           WHEN bt.typelem <> 0::oid AND bt.typlen = -1 THEN 'ARRAY'
           WHEN nbt.nspname = 'pg_catalog' THEN format_type(t.typbasetype, NULL)
           ELSE 'USER-DEFINED' END
         ELSE CASE
           WHEN t.typelem <> 0::oid AND t.typlen = -1 THEN 'ARRAY'
           WHEN nt.nspname = 'pg_catalog' THEN format_type(a.atttypid, NULL)
           ELSE 'USER-DEFINED' END
       END AS data_type,
       COALESCE(bt.typname, t.typname) AS format,
       a.attidentity IN ('a', 'd') AS is_identity,
       a.attgenerated IN ('s') AS is_generated,
       NOT (a.attnotnull OR t.typtype = 'd' AND t.typnotnull) AS is_nullable,
       uniques.table_id IS NOT NULL AS is_unique,
       check_constraints.definition AS check,
       array_to_json(array(
         SELECT enumlabel FROM pg_catalog.pg_enum enums
         WHERE enums.enumtypid = coalesce(bt.oid, t.oid)
            OR enums.enumtypid = coalesce(bt.typelem, t.typelem)
         ORDER BY enums.enumsortorder)) AS enums,
       col_description(c.oid, a.attnum) AS comment
     FROM pg_attribute a
       LEFT JOIN pg_attrdef ad ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
       JOIN (pg_class c JOIN pg_namespace nc ON c.relnamespace = nc.oid) ON a.attrelid = c.oid
       JOIN (pg_type t JOIN pg_namespace nt ON t.typnamespace = nt.oid) ON a.atttypid = t.oid
       LEFT JOIN (pg_type bt JOIN pg_namespace nbt ON bt.typnamespace = nbt.oid)
         ON t.typtype = 'd' AND t.typbasetype = bt.oid
       LEFT JOIN (
         SELECT DISTINCT ON (table_id, ordinal_position) conrelid AS table_id, conkey[1] AS ordinal_position
         FROM pg_catalog.pg_constraint WHERE contype = 'u' AND cardinality(conkey) = 1
       ) AS uniques ON uniques.table_id = c.oid AND uniques.ordinal_position = a.attnum
       LEFT JOIN (
         SELECT DISTINCT ON (table_id, ordinal_position) conrelid AS table_id, conkey[1] AS ordinal_position,
           substring(pg_get_constraintdef(pg_constraint.oid, true), 8,
             length(pg_get_constraintdef(pg_constraint.oid, true)) - 8) AS definition
         FROM pg_constraint WHERE contype = 'c' AND cardinality(conkey) = 1
         ORDER BY table_id, ordinal_position, oid asc
       ) AS check_constraints ON check_constraints.table_id = c.oid AND check_constraints.ordinal_position = a.attnum
     WHERE nc.nspname = $1 AND c.relname = $2
       AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','v','m','f','p')
     ORDER BY a.attnum`, [schema, table]);
  return r.rows;
}

// RLS policies on a table: name, command, roles, USING + WITH CHECK exprs.
async function policiesOf(backendId, table) {
  const schema = schemaName(backendId);
  qIdent(table);
  const r = await getPool().query(
    `SELECT pol.polname AS name,
       CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS action,
       CASE WHEN pol.polroles = '{0}'::oid[] THEN ARRAY['public']
            ELSE array(SELECT rolname FROM pg_roles WHERE oid = ANY(pol.polroles) ORDER BY rolname) END AS roles,
       CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
            WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL' ELSE NULL END AS command,
       pg_get_expr(pol.polqual, pol.polrelid) AS definition,
       pg_get_expr(pol.polwithcheck, pol.polrelid) AS check
     FROM pg_policy pol
       JOIN pg_class c ON c.oid = pol.polrelid
       LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2
     ORDER BY pol.polname`, [schema, table]);
  return r.rows;
}

// Indexes on a table: name, definition, uniqueness/primary flags, columns.
async function indexesOf(backendId, table) {
  const schema = schemaName(backendId);
  qIdent(table);
  const r = await getPool().query(
    `SELECT ic.relname AS name,
       idx.indisunique AS is_unique,
       idx.indisprimary AS is_primary,
       am.amname AS access_method,
       ix.indexdef AS definition,
       array_agg(a.attname ORDER BY a.attnum) AS columns
     FROM pg_index idx
       JOIN pg_class ic ON ic.oid = idx.indexrelid
       JOIN pg_class tc ON tc.oid = idx.indrelid
       JOIN pg_namespace n ON tc.relnamespace = n.oid
       JOIN pg_am am ON ic.relam = am.oid
       JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attnum = ANY(idx.indkey)
       JOIN pg_indexes ix ON ic.relname = ix.indexname AND n.nspname = ix.schemaname
     WHERE n.nspname = $1 AND tc.relname = $2
     GROUP BY ic.relname, idx.indisunique, idx.indisprimary, am.amname, ix.indexdef
     ORDER BY ic.relname`, [schema, table]);
  return r.rows;
}

// Foreign keys whose source is this table: constraint name, source/target
// columns, ON DELETE / ON UPDATE actions. Adapted from pg-meta foreign-keys.
const _FK_ACTIONS = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
async function foreignKeysOf(backendId, table) {
  const schema = schemaName(backendId);
  qIdent(table);
  const r = await getPool().query(
    `SELECT con.conname AS constraint_name,
       con.confdeltype AS deletion_action,
       con.confupdtype AS update_action,
       nsp.nspname AS source_schema, rel.relname AS source_table,
       (SELECT array_agg(att.attname ORDER BY un.ord)
          FROM unnest(con.conkey) WITH ORDINALITY un(attnum, ord)
          JOIN pg_attribute att ON att.attnum = un.attnum AND att.attrelid = rel.oid) AS source_columns,
       fnsp.nspname AS target_schema, frel.relname AS target_table,
       (SELECT array_agg(att.attname ORDER BY un.ord)
          FROM unnest(con.confkey) WITH ORDINALITY un(attnum, ord)
          JOIN pg_attribute att ON att.attnum = un.attnum AND att.attrelid = frel.oid) AS target_columns
     FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       JOIN pg_class frel ON frel.oid = con.confrelid
       JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
     WHERE con.contype = 'f' AND nsp.nspname = $1 AND rel.relname = $2`, [schema, table]);
  return r.rows.map((fk) => ({
    constraint_name: fk.constraint_name,
    source_schema: fk.source_schema, source_table: fk.source_table, source_columns: fk.source_columns,
    target_schema: fk.target_schema, target_table: fk.target_table, target_columns: fk.target_columns,
    on_delete: _FK_ACTIONS[fk.deletion_action] || fk.deletion_action,
    on_update: _FK_ACTIONS[fk.update_action] || fk.update_action,
  }));
}

// ---- schema advisors (security + performance lints) -------------------
// Scans a tenant's schema and flags risky/slow patterns, so the owner console
// can warn instead of just display. Lints adapted from Supabase's splinter.sql
// (pg_catalog only), scoped to the one be_<id> schema. Each query returns the
// offending objects; we normalize to { id, level, category, title, detail, table }.
// level: error | warn | info. category: security | performance.
async function advisorsFor(backendId) {
  const schema = schemaName(backendId);
  const pool = getPool();
  const out = [];
  const q = (sql) => pool.query(sql, [schema]).then((r) => r.rows).catch(() => []);

  // SECURITY — RLS off on a base table (anyone with the anon key reads everything).
  for (const r of await q(
    `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND c.relkind='r' AND NOT c.relrowsecurity ORDER BY c.relname`)) {
    out.push({ id: 'rls_disabled', level: 'error', category: 'security', table: r.t, title: 'Row-level security is disabled', detail: `Table "${r.t}" has RLS off — every row is readable/writable by anyone with the anon key. Enable RLS and add a policy (see the RLS templates).` });
  }
  // SECURITY — policies defined but RLS disabled (policies are inert).
  for (const r of await q(
    `SELECT DISTINCT c.relname AS t FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT c.relrowsecurity ORDER BY 1`)) {
    out.push({ id: 'policy_exists_rls_disabled', level: 'error', category: 'security', table: r.t, title: 'Policies exist but RLS is off', detail: `Table "${r.t}" has RLS policies that do nothing because RLS isn't enabled. Run: ALTER TABLE "${r.t}" ENABLE ROW LEVEL SECURITY;` });
  }
  // SECURITY — function with a mutable search_path (privilege-escalation surface).
  for (const r of await q(
    `SELECT p.proname AS t FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname=$1 AND p.prokind='f'
       AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}'::text[])) cfg WHERE cfg LIKE 'search_path=%') ORDER BY 1`)) {
    out.push({ id: 'function_search_path_mutable', level: 'warn', category: 'security', table: r.t, title: 'Function has a mutable search_path', detail: `Function "${r.t}" doesn't pin search_path — set "SET search_path = ''" (or a fixed schema) to avoid search-path hijacking.` });
  }
  // PERFORMANCE — table without a primary key.
  for (const r of await q(
    `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND c.relkind='r'
       AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary) ORDER BY 1`)) {
    out.push({ id: 'no_primary_key', level: 'info', category: 'performance', table: r.t, title: 'No primary key', detail: `Table "${r.t}" has no primary key — updates/deletes by row and realtime change-tracking work better with one.` });
  }
  // PERFORMANCE — duplicate indexes (same columns/expr on the same table).
  for (const r of await q(
    `SELECT c.relname AS t, array_agg(ic.relname::text ORDER BY ic.relname) AS idxs
     FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_class c ON c.oid=i.indrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
     GROUP BY c.relname, i.indkey, i.indclass, i.indpred, i.indexprs HAVING count(*)>1`)) {
    const idxs = Array.isArray(r.idxs) ? r.idxs.join(', ') : String(r.idxs || '').replace(/[{}"]/g, '');
    out.push({ id: 'duplicate_index', level: 'warn', category: 'performance', table: r.t, title: 'Duplicate index', detail: `Table "${r.t}" has identical indexes (${idxs}) — drop all but one to save space and write cost.` });
  }
  // PERFORMANCE — multiple permissive policies for the same role+command (each re-evaluated).
  for (const r of await q(
    `SELECT c.relname AS t, count(*) AS n FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND pol.polpermissive
     GROUP BY c.relname, pol.polcmd, pol.polroles HAVING count(*)>1`)) {
    out.push({ id: 'multiple_permissive_policies', level: 'warn', category: 'performance', table: r.t, title: 'Multiple permissive policies', detail: `Table "${r.t}" has ${r.n} permissive policies for the same role+action — each runs on every query. Combine them into one.` });
  }
  // PERFORMANCE — foreign key with no covering index on its columns.
  for (const r of await q(
    `SELECT c.relname AS t, con.conname AS c FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND con.contype='f'
       AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=con.conrelid
         AND (i.indkey::int2[])[1:cardinality(con.conkey)] = con.conkey) ORDER BY 1`)) {
    out.push({ id: 'unindexed_foreign_key', level: 'info', category: 'performance', table: r.t, title: 'Unindexed foreign key', detail: `FK "${r.c}" on "${r.t}" has no covering index — joins and cascade deletes scan the whole table. Add an index on its column(s).` });
  }
  const rank = { error: 0, warn: 1, info: 2 };
  out.sort((a, b) => (rank[a.level] - rank[b.level]) || a.category.localeCompare(b.category) || String(a.table).localeCompare(String(b.table)));
  return out;
}

// ---- prototype payload blob store -------------------------------------
// Offload large /try share payloads to the roomy cloud Postgres so they don't
// bloat the disk-tight control-plane SQLite (data.db). Owner-agnostic key/value
// keyed by the prototype id. Reuses the admin pool; lazy-creates its table.
let _blobTableReady = false;
async function _ensureBlobTable(client) {
  if (_blobTableReady) return;
  await client.query(`CREATE TABLE IF NOT EXISTS public.lingcode_prototype_blobs (
    id text PRIMARY KEY,
    payload text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  _blobTableReady = true;
}
async function putPrototypeBlob(id, payload) {
  const client = await getPool().connect();
  try {
    await _ensureBlobTable(client);
    await client.query(
      `INSERT INTO public.lingcode_prototype_blobs (id, payload, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [id, payload]);
  } finally { client.release(); }
}
async function getPrototypeBlob(id) {
  const r = await getPool().query('SELECT payload FROM public.lingcode_prototype_blobs WHERE id = $1', [id]);
  return r.rows[0] ? r.rows[0].payload : null;
}
async function deletePrototypeBlob(id) {
  try { await getPool().query('DELETE FROM public.lingcode_prototype_blobs WHERE id = $1', [id]); } catch (_) {}
}

// ---- cloud-app file blob store ----------------------------------------
// Per-file bytes for deployed Cloud Apps (built static frontends served at
// /apps/<id>/*). Unlike prototype blobs (text/base64), these are BINARY
// (png/woff2/wasm) so we use BYTEA — no base64 inflation, exact fidelity.
// blob_key = `${appId}/${normalizedPath}` so an app's files prefix-scan.
let _appBlobTableReady = false;
async function _ensureAppBlobTable(client) {
  if (_appBlobTableReady) return;
  await client.query(`CREATE TABLE IF NOT EXISTS public.lingcode_app_blobs (
    key text PRIMARY KEY,
    bytes bytea NOT NULL,
    content_type text,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  _appBlobTableReady = true;
}
async function putAppFileBlob(key, bytes, contentType) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const client = await getPool().connect();
  try {
    await _ensureAppBlobTable(client);
    await client.query(
      `INSERT INTO public.lingcode_app_blobs (key, bytes, content_type, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET bytes = EXCLUDED.bytes, content_type = EXCLUDED.content_type, updated_at = now()`,
      [key, buf, contentType || null]);
  } finally { client.release(); }
}
async function getAppFileBlob(key) {
  const r = await getPool().query('SELECT bytes FROM public.lingcode_app_blobs WHERE key = $1', [key]);
  return r.rows[0] ? r.rows[0].bytes : null; // Buffer | null
}
async function deleteAppBlobsForApp(appId) {
  // blob_key prefix is `${appId}/` — delete the whole app's byte set (all versions).
  try { await getPool().query('DELETE FROM public.lingcode_app_blobs WHERE key LIKE $1', [String(appId) + '/%']); } catch (_) {}
}
async function deleteAppBlobsForAppVersion(appId, version) {
  // Drop a single superseded version's bytes after an atomic re-deploy swap.
  try { await getPool().query('DELETE FROM public.lingcode_app_blobs WHERE key LIKE $1', [`${appId}/${version}/%`]); } catch (_) {}
}

module.exports = {
  isConfigured,
  poolStats,
  probe,
  realtimeBus,
  ensureRealtimeListener,
  canTenantSeeRow,
  putPrototypeBlob,
  getPrototypeBlob,
  deletePrototypeBlob,
  putAppFileBlob,
  getAppFileBlob,
  deleteAppBlobsForApp,
  deleteAppBlobsForAppVersion,
  provisionBackend,
  dropBackend,
  mintAnonJwt,
  mintUserJwt,
  verifyTenantJwt,
  createTenantUser,
  verifyTenantUser,
  getOrCreateTenantUserByEmail,
  listTenantUsers,
  getTenantUserById,
  deleteTenantUser,
  ensureAuthTables,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeRefreshTokens,
  enrollTotp,
  verifyTotp,
  listMfaFactors,
  deleteMfaFactor,
  userHasVerifiedMfa,
  listTables,
  listRows,
  runReadOnlyQuery,
  execAsTenant,
  applyMigration,
  proxySelect,
  proxyInsert,
  proxyUpdate,
  proxyDelete,
  vectorSearch,
  textSearch,
  hybridSearch,
  buildFtsColumnSql,
  primaryKeyColumns,
  countRows,
  columnsOf,
  tableColumns,
  policiesOf,
  indexesOf,
  foreignKeysOf,
  advisorsFor,
  schemaName,
  roleName,
  // Exported for DB-free unit testing of the injection-safe SQL builders.
  buildWhere,
  buildOrder,
};
