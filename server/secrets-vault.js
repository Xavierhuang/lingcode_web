'use strict';

// secrets-vault.js — Phase 4 per-prototype secrets storage.
//
// USE CASES:
//   - User pastes STRIPE_SECRET_KEY for the AI's `deploy_edge_function`
//     to inject when scaffolding a Stripe checkout integration
//   - User pastes a 3rd-party API key (OpenAI, Stripe, Twilio, etc.)
//     and references it from generated Edge Functions / server code
//
// FORMAT: AES-256-GCM with a master key from env. Each ciphertext is
//   base64(VERSION_BYTE || NONCE_12 || AUTHTAG_16 || CIPHER)
//   VERSION 0x01 = AES-256-GCM as described.
//
// We use Node's built-in `crypto` (OpenSSL-backed) rather than libsodium
// to avoid adding a native-build dep. AES-256-GCM is the canonical
// authenticated-encryption choice for at-rest secrets.
//
// THREAT MODEL covered:
//   - DB exfiltration alone → plaintext secrets remain safe (master key
//     not in the DB)
//   - Master key in env without DB access → useless
//   - Tampered ciphertext bytes → GCM auth tag fails, decrypt throws
//
// NOT covered (explicitly out of scope for v1):
//   - Per-user key derivation (a Phase 4 follow-up; today the master is
//     a single key for the whole deployment). Mitigated by user_id
//     ownership check before decrypt.
//   - Key rotation (would need a re-encrypt-all migration; track via
//     VERSION byte so a future v2 can coexist with v1 rows)

const crypto = require('crypto');
const { getUserFromRequest } = require('./auth-helpers');

const VERSION = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const ALGO = 'aes-256-gcm';

// Hard-cap secrets to a generous-but-not-abuse-friendly size.
const MAX_VALUE_BYTES = 16 * 1024;       // 16 KB per secret
const MAX_PER_PROTOTYPE = 32;            // 32 secrets per prototype
const MAX_KEY_LENGTH = 64;
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;  // env-var-style, conventional

function isConfigured() {
  return !!getMasterKeyOrNull();
}

// Primary env var is LINGCODE_VAULT_MASTER_KEY. The old LINGCODE_SECRETS_KEY
// name is still honored as a fallback for environments deployed before
// the rename — drop the fallback once those have caught up.
function getMasterKeyOrNull() {
  const raw = process.env.LINGCODE_VAULT_MASTER_KEY || process.env.LINGCODE_SECRETS_KEY;
  if (!raw) return null;
  // Accept hex (64 chars) or base64 (44 chars including padding).
  let buf;
  try {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex');
    else buf = Buffer.from(raw, 'base64');
  } catch { return null; }
  if (buf.length !== 32) return null;
  return buf;
}

function getMasterKey() {
  const k = getMasterKeyOrNull();
  if (!k) {
    throw new Error('Secrets vault not configured: set LINGCODE_VAULT_MASTER_KEY to a 32-byte key (64 hex chars or 44 base64 chars). Generate with: openssl rand -hex 32');
  }
  return k;
}

/**
 * Encrypt a string. Returns a base64 blob ready to write to the DB.
 * @param {string} plaintext
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string') throw new Error('encrypt: string required');
  const data = Buffer.from(plaintext, 'utf8');
  if (data.length > MAX_VALUE_BYTES) throw new Error(`secret too large (${data.length} > ${MAX_VALUE_BYTES} bytes)`);
  const masterKey = getMasterKey();
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv(ALGO, masterKey, nonce);
  const cipherBuf = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), nonce, tag, cipherBuf]).toString('base64');
}

/**
 * Decrypt a blob produced by encrypt(). Throws on tamper or wrong key.
 * @param {string} blob
 */
function decrypt(blob) {
  if (typeof blob !== 'string' || !blob) throw new Error('decrypt: blob required');
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < 1 + NONCE_LEN + TAG_LEN) throw new Error('decrypt: blob too short');
  const version = buf[0];
  if (version !== VERSION) throw new Error(`decrypt: unsupported vault version 0x${version.toString(16)}`);
  const nonce = buf.subarray(1, 1 + NONCE_LEN);
  const tag = buf.subarray(1 + NONCE_LEN, 1 + NONCE_LEN + TAG_LEN);
  const ct = buf.subarray(1 + NONCE_LEN + TAG_LEN);
  const masterKey = getMasterKey();
  const decipher = crypto.createDecipheriv(ALGO, masterKey, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString('utf8');
}

// ---- DB helpers -------------------------------------------------------

function ownsPrototype(db, prototypeId, userId) {
  const row = db.prepare('SELECT 1 FROM saved_prototypes WHERE id = ? AND user_id = ?').get(prototypeId, userId);
  return !!row;
}

