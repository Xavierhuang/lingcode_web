// Edge Function: Stripe checkout session.
// Deployed via /api/supabase/tools/add_stripe_checkout.
//
// Expects:
//   - STRIPE_SECRET_KEY  in the project's Edge Function secrets
//   - Body: { price_id: string, quantity?: number, success_url: string, cancel_url: string }
//
// Returns:
//   200 { id, url }            // Stripe checkout session, redirect the user to `url`
//   400 { error }              // missing or malformed input
//   500 { error }              // upstream Stripe error
//
// CORS is permissive by default so /try prototypes can call it from any
// origin. Tighten in production by replacing the '*' below.

import Stripe from 'https://esm.sh/stripe@17.4.0?target=deno';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');
if (!STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY missing — set via Supabase project Edge Function secrets.');
}
const stripe = new Stripe(STRIPE_SECRET_KEY ?? '', {
  apiVersion: '2024-11-20.acacia',
  httpClient: Stripe.createFetchHttpClient(),
});

const corsHeaders: HeadersInit = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!STRIPE_SECRET_KEY) return json({ error: 'stripe_not_configured' }, 503);

  let body: { price_id?: string; quantity?: number; success_url?: string; cancel_url?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const priceId = body.price_id;
  const quantity = Math.max(1, Math.floor(Number(body.quantity ?? 1)));
  const successUrl = body.success_url;
  const cancelUrl = body.cancel_url;
  if (!priceId || !successUrl || !cancelUrl) {
    return json({ error: 'missing_required', required: ['price_id', 'success_url', 'cancel_url'] }, 400);
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity }],
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    return json({ id: session.id, url: session.url }, 200);
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    return json({ error: 'stripe_error', message: e.message }, e.statusCode ?? 500);
  }
});

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });
}
