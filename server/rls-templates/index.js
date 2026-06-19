'use strict';

// rls-templates — vetted Postgres RLS policies the AI can apply against
// a user's Supabase project. Phase 3 of the /try Lovable-parity plan.
//
// Why pre-curated templates instead of letting the model freeform RLS?
// RLS policy bugs leak data silently. By restricting the AI to a small
// set of vetted patterns parameterized by table/column names, we avoid
// the entire class of "model invented a clever USING clause that always
// returns true" bugs. The AI picks a template by id and supplies the
// table + column names; this module substitutes them in safely.
//
// Wire-up (Phase 3): inference-anthropic.js exposes `apply_rls_template`
// as a tool whose dispatcher calls renderRLSTemplate(id, params) and
// hands the result to supabase-management.js for SQL apply.

const fs = require('node:fs');
const path = require('node:path');

// Postgres unquoted identifier: must start with a letter or underscore,
// then letters/digits/underscores, max 63 chars (NAMEDATALEN-1). We
// require lowercase to match Supabase migration convention (Postgres
// lowercases unquoted identifiers anyway, so `Foo` and `foo` collide).
const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

const TEMPLATES = [
  {
    id: 'user-owns-row',
    file: 'user-owns-row.sql',
    label: 'User owns row',
    description:
      'Each row of the table is owned by exactly one user, identified by a column whose value matches auth.uid(). Owner can SELECT/INSERT/UPDATE/DELETE; nobody else sees the row at all.',
    when_to_use:
      'Personal todos, notes, drafts, files — anything where the row belongs to one specific user and never needs to be shared.',
    params: [
      { name: 'TABLE', description: 'Table name (snake_case).', required: true },
      { name: 'USER_COL', description: 'UUID column on TABLE that holds the owner user id (e.g. user_id, owner_id).', required: true },
    ],
  },
  {
    id: 'team-scoped',
    file: 'team-scoped.sql',
    label: 'Team-scoped',
    description:
      'Rows belong to a team via a team_id column. A user is a member of a team if a row exists in a members table linking the team and the user. All members see and edit; non-members see nothing.',
    when_to_use:
      'Multi-tenant SaaS: workspaces, organizations, projects shared by a small team. Apply this template to the members table too with the appropriate user-owns-row pattern.',
    params: [
      { name: 'TABLE', description: 'The team-scoped data table.', required: true },
      { name: 'TEAM_COL', description: 'UUID column on TABLE that holds the team id (e.g. team_id).', required: true },
      { name: 'MEMBERS_TABLE', description: 'Table that joins users to teams (e.g. team_members).', required: true },
      { name: 'MEMBERS_TEAM_COL', description: 'Column on MEMBERS_TABLE pointing to the team (e.g. team_id).', required: true },
      { name: 'MEMBERS_USER_COL', description: 'Column on MEMBERS_TABLE pointing to the user (e.g. user_id).', required: true },
    ],
  },
  {
    id: 'public-read-auth-write',
    file: 'public-read-auth-write.sql',
    label: 'Public read, authenticated write',
    description:
      'Anyone (including unauthenticated visitors) can SELECT. Only signed-in users can INSERT, and only as themselves. Only the owner can UPDATE or DELETE their own rows.',
    when_to_use:
      'Public content with attribution: blog posts, marketplace listings, comments, reviews, public portfolio items.',
    params: [
      { name: 'TABLE', description: 'Table name.', required: true },
      { name: 'USER_COL', description: 'UUID column for the row owner.', required: true },
    ],
  },
  {
    id: 'soft-delete-aware',
    file: 'soft-delete-aware.sql',
    label: 'Owner-only with soft delete',
    description:
      'Like user-owns-row, but rows have a timestamptz deleted_at column. Owner sees only undeleted rows. Apps soft-delete by setting deleted_at = now() instead of issuing DELETE; hard deletes are reserved for the service role.',
    when_to_use:
      'Anything you want to be recoverable: user-deleted notes, accidentally-trashed files, anything subject to retention policies.',
    params: [
      { name: 'TABLE', description: 'Table name.', required: true },
      { name: 'USER_COL', description: 'UUID column for the row owner.', required: true },
      { name: 'DELETED_COL', description: 'timestamptz column for soft-delete (typically deleted_at).', required: true },
    ],
  },
  {
    id: 'read-self-write-self',
    file: 'read-self-write-self.sql',
    label: 'Per-user record (profile)',
    description:
      'The table stores one row per user, where the row id equals auth.uid(). User can SELECT and UPDATE their own row. INSERT is wired by trigger on auth.users (not exposed to the client). DELETE is service-role only.',
    when_to_use:
      'Profiles, per-user settings/preferences, billing details — tables with a 1:1 mapping to auth.users.',
    params: [
      { name: 'TABLE', description: 'Table name (typically profiles, settings, accounts).', required: true },
      { name: 'ID_COL', description: 'UUID primary key column matching auth.users.id (typically id or user_id).', required: true },
    ],
  },
  {
    id: 'service-role-only',
    file: 'service-role-only.sql',
    label: 'Service role only (lock down)',
    description:
      'RLS is enabled and no permissive policies are added — anon and authenticated roles see nothing. Only the service_role key (which bypasses RLS by design) can touch this table.',
    when_to_use:
      'Webhook payloads, audit logs, billing records, admin-only tables. WARNING: any client-side query against this table will silently return zero rows.',
    params: [
      { name: 'TABLE', description: 'Table name.', required: true },
    ],
  },
];

