'use strict';

// cloud-compliance.js — SOC 2 readiness checks for one managed backend.
//
// Scope discipline matters more here than check count. This reports ONLY
// controls LingCode can actually observe in its own data, because the output is
// meant to be handed to an auditor or pasted into a security questionnaire. A
// checklist that guesses is worse than a short one that doesn't: an unearned
// green tick is a false statement about a control, and the person relying on it
// finds out during fieldwork.
//
// So there is nothing here about policies, security training, vendor management
// or background checks. Those are real SOC 2 requirements and they belong in
// Vanta/Drata — `ownedBy: 'you'` findings say so explicitly rather than
// pretending the gap doesn't exist.
//
// Deliberately NOT folded into cloud-data-plane.advisorsFor(): that function is
// a pg_catalog schema linter whose consumer (website/backends.html:1187) filters
// findings by `category === 'security' | 'performance'`, so a third category
// would silently vanish from that modal. Compliance also reads auth settings,
// secrets and audit health, which aren't schema at all. This module instead
// COMPOSES advisorsFor and reuses its finding shape so one card renderer serves
// both.

const { auditHealth } = require('./cloud-audit');

// Who has to fix it. The shared-responsibility split is the honest part of a
// readiness score: a user cannot fix LingCode's backups, and LingCode cannot
// fix a user's RLS policy.
const LINGCODE = 'lingcode';
const YOU = 'you';

const PASS = 'pass';
const FAIL = 'fail';
const WARN = 'warn';

function control(c) {
  return {
    id: c.id,
    criteria: c.criteria,          // Trust Services Criteria reference, e.g. 'CC6.1'
    category: 'compliance',
    status: c.status,              // pass | fail | warn
    level: c.status === FAIL ? 'error' : c.status === WARN ? 'warn' : 'info',
    ownedBy: c.ownedBy,
    title: c.title,
    detail: c.detail,
    remediation: c.remediation || null,
    evidence: c.evidence || null,  // the observed value the status is derived from
  };
}

/**
 * Auth-configuration controls, read from backend_auth_settings.
 * @param {import('better-sqlite3').Database} db
 */
function authControls(db, backendId) {
  let s = {};
  try {
    s = db.prepare(`SELECT mfa_required, require_email_verification, allowed_redirect_origins, allowed_fetch_hosts
                    FROM backend_auth_settings WHERE backend_id = ?`).get(backendId) || {};
  } catch (_) { s = {}; }

  const out = [];

  out.push(control({
    id: 'mfa_required',
    criteria: 'CC6.1',
    status: Number(s.mfa_required) === 1 ? PASS : WARN,
    ownedBy: YOU,
    title: 'Multi-factor authentication required for app users',
    detail: Number(s.mfa_required) === 1
      ? 'This backend rejects access tokens below aal2, so every signed-in user has completed a second factor.'
      : 'MFA is available (TOTP) but not required, so users can sign in with a password alone. Auditors treat MFA as the baseline control for authenticated access.',
    remediation: Number(s.mfa_required) === 1 ? null : 'Turn on "Require MFA" in the backend\'s Auth settings.',
    evidence: { mfa_required: Number(s.mfa_required) === 1 },
  }));

  out.push(control({
    id: 'email_verification_required',
    criteria: 'CC6.1',
    status: Number(s.require_email_verification) === 1 ? PASS : WARN,
    ownedBy: YOU,
    title: 'Email verification required before sign-in',
    detail: Number(s.require_email_verification) === 1
      ? 'Password signups must confirm their address before the account becomes usable.'
      : 'Unverified addresses can sign in, so an account can be created for an address its owner does not control.',
    remediation: Number(s.require_email_verification) === 1 ? null : 'Enable "Require email verification" in Auth settings.',
    evidence: { require_email_verification: Number(s.require_email_verification) === 1 },
  }));

  // An empty allowlist is the secure default (deny all outbound), so absence is
  // a pass here — the failure mode is a wildcard, not an empty list.
  const hosts = String(s.allowed_fetch_hosts || '').trim();
  const wildcardFetch = hosts === '*' || hosts.split(',').some((h) => h.trim() === '*');
  out.push(control({
    id: 'egress_allowlist',
    criteria: 'CC6.6',
    status: wildcardFetch ? FAIL : PASS,
    ownedBy: YOU,
    title: 'Outbound network egress is restricted',
    detail: wildcardFetch
      ? 'Edge functions may call any host. An attacker with code execution can exfiltrate data to an arbitrary destination.'
      : (hosts ? `Egress is limited to an explicit allowlist (${hosts.split(',').length} host(s)).` : 'No outbound hosts are allowed — the secure default.'),
    remediation: wildcardFetch ? 'Replace the "*" entry with the specific hosts your functions call.' : null,
    evidence: { allowed_fetch_hosts: hosts || null },
  }));

  const origins = String(s.allowed_redirect_origins || '').trim();
  const wildcardRedirect = origins.split(',').some((o) => o.trim() === '*');
  if (origins) {
    out.push(control({
      id: 'oauth_redirect_allowlist',
      criteria: 'CC6.1',
      status: wildcardRedirect ? FAIL : PASS,
      ownedBy: YOU,
      title: 'OAuth redirect targets are explicitly listed',
      detail: wildcardRedirect
        ? 'A wildcard redirect origin lets an attacker redirect the sign-in flow to a host they control and capture the returned token.'
        : 'Sign-in redirects are limited to named origins.',
      remediation: wildcardRedirect ? 'Remove "*" and list each origin your app signs in from.' : null,
      evidence: { allowed_redirect_origins: origins },
    }));
  }

  return out;
}

