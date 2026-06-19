'use strict';

/** Set of configured Max Pro price IDs (monthly + annual). Empty if not configured. */
function maxProPriceIds() {
  return new Set(
    [process.env.STRIPE_PRICE_MAX_PRO_MONTHLY, process.env.STRIPE_PRICE_MAX_PRO_ANNUAL].filter(Boolean)
  );
}

/**
 * Map Stripe subscription to LingCode tier. A paid (active/trialing/past_due) subscription is
 * `max_pro` when ANY of its line items is on a configured Max Pro price, else `pro`. If the Max
 * Pro price env vars aren't set, this safely degrades to the old `pro`-for-everything behavior.
 * @param {import('stripe').Stripe.Subscription} subscription
 */
function tierFromSubscription(subscription) {
  const s = subscription.status;
  if (s !== 'active' && s !== 'trialing' && s !== 'past_due') {
    return 'free';
  }
  const maxPro = maxProPriceIds();
  if (maxPro.size) {
    const items = (subscription.items && subscription.items.data) || [];
    for (const it of items) {
      const priceId = it && it.price && it.price.id;
      if (priceId && maxPro.has(priceId)) {
        return 'max_pro';
      }
    }
  }
  return 'pro';
}

/**
 * Bytes of à-la-carte storage the subscription has purchased (Model B): the total
 * quantity across all line items on the configured storage add-on price ×
 * STORAGE_ADDON_BLOCK_BYTES. 0 if the add-on price isn't configured, the sub
 * isn't paid, or no add-on units are present — so this safely no-ops until the
 * Stripe product exists. The bytes stack on top of the tier's maxStorageBytes.
 * @param {import('stripe').Stripe.Subscription} subscription
 */
function purchasedStorageBytesFromSubscription(subscription) {
  const priceId = process.env.STRIPE_PRICE_STORAGE_ADDON;
  if (!priceId) return 0;
  const s = subscription.status;
  if (s !== 'active' && s !== 'trialing' && s !== 'past_due') return 0;
  const blockBytes = Number(process.env.STORAGE_ADDON_BLOCK_BYTES || 100 * 1024 * 1024 * 1024); // default 100 GB/unit
  let units = 0;
  const items = (subscription.items && subscription.items.data) || [];
  for (const it of items) {
    if (it && it.price && it.price.id === priceId) units += (it.quantity || 0);
  }
  return units * blockBytes;
}

function intervalFromSubscription(subscription) {
  const item = subscription.items && subscription.items.data && subscription.items.data[0];
  const interval = item && item.price && item.price.recurring && item.price.recurring.interval;
  return interval === 'year' || interval === 'month' ? interval : null;
}

function periodEndISO(subscription) {
  if (subscription.current_period_end) {
    return new Date(subscription.current_period_end * 1000).toISOString();
  }
  return null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {string|null} customerId
 * @param {import('stripe').Stripe.Subscription} subscription
 */
function applySubscriptionToUser(db, userId, customerId, subscription) {
  const tier = tierFromSubscription(subscription);
  const status = subscription.status;
  const subId = subscription.id;
  const periodEnd = periodEndISO(subscription);
  const interval = intervalFromSubscription(subscription);
  const purchasedStorage = purchasedStorageBytesFromSubscription(subscription);

  db.prepare(
    `UPDATE users SET
      stripe_customer_id = COALESCE(?, stripe_customer_id),
      stripe_subscription_id = ?,
      subscription_status = ?,
      subscription_current_period_end = ?,
      billing_interval = ?,
      tier = ?,
      purchased_storage_bytes = ?
    WHERE id = ?`
  ).run(
    customerId,
    subId,
    status,
    periodEnd,
    interval,
    tier,
    purchasedStorage,
    userId
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} customerId
 */
function clearSubscriptionByCustomer(db, customerId) {
  const row = db.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(customerId);
  if (!row) {
    return;
  }
  db.prepare(
    `UPDATE users SET
      stripe_subscription_id = NULL,
      subscription_status = 'canceled',
      subscription_current_period_end = NULL,
      billing_interval = NULL,
      tier = 'free',
      purchased_storage_bytes = 0
    WHERE id = ?`
  ).run(row.id);
}

module.exports = {
  tierFromSubscription,
  purchasedStorageBytesFromSubscription,
  applySubscriptionToUser,
  clearSubscriptionByCustomer,
  intervalFromSubscription,
  periodEndISO
};
