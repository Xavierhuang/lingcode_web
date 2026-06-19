'use strict';

// cloud-fn-invoke.js — the one place a user function is actually run.
//
// Shared by the HTTP invocation route (cloud-backend.js) and the scheduled-function
// scheduler (cloud-function-cron.js) so secret resolution, the per-invocation
// backend-access token (cloud-fn-rpc), and the runtime call stay identical.

const runtime = require('./cloud-functions-runtime');
const fnRpc = require('./cloud-fn-rpc');
const secretsVault = require('./secrets-vault');
const { limitsForTier } = require('./cloud-limits');

// The internal RPC endpoint lives on the backend's gateway origin (the only host
// the sandbox is allowed to reach). Returns null if the gateway URL is unusable.
function rpcUrlFor(gatewayUrl, backendId) {
  try { return new URL(gatewayUrl).origin + `/api/cloud/be/${backendId}/_fn-rpc`; }
  catch (_) { return null; }
}

// Run `fnRow` for `beRow`. Returns the runtime result { ok, data | error, logs }.
// `beRow` must have { id, tier, gateway_url, prototype_id }; `fnRow` { slug, source, secrets }.
async function invokeUserFunction(db, beRow, fnRow, { input = null, request = null, userId = null } = {}) {
  if (!runtime.isAvailable()) {
    const e = new Error('The functions runtime is not available on this server.');
    e.status = 503; e.code = 'functions_runtime_unavailable'; throw e;
  }
  const backendId = beRow.id;
  const tier = beRow.tier || 'free';
  const timeoutMs = limitsForTier(tier).maxFunctionMs;

  // Declared secrets (prototype-backed backends only, matching prior behavior).
  const secrets = {};
  const names = (() => { try { return fnRow.secrets ? JSON.parse(fnRow.secrets) : []; } catch (_) { return []; } })();
  if (names.length && secretsVault.isConfigured() && beRow.prototype_id) {
    for (const name of names) { const v = secretsVault.readSecret(db, beRow.prototype_id, name); if (v) secrets[name] = v; }
  }

  // Per-invocation backend-access token (powers ctx.db / ctx.storage), valid for
  // the function's wall-clock budget plus slack; revoked the moment it returns.
  let rpc = null, token = null;
  const url = rpcUrlFor(beRow.gateway_url, backendId);
  if (url) { token = fnRpc.issueToken(backendId, userId, timeoutMs + 5000); rpc = { url, token }; }
  try {
    return await runtime.runUserFunction({
      backendId, gatewayUrl: beRow.gateway_url, slug: fnRow.slug,
      source: fnRow.source, secrets, input, request, rpc, timeoutMs,
    });
  } finally {
    if (token) fnRpc.revokeToken(token);
  }
}

module.exports = { invokeUserFunction };
