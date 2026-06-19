'use strict';

// supabase-tools.js — HTTP routes the agent's executor calls when the
// model emits a Supabase tool_use block. Phase 3 of the /try Lovable-
// parity plan; the keystone that ties everything together:
//
//   agent.js SUPABASE_TOOLS schema
//      ↓ tool_use {name, args}
//   executor in main.js (TODO: not yet wired)
//      ↓ POST /api/supabase/tools/<name>
//   THIS MODULE
//      ↓ getRefreshTokenForUser(req.user.id)
//   supabase-oauth.js (refresh-token persistence)
//      ↓ refreshToken
//   supabase-management.js (Management API client)
//      ↓ HTTPS to api.supabase.com
//   Real Supabase project
//
// Security model (defense-in-depth):
//   1. Auth required: every route 401s without a logged-in user
//   2. OAuth-connected required: 403 if the user hasn't done the dance
//   3. Refresh token never leaves this server — only access tokens that
//      supabase-management.js mints from it
//   4. project_ref ownership: Supabase enforces it (refresh token scopes
//      to the user's account); we don't double-check yet, but TODO when
//      auto-provisioning lands and we have prototype_supabase_projects
//      bindings to consult
//
// Each route returns:
//   { ok: true, data: ... } on success
//   { ok: false, error: <code>, message: <string>, status: <httpStatus> } on failure

const { getUserFromRequest } = require('./auth-helpers');
const {
  isConfigured: isSupabaseOAuthConfigured,
  getRefreshTokenForUser,
  getOauthCredsFromEnv,
} = require('./supabase-oauth');
const supabaseManagement = require('./supabase-management');
const rlsTemplates = require('./rls-templates');
const secretsVault = require('./secrets-vault');
const crypto = require('crypto');
const fs = require('node:fs');
const path = require('node:path');

// Curated Edge Function templates the AI can deploy. Each entry is a
// (slug, source-file, required-secrets) tuple — keeps the surface area
// vetted so the model can't ship arbitrary Deno code into a user's
// project. To add a new template: drop a .ts file under
// edge-function-templates/ and append an entry here.
const EDGE_FUNCTION_TEMPLATES = {
  'stripe-checkout': {
    sourceFile: path.join(__dirname, 'edge-function-templates', 'stripe-checkout.ts'),
    requiredSecrets: ['STRIPE_SECRET_KEY'],
    verifyJwt: true,  // /try prototypes call this with the anon key
    description: 'Stripe checkout-session creator. Body: { price_id, quantity?, success_url, cancel_url }.',
  },
};

// Per-user concurrency cap on tool-route requests so a runaway agent
// loop can't spam the Management API on someone's behalf. The
// supabase-management module has its own global cap (4 concurrent), but
// that one is per-process — this one is per-user, so user A's burst
// can't starve user B.
const MAX_PER_USER_INFLIGHT = 6;
const _userInflight = new Map(); // user_id → count

function _enter(userId) {
  const cur = _userInflight.get(userId) || 0;
  if (cur >= MAX_PER_USER_INFLIGHT) return false;
  _userInflight.set(userId, cur + 1);
  return true;
}

function _exit(userId) {
  const cur = _userInflight.get(userId) || 0;
  if (cur <= 1) _userInflight.delete(userId);
  else _userInflight.set(userId, cur - 1);
}

// Common preflight for every tool route. Returns either
// `{ ok, refreshToken, oauthCreds, user }` or sends the response and
// returns null (caller should `return` immediately).
function preflight(req, res, db) {
  if (!isSupabaseOAuthConfigured()) {
    res.status(503).json({ ok: false, error: 'supabase_not_configured', message: 'Supabase OAuth not configured on server.' });
    return null;
  }
  const user = getUserFromRequest(db, req);
  if (!user) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return null;
  }
  const refreshToken = getRefreshTokenForUser(db, user.id);
  if (!refreshToken) {
    res.status(403).json({ ok: false, error: 'supabase_not_connected', message: 'Connect a Supabase account first.' });
    return null;
  }
  if (!_enter(user.id)) {
    res.status(429).json({ ok: false, error: 'too_many_inflight', message: `Max ${MAX_PER_USER_INFLIGHT} concurrent Supabase tool calls per user.` });
    return null;
  }
  return { user, refreshToken, oauthCreds: getOauthCredsFromEnv() };
}

