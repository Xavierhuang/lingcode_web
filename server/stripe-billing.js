'use strict';

/**
 * Cursor-style billing: Pro/Max-Pro × monthly/annual Stripe Price IDs, Checkout + Customer Portal.
 * @param {import('express').Application} app
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   stripe: import('stripe').Stripe | null,
 *   PUBLIC_ORIGIN: string,
 *   PRICE_PRO_MONTHLY: string | undefined,
 *   PRICE_PRO_ANNUAL: string | undefined,
 *   PRICE_MAX_PRO_MONTHLY: string | undefined,
 *   PRICE_MAX_PRO_ANNUAL: string | undefined
 * }} opts
 */
function registerBillingRoutes(app, opts) {
  const {
    db, stripe, PUBLIC_ORIGIN,
    PRICE_PRO_MONTHLY, PRICE_PRO_ANNUAL,
    PRICE_MAX_PRO_MONTHLY, PRICE_MAX_PRO_ANNUAL
  } = opts;

  function requireAccount(req, res, next) {
    const a = req.session && req.session.account;
    if (!a || !a.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.billingUserId = a.userId;
    next();
  }

  app.get('/api/billing/config', (req, res) => {
    res.json({
      ok: true,
      stripe: !!stripe,
      pro_monthly: !!PRICE_PRO_MONTHLY,
      pro_annual: !!PRICE_PRO_ANNUAL,
      max_pro_monthly: !!PRICE_MAX_PRO_MONTHLY,
      max_pro_annual: !!PRICE_MAX_PRO_ANNUAL
    });
  });

  app.post('/api/billing/checkout', requireAccount, async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe is not configured (STRIPE_SECRET_KEY).' });
    }
    const tier = String((req.body && req.body.tier) || 'pro').toLowerCase().replace(/-/g, '_');
    const interval = String((req.body && req.body.interval) || 'month').toLowerCase();
    const isAnnual = interval === 'year' || interval === 'annual';
    let priceId, envName;
    if (tier === 'max_pro' || tier === 'maxpro') {
      priceId = isAnnual ? PRICE_MAX_PRO_ANNUAL : PRICE_MAX_PRO_MONTHLY;
      envName = isAnnual ? 'STRIPE_PRICE_MAX_PRO_ANNUAL' : 'STRIPE_PRICE_MAX_PRO_MONTHLY';
    } else {
      priceId = isAnnual ? PRICE_PRO_ANNUAL : PRICE_PRO_MONTHLY;
      envName = isAnnual ? 'STRIPE_PRICE_PRO_ANNUAL' : 'STRIPE_PRICE_PRO_MONTHLY';
    }
    if (!priceId) {
      return res.status(503).json({ error: `Price not configured (${envName}).` });
    }
    const row = db.prepare('SELECT id, email, stripe_customer_id FROM users WHERE id = ?').get(req.billingUserId);
    if (!row) {
      return res.status(404).json({ error: 'User not found' });
    }
    try {
      /** @type {import('stripe').Stripe.Checkout.SessionCreateParams} */
      const params = {
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${PUBLIC_ORIGIN}/account.html?billing=success`,
        cancel_url: `${PUBLIC_ORIGIN}/account.html?billing=cancel`,
        client_reference_id: row.id,
        metadata: { user_id: row.id },
        subscription_data: {
          metadata: { user_id: row.id }
        }
      };
      if (row.stripe_customer_id) {
        params.customer = row.stripe_customer_id;
      } else {
        params.customer_email = row.email;
      }
      const session = await stripe.checkout.sessions.create(params);
      res.json({ ok: true, url: session.url });
    } catch (e) {
      console.error('checkout.sessions.create', e);
      res.status(500).json({ error: e.message || 'Checkout failed' });
    }
  });

  app.post('/api/billing/portal', requireAccount, async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe is not configured.' });
    }
    const row = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(req.billingUserId);
    if (!row || !row.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account yet. Subscribe to Pro first.' });
    }
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: row.stripe_customer_id,
        return_url: `${PUBLIC_ORIGIN}/account.html`
      });
      res.json({ ok: true, url: session.url });
    } catch (e) {
      console.error('billingPortal.sessions.create', e);
      res.status(500).json({ error: e.message || 'Portal failed' });
    }
  });
}

module.exports = { registerBillingRoutes };
