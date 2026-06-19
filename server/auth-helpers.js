'use strict';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @returns {object | null} user row
 */
function getUserFromRequest(db, req) {
  const auth = req.headers.authorization;
  if (auth && typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (!token) return null;
    const u = db.prepare('SELECT * FROM users WHERE api_access_token = ?').get(token);
    if (u && u.email_verified != null && Number(u.email_verified) === 0) return null;
    return u;
  }
  if (req.session && req.session.account && req.session.account.userId) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.account.userId);
    if (u && u.email_verified != null && Number(u.email_verified) === 0) return null;
    return u;
  }
  return null;
}

module.exports = { getUserFromRequest };
