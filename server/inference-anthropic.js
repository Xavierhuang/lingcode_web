'use strict';

const { Readable, Transform } = require('stream');
const express = require('express');
const { getUserFromRequest } = require('./auth-helpers');

/** Legacy lifetime cap. Default 0 = disabled (free tier is now gated by daily/monthly windows below). */
const HOSTED_LIMIT = parseInt(process.env.HOSTED_PROMPT_LIMIT || '0', 10);

const parseNonNegInt = (raw, fallback) => {
  const n = parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
};

/** Free LingModel prompts per UTC day. 0 = no daily prompt cap. Default 25 (~30–50 min agent session). */
const LINGMODEL_FREE_DAILY_PROMPT_LIMIT = parseNonNegInt(
  process.env.LINGMODEL_FREE_DAILY_PROMPT_LIMIT,
  25
);

/** Lifetime free-tier prompt cap (cumulative, never resets). When a signed-in
 *  free user hits this count, every further LingModel request 402s with
 *  `upgrade_url` so the client can route them to Stripe Checkout. 0 = disabled
 *  (legacy daily-only behavior). Default 100 — the funnel from free trial to
 *  Pro is "100 prompts to evaluate the product, then subscribe." */
const LINGMODEL_FREE_LIFETIME_PROMPT_LIMIT = parseNonNegInt(
  process.env.LINGMODEL_FREE_LIFETIME_PROMPT_LIMIT,
  100
);

/** Free LingModel output tokens per UTC day. 0 = no daily token cap. Default 60K (~25 turns × 2.4K). */
const LINGMODEL_FREE_DAILY_OUTPUT_TOKENS = parseNonNegInt(
  process.env.LINGMODEL_FREE_DAILY_OUTPUT_TOKENS,
  60000
);

/** Free LingModel output tokens per UTC month. 0 = no monthly cap. Default 750K → ≈ $0.30/user/mo on V4-Flash. */
const LINGMODEL_FREE_MONTHLY_OUTPUT_TOKENS = parseNonNegInt(
  process.env.LINGMODEL_FREE_MONTHLY_OUTPUT_TOKENS,
  750000
);

/** Free LingModel burst limit (requests/minute, per user). 0 = no burst cap. Default 10. */
const LINGMODEL_FREE_BURST_PER_MIN = parseNonNegInt(
  process.env.LINGMODEL_FREE_BURST_PER_MIN,
  10
);

/**
 * LingModel proxies Anthropic Messages API requests to an upstream vendor that exposes
 * the same `/anthropic/v1/messages` shape (streaming SSE).
 *
 * Default deployment: Moonshot Kimi (`api.moonshot.ai`) + `MOONSHOT_API_KEY`. This
 * matches production. The only key you must provide is a Moonshot platform key
 * (no DeepSeek key required).
 * To route via DeepSeek instead, set env (example):
 *
 *   LINGMODEL_ANTHROPIC_MESSAGES_URL=https://api.deepseek.com/anthropic/v1/messages
 *   LINGMODEL_UPSTREAM_API_KEY=<deepseek platform API key>
 *   LINGMODEL_DEFAULT_MODEL=deepseek-v4-flash
 *   LINGMODEL_FORCE_MODEL=deepseek-v4-flash  # optional: pin all tiers
 *
 * All three (URL, key, model) are also overridable per-deployment via the DB
 * `app_config` table (lingModelConfigValue), which takes precedence over these
 * code defaults — that's how production pins its exact Kimi config.
 *
 * Keys are resolved in order: LINGMODEL_UPSTREAM_API_KEY, MOONSHOT_API_KEY, DEEPSEEK_API_KEY.
 */

/**
 * When the app sends `model: "auto"` (LingModel), substitute this model id upstream.
 * Defaults to Moonshot Kimi. For DeepSeek, set env `LINGMODEL_DEFAULT_MODEL=deepseek-v4-flash`.
 */
const LINGMODEL_FALLBACK_MODEL = 'kimi-k2.7';

const DEFAULT_ANTHROPIC_MESSAGES_URL =
  'https://api.moonshot.ai/anthropic/v1/messages';

function lingmodelAnthropicMessagesUrl(db) {
  const u = lingModelConfigValue(db, 'LINGMODEL_ANTHROPIC_MESSAGES_URL');
  return u.length > 0 ? u : DEFAULT_ANTHROPIC_MESSAGES_URL;
}

/** Key for LingModel upstream; shared across deployments that use Moonshot, DeepSeek, or Anthropic.
 *  Resolution order: DB app_config (LINGMODEL_UPSTREAM_API_KEY, prod's source of truth) →
 *  MOONSHOT_API_KEY (the default upstream) → DEEPSEEK_API_KEY (legacy/alt). No DeepSeek key
 *  is required; a Moonshot key alone is sufficient. */
function lingmodelUpstreamApiKey(db) {
  const u = lingModelConfigValue(db, 'LINGMODEL_UPSTREAM_API_KEY');
  if (u) return u;
  return (
    (process.env.MOONSHOT_API_KEY || '').trim() ||
    (process.env.KIMI_API_KEY || '').trim() ||      // same vendor as Moonshot; name used elsewhere in the repo (swarm)
    (process.env.DEEPSEEK_API_KEY || '').trim() ||
    ''
  );
}

/** Pro LingModel prompts per day (UTC). 0 = no daily cap (operator escape hatch). Default 500. */
const LINGMODEL_PRO_DAILY_PROMPT_LIMIT = (() => {
  const n = parseInt(process.env.LINGMODEL_PRO_DAILY_PROMPT_LIMIT || '500', 10);
  if (!Number.isFinite(n) || n < 0) return 500;
  return n;
})();

/**
 * Pro LingModel prompts per 5-hour window (UTC). Same pattern as Cursor /
 * Claude.ai — caps cost on a tight rolling window so a runaway agent loop
 * can't burn months of budget in one day. 0 = no window cap. Default 30.
 * Windows are fixed UTC hours: 00, 05, 10, 15, 20.
 */
const LINGMODEL_PRO_5H_PROMPT_LIMIT = (() => {
  const n = parseInt(process.env.LINGMODEL_PRO_5H_PROMPT_LIMIT || '150', 10);
  if (!Number.isFinite(n) || n < 0) return 150;
  return n;
})();

/** Pro daily OUTPUT-token cap. Tokens (not prompts) are the actual cost
 *  metric — a 64K-output prompt on V4-Pro costs ~$0.22 alone. Default 600K
 *  tokens/day = ~$2.10 worst-case spend per Pro user per day at full Pro
 *  pricing. 0 = disabled. */
const LINGMODEL_PRO_DAILY_OUTPUT_TOKENS = (() => {
  const n = parseInt(process.env.LINGMODEL_PRO_DAILY_OUTPUT_TOKENS || '600000', 10);
  if (!Number.isFinite(n) || n < 0) return 600000;
  return n;
})();

