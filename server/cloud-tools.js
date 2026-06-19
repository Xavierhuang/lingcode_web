'use strict';

// cloud-tools.js — AI tool dispatcher for LingCode Cloud (Phase 7).
//
// The /try agent emits tool_use blocks (list_tables, apply_migration,
// query_database, get_backend_info); its executor POSTs them here so the
// model can set up and inspect the managed backend autonomously. Mirrors the
// auth/ownership/envelope shape of supabase-tools.js but targets our own data
// plane instead of Supabase SaaS. Each call is scoped to a prototype_id the
// caller owns; the backend must already be provisioned (via the Cloud
// console or a prior create call).
//
// Feature flag: routes 503 unless CLOUD_PG_ADMIN_URL + CLOUD_JWT_SECRET are
// configured AND env CLOUD_AI_TOOLS !== '0'.

const { getUserFromRequest } = require('./auth-helpers');
const dataPlane = require('./cloud-data-plane');
const { provisionForPrototype } = require('./cloud-backend');
const { recordSchemaMigration } = require('./cloud-audit');
const { computeCapabilities } = require('./cloud-limits');

function toolsEnabled() {
  return dataPlane.isConfigured() && process.env.CLOUD_AI_TOOLS !== '0';
}

function preflight(req, res, db) {
  if (!toolsEnabled()) { res.status(503).json({ ok: false, error: 'cloud_tools_disabled' }); return null; }
  const user = getUserFromRequest(db, req);
  if (!user) { res.status(401).json({ ok: false, error: 'unauthorized' }); return null; }
  const prototypeId = String((req.body && req.body.prototype_id) || '');
  if (!db.prepare('SELECT 1 FROM saved_prototypes WHERE id = ? AND user_id = ?').get(prototypeId, user.id)) {
    res.status(404).json({ ok: false, error: 'prototype_not_found' }); return null;
  }
  const backend = db.prepare(`SELECT * FROM prototype_backends WHERE prototype_id = ?`).get(prototypeId);
  if (!backend || backend.status !== 'live') { res.status(409).json({ ok: false, error: 'not_provisioned', message: 'Provision a backend in the Cloud console first.' }); return null; }
  return { user, backend };
}

function sendErr(res, err) {
  const status = (err && err.status) || 500;
  res.status(status >= 400 && status < 500 ? status : 500).json({ ok: false, error: 'cloud_error', message: err?.message });
}

/**
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
function registerCloudToolRoutes(app, db) {
  app.post('/api/cloud/tools/get_backend_info', (req, res) => {
    const ctx = preflight(req, res, db); if (!ctx) return;
    res.json({ ok: true, data: { backend_url: ctx.backend.gateway_url, anon_key: ctx.backend.anon_jwt, schema: ctx.backend.schema_name, compute: computeCapabilities(ctx.user.tier) } });
  });

  app.post('/api/cloud/tools/list_tables', async (req, res) => {
    const ctx = preflight(req, res, db); if (!ctx) return;
    try { res.json({ ok: true, data: await dataPlane.listTables(ctx.backend.id) }); }
    catch (err) { sendErr(res, err); }
  });

  app.post('/api/cloud/tools/apply_migration', async (req, res) => {
    const ctx = preflight(req, res, db); if (!ctx) return;
    const sql = (req.body && typeof req.body.sql === 'string') ? req.body.sql : '';
    if (!sql.trim() || sql.length > 200_000) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'sql required (≤200KB)' });
    try {
      const data = await dataPlane.applyMigration(ctx.backend.id, sql);
      recordSchemaMigration(db, { backendId: ctx.backend.id, userId: ctx.user && ctx.user.id, sql, status: 'applied' });
      res.json({ ok: true, data });
    } catch (err) {
      recordSchemaMigration(db, { backendId: ctx.backend.id, userId: ctx.user && ctx.user.id, sql, status: 'failed', error: (err && err.message) || String(err) });
      sendErr(res, err);
    }
  });

  // Schema-change history for this prototype's backend (newest first) — so the
  // console/agent can show every DDL that ran instead of it being a black box.
  app.post('/api/cloud/tools/schema_migrations', (req, res) => {
    const ctx = preflight(req, res, db); if (!ctx) return;
    const rows = db.prepare('SELECT id, user_id, sql, status, error, created_at FROM schema_migrations WHERE backend_id = ? ORDER BY created_at DESC LIMIT 100').all(ctx.backend.id);
    res.json({ ok: true, data: rows });
  });

  app.post('/api/cloud/tools/query_database', async (req, res) => {
    const ctx = preflight(req, res, db); if (!ctx) return;
    const sql = (req.body && typeof req.body.sql === 'string') ? req.body.sql : '';
    if (!sql.trim() || sql.length > 50_000) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'sql required (≤50KB)' });
    const trimmed = sql.trim().replace(/^\(\s*/, '');
    if (!/^(select|with)\s/i.test(trimmed)) return res.status(400).json({ ok: false, error: 'read_only_violation', message: 'query_database is read-only — use apply_migration for writes.' });
    try { res.json({ ok: true, data: await dataPlane.runReadOnlyQuery(ctx.backend.id, sql) }); }
    catch (err) { sendErr(res, err); }
  });

  // provision_backend — the one cloud tool that does NOT require a live backend
  // (it creates it). Lets the agent set up a managed backend from a prompt with
  // no manual Cloud-console step. Owner-scoped; idempotent (returns existing).
  app.post('/api/cloud/tools/provision_backend', async (req, res) => {
    if (!toolsEnabled()) return res.status(503).json({ ok: false, error: 'cloud_tools_disabled' });
    const user = getUserFromRequest(db, req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const prototypeId = String((req.body && req.body.prototype_id) || '');
    if (!db.prepare('SELECT 1 FROM saved_prototypes WHERE id = ? AND user_id = ?').get(prototypeId, user.id)) {
      return res.status(404).json({ ok: false, error: 'prototype_not_found', message: 'Save/publish this prototype before provisioning a backend.' });
    }
    try {
      const data = await provisionForPrototype(db, {
        prototypeId, userId: user.id, tier: user.tier,
        gatewayBase: `${req.protocol}://${req.get('host')}/api/cloud/be`,
      });
      res.json({ ok: true, data });
    } catch (err) { sendErr(res, err); }
  });
}

module.exports = { registerCloudToolRoutes };
