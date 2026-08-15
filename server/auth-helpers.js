'use strict';

const { resolveToken } = require('./account-tokens');

/**
 * Resolve a project-scoped bearer while retaining the historical helper shape.
 * New callers should use getUserFromRequest so all bearer policies stay central.
 */
function resolveScopedToken(db, token) {
  const resolved = resolveToken(db, token);
  if (!resolved || !resolved.tokenScope) return null;
  return {
    user_id: resolved.user.id,
    project_key: resolved.tokenScope.projectKey,
    caps: resolved.tokenScope.caps,
    token_id: resolved.tokenId,
  };
}

/**
 * Resolve digest-backed or Stage-1 legacy bearer credentials, then fall back to
 * the existing browser session. Project tokens stamp req.tokenScope; account
 * tokens remain unrestricted for backward compatibility.
 */
function getUserFromRequest(db, req) {
  const auth = req.headers.authorization;
  if (auth && typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (!token) return null;
    const resolved = resolveToken(db, token);
    if (!resolved) return null;
    if (resolved.tokenScope) {
      try { req.tokenScope = resolved.tokenScope; } catch (_) {}
    }
    return resolved.user;
  }
  if (req.session && req.session.account && req.session.account.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.account.userId);
    if (user && user.email_verified != null && Number(user.email_verified) === 0) return null;
    return user || null;
  }
  return null;
}

module.exports = { getUserFromRequest, resolveScopedToken };