/**
 * Row-level-security posture, derived from the existing schema advisor rather
 * than re-querying pg_catalog. `advisors` is the array advisorsFor() returned.
 */
function rlsControls(advisors) {
  const list = Array.isArray(advisors) ? advisors : [];
  const rlsOff = list.filter((a) => a.id === 'rls_disabled');
  const inertPolicies = list.filter((a) => a.id === 'policy_exists_rls_disabled');
  const mutablePath = list.filter((a) => a.id === 'function_search_path_mutable');
  const out = [];

  out.push(control({
    id: 'rls_enabled_all_tables',
    criteria: 'CC6.1',
    status: rlsOff.length ? FAIL : PASS,
    ownedBy: YOU,
    title: 'Row-level security enabled on every table',
    detail: rlsOff.length
      ? `${rlsOff.length} table(s) have RLS off: every row is readable and writable by anyone holding the public anon key. This is the single most common way data leaks from an app built on a managed Postgres backend.`
      : 'Every base table has RLS enabled, so access is mediated by policy rather than by possession of the anon key.',
    remediation: rlsOff.length
      ? `Enable RLS and attach a policy on: ${rlsOff.map((a) => a.table).join(', ')}. The RLS templates cover the common ownership patterns.`
      : null,
    evidence: { tables_without_rls: rlsOff.map((a) => a.table) },
  }));

  if (inertPolicies.length) {
    out.push(control({
      id: 'rls_policies_active',
      criteria: 'CC6.1',
      status: FAIL,
      ownedBy: YOU,
      title: 'RLS policies are actually in force',
      detail: `${inertPolicies.length} table(s) have policies written but RLS disabled, so the policies do nothing. This reads as protected in a code review and is not.`,
      remediation: `Run ALTER TABLE … ENABLE ROW LEVEL SECURITY on: ${inertPolicies.map((a) => a.table).join(', ')}.`,
      evidence: { tables_with_inert_policies: inertPolicies.map((a) => a.table) },
    }));
  }

  if (mutablePath.length) {
    out.push(control({
      id: 'function_search_path_pinned',
      criteria: 'CC6.8',
      status: WARN,
      ownedBy: YOU,
      title: 'Database functions pin their search_path',
      detail: `${mutablePath.length} function(s) do not pin search_path, which is a privilege-escalation surface if an attacker can create objects in a schema earlier on the path.`,
      remediation: 'Add SET search_path = \'\' (or a fixed schema) to each function definition.',
      evidence: { functions: mutablePath.map((a) => a.table) },
    }));
  }

  return out;
}

/**
 * Confidentiality + change-management controls read from control-plane tables.
 */
function platformControls(db, backendId) {
  const out = [];

  let secretCount = 0;
  try {
    secretCount = db.prepare('SELECT COUNT(*) AS n FROM backend_secrets WHERE backend_id = ?').get(backendId).n || 0;
  } catch (_) { secretCount = 0; }

  out.push(control({
    id: 'secrets_encrypted_at_rest',
    criteria: 'C1.1',
    status: PASS,
    ownedBy: LINGCODE,
    title: 'Secrets encrypted at rest (AES-256-GCM)',
    detail: secretCount
      ? `${secretCount} secret(s) are stored in the managed vault, encrypted with AES-256-GCM. Values marked as secrets are never returned over HTTP.`
      : 'The managed vault encrypts stored secrets with AES-256-GCM. This backend currently has none stored.',
    evidence: { secrets_in_vault: secretCount },
  }));

  const health = auditHealth(db);
  out.push(control({
    id: 'audit_log_operating',
    criteria: 'CC7.2',
    status: health.ok && !health.stale ? PASS : (health.ok ? WARN : FAIL),
    ownedBy: LINGCODE,
    title: 'Control-plane actions are recorded in an append-only audit log',
    detail: !health.ok
      ? 'The audit log could not be read. Until this is resolved, control-plane activity is not being evidenced.'
      : health.stale
        ? 'The audit log is readable but has recorded nothing in the last 24 hours. On a quiet account that is expected; on an active one it indicates the recorder is failing silently.'
        : `Authentication, credential, access-grant, secret and deployment events are recorded with actor, IP and request id. Retention is ${Math.round(health.retentionMs / 86400000)} days.`,
    evidence: { total_events: health.total, newest_at: health.newestAt, retention_days: Math.round(health.retentionMs / 86400000) },
  }));

  // Change management, from the deployment trail that already exists.
  let deployCount = 0;
  try {
    deployCount = db.prepare(`SELECT COUNT(*) AS n FROM audit_log
                              WHERE action = 'schema.migration' AND resource_id = ?`).get(backendId).n || 0;
  } catch (_) { deployCount = 0; }
  out.push(control({
    id: 'schema_change_trail',
    criteria: 'CC8.1',
    status: PASS,
    ownedBy: LINGCODE,
    title: 'Schema changes are attributable',
    detail: 'Every applied migration records the SQL, the user who ran it, and whether it succeeded. Production applies additionally require a digest-bound, single-use approved plan.',
    evidence: { recorded_migrations: deployCount },
  }));

  return out;
}

