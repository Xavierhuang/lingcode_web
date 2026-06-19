'use strict';

/**
 * Local check: STRIPE_SECRET_KEY + Price IDs (no secrets printed).
 * Run from website/server: npm run stripe-verify
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const Stripe = require('stripe');

async function main() {
  const sk = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!sk) {
    console.error('Missing STRIPE_SECRET_KEY in .env');
    process.exit(1);
  }

  const stripe = new Stripe(sk);
  const mode = sk.startsWith('sk_live_') ? 'live' : sk.startsWith('sk_test_') ? 'test' : 'unknown';
  console.log('Stripe API key mode:', mode);

  try {
    const bal = await stripe.balance.retrieve();
    const avail = bal.available && bal.available[0];
    console.log(
      'API key OK. Balance available:',
      avail ? avail.amount / 100 + ' ' + String(avail.currency).toUpperCase() : '(none)'
    );
  } catch (e) {
    console.error('API request failed (invalid key or network):', e.message);
    process.exit(1);
  }

  const monthly = (process.env.STRIPE_PRICE_PRO_MONTHLY || '').trim();
  const annual = (process.env.STRIPE_PRICE_PRO_ANNUAL || '').trim();

  for (const [label, id] of [
    ['STRIPE_PRICE_PRO_MONTHLY', monthly],
    ['STRIPE_PRICE_PRO_ANNUAL', annual]
  ]) {
    if (!id) {
      console.log(label + ': (not set)');
      continue;
    }
    try {
      const p = await stripe.prices.retrieve(id);
      const active = p.active ? 'active' : 'inactive';
      const rec = p.recurring;
      const interval = rec ? `${rec.interval_count || 1} ${rec.interval}(s)` : 'one-time';
      console.log(label + ': OK', p.id, active, interval, p.unit_amount != null ? (p.unit_amount / 100).toFixed(2) + ' ' + String(p.currency).toUpperCase() : '');
    } catch (e) {
      console.error(label + ': FAILED —', e.message);
      process.exitCode = 1;
    }
  }

  const wh = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  console.log('STRIPE_WEBHOOK_SECRET:', wh ? 'set (length ' + wh.length + ')' : '(not set — add after creating webhook endpoint)');

  if (process.exitCode === 1) {
    console.error('\nFix Price IDs in Stripe Dashboard → Products, or .env.');
  } else {
    console.log('\nNext: Dashboard → Developers → Webhooks → add https://YOUR_DOMAIN/api/stripe/webhook');
    console.log('Events: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted, customer.deleted');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
