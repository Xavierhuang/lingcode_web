#!/usr/bin/env node
'use strict';

// rotate-vault-key.js — re-encrypt every row in prototype_secrets from
// an old vault master key to a new one. Run when:
//   - you rotate LINGCODE_VAULT_MASTER_KEY for any reason (compromise,
//     employee turnover, calendar policy)
//   - you migrate from the legacy LINGCODE_SECRETS_KEY env var to the
//     new LINGCODE_VAULT_MASTER_KEY (same value works either way; this
//     script is only needed if you change the value)
//
// SAFETY:
//   - Always takes a snapshot backup of data.db before touching anything
//   - Wraps the whole rotation in a transaction; partial failure rolls back
//   - Idempotent: if a row already decrypts with the NEW key, leaves it alone
//   - Never prints plaintext secret values
//   - Confirms interactively unless --yes is passed
//
// USAGE:
//   OLD_VAULT_KEY=<old-hex-or-base64> NEW_VAULT_KEY=<new-hex-or-base64> \
//     node scripts/rotate-vault-key.js [--db <path>] [--dry-run] [--yes]
//
// EXIT CODES:
//   0  — success, all rows rotated (or already on new key)
//   1  — bad arguments / env
//   2  — at least one row failed to rotate (DB rolled back)
//   3  — user declined the confirmation prompt

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const VERSION = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const ALGO = 'aes-256-gcm';

// ---- argv ------------------------------------------------------------

const argv = process.argv.slice(2);
const opts = { dbPath: path.join(__dirname, '..', 'data.db'), dryRun: false, yes: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--db') opts.dbPath = argv[++i];
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--yes' || a === '-y') opts.yes = true;
  else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
  else { console.error(`Unknown argument: ${a}`); printUsage(); process.exit(1); }
}

function printUsage() {
  console.error(`
Re-encrypt every prototype_secrets row from OLD_VAULT_KEY to NEW_VAULT_KEY.

Required env:
  OLD_VAULT_KEY    32-byte key as 64 hex chars or 44 base64 chars
  NEW_VAULT_KEY    32-byte key as 64 hex chars or 44 base64 chars

Options:
  --db <path>      sqlite database (default: server/data.db)
  --dry-run        report what would change, don't touch the DB
  --yes, -y        skip the confirmation prompt
  --help, -h       this message
`);
}

// ---- key parsing (matches secrets-vault.js) --------------------------

function parseKey(raw, label) {
  if (!raw) throw new Error(`${label} env var is required (32-byte key, 64 hex or 44 base64 chars)`);
  let buf;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex');
  else buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error(`${label} must be 32 bytes (got ${buf.length})`);
  return buf;
}

let OLD_KEY, NEW_KEY;
try {
  OLD_KEY = parseKey(process.env.OLD_VAULT_KEY, 'OLD_VAULT_KEY');
  NEW_KEY = parseKey(process.env.NEW_VAULT_KEY, 'NEW_VAULT_KEY');
} catch (err) {
  console.error('ERROR: ' + err.message);
  printUsage();
  process.exit(1);
}

if (OLD_KEY.equals(NEW_KEY)) {
  console.error('ERROR: OLD_VAULT_KEY and NEW_VAULT_KEY are identical — nothing to rotate.');
  process.exit(1);
}

// ---- crypto (matches secrets-vault.js format) ------------------------

function encrypt(plaintext, key) {
  const data = Buffer.from(plaintext, 'utf8');
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, nonce);
  const cipherBuf = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), nonce, tag, cipherBuf]).toString('base64');
}

