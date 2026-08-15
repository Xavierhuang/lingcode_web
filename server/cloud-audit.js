'use strict';

// cloud-audit.js — the control-plane audit trail.
//
// Logging must NEVER break the operation it records, so every function here
// swallows its own errors. That is deliberate and load-bearing: an audit write
// that can fail a sign-in turns a logging outage into an availability outage.
//
// The tradeoff is that a silent audit failure is invisible. `auditHealth()`
// exists so the compliance surface can report "the log is being written to"
// rather than assuming it — an empty audit log and a broken audit log look
// identical from the outside.

const { AUDIT_RETENTION_MS } = require('./migrate');

// Canonical action names. Free-form strings would drift into `user.login`,
// `login`, `signIn` and make the evidence export unqueryable, so callers use
// these constants and the export can group by them with confidence.
// Convention: `<resource>.<verb>`, past-tense-neutral, lowercase.
const AUDIT = {
  // Authentication (CC6.1) — the events an auditor asks for first.
  AUTH_SIGNIN: 'auth.signin',
  AUTH_SIGNOUT: 'auth.signout',
  AUTH_SIGNUP: 'auth.signup',
  AUTH_THROTTLED: 'auth.throttled',
  AUTH_PASSWORD_RESET: 'auth.password_reset',
  AUTH_EMAIL_CODE_SENT: 'auth.email_code_sent',

  // Credential lifecycle (CC6.1, CC6.2/6.3 — provisioning and deprovisioning).
  TOKEN_ISSUE: 'token.issue',
  TOKEN_REVOKE: 'token.revoke',

  // Access-grant changes (CC6.2/6.3).
  PROJECT_INVITE: 'project.invite',
  PROJECT_ROLE_CHANGE: 'project.role_change',
  PROJECT_MEMBER_REMOVE: 'project.member_remove',
  PROJECT_TRANSFER: 'project.transfer',

  // Confidentiality (C1.1) — secret access is itself sensitive.
  SECRET_WRITE: 'secret.write',
  SECRET_DELETE: 'secret.delete',
  SECRET_READ: 'secret.read',

  // Change management (CC8.1).
  WORKER_DEPLOY: 'worker.deploy',
  WORKER_SUSPEND: 'worker.suspend',
  WORKER_RESUME: 'worker.resume',
  DOMAIN_ADD: 'domain.add',
  DOMAIN_REMOVE: 'domain.remove',
  SCHEMA_MIGRATION: 'schema.migration',

  // Availability (A1.2) — backup/restore drills land here so the evidence
  // bundle can prove restores were exercised, not just that backups ran.
  BACKUP_RUN: 'backup.run',
  BACKUP_RESTORE_TEST: 'backup.restore_test',
};

const MAX_UA = 512;
const MAX_METADATA = 8000;

// An audit trail that captures secret values is a credential store with a
// retention policy — worse than no audit trail, because it is queryable and
// widely readable. Redaction therefore runs on two independent axes, because
// either one alone fails on a real payload:
//
//   {"key": "STRIPE_KEY", "value": "sk_live_…"}
//
// Name-matching alone redacts the harmless identifier (`key`) and preserves the
// live credential, since `value` is not a suspicious name. Shape-matching alone
// misses secrets that don't follow a known vendor format. Both run.
//
// Note that bare `key` is deliberately absent from the name list: a secrets
// vault's audit row must record *which* key changed, or "someone wrote a
// secret" is unactionable. Shape-matching covers a credential that lands in
// such a field anyway.
const REDACT_KEY = /password|passphrase|secret|token|credential|authorization|cookie|session|(api|access|private|signing|master|vault)[_-]?key/i;

// Credential shapes, redacted regardless of the field name that holds them.
// Same vendor vocabulary as the /try pre-publish leak scan
// (website/try/main-leak-scan.js:17-28), plus LingCode's own token prefixes and
// JWTs. sk-ant- precedes sk- because alternation is first-match-wins.
const REDACT_VALUE = new RegExp([
  'AKIA[0-9A-Z]{12,}',                        // AWS access key id
  'gh[pousr]_[A-Za-z0-9]{20,}',               // GitHub token
  'sk-ant-[A-Za-z0-9_-]{16,}',                // Anthropic
  'sk-[A-Za-z0-9]{20,}',                      // OpenAI
  'sk_(live|test)_[A-Za-z0-9]{16,}',          // Stripe
  'AIza[0-9A-Za-z_-]{30,}',                   // Google
  'lc(at|t)_[0-9a-f]{32,}',                   // LingCode account / project tokens
  'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.', // JWT
].join('|'));

function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && REDACT_VALUE.test(value)) return '[redacted]';
  return value;
}

/**
 * Pull actor + provenance off an Express request. Safe on a partial or absent
 * req so callers in non-HTTP contexts (cron, CLI) can omit it.
 */
function actorFromRequest(req) {
  if (!req || typeof req !== 'object') return {};
  let userId = null;
  try {
    userId = (req.auditUser && req.auditUser.id)
      || (req.session && req.session.account && req.session.account.userId)
      || null;
  } catch (_) { /* malformed session — provenance is best-effort */ }
  return {
    actorUserId: userId,
    actorTokenId: req.tokenId || null,   // stamped by auth-helpers.getUserFromRequest
    ip: req.ip || null,                  // trustworthy: index.js sets 'trust proxy'
    userAgent: String(req.headers && req.headers['user-agent'] || '').slice(0, MAX_UA) || null,
    requestId: req.requestId || null,    // stamped by security-config.requestId()
  };
}

