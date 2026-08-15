'use strict';

const crypto = require('crypto');

const PLAN_TTL_MS = 10 * 60 * 1000;
const HASH_RE = /^[a-f0-9]{64}$/;

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function stableJSONStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSONStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJSONStringify(value[key])}`).join(',')}}`;
}

function normalizedPayload(preview) {
  if (!preview || !preview.normalized) fail('validated deployment preview missing', 500);
  const migrations = preview.normalized.migrations.map((migration) => ({
    id: migration.name,
    path: migration.path,
  }));
  const functions = preview.normalized.functions.map((fn) => ({
    slug: fn.name,
    path: fn.path,
    enabled: fn.enabled,
    secrets: [...fn.secrets],
    ...(fn.hasTestInput ? { testInput: fn.testInput } : {}),
  }));
  const files = {};
  const hashes = {};
  for (const artifact of [...preview.normalized.migrations, ...preview.normalized.functions]) {
    files[artifact.path] = artifact.content;
    hashes[artifact.path] = artifact.sha256;
  }
  return { manifest: { version: 1, migrations, functions }, files, hashes };
}

function confirmationEnvelope(preview) {
  return {
    summary: preview && preview.summary,
    warnings: preview && Array.isArray(preview.warnings) ? preview.warnings : [],
  };
}

function createDeploymentPlan(ctx, _payload, preview, now = Date.now()) {
  if (!ctx || !ctx.db || !ctx.backendId || !ctx.user || !ctx.user.id) fail('deployment plan context missing', 500);
  if (ctx.environment !== 'production') fail('confirmation plans are only created for production backends', 409);
  if (!preview || !HASH_RE.test(String(preview.digest || ''))) fail('deployment preview digest missing', 500);

  const planId = crypto.randomUUID();
  const expiresAt = now + PLAN_TTL_MS;
  const confirmation = confirmationEnvelope(preview);
  ctx.db.prepare(`INSERT INTO backend_deployment_plans
    (id, backend_id, user_id, environment, manifest_digest, payload_json,
     summary_json, warnings_json, status, expires_at, created_at)
    VALUES (?, ?, ?, 'production', ?, ?, ?, ?, 'pending', ?, ?)`)
    .run(
      planId,
      ctx.backendId,
      ctx.user.id,
      preview.digest,
      JSON.stringify(normalizedPayload(preview)),
      stableJSONStringify(confirmation.summary),
      stableJSONStringify(confirmation.warnings),
      expiresAt,
      now,
    );
  return { planId, expiresAt };
}

function safeDigestEqual(left, right) {
  if (!HASH_RE.test(String(left || '')) || !HASH_RE.test(String(right || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function consumeDeploymentPlan(ctx, args, now = Date.now()) {
  if (!ctx || !ctx.db || !ctx.backendId || !ctx.user || !ctx.user.id) fail('deployment plan context missing', 500);
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('apply arguments must be an object');
  const planId = String(args.planId || '');
  if (!planId) fail('planId is required');

  const consume = ctx.db.transaction(() => {
    const row = ctx.db.prepare('SELECT * FROM backend_deployment_plans WHERE id=?').get(planId);
    if (!row) fail('deployment plan not found; preview again', 404);
    if (row.status !== 'pending') fail('deployment plan was already used; preview again', 409);
    if (row.user_id !== ctx.user.id) fail('deployment plan belongs to a different user', 403);
    if (row.backend_id !== ctx.backendId) fail('deployment plan belongs to a different backend', 403);
    if (row.environment !== 'production' || ctx.environment !== 'production') {
      fail('deployment plan environment changed; preview again', 409);
    }
    if (now > row.expires_at) fail('deployment plan expired; preview again', 409);
    if (!safeDigestEqual(row.manifest_digest, args.digest)) fail('deployment digest changed; preview again', 409);

    const confirmation = args.confirmation;
    if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)) {
      fail('deployment confirmation is required', 400);
    }
    if (stableJSONStringify(confirmation.summary) !== row.summary_json
        || stableJSONStringify(confirmation.warnings) !== row.warnings_json) {
      fail('deployment confirmation does not match the preview', 409);
    }

    const updated = ctx.db.prepare(`UPDATE backend_deployment_plans
      SET status='consumed', consumed_at=? WHERE id=? AND status='pending'`).run(now, planId);
    if (updated.changes !== 1) fail('deployment plan was already used; preview again', 409);
    try {
      return JSON.parse(row.payload_json);
    } catch (_) {
      fail('stored deployment plan is invalid', 500);
    }
  });
  return consume();
}

module.exports = {
  PLAN_TTL_MS,
  createDeploymentPlan,
  consumeDeploymentPlan,
  confirmationEnvelope,
};
