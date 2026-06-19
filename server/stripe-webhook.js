'use strict';

const { applySubscriptionToUser, clearSubscriptionByCustomer } = require('./stripe-sync');

/**
 * @param {import('stripe').Stripe} stripe
 * @param {import('better-sqlite3').Database} db
 * @param {import('stripe').Stripe.Event} event
 */
async function handleStripeEvent(stripe, db, event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
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
            tier = 'free'
          WHERE id = ?`
        ).run(subscription.status || 'canceled', row.id);
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

module.exports = { handleStripeEvent };
