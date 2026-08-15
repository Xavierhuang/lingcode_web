'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

const cloudDataPlane = require('../cloud-data-plane');
const functionRuntime = require('../cloud-functions-runtime');
const { registerCloudAccountMcpRoutes } = require('../cloud-account-mcp');
const { migrateUsersTable, migrateCloudBackendTables, migrateCloudAppsTables, migrateProjectsTables } = require('../migrate');
const { sha256 } = require('../cloud-backend-source');

async function buildHarness() {
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
  migrateProjectsTables(db);

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, email, tier, created_at, api_access_token, email_verified)
    VALUES ('user-1', 'mcp-functions@test.local', 'pro', ?, 'token-1', 1)
  `).run(now);
  db.prepare(`
    INSERT INTO users (id, email, tier, created_at, api_access_token, email_verified)
    VALUES ('user-viewer', 'mcp-viewer@test.local', 'pro', ?, 'token-viewer', 1)
  `).run(now);
  db.prepare(`
    INSERT INTO account_backends
      (id, user_id, project_key, schema_name, status, gateway_url, tier, created_at, updated_at)
    VALUES ('backend-1', 'user-1', 'project-1', 'be_backend_1', 'live',
            'https://lingcode.dev/api/cloud/be/backend-1', 'pro', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO account_backends
      (id, user_id, project_key, schema_name, status, gateway_url, tier, environment, created_at, updated_at)
    VALUES ('backend-2', 'user-1', 'project-2', 'be_backend_2', 'live',
            'https://lingcode.dev/api/cloud/be/backend-2', 'pro', 'development', ?, ?)
  `).run(now, now);
  db.prepare(`INSERT INTO projects (id, owner_id, name, created_at, updated_at)
    VALUES ('shared-project', 'user-1', 'Shared project', ?, ?)`).run(Date.now(), Date.now());
  db.prepare(`INSERT INTO project_members (id, project_id, user_id, role, invited_by, created_at)
    VALUES ('member-owner', 'shared-project', 'user-1', 'owner', 'user-1', ?),
           ('member-viewer', 'shared-project', 'user-viewer', 'viewer', 'user-1', ?)`).run(Date.now(), Date.now());
  db.prepare("UPDATE account_backends SET project_id='shared-project' WHERE id='backend-1'").run();

  const originalIsConfigured = cloudDataPlane.isConfigured;
  cloudDataPlane.isConfigured = () => true;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  registerCloudAccountMcpRoutes(app, db);
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.on('error', reject);
  });

  return {
    db,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => {
      server.close(() => {
        cloudDataPlane.isConfigured = originalIsConfigured;
        db.close();
        resolve();
      });
    }),
  };
}

async function rpc(h, method, params, options = {}) {
  const response = await fetch(`${h.baseUrl}/api/cloud/account/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token || 'token-1'}`,
      'content-type': 'application/json',
      'x-lingcode-project': options.projectKey || 'project-1',
      ...(options.projectId ? { 'x-lingcode-project-id': options.projectId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function callTool(h, name, args = {}, options = {}) {
  const response = await rpc(h, 'tools/call', { name, arguments: args }, options);
  assert.equal(response.result.isError, undefined, response.result.content[0].text);
  return JSON.parse(response.result.content[0].text);
}

test('account MCP advertises custom-function lifecycle tools', async () => {
  const h = await buildHarness();
  try {
    const response = await rpc(h, 'tools/list', {});
    const names = response.result.tools.map((tool) => tool.name);
    assert.ok(names.includes('upsert_function'));
    assert.ok(names.includes('test_function'));
    assert.ok(names.includes('delete_function'));
    assert.ok(names.includes('deploy_backend_manifest'));
    assert.ok(names.includes('backend_source_status'));
    for (const tool of response.result.tools) {
      for (const unsupported of ['oneOf', 'allOf', 'anyOf']) {
        assert.equal(
          Object.hasOwn(tool.inputSchema, unsupported),
          false,
          `${tool.name} input schema cannot advertise top-level ${unsupported}`,
        );
      }
    }
    const deployment = response.result.tools.find((tool) => tool.name === 'deploy_backend_manifest');
    assert.deepEqual(deployment.inputSchema.properties.mode.enum, ['preview', 'apply']);
    assert.equal(deployment.inputSchema.properties.digest.pattern, '^[a-f0-9]{64}$');
    assert.equal(deployment.inputSchema.properties.autoApply.type, 'boolean');
    assert.equal(deployment.inputSchema.properties.planId.type, 'string');
    assert.equal(deployment.inputSchema.properties.confirmation.type, 'object');
  } finally {
    await h.close();
  }
});

test('project-token route stores only a scoped digest and cannot mint recursively', async () => {
  const h = await buildHarness();
  try {
    const response = await fetch(`${h.baseUrl}/api/cloud/account/project-token`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer token-1',
        'content-type': 'application/json',
        'x-lingcode-project': 'project-1',
      },
      body: JSON.stringify({ ttl_days: 2 }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.match(body.token, /^lct_[0-9a-f]{64}$/);
    assert.equal(body.project, 'project-1');
    const legacyTable = h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scoped_tokens'").get();
    assert.equal(legacyTable, undefined);
    const stored = h.db.prepare("SELECT * FROM account_tokens WHERE scope='project'").get();
    assert.ok(stored);
    assert.equal(JSON.stringify(stored).includes(body.token), false);

    const recursive = await fetch(`${h.baseUrl}/api/cloud/account/project-token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${body.token}`,
        'content-type': 'application/json',
        'x-lingcode-project': 'project-1',
      },
      body: '{}',
    });
    assert.equal(recursive.status, 403);
  } finally {
    await h.close();
  }
});

test('production backend preview is read-only and exact confirmation applies once', async () => {
  const h = await buildHarness();
  try {
    const path = 'functions/message-api.ts';
    const source = 'export default () => ({ ok: true })';
    const input = {
      mode: 'preview',
      manifest: {
        version: 1,
        migrations: [],
        functions: [{ slug: 'message-api', path, enabled: true, secrets: [] }],
      },
      files: { [path]: source },
      hashes: { [path]: sha256(source) },
    };
    const preview = await callTool(h, 'deploy_backend_manifest', input);
    assert.equal(preview.mode, 'preview');
    assert.equal(preview.environment, 'production');
    assert.equal(preview.confirmationRequired, true);
    assert.match(preview.planId, /^[0-9a-f-]{36}$/);
    assert.match(preview.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(preview.summary, { migrations: 0, functions: 1, unchanged: 0, deletions: 0 });
    assert.deepEqual(preview.warnings, []);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM backend_functions WHERE backend_id='backend-1'").get().n, 0);

    const apply = {
      mode: 'apply',
      planId: preview.planId,
      digest: preview.digest,
      confirmation: { summary: preview.summary, warnings: preview.warnings },
    };
    const deployment = await callTool(h, 'deploy_backend_manifest', apply);
    assert.equal(deployment.mode, 'apply');
    assert.deepEqual(deployment.applied.map((x) => `${x.kind}:${x.name}`), ['function:message-api']);

    const replay = await rpc(h, 'tools/call', {
      name: 'deploy_backend_manifest',
      arguments: apply,
    });
    assert.equal(replay.result.isError, true);
    assert.match(replay.result.content[0].text, /already used/i);

    h.db.prepare(`INSERT INTO backend_source_artifacts
      (backend_id, kind, name, path, sha256, metadata_json, user_id, deployed_at)
      VALUES ('backend-2', 'function', 'private', 'functions/private.ts', ?, '{}', 'user-1', ?)`)
      .run('a'.repeat(64), new Date().toISOString());
    const status = await callTool(h, 'backend_source_status');
    assert.deepEqual(status.artifacts.map((x) => x.name), ['message-api']);

    const denied = await rpc(h, 'tools/call', {
      name: 'deploy_backend_manifest',
      arguments: { mode: 'preview', manifest: { version: 1, migrations: [], functions: [] }, files: {}, hashes: {} },
    }, { token: 'token-viewer', projectId: 'shared-project' });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /needs editor.*viewer/i);
  } finally {
    await h.close();
  }
});

test('altered production confirmation is rejected without consuming the plan', async () => {
  const h = await buildHarness();
  try {
    const path = 'functions/safe-api.ts';
    const source = 'export default () => ({ ok: true })';
    const preview = await callTool(h, 'deploy_backend_manifest', {
      mode: 'preview',
      manifest: { version: 1, migrations: [], functions: [{ slug: 'safe-api', path }] },
      files: { [path]: source },
      hashes: { [path]: sha256(source) },
    });
    const altered = await rpc(h, 'tools/call', {
      name: 'deploy_backend_manifest',
      arguments: {
        mode: 'apply',
        planId: preview.planId,
        digest: preview.digest,
        confirmation: {
          summary: { ...preview.summary, functions: 0 },
          warnings: preview.warnings,
        },
      },
    });
    assert.equal(altered.result.isError, true);
    assert.match(altered.result.content[0].text, /confirmation/i);

    const applied = await callTool(h, 'deploy_backend_manifest', {
      mode: 'apply',
      planId: preview.planId,
      digest: preview.digest,
      confirmation: { summary: preview.summary, warnings: preview.warnings },
    });
    assert.deepEqual(applied.applied.map((item) => item.name), ['safe-api']);
  } finally {
    await h.close();
  }
});

test('development backend preview auto-applies without creating a confirmation plan', async () => {
  const h = await buildHarness();
  try {
    const path = 'functions/dev-api.ts';
    const source = 'export default () => ({ development: true })';
    const result = await callTool(h, 'deploy_backend_manifest', {
      mode: 'preview',
      autoApply: true,
      manifest: { version: 1, migrations: [], functions: [{ slug: 'dev-api', path }] },
      files: { [path]: source },
      hashes: { [path]: sha256(source) },
    }, { projectKey: 'project-2' });

    assert.equal(result.mode, 'preview');
    assert.equal(result.environment, 'development');
    assert.equal(result.confirmationRequired, false);
    assert.deepEqual(result.deployment.applied.map((item) => item.name), ['dev-api']);
    assert.equal(
      h.db.prepare("SELECT COUNT(*) AS n FROM backend_deployment_plans WHERE backend_id='backend-2'").get().n,
      0,
    );
  } finally {
    await h.close();
  }
});

test('upsert_function creates and updates one function idempotently', async () => {
  const h = await buildHarness();
  try {
    const created = await callTool(h, 'upsert_function', {
      slug: 'message-api',
      source: 'export default () => ({ version: 1 })',
      secrets: [' CHAT_SECRET ', 'CHAT_SECRET', ''],
    });
    assert.equal(created.slug, 'message-api');
    assert.equal(created.created, true);

    const updated = await callTool(h, 'upsert_function', {
      slug: 'message-api',
      source: 'export default () => ({ version: 2 })',
      secrets: ['CHAT_SECRET'],
      enabled: false,
    });
    assert.equal(updated.created, false);

    const rows = h.db.prepare(`
      SELECT slug, source, enabled, secrets FROM backend_functions WHERE backend_id = 'backend-1'
    `).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'export default () => ({ version: 2 })');
    assert.equal(rows[0].enabled, 0);
    assert.deepEqual(JSON.parse(rows[0].secrets), ['CHAT_SECRET']);
  } finally {
    await h.close();
  }
});

test('test_function runs saved source with input and the owner tier timeout', async () => {
  const h = await buildHarness();
  const originalRun = functionRuntime.runUserFunction;
  let received;
  functionRuntime.runUserFunction = async (options) => {
    received = options;
    return { result: { accepted: true }, logs: ['tested'] };
  };
  try {
    await callTool(h, 'upsert_function', {
      slug: 'message-api',
      source: 'export default (input) => ({ text: input.text })',
    });
    const result = await callTool(h, 'test_function', {
      slug: 'message-api',
      input: { text: 'hello' },
    });

    assert.deepEqual(result, { result: { accepted: true }, logs: ['tested'] });
    assert.equal(received.backendId, 'backend-1');
    assert.equal(received.gatewayUrl, 'https://lingcode.dev/api/cloud/be/backend-1');
    assert.equal(received.slug, 'message-api');
    assert.deepEqual(received.input, { text: 'hello' });
    assert.equal(received.timeoutMs, 10000);
  } finally {
    functionRuntime.runUserFunction = originalRun;
    await h.close();
  }
});

test('delete_function removes the function and its schedules', async () => {
  const h = await buildHarness();
  try {
    await callTool(h, 'upsert_function', {
      slug: 'message-api',
      source: 'export default () => ({ ok: true })',
    });
    h.db.prepare(`
      INSERT INTO backend_function_schedules
        (id, backend_id, slug, schedule, enabled, next_run_at, created_at)
      VALUES ('schedule-1', 'backend-1', 'message-api', '* * * * *', 1, 1, 1)
    `).run();

    const result = await callTool(h, 'delete_function', { slug: 'message-api' });
    assert.deepEqual(result, { removed: true, slug: 'message-api', schedulesRemoved: 1 });
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM backend_functions WHERE backend_id = 'backend-1'").get().n, 0);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM backend_function_schedules WHERE backend_id = 'backend-1'").get().n, 0);
  } finally {
    await h.close();
  }
});
