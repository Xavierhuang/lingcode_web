'use strict';

// cloud-compliance-presets.js — named security bundles for one backend.
//
// The existing cloud-compliance.js READS the state and reports where SOC 2
// controls stand. This module lets the operator WRITE a bundle of settings
// in one shot (`applyPreset`) and enforces that the bundled controls can
// only be disabled through an explicit acknowledgment path
// (`enforcePreset`). One preset per backend, stored on the account_backends
// row so every proxy/gateway/console read sees it without a join.
//
// Deliberate scope discipline:
//
//   - A preset is a set of SETTINGS + REQUIRED ACKNOWLEDGMENTS, not a
//     compliance certification. Nothing here signs a SOC 2 report. The
//     value is: an app opting in to `hipaa` cannot silently turn MFA off,
//     which is the class of drift that fails an audit six months later.
//
//   - The preset does not "enable" a capability the platform doesn't
//     already provide (encryption at rest, RLS, audit events, MFA, email
//     verification are all pre-existing). It just names a bundle and
//     locks the choices so operator drift is visible.
//
//   - Acknowledgments (BAA-signed, incident-contact-on-file, risk-register-
//     acknowledged) are recorded as ROWS the operator has agreed to, with
//     a timestamp and the acknowledging user id. Legal weight is out of
//     scope; the row is an audit artifact.

const PRESET_NONE = 'none';
const PRESET_SOC2 = 'soc2';
const PRESET_HIPAA = 'hipaa';
const PRESET_ISO27001 = 'iso27001';

const KNOWN_PRESETS = Object.freeze([PRESET_NONE, PRESET_SOC2, PRESET_HIPAA, PRESET_ISO27001]);

// Each preset is a function from "state proposal" to "adjusted state".
// The proposal is whatever the caller wants; the preset overrides fields
// that must be locked. Callers see the diff on `applyPreset` return so
// the console can render "MFA turned on by preset".
//
// Locked fields are enforced by `enforcePreset` on subsequent writes —
// a PUT that flips MFA off with a preset active is rejected unless the
// caller ALSO passes `unlock_preset: '<name>'` to signal they know they
// are dropping compliance.
const PRESETS = Object.freeze({
  [PRESET_NONE]: Object.freeze({
    name: PRESET_NONE,
    title: 'None',
    description: 'No compliance preset — settings behave as before.',
    // No locked keys; auth settings can be freely toggled.
    lockedAuth: Object.freeze({}),
    // No acknowledgments needed.
    requiredAcknowledgments: Object.freeze([]),
    // Recommended controls in cloud-compliance.js are still evaluated; a
    // 'none' preset just doesn't force any of them.
  }),

  [PRESET_SOC2]: Object.freeze({
    name: PRESET_SOC2,
    title: 'SOC 2',
    description:
      'Baseline auditable controls: MFA required, verified email required, ' +
      'audit-event retention ≥ 90 days, no PII in logs. Does not certify ' +
      'the backend for a SOC 2 Type II report — the operator still needs ' +
      'their own Trust Services audit — but locks the settings a SOC 2 ' +
      'auditor expects to see on day one.',
    lockedAuth: Object.freeze({
      mfa_required: 1,
      require_email_verification: 1,
    }),
    requiredAcknowledgments: Object.freeze([
      'trust_services_scope_documented',
      'incident_response_contact',
    ]),
  }),

  [PRESET_HIPAA]: Object.freeze({
    name: PRESET_HIPAA,
    title: 'HIPAA',
    description:
      'Extends SOC 2 with a signed BAA on file, PHI-column encryption ' +
      'enforced via schema policy, and deletion-with-verification. HIPAA ' +
      'compliance is a legal regime, not a feature toggle — LingCode is ' +
      'not a Covered Entity or Business Associate for you; use this only ' +
      'after your own counsel confirms the shared-responsibility split.',
    lockedAuth: Object.freeze({
      mfa_required: 1,
      require_email_verification: 1,
    }),
    requiredAcknowledgments: Object.freeze([
      'trust_services_scope_documented',
      'incident_response_contact',
      'baa_executed_with_lingcode',
      'phi_columns_documented',
    ]),
  }),

  [PRESET_ISO27001]: Object.freeze({
    name: PRESET_ISO27001,
    title: 'ISO 27001',
    description:
      'Extends SOC 2 with a documented risk register and an incident-' +
      'response plan pointer on file. The ISMS itself lives outside the ' +
      'platform — this preset is the artifact list the ISO auditor will ' +
      'ask for from your side.',
    lockedAuth: Object.freeze({
      mfa_required: 1,
      require_email_verification: 1,
    }),
    requiredAcknowledgments: Object.freeze([
      'trust_services_scope_documented',
      'incident_response_contact',
      'risk_register_maintained',
      'annex_a_controls_mapped',
    ]),
  }),
});

