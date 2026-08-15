'use strict';

const crypto = require('node:crypto');
const { migrateAccountTokensTable } = require('./migrate');

const DEVELOPMENT_PEPPER = 'lingcode-local-development-token-pepper-do-not-use-in-production';
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ACTIVE_ACCOUNT_TOKENS = 10;

function tokenPepper(options = {}) {
  const pepper = options.pepper || process.env.LINGCODE_TOKEN_PEPPER;
  if (pepper) return String(pepper);
  if ((options.nodeEnv || process.env.NODE_ENV) === 'production') {
    const error = new Error('Unsafe production security configuration: LINGCODE_TOKEN_PEPPER');
    error.code = 'unsafe_security_configuration';
    throw error;
  }
  return DEVELOPMENT_PEPPER;
}

function digestToken(raw, pepper) {
  return crypto.createHmac('sha256', pepper).update(String(raw), 'utf8').digest('hex');
}

function insertLegacy(db, row, options) {
  const pepper = tokenPepper(options);
  const result = db.prepare(`INSERT OR IGNORE INTO account_tokens
    (id,user_id,digest_version,token_digest,display_prefix,scope,project_key,caps,created_at,expires_at,revoked_at,legacy_source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    crypto.randomUUID(), row.userId, 'h1', digestToken(row.token, pepper),
    String(row.token).slice(0, 12), row.scope, row.projectKey || null, row.caps || '',
    Number(row.createdAt || options.now || Date.now()), row.expiresAt == null ? null : Number(row.expiresAt),
    row.revokedAt == null ? null : Number(row.revokedAt), row.legacySource
  );
  return result.changes;
}

function migrateAccountTokens(db, options = {}) {
  migrateAccountTokensTable(db);
  const now = options.now == null ? Date.now() : Number(options.now);
  let legacyAccountBackfilled = 0;
  let legacyScopedBackfilled = 0;
  let accountRows = [];
  let scopedRows = [];
  try {
    accountRows = db.prepare("SELECT id, api_access_token FROM users WHERE api_access_token IS NOT NULL AND api_access_token != ''").all();
  } catch (_) {}
  try {
    scopedRows = db.prepare("SELECT token,user_id,project_key,caps,created_at,expires_at,revoked_at FROM scoped_tokens WHERE token IS NOT NULL AND token != ''").all();
  } catch (_) {}
  const tx = db.transaction(() => {
    for (const row of accountRows) {
      legacyAccountBackfilled += insertLegacy(db, {
        token: row.api_access_token,
        userId: row.id,
        scope: 'account',
        createdAt: now,
        legacySource: 'users.api_access_token',
      }, { ...options, now });
    }
    for (const row of scopedRows) {
      legacyScopedBackfilled += insertLegacy(db, {
        token: row.token,
        userId: row.user_id,
        scope: 'project',
        projectKey: row.project_key,
        caps: row.caps,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        legacySource: 'scoped_tokens.token',
      }, { ...options, now });
    }
  });
  tx();
  return { legacyAccountBackfilled, legacyScopedBackfilled };
}

function issueToken(db, userId, options = {}) {
  migrateAccountTokensTable(db);
  const pepper = tokenPepper(options);
  const scope = options.scope === 'project' ? 'project' : 'account';
  const now = options.now == null ? Date.now() : Number(options.now);
  const token = `${scope === 'project' ? 'lct' : 'lcat'}_${crypto.randomBytes(32).toString('hex')}`;
  const id = crypto.randomUUID();
  const expiresAt = options.expiresAt == null ? null : Number(options.expiresAt);
  const projectKey = scope === 'project' ? String(options.projectKey || '') : null;
  if (scope === 'project' && !projectKey) throw new Error('projectKey is required for a project token');
  const caps = scope === 'project' ? String(options.caps || 'cloud+inference') : '';

  db.transaction(() => {
    db.prepare(`INSERT INTO account_tokens
      (id,user_id,digest_version,token_digest,display_prefix,scope,project_key,caps,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      id, userId, 'h1', digestToken(token, pepper), token.slice(0, 12), scope,
      projectKey, caps, now, expiresAt
    );
    if (scope === 'account') {
      const excess = db.prepare(`SELECT id FROM account_tokens
        WHERE user_id=? AND scope='account' AND revoked_at IS NULL AND legacy_source IS NULL
          AND (expires_at IS NULL OR expires_at>?)
        ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?`).all(userId, now, MAX_ACTIVE_ACCOUNT_TOKENS);
      const revoke = db.prepare('UPDATE account_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL');
      for (const row of excess) revoke.run(now, row.id);
    }
  })();
  return { token, id, scope, projectKey, expiresAt };
}

