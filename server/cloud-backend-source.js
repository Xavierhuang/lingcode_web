'use strict';

const crypto = require('crypto');
const dataPlane = require('./cloud-data-plane');
const functionRuntime = require('./cloud-functions-runtime');
const { limitsForTier } = require('./cloud-limits');
const { recordSchemaMigration } = require('./cloud-audit');
const {
  createDeploymentPlan,
  consumeDeploymentPlan,
} = require('./cloud-backend-deployment-plans');

const OWN = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const MIGRATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const FUNCTION_SLUG_RE = /^[a-z][a-z0-9-]{0,40}$/;
const SECRET_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function sha256(content) {
  return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
}

function stableJSONStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSONStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJSONStringify(value[key])}`).join(',')}}`;
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  plainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} contains unknown field '${key}'`);
  }
}

function artifactPath(raw, kind) {
  const value = String(raw || '');
  const prefix = kind === 'migration' ? 'migrations/' : 'functions/';
  const suffix = kind === 'migration' ? '.sql' : '.ts';
  if (!value.startsWith(prefix) || !value.endsWith(suffix) || value.startsWith('/') || value.includes('\\')) {
    fail(`${kind} path must be a relative ${prefix}*${suffix} path`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    fail(`${kind} path contains an invalid segment`);
  }
  return value;
}

function normalizedSecrets(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 32) fail('function secrets must be an array of at most 32 names');
  const out = [];
  for (const item of raw) {
    const name = String(item || '');
    if (!SECRET_RE.test(name)) fail(`invalid secret name '${name}'`);
    if (out.includes(name)) fail(`duplicate secret name '${name}'`);
    out.push(name);
  }
  return out;
}

function normalizePayload(args) {
  exactKeys(args, ['manifest', 'files', 'hashes'], 'deployment');
  const manifest = plainObject(args.manifest, 'manifest');
  const files = plainObject(args.files, 'files');
  const hashes = plainObject(args.hashes, 'hashes');
  exactKeys(manifest, ['$schema', 'version', 'migrations', 'functions'], 'manifest');
  if (manifest.version !== 1) fail('manifest version must be 1');
  if (OWN(manifest, '$schema') && typeof manifest.$schema !== 'string') fail('manifest $schema must be a string');

  const migrationsRaw = manifest.migrations === undefined ? [] : manifest.migrations;
  const functionsRaw = manifest.functions === undefined ? [] : manifest.functions;
  if (!Array.isArray(migrationsRaw)) fail('manifest migrations must be an array');
  if (!Array.isArray(functionsRaw)) fail('manifest functions must be an array');

  const names = new Set();
  const paths = new Set();
  const migrations = migrationsRaw.map((entry, index) => {
    exactKeys(entry, ['id', 'path'], `migration[${index}]`);
    const id = String(entry.id || '');
    if (!MIGRATION_ID_RE.test(id)) fail(`invalid migration id '${id}'`);
    if (names.has(`migration:${id}`)) fail(`duplicate migration id '${id}'`);
    names.add(`migration:${id}`);
    const path = artifactPath(entry.path, 'migration');
    if (paths.has(path)) fail(`duplicate artifact path '${path}'`);
    paths.add(path);
    return { kind: 'migration', name: id, path };
  });

  const functions = functionsRaw.map((entry, index) => {
    exactKeys(entry, ['slug', 'path', 'enabled', 'secrets', 'testInput'], `function[${index}]`);
    const slug = String(entry.slug || '');
    if (!FUNCTION_SLUG_RE.test(slug)) fail(`invalid function slug '${slug}'`);
    if (names.has(`function:${slug}`)) fail(`duplicate function slug '${slug}'`);
    names.add(`function:${slug}`);
    const path = artifactPath(entry.path, 'function');
    if (paths.has(path)) fail(`duplicate artifact path '${path}'`);
    paths.add(path);
    if (OWN(entry, 'enabled') && typeof entry.enabled !== 'boolean') fail(`function '${slug}' enabled must be boolean`);
    return {
      kind: 'function',
      name: slug,
      path,
      enabled: entry.enabled !== false,
      secrets: normalizedSecrets(entry.secrets),
      hasTestInput: OWN(entry, 'testInput'),
      testInput: entry.testInput,
    };
  });

  const declared = new Set([...migrations, ...functions].map((entry) => entry.path));
  for (const key of Object.keys(files)) if (!declared.has(key)) fail(`undeclared file '${key}'`);
  for (const key of Object.keys(hashes)) if (!declared.has(key)) fail(`undeclared hash '${key}'`);

  for (const artifact of [...migrations, ...functions]) {
    if (!OWN(files, artifact.path) || typeof files[artifact.path] !== 'string') fail(`missing file '${artifact.path}'`);
    if (!OWN(hashes, artifact.path) || !HASH_RE.test(String(hashes[artifact.path]))) fail(`invalid hash for '${artifact.path}'`);
    const content = files[artifact.path];
    const actualHash = sha256(content);
    if (actualHash !== hashes[artifact.path]) fail(`hash mismatch for '${artifact.path}'`);
    if (artifact.kind === 'function' && Buffer.byteLength(content, 'utf8') > functionRuntime.MAX_SOURCE_BYTES) {
      fail(`function '${artifact.name}' exceeds ${functionRuntime.MAX_SOURCE_BYTES} bytes`, 413);
    }
    artifact.content = content;
    artifact.sha256 = actualHash;
  }

  return { migrations, functions };
}

function stateRow(db, backendId, kind, name) {
  return db.prepare(`SELECT path, sha256, metadata_json, user_id, deployed_at
    FROM backend_source_artifacts WHERE backend_id=? AND kind=? AND name=?`).get(backendId, kind, name);
}

function artifactResult(artifact) {
  return { kind: artifact.kind, name: artifact.name, path: artifact.path, sha256: artifact.sha256 };
}

function failedArtifact(artifact, error) {
  return {
    kind: artifact.kind,
    name: artifact.name,
    path: artifact.path,
    error: String(error && error.message || error || 'deployment failed'),
  };
}

function saveState(ctx, artifact, metadata) {
  const now = new Date().toISOString();
  ctx.db.prepare(`INSERT INTO backend_source_artifacts
    (backend_id, kind, name, path, sha256, metadata_json, user_id, deployed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(backend_id, kind, name) DO UPDATE SET
      path=excluded.path, sha256=excluded.sha256, metadata_json=excluded.metadata_json,
      user_id=excluded.user_id, deployed_at=excluded.deployed_at`)
    .run(ctx.backendId, artifact.kind, artifact.name, artifact.path, artifact.sha256,
      JSON.stringify(metadata || {}), ctx.user && ctx.user.id || null, now);
}

function sameFunctionState(row, artifact) {
  if (!row || row.sha256 !== artifact.sha256 || row.path !== artifact.path) return false;
  let metadata = {};
  try { metadata = JSON.parse(row.metadata_json || '{}'); } catch (_) { return false; }
  return metadata.enabled === artifact.enabled
    && JSON.stringify(metadata.secrets || []) === JSON.stringify(artifact.secrets);
}

function canonicalArtifact(artifact) {
  const base = {
    kind: artifact.kind,
    name: artifact.name,
    path: artifact.path,
    sha256: artifact.sha256,
  };
  if (artifact.kind === 'function') {
    base.enabled = artifact.enabled;
    base.secrets = [...artifact.secrets].sort();
    base.hasTestInput = artifact.hasTestInput;
    base.testInputSha256 = artifact.hasTestInput ? sha256(stableJSONStringify(artifact.testInput)) : null;
  }
  return base;
}

function normalizedDeploymentDigest(normalized) {
  return sha256(stableJSONStringify({
    version: 1,
    migrations: normalized.migrations.map(canonicalArtifact),
    functions: normalized.functions.map(canonicalArtifact),
  }));
}

function canonicalDeploymentDigest(payload) {
  return normalizedDeploymentDigest(normalizePayload(payload));
}

function sqlForRiskScan(sql) {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}

function migrationRiskWarnings(migration) {
  const warnings = [];
  const seen = new Set();
  const artifact = String(migration && migration.name || 'migration');
  const path = String(migration && migration.path || '');
  const add = (code, message) => {
    const key = `${code}:${artifact}`;
    if (seen.has(key)) return;
    seen.add(key);
    warnings.push({ code, artifact, path, message });
  };

  for (const rawStatement of sqlForRiskScan(migration && migration.content).split(';')) {
    const statement = rawStatement.trim();
    if (!statement) continue;
    if (/\bdrop\s+(table|schema|database|view|function|index|type|extension)\b/i.test(statement)) {
      add('destructive_drop', `Destructive DROP in migration '${artifact}'.`);
    }
    if (/\btruncate(?:\s+table)?\b/i.test(statement)) {
      add('destructive_truncate', `TRUNCATE removes all rows in migration '${artifact}'.`);
    }
    if (/\bdelete\s+from\b/i.test(statement) && !/\bwhere\b/i.test(statement)) {
      add('unbounded_delete', `DELETE without WHERE in migration '${artifact}'.`);
    }
    if (/\bupdate\s+[\s\S]+?\s+set\b/i.test(statement) && !/\bwhere\b/i.test(statement)) {
      add('unbounded_update', `UPDATE without WHERE in migration '${artifact}'.`);
    }
    if (/\balter\s+table\b[\s\S]*\b(drop\s+(column|constraint)|alter\s+column[\s\S]*(type|set\s+not\s+null))\b/i.test(statement)) {
      add('destructive_alter', `Potentially destructive ALTER TABLE in migration '${artifact}'.`);
    }
    if (/\b(grant|revoke)\b|\balter\s+(role|user)\b|\balter\s+[\s\S]*\bowner\s+to\b|\b(create|alter|drop)\s+policy\b/i.test(statement)) {
      add('privilege_change', `Privilege, ownership, role, or policy change in migration '${artifact}'.`);
    }
  }
  return warnings;
}

function buildBackendPreview(ctx, args) {
  if (!ctx || !ctx.db || !ctx.backendId) fail('backend deployment context missing', 500);
  const normalized = normalizePayload(args);
  const apply = [];
  const unchanged = [];

  for (const migration of normalized.migrations) {
    const existing = stateRow(ctx.db, ctx.backendId, 'migration', migration.name);
    if (existing && existing.sha256 !== migration.sha256) {
      fail(`migration '${migration.name}' changed after it was applied; create a new migration id`, 409);
    }
    (existing ? unchanged : apply).push(artifactResult(migration));
  }

  for (const fn of normalized.functions) {
    const existing = stateRow(ctx.db, ctx.backendId, 'function', fn.name);
    (sameFunctionState(existing, fn) ? unchanged : apply).push(artifactResult(fn));
  }

  const warnings = normalized.migrations
    .filter((migration) => apply.some((item) => item.kind === 'migration' && item.name === migration.name))
    .flatMap(migrationRiskWarnings);
  return {
    normalized,
    digest: normalizedDeploymentDigest(normalized),
    summary: {
      migrations: apply.filter((item) => item.kind === 'migration').length,
      functions: apply.filter((item) => item.kind === 'function').length,
      unchanged: unchanged.length,
      deletions: 0,
    },
    changes: { apply, unchanged },
    warnings,
  };
}

function manifestPayload(args) {
  return { manifest: args.manifest, files: args.files, hashes: args.hashes };
}

function publicPreview(ctx, preview) {
  return {
    environment: ctx.environment,
    digest: preview.digest,
    summary: preview.summary,
    changes: preview.changes,
    warnings: preview.warnings,
  };
}

async function runBackendDeployment(ctx, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('deployment must be an object');
  const mode = args.mode === undefined ? 'preview' : String(args.mode);
  if (mode !== 'preview' && mode !== 'apply') fail("deployment mode must be 'preview' or 'apply'");

  if (mode === 'apply') {
    exactKeys(args, ['mode', 'planId', 'digest', 'confirmation'], 'deployment apply');
    const storedPayload = consumeDeploymentPlan(ctx, args);
    return { mode: 'apply', ...(await deployBackendManifest(ctx, storedPayload)) };
  }

  exactKeys(args, ['mode', 'autoApply', 'manifest', 'files', 'hashes'], 'deployment preview');
  if (args.autoApply !== undefined && typeof args.autoApply !== 'boolean') fail('autoApply must be a boolean');
  const payload = manifestPayload(args);
  const preview = buildBackendPreview(ctx, payload);
  const visible = publicPreview(ctx, preview);

  if (ctx.environment === 'development') {
    if (args.autoApply === false) {
      return { mode: 'preview', ...visible, confirmationRequired: false };
    }
    return {
      mode: 'preview',
      ...visible,
      confirmationRequired: false,
      deployment: await deployBackendManifest(ctx, payload),
    };
  }
  if (ctx.environment !== 'production') fail('backend environment is invalid', 500);
  const plan = createDeploymentPlan(ctx, payload, preview);
  return { mode: 'preview', ...visible, confirmationRequired: true, ...plan };
}

async function deployBackendManifest(ctx, args) {
  if (!ctx || !ctx.db || !ctx.backendId) fail('backend deployment context missing', 500);
  const normalized = normalizePayload(args);
  const applied = [];
  const skipped = [];

  // Migration history is immutable. Check every ID before applying the first
  // statement so a rewritten old migration cannot produce a partial deploy.
  for (const migration of normalized.migrations) {
    const existing = stateRow(ctx.db, ctx.backendId, 'migration', migration.name);
    if (existing && existing.sha256 !== migration.sha256) {
      fail(`migration '${migration.name}' changed after it was applied; create a new migration id`, 409);
    }
  }

  for (const migration of normalized.migrations) {
    const existing = stateRow(ctx.db, ctx.backendId, 'migration', migration.name);
    if (existing) {
      skipped.push(artifactResult(migration));
      continue;
    }
    try {
      await dataPlane.applyMigration(ctx.backendId, migration.content);
      recordSchemaMigration(ctx.db, {
        backendId: ctx.backendId,
        userId: ctx.user && ctx.user.id,
        sql: migration.content,
        status: 'applied',
      });
    } catch (error) {
      recordSchemaMigration(ctx.db, {
        backendId: ctx.backendId,
        userId: ctx.user && ctx.user.id,
        sql: migration.content,
        status: 'failed',
        error: error && error.message || String(error),
      });
      return { applied, skipped, failed: failedArtifact(migration, error) };
    }
    saveState(ctx, migration, { id: migration.name });
    applied.push(artifactResult(migration));
  }

  const backend = ctx.db.prepare('SELECT gateway_url FROM account_backends WHERE id=?').get(ctx.backendId);
  for (const fn of normalized.functions) {
    const existing = stateRow(ctx.db, ctx.backendId, 'function', fn.name);
    if (sameFunctionState(existing, fn)) {
      skipped.push(artifactResult(fn));
      continue;
    }
    if (fn.hasTestInput) {
      try {
        const draft = await functionRuntime.runUserFunction({
          backendId: ctx.backendId,
          gatewayUrl: backend && backend.gateway_url || `${ctx.gatewayBase}/${ctx.backendId}`,
          slug: fn.name,
          source: fn.content,
          input: fn.testInput,
          timeoutMs: limitsForTier(ctx.user && ctx.user.tier).maxFunctionMs,
        });
        if (draft && draft.ok === false) {
          return { applied, skipped, failed: failedArtifact(fn, draft.error || 'draft test failed') };
        }
      } catch (error) {
        return { applied, skipped, failed: failedArtifact(fn, error) };
      }
    }
    const now = new Date().toISOString();
    const saved = ctx.db.prepare('SELECT id FROM backend_functions WHERE backend_id=? AND slug=?').get(ctx.backendId, fn.name);
    ctx.db.prepare(`INSERT INTO backend_functions
      (id, backend_id, slug, source, runtime, enabled, secrets, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'deno-ts', ?, ?, ?, ?)
      ON CONFLICT(backend_id, slug) DO UPDATE SET
        source=excluded.source, enabled=excluded.enabled, secrets=excluded.secrets, updated_at=excluded.updated_at`)
      .run(saved ? saved.id : crypto.randomUUID(), ctx.backendId, fn.name, fn.content,
        fn.enabled ? 1 : 0, JSON.stringify(fn.secrets), now, now);
    saveState(ctx, fn, { enabled: fn.enabled, secrets: fn.secrets });
    applied.push(artifactResult(fn));
  }

  return { applied, skipped };
}

function backendSourceStatus(ctx) {
  const rows = ctx.db.prepare(`SELECT kind, name, path, sha256, metadata_json, user_id, deployed_at
    FROM backend_source_artifacts WHERE backend_id=? ORDER BY kind, name`).all(ctx.backendId);
  return {
    artifacts: rows.map((row) => {
      let metadata = {};
      try { metadata = JSON.parse(row.metadata_json || '{}'); } catch (_) { metadata = {}; }
      return {
        kind: row.kind,
        name: row.name,
        path: row.path,
        sha256: row.sha256,
        metadata,
        deployedBy: row.user_id || null,
        deployedAt: row.deployed_at,
      };
    }),
  };
}

module.exports = {
  deployBackendManifest,
  backendSourceStatus,
  buildBackendPreview,
  canonicalDeploymentDigest,
  runBackendDeployment,
  migrationRiskWarnings,
  sha256,
  normalizePayload,
};
