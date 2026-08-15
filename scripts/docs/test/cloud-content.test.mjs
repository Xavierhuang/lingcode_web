import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const buildScript = path.join(repoRoot, 'website/scripts/docs/build.mjs');
const outputRoot = path.join(repoRoot, 'website/docs/cloud');

function build() {
  const result = spawnSync(process.execPath, [buildScript], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('Cloud overview separates available products from reactive preview APIs', async () => {
  build();
  const html = await readFile(path.join(outputRoot, 'index.html'), 'utf8');
  for (const phrase of ['managed PostgreSQL', 'Authentication', 'Storage', 'Realtime', 'Functions', 'Vector search']) {
    assert.match(html, new RegExp(phrase, 'i'));
  }
  assert.match(html, /href="\/docs\/cloud\/functions\/queries\.html"/);
  assert.match(html, /Preview APIs/);
  assert.match(html, /window\.lingcode/);
  assert.match(html, /anon key is public/i);
});

test('core concepts explains the security and deployment boundaries', async () => {
  build();
  const html = await readFile(path.join(outputRoot, 'concepts/index.html'), 'utf8');
  for (const phrase of ['data gateway', 'tenant schema', 'row-level security', 'control plane', 'data plane', 'backend-as-code']) {
    assert.match(html, new RegExp(phrase, 'i'));
  }
  assert.match(html, /be_&lt;backend-id&gt;/);
  assert.match(html, /trole_&lt;backend-id&gt;/);
  assert.match(html, /Available/);
  assert.doesNotMatch(html, /not generally available yet/);
});

test('function documentation distinguishes shipped custom functions from preview semantics', async () => {
  build();
  const custom = await readFile(path.join(outputRoot, 'functions/custom-functions.html'), 'utf8');
  for (const phrase of ['export default', 'handler(input, ctx)', 'Deno', 'ctx.secrets', '256 KB', 'separate database transaction']) {
    assert.ok(custom.toLowerCase().includes(phrase.toLowerCase()), `missing '${phrase}'`);
  }
  assert.match(custom, /Available/);
  assert.doesNotMatch(custom, /not generally available yet/);

  const expectations = new Map([
    ['queries.html', ['read-only transaction', 'deterministic', 'dependency']],
    ['mutations.html', ['SERIALIZABLE', 'atomic', 'idempotency']],
    ['actions.html', ['side effects', 'not automatically retried', 'external']],
    ['validation.html', ['runtime validation', 'arguments', 'return value']],
    ['errors.html', ['application errors', 'developer errors', 'production']],
  ]);
  for (const [file, phrases] of expectations) {
    const html = await readFile(path.join(outputRoot, 'functions', file), 'utf8');
    assert.match(html, /Preview/);
    assert.match(html, /not generally available yet/);
    for (const phrase of phrases) assert.ok(html.toLowerCase().includes(phrase.toLowerCase()), `${file} missing '${phrase}'`);
  }
});

test('deployment and production references document current safety contracts', async () => {
  build();
  const expectations = new Map([
    ['deployments/index.html', ['development', 'production', 'backend-as-code']],
    ['deployments/backend-as-code.html', ['lingcode/backend.json', 'SHA-256', 'immutable migration', 'backend_source_status']],
    ['deployments/production-approval.html', ['10 minutes', 'planId', 'digest', 'consumed', 'no watch deploy']],
    ['production/index.html', ['security', 'reliability', 'observability', 'backup']],
    ['production/reliability.html', ['timeout', 'pool', 'reconnect', 'restore']],
    ['production/observability.html', ['logs', 'metrics', 'request ID', 'cardinality']],
    ['limits.html', ['unlimited saved function definitions', 'HTTP 402', 'quota_exceeded', 'pagination']],
    ['reference/javascript-sdk.html', ['createClient', 'from(table)', 'functions.invoke', 'Result&lt;T&gt;']],
    ['reference/rest-api.html', ['Authorization', '{ ok: true, data }', 'HTTP status']],
    ['reference/cli-mcp.html', ['provision_backend', 'deploy_backend_manifest', 'backend_source_status', 'apply_migration']],
  ]);
  for (const [relative, phrases] of expectations) {
    const html = await readFile(path.join(outputRoot, relative), 'utf8');
    assert.match(html, /Available/);
    for (const phrase of phrases) assert.ok(html.toLowerCase().includes(phrase.toLowerCase()), `${relative} missing '${phrase}'`);
  }
});

test('security assurance page states verified controls and honest boundaries', async () => {
  build();
  const html = await readFile(path.join(outputRoot, 'security/index.html'), 'utf8');
  for (const phrase of [
    'hashed token lookup',
    'password throttling',
    'no forced reconnect',
    'project-scoped token',
    'shared responsibility',
    'security roadmap',
  ]) {
    assert.ok(html.toLowerCase().includes(phrase.toLowerCase()), `security page missing '${phrase}'`);
  }
  assert.doesNotMatch(html, /completely secure|100% secure|unhackable/i);
});
