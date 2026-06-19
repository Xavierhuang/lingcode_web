// Monetization service for tier management and payment processing

const TIERS = {
  free: {
    name: 'Free',
    price: 0,
    appsPerMonth: 1,
    description: '1 app/month',
  },
  pro: {
    name: 'Pro',
    price: null, // Only via LingModel bundle
    appsPerMonth: 4,
    description: '4 apps/month (via LingModel)',
  },
  max_pro: {
    name: 'Max Pro',
    price: 200,
    appsPerMonth: Infinity,
    description: 'Unlimited apps/month',
  },
};

const SUPABASE_URL = 'https://roirvcdajfhpcdqkywnk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_bLZYW_xI8bkswKxZJPGMig_CqTksaUI';

// Initialize Supabase
async function initSupabase() {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.38.0');
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

let supabaseClient = null;

async function getSupabase() {
  if (!supabaseClient) {
    supabaseClient = await initSupabase();
  }
  return supabase;
}

// Get current user
export async function getCurrentUser() {
  const supabase = await getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// Get user subscription tier
export async function getUserTier(userId) {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('users')
    .select('subscription_tier, lingmodel_pro_status, apps_generated_this_month')
    .eq('id', userId)
    .single();

  if (error) return TIERS.free;

  // LingModel Pro users automatically get App Generator Pro
  if (data.lingmodel_pro_status === 'active') {
    return TIERS.pro;
  }

  return TIERS[data.subscription_tier] || TIERS.free;
}

// Check if user can generate an app
export async function canGenerateApp(userId) {
  const supabase = await getSupabase();

  // Get user's subscription
  const { data: user, error } = await supabase
    .from('users')
    .select('subscription_tier, lingmodel_pro_status, apps_generated_this_month, month_reset_date')
    .eq('id', userId)
    .single();

  if (error) {
    // New user, create profile
    await supabase.from('users').insert({
      id: userId,
      subscription_tier: 'free',
      apps_generated_this_month: 0,
      month_reset_date: new Date().toISOString().split('T')[0],
    });
    return true;
  }

  // Determine effective tier (LingModel Pro grants app generator Pro)
  let effectiveTier = TIERS[user.subscription_tier];
  if (user.lingmodel_pro_status === 'active') {
    effectiveTier = TIERS.pro;
  }

  // Check if month has reset
  const today = new Date().toISOString().split('T')[0];
  const [year, month] = today.split('-');
  const [resetYear, resetMonth] = (user.month_reset_date || today).split('-');

  if (year !== resetYear || month !== resetMonth) {
    // Month has changed, reset counter
    await supabase
      .from('users')
      .update({
        apps_generated_this_month: 0,
        month_reset_date: today,
      })
      .eq('id', userId);
    return true;
  }

  // Check tier limit
  if (effectiveTier.appsPerMonth === Infinity) {
    return true;
  }

  return user.apps_generated_this_month < effectiveTier.appsPerMonth;
}

// Record app generation
export async function recordAppGeneration(userId, appName, githubUrl, liveUrl) {
  const supabase = await getSupabase();

  // Get user's tier
  const { data: user } = await supabase
    .from('users')
    .select('subscription_tier')
    .eq('id', userId)
    .single();

  const tier = TIERS[user.subscription_tier];
  const costToUser = tier.price > 0 && tier.price !== 10 ? tier.price : 0;

  // Record the app
  const { error } = await supabase
    .from('generated_apps')
    .insert({
      user_id: userId,
      name: appName,
      description: '', // Could add this
      template: '', // Could add this
      github_url: githubUrl,
      live_url: liveUrl,
      cost_to_user: costToUser,
    });

  if (error) throw error;

  // Update usage counter
  await supabase
    .from('users')
    .update({
      apps_generated_this_month: (user.apps_generated_this_month || 0) + 1,
    })
    .eq('id', userId);

  return { success: true, costToUser };
}

// Get upgrade prompt
export function getUpgradePrompt(tier) {
  if (tier === 'free') {
    return {
      title: '📊 You\'ve hit your free limit',
      message: 'Upgrade to continue creating apps.',
      options: [
        {
          text: 'Max Pro (Unlimited apps, $200/mo)',
          action: 'upgrade-max-pro',
          priceId: 'price_max_pro',
        },
        {
          text: 'Get LingModel Pro (4 apps/mo)',
          action: 'lingmodel-pro',
        },
      ],
    };
  }
  return null;
}

// Stripe checkout (for upgrades)
export async function initiateStripeCheckout(userId, priceId) {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/stripe-checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId,
        priceId, // 'price_pro' or 'price_ppg'
      }),
    });

    const { sessionUrl } = await response.json();
    window.location.href = sessionUrl;
  } catch (error) {
    console.error('Stripe checkout error:', error);
    throw error;
  }
}

// Auth functions
export async function signUpWithEmail(email, password) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });

  if (error) throw error;
  if (data.user) {
    await supabase.from('users').insert({
      id: data.user.id,
      email,
      subscription_tier: 'free',
    });

    // Send welcome email
    await sendEmail(email, 'welcome');
  }
  return data;
}

export async function signInWithEmail(email, password) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) throw error;
  return data;
}

export async function signOut() {
  const supabase = await getSupabase();
  await supabase.auth.signOut();
  window.location.href = '/try';
}

export async function getSession() {
  const supabase = await getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

// Update LingModel Pro status (called by webhook when user subscribes)
export async function setLingModelProStatus(userId, status) {
  const supabase = await getSupabase();
  await supabase
    .from('users')
    .update({ lingmodel_pro_status: status })
    .eq('id', userId);
}

// Send email notifications
async function sendEmail(to, type, data = {}) {
  try {
    await fetch('https://roirvcdajfhpcdqkywnk.supabase.co/functions/v1/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, type, data }),
    });
  } catch (error) {
    console.error('Email send error:', error);
  }
}

export { TIERS, sendEmail };