function touchLastUsed(db, row, now) {
  if (row.last_used_at != null && now - Number(row.last_used_at) < LAST_USED_WRITE_INTERVAL_MS) return;
  db.prepare(`UPDATE account_tokens SET last_used_at=?
    WHERE id=? AND (last_used_at IS NULL OR last_used_at<=?)`)
    .run(now, row.id, now - LAST_USED_WRITE_INTERVAL_MS);
}

function resolvedResult(db, row, now, legacy) {
  if (!row || row.revoked_at != null) return null;
  if (row.expires_at != null && now > Number(row.expires_at)) return null;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id);
  if (!user) return null;
  if (user.email_verified != null && Number(user.email_verified) === 0) return null;
  if (row.id) touchLastUsed(db, row, now);
  return {
    user,
    tokenScope: row.scope === 'project'
      ? { projectKey: row.project_key, caps: String(row.caps || '') }
      : null,
    tokenId: row.id || null,
    legacy: Boolean(legacy),
  };
}

function resolveToken(db, rawToken, options = {}) {
  const raw = String(rawToken || '').trim();
  if (!raw) return null;
  const pepper = tokenPepper(options);
  const now = options.now == null ? Date.now() : Number(options.now);
  let row;
  try {
    row = db.prepare('SELECT * FROM account_tokens WHERE digest_version=? AND token_digest=?')
      .get('h1', digestToken(raw, pepper));
  } catch (_) {
    row = null;
  }
  if (row) return resolvedResult(db, row, now, row.legacy_source != null);

  // Stage 1 compatibility only: credentials created before the digest migration
  // remain valid until the separately approved plaintext-cleanup stage.
  try {
    const user = db.prepare('SELECT * FROM users WHERE api_access_token=?').get(raw);
    if (user) return resolvedResult(db, {
      user_id: user.id, scope: 'account', revoked_at: null, expires_at: null
    }, now, true);
  } catch (_) {}
  try {
    const scoped = db.prepare('SELECT * FROM scoped_tokens WHERE token=?').get(raw);
    if (scoped) return resolvedResult(db, {
      user_id: scoped.user_id,
      scope: 'project',
      project_key: scoped.project_key,
      caps: scoped.caps,
      revoked_at: scoped.revoked_at,
      expires_at: scoped.expires_at,
    }, now, true);
  } catch (_) {}
  return null;
}

function revokeToken(db, tokenId, userId, options = {}) {
  const now = options.now == null ? Date.now() : Number(options.now);
  return db.prepare('UPDATE account_tokens SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL')
    .run(now, tokenId, userId).changes > 0;
}

function revokeUserTokens(db, userId, options = {}) {
  const now = options.now == null ? Date.now() : Number(options.now);
  const scope = options.scope === 'project' ? 'project' : options.scope === 'account' ? 'account' : null;
  const result = scope
    ? db.prepare('UPDATE account_tokens SET revoked_at=? WHERE user_id=? AND scope=? AND revoked_at IS NULL').run(now, userId, scope)
    : db.prepare('UPDATE account_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now, userId);
  return result.changes;
}

module.exports = {
  digestToken,
  migrateAccountTokens,
  issueToken,
  resolveToken,
  revokeToken,
  revokeUserTokens,
};