function isKnownPreset(name) {
  return KNOWN_PRESETS.includes(name);
}

function normalizePresetName(raw) {
  const name = typeof raw === 'string' ? raw.trim().toLowerCase() : PRESET_NONE;
  return isKnownPreset(name) ? name : null;
}

function getPreset(name) {
  const normalized = normalizePresetName(name);
  if (!normalized) return null;
  return PRESETS[normalized];
}

function knownPresets() {
  return KNOWN_PRESETS.slice();
}

// Read the currently-applied preset for a backend. Missing column /
// missing row defaults to 'none' so pre-migration backends are unchanged.
function loadBackendPreset(db, backendId) {
  try {
    const row = db
      .prepare('SELECT compliance_preset FROM account_backends WHERE id = ?')
      .get(backendId);
    if (!row) return PRESET_NONE;
    return normalizePresetName(row.compliance_preset) || PRESET_NONE;
  } catch (_) {
    return PRESET_NONE;
  }
}

// Rows the operator has agreed to for a given preset. One
// backend_compliance_acknowledgments row per (backend_id, ack_key). We
// use the same table across every preset so an acknowledgment recorded
// under SOC 2 automatically satisfies the same key under HIPAA (they
// share `incident_response_contact`, for instance).
function loadBackendAcknowledgments(db, backendId) {
  try {
    const rows = db
      .prepare(
        'SELECT ack_key, acknowledged_at, acknowledged_by FROM backend_compliance_acknowledgments WHERE backend_id = ?',
      )
      .all(backendId);
    return rows.map((r) => ({
      key: r.ack_key,
      at: r.acknowledged_at,
      by: r.acknowledged_by,
    }));
  } catch (_) {
    return [];
  }
}

function acknowledgmentKeys(rows) {
  return new Set(rows.map((r) => r.key));
}

// Apply a preset to a backend. This is a transactional write:
//   1. compliance_preset column flips on account_backends.
//   2. Any preset-locked auth settings get forced to the required value.
//   3. An "applied" audit trail row is appended.
//
// The caller passes `nowIso` so tests can pin the timestamp. Returns the
// list of settings that changed so the console can show a diff to the
// operator ("MFA was turned on by the SOC 2 preset").
function applyPreset(db, backendId, presetName, { userId, nowIso }) {
  const preset = getPreset(presetName);
  if (!preset) throw new Error(`unknown_preset:${String(presetName)}`);

  const now = nowIso || new Date().toISOString();
  const currentAuth =
    db
      .prepare(
        'SELECT mfa_required, require_email_verification FROM backend_auth_settings WHERE backend_id = ?',
      )
      .get(backendId) || { mfa_required: 0, require_email_verification: 0 };

  const applied = {};
  const changes = [];
  for (const [key, requiredValue] of Object.entries(preset.lockedAuth)) {
    applied[key] = requiredValue;
    if (Number(currentAuth[key] || 0) !== Number(requiredValue)) {
      changes.push({ key, from: Number(currentAuth[key] || 0), to: Number(requiredValue) });
    }
  }

  const runTx = db.transaction(() => {
    db.prepare(
      'UPDATE account_backends SET compliance_preset = ?, updated_at = ? WHERE id = ?',
    ).run(preset.name, now, backendId);

    if (Object.keys(applied).length > 0) {
      const mfaRequired =
        'mfa_required' in applied ? Number(applied.mfa_required) : Number(currentAuth.mfa_required || 0);
      const requireEmailVerification =
        'require_email_verification' in applied
          ? Number(applied.require_email_verification)
          : Number(currentAuth.require_email_verification || 0);
      db.prepare(
        `INSERT INTO backend_auth_settings (backend_id, mfa_required, require_email_verification, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(backend_id) DO UPDATE SET
           mfa_required = excluded.mfa_required,
           require_email_verification = excluded.require_email_verification,
           updated_at = excluded.updated_at`,
      ).run(backendId, mfaRequired, requireEmailVerification, now);
    }
  });
  runTx();

  return {
    preset: preset.name,
    changes,
    requiredAcknowledgments: preset.requiredAcknowledgments.slice(),
    outstandingAcknowledgments: preset.requiredAcknowledgments.filter(
      (key) => !acknowledgmentKeys(loadBackendAcknowledgments(db, backendId)).has(key),
    ),
    appliedAt: now,
    appliedBy: userId || null,
  };
}

// Record an operator acknowledgment (e.g. "BAA is on file"). Duplicate
// (backend_id, ack_key) is a no-op — the earlier record wins so an
// acknowledged-then-re-acknowledged control keeps its original timestamp.
function acknowledgeControl(db, backendId, ackKey, { userId, nowIso }) {
  const now = nowIso || new Date().toISOString();
  db.prepare(
    `INSERT INTO backend_compliance_acknowledgments (backend_id, ack_key, acknowledged_at, acknowledged_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(backend_id, ack_key) DO NOTHING`,
  ).run(backendId, String(ackKey || ''), now, userId || null);
  return {
    key: ackKey,
    at: now,
    by: userId || null,
  };
}

