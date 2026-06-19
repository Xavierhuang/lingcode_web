'use strict';

/**
 * LingModel image-generation endpoint.
 *
 * Forwards a user prompt to OpenAI's `images/generations` (model `gpt-image-1`)
 * and returns a base64-encoded PNG. Auth + tier gating mirror the text proxy in
 * `inference-anthropic.js` so we inherit the same bearer-token surface and
 * admin-overridable config story (`app_config` table).
 *
 * Branding rule: never name the upstream in user-visible strings. Internal
 * logs OK.
 */

const express = require('express');
const { getUserFromRequest } = require('./auth-helpers');

/** Per-tier monthly image generation cap defaults. Override via app_config keys
 *  IMAGE_QUOTA_FREE / IMAGE_QUOTA_PRO / IMAGE_QUOTA_MAX_PRO (or matching env vars).
 *  Free cap intentionally low so upstream cost stays bounded — gpt-image-1 is
 *  $0.04–0.17/image, so 20/free user/mo is ~$0.80–3.40. */
const DEFAULT_IMAGE_QUOTAS = {
  free: 20,
  pro: 1000,
  max_pro: 10000,
};

/** Allowed image sizes from the client. Anything else 400s — keeps the upstream
 *  bill predictable. */
const ALLOWED_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024']);

/**
 * Resolve the operator-configurable OpenAI key (DB-first, then env).
 * @param {import('better-sqlite3').Database} db
 */
function openaiApiKey(db) {
  if (db) {
    try {
      const row = db
        .prepare('SELECT value FROM app_config WHERE key = ?')
        .get('LINGMODEL_IMAGE_UPSTREAM_KEY');
      if (row && typeof row.value === 'string' && row.value.trim()) {
        return row.value.trim();
      }
    } catch (_) { /* table may not exist on first boot */ }
  }
  return (process.env.LINGMODEL_IMAGE_UPSTREAM_KEY || process.env.OPENAI_API_KEY || '').trim();
}

/**
 * Resolve the upstream URL (lets ops point at a different vendor without a code
 * change; defaults to OpenAI).
 * @param {import('better-sqlite3').Database} db
 */
function imageUpstreamUrl(db) {
  if (db) {
    try {
      const row = db
        .prepare('SELECT value FROM app_config WHERE key = ?')
        .get('LINGMODEL_IMAGE_UPSTREAM_URL');
      if (row && typeof row.value === 'string' && row.value.trim()) {
        return row.value.trim();
      }
    } catch (_) { /* fall through */ }
  }
  return (process.env.LINGMODEL_IMAGE_UPSTREAM_URL || 'https://api.openai.com/v1/images/generations').trim();
}

/**
 * Tier → monthly cap. DB row wins over env var. Returns 0 (unlimited) if both
 * are blank or invalid — operators can intentionally set 0 on max_pro.
 * @param {import('better-sqlite3').Database} db
 * @param {string} tier
 */
