'use strict';

const { applySubscriptionToUser, clearSubscriptionByCustomer } = require('./stripe-sync');
const {
  digestCardFingerprint,
  finalizeRedemption,
  blockRedemption,
} = require('./vouchers');

const TRIAL_SECONDS = 30 * 24 * 60 * 60;
const TRIAL_TOLERANCE_SECONDS = 5 * 60;

function objectId(value) {
  return typeof value === 'string' ? value : value && value.id;
}

function metadataMatches(metadata, expected) {
  return metadata
    && metadata.flow === 'promotion_voucher'
    && metadata.voucher_id === expected.voucherId
    && metadata.batch_id === expected.batchId
    && metadata.user_id === expected.userId;
}

function validVoucherSubscription(subscription, expected, priceId) {
  if (!subscription || subscription.status !== 'trialing') return false;
  if (!metadataMatches(subscription.metadata, expected)) return false;
  const trialStart = Number(subscription.trial_start);
  const trialEnd = Number(subscription.trial_end);
  if (!Number.isFinite(trialStart) || !Number.isFinite(trialEnd)) return false;
  if (Math.abs((trialEnd - trialStart) - TRIAL_SECONDS) > TRIAL_TOLERANCE_SECONDS) return false;
  const items = subscription.items && subscription.items.data;
  if (!Array.isArray(items) || items.length !== 1) return false;
  const item = items[0];
  return item
    && Number(item.quantity || 0) === 1
    && item.price
    && item.price.id === priceId
    && item.price.recurring
    && item.price.recurring.interval === 'month';
}

async function cancelAndBlock(stripe, db, subscriptionId, reservation, session, reasonCode, now) {
  await stripe.subscriptions.cancel(subscriptionId);
  if (reservation) {
    blockRedemption(db, {
      voucherId: reservation.id,
      userId: reservation.reserved_by,
      checkoutSessionId: session.id,
      reasonCode,
    }, { now });
  }
  return { handled: true, status: 'blocked' };
}

/**
 * Verify and finalize a promotion-voucher Checkout Session. Returning
 * `handled: false` preserves the ordinary Checkout path.
 */
async function finalizeVoucherCheckout(stripe, db, session, options = {}) {
  if (!session.metadata || session.metadata.flow !== 'promotion_voucher') {
    return { handled: false, status: 'ignored' };
  }
  const now = typeof options.now === 'function' ? Number(options.now()) : Date.now();
  const subscriptionId = objectId(session.subscription);
  if (!subscriptionId || !options.hmacSecret || !options.proMonthlyPriceId) {
    throw new Error('Voucher webhook configuration or subscription is missing');
  }
  const reservation = db.prepare(
    'SELECT * FROM promotion_vouchers WHERE checkout_session_id = ?'
  ).get(session.id);
  const expected = reservation ? {
    voucherId: reservation.id,
    batchId: reservation.batch_id,
    userId: reservation.reserved_by,
  } : {
    voucherId: session.metadata.voucher_id,
    batchId: session.metadata.batch_id,
    userId: session.metadata.user_id,
  };
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['default_payment_method'],
  });
  const sessionMetadataValid = reservation
    && metadataMatches(session.metadata, expected)
    && session.client_reference_id === expected.userId;
  if (!sessionMetadataValid || !validVoucherSubscription(subscription, expected, options.proMonthlyPriceId)) {
    return cancelAndBlock(
      stripe,
      db,
      subscriptionId,
      reservation,
      session,
      sessionMetadataValid ? 'invalid_subscription' : 'metadata_mismatch',
      now
    );
  }
  const paymentMethod = subscription.default_payment_method;
  const fingerprint = paymentMethod && paymentMethod.card && paymentMethod.card.fingerprint;
  if (!fingerprint) {
    return cancelAndBlock(stripe, db, subscriptionId, reservation, session, 'missing_card_fingerprint', now);
  }
  const cardFingerprintDigest = digestCardFingerprint(fingerprint, options.hmacSecret);
  const customerId = objectId(session.customer) || objectId(subscription.customer) || null;
  const result = finalizeRedemption(db, {
    voucherId: expected.voucherId,
    userId: expected.userId,
    checkoutSessionId: session.id,
    subscriptionId,
    cardFingerprintDigest,
  }, {
    now,
    onFinalize: () => applySubscriptionToUser(db, expected.userId, customerId, subscription),
  });
  if (result.ok) return { handled: true, status: 'active' };
  if (result.error === 'duplicate_account' || result.error === 'duplicate_card') {
    return cancelAndBlock(stripe, db, subscriptionId, reservation, session, result.error, now);
  }
  return cancelAndBlock(stripe, db, subscriptionId, reservation, session, 'reservation_mismatch', now);
}

/**
 * @param {import('stripe').Stripe} stripe
 * @param {import('better-sqlite3').Database} db
 * @param {import('stripe').Stripe.Event} event
 */
async function handleStripeEvent(stripe, db, event, options = {}) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const voucherResult = await finalizeVoucherCheckout(stripe, db, session, options);
      if (voucherResult.handled) break;
      const userId = session.client_reference_id || (session.metadata && session.metadata.user_id);
      const customerId = typeof session.customer === 'string' ? session.customer : session.customer && session.customer.id;
      const subscriptionId =
        typeof session.subscription === 'string' ? session.subscription : session.subscription && session.subscription.id;
      if (!userId || !subscriptionId) {
        console.warn('stripe webhook: checkout.session.completed missing user or subscription');
        return;
      }
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      applySubscriptionToUser(db, userId, customerId, sub);
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const customerId =
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer && subscription.customer.id;
      if (!customerId) {
        break;
      }
      const row = db.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(customerId);
      if (!row) {
        console.warn('stripe webhook: no user for customer', customerId);
        break;
      }
      if (event.type === 'customer.subscription.deleted' || subscription.status === 'canceled') {
        db.prepare(
          `UPDATE users SET
            stripe_subscription_id = NULL,
            subscription_status = ?,
            subscription_current_period_end = NULL,
            billing_interval = NULL,
            tier = 'free',
            purchased_storage_bytes = 0
          WHERE id = ? AND stripe_subscription_id = ?`
        ).run(subscription.status || 'canceled', row.id, subscription.id);
        break;
      }
      applySubscriptionToUser(db, row.id, customerId, subscription);
      break;
    }
    case 'customer.deleted': {
      const customer = event.data.object;
      const customerId = customer.id;
      clearSubscriptionByCustomer(db, customerId);
      db.prepare(
        `UPDATE users SET stripe_customer_id = NULL WHERE stripe_customer_id = ?`
      ).run(customerId);
      break;
    }
    default:
      break;
  }
}

module.exports = { handleStripeEvent, finalizeVoucherCheckout, validVoucherSubscription };
