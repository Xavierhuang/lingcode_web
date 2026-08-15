'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migrateVoucherTables } = require('../migrate');

function fixtureDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE
    );
    INSERT INTO users (id, email) VALUES
      ('admin-1', 'admin@example.com'),
      ('user-1', 'one@example.com'),
      ('user-2', 'two@example.com');
  `);
  return db;
}

function seedBatch(db) {
  db.prepare(`
    INSERT INTO voucher_batches
      (id, name, quantity, benefit_days, redeem_by, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('batch-1', 'Launch 2026', 500, 30, 1_800_000_000_000, 'active', 'admin-1', 1_700_000_000_000);
}

function insertVoucher(db, overrides = {}) {
  const row = {
    id: 'voucher-1',
    batch_id: 'batch-1',
    serial_number: 1,
    digest_version: 'h1',
    code_digest: 'h1:code-1',
    display_suffix: 'ABCD',
    status: 'available',
    reserved_by: null,
    reserved_until: null,
    checkout_session_id: null,
    redeemed_by: null,
    redeemed_at: null,
    stripe_subscription_id: null,
    card_fingerprint_digest: null,
    blocked_reason: null,
    revoked_at: null,
    revoked_by: null,
    created_at: 1_700_000_000_000,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO promotion_vouchers (
      id, batch_id, serial_number, digest_version, code_digest, display_suffix,
      status, reserved_by, reserved_until, checkout_session_id, redeemed_by,
      redeemed_at, stripe_subscription_id, card_fingerprint_digest,
      blocked_reason, revoked_at, revoked_by, created_at
    ) VALUES (
      @id, @batch_id, @serial_number, @digest_version, @code_digest, @display_suffix,
      @status, @reserved_by, @reserved_until, @checkout_session_id, @redeemed_by,
      @redeemed_at, @stripe_subscription_id, @card_fingerprint_digest,
      @blocked_reason, @revoked_at, @revoked_by, @created_at
    )
  `).run(row);
}

test('voucher migration creates the three lifecycle tables', () => {
  const db = fixtureDb();
  migrateVoucherTables(db);
  for (const name of ['voucher_batches', 'promotion_vouchers', 'voucher_audit_events']) {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    assert.ok(table, `missing ${name}`);
  }
  db.close();
});

test('voucher migration rejects invalid states and duplicate serials', () => {
  const db = fixtureDb();
  migrateVoucherTables(db);
  seedBatch(db);
  insertVoucher(db);

  assert.throws(() => insertVoucher(db, {
    id: 'voucher-invalid',
    serial_number: 2,
    code_digest: 'h1:invalid',
    status: 'lost',
  }), /CHECK constraint failed/);
  assert.throws(() => insertVoucher(db, {
    id: 'voucher-duplicate-serial',
    code_digest: 'h1:other',
  }), /UNIQUE constraint failed/);
  db.close();
});

test('voucher migration enforces one redeemed voucher per account and card digest', () => {
  const db = fixtureDb();
  migrateVoucherTables(db);
  seedBatch(db);
  insertVoucher(db, {
    status: 'redeemed',
    reserved_by: 'user-1',
    reserved_until: 1_700_001_800_000,
    checkout_session_id: 'cs_1',
    redeemed_by: 'user-1',
    redeemed_at: 1_700_000_100_000,
    stripe_subscription_id: 'sub_1',
    card_fingerprint_digest: 'h1:card-1',
  });

  assert.throws(() => insertVoucher(db, {
    id: 'voucher-same-user',
    serial_number: 2,
    code_digest: 'h1:code-2',
    status: 'redeemed',
    reserved_by: 'user-1',
    reserved_until: 1_700_001_800_000,
    checkout_session_id: 'cs_2',
    redeemed_by: 'user-1',
    redeemed_at: 1_700_000_200_000,
    stripe_subscription_id: 'sub_2',
    card_fingerprint_digest: 'h1:card-2',
  }), /UNIQUE constraint failed/);

  assert.throws(() => insertVoucher(db, {
    id: 'voucher-same-card',
    serial_number: 3,
    code_digest: 'h1:code-3',
    status: 'redeemed',
    reserved_by: 'user-2',
    reserved_until: 1_700_001_800_000,
    checkout_session_id: 'cs_3',
    redeemed_by: 'user-2',
    redeemed_at: 1_700_000_300_000,
    stripe_subscription_id: 'sub_3',
    card_fingerprint_digest: 'h1:card-1',
  }), /UNIQUE constraint failed/);
  db.close();
});

test('voucher migration rejects fields that do not match the lifecycle state', () => {
  const db = fixtureDb();
  migrateVoucherTables(db);
  seedBatch(db);

  assert.throws(() => insertVoucher(db, {
    status: 'reserved',
    reserved_by: null,
    reserved_until: 1_700_001_800_000,
  }), /CHECK constraint failed/);
  assert.throws(() => insertVoucher(db, {
    id: 'voucher-stale-revocation',
    serial_number: 2,
    code_digest: 'h1:stale-revocation',
    status: 'revoked',
    reserved_by: 'user-1',
    reserved_until: 1_700_001_800_000,
    checkout_session_id: 'cs_stale',
    revoked_at: 1_700_000_100_000,
    revoked_by: 'admin-1',
  }), /CHECK constraint failed/);
  db.close();
});

test('voucher migration is idempotent and preserves existing rows', () => {
  const db = fixtureDb();
  migrateVoucherTables(db);
  seedBatch(db);
  insertVoucher(db);
  migrateVoucherTables(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM promotion_vouchers').get().count, 1);
  db.close();
});