function listSecretMeta(db, prototypeId) {
  return db.prepare(`
    SELECT key, length(encrypted_value) AS encrypted_len, created_at, updated_at
    FROM prototype_secrets
    WHERE prototype_id = ?
    ORDER BY key ASC
  `).all(prototypeId);
}

function readSecret(db, prototypeId, key) {
  const row = db.prepare('SELECT encrypted_value FROM prototype_secrets WHERE prototype_id = ? AND key = ?').get(prototypeId, key);
  if (!row) return null;
  return decrypt(row.encrypted_value);
}

function setSecret(db, prototypeId, userId, key, plaintext) {
  const now = new Date().toISOString();
  const encrypted = encrypt(plaintext);
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO prototype_secrets (id, prototype_id, user_id, key, encrypted_value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(prototype_id, key) DO UPDATE SET
      encrypted_value = excluded.encrypted_value,
      updated_at = excluded.updated_at
  `).run(id, prototypeId, userId, key, encrypted, now, now);
}

function deleteSecret(db, prototypeId, key) {
  return db.prepare('DELETE FROM prototype_secrets WHERE prototype_id = ? AND key = ?').run(prototypeId, key).changes;
}

// ---- account-backend secrets (keyed by backend_id) --------------------
// Same encryption + caps as prototype secrets, but scoped to a Cloud account
// backend (which has no prototype_id). Ownership is enforced at the route via
// accountBackend(); these helpers assume the caller already authorized.

function listBackendSecretMeta(db, backendId) {
  return db.prepare(`SELECT key, kind, length(encrypted_value) AS encrypted_len, created_at, updated_at
    FROM backend_secrets WHERE backend_id = ? ORDER BY key ASC`).all(backendId);
}

function readBackendSecret(db, backendId, key) {
  const row = db.prepare('SELECT encrypted_value FROM backend_secrets WHERE backend_id = ? AND key = ?').get(backendId, key);
  return row ? decrypt(row.encrypted_value) : null;
}

// Plaintext value ONLY for non-sensitive 'var' entries (console read-back). Returns
// null for a true 'secret' (never expose those) or a missing key. The kind check
// is what makes read-back safe.
function readBackendVar(db, backendId, key) {
  const row = db.prepare("SELECT encrypted_value, kind FROM backend_secrets WHERE backend_id = ? AND key = ?").get(backendId, key);
  if (!row || row.kind !== 'var') return null;
  try { return decrypt(row.encrypted_value); } catch (_) { return null; }
}

// kind: 'secret' (default, masked) | 'var' (readable-back config). Both encrypt at
// rest and both ship as c.env bindings to a deployed Worker.
function setBackendSecret(db, backendId, key, plaintext, kind = 'secret') {
  const now = new Date().toISOString();
  const encrypted = encrypt(plaintext);
  const k = kind === 'var' ? 'var' : 'secret';
  db.prepare(`INSERT INTO backend_secrets (backend_id, key, encrypted_value, kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(backend_id, key) DO UPDATE SET encrypted_value = excluded.encrypted_value, kind = excluded.kind, updated_at = excluded.updated_at`)
    .run(backendId, key, encrypted, k, now, now);
}

function deleteBackendSecret(db, backendId, key) {
  return db.prepare('DELETE FROM backend_secrets WHERE backend_id = ? AND key = ?').run(backendId, key).changes;
}

// Decrypt all of a backend's secrets into a { KEY: value } map for ctx.secrets.
// Best-effort: a row that fails to decrypt (e.g. master-key rotation) is skipped.
function readAllBackendSecrets(db, backendId) {
  const out = {};
  for (const r of db.prepare('SELECT key, encrypted_value FROM backend_secrets WHERE backend_id = ?').all(backendId)) {
    try { out[r.key] = decrypt(r.encrypted_value); } catch (_) {}
  }
  return out;
}

// ---- worker secrets (keyed by worker_id) ------------------------------
// Per-deployed-Worker env vars, settable directly with NO managed backend. Same
// encryption as backend secrets; bound to the Worker as c.env.<KEY> on deploy.

function listWorkerSecretMeta(db, workerId) {
  return db.prepare(`SELECT key, length(encrypted_value) AS encrypted_len, created_at, updated_at
    FROM worker_secrets WHERE worker_id = ? ORDER BY key ASC`).all(workerId);
}

function setWorkerSecret(db, workerId, key, plaintext) {
  const now = new Date().toISOString();
  const encrypted = encrypt(plaintext);
  db.prepare(`INSERT INTO worker_secrets (worker_id, key, encrypted_value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(worker_id, key) DO UPDATE SET encrypted_value = excluded.encrypted_value, updated_at = excluded.updated_at`)
    .run(workerId, key, encrypted, now, now);
}

function deleteWorkerSecret(db, workerId, key) {
  return db.prepare('DELETE FROM worker_secrets WHERE worker_id = ? AND key = ?').run(workerId, key).changes;
}

function readAllWorkerSecrets(db, workerId) {
  const out = {};
  for (const r of db.prepare('SELECT key, encrypted_value FROM worker_secrets WHERE worker_id = ?').all(workerId)) {
    try { out[r.key] = decrypt(r.encrypted_value); } catch (_) {}
  }
  return out;
}

// ---- HTTP routes ------------------------------------------------------

/**
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
function registerSecretsVaultRoutes(app, db) {
  // ── GET /api/prototypes/:id/secrets — list keys + metadata, no values ──
  app.get('/api/prototypes/:id/secrets', (req, res) => {
    if (!isConfigured()) return res.status(503).json({ ok: false, error: 'vault_not_configured' });
    const user = getUserFromRequest(db, req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const prototypeId = String(req.params.id || '');
    if (!ownsPrototype(db, prototypeId, user.id)) {
      return res.status(404).json({ ok: false, error: 'prototype_not_found' });
    }
    res.json({ ok: true, data: listSecretMeta(db, prototypeId) });
  });

  // ── PUT /api/prototypes/:id/secrets/:key — set or update ──
  app.put('/api/prototypes/:id/secrets/:key', (req, res) => {
    if (!isConfigured()) return res.status(503).json({ ok: false, error: 'vault_not_configured' });
    const user = getUserFromRequest(db, req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const prototypeId = String(req.params.id || '');
    const key = String(req.params.key || '');
    if (!KEY_PATTERN.test(key) || key.length > MAX_KEY_LENGTH) {
      return res.status(400).json({ ok: false, error: 'invalid_key', message: 'Key must match /^[A-Z][A-Z0-9_]{0,63}$/.' });
    }
    if (!ownsPrototype(db, prototypeId, user.id)) {
      return res.status(404).json({ ok: false, error: 'prototype_not_found' });
    }
    const value = req.body && typeof req.body.value === 'string' ? req.body.value : null;
    if (value === null) return res.status(400).json({ ok: false, error: 'invalid_request', message: '`value` (string) required in JSON body' });
    if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
      return res.status(413).json({ ok: false, error: 'value_too_large', message: `max ${MAX_VALUE_BYTES} bytes` });
    }
    // Per-prototype cap so a runaway agent loop can't bloat the DB.
    const existing = db.prepare('SELECT COUNT(*) AS n FROM prototype_secrets WHERE prototype_id = ?').get(prototypeId).n;
    const isReplacing = !!db.prepare('SELECT 1 FROM prototype_secrets WHERE prototype_id = ? AND key = ?').get(prototypeId, key);
    if (!isReplacing && existing >= MAX_PER_PROTOTYPE) {
      return res.status(409).json({ ok: false, error: 'too_many_secrets', message: `max ${MAX_PER_PROTOTYPE} secrets per prototype` });
    }
    try {
      setSecret(db, prototypeId, user.id, key, value);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'encrypt_failed', message: err.message });
    }
  });

  // ── DELETE /api/prototypes/:id/secrets/:key ──
  app.delete('/api/prototypes/:id/secrets/:key', (req, res) => {
    const user = getUserFromRequest(db, req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const prototypeId = String(req.params.id || '');
    const key = String(req.params.key || '');
    if (!ownsPrototype(db, prototypeId, user.id)) {
      return res.status(404).json({ ok: false, error: 'prototype_not_found' });
    }
    const removed = deleteSecret(db, prototypeId, key);
    res.json({ ok: true, data: { removed } });
  });
}

module.exports = {
  registerSecretsVaultRoutes,
  isConfigured,
  // server-side consumers (e.g. an Edge Function deploy flow) call this
  // directly to fetch a secret in plaintext for injection into upstream
  // payloads. Never expose via HTTP.
  readSecret,
  // account-backend secrets (keyed by backend_id) + caps for the routes
  listBackendSecretMeta,
  readBackendSecret,
  readBackendVar,
  setBackendSecret,
  deleteBackendSecret,
  readAllBackendSecrets,
  // worker secrets (keyed by worker_id) — direct env vars, no backend needed
  listWorkerSecretMeta,
  setWorkerSecret,
  deleteWorkerSecret,
  readAllWorkerSecrets,
  KEY_PATTERN,
  MAX_VALUE_BYTES,
  MAX_PER_BACKEND: MAX_PER_PROTOTYPE,
  // exported for tests
  _encrypt: encrypt,
  _decrypt: decrypt,
  _KEY_PATTERN: KEY_PATTERN,
  _MAX_VALUE_BYTES: MAX_VALUE_BYTES,
};