/**
 * Controls LingCode has NOT yet met. Listed explicitly rather than omitted,
 * because a readiness report that shows only what passes is marketing. These
 * mirror the public roadmap in docs-src/cloud/security/index.md.
 */
function knownGaps() {
  return [
    control({
      id: 'tenant_database_backups',
      criteria: 'A1.2',
      status: FAIL,
      ownedBy: LINGCODE,
      title: 'Managed Postgres backup and tested restore',
      detail: 'Automated backups with a tested restore are not yet in place for the managed Postgres tier. This is required for the Availability criterion and is on the roadmap.',
      remediation: 'Tracked by LingCode. Export critical data yourself if your own RPO depends on it today.',
      evidence: { status: 'roadmap' },
    }),
    control({
      id: 'per_backend_signing_keys',
      criteria: 'CC6.1',
      status: WARN,
      ownedBy: LINGCODE,
      title: 'Per-backend JWT signing keys',
      detail: 'Tenant JWTs are currently signed with a single platform-wide key rather than a per-backend key. Isolation between backends rests on role and schema separation.',
      remediation: 'Tracked by LingCode.',
      evidence: { status: 'roadmap' },
    }),
    control({
      id: 'independent_penetration_test',
      criteria: 'CC4.1',
      status: WARN,
      ownedBy: LINGCODE,
      title: 'Independent penetration test',
      detail: 'No third-party penetration test has been performed. Most enterprise reviews ask for one alongside a SOC 2 report.',
      remediation: 'Tracked by LingCode.',
      evidence: { status: 'roadmap' },
    }),
  ];
}

/**
 * Controls that are genuinely outside what LingCode can see. Emitted so the
 * report is not mistaken for full SOC 2 coverage — roughly half of a real audit
 * is organisational and lives in a compliance platform, not here.
 */
function outOfScopeNotice() {
  return {
    note: 'LingCode reports only technical controls it can observe. A SOC 2 audit also covers organisational controls it cannot see.',
    notCovered: [
      { criteria: 'CC1.x', item: 'Governance, org chart, background checks' },
      { criteria: 'CC1.4', item: 'Security awareness training' },
      { criteria: 'CC2.x', item: 'Written policies (incident response, BCDR, SDLC, access control)' },
      { criteria: 'CC3.x', item: 'Risk assessment and treatment' },
      { criteria: 'CC6.2', item: 'HR onboarding / offboarding for your own staff' },
      { criteria: 'CC9.2', item: 'Vendor management and subprocessor DPAs' },
    ],
    suggestion: 'Export the evidence bundle and attach it to Vanta, Drata, or your auditor\'s request list to cover the technical half.',
  };
}

/**
 * Full readiness report for one backend.
 *
 * @param {import('better-sqlite3').Database} db  control-plane SQLite
 * @param {string} backendId
 * @param {(id: string) => Promise<Array>} advisorsForFn  injected so this module
 *        stays free of a hard dependency on the data plane (and testable without Postgres)
 */
async function complianceFor(db, backendId, advisorsForFn) {
  let advisors = [];
  if (typeof advisorsForFn === 'function') {
    // A data-plane outage must degrade the report, not fail it: the
    // control-plane checks below are still worth returning.
    try { advisors = await advisorsForFn(backendId); } catch (_) { advisors = null; }
  }

  const controls = [
    ...authControls(db, backendId),
    ...(advisors === null ? [control({
      id: 'schema_scan_unavailable',
      criteria: 'CC6.1',
      status: WARN,
      ownedBy: LINGCODE,
      title: 'Schema checks could not run',
      detail: 'The database could not be reached, so RLS and function checks were skipped. Their status is unknown rather than passing.',
      evidence: { scanned: false },
    })] : rlsControls(advisors)),
    ...platformControls(db, backendId),
    ...knownGaps(),
  ];

  // Scored over controls the user can act on. Including LingCode's own gaps
  // would let a user's score drop for something they cannot fix, and including
  // LingCode's passes would inflate it — neither reflects their readiness.
  const yours = controls.filter((c) => c.ownedBy === YOU);
  const passing = yours.filter((c) => c.status === PASS).length;

  return {
    backendId,
    generatedAt: Date.now(),
    score: { passing, total: yours.length, percent: yours.length ? Math.round((passing / yours.length) * 100) : null },
    summary: {
      fail: controls.filter((c) => c.status === FAIL).length,
      warn: controls.filter((c) => c.status === WARN).length,
      pass: controls.filter((c) => c.status === PASS).length,
    },
    controls,
    scope: outOfScopeNotice(),
  };
}

module.exports = { complianceFor, LINGCODE, YOU, PASS, FAIL, WARN };
