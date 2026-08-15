'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrateUsersTable, migrateCloudBackendTables } = require('../migrate');
const { buildBackendPreview, sha256 } = require('../cloud-backend-source');
const {
  createDeploymentPlan,
  consumeDeploymentPlan,
  confirmationEnvelope,
} = require('../cloud-backend-deployment-plans');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL DEFAULT 'free',
      created_at TEXT NOT NULL,
      source TEXT DEFAULT ''
    )
  `);
  migrateUsersTable(db);
  migrateCloudBackendTables(db);
  return db;
}

function seed(db) {
  const now = new Date().toISOString();
  for (const [id, email, token] of [
    ['user-1', 'plans-1@test.local', 'token-1'],
    ['user-2', 'plans-2@test.local', 'token-2'],
  ]) {
    db.prepare(`
      INSERT INTO users (id, email, tier, created_at, api_access_token, email_verified)
      VALUES (?, ?, 'pro', ?, ?, 1)
    `).run(id, email, now, token);
  }
  for (const [id, userId, environment] of [
    ['backend-1', 'user-1', 'production'],
    ['backend-2', 'user-2', 'production'],
  ]) {
    db.prepare(`
      INSERT INTO account_backends
        (id, user_id, project_key, schema_name, status, tier, environment, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'live', 'pro', ?, ?, ?)
    `).run(id, userId, `project-${id}`, `be_${id.replaceAll('-', '_')}`, environment, now, now);
  }
}

function context(db, userId = 'user-1', backendId = 'backend-1') {
  return {
    db,
    backendId,
    environment: 'production',
    user: { id: userId, tier: 'pro' },
  };
}

function payload() {
  const path = 'functions/message-api.ts';
  const source = 'export default () => ({ ok: true })';
  return {
    manifest: {
      version: 1,
      migrations: [],
      functions: [{ slug: 'message-api', path, enabled: true, secrets: [] }],
    },
    files: { [path]: source },
    hashes: { [path]: sha256(source) },
  };
}

function applyArgs(created, preview) {
  return {
    planId: created.planId,
    digest: preview.digest,
    confirmation: confirmationEnvelope(preview),
  };
}

test('cloud backend migration adds explicit environments and deployment plan storage', () => {
  const db = makeDb();
  try {
    const columns = db.prepare('PRAGMA table_info(account_backends)').all();
    assert.equal(columns.find((column) => column.name === 'environment').dflt_value, "'production'");

    const planTable = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'backend_deployment_plans'
    `).get();
    assert.ok(planTable);
    assert.match(planTable.sql, /status\s+TEXT NOT NULL CHECK\s*\(status IN \('pending','consumed'\)\)/);
    assert.match(planTable.sql, /FOREIGN KEY\s*\(backend_id\) REFERENCES account_backends\s*\(id\) ON DELETE CASCADE/);

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (id, email, tier, created_at, api_access_token, email_verified)
      VALUES ('user-1', 'plans@test.local', 'pro', ?, 'token-1', 1)
    `).run(now);
    db.prepare(`
      INSERT INTO account_backends
        (id, user_id, project_key, schema_name, status, tier, created_at, updated_at)
      VALUES ('backend-1', 'user-1', 'project-1', 'be_backend_1', 'live', 'pro', ?, ?)
    `).run(now, now);
    assert.equal(
      db.prepare("SELECT environment FROM account_backends WHERE id='backend-1'").get().environment,
      'production',
    );

    migrateCloudBackendTables(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_backends').get().n, 1);
  } finally {
    db.close();
  }
});

test('production plans expire after ten minutes and bind user, backend, digest, and confirmation', () => {
  const db = makeDb();
  try {
    seed(db);
    const input = payload();
    const preview = buildBackendPreview(context(db), input);
    const created = createDeploymentPlan(context(db), input, preview, 1_000);
    assert.equal(created.expiresAt, 601_000);

    assert.throws(
      () => consumeDeploymentPlan(context(db, 'user-2', 'backend-1'), applyArgs(created, preview), 2_000),
      /different user/i,
    );
    assert.throws(
      () => consumeDeploymentPlan(context(db, 'user-1', 'backend-2'), applyArgs(created, preview), 2_000),
      /different backend/i,
    );
    assert.throws(
      () => consumeDeploymentPlan(context(db), { ...applyArgs(created, preview), digest: '0'.repeat(64) }, 2_000),
      /digest/i,
    );

    const altered = applyArgs(created, preview);
    altered.confirmation = { ...altered.confirmation, summary: { ...altered.confirmation.summary, functions: 99 } };
    assert.throws(() => consumeDeploymentPlan(context(db), altered, 2_000), /confirmation/i);
    assert.throws(() => consumeDeploymentPlan(context(db), applyArgs(created, preview), 601_001), /expired/i);
    assert.equal(
      db.prepare('SELECT status FROM backend_deployment_plans WHERE id=?').get(created.planId).status,
      'pending',
    );
  } finally {
    db.close();
  }
});

test('production plans are single-use and return only normalized deployment payload', () => {
  const db = makeDb();
  try {
    seed(db);
    const input = payload();
    const preview = buildBackendPreview(context(db), input);
    const created = createDeploymentPlan(context(db), input, preview, 10_000);
    const stored = consumeDeploymentPlan(context(db), applyArgs(created, preview), 11_000);

    assert.deepEqual(stored, input);
    assert.equal(
      db.prepare('SELECT status FROM backend_deployment_plans WHERE id=?').get(created.planId).status,
      'consumed',
    );
    assert.throws(() => consumeDeploymentPlan(context(db), applyArgs(created, preview), 12_000), /already used/i);
  } finally {
    db.close();
  }
});
