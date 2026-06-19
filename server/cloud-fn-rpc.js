'use strict';

// cloud-fn-rpc.js — backend access for sandboxed serverless functions.
//
// A function runs in a Deno sandbox whose ONLY allowed network host is its
// backend's gateway (cloud-functions-runtime.js: `--allow-net=<gatewayHost>`).
// So when a function calls `ctx.db.query(...)` or `ctx.storage.*`, the in-sandbox
// shim fetches an internal endpoint here, authenticated by a SHORT-LIVED token
// minted for that single invocation. The endpoint runs the op as the tenant role
// (RLS enforced) — the same isolation as the anon data path, never broader.
//
// The token is not vended to the app: it's injected into the function's ctx and
// lives only for the invocation. Even if a function logs it, it grants nothing
// the backend's own anon key doesn't already grant (tenant-scoped, RLS-bound),
// and it expires within seconds.

const crypto = require('crypto');
const dataPlane = require('./cloud-data-plane');
const storage = require('./cloud-storage');

// token -> { backendId, userId, expiresAt }
const _tokens = new Map();

function _sweep() {
  const now = Date.now();
  for (const [t, v] of _tokens) if (v.expiresAt <= now) _tokens.delete(t);
}

// Mint a token valid for `ttlMs` (the function's wall-clock budget + slack).
function issueToken(backendId, userId, ttlMs) {
  _sweep();
  const token = crypto.randomBytes(24).toString('base64url');
  _tokens.set(token, { backendId, userId: userId || null, expiresAt: Date.now() + Math.max(1000, ttlMs || 10000) });
  return token;
}

function resolveToken(token) {
  if (!token) return null;
  const v = _tokens.get(token);
  if (!v) return null;
  if (v.expiresAt <= Date.now()) { _tokens.delete(token); return null; }
  return v;
}

function revokeToken(token) { if (token) _tokens.delete(token); }

const STORAGE_OPS = new Set(['storage.list', 'storage.remove', 'storage.url', 'storage.uploadUrl']);

// Dispatch one RPC op for an already-authenticated invocation. `auth` is the
// resolved token payload { backendId, userId }. Returns the JSON-able result.
async function dispatch(auth, body) {
  const op = String((body && body.op) || '');
  const backendId = auth.backendId;
  if (op === 'query') {
    return dataPlane.execAsTenant(backendId, body.sql, body.params || [], {
      userId: auth.userId, readOnly: body.readOnly === true,
    });
  }
  if (STORAGE_OPS.has(op)) {
    if (!storage.isConfigured()) { const e = new Error('storage_not_configured'); e.status = 503; throw e; }
    const bucket = body.bucket === 'private' ? 'private' : 'public';
    const path = String(body.path || '');
    if (op === 'storage.uploadUrl') {
      const url = await storage.presignPut(backendId, bucket, path, body.contentType || 'application/octet-stream', Math.min(3600, body.expiresIn || 900));
      return { url, key: storage.keyFor(backendId, bucket, path) };
    }
    if (op === 'storage.url') {
      if (bucket === 'public') return { url: storage.publicUrl(backendId, bucket, path) };
      return { url: await storage.presignGet(backendId, bucket, path, Math.min(3600, body.expiresIn || 900)) };
    }
    if (op === 'storage.remove') { await storage.removeObject(backendId, bucket, path); return { ok: true }; }
    if (op === 'storage.list') { const e = new Error('storage.list is owner-console only'); e.status = 400; throw e; }
  }
  const e = new Error(`unknown op: ${op}`); e.status = 400; throw e;
}

// Register the internal endpoint on the gateway origin. Auth is the per-invocation
// token (NOT the anon key) and the token's backend must match the path param.
function registerFnRpcRoute(app) {
  const express = require('express');
  app.post('/api/cloud/be/:backendId/_fn-rpc', express.json({ limit: '1mb' }), async (req, res) => {
    const auth = (req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const resolved = resolveToken(token);
    if (!resolved) return res.status(401).json({ ok: false, error: 'invalid_fn_token' });
    if (resolved.backendId !== String(req.params.backendId || '')) {
      return res.status(403).json({ ok: false, error: 'backend_mismatch' });
    }
    try {
      const data = await dispatch(resolved, req.body || {});
      res.json({ ok: true, data });
    } catch (err) {
      res.status(err.status || 400).json({ ok: false, error: err.code || 'fn_rpc_error', message: String(err.message || err) });
    }
  });
}

module.exports = { issueToken, resolveToken, revokeToken, dispatch, registerFnRpcRoute };
