'use strict';

// project-access.js — the SINGLE authoritative gate for "can this user act on
// this deployed resource". Every cloud-apps / cloud-workers / cloud-backend
// ownership check funnels through resolveResourceAccess so the membership rule
// lives in exactly one place (see the biggest-risk note in the plan: a missed
// call site is a cross-tenant data breach).
//
// A resource row carries a nullable `project_id`:
//   - NULL  → legacy solo resource; access falls back to the direct user_id check.
//   - set   → shared resource; access is the caller's project_members role.

const ROLE_WEIGHT = { owner: 3, editor: 2, viewer: 1 };

function roleAtLeast(role, minRole) {
  return (ROLE_WEIGHT[role] || 0) >= (ROLE_WEIGHT[minRole] || 0);
}

// Resource tables that may carry a project_id. Whitelisted so the table name is
// never derived from user input (it's interpolated into SQL below).
const RESOURCE_TABLES = new Set(['account_backends', 'cloud_apps', 'cloud_workers']);

/**
 * The caller's effective membership role for a project (or null if not a member).
 * @returns {'owner'|'editor'|'viewer'|null}
 */
function projectRole(db, projectId, userId) {
  if (!projectId || !userId) return null;
  const m = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId);
  return m ? m.role : null;
}

/**
 * Resolve a user's access to a single resource row.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {'account_backends'|'cloud_apps'|'cloud_workers'} opts.resourceTable
 * @param {string} [opts.resourceId]   id to look up (ignored if `row` is given)
 * @param {object} [opts.row]          pre-fetched resource row (avoids a 2nd SELECT)
 * @param {string} opts.userId         the caller
 * @param {'owner'|'editor'|'viewer'} [opts.minRole='owner']  required level (fail-closed default)
 * @returns {{ok:true,row:object,role:string,projectId:string|null,legacy:boolean}
 *          | {ok:false,code:'not_found'|'forbidden'}}
 *   `not_found` is returned for both a missing row AND a non-member (don't leak
 *   existence of another tenant's resource). `forbidden` is only for a real
 *   member whose role is below minRole.
 */
function resolveResourceAccess(db, { resourceTable, resourceId, row, userId, minRole = 'owner' }) {
  if (!RESOURCE_TABLES.has(resourceTable)) throw new Error(`resolveResourceAccess: bad table ${resourceTable}`);
  if (!row) {
    row = db.prepare(`SELECT * FROM ${resourceTable} WHERE id = ?`).get(String(resourceId || ''));
  }
  if (!row) return { ok: false, code: 'not_found' };

  // Legacy solo resource: direct ownership only.
  if (!row.project_id) {
    if (row.user_id !== userId) return { ok: false, code: 'not_found' };
    return { ok: true, row, role: 'owner', projectId: null, legacy: true };
  }

  // Shared resource: membership decides.
  const role = projectRole(db, row.project_id, userId);
  if (!role) return { ok: false, code: 'not_found' };       // not a member → hide existence
  if (!roleAtLeast(role, minRole)) return { ok: false, code: 'forbidden' };
  return { ok: true, row, role, projectId: row.project_id, legacy: false };
}

module.exports = { ROLE_WEIGHT, roleAtLeast, projectRole, resolveResourceAccess };
