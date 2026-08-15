'use strict';

const crypto = require('crypto');

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_SYMBOLS = 16;
const MAX_BATCH_SIZE = 500;
const RESERVATION_MS = 30 * 60 * 1000;
const PAID_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

function voucherError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeVoucherCode(raw) {
  if (typeof raw !== 'string') throw voucherError('invalid_voucher_code');
  const normalized = raw.trim().toUpperCase().replaceAll('-', '');
  if (!/^LCPRO[2-9A-HJ-NP-Z]{16}$/.test(normalized)) {
    throw voucherError('invalid_voucher_code');
  }
  return normalized;
}

function generateVoucherCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(CODE_SYMBOLS);
  if (!Buffer.isBuffer(bytes) || bytes.length < CODE_SYMBOLS) {
    throw voucherError('invalid_random_source');
  }
  let symbols = '';
  for (let i = 0; i < CODE_SYMBOLS; i += 1) {
    symbols += ALPHABET[bytes[i] & 31];
  }
  return `LC-PRO-${symbols.slice(0, 4)}-${symbols.slice(4, 8)}-${symbols.slice(8, 12)}-${symbols.slice(12, 16)}`;
}

function hmacDigest(domain, value, secret) {
  if (typeof secret !== 'string' && !Buffer.isBuffer(secret)) {
    throw voucherError('invalid_voucher_secret');
  }
  if (Buffer.byteLength(secret) === 0) throw voucherError('invalid_voucher_secret');
  return `h1:${crypto.createHmac('sha256', secret).update(`${domain}:h1\0${value}`).digest('hex')}`;
}

function digestVoucherCode(raw, secret) {
  return hmacDigest('voucher-code', normalizeVoucherCode(raw), secret);
}

function digestCardFingerprint(raw, secret) {
  if (typeof raw !== 'string' || !raw.trim()) throw voucherError('invalid_card_fingerprint');
  return hmacDigest('stripe-card-fingerprint', raw.trim(), secret);
}

function prepareVoucherBatch(input, options = {}) {
  const now = Number(options.now == null ? Date.now() : options.now);
  const quantity = Number(input && input.quantity);
  const benefitDays = Number(input && input.benefitDays);
  const redeemBy = Number(input && input.redeemBy);
  const name = typeof (input && input.name) === 'string' ? input.name.trim() : '';
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_BATCH_SIZE) {
    throw voucherError('invalid_quantity');
  }
  if (!Number.isInteger(benefitDays) || benefitDays < 1) {
    throw voucherError('invalid_benefit_days');
  }
  if (!Number.isFinite(redeemBy) || redeemBy <= now) {
    throw voucherError('invalid_redeem_by');
  }
  if (!name) throw voucherError('invalid_batch_name');

  const secret = options.secret;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const batch = {
    id: randomUUID(),
    name,
    quantity,
    benefitDays,
    redeemBy,
    status: 'active',
    createdBy: input.createdBy || null,
    createdAt: now,
  };
  const codes = [];
  const storedRows = [];
  const digests = new Set();

  for (let serialNumber = 1; serialNumber <= quantity; serialNumber += 1) {
    let code;
    let codeDigest;
    let attempts = 0;
    do {
      if (attempts >= 32) throw voucherError('voucher_code_collision_limit');
      code = generateVoucherCode(randomBytes);
      codeDigest = digestVoucherCode(code, secret);
      attempts += 1;
    } while (digests.has(codeDigest));
    digests.add(codeDigest);
    codes.push({ serialNumber, code });
    storedRows.push({
      id: randomUUID(),
      batchId: batch.id,
      serialNumber,
      digestVersion: 'h1',
      codeDigest,
      displaySuffix: normalizeVoucherCode(code).slice(-4),
      status: 'available',
      createdAt: now,
    });
  }

  return { batch, codes, storedRows };
}

function insertPreparedBatch(db, prepared, options = {}) {
  const insertBatch = db.prepare(`
    INSERT INTO voucher_batches
      (id, name, quantity, benefit_days, redeem_by, status, created_by, created_at)
    VALUES
      (@id, @name, @quantity, @benefitDays, @redeemBy, @status, @createdBy, @createdAt)
  `);
  const insertVoucher = db.prepare(`
    INSERT INTO promotion_vouchers
      (id, batch_id, serial_number, digest_version, code_digest, display_suffix, status, created_at)
    VALUES
      (@id, @batchId, @serialNumber, @digestVersion, @codeDigest, @displaySuffix, @status, @createdAt)
  `);
  db.transaction(() => {
    insertBatch.run(prepared.batch);
    for (const row of prepared.storedRows) insertVoucher.run(row);
    if (typeof options.afterInsert === 'function') options.afterInsert();
  }).immediate();
  return { batch: { ...prepared.batch } };
}