function decrypt(blob, key) {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < 1 + NONCE_LEN + TAG_LEN) throw new Error('blob too short');
  const version = buf[0];
  if (version !== VERSION) throw new Error(`unsupported version 0x${version.toString(16)}`);
  const nonce = buf.subarray(1, 1 + NONCE_LEN);
  const tag = buf.subarray(1 + NONCE_LEN, 1 + NONCE_LEN + TAG_LEN);
  const ct = buf.subarray(1 + NONCE_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ---- main ------------------------------------------------------------

(async function main() {
  if (!fs.existsSync(opts.dbPath)) {
    console.error(`ERROR: database not found at ${opts.dbPath}`);
    process.exit(1);
  }

  let Database;
  try { Database = require('better-sqlite3'); }
  catch { console.error('ERROR: better-sqlite3 not installed. Run from website/server/ with deps installed.'); process.exit(1); }

  const db = new Database(opts.dbPath);
  const rows = db.prepare('SELECT id, prototype_id, key, encrypted_value FROM prototype_secrets').all();

  if (rows.length === 0) {
    console.log('No rows in prototype_secrets — nothing to rotate. Update your env var and restart.');
    process.exit(0);
  }

  // ── Pre-flight: classify every row WITHOUT mutating ──
  const work = { rotate: [], alreadyNew: [], failed: [] };
  for (const r of rows) {
    let plaintext;
    try { plaintext = decrypt(r.encrypted_value, OLD_KEY); work.rotate.push({ row: r, plaintext }); continue; } catch { /* fall through */ }
    try { decrypt(r.encrypted_value, NEW_KEY); work.alreadyNew.push(r); continue; } catch { /* fall through */ }
    work.failed.push(r);
  }

  console.log('');
  console.log(`Database:        ${opts.dbPath}`);
  console.log(`Rows total:      ${rows.length}`);
  console.log(`  → to rotate:   ${work.rotate.length}`);
  console.log(`  → already new: ${work.alreadyNew.length} (skipped)`);
  console.log(`  → unreadable:  ${work.failed.length} (decrypt fails with both keys)`);
  console.log('');

  if (work.failed.length > 0) {
    console.log('UNREADABLE ROWS (will NOT be modified):');
    for (const r of work.failed) console.log(`  - id=${r.id} prototype_id=${r.prototype_id} key=${r.key}`);
    console.log('');
  }

  if (opts.dryRun) {
    console.log('Dry run — no changes written.');
    process.exit(work.failed.length > 0 ? 2 : 0);
  }

  if (work.rotate.length === 0) {
    console.log('No rows need rotating. Done.');
    process.exit(work.failed.length > 0 ? 2 : 0);
  }

  if (!opts.yes) {
    const ok = await confirm(`Re-encrypt ${work.rotate.length} row(s) and write to ${opts.dbPath}? [y/N] `);
    if (!ok) { console.log('Aborted.'); process.exit(3); }
  }

  // ── Backup (always; even on a small DB this is cheap insurance) ──
  const stamp = new Date().toISOString().replace(/[:]/g, '-').slice(0, 19);
  const backupPath = `${opts.dbPath}.bak.${stamp}`;
  fs.copyFileSync(opts.dbPath, backupPath);
  console.log(`Backup: ${backupPath}`);

  // ── Rotation in a transaction ──
  const upd = db.prepare('UPDATE prototype_secrets SET encrypted_value = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  let written = 0;
  try {
    db.exec('BEGIN');
    for (const item of work.rotate) {
      const newBlob = encrypt(item.plaintext, NEW_KEY);
      upd.run(newBlob, now, item.row.id);
      written += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(`\nROLLBACK: error during rotation: ${err.message}`);
    console.error(`Backup is intact at ${backupPath}`);
    process.exit(2);
  }

  console.log(`\nDone. Rotated ${written} row(s).`);
  if (work.failed.length > 0) {
    console.log(`(${work.failed.length} unreadable row(s) left untouched — investigate before deleting them.)`);
    process.exit(2);
  }
  process.exit(0);
})();

// ---- helpers ---------------------------------------------------------

function confirm(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false); // non-tty defaults to "no"
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (ans) => { rl.close(); resolve(/^y(es)?$/i.test(ans.trim())); });
  });
}