function imageQuotaFor(db, tier) {
  const key = tier === 'max_pro' ? 'IMAGE_QUOTA_MAX_PRO'
            : tier === 'pro'     ? 'IMAGE_QUOTA_PRO'
            : 'IMAGE_QUOTA_FREE';
  if (db) {
    try {
      const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
      if (row && typeof row.value === 'string' && row.value.trim()) {
        const n = parseInt(row.value.trim(), 10);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    } catch (_) { /* fall through */ }
  }
  const env = process.env[key];
  if (env !== undefined) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_IMAGE_QUOTAS[tier] ?? DEFAULT_IMAGE_QUOTAS.free;
}

function utcMonthKey(now = new Date()) {
  return now.toISOString().slice(0, 7); // "YYYY-MM"
}

/**
 * Read the current month's usage from a user row. If the stored month key
 * doesn't match the current UTC month, the count is treated as 0 — the actual
 * reset to the DB happens lazily inside `incrementMonthCount`.
 * @returns {number}
 */
function currentMonthCount(user, monthKey) {
  if (user.lingmodel_image_month === monthKey) {
    return Number(user.lingmodel_image_month_count || 0);
  }
  return 0;
}

/**
 * Increment the user's monthly counter atomically. If the month key changed,
 * resets the count to 1 in the same statement.
 */
function incrementMonthCount(db, userId, monthKey) {
  const stmt = db.prepare(`
    UPDATE users
       SET lingmodel_image_month = ?,
           lingmodel_image_month_count = CASE
             WHEN lingmodel_image_month = ? THEN lingmodel_image_month_count + 1
             ELSE 1
           END
     WHERE id = ?
  `);
  stmt.run(monthKey, monthKey, userId);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {import('express').Router}
 */
function createImageRouter(db) {
  const router = express.Router();

  // GET /quota — lets the Mac client surface "you have N images remaining"
  // without burning a generation. Anon users get 401.
  router.get('/quota', (req, res) => {
    const user = getUserFromRequest(db, req);
    if (!user) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const tier = String(user.tier || 'free').toLowerCase();
    const quota = imageQuotaFor(db, tier);
    const month = utcMonthKey();
    const used = currentMonthCount(user, month);
    return res.json({
      tier,
      monthly_quota: quota,
      used_this_month: used,
      remaining: quota === 0 ? null : Math.max(0, quota - used),
      month,
    });
  });

  // POST /generate — body: { prompt: string, size?: "1024x1024"|... }
  // Returns: { b64_json: string, used_this_month: number, monthly_quota: number }
  // Error codes: 401 unauthorized, 402 over-quota, 400 bad input,
  //              503 upstream not configured, 502 upstream error.
  router.post('/generate', express.json({ limit: '64kb' }), async (req, res) => {
    const user = getUserFromRequest(db, req);
    if (!user) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const size = typeof req.body?.size === 'string' ? req.body.size : '1024x1024';

    if (!prompt) {
      return res.status(400).json({ error: 'prompt_required' });
    }
    if (prompt.length > 4000) {
      return res.status(400).json({ error: 'prompt_too_long', limit: 4000 });
    }
    if (!ALLOWED_SIZES.has(size)) {
      return res.status(400).json({ error: 'invalid_size', allowed: [...ALLOWED_SIZES] });
    }

    const tier = String(user.tier || 'free').toLowerCase();
    const quota = imageQuotaFor(db, tier);
    const month = utcMonthKey();
    const used = currentMonthCount(user, month);

    if (quota > 0 && used >= quota) {
      return res.status(402).json({
        error: 'image_quota_reached',
        message: `LingModel image quota reached for the month (${used}/${quota}). Resets on the 1st (UTC).`,
        monthly_quota: quota,
        used_this_month: used,
        tier,
      });
    }

    const apiKey = openaiApiKey(db);
    if (!apiKey) {
      return res.status(503).json({ error: 'upstream_not_configured' });
    }
    const upstream = imageUpstreamUrl(db);

    // gpt-image-1 returns b64-encoded PNG by default.
    let upstreamRes;
    try {
      upstreamRes = await fetch(upstream, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-image-1',
          prompt,
          size,
          n: 1,
        }),
      });
    } catch (err) {
      return res.status(502).json({ error: 'upstream_unreachable', message: err.message });
    }

    if (!upstreamRes.ok) {
      let detail = '';
      try { detail = await upstreamRes.text(); } catch (_) { /* ignore */ }
      // Don't leak the upstream error body to the client — keep the surface
      // generic, log the detail server-side for ops.
      // eslint-disable-next-line no-console
      console.error('[image-generation] upstream', upstreamRes.status, detail);
      return res.status(502).json({ error: 'upstream_error', status: upstreamRes.status });
    }

    let upstreamJson;
    try {
      upstreamJson = await upstreamRes.json();
    } catch (_) {
      return res.status(502).json({ error: 'upstream_bad_response' });
    }

    const b64 = upstreamJson?.data?.[0]?.b64_json;
    if (typeof b64 !== 'string' || !b64) {
      return res.status(502).json({ error: 'upstream_missing_image' });
    }

    // Charge the user only after a successful generation.
    try {
      incrementMonthCount(db, user.id, month);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[image-generation] counter increment failed', err);
      // Don't fail the request — we already paid the upstream cost.
    }

    return res.json({
      b64_json: b64,
      used_this_month: used + 1,
      monthly_quota: quota,
      tier,
    });
  });

  return router;
}

/**
 * Admin-only diagnostic: send a single tiny generation request to the
 * configured upstream and return success/failure. Does NOT charge any user
 * quota. Used by the dashboard's "Test key" button so operators can confirm
 * the OpenAI key works without round-tripping through the Mac client.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{ ok: boolean, status?: number, message?: string, upstream?: string, b64_present?: boolean }>}
 */
async function testUpstream(db) {
  const apiKey = openaiApiKey(db);
  if (!apiKey) {
    return { ok: false, message: 'No upstream key configured (DB or env).' };
  }
  const upstream = imageUpstreamUrl(db);
  let res;
  try {
    res = await fetch(upstream, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: 'a single small green dot on a white background',
        size: '1024x1024',
        n: 1,
      }),
    });
  } catch (err) {
    return { ok: false, message: `Upstream unreachable: ${err.message}`, upstream };
  }
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (_) { /* ignore */ }
    // Truncate so the dashboard doesn't render a megabyte of HTML if the
    // upstream returned a stack trace page.
    return {
      ok: false,
      status: res.status,
      message: detail.slice(0, 500) || `HTTP ${res.status}`,
      upstream,
    };
  }
  let json;
  try { json = await res.json(); } catch (_) {
    return { ok: false, status: res.status, message: 'Upstream returned non-JSON.', upstream };
  }
  const hasImage = typeof json?.data?.[0]?.b64_json === 'string' && json.data[0].b64_json.length > 0;
  return { ok: hasImage, status: res.status, b64_present: hasImage, upstream };
}

module.exports = {
  createImageRouter,
  DEFAULT_IMAGE_QUOTAS,
  ALLOWED_SIZES,
  imageQuotaFor,
  utcMonthKey,
  currentMonthCount,
  testUpstream,
};
