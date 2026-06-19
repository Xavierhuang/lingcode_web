'use strict';

// cloud-audit.js — best-effort audit logging for managed-backend changes.
// Logging must NEVER break the operation it records, so every function here
// swallows its own errors.

// One row per apply_migration call → schema_migrations. Gives the console a
// history of every schema change (what ran, who, when, applied/failed) so DDL
// isn't a black box. Purely additive; does not auto-reverse anything.
function recordSchemaMigration(db, { backendId, userId, sql, status, error }) {
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
}

module.exports = { recordSchemaMigration };