// Map a Management API error to an HTTP response. supabase-management.js
// throws errors with .status set to the upstream status, so we propagate
// 4xx but collapse 5xx into 502.
function sendUpstreamError(res, err, route) {
  const status = (err && err.status) || 500;
  const httpStatus = status >= 400 && status < 500 ? status : 502;
  res.status(httpStatus).json({
    ok: false,
    error: 'supabase_api_error',
    message: err?.message || `Upstream Supabase error during ${route}`,
    status,
  });
}

/**
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
function registerSupabaseToolRoutes(app, db) {
  // ── list_organizations ──────────────────────────────────────────────
  app.post('/api/supabase/tools/list_organizations', async (req, res) => {
    const ctx = preflight(req, res, db); if (!ctx) return;
    try {
      const data = await supabaseManagement.listOrganizations({
        refreshToken: ctx.refreshToken, oauthCreds: ctx.oauthCreds,
      });
      res.json({ ok: true, data });
    } catch (err) {
      sendUpstreamError(res, err, 'list_organizations');
    } finally { _exit(ctx.user.id); }
  });

  // ── create_supabase_project ─────────────────────────────────────────
  app.post('/api/supabase/tools/create_supabase_project', async (req, res) => {
    const ctx = preflight(req, res, db); if (!ctx) return;
    const { organization_id, name, region } = req.body || {};
    if (!organization_id || typeof organization_id !== 'string') {
      _exit(ctx.user.id);
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'organization_id required' });
    }
    if (!name || typeof name !== 'string' || name.length > 100) {
      _exit(ctx.user.id);
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'name required (max 100 chars)' });
    }
    // Strong random db_pass; we don't persist or surface it in v1 since
    // users can reset via the Supabase dashboard. TODO when
    // prototype_supabase_projects gains a db_pass column: store it here.
    const dbPass = crypto.randomBytes(32).toString('base64url');
    try {
      const data = await supabaseManagement.createProject({
        refreshToken: ctx.refreshToken, oauthCreds: ctx.oauthCreds,
        organizationId: organization_id, name, region: region || 'us-east-1', dbPass,
      });
      // Return only the public-safe fields — never echo dbPass.
      res.json({
        ok: true,
        data: {
          project_ref: data?.id || data?.ref,
          name: data?.name,
          region: data?.region,
          status: data?.status || 'provisioning',
          created_at: data?.created_at,
        },
      });
    } catch (err) {
      sendUpstreamError(res, err, 'create_supabase_project');
    } finally { _exit(ctx.user.id); }
  });

  // ── list_supabase_tables ────────────────────────────────────────────
  app.post('/api/supabase/tools/list_supabase_tables', async (req, res) => {
    const ctx = preflight(req, res, db); if (!ctx) return;
    const { project_ref, schema } = req.body || {};
    if (!project_ref) {
      _exit(ctx.user.id);
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'project_ref required' });
    }
    try {
      const data = await supabaseManagement.listTables({
        refreshToken: ctx.refreshToken, oauthCreds: ctx.oauthCreds,
        projectRef: project_ref, schema: schema || 'public',
      });
      res.json({ ok: true, data });
    } catch (err) {
      sendUpstreamError(res, err, 'list_supabase_tables');
    } finally { _exit(ctx.user.id); }
  });

  // ── apply_migration ─────────────────────────────────────────────────
  app.post('/api/supabase/tools/apply_migration', async (req, res) => {
    const ctx = preflight(req, res, db); if (!ctx) return;
    const { project_ref, name, sql } = req.body || {};
    if (!project_ref || !name || !sql) {
      _exit(ctx.user.id);
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'project_ref, name, sql required' });
    }
    if (typeof sql !== 'string' || sql.length > 200_000) {
      _exit(ctx.user.id);
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'sql must be a string ≤ 200KB' });
    }
    if (!/^[a-z0-9_-]{1,80}$/i.test(name)) {
      _exit(ctx.user.id);
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'name must be 1–80 chars [a-z0-9_-]' });
    }
    try {
      const data = await supabaseManagement.applyMigration({
        refreshToken: ctx.refreshToken, oauthCreds: ctx.oauthCreds,
        projectRef: project_ref, name, sql,
      });
      res.json({ ok: true, data });
    } catch (err) {
      sendUpstreamError(res, err, 'apply_migration');
    } finally { _exit(ctx.user.id); }
  });

  // ── apply_rls_template ──────────────────────────────────────────────
  app.post('/api/supabase/tools/apply_rls_template', async (req, res) => {
    const ctx = preflight(req, res, db); if (!ctx) return;
    const { project_ref, template_id, params } = req.body || {};
    if (!project_ref || !template_id || !params || typeof params !== 'object') {
      _exit(ctx.user.id);
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'project_ref, template_id, params required' });
    }
    let sql;
    try {
      sql = rlsTemplates.renderRLSTemplate(template_id, params);
    } catch (err) {
      _exit(ctx.user.id);
      return res.status(400).json({ ok: false, error: 'rls_template_invalid', message: err.message });
    }
    // Auto-name the migration after the template + table for traceable history.
    const tableName = (params && params.TABLE) ? String(params.TABLE).slice(0, 40) : 'table';
    const migrationName = `rls_${template_id}_${tableName}`.replace(/[^a-z0-9_-]/gi, '_');
    try {
      const data = await supabaseManagement.applyMigration({
        refreshToken: ctx.refreshToken, oauthCreds: ctx.oauthCreds,
        projectRef: project_ref, name: migrationName, sql,
      });
      res.json({ ok: true, data: { ...data, template_id, sql, migration_name: migrationName } });
    } catch (err) {
      sendUpstreamError(res, err, 'apply_rls_template');
    } finally { _exit(ctx.user.id); }
  });

  // ── query_database ──────────────────────────────────────────────────
  app.post('/api/supabase/tools/query_database', async (req, res) => {
    const ctx = preflight(req, res, db); if (!ctx) return;
    const { project_ref, sql } = req.body || {};
    if (!project_ref || !sql) {
      _exit(ctx.user.id);
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'project_ref, sql required' });
    }
    if (typeof sql !== 'string' || sql.length > 50_000) {
      _exit(ctx.user.id);
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'sql must be a string ≤ 50KB' });
    }
    // Belt-and-braces read-only check: refuse anything that isn't a SELECT
    // (or a WITH...SELECT). The Management API will execute whatever we
    // send, so an LLM emitting "DROP TABLE" via this tool would be very
    // bad. apply_migration is the path for writes.
    const trimmed = sql.trim().replace(/^\(\s*/, '');
    if (!/^(select|with)\s/i.test(trimmed)) {
      _exit(ctx.user.id);
      return res.status(400).json({ ok: false, error: 'read_only_violation', message: 'query_database is read-only — use apply_migration for writes.' });
    }
    try {
      const data = await supabaseManagement.query({
        refreshToken: ctx.refreshToken, oauthCreds: ctx.oauthCreds,
        projectRef: project_ref, sql,
      });
      res.json({ ok: true, data });
    } catch (err) {
      sendUpstreamError(res, err, 'query_database');
    } finally { _exit(ctx.user.id); }
  });

  // ── get_anon_key ────────────────────────────────────────────────────
  // Polled by the frontend after create_supabase_project until non-null.
  // The Management API's /api-keys endpoint 404s while provisioning, so
  // we collapse 404 to `{ ok: true, data: null }` to make polling simple.
  app.post('/api/supabase/tools/get_anon_key', async (req, res) => {
    const ctx = preflight(req, res, db); if (!ctx) return;
    const { project_ref } = req.body || {};
    if (!project_ref) {
      _exit(ctx.user.id);
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'project_ref required' });
    }
    try {
      const anonKey = await supabaseManagement.getAnonKey({
        refreshToken: ctx.refreshToken, oauthCreds: ctx.oauthCreds,
        projectRef: project_ref,
      });
      res.json({ ok: true, data: { anon_key: anonKey, project_url: `https://${project_ref}.supabase.co` } });
    } catch (err) {
      if (err && err.status === 404) {
        // Project still provisioning — return null so the poller keeps trying.
        return res.json({ ok: true, data: { anon_key: null, project_url: `https://${project_ref}.supabase.co` } });
      }
      sendUpstreamError(res, err, 'get_anon_key');
    } finally { _exit(ctx.user.id); }
  });

  // ── add_stripe_checkout — Phase 5 marquee ───────────────────────────
  // Orchestrates: read STRIPE_SECRET_KEY from the prototype's vault →
  // push it into the project's Edge Function secrets → deploy the
  // curated stripe-checkout function source. Returns the public function
  // URL the prototype can POST to.
  app.post('/api/supabase/tools/add_stripe_checkout', async (req, res) => {
    const ctx = preflight(req, res, db); if (!ctx) return;
    const { project_ref, prototype_id } = req.body || {};
    if (!project_ref || !prototype_id) {
      _exit(ctx.user.id);
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'project_ref and prototype_id required' });
    }
    if (!secretsVault.isConfigured()) {
      _exit(ctx.user.id);
      return res.status(503).json({ ok: false, error: 'vault_not_configured', message: 'Server-side secrets vault not configured.' });
    }
    // Confirm the prototype belongs to this user before reading their secrets.
    const ownsProto = db.prepare('SELECT 1 FROM saved_prototypes WHERE id = ? AND user_id = ?').get(prototype_id, ctx.user.id);
    if (!ownsProto) {
      _exit(ctx.user.id);
      return res.status(404).json({ ok: false, error: 'prototype_not_found' });
    }
    const tmpl = EDGE_FUNCTION_TEMPLATES['stripe-checkout'];
    // Read every required secret from the user's vault. If any is
    // missing, return early with a structured error so the frontend can
    // tell the user exactly which key to pin.
    const secretsToSync = [];
    for (const name of tmpl.requiredSecrets) {
      let value;
      try { value = secretsVault.readSecret(db, prototype_id, name); }
      catch (err) {
        _exit(ctx.user.id);
        return res.status(500).json({ ok: false, error: 'vault_decrypt_failed', message: err.message });
      }
      if (!value) {
        _exit(ctx.user.id);
        return res.status(412).json({ ok: false, error: 'missing_secret', message: `Pin ${name} in the 🔐 Secrets dialog before adding Stripe checkout.`, missing: name });
      }
      secretsToSync.push({ name, value });
    }
    let body;
    try { body = fs.readFileSync(tmpl.sourceFile, 'utf8'); }
    catch (err) {
      _exit(ctx.user.id);
      return res.status(500).json({ ok: false, error: 'template_read_failed', message: err.message });
    }
    try {
      // 1) Push secrets into the project's Edge Function env.
      await supabaseManagement.setProjectSecrets({
        refreshToken: ctx.refreshToken, oauthCreds: ctx.oauthCreds,
        projectRef: project_ref, secrets: secretsToSync,
      });
      // 2) Deploy the function.
      const fn = await supabaseManagement.deployEdgeFunction({
        refreshToken: ctx.refreshToken, oauthCreds: ctx.oauthCreds,
        projectRef: project_ref, slug: 'stripe-checkout', name: 'Stripe checkout',
        body, verifyJwt: tmpl.verifyJwt,
      });
      const url = `https://${project_ref}.supabase.co/functions/v1/stripe-checkout`;
      res.json({
        ok: true,
        data: {
          slug: 'stripe-checkout',
          url,
          synced_secrets: secretsToSync.map((s) => s.name), // never echo values
          fn,
        },
      });
    } catch (err) {
      sendUpstreamError(res, err, 'add_stripe_checkout');
    } finally { _exit(ctx.user.id); }
  });

  // ── list_rls_templates ──────────────────────────────────────────────
  // Read-only metadata; useful for the frontend to render a picker. Does
  // NOT require Supabase OAuth — anyone signed in can browse the catalog.
  app.get('/api/supabase/tools/list_rls_templates', (req, res) => {
    const user = getUserFromRequest(db, req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.json({ ok: true, data: rlsTemplates.listTemplates() });
  });
}

module.exports = { registerSupabaseToolRoutes };