function audit(db, input, options = {}) {
  const randomUUID = options.randomUUID || crypto.randomUUID;
  db.prepare(`
    INSERT INTO voucher_audit_events
      (id, voucher_id, batch_id, actor_user_id, event_type, reason_code, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    input.voucherId || null,
    input.batchId || null,
    input.actorUserId || null,
    input.eventType,
    input.reasonCode || null,
    JSON.stringify(input.metadata || {}),
    input.createdAt
  );
}

function safeReservedVoucher(row) {
  return {
    id: row.id,
    batchId: row.batch_id,
    serialNumber: row.serial_number,
    benefitDays: row.benefit_days,
    reservedUntil: row.reserved_until,
  };
}

function accountEligible(db, user) {
  if (!user || !user.id) return { ok: false, error: 'unauthorized' };
  if (Number(user.email_verified) !== 1) return { ok: false, error: 'unverified' };
  if (user.tier !== 'free' || PAID_STATUSES.has(String(user.subscription_status || '').toLowerCase())) {
    return { ok: false, error: 'ineligible' };
  }
  const redeemed = db.prepare(
    "SELECT 1 FROM promotion_vouchers WHERE redeemed_by = ? AND status = 'redeemed' LIMIT 1"
  ).get(user.id);
  return redeemed ? { ok: false, error: 'ineligible' } : { ok: true };
}

function reserveVoucher(db, input, options = {}) {
  const now = Number(options.now == null ? Date.now() : options.now);
  const reservationMs = Number(options.reservationMs || RESERVATION_MS);
  let codeDigest;
  try {
    codeDigest = digestVoucherCode(input && input.code, options.secret);
  } catch (_) {
    return { ok: false, error: 'unavailable' };
  }

  return db.transaction(() => {
    const eligibility = accountEligible(db, input.user);
    if (!eligibility.ok) return eligibility;

    let row = db.prepare(`
      SELECT v.*, b.status AS batch_status, b.redeem_by, b.benefit_days
      FROM promotion_vouchers v
      JOIN voucher_batches b ON b.id = v.batch_id
      WHERE v.code_digest = ?
    `).get(codeDigest);
    if (!row) return { ok: false, error: 'unavailable' };

    if (row.status === 'reserved'
      && row.reserved_by === input.user.id
      && row.reserved_until > now) {
      return { ok: true, idempotent: true, voucher: safeReservedVoucher(row) };
    }

    if (row.status === 'reserved'
      && row.reserved_until <= now
      && row.checkout_session_id == null) {
      db.prepare(`
        UPDATE promotion_vouchers
        SET status = 'available', reserved_by = NULL, reserved_until = NULL
        WHERE id = ? AND status = 'reserved' AND checkout_session_id IS NULL AND reserved_until <= ?
      `).run(row.id, now);
      row = db.prepare(`
        SELECT v.*, b.status AS batch_status, b.redeem_by, b.benefit_days
        FROM promotion_vouchers v
        JOIN voucher_batches b ON b.id = v.batch_id
        WHERE v.id = ?
      `).get(row.id);
    }

    if (row.status !== 'available' || row.batch_status !== 'active' || row.redeem_by <= now) {
      return { ok: false, error: 'unavailable' };
    }
    const reservedUntil = now + reservationMs;
    const changed = db.prepare(`
      UPDATE promotion_vouchers
      SET status = 'reserved', reserved_by = ?, reserved_until = ?
      WHERE id = ? AND status = 'available'
    `).run(input.user.id, reservedUntil, row.id).changes;
    if (changed !== 1) return { ok: false, error: 'unavailable' };
    audit(db, {
      voucherId: row.id,
      batchId: row.batch_id,
      actorUserId: input.user.id,
      eventType: 'reserved',
      createdAt: now,
      metadata: {
        reserved_until: reservedUntil,
        ...(input.termsVersion ? {
          terms_version: input.termsVersion,
          terms_accepted_at: Number(input.termsAcceptedAt || now),
        } : {}),
      },
    }, options);
    row.status = 'reserved';
    row.reserved_by = input.user.id;
    row.reserved_until = reservedUntil;
    return { ok: true, idempotent: false, voucher: safeReservedVoucher(row) };
  }).immediate();
}

function bindCheckoutSession(db, input, options = {}) {
  const now = Number(options.now == null ? Date.now() : options.now);
  try {
    return db.transaction(() => {
      const row = db.prepare('SELECT * FROM promotion_vouchers WHERE id = ?').get(input.voucherId);
      if (!row || row.status !== 'reserved' || row.reserved_by !== input.userId) return false;
      if (row.checkout_session_id != null) return row.checkout_session_id === input.checkoutSessionId;
      const changed = db.prepare(`
        UPDATE promotion_vouchers SET checkout_session_id = ?
        WHERE id = ? AND status = 'reserved' AND reserved_by = ? AND checkout_session_id IS NULL
      `).run(input.checkoutSessionId, input.voucherId, input.userId).changes;
      if (changed !== 1) return false;
      audit(db, {
        voucherId: row.id,
        batchId: row.batch_id,
        actorUserId: input.userId,
        eventType: 'checkout_bound',
        createdAt: now,
        metadata: { checkout_session_id: input.checkoutSessionId },
      }, options);
      return true;
    }).immediate();
  } catch (error) {
    if (error && error.code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
    throw error;
  }
}

function releaseReservation(db, input, options = {}) {
  const now = Number(options.now == null ? Date.now() : options.now);
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM promotion_vouchers WHERE id = ?').get(input.voucherId);
    if (!row || row.status !== 'reserved') return false;
    if (input.userId && row.reserved_by !== input.userId) return false;
    if (row.checkout_session_id) {
      if (input.checkoutSessionId !== row.checkout_session_id || input.checkoutStatus !== 'expired') return false;
    } else if (row.reserved_until > now && input.creationFailed !== true) {
      return false;
    }
    const changed = db.prepare(`
      UPDATE promotion_vouchers
      SET status = 'available', reserved_by = NULL, reserved_until = NULL, checkout_session_id = NULL
      WHERE id = ? AND status = 'reserved'
    `).run(row.id).changes;
    if (changed !== 1) return false;
    audit(db, {
      voucherId: row.id,
      batchId: row.batch_id,
      actorUserId: input.actorUserId || input.userId || null,
      eventType: 'reservation_released',
      reasonCode: row.checkout_session_id
        ? 'checkout_expired'
        : (input.creationFailed === true ? 'checkout_creation_failed' : 'reservation_expired'),
      createdAt: now,
    }, options);
    return true;
  }).immediate();
}

function finalizeRedemption(db, input, options = {}) {
  const now = Number(options.now == null ? Date.now() : options.now);
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM promotion_vouchers WHERE id = ?').get(input.voucherId);
    if (!row) return { ok: false, error: 'reservation_mismatch' };
    if (row.status === 'redeemed') {
      const exact = row.redeemed_by === input.userId
        && row.checkout_session_id === input.checkoutSessionId
        && row.stripe_subscription_id === input.subscriptionId
        && row.card_fingerprint_digest === input.cardFingerprintDigest;
      if (exact && typeof options.onFinalize === 'function') options.onFinalize();
      return exact
        ? { ok: true, idempotent: true }
        : { ok: false, error: 'redemption_mismatch' };
    }
    if (row.status !== 'reserved'
      || row.reserved_by !== input.userId
      || row.checkout_session_id !== input.checkoutSessionId) {
      return { ok: false, error: 'reservation_mismatch' };
    }
    if (!/^h1:[a-f0-9]{64}$/.test(String(input.cardFingerprintDigest || ''))) {
      return { ok: false, error: 'invalid_card_digest' };
    }
    if (db.prepare("SELECT 1 FROM promotion_vouchers WHERE status = 'redeemed' AND redeemed_by = ?").get(input.userId)) {
      return { ok: false, error: 'duplicate_account' };
    }
    if (db.prepare("SELECT 1 FROM promotion_vouchers WHERE status = 'redeemed' AND card_fingerprint_digest = ?").get(input.cardFingerprintDigest)) {
      return { ok: false, error: 'duplicate_card' };
    }
    const changed = db.prepare(`
      UPDATE promotion_vouchers
      SET status = 'redeemed', redeemed_by = ?, redeemed_at = ?,
          stripe_subscription_id = ?, card_fingerprint_digest = ?
      WHERE id = ? AND status = 'reserved' AND reserved_by = ? AND checkout_session_id = ?
    `).run(
      input.userId,
      now,
      input.subscriptionId,
      input.cardFingerprintDigest,
      row.id,
      input.userId,
      input.checkoutSessionId
    ).changes;
    if (changed !== 1) return { ok: false, error: 'reservation_mismatch' };
    if (typeof options.onFinalize === 'function') options.onFinalize();
    audit(db, {
      voucherId: row.id,
      batchId: row.batch_id,
      actorUserId: input.userId,
      eventType: 'redeemed',
      createdAt: now,
      metadata: {
        checkout_session_id: input.checkoutSessionId,
        stripe_subscription_id: input.subscriptionId,
      },
    }, options);
    return { ok: true, idempotent: false };
  }).immediate();
}

function blockRedemption(db, input, options = {}) {
  const now = Number(options.now == null ? Date.now() : options.now);
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM promotion_vouchers WHERE id = ?').get(input.voucherId);
    if (!row) return false;
    if (row.status === 'blocked') {
      return row.reserved_by === input.userId
        && row.checkout_session_id === input.checkoutSessionId
        && row.blocked_reason === input.reasonCode;
    }
    if (row.status !== 'reserved'
      || row.reserved_by !== input.userId
      || row.checkout_session_id !== input.checkoutSessionId
      || !input.reasonCode) return false;
    const changed = db.prepare(`
      UPDATE promotion_vouchers SET status = 'blocked', blocked_reason = ?
      WHERE id = ? AND status = 'reserved' AND reserved_by = ? AND checkout_session_id = ?
    `).run(input.reasonCode, row.id, input.userId, input.checkoutSessionId).changes;
    if (changed !== 1) return false;
    audit(db, {
      voucherId: row.id,
      batchId: row.batch_id,
      actorUserId: input.userId,
      eventType: 'blocked',
      reasonCode: input.reasonCode,
      createdAt: now,
    }, options);
    return true;
  }).immediate();
}

function revokeVoucher(db, input, options = {}) {
  const now = Number(options.now == null ? Date.now() : options.now);
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM promotion_vouchers WHERE id = ?').get(input.voucherId);
    if (!row) return false;
    if (row.status === 'revoked') return true;
    if (row.status !== 'available'
      && !(row.status === 'reserved' && input.checkoutStatus === 'expired')) return false;
    const changed = db.prepare(`
      UPDATE promotion_vouchers
      SET status = 'revoked', reserved_by = NULL, reserved_until = NULL,
          checkout_session_id = NULL, revoked_at = ?, revoked_by = ?
      WHERE id = ? AND status IN ('available','reserved')
    `).run(now, input.actorUserId, row.id).changes;
    if (changed !== 1) return false;
    audit(db, {
      voucherId: row.id,
      batchId: row.batch_id,
      actorUserId: input.actorUserId,
      eventType: 'revoked',
      createdAt: now,
    }, options);
    return true;
  }).immediate();
}

function revokeBatch(db, input, options = {}) {
  const now = Number(options.now == null ? Date.now() : options.now);
  return db.transaction(() => {
    const batch = db.prepare('SELECT * FROM voucher_batches WHERE id = ?').get(input.batchId);
    if (!batch) return 0;
    db.prepare("UPDATE voucher_batches SET status = 'revoked' WHERE id = ?").run(input.batchId);
    const changed = db.prepare(`
      UPDATE promotion_vouchers
      SET status = 'revoked', revoked_at = ?, revoked_by = ?
      WHERE batch_id = ? AND status = 'available'
    `).run(now, input.actorUserId, input.batchId).changes;
    audit(db, {
      batchId: input.batchId,
      actorUserId: input.actorUserId,
      eventType: 'batch_revoked',
      createdAt: now,
      metadata: { vouchers_revoked: changed },
    }, options);
    return changed;
  }).immediate();
}

function voucherStatusForUser(db, input) {
  const row = db.prepare(`
    SELECT status FROM promotion_vouchers
    WHERE checkout_session_id = ? AND reserved_by = ?
  `).get(input.checkoutSessionId, input.userId);
  if (!row) return null;
  if (row.status === 'reserved') return 'pending';
  if (row.status === 'redeemed') return 'active';
  if (row.status === 'blocked' || row.status === 'revoked') return 'blocked';
  return null;
}

function batchSummary(db, batchId) {
  const batch = db.prepare('SELECT * FROM voucher_batches WHERE id = ?').get(batchId);
  if (!batch) return null;
  const counts = { available: 0, reserved: 0, redeemed: 0, blocked: 0, revoked: 0 };
  for (const row of db.prepare(`
    SELECT status, COUNT(*) AS count FROM promotion_vouchers
    WHERE batch_id = ? GROUP BY status
  `).all(batchId)) {
    counts[row.status] = row.count;
  }
  return {
    id: batch.id,
    name: batch.name,
    quantity: batch.quantity,
    benefitDays: batch.benefit_days,
    redeemBy: batch.redeem_by,
    status: batch.status,
    createdBy: batch.created_by,
    createdAt: batch.created_at,
    counts,
  };
}

function recordVoucherAudit(db, input, options = {}) {
  audit(db, input, options);
}

module.exports = {
  ALPHABET,
  CODE_SYMBOLS,
  normalizeVoucherCode,
  generateVoucherCode,
  digestVoucherCode,
  digestCardFingerprint,
  prepareVoucherBatch,
  insertPreparedBatch,
  reserveVoucher,
  bindCheckoutSession,
  releaseReservation,
  finalizeRedemption,
  blockRedemption,
  revokeVoucher,
  revokeBatch,
  voucherStatusForUser,
  batchSummary,
  recordVoucherAudit,
};
