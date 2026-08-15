'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const dataPlane = require('../cloud-data-plane');
const functionRuntime = require('../cloud-functions-runtime');
const { migrateUsersTable, migrateCloudBackendTables, migrateCloudAppsTables } = require('../migrate');
const {
  deployBackendManifest,
  backendSourceStatus,
  buildBackendPreview,
  canonicalDeploymentDigest,
  migrationRiskWarnings,
  runBackendDeployment,
  sha256,
} = require('../cloud-backend-source');

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
  migrateCloudAppsTables(db);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, email, tier, created_at, api_access_token, email_verified)
    VALUES ('user-1', 'backend-source@test.local', 'pro', ?, 'token-1', 1)
  `).run(now);
  for (const id of ['backend-1', 'backend-2']) {
    db.prepare(`
      INSERT INTO account_backends
        (id, user_id, project_key, schema_name, status, gateway_url, tier, created_at, updated_at)
      VALUES (?, 'user-1', ?, ?, 'live', ?, 'pro', ?, ?)
    `).run(id, `project-${id}`, `be_${id.replaceAll('-', '_')}`, `https://lingcode.dev/api/cloud/be/${id}`, now, now);
  }
  return db;
}

function context(db, backendId = 'backend-1') {
  return {
    db,
    backendId,
    gatewayBase: 'https://lingcode.dev/api/cloud/be',
    user: { id: 'user-1', tier: 'pro' },
  };
}

function payload({ migrationSql = 'CREATE TABLE messages(id text primary key);', functionSource = 'export default (input) => ({ text: input.text })', testInput = { text: 'hello' } } = {}) {
  const migrationPath = 'migrations/0001_initial.sql';
  const functionPath = 'functions/message-api.ts';
  return {
    manifest: {
      $schema: 'https://lingcode.dev/schemas/backend-v1.schema.json',
      version: 1,
      migrations: [{ id: '0001_initial', path: migrationPath }],
      functions: [{
        slug: 'message-api',
        path: functionPath,
        enabled: true,
        secrets: ['MESSAGE_SIGNING_KEY'],
        ...(testInput === undefined ? {} : { testInput }),
      }],
    },
    files: {
      [migrationPath]: migrationSql,
      [functionPath]: functionSource,
    },
    hashes: {
      [migrationPath]: sha256(migrationSql),
      [functionPath]: sha256(functionSource),
    },
  };
}

async function withRuntimes(fn) {
  const originalMigration = dataPlane.applyMigration;
  const originalFunction = functionRuntime.runUserFunction;
  const calls = { migrations: [], functions: [] };
  dataPlane.applyMigration = async (backendId, sql) => {
    calls.migrations.push({ backendId, sql });
    return { applied: true };
  };
  functionRuntime.runUserFunction = async (options) => {
    calls.functions.push(options);
    return { result: { ok: true }, logs: [] };
  };
  try {
    return await fn(calls);
  } finally {
    dataPlane.applyMigration = originalMigration;
    functionRuntime.runUserFunction = originalFunction;
  }
}

test('rejects malformed paths, undeclared files, unknown fields, and hash mismatches before deployment', async () => {
  const db = makeDb();
  try {
    await withRuntimes(async (calls) => {
      const cases = [];

      const traversal = payload();
      traversal.manifest.functions[0].path = '../message-api.ts';
      cases.push(traversal);

      const undeclared = payload();
      undeclared.files['functions/extra.ts'] = 'export default () => null';
      undeclared.hashes['functions/extra.ts'] = sha256(undeclared.files['functions/extra.ts']);
      cases.push(undeclared);

      const unknown = payload();
      unknown.manifest.functions[0].secretValues = { MESSAGE_SIGNING_KEY: 'never' };
      cases.push(unknown);

      const wrongHash = payload();
      wrongHash.hashes['migrations/0001_initial.sql'] = '0'.repeat(64);
      cases.push(wrongHash);

      for (const input of cases) {
        await assert.rejects(() => deployBackendManifest(context(db), input));
      }
      assert.equal(calls.migrations.length, 0);
      assert.equal(calls.functions.length, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backend_source_artifacts').get().n, 0);
    });
  } finally {
    db.close();
  }
});

test('preview classifies changes without executing migrations, functions, or deployment-state writes', async () => {
  const db = makeDb();
  try {
    await withRuntimes(async (calls) => {
      const input = payload();
      const preview = buildBackendPreview(context(db), input);

      assert.deepEqual(preview.summary, {
        migrations: 1,
        functions: 1,
        unchanged: 0,
        deletions: 0,
      });
      assert.deepEqual(preview.changes.apply.map((item) => `${item.kind}:${item.name}`), [
        'migration:0001_initial',
        'function:message-api',
      ]);
      assert.deepEqual(preview.changes.unchanged, []);
      assert.equal(preview.digest, canonicalDeploymentDigest(input));
      assert.equal(calls.migrations.length, 0);
      assert.equal(calls.functions.length, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backend_source_artifacts').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backend_functions').get().n, 0);
    });
  } finally {
    db.close();
  }
});

