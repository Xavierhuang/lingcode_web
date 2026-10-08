#!/usr/bin/env node
'use strict';

// offload-objects-to-spaces.js — move backend_objects blobs that were stored
// inline (base64 in data.db) out to DigitalOcean Spaces.
//
// persistObject() falls back to inline base64 whenever Spaces is not
// configured. Prod ran that way until 2026-10-08, and autoyt alone put 1.7 GB
// of media into data.db (2.3 GB of a 2.5 GB file), which filled the disk.
// Once SPACES_* is set in .env, new uploads go to Spaces; this script moves
// the rows written before that.
//
// SAFETY:
//   - Uploads each blob, then HEADs it and checks the byte count before
//     touching the row.
//   - The row is only rewritten if data_b64 is still exactly what was uploaded,
//     so an app re-uploading the same path mid-run keeps its new bytes.
//   - Idempotent: rows that already have spaces_key or empty data_b64 are
//     skipped, so an interrupted run can simply be re-run.
//   - Never deletes anything from Spaces.
//   - --dry-run only counts. Without --yes it asks before writing.
//
// Emptied rows leave free pages inside data.db; the file only shrinks after
// VACUUM. Pass --vacuum to run it at the end (it blocks writers for roughly a
// minute on the prod box, so run it at a quiet time).
//
// USAGE (on the API box, as the service user):
//   cd /opt/lingcode-api && sudo -u lingcode node scripts/offload-objects-to-spaces.js \
//     [--db <path>] [--backend <id>] [--limit N] [--dry-run] [--yes] [--vacuum]
//
// EXIT CODES:
//   0  — every candidate row moved (or nothing to do)
//   1  — bad arguments / Spaces not configured
//   2  — at least one row failed (the rest were moved; re-run to retry)
//   3  — user declined the confirmation prompt

const path = require('path');
const readline = require('readline');

function parseArgs(argv) {
  const out = { db: null, backend: null, limit: 0, dryRun: false, yes: false, vacuum: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i];
    else if (a === '--backend') out.backend = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]) || 0;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--yes') out.yes = true;
    else if (a === '--vacuum') out.vacuum = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

// Candidate ids only — the blobs are read one row at a time so a 2 GB table
// never sits in memory.
function candidateIds(db, { backend, limit }) {
  let sql = `SELECT id FROM backend_objects WHERE spaces_key IS NULL AND data_b64 != ''`;
  const params = [];
  if (backend) { sql += ' AND backend_id = ?'; params.push(backend); }
  sql += ' ORDER BY created_at';
  if (limit > 0) { sql += ' LIMIT ?'; params.push(limit); }
  return db.prepare(sql).all(...params).map((r) => r.id);
}

async function offloadObjects({ db, storage, backend = null, limit = 0, log = () => {} }) {
  const ids = candidateIds(db, { backend, limit });
  const getRow = db.prepare(
    `SELECT id, backend_id, bucket, path, content_type, data_b64 FROM backend_objects
      WHERE id = ? AND spaces_key IS NULL AND data_b64 != ''`);
  const markMoved = db.prepare(
    `UPDATE backend_objects SET data_b64 = '', spaces_key = ?, etag = ?
      WHERE id = ? AND spaces_key IS NULL AND data_b64 = ?`);
  const result = { candidates: ids.length, moved: 0, skipped: 0, failed: 0, bytes: 0, errors: [] };

  for (const id of ids) {
    const row = getRow.get(id);
    if (!row) { result.skipped++; continue; } // deleted or moved since listing
    try {
      const buf = Buffer.from(row.data_b64, 'base64');
      const put = await storage.putObject(row.backend_id, row.bucket, row.path, buf,
        row.content_type || 'application/octet-stream');
      const head = await storage.headObject(row.backend_id, row.bucket, row.path);
      if (!head || head.bytes !== buf.length) {
        throw new Error(`verify failed: expected ${buf.length} bytes, Spaces has ${head ? head.bytes : 'nothing'}`);
      }
      const info = markMoved.run(put.key, put.etag || head.etag || null, row.id, row.data_b64);
      if (info.changes === 1) {
        result.moved++;
        result.bytes += buf.length;
      } else {
        // Re-uploaded or deleted while we were copying; the row is left as the
        // app wrote it, and the copy in Spaces is overwritten by the next move.
        result.skipped++;
      }
    } catch (err) {
      result.failed++;
      result.errors.push({ id: row.id, backend_id: row.backend_id, path: row.path, error: String((err && err.message) || err) });
    }
    const done = result.moved + result.skipped + result.failed;
    if (done % 50 === 0) log(`  ${done}/${ids.length} (moved ${result.moved}, failed ${result.failed})`);
  }
  return result;
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); }));
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }

  const serverDir = path.join(__dirname, '..');
  require('dotenv').config({ path: path.join(serverDir, '.env') });
  const storage = require(path.join(serverDir, 'cloud-storage'));
  const Database = require('better-sqlite3');

  const dbPath = args.db || path.join(serverDir, 'data.db');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 10000');

  const summary = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM backend_objects
      WHERE spaces_key IS NULL AND data_b64 != ''` + (args.backend ? ' AND backend_id = ?' : ''))
    .get(...(args.backend ? [args.backend] : []));
  console.log(`${dbPath}: ${summary.n} inline object(s), ${(summary.bytes / 1048576).toFixed(1)} MB`);
  if (args.dryRun || summary.n === 0) { db.close(); return; }

  if (!storage.isConfigured()) {
    console.error('Spaces is not configured: set SPACES_KEY, SPACES_SECRET, SPACES_ENDPOINT and SPACES_BUCKET in .env first.');
    db.close();
    process.exit(1);
  }
  if (!args.yes && !(await confirm(`Move them to Spaces bucket "${process.env.SPACES_BUCKET}"? [y/N] `))) {
    db.close();
    process.exit(3);
  }

  const r = await offloadObjects({ db, storage, backend: args.backend, limit: args.limit, log: console.log });
  console.log(`moved ${r.moved} (${(r.bytes / 1048576).toFixed(1)} MB), skipped ${r.skipped}, failed ${r.failed}`);
  for (const e of r.errors.slice(0, 20)) console.log(`  FAILED ${e.backend_id} ${e.path}: ${e.error}`);

  if (args.vacuum && r.failed === 0) {
    console.log('VACUUM…');
    db.exec('VACUUM');
    console.log('VACUUM done');
  }
  db.close();
  if (r.failed > 0) process.exit(2);
}

if (require.main === module) {
  main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(2); });
}

module.exports = { offloadObjects, parseArgs };
