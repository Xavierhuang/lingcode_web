'use strict';

// Compliance-preset unit + control-plane integration.
//
//   node --test website/server/test/cloud-compliance-presets.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { migrateCloudBackendTables } = require('../migrate');
const presets = require('../cloud-compliance-presets');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  migrateCloudBackendTables(db);
  return db;
}

function seedBackend(db, id = 'be_test_1') {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO account_backends (id, user_id, project_key, schema_name, status, created_at, updated_at)
     VALUES (?, 'u_1', 'k1', 's1', 'live', ?, ?)`,
  ).run(id, now, now);
  return id;
}

// --- Preset table (wire contract) ----------------------------------------

test('known presets are exactly the four we advertise', () => {
  assert.deepEqual(
    presets.knownPresets().sort(),
    ['hipaa', 'iso27001', 'none', 'soc2'],
    'add/remove requires a schema migration + docs; do not silently expand',
  );
});

test('every non-none preset locks MFA + email verification', () => {
  for (const name of ['soc2', 'hipaa', 'iso27001']) {
    const p = presets.getPreset(name);
    assert.equal(p.lockedAuth.mfa_required, 1, `${name} must lock mfa_required=1`);
    assert.equal(
      p.lockedAuth.require_email_verification,
      1,
      `${name} must lock require_email_verification=1`,
    );
  }
});

test('HIPAA and ISO27001 require extra acknowledgments beyond SOC 2', () => {
  const soc2Acks = new Set(presets.getPreset('soc2').requiredAcknowledgments);
  const hipaaAcks = new Set(presets.getPreset('hipaa').requiredAcknowledgments);
  const isoAcks = new Set(presets.getPreset('iso27001').requiredAcknowledgments);
  for (const ack of soc2Acks) {
    assert.ok(hipaaAcks.has(ack), `HIPAA must inherit SOC 2 ack ${ack}`);
    assert.ok(isoAcks.has(ack), `ISO 27001 must inherit SOC 2 ack ${ack}`);
  }
  assert.ok(hipaaAcks.has('baa_executed_with_lingcode'), 'HIPAA needs BAA');
  assert.ok(isoAcks.has('risk_register_maintained'), 'ISO 27001 needs risk register');
});

test('normalizePresetName is case-insensitive and rejects unknowns', () => {
  assert.equal(presets.normalizePresetName('SOC2'), 'soc2');
  assert.equal(presets.normalizePresetName(' hipaa '), 'hipaa');
  assert.equal(presets.normalizePresetName('gdpr'), null, 'unknown must not silently become none');
});

// --- applyPreset ---------------------------------------------------------

test('applyPreset flips MFA + email verification for SOC 2 and reports the diff', () => {
  const db = freshDb();
  const backendId = seedBackend(db);

  const result = presets.applyPreset(db, backendId, 'soc2', { userId: 'u_1', nowIso: '2026-08-19T00:00:00Z' });
  assert.equal(result.preset, 'soc2');
  assert.deepEqual(
    result.changes.map((c) => c.key).sort(),
    ['mfa_required', 'require_email_verification'],
  );

  const auth = db
    .prepare('SELECT mfa_required, require_email_verification FROM backend_auth_settings WHERE backend_id = ?')
    .get(backendId);
  assert.equal(auth.mfa_required, 1);
  assert.equal(auth.require_email_verification, 1);

  const stored = db
    .prepare('SELECT compliance_preset FROM account_backends WHERE id = ?')
    .get(backendId).compliance_preset;
  assert.equal(stored, 'soc2');
});

test('applyPreset lists outstanding acknowledgments', () => {
  const db = freshDb();
  const backendId = seedBackend(db);
  const result = presets.applyPreset(db, backendId, 'hipaa', { userId: 'u_1' });
  const outstanding = new Set(result.outstandingAcknowledgments);
  assert.ok(outstanding.has('baa_executed_with_lingcode'), 'HIPAA needs BAA to start outstanding');
  assert.ok(outstanding.has('trust_services_scope_documented'));
});

test('applyPreset rejects an unknown name loudly', () => {
  const db = freshDb();
  const backendId = seedBackend(db);
  assert.throws(() => presets.applyPreset(db, backendId, 'gdpr', { userId: 'u_1' }), /unknown_preset/);
});

test('applying `none` clears the lock — settings can be changed freely again', () => {
  const db = freshDb();
  const backendId = seedBackend(db);
  presets.applyPreset(db, backendId, 'soc2', { userId: 'u_1' });
  presets.applyPreset(db, backendId, 'none', { userId: 'u_1' });
  const stored = db
    .prepare('SELECT compliance_preset FROM account_backends WHERE id = ?')
    .get(backendId).compliance_preset;
  assert.equal(stored, 'none');
});

// --- enforcePreset -------------------------------------------------------

test('enforcePreset is a no-op when no preset is active', () => {
  const db = freshDb();
  const backendId = seedBackend(db);
  const result = presets.enforcePreset(db, backendId, { mfa_required: 0, require_email_verification: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.active, 'none');
});

test('enforcePreset blocks a downgrade when SOC 2 is active', () => {
  const db = freshDb();
  const backendId = seedBackend(db);
  presets.applyPreset(db, backendId, 'soc2', { userId: 'u_1' });
  const result = presets.enforcePreset(db, backendId, {
    mfa_required: 0,
    require_email_verification: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.active, 'soc2');
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].key, 'mfa_required');
});

test('enforcePreset allows a downgrade when unlock_preset matches the active preset', () => {
  const db = freshDb();
  const backendId = seedBackend(db);
  presets.applyPreset(db, backendId, 'hipaa', { userId: 'u_1' });
  const result = presets.enforcePreset(
    db,
    backendId,
    { mfa_required: 0, require_email_verification: 1 },
    { unlockPreset: 'hipaa' },
  );
  assert.equal(result.ok, true);
  assert.equal(result.unlocked, true);
});

test('enforcePreset refuses an unlock scoped to a different preset — no accidental cross-unlock', () => {
  const db = freshDb();
  const backendId = seedBackend(db);
  presets.applyPreset(db, backendId, 'hipaa', { userId: 'u_1' });
  const result = presets.enforcePreset(
    db,
    backendId,
    { mfa_required: 0, require_email_verification: 1 },
    { unlockPreset: 'soc2' },
  );
  assert.equal(result.ok, false, 'unlocking soc2 must not release the hipaa lock');
});

// --- acknowledgments -----------------------------------------------------

test('acknowledgeControl is idempotent — the earlier row wins its timestamp', () => {
  const db = freshDb();
  const backendId = seedBackend(db);
  const first = presets.acknowledgeControl(db, backendId, 'baa_executed_with_lingcode', {
    userId: 'u_1',
    nowIso: '2026-08-19T00:00:00Z',
  });
  presets.acknowledgeControl(db, backendId, 'baa_executed_with_lingcode', {
    userId: 'u_2',
    nowIso: '2026-09-01T00:00:00Z',
  });
  const rows = presets.loadBackendAcknowledgments(db, backendId);
  assert.equal(rows.length, 1, 'no duplicate row');
  assert.equal(rows[0].at, first.at, 'first timestamp must win');
});

test('revokeAcknowledgment removes the row and flips the control back to outstanding', () => {
  const db = freshDb();
  const backendId = seedBackend(db);
  presets.applyPreset(db, backendId, 'hipaa', { userId: 'u_1' });
  presets.acknowledgeControl(db, backendId, 'baa_executed_with_lingcode', { userId: 'u_1' });
  presets.revokeAcknowledgment(db, backendId, 'baa_executed_with_lingcode');
  const evalResult = presets.evaluatePreset(db, backendId);
  const baaControl = evalResult.controls.find((c) => c.id.endsWith('baa_executed_with_lingcode'));
  assert.equal(baaControl.status, 'warn', 'revoked ack must show as outstanding again');
});

// --- evaluatePreset ------------------------------------------------------

test('evaluatePreset reports each locked setting + each acknowledgment as its own control', () => {
  const db = freshDb();
  const backendId = seedBackend(db);
  presets.applyPreset(db, backendId, 'soc2', { userId: 'u_1' });
  const evalResult = presets.evaluatePreset(db, backendId);
  assert.equal(evalResult.active, 'soc2');
  const authControls = evalResult.controls.filter((c) => c.id.includes('mfa_required') || c.id.includes('email_verification'));
  assert.equal(authControls.length, 2);
  const ackControls = evalResult.controls.filter((c) => c.id.includes('ack_'));
  assert.equal(ackControls.length, 2, 'soc2 has two required acks');
  for (const c of ackControls) assert.equal(c.status, 'warn', 'unacknowledged starts as warn');
});

test('evaluatePreset with no active preset warns the operator to choose one', () => {
  const db = freshDb();
  const backendId = seedBackend(db);
  const evalResult = presets.evaluatePreset(db, backendId);
  assert.equal(evalResult.active, 'none');
  assert.equal(evalResult.controls.length, 1);
  assert.equal(evalResult.controls[0].status, 'warn');
});