test('preview reports conservative destructive SQL warnings without flagging bounded writes', () => {
  const cases = [
    ['DROP TABLE messages', 'destructive_drop'],
    ['TRUNCATE messages', 'destructive_truncate'],
    ['DELETE FROM messages', 'unbounded_delete'],
    ['UPDATE messages SET body = NULL', 'unbounded_update'],
    ['ALTER TABLE messages DROP COLUMN body', 'destructive_alter'],
    ['GRANT ALL ON messages TO public', 'privilege_change'],
  ];

  for (const [sql, code] of cases) {
    const warnings = migrationRiskWarnings({
      kind: 'migration',
      name: '0002_cleanup',
      path: 'migrations/0002_cleanup.sql',
      content: sql,
    });
    assert.ok(warnings.some((warning) => warning.code === code), `${sql} should warn with ${code}`);
  }

  for (const sql of [
    'DELETE FROM messages WHERE id = $1',
    'UPDATE messages SET body = $1 WHERE id = $2',
  ]) {
    const warnings = migrationRiskWarnings({
      kind: 'migration',
      name: '0002_bounded',
      path: 'migrations/0002_bounded.sql',
      content: sql,
    });
    assert.ok(!warnings.some((warning) => warning.code === 'unbounded_delete' || warning.code === 'unbounded_update'));
  }

  const quoted = migrationRiskWarnings({
    kind: 'migration',
    name: '0002_quoted',
    path: 'migrations/0002_quoted.sql',
    content: "SELECT 'DROP TABLE users'; -- DELETE FROM users\nSELECT 1;",
  });
  assert.deepEqual(quoted, []);
});

test('deploys a manifest once and skips an unchanged retry', async () => {
  const db = makeDb();
  try {
    await withRuntimes(async (calls) => {
      const input = payload();
      const first = await deployBackendManifest(context(db), input);
      assert.deepEqual(first.applied.map((x) => `${x.kind}:${x.name}`), [
        'migration:0001_initial',
        'function:message-api',
      ]);
      assert.deepEqual(first.skipped, []);

      const second = await deployBackendManifest(context(db), input);
      assert.deepEqual(second.applied, []);
      assert.deepEqual(second.skipped.map((x) => `${x.kind}:${x.name}`), [
        'migration:0001_initial',
        'function:message-api',
      ]);

      assert.equal(calls.migrations.length, 1);
      assert.equal(calls.functions.length, 1);
      assert.deepEqual(calls.functions[0].input, { text: 'hello' });
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backend_source_artifacts').get().n, 2);
      const saved = db.prepare("SELECT source, enabled, secrets FROM backend_functions WHERE backend_id='backend-1' AND slug='message-api'").get();
      assert.equal(saved.source, input.files['functions/message-api.ts']);
      assert.equal(saved.enabled, 1);
      assert.deepEqual(JSON.parse(saved.secrets), ['MESSAGE_SIGNING_KEY']);
    });
  } finally {
    db.close();
  }
});

test('rejects a changed migration with an already-applied id', async () => {
  const db = makeDb();
  try {
    await withRuntimes(async (calls) => {
      await deployBackendManifest(context(db), payload());
      const rewritten = payload({ migrationSql: 'CREATE TABLE rewritten(id text primary key);' });
      await assert.rejects(
        () => deployBackendManifest(context(db), rewritten),
        /migration.*0001_initial.*changed/i,
      );
      assert.equal(calls.migrations.length, 1);
      const state = db.prepare("SELECT sha256 FROM backend_source_artifacts WHERE backend_id='backend-1' AND kind='migration' AND name='0001_initial'").get();
      assert.equal(state.sha256, payload().hashes['migrations/0001_initial.sql']);
    });
  } finally {
    db.close();
  }
});

test('draft test failure leaves the previous saved function and hash unchanged', async () => {
  const db = makeDb();
  try {
    await withRuntimes(async () => {
      const original = payload({ testInput: undefined });
      await deployBackendManifest(context(db), original);

      const previousRunner = functionRuntime.runUserFunction;
      functionRuntime.runUserFunction = async () => ({ ok: false, error: 'draft rejected', logs: [] });
      try {
        const changed = payload({ functionSource: 'export default () => ({ version: 2 })' });
        const result = await deployBackendManifest(context(db), changed);
        assert.deepEqual(result.failed, {
          kind: 'function',
          name: 'message-api',
          path: 'functions/message-api.ts',
          error: 'draft rejected',
        });
      } finally {
        functionRuntime.runUserFunction = previousRunner;
      }

      const saved = db.prepare("SELECT source FROM backend_functions WHERE backend_id='backend-1' AND slug='message-api'").get();
      const state = db.prepare("SELECT sha256 FROM backend_source_artifacts WHERE backend_id='backend-1' AND kind='function' AND name='message-api'").get();
      assert.equal(saved.source, original.files['functions/message-api.ts']);
      assert.equal(state.sha256, original.hashes['functions/message-api.ts']);
    });
  } finally {
    db.close();
  }
});

