#!/usr/bin/env node
'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const { digestToken } = require('../account-tokens');

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function checkTokenMigration(db, options = {}) {
  const pepper = String(options.pepper || process.env.LINGCODE_TOKEN_PEPPER || '');
  if (!pepper) {
    const error = new Error('LINGCODE_TOKEN_PEPPER is required');
    error.code = 'token_pepper_required';
    throw error;
  }

  const accounts = db.prepare("SELECT api_access_token AS token FROM users WHERE api_access_token IS NOT NULL AND api_access_token != ''").all();
  const scoped = hasTable(db, 'scoped_tokens')
    ? db.prepare("SELECT token FROM scoped_tokens WHERE token IS NOT NULL AND token != ''").all()
    : [];
  const digestTableExists = hasTable(db, 'account_tokens');
  const digestRows = digestTableExists
    ? db.prepare('SELECT COUNT(*) AS n FROM account_tokens').get().n
    : 0;
  const covered = digestTableExists
    ? db.prepare("SELECT 1 FROM account_tokens WHERE digest_version='h1' AND token_digest=?")
    : null;
  let missingDigestRows = 0;
  for (const row of [...accounts, ...scoped]) {
    if (!covered || !covered.get(digestToken(row.token, pepper))) missingDigestRows += 1;
  }
  const newPlaintextIssuerRows = accounts.filter((row) => /^lcat_[0-9a-f]{64}$/i.test(row.token)).length
    + scoped.filter((row) => /^lct_[0-9a-f]{64}$/i.test(row.token)).length;

  return {
    legacyAccountRows: accounts.length,
    legacyScopedRows: scoped.length,
    digestRows,
    missingDigestRows,
    newPlaintextIssuerRows,
  };
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const databasePath = argument('--db', process.env.CLOUD_DB_PATH || path.join(__dirname, '..', 'data.db'));
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const report = checkTokenMigration(db);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.missingDigestRows > 0 || report.newPlaintextIssuerRows > 0) {
      process.exitCode = 2;
      process.stderr.write('token_migration_incomplete\n');
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error && error.code ? error.code : 'token_migration_check_failed'}\n`);
  }
}

module.exports = { checkTokenMigration };
