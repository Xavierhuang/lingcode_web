'use strict';

// backfill-tiers.js — one-time re-sync of users.tier from Stripe (the source of truth).
//
// Why: the webhook used to map EVERY paid subscription to 'pro', so customers who bought
// Max Pro got tier='pro' (Pro limits) despite paying. The webhook is now fixed, but existing
// subscribers won't self-heal until their next subscription event. This re-fetches each
// subscriber's live Stripe subscription and re-applies the (now-correct) tier mapping.
//
// Idempotent — safe to run repeatedly. Reads Stripe + the local data.db only.
//
//   node backfill-tiers.js           # DRY-RUN: print who would change + a summary
//   node backfill-tiers.js --apply   # actually write the corrected tiers
//
// Run it on the box that has data.db + the Stripe env (prod: /opt/lingcode-api).

const fs = require('fs');
const path = require('path');

// Minimal .env loader so STRIPE_SECRET_KEY + price IDs are present when run by hand
// (the systemd service gets them via EnvironmentFile; a manual `node` invocation needs this).
(function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch (_) { /* env may already be in the environment */ }
})();

const Database = require('better-sqlite3');
const Stripe = require('stripe');
const { tierFromSubscription, applySubscriptionToUser } = require('./stripe-sync');

const APPLY = process.argv.includes('--apply');

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY is not set — cannot reach Stripe. Aborting.');
  process.exit(1);
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const db = new Database(path.join(__dirname, 'data.db'));

(async () => {
  const users = db
    .prepare("SELECT id, email, tier, stripe_subscription_id, stripe_customer_id FROM users WHERE stripe_subscription_id IS NOT NULL AND stripe_subscription_id != ''")
    .all();

  console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} — ${users.length} user(s) with a Stripe subscription\n`);

  let changed = 0, unchanged = 0, errors = 0;
  for (const u of users) {
    let sub;
    try {
      sub = await stripe.subscriptions.retrieve(u.stripe_subscription_id);
    } catch (e) {
      errors++;
      console.log(`  !  ${u.email}  — could not retrieve ${u.stripe_subscription_id}: ${e.message} (left unchanged)`);
      continue;
    }
    const newTier = tierFromSubscription(sub);
    if (newTier === (u.tier || 'free')) { unchanged++; continue; }

    changed++;
    const priceId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id;
    console.log(`  ${APPLY ? 'FIX  ' : 'WOULD'} ${u.email}: ${u.tier || 'free'} → ${newTier}   (sub ${sub.status}, price ${priceId || '?'})`);
    if (APPLY) {
      applySubscriptionToUser(db, u.id, sub.customer || u.stripe_customer_id, sub);
    }
  }

  console.log(`\nSummary: ${changed} ${APPLY ? 'corrected' : 'to correct'}, ${unchanged} already correct, ${errors} error(s).`);
  if (!APPLY && changed > 0) console.log('Re-run with  --apply  to write these changes.');
})().catch((e) => { console.error('Backfill failed:', e); process.exit(1); });