/**
 * Append one row to the audit trail. Never throws.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} entry
 * @param {string} entry.action        one of AUDIT.*
 * @param {'success'|'failure'|'denied'} [entry.outcome='success']
 * @param {object} [entry.req]         Express request; supplies actor, ip, ua, request id
 * @param {string} [entry.actorUserId] overrides the actor from req (e.g. the user being acted upon)
 * @param {string} [entry.resourceType]
 * @param {string} [entry.resourceId]
 * @param {string} [entry.projectId]
 * @param {object} [entry.metadata]    redacted before storage
 */
function recordAudit(db, entry) {
  try {
    if (!db || !entry || !entry.action) return;
    const from = actorFromRequest(entry.req);
    let metadata = '{}';
    try {
      metadata = JSON.stringify(redact(entry.metadata || {})).slice(0, MAX_METADATA);
    } catch (_) { metadata = '{"_":"unserializable"}'; }

    db.prepare(
      `INSERT INTO audit_log
         (created_at, action, outcome, actor_user_id, actor_token_id,
          resource_type, resource_id, project_id, ip, user_agent, request_id, metadata_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      Date.now(),
      String(entry.action),
      String(entry.outcome || 'success'),
      entry.actorUserId !== undefined ? (entry.actorUserId || null) : (from.actorUserId || null),
      entry.actorTokenId !== undefined ? (entry.actorTokenId || null) : (from.actorTokenId || null),
      entry.resourceType || null,
      entry.resourceId != null ? String(entry.resourceId) : null,
      entry.projectId != null ? String(entry.projectId) : null,
      entry.ip || from.ip || null,
      entry.userAgent || from.userAgent || null,
      entry.requestId || from.requestId || null,
      metadata
    );
  } catch (_) { /* audit is best-effort — never throw */ }
}

/**
 * One row per apply_migration call → schema_migrations. Gives the console a
 * history of every schema change (what ran, who, when, applied/failed) so DDL
 * isn't a black box. Purely additive; does not auto-reverse anything.
 *
 * Also mirrored into audit_log so the evidence export sees schema changes
 * alongside every other control-plane action. schema_migrations keeps the full
 * SQL for the console; the audit row carries only a digest and a length, since
 * DDL text can embed literal values.
 */
function recordSchemaMigration(db, { backendId, userId, sql, status, error, req } = {}) {
  try {
    db.prepare(
      'INSERT INTO schema_migrations (backend_id, user_id, sql, status, error, created_at) VALUES (?,?,?,?,?,?)'
    ).run(
      String(backendId || ''),
      userId || null,
      String(sql || '').slice(0, 200000),
      String(status || ''),
      error ? String(error).slice(0, 2000) : null,
      Date.now()
    );
  } catch (_) { /* audit is best-effort — never throw */ }

  recordAudit(db, {
    action: AUDIT.SCHEMA_MIGRATION,
    outcome: String(status || '') === 'applied' ? 'success' : 'failure',
    req,
    actorUserId: userId || null,
    resourceType: 'backend',
    resourceId: backendId,
    metadata: {
      status: String(status || ''),
      sql_bytes: String(sql || '').length,
      error: error ? String(error).slice(0, 500) : undefined,
    },
  });
}

/**
 * Drop rows past the retention horizon. The append-only trigger permits DELETE
 * only outside that window, so this cannot be repurposed to erase recent
 * activity even by a caller that wants to. Returns rows removed (0 on error).
 */
function pruneAuditLog(db) {
  try {
    return db.prepare('DELETE FROM audit_log WHERE created_at < ?')
      .run(Date.now() - AUDIT_RETENTION_MS).changes || 0;
  } catch (_) { return 0; }
}

/**
 * Read the trail back for the console viewer and the Track C evidence export.
 * Filters are all optional and AND-ed together.
 */
function queryAuditLog(db, filters = {}) {
  try {
    const where = [];
    const args = [];
    const eq = (col, val) => { if (val != null && val !== '') { where.push(`${col} = ?`); args.push(String(val)); } };
    eq('actor_user_id', filters.actorUserId);
    eq('project_id', filters.projectId);
    eq('resource_type', filters.resourceType);
    eq('resource_id', filters.resourceId);
    eq('action', filters.action);
    eq('outcome', filters.outcome);
    eq('request_id', filters.requestId);
    if (filters.since != null) { where.push('created_at >= ?'); args.push(Number(filters.since)); }
    if (filters.until != null) { where.push('created_at <= ?'); args.push(Number(filters.until)); }

    const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 500, 1), 10000);
    const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

    return db.prepare(
      `SELECT * FROM audit_log
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`
    ).all(...args, limit, offset);
  } catch (_) { return []; }
}

/**
 * Is the trail actually being written to? Because recordAudit swallows its own
 * failures, a misconfigured or broken log is silent — and indistinguishable
 * from a quiet system. The compliance surface reports this rather than
 * inferring health from row count alone.
 */
function auditHealth(db) {
  try {
    const row = db.prepare('SELECT count(*) AS total, max(created_at) AS newest FROM audit_log').get();
    return {
      ok: true,
      total: row.total || 0,
      newestAt: row.newest || null,
      retentionMs: AUDIT_RETENTION_MS,
      stale: row.newest ? (Date.now() - row.newest) > 24 * 60 * 60 * 1000 : true,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), retentionMs: AUDIT_RETENTION_MS };
  }
}

module.exports = {
  AUDIT,
  recordAudit,
  recordSchemaMigration,
  actorFromRequest,
  pruneAuditLog,
  queryAuditLog,
  auditHealth,
};