/** Pro monthly OUTPUT-token cap. Hard ceiling so unit economics survive
 *  even if a user uses every daily window. Default 8M tokens/month = ~$28
 *  worst-case at full Pro pricing. 0 = disabled. */
const LINGMODEL_PRO_MONTHLY_OUTPUT_TOKENS = (() => {
  const n = parseInt(process.env.LINGMODEL_PRO_MONTHLY_OUTPUT_TOKENS || '8000000', 10);
  if (!Number.isFinite(n) || n < 0) return 8000000;
  return n;
})();

/** Max-Pro tier ("Pro+"). Same shape as Pro, looser caps. 0 = unlimited.
 *  Defaults: fully uncapped — no daily/5h prompt caps and no daily/monthly
 *  output-token caps. Max Pro is the top tier and is not metered; operators can
 *  still pin a finite ceiling per key via env or the admin dashboard if needed. */
const LINGMODEL_MAX_PRO_DAILY_PROMPT_LIMIT = (() => {
  const n = parseInt(process.env.LINGMODEL_MAX_PRO_DAILY_PROMPT_LIMIT || '0', 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
})();
const LINGMODEL_MAX_PRO_5H_PROMPT_LIMIT = (() => {
  const n = parseInt(process.env.LINGMODEL_MAX_PRO_5H_PROMPT_LIMIT || '0', 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
})();
const LINGMODEL_MAX_PRO_DAILY_OUTPUT_TOKENS = (() => {
  const n = parseInt(process.env.LINGMODEL_MAX_PRO_DAILY_OUTPUT_TOKENS || '0', 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
})();
const LINGMODEL_MAX_PRO_MONTHLY_OUTPUT_TOKENS = (() => {
  const n = parseInt(process.env.LINGMODEL_MAX_PRO_MONTHLY_OUTPUT_TOKENS || '0', 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
})();

/** Tier-aware cap lookup. `tier` is 'free' | 'pro' | 'max_pro' (or anything that
 *  falls through to Pro). `limits` is a snapshot from loadLingModelLimits(db)
 *  so per-tier numbers can be overridden via the admin dashboard. */
function paidTierCaps(tier, limits) {
  if (tier === 'max_pro') {
    return {
      dailyPrompt:    limits.maxProDailyPromptLimit,
      windowPrompt:   limits.maxPro5hPromptLimit,
      dailyTokens:    limits.maxProDailyOutputTokens,
      monthlyTokens:  limits.maxProMonthlyOutputTokens,
    };
  }
  return {
    dailyPrompt:   limits.proDailyPromptLimit,
    windowPrompt:  limits.pro5hPromptLimit,
    dailyTokens:   limits.proDailyOutputTokens,
    monthlyTokens: limits.proMonthlyOutputTokens,
  };
}

const PRO_WINDOW_HOURS = 5;
/** Returns "YYYY-MM-DDTHH" where HH is the start hour of the current 5h
 *  UTC window: 00, 05, 10, 15, or 20. */
function current5hWindowKey(now = new Date()) {
  const ymd = now.toISOString().slice(0, 10);
  const startHour = Math.floor(now.getUTCHours() / PRO_WINDOW_HOURS) * PRO_WINDOW_HOURS;
  return `${ymd}T${String(startHour).padStart(2, '0')}`;
}
/** When does the current window end (ms since epoch)? Used in the entitlement
 *  payload so the client can show a countdown ("resets in 2h 15m"). */
function currentWindowEndMs(now = new Date()) {
  const startHour = Math.floor(now.getUTCHours() / PRO_WINDOW_HOURS) * PRO_WINDOW_HOURS;
  const end = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    startHour + PRO_WINDOW_HOURS, 0, 0, 0,
  ));
  return end.getTime();
}

/** Default max output tokens per request when env not set (always enforced for hosted LingModel).
 *  Raised 2026-04-26: Free 4096→8192 to match the client-requested ceiling so prototypes stop
 *  getting cut mid-CSS; Pro 8192→16384 for longer doc/code generations. Daily/monthly token
 *  caps still bound total cost per user, so this doesn't change the spend ceiling — only how
 *  tokens distribute across responses. Tune per-tier with LINGMODEL_MAX_OUTPUT_TOKENS_FREE/_PRO. */
// Bumped 2026-04-27: multi-page website generation now lands here. A
// polished page with inlined design-discipline CSS runs ~3-5K tokens, so
// free at 24K fits ~5 pages and Pro at 64K fits ~13. DeepSeek V4 itself
// supports up to 384K output — these are cost controls, not technical
// limits. Override via env: LINGMODEL_MAX_OUTPUT_TOKENS_{FREE,PRO}.
const DEFAULT_MAX_OUT_FREE = 24576;
// Tightened 2026-04-28: 64K → 32K. A single 64K Pro prompt at full pricing
// costs ~$0.22; 32K halves the per-prompt blast radius. Override via env
// LINGMODEL_MAX_OUTPUT_TOKENS_PRO if a deployment needs the larger ceiling.
const DEFAULT_MAX_OUT_PRO = 32768;

// Anonymous (no-signup) LingModel access has been removed — LingModel now
// requires a signed-in account or a BYO provider key. Signed-out requests are
// rejected with 401 in the handler below.

/** Per-request output token cap for Max-Pro (Pro+) tier. Headroom over Pro
 *  for long single-shot generations; daily/monthly token caps still bound
 *  total spend. Override via LINGMODEL_MAX_OUTPUT_TOKENS_MAX_PRO. */
const DEFAULT_MAX_OUT_MAX_PRO = 65536;

/**
 * @param {string} tier - 'free' | 'pro' | 'max_pro' (anything else maps to free)
 * @returns {number}
 */
function maxOutputTokensCap(tier) {
  const legacy = (process.env.LINGMODEL_MAX_OUTPUT_TOKENS || '').trim();
  const freeRaw   = (process.env.LINGMODEL_MAX_OUTPUT_TOKENS_FREE || '').trim();
  const proRaw    = (process.env.LINGMODEL_MAX_OUTPUT_TOKENS_PRO || '').trim();
  const maxProRaw = (process.env.LINGMODEL_MAX_OUTPUT_TOKENS_MAX_PRO || '').trim();

  const fallback = tier === 'max_pro' ? DEFAULT_MAX_OUT_MAX_PRO
                 : tier === 'pro'     ? DEFAULT_MAX_OUT_PRO
                 : DEFAULT_MAX_OUT_FREE;

  const raw = tier === 'max_pro' ? (maxProRaw || proRaw || legacy)
            : tier === 'pro'     ? (proRaw    || legacy)
            : (freeRaw || legacy);

  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

/**
 * Clamp or set max_tokens so no tier can request unlimited output on your API key.
 *
 * @param {object} out
 * @param {string} tier - 'free' | 'pro' | 'max_pro'
 */
function clampMaxTokens(out, tier) {
  const cap = maxOutputTokensCap(tier);
  const mt = out.max_tokens;
  if (typeof mt === 'number' && Number.isFinite(mt)) {
    out.max_tokens = Math.min(mt, cap);
    return;
  }
  if (typeof mt === 'string' && mt.trim() !== '') {
    const n = parseInt(mt, 10);
    out.max_tokens = Number.isFinite(n) ? Math.min(n, cap) : cap;
    return;
  }
  out.max_tokens = cap;
}

/**
 * Detect whether an incoming /v1/messages request is a fresh user turn or a
 * tool-loop continuation. Used for prompt-quota accounting — without this,
 * one user message can chew through 5-15 quota slots as the agent SDK
 * iterates Read → Edit → Bash → ... calling back into us each time.
 *
 * Anthropic's conversation shape:
 *   { role:'user', content:'hello' }                                  ← fresh (string)
 *   { role:'user', content:[{type:'text',text:'hi'}] }                ← fresh (text block)
 *   { role:'user', content:[{type:'image',...}] }                     ← fresh (image input)
 *   { role:'user', content:[{type:'tool_result',tool_use_id,content}] } ← tool-loop continuation
 *   { role:'user', content:[{type:'tool_result',...},{type:'text',...}] } ← mixed (rare; count as fresh)
 *
 * Continuation iff every content block in the last user message has
 * type='tool_result'. Anything else means the user typed/attached
 * something new and should be counted.
 *
 * Permissive defaults (count as fresh) on malformed input so the gate
 * never falsely lets traffic through unmetered.
 *
 * @param {any} body
 * @returns {boolean} true if this should count against the prompt limit
 */
function isFreshUserTurn(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return true;
  }
  // Find the last user message (assistant messages sit between turns).
  let lastUser = null;
  for (let i = body.messages.length - 1; i >= 0; i--) {
    if (body.messages[i] && body.messages[i].role === 'user') {
      lastUser = body.messages[i];
      break;
    }
  }
  if (!lastUser) return true;
  const content = lastUser.content;
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return true;
  if (content.length === 0) return true;
  return content.some((block) => block && block.type && block.type !== 'tool_result');
}
/**
 * Keys that admins can override at runtime via the `app_config` table.
 * DB row wins over env; clearing the row falls back to env (the deploy-time default).
 */
const LINGMODEL_CONFIG_KEYS = Object.freeze([
  'LINGMODEL_ANTHROPIC_MESSAGES_URL',
  'LINGMODEL_UPSTREAM_API_KEY',
  'LINGMODEL_DEFAULT_MODEL',
  'LINGMODEL_ADVANCED_MODEL',
  'LINGMODEL_FORCE_MODEL',
  'LINGMODEL_FREE_TIER_MODEL',
  'LINGMODEL_ALLOWED_MODELS',
  // Image generation (consumed by image-generation.js).
  'LINGMODEL_IMAGE_UPSTREAM_URL',
  'LINGMODEL_IMAGE_UPSTREAM_KEY',
]);

/** Keys whose values are credentials — masked in admin GET, never echoed back in plaintext. */
const LINGMODEL_CONFIG_SECRETS = Object.freeze(new Set([
  'LINGMODEL_UPSTREAM_API_KEY',
  'LINGMODEL_IMAGE_UPSTREAM_KEY',
]));

/**
 * Resolve a single LingModel-tier config value: DB row first, then env var.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} key - one of LINGMODEL_CONFIG_KEYS
 * @returns {string} trimmed value, '' if neither DB nor env has it
 */
function lingModelConfigValue(db, key) {
  if (db) {
    try {
      const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
      if (row && typeof row.value === 'string' && row.value.trim()) {
        return row.value.trim();
      }
    } catch (_) {
      // Table may not exist yet on first boot; fall through to env.
    }
  }
  return (process.env[key] || '').trim();
}

/**
 * Snapshot the full tier-mapping config for one request.
 *
 * @param {import('better-sqlite3').Database} db
 */
function loadLingModelConfig(db) {
  return {
    defaultModel: lingModelConfigValue(db, 'LINGMODEL_DEFAULT_MODEL') || LINGMODEL_FALLBACK_MODEL,
    advancedModel: lingModelConfigValue(db, 'LINGMODEL_ADVANCED_MODEL'),
    forceModel: lingModelConfigValue(db, 'LINGMODEL_FORCE_MODEL'),
    freeTierModel: lingModelConfigValue(db, 'LINGMODEL_FREE_TIER_MODEL'),
    allowedModels: lingModelConfigValue(db, 'LINGMODEL_ALLOWED_MODELS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * Read a numeric tier-limit value, falling through DB → env → hard-coded
 * default. Mirrors lingModelConfigValue but for non-negative integers.
 * Empty/invalid DB rows fall through to env; empty/invalid env falls through
 * to the supplied default.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} key — one of LINGMODEL_LIMIT_KEYS
 * @param {number} defaultValue
 * @returns {number}
 */
function lingModelLimitValue(db, key, defaultValue) {
  if (db) {
    try {
      const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
      if (row && typeof row.value === 'string' && row.value.trim()) {
        const n = parseInt(row.value.trim(), 10);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    } catch (_) { /* table may not exist yet on first boot */ }
  }
  const env = process.env[key];
  if (env !== undefined) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return defaultValue;
}

/**
 * Snapshot every tier limit for one request. DB-overridable per key; falls
 * back to env, then to the hard-coded default. Defaults are the same numbers
 * the const declarations at the top of this file use, kept in sync manually
 * (no clean way to share without breaking the module-load contract that other
 * code paths still depend on for the legacy named exports).
 *
 * @param {import('better-sqlite3').Database} db
 */
function loadLingModelLimits(db) {
  return {
    // Free tier
    freeDailyPromptLimit:      lingModelLimitValue(db, 'LINGMODEL_FREE_DAILY_PROMPT_LIMIT', 25),
    freeLifetimePromptLimit:   lingModelLimitValue(db, 'LINGMODEL_FREE_LIFETIME_PROMPT_LIMIT', 100),
    freeDailyOutputTokens:     lingModelLimitValue(db, 'LINGMODEL_FREE_DAILY_OUTPUT_TOKENS', 0),
    freeMonthlyOutputTokens:   lingModelLimitValue(db, 'LINGMODEL_FREE_MONTHLY_OUTPUT_TOKENS', 0),
    freeBurstPerMin:           lingModelLimitValue(db, 'LINGMODEL_FREE_BURST_PER_MIN', 10),
    // Pro tier
    proDailyPromptLimit:       lingModelLimitValue(db, 'LINGMODEL_PRO_DAILY_PROMPT_LIMIT', 500),
    pro5hPromptLimit:          lingModelLimitValue(db, 'LINGMODEL_PRO_5H_PROMPT_LIMIT', 30),
    proDailyOutputTokens:      lingModelLimitValue(db, 'LINGMODEL_PRO_DAILY_OUTPUT_TOKENS', 600000),
    proMonthlyOutputTokens:    lingModelLimitValue(db, 'LINGMODEL_PRO_MONTHLY_OUTPUT_TOKENS', 8000000),
    // Max Pro tier
    maxProDailyPromptLimit:    lingModelLimitValue(db, 'LINGMODEL_MAX_PRO_DAILY_PROMPT_LIMIT', 0),
    maxPro5hPromptLimit:       lingModelLimitValue(db, 'LINGMODEL_MAX_PRO_5H_PROMPT_LIMIT', 0),
    maxProDailyOutputTokens:   lingModelLimitValue(db, 'LINGMODEL_MAX_PRO_DAILY_OUTPUT_TOKENS', 0),
    maxProMonthlyOutputTokens: lingModelLimitValue(db, 'LINGMODEL_MAX_PRO_MONTHLY_OUTPUT_TOKENS', 0),
    // Image generation monthly caps. Defaults are deliberately low on free so
    // upstream cost stays bounded — gpt-image-1 is $0.04–0.17/image.
    imageQuotaFree:            lingModelLimitValue(db, 'IMAGE_QUOTA_FREE', 20),
    imageQuotaPro:             lingModelLimitValue(db, 'IMAGE_QUOTA_PRO', 1000),
    imageQuotaMaxPro:          lingModelLimitValue(db, 'IMAGE_QUOTA_MAX_PRO', 10000),
  };
}

/**
 * Keys an admin can override at runtime via app_config + the
 * /api/admin/lingmodel-limits dashboard tile. Must stay in sync with the
 * field names returned by loadLingModelLimits.
 */
const LINGMODEL_LIMIT_KEYS = Object.freeze([
  'LINGMODEL_FREE_DAILY_PROMPT_LIMIT',
  'LINGMODEL_FREE_LIFETIME_PROMPT_LIMIT',
  'LINGMODEL_FREE_DAILY_OUTPUT_TOKENS',
  'LINGMODEL_FREE_MONTHLY_OUTPUT_TOKENS',
  'LINGMODEL_FREE_BURST_PER_MIN',
  'LINGMODEL_PRO_DAILY_PROMPT_LIMIT',
  'LINGMODEL_PRO_5H_PROMPT_LIMIT',
  'LINGMODEL_PRO_DAILY_OUTPUT_TOKENS',
  'LINGMODEL_PRO_MONTHLY_OUTPUT_TOKENS',
  'LINGMODEL_MAX_PRO_DAILY_PROMPT_LIMIT',
  'LINGMODEL_MAX_PRO_5H_PROMPT_LIMIT',
  'LINGMODEL_MAX_PRO_DAILY_OUTPUT_TOKENS',
  'LINGMODEL_MAX_PRO_MONTHLY_OUTPUT_TOKENS',
  // Image-generation monthly caps (consumed by image-generation.js). Lives in
  // the same admin tile so operators have one panel to manage every quota.
  'IMAGE_QUOTA_FREE',
  'IMAGE_QUOTA_PRO',
  'IMAGE_QUOTA_MAX_PRO',
]);

/**
 * Server-side cost controls for LingModel.
 * Precedence: forceModel (all users) > freeTierModel (free only) > allowedModels.
 *
 * @param {object} body - Parsed JSON body from the client
 * @param {{ isPro: boolean, tier?: string, config: ReturnType<typeof loadLingModelConfig> }} opts
 * @returns {object}
 */
function applyLingModelCostControls(body, opts) {
  if (!body || typeof body !== 'object') {
    return body;
  }
  const out = { ...body };
  const { isPro, tier = (isPro ? 'pro' : 'free'), config, upstreamUrl = '' } = opts;

  const defaultLingModel = config.defaultModel;
  const advancedLingModel = config.advancedModel || defaultLingModel;
  const rawModel = String(out.model ?? '').trim();
  if (rawModel === 'auto-advanced' || rawModel === 'auto-pro') {
    out.model = advancedLingModel;
  } else if (!rawModel || rawModel === 'auto' || rawModel === 'auto-standard') {
    out.model = defaultLingModel;
  }

  if (config.forceModel) {
    out.model = config.forceModel;
  } else if (!isPro && config.freeTierModel) {
    out.model = config.freeTierModel;
  } else if (config.allowedModels.length > 0) {
    const requested = String(out.model || '');
    if (!config.allowedModels.includes(requested)) {
      out.model = config.allowedModels.includes(defaultLingModel)
        ? defaultLingModel
        : config.allowedModels[0];
    }
  }

  // DeepSeek-V4 enables extended thinking by default and produces ~30-40× the
  // token volume of the visible reply for short prompts (empirical: 272 → 9
  // output tokens for "say hi" with thinking disabled). Default thinking off
  // unless the caller explicitly opts in via { type: 'enabled' }.
  //
  // Exception: when the resolved upstream model is a real Anthropic Claude id,
  // pass `thinking` through unchanged. Claude's extended thinking is the
  // headline feature paying users expect, and Anthropic's billing already
  // exposes the cost; clamping here would silently degrade the Advanced tier
  // after an admin flips the upstream provider to Anthropic.
  const resolvedModel = String(out.model || '').toLowerCase();
  const isClaudeUpstream = /(?:^|[-_/])(?:claude|opus|sonnet|haiku)/.test(resolvedModel);
  // Moonshot/Kimi (the default LingModel upstream) REJECTS `thinking.type=disabled`
  // with "invalid thinking: only type=enabled is allowed for this model" — but it
  // accepts an ABSENT thinking field. DeepSeek-V4, by contrast, needs an explicit
  // `disabled` to keep its default-on extended thinking from ballooning token use.
  // So branch by upstream: drop non-enabled thinking for Kimi, force-disable for the
  // rest (Claude passes through untouched above).
  // Detect Moonshot/Kimi by the UPSTREAM URL first — the Agent SDK usually sends a
  // Claude model id even when the real upstream is Kimi, so the model id alone isn't
  // reliable. Kimi rejects any thinking.type other than 'enabled' (incl. 'disabled'
  // and the SDK's 'adaptive') but accepts an ABSENT field, so drop non-enabled
  // thinking. DeepSeek-V4 needs an explicit 'disabled'; Claude passes through.
  const isMoonshotUpstream = /moonshot|kimi/i.test(upstreamUrl) || /kimi|moonshot/.test(resolvedModel);
  if (isMoonshotUpstream) {
    // kimi-k2.7-code REQUIRES thinking.type=enabled — both an ABSENT thinking field
    // and type=disabled 400 with "only type=enabled is allowed for this model"
    // (verified empirically). It's a reasoning model with no thinking-off mode, so
    // force it on, preserving any caller-set budget.
    const budget = (out.thinking && typeof out.thinking.budget_tokens === 'number')
      ? out.thinking.budget_tokens : 8000;
    out.thinking = { type: 'enabled', budget_tokens: budget };
  } else if (!isClaudeUpstream && out.thinking?.type !== 'enabled') {
    out.thinking = { type: 'disabled' };
  }

  // Claude Code / Messages API: reasoning effort cannot be combined with
  // `thinking.type=disabled`. LingModel coerces non-enabled thinking to disabled;
  // strip effort fields so the upstream request validates.
  if (out.thinking?.type === 'disabled') {
    if (out.reasoning_effort != null) delete out.reasoning_effort;
    if (out.output_config && typeof out.output_config === 'object') {
      const next = { ...out.output_config };
      delete next.effort;
      if (Object.keys(next).length === 0) delete out.output_config;
      else out.output_config = next;
    }
  }

  clampMaxTokens(out, tier);

  return out;
}

/**
 * Per-user burst bucket. In-memory, so it resets on systemd restart; that's fine — the abuse
 * window we care about is seconds, not hours, and the daily/monthly DB-backed caps catch
 * anything slower. Keyed by user id.
 *
 * @type {Map<string, { tokens: number, refilledAt: number }>}
 */
const burstBuckets = new Map();

/**
 * @param {string} userId
 * @returns {boolean} true if a token was consumed; false if the bucket is empty.
 */
function takeBurstToken(userId) {
  if (LINGMODEL_FREE_BURST_PER_MIN <= 0) return true;
  const cap = LINGMODEL_FREE_BURST_PER_MIN;
  const refillPerMs = cap / 60_000;
  const now = Date.now();
  let b = burstBuckets.get(userId);
  if (!b) {
    b = { tokens: cap, refilledAt: now };
    burstBuckets.set(userId, b);
  } else {
    b.tokens = Math.min(cap, b.tokens + (now - b.refilledAt) * refillPerMs);
    b.refilledAt = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** YYYY-MM-DD in UTC. */
function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

/** YYYY-MM in UTC. */
function utcMonth() {
  return new Date().toISOString().slice(0, 7);
}

/** ISO-8601 of next UTC midnight, used for X-LingModel-Reset. */
function nextUtcMidnightIso() {
  const now = new Date();
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return reset.toISOString();
}

/**
 * SSE-aware passthrough that taps `usage.output_tokens` from `message_delta` events streamed
 * by the Anthropic-compatible upstream. We keep `lastOutputTokens` for the route handler
 * to read on the source's `'end'` event, then increment DB columns once. No parser dep.
 */
function createUsageTap() {
  let buffer = '';
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      const text = chunk.toString('utf8');
      buffer += text;
      // SSE events are delimited by blank lines. Scan complete events only; leave the trailing
      // partial in the buffer.
      let lastBoundary = -1;
      for (let i = 0; i + 1 < buffer.length; i++) {
        if (buffer[i] === '\n' && buffer[i + 1] === '\n') {
          const ev = buffer.slice(lastBoundary + 1, i);
          tryExtractUsage(ev, tap);
          lastBoundary = i + 1;
        }
      }
      if (lastBoundary >= 0) {
        buffer = buffer.slice(lastBoundary + 1);
      }
      this.push(chunk);
      cb();
    },
    flush(cb) {
      if (buffer.length > 0) {
        tryExtractUsage(buffer, tap);
        buffer = '';
      }
      cb();
    }
  });
  tap.lastOutputTokens = 0;
  return tap;
}

function tryExtractUsage(eventBlock, tap) {
  // Only `message_delta` carries the cumulative `usage` we need; `message_start` has it too
  // but we want the final number, which the upstream emits on `message_delta` with stop_reason.
  if (!eventBlock.includes('message_delta') && !eventBlock.includes('message_start')) return;
  for (const line of eventBlock.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    const usage = obj && obj.usage;
    const out =
      (usage && typeof usage.output_tokens === 'number' && usage.output_tokens) ||
      (obj && obj.delta && obj.delta.usage && obj.delta.usage.output_tokens);
    if (typeof out === 'number' && out > tap.lastOutputTokens) {
      tap.lastOutputTokens = out;
    }
  }
}

/**
 * LingModel: streaming proxy using the operator's Anthropic-compat upstream key + URL.
 * Default upstream is Moonshot Kimi; set `LINGMODEL_ANTHROPIC_MESSAGES_URL` + a DeepSeek key to switch.
 * The route speaks Anthropic message-format client-side (the app pins the Anthropic shape).
 * BYOK users call vendors from the app directly and do not hit this route when not using LingModel tier.
 *
 * Free tier (in order of cheapness): per-minute burst → daily prompt cap → daily output-token
 * cap → monthly output-token backstop. Token caps are charged post-stream from the upstream's
 * own usage accounting. Pro: LINGMODEL_PRO_DAILY_PROMPT_LIMIT per UTC day (default 500).
 *
 * @param {import('better-sqlite3').Database} db
 */
function createInferenceRouter(db) {
  const router = express.Router();

  router.post('/anthropic/v1/messages', express.json({ limit: '50mb' }), async (req, res) => {
    const ownerKey = lingmodelUpstreamApiKey(db);
    if (!ownerKey) {
      return res.status(503).json({
        error:
          'LingModel is not configured. Set MOONSHOT_API_KEY (default upstream — Kimi), ' +
          'or LINGMODEL_UPSTREAM_API_KEY (+ LINGMODEL_ANTHROPIC_MESSAGES_URL to point at a ' +
          'different Anthropic-compat upstream such as DeepSeek).'
      });
    }

    // Accept the api_access_token via x-api-key as an alias for
    // Authorization: Bearer. Anthropic's SDK natively sends x-api-key, so
    // CLI clients can use ANTHROPIC_API_KEY=<lingmodel token> + override
    // ANTHROPIC_BASE_URL without rewriting auth headers.
    if (!req.headers.authorization && req.headers['x-api-key']) {
      const k = String(req.headers['x-api-key']).trim();
      if (k.startsWith('lcat_')) req.headers.authorization = 'Bearer ' + k;
    }
    const user = getUserFromRequest(db, req);
    if (!user) {
      // No anonymous access: LingModel requires a signed-in account (or BYOK).
      return res.status(401).json({
        error: 'Sign in to the LingCode app to use LingModel, or add your own API key in Settings (BYOK).'
      });
    }

    const tier = String(user.tier || 'free').toLowerCase();
    const isPro = tier === 'pro' || tier === 'max_pro';
    // DB-overridable tier limits (admin dashboard writes app_config; falls
    // through to env, then hard-coded defaults). Read once per request so a
    // mid-stream admin change doesn't half-apply.
    const limits = loadLingModelLimits(db);
    const tierCaps = paidTierCaps(tier, limits);
    const used = Number(user.hosted_prompts_used || 0);

    // Distinguish fresh user turns from agent tool-loop continuations. The
    // Anthropic Agent SDK spawns a new /v1/messages call for every tool
    // round-trip; without this gate one user message would burn 5-15 quota
    // slots as the agent does Read → Edit → Bash → ... A continuation
    // still flows through (token caps and the upstream proxy run), but it
    // doesn't count against the daily prompt cap and bypasses burst.
    const isFreshTurn = isFreshUserTurn(req.body);

    /** @type {null | { dayCount: number, dayTokens: number, monthTokens: number }} */
    let freeUsage = null;

    if (!isPro) {
      // Burst limit only applies to fresh user turns. The agent loop can
      // legitimately fire 5-10 requests in 30 seconds while resolving a
      // single user prompt; 429-ing mid-loop would leave the agent stuck
      // halfway through a multi-step plan.
      if (isFreshTurn && !takeBurstToken(user.id)) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({
          error: 'lingmodel_burst',
          message: 'Slow down — too many LingModel requests in a short window. Try again in a minute.',
          product: 'LingModel'
        });
      }

      if (HOSTED_LIMIT > 0 && used >= HOSTED_LIMIT) {
        return res.status(402).json({
          error: 'lingmodel_limit',
          message:
            'LingModel free quota is used up. Add your own API key in Settings (no subscription needed), or upgrade to Pro for a higher daily LingModel allowance.',
          hosted_prompts_used: used,
          hosted_prompt_limit: HOSTED_LIMIT,
          product: 'LingModel'
        });
      }

      // Anonymous: skip the user-table free-tier transaction entirely.
      // The IP-keyed anon quota above is the only gate; no DB row to touch.
      // Tool-loop continuations also skip — they're already part of a
      // counted turn (see isFreshUserTurn above).
      const today = utcToday();
      const month = utcMonth();
      if (isFreshTurn) try {
        freeUsage = db.transaction(() => {
          const row = db
            .prepare(
              `SELECT lingmodel_free_day, lingmodel_free_day_count, lingmodel_free_day_output_tokens,
                      lingmodel_free_month, lingmodel_free_month_output_tokens,
                      lingmodel_free_lifetime_count
               FROM users WHERE id = ?`
            )
            .get(user.id);
          const dayCount = row.lingmodel_free_day === today ? Number(row.lingmodel_free_day_count || 0) : 0;
          const dayTokens = row.lingmodel_free_day === today ? Number(row.lingmodel_free_day_output_tokens || 0) : 0;
          const monthTokens =
            row.lingmodel_free_month === month ? Number(row.lingmodel_free_month_output_tokens || 0) : 0;
          const lifetimeCount = Number(row.lingmodel_free_lifetime_count || 0);

          // Lifetime cap is checked BEFORE the daily cap so a user who's burned
          // their 100-prompt trial sees the upgrade prompt immediately, not a
          // "resets at midnight" message that never actually unblocks them.
          if (limits.freeLifetimePromptLimit > 0 && lifetimeCount >= limits.freeLifetimePromptLimit) {
            const e = new Error('FREE_LIFETIME_PROMPT_LIMIT');
            e.dayCount = dayCount; e.dayTokens = dayTokens; e.monthTokens = monthTokens;
            e.lifetimeCount = lifetimeCount;
            throw e;
          }
          if (limits.freeDailyPromptLimit > 0 && dayCount >= limits.freeDailyPromptLimit) {
            const e = new Error('FREE_DAILY_PROMPT_LIMIT');
            e.dayCount = dayCount; e.dayTokens = dayTokens; e.monthTokens = monthTokens;
            e.lifetimeCount = lifetimeCount;
            throw e;
          }
          if (limits.freeDailyOutputTokens > 0 && dayTokens >= limits.freeDailyOutputTokens) {
            const e = new Error('FREE_DAILY_TOKEN_LIMIT');
            e.dayCount = dayCount; e.dayTokens = dayTokens; e.monthTokens = monthTokens;
            e.lifetimeCount = lifetimeCount;
            throw e;
          }
          if (
            limits.freeMonthlyOutputTokens > 0 &&
            monthTokens >= limits.freeMonthlyOutputTokens
          ) {
            const e = new Error('FREE_MONTHLY_TOKEN_LIMIT');
            e.dayCount = dayCount; e.dayTokens = dayTokens; e.monthTokens = monthTokens;
            e.lifetimeCount = lifetimeCount;
            throw e;
          }

          // Bump the prompt count and roll day/month markers atomically. The CASE expressions
          // reference the OLD column values, so token columns reset to 0 when the day or month
          // boundary is crossed. The lifetime counter is monotonic — never resets.
          db.prepare(
            `UPDATE users SET
               lingmodel_free_day_output_tokens =
                 CASE WHEN lingmodel_free_day = ? THEN lingmodel_free_day_output_tokens ELSE 0 END,
               lingmodel_free_month_output_tokens =
                 CASE WHEN lingmodel_free_month = ? THEN lingmodel_free_month_output_tokens ELSE 0 END,
               lingmodel_free_day = ?,
               lingmodel_free_day_count = ?,
               lingmodel_free_month = ?,
               lingmodel_free_lifetime_count = lingmodel_free_lifetime_count + 1,
               hosted_prompts_used = hosted_prompts_used + 1
             WHERE id = ?`
          ).run(today, month, today, dayCount + 1, month, user.id);

          return { dayCount: dayCount + 1, dayTokens, monthTokens, lifetimeCount: lifetimeCount + 1 };
        })();
      } catch (e) {
        let code, message, isLifetime = false;
        switch (e.message) {
          case 'FREE_LIFETIME_PROMPT_LIMIT':
            code = 'lingmodel_lifetime_prompt_limit';
            message = "You've used all 100 free LingModel prompts. Upgrade to Pro to continue.";
            isLifetime = true;
            break;
          case 'FREE_DAILY_PROMPT_LIMIT':
            code = 'lingmodel_daily_prompt_limit';
            message = 'LingModel daily limit reached. Resets at midnight UTC, or upgrade to Pro for a higher daily allowance.';
            break;
          case 'FREE_DAILY_TOKEN_LIMIT':
            code = 'lingmodel_daily_token_limit';
            message = "Today's LingModel usage budget is full. Resets at midnight UTC, or upgrade to Pro.";
            break;
          case 'FREE_MONTHLY_TOKEN_LIMIT':
            code = 'lingmodel_monthly_token_limit';
            message = 'Monthly LingModel allowance reached. Add your own API key in Settings, or upgrade to Pro.';
            break;
          default:
            throw e;
        }
        return res.status(402).json({
          error: code,
          message,
          // Lifetime exhaustion has no reset time — the client should hide any
          // "resets at" copy when this field is absent.
          reset_at: isLifetime ? null : nextUtcMidnightIso(),
          // Single canonical upgrade entry. Pricing page hosts the Stripe
          // Checkout button (the POST /api/billing/checkout endpoint requires
          // auth, so clients can't open it directly across all sign-in states).
          upgrade_url: 'https://lingcode.dev/pricing.html',
          upgrade_required: isLifetime,
          lingmodel_free_daily_prompt_limit: limits.freeDailyPromptLimit,
          lingmodel_free_lifetime_prompt_limit: limits.freeLifetimePromptLimit,
          lingmodel_free_daily_token_limit: limits.freeDailyOutputTokens,
          lingmodel_free_monthly_token_limit: limits.freeMonthlyOutputTokens,
          lingmodel_free_prompts_today: e.dayCount,
          lingmodel_free_prompts_lifetime: e.lifetimeCount,
          lingmodel_free_tokens_used_today: e.dayTokens,
          lingmodel_free_tokens_used_month: e.monthTokens,
          product: 'LingModel'
        });
      }
    } else if (
      tierCaps.dailyPrompt > 0
      || tierCaps.windowPrompt > 0
      || tierCaps.dailyTokens > 0
      || tierCaps.monthlyTokens > 0
    ) {
      const today = new Date().toISOString().slice(0, 10);
      const month = today.slice(0, 7);
      const windowKey = current5hWindowKey();
      // Pre-flight token check — reject BEFORE the upstream call if this
      // user has already burned the daily/monthly token budget. Tokens
      // are committed post-stream by commitUsage below; a request-in-flight
      // could push the user fractionally over, but no individual request
      // can exceed the per-request cap so the slip is bounded by ~32K.
      try {
        const tokRow = db
          .prepare('SELECT lingmodel_pro_day, lingmodel_pro_day_output_tokens, lingmodel_pro_month, lingmodel_pro_month_output_tokens FROM users WHERE id = ?')
          .get(user.id);
        const tokensToday = tokRow.lingmodel_pro_day === today
          ? Number(tokRow.lingmodel_pro_day_output_tokens || 0) : 0;
        const tokensMonth = tokRow.lingmodel_pro_month === month
          ? Number(tokRow.lingmodel_pro_month_output_tokens || 0) : 0;
        if (tierCaps.dailyTokens > 0 && tokensToday >= tierCaps.dailyTokens) {
          return res.status(402).json({
            error: 'lingmodel_pro_daily_token_limit',
            message: 'LingModel daily output-token budget reached. Resets at 00:00 UTC.',
            lingmodel_pro_daily_token_limit: tierCaps.dailyTokens,
            lingmodel_pro_tokens_used_today: tokensToday,
            product: 'LingModel',
            tier
          });
        }
        if (tierCaps.monthlyTokens > 0 && tokensMonth >= tierCaps.monthlyTokens) {
          return res.status(402).json({
            error: 'lingmodel_pro_monthly_token_limit',
            message: 'LingModel monthly output-token budget reached. Resets on the 1st (UTC).',
            lingmodel_pro_monthly_token_limit: tierCaps.monthlyTokens,
            lingmodel_pro_tokens_used_month: tokensMonth,
            product: 'LingModel',
            tier
          });
        }
      } catch (e) {
        console.error('LingModel paid-tier token-cap precheck failed:', e);
        // Fall through — don't 500 on accounting bugs; the prompt-count
        // caps below are still enforced and bound the worst case.
      }
      if (isFreshTurn) try {
        db.transaction(() => {
          const row = db
            .prepare('SELECT lingmodel_pro_day, lingmodel_pro_day_count, lingmodel_pro_window, lingmodel_pro_window_count FROM users WHERE id = ?')
            .get(user.id);
          // 5h window check (runs first — tighter cap, more likely to bite).
          let windowCount = Number(row.lingmodel_pro_window_count || 0);
          if (row.lingmodel_pro_window !== windowKey) windowCount = 0;
          if (tierCaps.windowPrompt > 0 && windowCount >= tierCaps.windowPrompt) {
            throw new Error('PRO_5H_LIMIT');
          }
          // Daily check (cost backstop on top of the window cap).
          let count = Number(row.lingmodel_pro_day_count || 0);
          if (row.lingmodel_pro_day !== today) {
            count = 0;
          }
          if (tierCaps.dailyPrompt > 0 && count >= tierCaps.dailyPrompt) {
            throw new Error('PRO_DAILY_LIMIT');
          }
          const nextCount = row.lingmodel_pro_day === today ? count + 1 : 1;
          const nextWindowCount = row.lingmodel_pro_window === windowKey ? windowCount + 1 : 1;
          db.prepare(
            'UPDATE users SET lingmodel_pro_window = ?, lingmodel_pro_window_count = ? WHERE id = ?'
          ).run(windowKey, nextWindowCount, user.id);
          db.prepare(
            'UPDATE users SET lingmodel_pro_day = ?, lingmodel_pro_day_count = ? WHERE id = ?'
          ).run(today, nextCount, user.id);
        })();
      } catch (e) {
        if (e.message === 'PRO_5H_LIMIT') {
          const row = db
            .prepare('SELECT lingmodel_pro_window, lingmodel_pro_window_count FROM users WHERE id = ?')
            .get(user.id);
          let c = Number(row.lingmodel_pro_window_count || 0);
          if (row.lingmodel_pro_window !== windowKey) c = 0;
          return res.status(402).json({
            error: 'lingmodel_pro_window_limit',
            message:
              'LingModel Pro 5-hour window limit reached. The window resets every 5h (UTC) — try again shortly, or add your own API key in Settings (BYOK).',
            lingmodel_pro_window_limit: tierCaps.windowPrompt,
            lingmodel_pro_window_used: c,
            lingmodel_pro_window_resets_at: currentWindowEndMs(),
            product: 'LingModel',
            tier
          });
        }
        if (e.message === 'PRO_DAILY_LIMIT') {
          const row = db
            .prepare('SELECT lingmodel_pro_day, lingmodel_pro_day_count FROM users WHERE id = ?')
            .get(user.id);
          let c = Number(row.lingmodel_pro_day_count || 0);
          if (row.lingmodel_pro_day !== today) {
            c = 0;
          }
          return res.status(402).json({
            error: 'lingmodel_pro_daily_limit',
            message:
              'LingModel daily limit reached. Try again tomorrow (UTC), or add your own API key in Settings (BYOK).',
            lingmodel_pro_daily_limit: tierCaps.dailyPrompt,
            lingmodel_pro_prompts_today: c,
            product: 'LingModel',
            tier
          });
        }
        throw e;
      }
    }

    const anthropicVersion = req.headers['anthropic-version'] || '2023-06-01';

    const upstreamMessagesUrl = lingmodelAnthropicMessagesUrl(db);
    const upstreamBody = applyLingModelCostControls(req.body, { isPro, tier, config: loadLingModelConfig(db), upstreamUrl: upstreamMessagesUrl });
    let upstream;
    try {
      // Anthropic-compat vendors (DeepSeek, Moonshot Kimi, …) typically accept Bearer;
      // `x-api-key` mirrors the Messages API convention for portability.
      upstream = await fetch(upstreamMessagesUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': ownerKey,
          'authorization': `Bearer ${ownerKey}`,
          'anthropic-version': anthropicVersion
        },
        body: JSON.stringify(upstreamBody)
      });
    } catch (e) {
      console.error('LingModel upstream fetch failed:', upstreamMessagesUrl.slice(0, 80), e);
      return res.status(502).json({ error: 'Upstream request failed' });
    }

    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) {
      res.setHeader('Content-Type', ct);
    }
    res.setHeader('X-LingModel-Tier', isPro ? 'pro' : 'free');
    res.setHeader('X-LingModel-Reset', nextUtcMidnightIso());
    if (!isPro && freeUsage) {
      const promptsRemaining =
        limits.freeDailyPromptLimit > 0
          ? Math.max(0, limits.freeDailyPromptLimit - freeUsage.dayCount)
          : -1;
      const dayTokensRemaining =
        limits.freeDailyOutputTokens > 0
          ? Math.max(0, limits.freeDailyOutputTokens - freeUsage.dayTokens)
          : -1;
      const monthTokensRemaining =
        limits.freeMonthlyOutputTokens > 0
          ? Math.max(0, limits.freeMonthlyOutputTokens - freeUsage.monthTokens)
          : -1;
      res.setHeader('X-LingModel-Prompts-Remaining-Today', String(promptsRemaining));
      res.setHeader('X-LingModel-Tokens-Remaining-Today', String(dayTokensRemaining));
      res.setHeader('X-LingModel-Tokens-Remaining-Month', String(monthTokensRemaining));
    }

    // Capture upstream rejection bodies so Kimi/DeepSeek error reasons land
    // in the journal. Without this `res.status(...); res.send(...)` forwards
    // the body straight through and we lose it. Error responses are small
    // JSON blobs, never streams — safe to buffer.
    if (upstream.status >= 400) {
      const text = upstream.body ? await upstream.text() : '';
      console.error('LingModel upstream rejected', {
        user: user.email || user.id,
        model: upstreamBody && upstreamBody.model,
        status: upstream.status,
        body: text.slice(0, 500),
      });
      return res.send(text);
    }

    if (!upstream.body) {
      const text = await upstream.text();
      return res.send(text);
    }

    // Nginx's default `proxy_buffering on` collects the upstream SSE into
    // ~4-64 KB buffers, so every `content_block_delta` accumulates on the
    // droplet and only flushes when the upstream connection closes —
    // the client sees one-shot "all-at-once" responses instead of a stream.
    // `X-Accel-Buffering: no` is the per-response nginx opt-out.
    if (typeof ct === 'string' && ct.toLowerCase().includes('text/event-stream')) {
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
    }

    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', (err) => {
      console.error('LingModel upstream stream error:', err);
      if (!res.headersSent) {
        res.status(502).end();
      }
    });

    if (upstream.ok) {
      const tap = createUsageTap();
      let committed = false;
      const commitUsage = () => {
        if (committed) return;
        committed = true;
        const tokens = tap.lastOutputTokens || 0;
        if (tokens <= 0) return;
        try {
          if (isPro) {
            db.prepare(
              `UPDATE users SET
                 lingmodel_pro_day_output_tokens =
                   CASE WHEN lingmodel_pro_day = ? THEN lingmodel_pro_day_output_tokens + ? ELSE ? END,
                 lingmodel_pro_month_output_tokens =
                   CASE WHEN lingmodel_pro_month = ? THEN lingmodel_pro_month_output_tokens + ? ELSE ? END,
                 lingmodel_pro_day = ?,
                 lingmodel_pro_month = ?
               WHERE id = ?`
            ).run(utcToday(), tokens, tokens, utcMonth(), tokens, tokens, utcToday(), utcMonth(), user.id);
          } else {
            db.prepare(
              `UPDATE users SET
                 lingmodel_free_day_output_tokens =
                   CASE WHEN lingmodel_free_day = ? THEN lingmodel_free_day_output_tokens + ? ELSE ? END,
                 lingmodel_free_month_output_tokens =
                   CASE WHEN lingmodel_free_month = ? THEN lingmodel_free_month_output_tokens + ? ELSE ? END,
                 lingmodel_free_day = ?,
                 lingmodel_free_month = ?
               WHERE id = ?`
            ).run(utcToday(), tokens, tokens, utcMonth(), tokens, tokens, utcToday(), utcMonth(), user.id);
          }
        } catch (err) {
          console.error('LingModel token accounting failed:', err);
        }
      };
      tap.on('end', commitUsage);
      nodeStream.on('error', commitUsage);
      nodeStream.pipe(tap).pipe(res);
    } else {
      nodeStream.pipe(res);
    }
  });

  return router;
}