function listTemplates() {
  return TEMPLATES.map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    when_to_use: t.when_to_use,
    params: t.params,
  }));
}

function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

// Renders a template to executable SQL. Throws if id is unknown, a
// required param is missing, or any param value isn't a Postgres-safe
// unquoted identifier. The returned SQL is intended to be applied via
// supabase-management.js — it never embeds user-provided values into
// quoted strings, only into identifier positions, and only after the
// IDENT_RE check above. There is no string interpolation path; we
// substitute on the literal `{{NAME}}` token only.
function renderRLSTemplate(id, params) {
  const tmpl = getTemplate(id);
  if (!tmpl) {
    const known = TEMPLATES.map((t) => t.id).join(', ');
    throw new Error(`Unknown RLS template id: ${id}. Known: ${known}`);
  }
  const supplied = { ...(params || {}) };
  for (const p of tmpl.params) {
    const value = supplied[p.name];
    if (p.required && (value === undefined || value === null || value === '')) {
      throw new Error(`Template "${id}" requires param "${p.name}" (${p.description})`);
    }
    if (typeof value !== 'string' || !IDENT_RE.test(value)) {
      throw new Error(
        `Template "${id}" param "${p.name}" must be a Postgres identifier (snake_case, 1–63 chars, [a-z_][a-z0-9_]*); got: ${JSON.stringify(value)}`,
      );
    }
  }
  // Reject any extra keys to catch typos (e.g. {table: ...} instead of {TABLE: ...}).
  const knownKeys = new Set(tmpl.params.map((p) => p.name));
  for (const k of Object.keys(supplied)) {
    if (!knownKeys.has(k)) {
      throw new Error(`Template "${id}" got unknown param "${k}"`);
    }
  }
  let sql = fs.readFileSync(path.join(__dirname, tmpl.file), 'utf8');
  for (const p of tmpl.params) {
    sql = sql.split(`{{${p.name}}}`).join(supplied[p.name]);
  }
  // Belt-and-braces: if any {{...}} placeholders survived, the template
  // file disagrees with the registry entry — refuse to ship half-rendered SQL.
  const leftover = sql.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    throw new Error(`Template "${id}" left unrendered placeholders: ${leftover.join(', ')}. Check the registry params match the SQL file.`);
  }
  return sql;
}

module.exports = { listTemplates, getTemplate, renderRLSTemplate };
