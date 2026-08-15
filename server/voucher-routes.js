'use strict';

const { createVoucherLimiter } = require('./voucher-rate-limit');
const {
  prepareVoucherBatch,
  insertPreparedBatch,
  reserveVoucher,
  bindCheckoutSession,
  releaseReservation,
  voucherStatusForUser,
  revokeVoucher,
  revokeBatch,
  batchSummary,
  recordVoucherAudit,
} = require('./vouchers');
const { createVoucherZip } = require('./voucher-artifacts');

const VOUCHER_TERMS_VERSION = 'voucher-terms-2026-08-09';
const UNAVAILABLE = Object.freeze({ error: 'voucher_unavailable' });

function voucherConfigFromEnv(env = process.env) {
  if (env.VOUCHERS_ENABLED !== '1') return { enabled: false };
  const hmacSecret = String(env.LINGCODE_VOUCHER_HMAC_SECRET || '');
  const proMonthlyPriceId = String(env.STRIPE_PRICE_PRO_MONTHLY || '').trim();
  if (Buffer.byteLength(hmacSecret) < 32 || !proMonthlyPriceId) return { enabled: false };
  return { enabled: true, hmacSecret, proMonthlyPriceId };
}

function registerVoucherRoutes(app, options) {
  const db = options.db;
  const stripe = options.stripe;
  const publicOrigin = String(options.publicOrigin || '').replace(/\/$/, '');
  const proMonthlyPriceId = String(options.proMonthlyPriceId || '').trim();
  const hmacSecret = options.hmacSecret;
  const enabled = options.enabled === true
    && stripe != null
    && publicOrigin.length > 0
    && proMonthlyPriceId.length > 0
    && (typeof hmacSecret === 'string' || Buffer.isBuffer(hmacSecret))
    && Buffer.byteLength(hmacSecret) >= 32;
  const limiter = options.limiter || createVoucherLimiter();
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const logger = options.logger || console;
  const requireAdmin = options.requireAdmin;
  const createArtifact = options.createArtifact || createVoucherZip;

  function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private');
    next();
  }

  function browserUser(req) {
    const userId = req.session && req.session.account && req.session.account.userId;
    if (!userId) return null;
    return db.prepare(`
      SELECT id, email, tier, email_verified, subscription_status, stripe_customer_id
      FROM users WHERE id = ?
    `).get(userId) || null;
  }

  app.post('/api/vouchers/checkout', noStore, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'service_unavailable' });
    const user = browserUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    if (Number(user.email_verified) !== 1) return res.status(403).json({ error: 'email_verification_required' });
    if (!req.body || req.body.renewalAcknowledged !== true) {
      return res.status(400).json({ error: 'renewal_acknowledgment_required' });
    }

    const attempt = { account: user.id, ip: req.ip, now: clock() };
    const allowed = limiter.check(attempt);
    if (!allowed.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(allowed.retryAfterMs / 1000))));
      return res.status(429).json(UNAVAILABLE);
    }

    const now = clock();
    const reservation = reserveVoucher(db, {
      code: req.body.code,
      user,
      termsVersion: VOUCHER_TERMS_VERSION,
      termsAcceptedAt: now,
    }, { secret: hmacSecret, now });
    if (!reservation.ok) {
      if (reservation.error === 'unverified') {
        return res.status(403).json({ error: 'email_verification_required' });
      }
      if (reservation.error === 'ineligible') {
        return res.status(409).json({ error: 'voucher_ineligible' });
      }
      limiter.fail(attempt);
      return res.status(400).json(UNAVAILABLE);
    }

    const metadata = {
      flow: 'promotion_voucher',
      voucher_id: reservation.voucher.id,
      batch_id: reservation.voucher.batchId,
      user_id: user.id,
    };
    const params = {
      mode: 'subscription',
      line_items: [{ price: proMonthlyPriceId, quantity: 1 }],
      payment_method_collection: 'always',
      success_url: `${publicOrigin}/redeem/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${publicOrigin}/redeem/?canceled=1`,
      client_reference_id: user.id,
      expires_at: Math.floor(reservation.voucher.reservedUntil / 1000),
      metadata,
      subscription_data: { trial_period_days: 30, metadata: { ...metadata } },
    };
    if (user.stripe_customer_id) params.customer = user.stripe_customer_id;
    else params.customer_email = user.email;

    let session;
    try {
      session = await stripe.checkout.sessions.create(params);
    } catch (error) {
      releaseReservation(db, {
        voucherId: reservation.voucher.id,
        userId: user.id,
        creationFailed: true,
      }, { now: clock() });
      logger.error('voucher checkout: Stripe Session creation failed', error && error.message);
      return res.status(502).json({ error: 'checkout_unavailable' });
    }

    const bound = bindCheckoutSession(db, {
      voucherId: reservation.voucher.id,
      userId: user.id,
      checkoutSessionId: session.id,
    }, { now: clock() });
    if (!bound) {
      try {
        const expired = await stripe.checkout.sessions.expire(session.id);
        releaseReservation(db, {
          voucherId: reservation.voucher.id,
          userId: user.id,
          checkoutSessionId: session.id,
          checkoutStatus: expired.status,
        }, { now: clock() });
      } catch (error) {
        logger.error('voucher checkout: failed to expire unbound Session', error && error.message);
      }
      return res.status(409).json({ error: 'checkout_unavailable' });
    }
    limiter.success({ account: user.id });
    return res.json({ ok: true, url: session.url });
  });

  app.get('/api/vouchers/status/:sessionId', noStore, (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'service_unavailable' });
    const user = browserUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    const status = voucherStatusForUser(db, {
      checkoutSessionId: req.params.sessionId,
      userId: user.id,
    });
    if (!status) return res.status(404).json({ error: 'not_found' });
    return res.json({ status });
  });

  if (typeof requireAdmin !== 'function') return;

  function requireSameOrigin(req, res, next) {
    if (req.get('origin') !== publicOrigin) return res.status(403).json({ error: 'forbidden_origin' });
    next();
  }

  function adminActor(req) {
    return String((req.session && req.session.adminUserId) || 'admin');
  }

  app.get('/api/admin/vouchers/batches', noStore, requireAdmin, (_req, res) => {
    const rows = db.prepare('SELECT id FROM voucher_batches ORDER BY created_at DESC').all();
    res.json({ batches: rows.map((row) => batchSummary(db, row.id)) });
  });

  app.get('/api/admin/vouchers/batches/:batchId', noStore, requireAdmin, (req, res) => {
    const batch = batchSummary(db, req.params.batchId);
    if (!batch) return res.status(404).json({ error: 'not_found' });
    const vouchers = db.prepare(`
      SELECT id, serial_number, display_suffix, status, reserved_until,
             checkout_session_id, redeemed_at, blocked_reason, revoked_at
      FROM promotion_vouchers WHERE batch_id = ? ORDER BY serial_number
    `).all(req.params.batchId).map((row) => ({
      id: row.id,
      serialNumber: row.serial_number,
      displaySuffix: row.display_suffix,
      status: row.status,
      reservedUntil: row.reserved_until,
      checkoutSessionBound: Boolean(row.checkout_session_id),
      redeemedAt: row.redeemed_at,
      blockedReason: row.blocked_reason,
      revokedAt: row.revoked_at,
    }));
    return res.json({ batch, vouchers });
  });

  app.post('/api/admin/vouchers/batches', noStore, requireAdmin, requireSameOrigin, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'voucher_issuance_disabled' });
    const body = req.body || {};
    const quantity = Number(body.quantity);
    const benefitDays = Number(body.benefitDays);
    const redeemBy = Number(body.redeemBy);
    if (!Number.isInteger(quantity)
      || quantity < 1
      || quantity > 500
      || benefitDays !== 30
      || !Number.isFinite(redeemBy)
      || redeemBy <= clock()
      || body.confirmation !== `CREATE ${quantity} VOUCHERS`) {
      return res.status(400).json({ error: 'invalid_batch_request' });
    }

    let prepared;
    try {
      prepared = prepareVoucherBatch({
        name: body.name,
        quantity,
        benefitDays,
        redeemBy,
        createdBy: adminActor(req),
      }, { secret: hmacSecret, now: clock() });
      const zip = await createArtifact({
        batch: prepared.batch,
        codes: prepared.codes,
        redeemUrl: `${publicOrigin}/redeem/`,
        termsUrl: `${publicOrigin}/voucher-terms/`,
      });
      insertPreparedBatch(db, prepared, {
        afterInsert: () => recordVoucherAudit(db, {
          batchId: prepared.batch.id,
          actorUserId: adminActor(req),
          eventType: 'batch_created',
          createdAt: clock(),
          metadata: {
            quantity,
            benefit_days: benefitDays,
            redeem_by: redeemBy,
          },
        }),
      });
      res.status(201);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="LingCode-Pro-Vouchers-${prepared.batch.id}.zip"`);
      return res.send(zip);
    } catch (error) {
      logger.error('voucher admin: batch creation failed', error && error.message);
      return res.status(error && String(error.code || '').startsWith('invalid_') ? 400 : 500)
        .json({ error: 'batch_creation_failed' });
    } finally {
      if (prepared && Array.isArray(prepared.codes)) {
        for (const item of prepared.codes) item.code = '';
        prepared.codes.length = 0;
      }
    }
  });

  app.post('/api/admin/vouchers/batches/:batchId/revoke', noStore, requireAdmin, requireSameOrigin, (req, res) => {
    if (!req.body || req.body.confirmation !== 'REVOKE BATCH') {
      return res.status(400).json({ error: 'confirmation_required' });
    }
    if (!batchSummary(db, req.params.batchId)) return res.status(404).json({ error: 'not_found' });
    const revoked = revokeBatch(db, {
      batchId: req.params.batchId,
      actorUserId: adminActor(req),
    }, { now: clock() });
    return res.json({ ok: true, revoked });
  });

  app.post('/api/admin/vouchers/:voucherId/revoke', noStore, requireAdmin, requireSameOrigin, (req, res) => {
    if (!req.body || req.body.confirmation !== 'REVOKE VOUCHER') {
      return res.status(400).json({ error: 'confirmation_required' });
    }
    const ok = revokeVoucher(db, {
      voucherId: req.params.voucherId,
      actorUserId: adminActor(req),
    }, { now: clock() });
    return ok ? res.json({ ok: true }) : res.status(409).json({ error: 'voucher_not_revocable' });
  });

  app.post('/api/admin/vouchers/:voucherId/release', noStore, requireAdmin, requireSameOrigin, async (req, res) => {
    if (!req.body || req.body.confirmation !== 'RELEASE RESERVATION') {
      return res.status(400).json({ error: 'confirmation_required' });
    }
    const voucher = db.prepare(`
      SELECT id, status, reserved_by, checkout_session_id FROM promotion_vouchers WHERE id = ?
    `).get(req.params.voucherId);
    if (!voucher) return res.status(404).json({ error: 'not_found' });
    if (voucher.status !== 'reserved') return res.status(409).json({ error: 'voucher_not_reserved' });
    let checkoutStatus;
    if (voucher.checkout_session_id) {
      if (!stripe) return res.status(503).json({ error: 'stripe_unavailable' });
      try {
        const session = await stripe.checkout.sessions.retrieve(voucher.checkout_session_id);
        checkoutStatus = session.status;
      } catch (error) {
        logger.error('voucher admin: Checkout status lookup failed', error && error.message);
        return res.status(502).json({ error: 'checkout_status_unavailable' });
      }
      if (checkoutStatus !== 'expired') {
        return res.status(409).json({ error: 'checkout_not_expired' });
      }
    }
    const ok = releaseReservation(db, {
      voucherId: voucher.id,
      userId: voucher.reserved_by,
      actorUserId: adminActor(req),
      checkoutSessionId: voucher.checkout_session_id,
      checkoutStatus,
    }, { now: clock() });
    return ok ? res.json({ ok: true }) : res.status(409).json({ error: 'reservation_not_released' });
  });
}

module.exports = { registerVoucherRoutes, voucherConfigFromEnv, VOUCHER_TERMS_VERSION };