// Admin "Test" button: send a tiny messages request to the EFFECTIVE upstream
// URL with the EFFECTIVE key (same DB-over-env resolution the proxy uses) and
// measure latency, so an operator can confirm a URL/key change actually works
// before relying on it. Costs a few tokens. Mirrors image-generation.testUpstream.
async function testLingModelUpstream(db) {
  const url = lingmodelAnthropicMessagesUrl(db);
  const key = lingmodelUpstreamApiKey(db);
  if (!key) return { ok: false, message: 'No upstream key configured (DB or env).' };
  const model = loadLingModelConfig(db).defaultModel || LINGMODEL_FALLBACK_MODEL;
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'authorization': `Bearer ${key}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
    });
  } catch (err) {
    return { ok: false, message: `Upstream unreachable: ${err.message}`, upstream: url.slice(0, 80) };
  }
  const latencyMs = Date.now() - startedAt;
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (_) { /* ignore */ }
    return {
      ok: false, status: res.status, latencyMs, model, upstream: url.slice(0, 80),
      message: (detail.slice(0, 400) || `HTTP ${res.status}`),
    };
  }
  // Drain the body so the socket can return to the keep-alive pool.
  try { await res.text(); } catch (_) { /* ignore */ }
  return { ok: true, status: res.status, latencyMs, model, upstream: url.slice(0, 80) };
}

module.exports = {
  createInferenceRouter,
  testLingModelUpstream,
  LINGMODEL_CONFIG_KEYS,
  LINGMODEL_CONFIG_SECRETS,
  LINGMODEL_LIMIT_KEYS,        // numeric tier limits, admin-editable via app_config
  loadLingModelConfig,
  lingmodelAnthropicMessagesUrl, // reused by the Slack Events webhook (slack-inference.js)
  lingmodelUpstreamApiKey,       // reused by the Slack Events webhook (slack-inference.js)
  loadLingModelLimits,         // snapshot of all 13 tier-limit numbers (DB-first → env → default)
  lingModelConfigValue,
  lingModelLimitValue,
  paidTierCaps,
  isFreshUserTurn,             // exported for the test suite
  HOSTED_LIMIT,
  LINGMODEL_PRO_DAILY_PROMPT_LIMIT,
  LINGMODEL_PRO_5H_PROMPT_LIMIT,
  LINGMODEL_PRO_DAILY_OUTPUT_TOKENS,
  LINGMODEL_PRO_MONTHLY_OUTPUT_TOKENS,
  LINGMODEL_FREE_DAILY_PROMPT_LIMIT,
  LINGMODEL_FREE_DAILY_OUTPUT_TOKENS,
  LINGMODEL_FREE_MONTHLY_OUTPUT_TOKENS,
  LINGMODEL_FREE_BURST_PER_MIN,
  current5hWindowKey,
  currentWindowEndMs,
};