test('reports the first failed migration with completed progress and remains retry-safe', async () => {
  const db = makeDb();
  try {
    await withRuntimes(async () => {
      const previousMigration = dataPlane.applyMigration;
      dataPlane.applyMigration = async () => { throw new Error('postgres rejected migration'); };
      try {
        const result = await deployBackendManifest(context(db), payload());
        assert.deepEqual(result.applied, []);
        assert.deepEqual(result.skipped, []);
        assert.deepEqual(result.failed, {
          kind: 'migration',
          name: '0001_initial',
          path: 'migrations/0001_initial.sql',
          error: 'postgres rejected migration',
        });
      } finally {
        dataPlane.applyMigration = previousMigration;
      }
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backend_source_artifacts').get().n, 0);
      assert.equal(db.prepare("SELECT status FROM schema_migrations ORDER BY id DESC LIMIT 1").get().status, 'failed');
    });
  } finally {
    db.close();
  }
});

test('fresh production preview safely resumes after a partially completed apply', async () => {
  const db = makeDb();
  try {
    await withRuntimes(async (calls) => {
      const ctx = { ...context(db), environment: 'production' };
      const input = payload();
      const firstPreview = await runBackendDeployment(ctx, { mode: 'preview', ...input });

      const successfulRunner = functionRuntime.runUserFunction;
      let attempts = 0;
      functionRuntime.runUserFunction = async (options) => {
        attempts += 1;
        if (attempts === 1) return { ok: false, error: 'draft rejected once', logs: [] };
        return successfulRunner(options);
      };
      try {
        const firstApply = await runBackendDeployment(ctx, {
          mode: 'apply',
          planId: firstPreview.planId,
          digest: firstPreview.digest,
          confirmation: { summary: firstPreview.summary, warnings: firstPreview.warnings },
        });
        assert.equal(firstApply.failed.name, 'message-api');
        assert.deepEqual(firstApply.applied.map((item) => item.name), ['0001_initial']);

        const retryPreview = await runBackendDeployment(ctx, { mode: 'preview', ...input });
        assert.deepEqual(retryPreview.summary, {
          migrations: 0,
          functions: 1,
          unchanged: 1,
          deletions: 0,
        });
        const retryApply = await runBackendDeployment(ctx, {
          mode: 'apply',
          planId: retryPreview.planId,
          digest: retryPreview.digest,
          confirmation: { summary: retryPreview.summary, warnings: retryPreview.warnings },
        });
        assert.deepEqual(retryApply.applied.map((item) => item.name), ['message-api']);
        assert.equal(calls.migrations.length, 1);
      } finally {
        functionRuntime.runUserFunction = successfulRunner;
      }
    });
  } finally {
    db.close();
  }
});

test('updates changed functions, preserves omitted functions, and scopes status by backend', async () => {
  const db = makeDb();
  try {
    await withRuntimes(async () => {
      await deployBackendManifest(context(db), payload());
      const changed = payload({ functionSource: 'export default () => ({ version: 2 })' });
      const result = await deployBackendManifest(context(db), changed);
      assert.deepEqual(result.applied.map((x) => `${x.kind}:${x.name}`), ['function:message-api']);

      const migrationOnly = payload();
      migrationOnly.manifest.functions = [];
      delete migrationOnly.files['functions/message-api.ts'];
      delete migrationOnly.hashes['functions/message-api.ts'];
      await deployBackendManifest(context(db), migrationOnly);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM backend_functions WHERE backend_id='backend-1' AND slug='message-api'").get().n, 1);

      db.prepare(`INSERT INTO backend_source_artifacts
        (backend_id, kind, name, path, sha256, metadata_json, user_id, deployed_at)
        VALUES ('backend-2', 'function', 'other', 'functions/other.ts', ?, '{}', 'user-1', ?)`)
        .run('a'.repeat(64), new Date().toISOString());

      const status = backendSourceStatus(context(db));
      assert.equal(status.artifacts.length, 2);
      assert.deepEqual(status.artifacts.map((x) => x.name).sort(), ['0001_initial', 'message-api']);
      assert.ok(status.artifacts.every((x) => x.backendId === undefined));
    });
  } finally {
    db.close();
  }
});