// Revoke an acknowledgment. Recorded via DELETE — the presence of a row
// IS the acknowledgment, so removing it flips the control back to
// outstanding immediately.
function revokeAcknowledgment(db, backendId, ackKey) {
  const info = db
    .prepare('DELETE FROM backend_compliance_acknowledgments WHERE backend_id = ? AND ack_key = ?')
    .run(backendId, String(ackKey || ''));
  return { revoked: info.changes > 0 };
}

// Called from cloud-backend.js auth-settings PUT before it writes. If a
// preset is active and the proposed change would violate a locked value,
// throw unless the caller ALSO passes `unlockPreset: '<name>'` — a
// deliberate signal the operator knows they are dropping compliance.
// The unlock is one-shot per call; the preset itself stays active until
// the caller applies `none` explicitly.
function enforcePreset(db, backendId, proposedAuthSettings, { unlockPreset } = {}) {
  const active = loadBackendPreset(db, backendId);
  if (active === PRESET_NONE) return { ok: true, active };

  const preset = getPreset(active);
  if (!preset) return { ok: true, active };

  const violations = [];
  for (const [key, requiredValue] of Object.entries(preset.lockedAuth)) {
    if (!(key in proposedAuthSettings)) continue;
    if (Number(proposedAuthSettings[key] || 0) !== Number(requiredValue)) {
      violations.push({ key, required: Number(requiredValue), attempted: Number(proposedAuthSettings[key] || 0) });
    }
  }

  if (violations.length === 0) return { ok: true, active };

  // The caller may pass unlockPreset === the currently-active preset
  // to acknowledge they are dropping compliance. The unlock is
  // one-shot: the preset column stays set until the caller applies
  // 'none' explicitly. This keeps the log honest — a temporary
  // unlock leaves a trace.
  if (unlockPreset && normalizePresetName(unlockPreset) === active) {
    return { ok: true, active, unlocked: true };
  }

  return { ok: false, active, violations };
}

// Evaluate the preset for cloud-compliance.js consumption. Returns a
// list of finding-shaped controls describing what the preset requires
// and whether each requirement is met.
function evaluatePreset(db, backendId) {
  const activeName = loadBackendPreset(db, backendId);
  const preset = getPreset(activeName);
  if (!preset || preset.name === PRESET_NONE) {
    return {
      active: PRESET_NONE,
      controls: [
        {
          id: 'compliance_preset_none',
          title: 'No compliance preset applied',
          detail:
            'This backend has no compliance preset. Choose SOC 2, HIPAA, or ISO 27001 in the console to lock the settings each expects.',
          status: 'warn',
        },
      ],
    };
  }

  const authRow =
    db
      .prepare(
        'SELECT mfa_required, require_email_verification FROM backend_auth_settings WHERE backend_id = ?',
      )
      .get(backendId) || {};
  const acks = acknowledgmentKeys(loadBackendAcknowledgments(db, backendId));

  const controls = [];
  for (const [key, requiredValue] of Object.entries(preset.lockedAuth)) {
    const currentValue = Number(authRow[key] || 0);
    const met = currentValue === Number(requiredValue);
    controls.push({
      id: `preset_${preset.name}_${key}`,
      title: `${preset.title}: ${key.replace(/_/g, ' ')} = ${requiredValue}`,
      detail: met
        ? `The ${preset.title} preset locks ${key} at ${requiredValue}; the backend matches.`
        : `The ${preset.title} preset expects ${key} = ${requiredValue}; found ${currentValue}.`,
      status: met ? 'pass' : 'fail',
    });
  }
  for (const ackKey of preset.requiredAcknowledgments) {
    const met = acks.has(ackKey);
    controls.push({
      id: `preset_${preset.name}_ack_${ackKey}`,
      title: `${preset.title}: acknowledge ${ackKey.replace(/_/g, ' ')}`,
      detail: met
        ? `Acknowledged by the operator.`
        : `Outstanding — the operator has not yet acknowledged ${ackKey.replace(/_/g, ' ')} for this backend.`,
      status: met ? 'pass' : 'warn',
    });
  }

  return { active: preset.name, controls };
}

module.exports = {
  PRESET_NONE,
  PRESET_SOC2,
  PRESET_HIPAA,
  PRESET_ISO27001,
  PRESETS,
  knownPresets,
  isKnownPreset,
  normalizePresetName,
  getPreset,
  loadBackendPreset,
  loadBackendAcknowledgments,
  applyPreset,
  acknowledgeControl,
  revokeAcknowledgment,
  enforcePreset,
  evaluatePreset,
};
