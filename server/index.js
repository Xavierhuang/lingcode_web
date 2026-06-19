'use strict';

/**
 * LingCode admin API + OAuth start page for the Mac app (GET /oauth/authorize).
 * Deploy: run on 127.0.0.1:PORT, proxy /api and /oauth from nginx to this process.
 * Configure ADMIN_PASSWORD or ADMIN_PASSWORD_HASH, SESSION_SECRET, NODE_ENV=production.
 * Local: ADMIN_DEV_STATIC=1 npm run dev — test OAuth at http://127.0.0.1:3000/oauth/authorize?redirect_uri=lingcode://auth/callback&state=test
 * Web account: redirect_uri must be {PUBLIC_ORIGIN}/oauth/web-callback (see signin.html). Sets session + redirects to /account.html
 * Production Info.plist: LingCodeAuthSignInURL = https://lingcode.dev/oauth/authorize
 *
 * Stripe (Cursor-style Pro): set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, Price IDs, webhook URL /api/stripe/webhook
 *
 * Password reset: RESEND_API_KEY (+ optional RESEND_FROM). Forgot/reset flows in forgot-password.html and reset-password.html.
 * Sign-up verification: same Resend; new accounts get email_verified=0 until GET /api/account/verify-email?token=...
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const Stripe = require('stripe');
const http = require('http');
const { migrateUsersTable, migrateStatsTables, migrateTelemetryTables, migrateCLITables, migrateSavedPrototypesTable, migrateSupabaseTables, migrateSecretsVaultTable, migratePrototypeDomainsTable, migrateCollabTables, migrateAppConfigTable, migrateAgentSdkTables, migrateFeedbackTable, migrateCloudBackendTables, migrateCloudAppsTables, migrateProjectsTables, migrateCloudTelemetryTables, migrateSlackTables, migrateRemoteHostsTable } = require('./migrate');
const { initCollabServer } = require('./collab-server');
const { registerCollabRoutes } = require('./collab-routes');
const { registerRemoteRoutes } = require('./remote-routes');
const { registerSavedPrototypeRoutes, registerPublicShareRoute } = require('./saved-prototypes');
const { handleStripeEvent } = require('./stripe-webhook');
const { registerBillingRoutes } = require('./stripe-billing');
const { getUserFromRequest } = require('./auth-helpers');
const {
  createInferenceRouter,
  LINGMODEL_CONFIG_KEYS,
  LINGMODEL_LIMIT_KEYS,
  loadLingModelLimits,
  LINGMODEL_CONFIG_SECRETS,
  paidTierCaps,
  HOSTED_LIMIT,
  LINGMODEL_FREE_DAILY_PROMPT_LIMIT,
  LINGMODEL_FREE_DAILY_OUTPUT_TOKENS,
  LINGMODEL_FREE_MONTHLY_OUTPUT_TOKENS,
  current5hWindowKey,
  currentWindowEndMs,
  testLingModelUpstream,
} = require('./inference-anthropic');
const { sendResendEmail } = require('./mail-resend');
const { createSlackEventsHandler } = require('./slack-events');

const PORT = parseInt(process.env.PORT || '3000', 10);
const app = express();

// Prometheus metrics: time every request (low-cardinality route labels). Added
// first so it wraps all downstream handlers. No-op if prom-client is absent.
const metrics = require('./metrics');
app.use(metrics.middleware());

const dbPath = path.join(__dirname, 'data.db');
const db = new Database(dbPath);

// Enable WAL early — concurrent reads during writes matter for the session
// store (every request reads + writes a session row) and the Yjs collab
// snapshot writes. Idempotent; safe to run on every boot.
try { db.pragma('journal_mode = WAL'); } catch (_) {}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL,
  source TEXT DEFAULT ''
);
`);
migrateUsersTable(db);
migrateStatsTables(db);
migrateTelemetryTables(db);
migrateCLITables(db);
migrateSavedPrototypesTable(db);
migrateSupabaseTables(db);
migrateSecretsVaultTable(db);
migratePrototypeDomainsTable(db);
migrateCollabTables(db);
migrateAppConfigTable(db);
migrateAgentSdkTables(db);
migrateFeedbackTable(db);
migrateCloudBackendTables(db);
migrateCloudAppsTables(db); // after CloudBackend: ALTERs custom_domains created there
migrateProjectsTables(db); // after CloudBackend + CloudApps: unified project entity + backfill
migrateCloudTelemetryTables(db); // analytics/perf/crash aggregates (backbone ①)
migrateSlackTables(db);
migrateRemoteHostsTable(db); // easy-remote-coding hosts (room id == host id)

// Deep Agent startup housekeeping: drop stale usage rows (>13 months) and
// remove on-disk workspace dirs that survived a server restart but have no
// in-memory session. Both are best-effort; failures log to stderr but
// don't block boot.
try {
  const _das = require('./agent-sdk-session');
  const _dab = require('./agent-sdk-budget');
  const orphans = _das.sweepOrphanedWorkspaces(db);
  if (orphans.dirs_removed > 0 || orphans.rows_closed > 0) {
    console.log(`[deep-agent] startup sweep: removed ${orphans.dirs_removed} orphaned workspace dir(s), closed ${orphans.rows_closed} session row(s)`);
  }
  const old = _dab.sweepOldUsage(db, 13);
  if (old.usage_deleted > 0 || old.overrides_deleted > 0) {
    console.log(`[deep-agent] startup sweep: dropped ${old.usage_deleted} usage row(s) + ${old.overrides_deleted} override row(s) older than ${old.cutoff}`);
  }
} catch (e) {
  console.error('[deep-agent] startup sweep failed (non-fatal):', e && e.message);
}

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

app.set('trust proxy', 1);

// Customer custom domains mapped to a hosted Worker: reverse-proxy the RAW
// request to the worker's run.lingcode.dev origin BEFORE any body parser or
// path-based route below, so the whole site — including raw webhook POSTs —
// runs on the customer's own domain. Apex/site traffic is untouched.
require('./cloud-domains').installWorkerDomainProxy(app, db);

app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(503).send('Stripe webhook not configured');
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Stripe webhook signature:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    try {
      await handleStripeEvent(stripe, db, event);
    } catch (e) {
      console.error('Stripe webhook handler:', e);
      return res.status(500).json({ error: 'Webhook handler failed' });
    }
    res.json({ received: true });
  }
);

// Slack Events API webhook. Uses express.raw() so the handler can verify the
// HMAC signature against the exact bytes Slack sent — same raw-body constraint
// as the Stripe webhook above, which is why it sits before the global parser.
app.post(
  '/api/slack/events',
  express.raw({ type: 'application/json' }),
  createSlackEventsHandler(db)
);

// Skip the global 128KB JSON parser for inference routes — they ship
// vision images (base64-encoded, can hit tens of MB) and have their own
// 50MB parser at the route level. Without this skip, the global parser
// runs first and 413s before the route-level parser gets a chance.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/inference/')) return next();
  // /api/feedback carries an optional base64-encoded screenshot data URL.
  // The route's own parser (below) is sized for it; let it through instead
  // of letting the 128KB global guard 413 the request before the route runs.
  if (req.path === '/api/feedback') return next();
  // Cloud Apps upload (POST/PUT /api/account/cloud-apps[/:id]) streams a gzip'd
  // tar of a built dist tree (up to 100MB) and reads the RAW request stream —
  // the global parser would 413 it first. The custom-domain sub-routes under
  // this prefix attach their own express.json() in cloud-apps.js.
  if (req.path.startsWith('/api/account/cloud-apps')) return next();
  // Cloud Workers (white-label compute) upload streams a gzip'd tar of a built
  // dist/ tree (Worker + assets) and reads the RAW request stream, same as
  // cloud-apps above.
  if (req.path.startsWith('/api/account/cloud-workers')) return next();
  // Saved prototypes / short links carry the full prototype payload (gzipped
  // HTML, up to SHARE_MAX) + a live-screenshot thumbnail + gzipped chat history.
  // The client (preview.js fitSavedPrototypeBody) keeps the body under ~15MB by
  // shedding the thumbnail/history when needed; 16mb here matches that ceiling
  // (nginx allows 25–32m). Without this the 128KB global guard would 413 it
  // first ("Could not create short link: http_413").
  if (req.path.startsWith('/api/account/saved-prototypes')) {
    return express.json({ limit: '16mb', verify: captureRawBody })(req, res, next);
  }
  return express.json({ limit: '128kb', verify: captureRawBody })(req, res, next);
});

// Stash the exact request bytes so handlers that need them (serverless-function
// webhook receivers verifying a Stripe/GitHub signature off ctx.request.rawBody)
// get the original payload, not a re-serialized copy. Cheap: just keeps the buffer.
function captureRawBody(req, _res, buf) { if (buf && buf.length) req.rawBody = buf; }

// ─────────────────────────────────────────────────────────────────────────────
// SLACK INTEGRATION
//
// Two surfaces:
//   1. Bot install (public, distributed) — anyone can add the bot to their workspace.
//   2. Ship & Announce link (authenticated) — signed-in LingCode users connect
//      their workspace so the IDE's Announce button posts via the bot instead of
//      requiring a manually-configured incoming webhook.
//
// Required env: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET
// ─────────────────────────────────────────────────────────────────────────────

// Bot token scopes requested at install time. Shared by both the IDE-initiated
// install-link (state-bound to a LingCode user) and the public Add-to-Slack
// redirect on the marketing landing page, so the two never drift apart.
const SLACK_OAUTH_SCOPES = [
  'app_mentions:read', 'chat:write', 'channels:read', 'channels:join',
  'groups:read', 'im:history', 'im:read', 'mpim:read',
].join(',');

function buildSlackAuthorizeURL({ clientId, publicOrigin, state }) {
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', SLACK_OAUTH_SCOPES);
  url.searchParams.set('redirect_uri', `${publicOrigin}/api/slack/oauth/callback`);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

// Return the Slack OAuth install URL with a state nonce tied to the current
// LingCode user. The IDE calls this, then opens the URL in the browser.
// On completion, Slack redirects to /api/slack/oauth/callback with the nonce.
app.get('/api/slack/install-link', (req, res) => {
  const user = getUserFromRequest(db, req);
  if (!user) return res.status(401).json({ error: 'auth required' });

  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) return res.status(503).json({ error: 'Slack not configured on server' });

  // Purge expired nonces (>15 min old) to keep the table tidy.
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM slack_link_states WHERE created_at < ?').run(cutoff);

  const nonce = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO slack_link_states (state_nonce, lingcode_user_id, created_at) VALUES (?, ?, ?)')
    .run(nonce, user.id, new Date().toISOString());

  const publicOrigin = String(process.env.PUBLIC_ORIGIN || 'https://lingcode.dev').replace(/\/$/, '');
  res.json({ url: buildSlackAuthorizeURL({ clientId, publicOrigin, state: nonce }) });
});

// Public Add-to-Slack entry point for the marketing landing page (slack.html).
// No auth and no state nonce: an anonymous visitor installs the bot into their
// own workspace, and the OAuth callback's no-state branch shows the success
// page (the workspace is recorded in slack_installations either way). This is
// the URL the Slack Marketplace listing's "Add to Slack" button points at, and
// it keeps SLACK_CLIENT_ID server-side instead of baking it into static HTML.
app.get('/api/slack/install', (req, res) => {
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) return res.status(503).send('Slack is not configured on this server.');
  const publicOrigin = String(process.env.PUBLIC_ORIGIN || 'https://lingcode.dev').replace(/\/$/, '');
  res.redirect(302, buildSlackAuthorizeURL({ clientId, publicOrigin }));
});

// OAuth callback — handles both anonymous Add-to-Slack installs and
// IDE-initiated installs that carry a state nonce linking to a LingCode user.
app.get('/api/slack/oauth/callback', async (req, res) => {
  const { code, error, state } = req.query;

  if (error) return res.status(400).send(`Slack OAuth Error: ${error}`);
  if (!code) return res.status(400).send('Missing OAuth code');

  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).send('Slack App not configured on server');

  const publicOrigin = String(process.env.PUBLIC_ORIGIN || 'https://lingcode.dev').replace(/\/$/, '');

  try {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: String(code),
      redirect_uri: `${publicOrigin}/api/slack/oauth/callback`,
    });

    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      body: params,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const data = await response.json();

    if (!data.ok) {
      console.error('Slack OAuth exchange failed:', data.error);
      return res.status(400).send(`Slack OAuth exchange failed: ${data.error}`);
    }

    const { access_token, team, bot_user_id } = data;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO slack_installations (team_id, team_name, bot_token, bot_user_id, installed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id) DO UPDATE SET
        team_name = excluded.team_name,
        bot_token = excluded.bot_token,
        bot_user_id = excluded.bot_user_id,
        updated_at = excluded.updated_at
    `).run(team.id, team.name, access_token, bot_user_id, now, now);

    // If state nonce was provided, link this workspace to the LingCode user.
    if (state) {
      const linkState = db.prepare(
        'SELECT lingcode_user_id FROM slack_link_states WHERE state_nonce = ?'
      ).get(String(state));

      if (linkState) {
        db.prepare('DELETE FROM slack_link_states WHERE state_nonce = ?').run(String(state));
        db.prepare(`
          INSERT INTO slack_user_links
            (lingcode_user_id, team_id, workspace_name, channel_id, channel_name, linked_at, updated_at)
          VALUES (?, ?, ?, NULL, NULL, ?, ?)
          ON CONFLICT(lingcode_user_id) DO UPDATE SET
            team_id = excluded.team_id,
            workspace_name = excluded.workspace_name,
            channel_id = NULL,
            channel_name = NULL,
            updated_at = excluded.updated_at
        `).run(linkState.lingcode_user_id, team.id, team.name, now, now);

        // Redirect back to the IDE to pick a channel.
        const deepLink = new URL('lingcode://slack/connected');
        deepLink.searchParams.set('workspace', team.name);
        deepLink.searchParams.set('team_id', team.id);
        return res.redirect(302, deepLink.toString());
      }
    }

    // Anonymous / non-IDE install: show the classic success page.
    res.send(`
      <html>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
          <div style="text-align: center;">
            <h1 style="color: #4A154B;">LingCode Bot Installed!</h1>
            <p>Successfully connected to <strong>${escapeHtml(team.name)}</strong>.</p>
            <p>You can now close this window and start using the bot in Slack.</p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('Slack OAuth system error:', err);
    res.status(500).send('Internal Server Error during Slack OAuth');
  }
});

// Returns the current user's Slack link status.
app.get('/api/slack/link-status', (req, res) => {
  const user = getUserFromRequest(db, req);
  if (!user) return res.status(401).json({ error: 'auth required' });

  const link = db.prepare(
    'SELECT workspace_name, team_id, channel_id, channel_name FROM slack_user_links WHERE lingcode_user_id = ?'
  ).get(user.id);

  if (!link) return res.json({ linked: false });
  res.json({
    linked: true,
    workspace_name: link.workspace_name,
    team_id: link.team_id,
    channel_id: link.channel_id || null,
    channel_name: link.channel_name || null,
  });
});

// Lists public Slack channels the bot can post to in the user's linked workspace.
app.get('/api/slack/channels', async (req, res) => {
  const user = getUserFromRequest(db, req);
  if (!user) return res.status(401).json({ error: 'auth required' });

  const link = db.prepare('SELECT team_id FROM slack_user_links WHERE lingcode_user_id = ?').get(user.id);
  if (!link) return res.status(404).json({ error: 'no linked workspace' });

  const installation = db.prepare('SELECT bot_token FROM slack_installations WHERE team_id = ?').get(link.team_id);
  if (!installation) return res.status(404).json({ error: 'workspace installation not found' });

  try {
    const resp = await fetch(
      'https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200',
      { headers: { authorization: `Bearer ${installation.bot_token}` } }
    );
    const data = await resp.json();
    if (!data.ok) return res.status(502).json({ error: `Slack API: ${data.error}` });
    const channels = (data.channels || []).map((c) => ({ id: c.id, name: c.name, is_private: c.is_private || false }));
    res.json({ channels });
  } catch (err) {
    console.error('Slack channels fetch failed:', err);
    res.status(502).json({ error: 'failed to fetch channels from Slack' });
  }
});

// Saves the user's chosen channel and auto-joins the bot to it.
app.post('/api/slack/user-channel', async (req, res) => {
  const user = getUserFromRequest(db, req);
  if (!user) return res.status(401).json({ error: 'auth required' });

  const { channel_id, channel_name } = req.body || {};
  if (!channel_id || typeof channel_id !== 'string') return res.status(400).json({ error: 'channel_id required' });

  const link = db.prepare('SELECT team_id FROM slack_user_links WHERE lingcode_user_id = ?').get(user.id);
  if (!link) return res.status(404).json({ error: 'no linked workspace' });

  const installation = db.prepare('SELECT bot_token FROM slack_installations WHERE team_id = ?').get(link.team_id);
  if (!installation) return res.status(404).json({ error: 'workspace installation not found' });

  // Try to join the channel so the bot can post there (no-op if already a member,
  // silently fails for private channels — user must /invite the bot manually).
  await fetch('https://slack.com/api/conversations.join', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${installation.bot_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ channel: channel_id }),
  }).catch(() => {});

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE slack_user_links
    SET channel_id = ?, channel_name = ?, updated_at = ?
    WHERE lingcode_user_id = ?
  `).run(channel_id, channel_name || channel_id, now, user.id);

  res.json({ ok: true });
});

// Removes the user's Slack workspace link.
app.delete('/api/slack/link', (req, res) => {
  const user = getUserFromRequest(db, req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  db.prepare('DELETE FROM slack_user_links WHERE lingcode_user_id = ?').run(user.id);
  res.json({ ok: true });
});

// Posts a Ship & Announce message via the bot to the user's linked channel.
app.post('/api/slack/announce', async (req, res) => {
  const user = getUserFromRequest(db, req);
  if (!user) return res.status(401).json({ error: 'auth required' });

  const link = db.prepare(
    'SELECT team_id, channel_id FROM slack_user_links WHERE lingcode_user_id = ?'
  ).get(user.id);
  if (!link) return res.status(404).json({ error: 'no linked workspace — connect Slack in Settings first' });
  if (!link.channel_id) return res.status(400).json({ error: 'no channel selected — pick a channel in Settings first' });

  const installation = db.prepare('SELECT bot_token FROM slack_installations WHERE team_id = ?').get(link.team_id);
  if (!installation) return res.status(404).json({ error: 'workspace installation not found' });

  const { title, summary, commits, filesChanged, insertions, deletions, branch } = req.body || {};

  // Build Block Kit payload (same shape as SlackNotifier.swift buildPayload).
  const statsParts = [];
  if (filesChanged > 0) statsParts.push(`${filesChanged} file${filesChanged === 1 ? '' : 's'}`);
  if (insertions > 0) statsParts.push(`+${insertions}`);
  if (deletions > 0) statsParts.push(`-${deletions}`);
  if (branch) statsParts.push(`branch \`${branch}\``);
  const statsLine = statsParts.join(' · ');

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: String(title || 'Ship update'), emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: String(summary || '') } },
  ];
  if (Array.isArray(commits) && commits.length > 0) {
    const blob = commits.slice(0, 10).map((c) => `• \`${escapeHtml(String(c))}\``).join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: blob } });
  }
  if (statsLine) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statsLine }] });
  }

  try {
    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${installation.bot_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        channel: link.channel_id,
        text: `${title || 'Ship update'} — ${summary || ''}`,
        blocks,
      }),
    });
    const data = await resp.json();
    if (!data.ok) {
      console.error('Slack announce failed:', data.error);
      return res.status(502).json({ error: `Slack API: ${data.error}` });
    }
    res.json({ ok: true, ts: data.ts });
  } catch (err) {
    console.error('Slack announce error:', err);
    res.status(500).json({ error: 'failed to post to Slack' });
  }
});
app.use(express.urlencoded({ extended: true }));

const isProd = process.env.NODE_ENV === 'production';

const PUBLIC_ORIGIN = String(process.env.PUBLIC_ORIGIN || 'https://lingcode.dev').replace(/\/$/, '');
const WEB_OAUTH_REDIRECT = `${PUBLIC_ORIGIN}/oauth/web-callback`;

const PRICE_PRO_MONTHLY = String(process.env.STRIPE_PRICE_PRO_MONTHLY || '').trim();
const PRICE_PRO_ANNUAL = String(process.env.STRIPE_PRICE_PRO_ANNUAL || '').trim();
const PRICE_MAX_PRO_MONTHLY = String(process.env.STRIPE_PRICE_MAX_PRO_MONTHLY || '').trim();
const PRICE_MAX_PRO_ANNUAL = String(process.env.STRIPE_PRICE_MAX_PRO_ANNUAL || '').trim();

const LINGCODE_CALLBACK = 'lingcode://auth/callback';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeRedirectUri(raw) {
  if (!raw) return '';
  try {
    return decodeURIComponent(String(raw).trim());
  } catch {
    return String(raw).trim();
  }
}

/** @returns {'mac'|'web'|null} */
function classifyRedirectUri(uri) {
  const n = normalizeRedirectUri(uri);
  if (n === LINGCODE_CALLBACK) return 'mac';
  if (n === WEB_OAUTH_REDIRECT) return 'web';
  return null;
}

// SQLite-backed session store: survives API restart so users (and live collab
// sessions) aren't kicked on every deploy. Reuses the existing better-sqlite3
// connection. The store creates its `sessions` table on first init and runs
// expiry cleanup every 15 min.
const SqliteSessionStore = require('better-sqlite3-session-store')(session);
const sessionStore = new SqliteSessionStore({
  client: db,
  expired: { clear: true, intervalMs: 15 * 60 * 1000 },
});

const sessionMiddleware = session({
  name: 'lingcode.sid',
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'set-SESSION_SECRET-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProd,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
    ...(process.env.SESSION_COOKIE_DOMAIN
      ? { domain: process.env.SESSION_COOKIE_DOMAIN.trim() }
      : {})
  }
});
app.use(sessionMiddleware);

/**
 * Mac app opens this URL (LingCodeAuthSignInURL). User submits email; we redirect to lingcode://auth/callback
 * with access_token + email (+ state). Web uses the same form with redirect_uri = {PUBLIC_ORIGIN}/oauth/web-callback.
 */
app.get('/oauth/authorize', (req, res) => {
  const flow = classifyRedirectUri(req.query.redirect_uri || '');
  if (!flow) {
    return res.status(400).send(
      `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;"><p>Invalid <code>redirect_uri</code>. Use the Mac app, or sign in from this site with <code>redirect_uri=${escapeHtml(
        WEB_OAUTH_REDIRECT
      )}</code> (URL-encoded), or <code>${escapeHtml(LINGCODE_CALLBACK)}</code> for the app.</p></body></html>`
    );
  }
  const q = new URLSearchParams(req.query);
  if (!q.has('oauth_mode')) {
    q.set('oauth_mode', 'signin');
  }
  const oauthMode = String(q.get('oauth_mode') || 'signin').toLowerCase() === 'signup' ? 'signup' : 'signin';
  const hidden = [];
  q.forEach((value, key) => {
    hidden.push(`<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`);
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const isSignup = oauthMode === 'signup';
  const title = isSignup ? 'Create account — LingCode' : 'Sign in — LingCode';
  let intro;
  if (isSignup) {
    intro =
      flow === 'web'
        ? 'Create a new account. You will return to this website after you continue.'
        : 'Create a new LingCode account. After you continue, the app will open automatically.';
    if (process.env.RESEND_API_KEY && String(process.env.RESEND_API_KEY).trim()) {
      intro +=
        ' We will email you a link to verify this address before you can sign in.';
    }
  } else {
    intro =
      flow === 'web'
        ? 'Sign in with the email and password for your existing account. You will return to this website to view your account and billing.'
        : 'Sign in with your existing LingCode email and password. After you continue, the app will open automatically.';
  }
  const hint = isSignup
    ? `Already registered? <a href="${escapeHtml(PUBLIC_ORIGIN)}/signin.html" style="color:#8ab4ff;">Sign in</a> instead.`
    : `Need an account? <a href="${escapeHtml(PUBLIC_ORIGIN)}/signup.html" style="color:#8ab4ff;">Create one</a> first (sign-in never creates a new account).`;
  const forgotRow = isSignup
    ? ''
    : `<p style="margin: -6px 0 16px; font-size: 0.75rem;"><a href="${escapeHtml(PUBLIC_ORIGIN)}/forgot-password.html" style="color:#8ab4ff;">Forgot password?</a></p>`;
  const btn = isSignup ? 'Create account' : 'Sign in';
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #FAFAFF; --bg-card: #FFFFFF;
      --text: #1A1530; --text-muted: #5D5475; --text-dim: #8B829F;
      --border: rgba(26,21,48,0.10); --border-strong: rgba(26,21,48,0.16);
      --signal: #4f46e5;
    }
    body {
      font-family: 'Geist', -apple-system, system-ui, sans-serif;
      background: var(--bg);
      background-image: radial-gradient(120% 90% at 50% -10%, rgba(168,85,247,0.08), transparent 60%);
      color: var(--text);
      margin: 0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
    }
    .card {
      width: 100%; max-width: 400px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 28px;
      box-shadow: 0 24px 60px -32px rgba(58, 30, 120, 0.22);
    }
    h1 { font-size: 1.25rem; margin: 0 0 8px; font-weight: 600; letter-spacing: -0.01em; color: var(--text); }
    p { color: var(--text-muted); font-size: 0.9rem; margin: 0 0 20px; line-height: 1.5; }
    label { display: block; font-size: 0.75rem; font-weight: 600; color: var(--text-muted); margin-bottom: 6px; }
    input[type="email"], input[type="password"] {
      width: 100%; box-sizing: border-box;
      padding: 10px 12px; border-radius: 8px;
      border: 1px solid var(--border-strong);
      background: #fff; color: var(--text);
      font: inherit; font-size: 1rem;
      margin-bottom: 16px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    input[type="email"]:focus, input[type="password"]:focus {
      outline: none;
      border-color: var(--signal);
      box-shadow: 0 0 0 3px rgba(79,70,229,0.18);
    }
    button {
      width: 100%; padding: 11px;
      border-radius: 8px; border: none;
      background: var(--signal); color: #fff;
      font: inherit; font-weight: 500; font-size: 0.95rem;
      cursor: pointer;
      transition: filter 0.15s;
    }
    button:hover { filter: brightness(0.94); }
    .hint { margin-top: 16px; font-size: 0.75rem; color: var(--text-dim); line-height: 1.4; }
    .hint a { color: var(--signal); }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0E0B1F; --bg-card: #181428;
        --text: #F1EEFA; --text-muted: #B5ADC9; --text-dim: #8B829F;
        --border: rgba(255,255,255,0.10); --border-strong: rgba(255,255,255,0.18);
      }
      body { background-image: radial-gradient(120% 90% at 50% -10%, rgba(168,85,247,0.18), transparent 60%); }
      input[type="email"], input[type="password"] { background: rgba(255,255,255,0.04); }
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>${isSignup ? 'Create your LingCode account' : 'Sign in to LingCode'}</h1>
    <p>${escapeHtml(intro)}</p>
    <form method="POST" action="/oauth/complete">
      ${hidden.join('\n      ')}
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required minlength="8" autocomplete="${isSignup ? 'new-password' : 'current-password'}" placeholder="At least 8 characters">
      ${forgotRow}
      <button type="submit">${escapeHtml(btn)}</button>
    </form>
    <p class="hint">${hint}</p>
  </div>
</body>
</html>`);
});

const ACCOUNT_PASSWORD_MIN = 8;
const BCRYPT_COST = 12;

function hashAccountPassword(plain) {
  return bcrypt.hashSync(plain, BCRYPT_COST);
}

/**
 * Sign in only: user must already exist. Legacy rows without password_hash set hash on first successful submit.
 */
function signInAccount(email, password) {
  if (typeof password !== 'string' || password.length < ACCOUNT_PASSWORD_MIN) {
    return { ok: false, error: 'password_policy' };
  }
  const existing = db
    .prepare('SELECT id, email, tier, password_hash, email_verified FROM users WHERE email = ?')
    .get(email);
  if (!existing) {
    return { ok: false, error: 'no_account' };
  }
  if (existing.email_verified != null && Number(existing.email_verified) === 0) {
    return { ok: false, error: 'email_unverified' };
  }
  if (existing.password_hash) {
    if (!bcrypt.compareSync(password, existing.password_hash)) {
      return { ok: false, error: 'invalid_credentials' };
    }
  } else {
    const h = hashAccountPassword(password);
    db.prepare('UPDATE users SET password_hash = ?, source = ? WHERE id = ?').run(h, 'oauth', existing.id);
  }
  const row = db.prepare('SELECT id, email, tier, email_verified FROM users WHERE email = ?').get(email);
  return { ok: true, row };
}

/** Register only: reject if email already exists. Sends verification email when Resend is configured. */
async function signUpAccount(email, password, nextDest) {
  if (typeof password !== 'string' || password.length < ACCOUNT_PASSWORD_MIN) {
    return { ok: false, error: 'password_policy' };
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return { ok: false, error: 'account_exists' };
  }
  const id = crypto.randomUUID();
  const created = new Date().toISOString();
  const h = hashAccountPassword(password);
  const hasResend = process.env.RESEND_API_KEY && String(process.env.RESEND_API_KEY).trim();
  if (!hasResend) {
    db.prepare(
      'INSERT INTO users (id, email, tier, created_at, source, password_hash, email_verified) VALUES (?, ?, ?, ?, ?, ?, 1)'
    ).run(id, email, 'free', created, 'oauth', h);
    const row = db.prepare('SELECT id, email, tier, email_verified FROM users WHERE email = ?').get(email);
    return { ok: true, row };
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  // Same-origin path validation — protects the verify-email redirect from
  // open-redirect abuse if someone forges a signup with a malicious `next`.
  const safeNext = (typeof nextDest === 'string' && nextDest.startsWith('/') && !nextDest.startsWith('//'))
    ? nextDest : null;
  db.prepare(
    'INSERT INTO users (id, email, tier, created_at, source, password_hash, email_verified, email_verification_token, email_verification_expires, email_verification_next) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)'
  ).run(id, email, 'free', created, 'oauth', h, token, expires, safeNext);
  const verifyUrl = `${PUBLIC_ORIGIN}/api/account/verify-email?token=${encodeURIComponent(token)}`;
  const html = `<p>Thanks for signing up for LingCode.</p><p><a href="${escapeHtml(verifyUrl)}">Verify your email</a></p><p>This link expires in 48 hours.</p>`;
  const sent = await sendResendEmail({
    to: email,
    subject: 'Verify your LingCode email',
    html
  });
  if (!sent.ok) {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: false, error: 'mail_send_failed', detail: sent.error };
  }
  const row = db.prepare('SELECT id, email, tier, email_verified FROM users WHERE email = ?').get(email);
  return { ok: true, row };
}

function oauthErrorPage(message, extraLinkHtml) {
  const extra = extraLinkHtml || '';
  return `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;background:#0a0a0a;color:#f0f0f0;"><p>${message}</p>${extra}<p><a href="javascript:history.back()" style="color:#8ab4ff;">Back</a></p></body></html>`;
}

app.post('/oauth/complete', async (req, res) => {
  const flow = classifyRedirectUri(req.body.redirect_uri || '');
  if (!flow) {
    return res.status(400).send('Invalid redirect_uri');
  }
  const email = String(req.body.email || '')
    .trim()
    .toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).send('Invalid email');
  }
  const password = String(req.body.password || '');
  const oauthMode = String(req.body.oauth_mode || 'signin').toLowerCase() === 'signup' ? 'signup' : 'signin';
  let auth;
  try {
    auth = oauthMode === 'signup'
      ? await signUpAccount(email, password, req.body.next)
      : signInAccount(email, password);
  } catch (e) {
    console.error('oauth/complete:', e);
    return res.status(500).send('Something went wrong. Try again.');
  }
  if (!auth.ok) {
    if (auth.error === 'password_policy') {
      return res.status(400).send(oauthErrorPage(`Password must be at least ${ACCOUNT_PASSWORD_MIN} characters.`));
    }
    if (auth.error === 'no_account') {
      return res.status(404).send(
        oauthErrorPage(
          'No account for this email. Create one first.',
          `<p><a href="${escapeHtml(PUBLIC_ORIGIN)}/signup.html" style="color:#8ab4ff;">Create an account</a></p>`
        )
      );
    }
    if (auth.error === 'account_exists') {
      return res.status(409).send(
        oauthErrorPage(
          'An account with this email already exists. Sign in instead.',
          `<p><a href="${escapeHtml(PUBLIC_ORIGIN)}/signin.html" style="color:#8ab4ff;">Sign in</a></p>`
        )
      );
    }
    if (auth.error === 'email_unverified') {
      return res.status(403).send(
        oauthErrorPage(
          'Verify your email before signing in. Check your inbox or use the link on the sign-up confirmation page to resend.',
          `<p><a href="${escapeHtml(PUBLIC_ORIGIN)}/verify-email-sent.html?email=${encodeURIComponent(email)}" style="color:#8ab4ff;">Resend verification email</a></p>`
        )
      );
    }
    if (auth.error === 'mail_send_failed') {
      return res.status(502).send(
        oauthErrorPage('Could not send the verification email. Check RESEND on the server or try again.')
      );
    }
    return res.status(401).send(oauthErrorPage('Invalid email or password.'));
  }
  const row = auth.row;
  // Referral attribution — only on a fresh signup, guarded so it never throws.
  if (oauthMode === 'signup' && row) referrals.attributeOnSignup(db, req, row.id);
  const state = req.body.state != null ? String(req.body.state) : '';

  if (oauthMode === 'signup' && Number(row.email_verified) === 0) {
    if (flow === 'web') {
      return res.redirect(
        302,
        `${PUBLIC_ORIGIN}/verify-email-sent.html?email=${encodeURIComponent(email)}`
      );
    }
    const p = new URLSearchParams();
    p.set('error', 'verification_required');
    p.set(
      'error_description',
      'Check your email to verify your account. Then use Sign in with Browser.'
    );
    if (state) {
      p.set('state', state);
    }
    return res.redirect(302, `${LINGCODE_CALLBACK}?${p.toString()}`);
  }

  if (flow === 'web') {
    req.session.account = {
      userId: row.id,
      email: row.email,
      tier: row.tier
    };
    return req.session.save((err) => {
      if (err) {
        return res.status(500).send('Could not start session');
      }
      // Honor `next` (forwarded from /signin.html?next=…) so callers like
      // /try.html land back where they came from. Same-origin paths only.
      const nextRaw = String(req.body.next || '');
      const safeNext = nextRaw.startsWith('/') && !nextRaw.startsWith('//')
        ? nextRaw : '/account.html';
      res.redirect(302, `${PUBLIC_ORIGIN}${safeNext}`);
    });
  }

  // Reuse the existing api_access_token if one already exists for this user.
  // Reason: re-minting on every sign-in invalidates whatever token is in the
  // Mac app's Keychain (which only refreshes on the lingcode:// callback path,
  // not on every browser sign-in), so a user who signs in again on the web
  // would silently break their Mac app's bridge auth. Token rotation only
  // happens on explicit /signout-all-devices or password reset (which NULLs
  // the token elsewhere).
  let accessToken = null;
  try {
    accessToken = db.prepare('SELECT api_access_token FROM users WHERE email = ?').get(email)?.api_access_token || null;
  } catch (e) { /* fall through to mint */ }
  if (!accessToken) {
    accessToken = crypto.randomBytes(32).toString('hex');
    try {
      db.prepare('UPDATE users SET api_access_token = ? WHERE email = ?').run(accessToken, email);
    } catch (e) {
      console.error('Failed to persist api_access_token:', e);
    }
  }
  const params = new URLSearchParams();
  params.set('access_token', accessToken);
  params.set('email', email);
  if (state) {
    params.set('state', state);
  }
  const callbackUrl = `${LINGCODE_CALLBACK}?${params.toString()}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>All set — LingCode</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #f0f0f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { text-align: center; max-width: 420px; width: 100%; }
    .icon { font-size: 3rem; margin-bottom: 20px; }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 10px; }
    p { color: #888; font-size: 0.95rem; line-height: 1.6; margin-bottom: 24px; }
    .btn { display: inline-block; padding: 11px 28px; border-radius: 8px; background: #f0f0f0; color: #0a0a0a; font-weight: 600; font-size: 0.95rem; text-decoration: none; cursor: pointer; border: none; }
    .btn:hover { opacity: 0.85; }
    .hint { margin-top: 16px; font-size: 0.75rem; color: #444; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>All set! Feel free to return to LingCode.</h1>
    <p>You're signed in. LingCode should open automatically.<br>If nothing happens, click the button below.</p>
    <a class="btn" href="${escapeHtml(callbackUrl)}">Open LingCode</a>
    <p class="hint">You can close this tab.</p>
  </div>
  <script>
    // Auto-open the app; browser will show the "Allow website to open LingCode?" prompt.
    window.location.href = ${JSON.stringify(callbackUrl)};
  </script>
</body>
</html>`);
});

// ── Google Sign-In ────────────────────────────────────────────────────────────
// Standard OAuth 2.0 Authorization Code flow. State lives in the session (no
// cookie-parser dep). On callback we trade the code for tokens, decode the
// ID token, then upsert by google_sub (falling back to email for account
// linking when a user previously registered with email + password).

const GOOGLE_OAUTH_CLIENT_ID = String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
const GOOGLE_OAUTH_CLIENT_SECRET = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
const GOOGLE_OAUTH_REDIRECT = `${PUBLIC_ORIGIN}/auth/google/callback`;

app.get('/auth/google', (req, res) => {
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
    return res.status(500).send('Google sign-in is not configured on the server.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  const nextRaw = String(req.query.next || '/account.html');
  // Only allow same-origin paths for `next` — reject `//foo.com` open-redirects.
  const safeNext = /^\/[^\/]/.test(nextRaw) ? nextRaw : '/account.html';
  req.session.google_state = state;
  req.session.google_next = safeNext;
  req.session.save((err) => {
    if (err) return res.status(500).send('Could not start sign-in.');
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', GOOGLE_OAUTH_CLIENT_ID);
    u.searchParams.set('redirect_uri', GOOGLE_OAUTH_REDIRECT);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', state);
    u.searchParams.set('prompt', 'select_account');
    res.redirect(302, u.toString());
  });
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error: gErr } = req.query || {};
  if (gErr) return res.status(400).send(`Google sign-in cancelled: ${String(gErr)}`);

  const expectedState = req.session?.google_state;
  const next = req.session?.google_next || '/account.html';
  if (req.session) {
    delete req.session.google_state;
    delete req.session.google_next;
  }

  if (!code || !state || !expectedState || state !== expectedState) {
    return res.status(400).send('Invalid OAuth state.');
  }

  let tokenPayload;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
        redirect_uri: GOOGLE_OAUTH_REDIRECT,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => '');
      console.error('google token exchange failed:', tokenRes.status, body);
      return res.status(400).send('Google token exchange failed.');
    }
    tokenPayload = await tokenRes.json();
  } catch (e) {
    console.error('google token fetch error:', e);
    return res.status(500).send('Network error contacting Google.');
  }

  if (!tokenPayload || !tokenPayload.id_token) {
    return res.status(400).send('Missing ID token from Google.');
  }

  // Decode the ID token payload (middle JWT segment). The token arrived directly
  // over TLS from Google authenticated with our client_secret, so it is trusted
  // for this flow. Add JWKS signature verification via `jose` as defence-in-depth
  // in a follow-up.
  let parsed;
  try {
    const payloadB64 = String(tokenPayload.id_token).split('.')[1];
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (e) {
    return res.status(400).send('Could not decode ID token.');
  }
  const sub = String(parsed.sub || '');
  const emailRaw = String(parsed.email || '').trim().toLowerCase();
  const emailVerified = parsed.email_verified === true || parsed.email_verified === 'true';
  if (!sub || !emailRaw) return res.status(400).send('Google returned an incomplete profile.');
  if (!emailVerified) return res.status(400).send('Google reports this email as unverified.');

  let user = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(sub);
  if (!user) user = db.prepare('SELECT * FROM users WHERE email = ?').get(emailRaw);

  if (user) {
    if (!user.google_sub) {
      db.prepare('UPDATE users SET google_sub = ?, email_verified = 1 WHERE id = ?').run(sub, user.id);
      user.google_sub = sub;
      user.email_verified = 1;
    }
  } else {
    const id = crypto.randomUUID();
    const created = new Date().toISOString();
    db.prepare(
      'INSERT INTO users (id, email, tier, created_at, source, email_verified, google_sub) VALUES (?, ?, ?, ?, ?, 1, ?)'
    ).run(id, emailRaw, 'free', created, 'google', sub);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    referrals.attributeOnSignup(db, req, id); // fresh Google signup only (guarded)
  }

  req.session.account = {
    userId: user.id,
    email: user.email,
    tier: user.tier,
  };
  req.session.save((err) => {
    if (err) return res.status(500).send('Could not start session.');
    res.redirect(302, next);
  });
});

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Prometheus scrape target (token-gated; keep off the public nginx vhost).
app.get('/metrics', metrics.handler);

// Readiness probe: liveness (/api/health) is a static OK; this one actually
// touches the Cloud Postgres (short SELECT 1) and returns pool stats, so an
// orchestrator/monitor can tell when the data plane is unreachable. 503 on fail.
app.get('/api/health/deep', async (req, res) => {
  const dataPlane = require('./cloud-data-plane');
  if (!dataPlane.isConfigured()) return res.json({ ok: true, cloud: 'not_configured' });
  try {
    const r = await dataPlane.probe();
    res.json({ ok: true, cloud: 'up', pool: r.pool });
  } catch (err) {
    res.status(503).json({ ok: false, cloud: 'down', error: err && err.message });
  }
});

// Feed pg pool gauges (total/idle/waiting) to Prometheus. No-op if prom-client
// is absent or Cloud is unconfigured; poolStats returns zeros pre-pool.
try { metrics.registerPoolGauges(require('./cloud-data-plane').poolStats); } catch (_) {}

// ─── Model telemetry ─────────────────────────────────────────────────────────
// Anonymous metadata from the Mac app (provider, model, tokens, accept/revert).
// Never carries prompt or response content. Users can disable in
// Settings > Privacy; the client is expected to honour that before POSTing.

const TELEMETRY_ALLOWED_EVENTS = new Set(['response', 'diff_outcome']);
const TELEMETRY_MAX_BATCH = 100;
const TELEMETRY_STR_MAX = 128;

// Per-IP token bucket. Each IP gets TELEMETRY_RATE_BURST tokens, refilled at
// TELEMETRY_RATE_PER_SEC tokens/sec. One token = one POST. Plenty for honest
// clients (~30s batches), enough to smother abuse without a Redis dependency.
const TELEMETRY_RATE_BURST = 30;
const TELEMETRY_RATE_PER_SEC = 0.5;
const telemetryBuckets = new Map();

function telemetryRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now() / 1000;
  const b = telemetryBuckets.get(ip) || { tokens: TELEMETRY_RATE_BURST, ts: now };
  const elapsed = Math.max(0, now - b.ts);
  b.tokens = Math.min(TELEMETRY_RATE_BURST, b.tokens + elapsed * TELEMETRY_RATE_PER_SEC);
  b.ts = now;
  if (b.tokens < 1) {
    telemetryBuckets.set(ip, b);
    return res.status(429).json({ error: 'Too many requests' });
  }
  b.tokens -= 1;
  telemetryBuckets.set(ip, b);
  next();
}

function telemetryClampStr(v) {
  if (v == null) return null;
  const s = String(v);
  return s.length > TELEMETRY_STR_MAX ? s.slice(0, TELEMETRY_STR_MAX) : s;
}

function telemetryClampInt(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(-1, Math.min(10_000_000, Math.round(n)));
}

app.post('/api/telemetry/model-events', telemetryRateLimit, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const installId = telemetryClampStr(body.installId);
  const events = Array.isArray(body.events) ? body.events : [];
  if (!installId || events.length === 0) {
    return res.status(400).json({ error: 'installId and events[] required' });
  }
  if (events.length > TELEMETRY_MAX_BATCH) {
    return res.status(413).json({ error: `events[] exceeds ${TELEMETRY_MAX_BATCH}` });
  }
  const nowIso = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO model_telemetry_events
      (install_id, conversation_id, event_type, provider, model,
       prompt_tokens, completion_tokens, latency_ms, accepted, file_count,
       client_ts, received_at, schema_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  let inserted = 0;
  let rejected = 0;
  const tx = db.transaction((rows) => {
    for (const e of rows) {
      if (!e || typeof e !== 'object') { rejected++; continue; }
      const eventType = telemetryClampStr(e.eventType);
      const conversationId = telemetryClampStr(e.conversationId);
      if (!TELEMETRY_ALLOWED_EVENTS.has(eventType) || !conversationId) {
        rejected++;
        continue;
      }
      const accepted = e.accepted == null ? null : (e.accepted ? 1 : 0);
      stmt.run(
        installId,
        conversationId,
        eventType,
        telemetryClampStr(e.provider),
        telemetryClampStr(e.model),
        telemetryClampInt(e.promptTokens),
        telemetryClampInt(e.completionTokens),
        telemetryClampInt(e.latencyMs),
        accepted,
        telemetryClampInt(e.fileCount),
        telemetryClampStr(e.clientTs) || nowIso,
        nowIso
      );
      inserted++;
    }
  });
  try {
    tx(events);
  } catch (err) {
    console.error('[telemetry] insert failed:', err.message);
    return res.status(500).json({ error: 'insert failed' });
  }
  res.json({ ok: true, inserted, rejected });
});

// BYOK Claude-backend usage. Sent by the Mac app every ~5 min (or when
// the in-memory buffer hits 50 events) when the user has the
// Settings → Claude Backends → Privacy toggle ON (default).
//
// Anonymous: device_id is a per-install random UUID re-rolled on opt-out.
// Per-event payload: backend_kind ("anthropic-direct"/"lingmodel"/"byok"),
// backend_preset_id (slug like "deepseek", "zhipu-glm", or "custom" —
// never the user's per-instance UUID), model_id, tokens_in/out, latency_ms,
// outcome ("success"/"error"/"cancelled"). No prompts, responses, file
// paths, project info, API keys, or user identity ever leave the device.
//
// Goal: see which BYOK presets are popular and where users hit failures.
const BYOK_TELEMETRY_KINDS = new Set(['anthropic-direct', 'lingmodel', 'byok']);
const BYOK_TELEMETRY_OUTCOMES = new Set(['success', 'error', 'cancelled']);

app.post('/api/telemetry/byok', telemetryRateLimit, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const deviceId = telemetryClampStr(body.device_id);
  const events = Array.isArray(body.events) ? body.events : [];
  if (!deviceId || events.length === 0) {
    return res.status(400).json({ error: 'device_id and events[] required' });
  }
  if (events.length > TELEMETRY_MAX_BATCH) {
    return res.status(413).json({ error: `events[] exceeds ${TELEMETRY_MAX_BATCH}` });
  }
  const nowIso = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO byok_telemetry_events
      (device_id, backend_kind, backend_preset_id, model_id,
       tokens_in, tokens_out, latency_ms, outcome,
       client_ts, received_at, schema_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  let inserted = 0;
  let rejected = 0;
  const tx = db.transaction((rows) => {
    for (const e of rows) {
      if (!e || typeof e !== 'object') { rejected++; continue; }
      const backendKind = telemetryClampStr(e.backend_kind);
      const outcome = telemetryClampStr(e.outcome);
      // Whitelist enums — silently drop anything we don't recognise so a
      // future client schema bump can't poison the table.
      if (!BYOK_TELEMETRY_KINDS.has(backendKind) || !BYOK_TELEMETRY_OUTCOMES.has(outcome)) {
        rejected++;
        continue;
      }
      stmt.run(
        deviceId,
        backendKind,
        telemetryClampStr(e.backend_preset_id),
        telemetryClampStr(e.model_id),
        telemetryClampInt(e.tokens_in),
        telemetryClampInt(e.tokens_out),
        telemetryClampInt(e.latency_ms),
        outcome,
        telemetryClampInt(e.ts) ?? Math.floor(Date.now() / 1000),
        nowIso
      );
      inserted++;
    }
  });
  try {
    tx(events);
  } catch (err) {
    console.error('[byok-telemetry] insert failed:', err.message);
    return res.status(500).json({ error: 'insert failed' });
  }
  res.json({ ok: true, inserted, rejected });
});

// In-app feedback from the Mac IDE's "Send Feedback" sheet. Anonymous, rate-
// limited; admin reads via /api/admin/feedback.
const FEEDBACK_CATEGORIES = new Set(['BUG', 'FEATURE', 'UX', 'OTHER']);
const FEEDBACK_SUMMARY_MAX = 256;
const FEEDBACK_DETAILS_MAX = 4000;
// Inline screenshot cap. 6 MB on the wire = ~4.4 MB raw bytes after base64
// decode — enough for a Retina full-window PNG without going overboard.
// Tuned so the SQLite row stays manageable; if volume grows beyond what
// inline storage handles comfortably, swap to S3-backed URL with the same
// shape (replace the data: URL on insert).
const FEEDBACK_SCREENSHOT_MAX_BYTES = 6 * 1024 * 1024;
const FEEDBACK_SCREENSHOT_PREFIX = /^data:image\/(png|jpeg);base64,/i;
// Route-level body parser. The global 128KB parser skips /api/feedback
// (see middleware above) so this is the only one that runs for this path.
const feedbackBodyParser = express.json({ limit: '8mb' });
app.post('/api/feedback', telemetryRateLimit, feedbackBodyParser, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const category = String(body.category || '').toUpperCase();
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  const detailsRaw = typeof body.details === 'string' ? body.details.trim() : '';
  const emailRaw = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!FEEDBACK_CATEGORIES.has(category)) {
    return res.status(400).json({ error: 'category must be one of BUG, FEATURE, UX, OTHER' });
  }
  if (!summary) {
    return res.status(400).json({ error: 'summary required' });
  }
  // Optional — if present, must look like an email. Empty string = "not provided".
  let email = null;
  if (emailRaw) {
    if (emailRaw.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
      return res.status(400).json({ error: 'email is not a valid address' });
    }
    email = emailRaw;
  }
  // Optional screenshot. Must be a PNG or JPEG `data:` URL — anything else
  // (http URLs, application/json, arbitrary base64) is rejected so we don't
  // accidentally render a non-image payload in the admin dashboard `<img>`.
  let screenshot = null;
  if (typeof body.screenshot === 'string' && body.screenshot.length > 0) {
    const raw = body.screenshot;
    if (!FEEDBACK_SCREENSHOT_PREFIX.test(raw)) {
      return res.status(400).json({ error: 'screenshot must be a data:image/(png|jpeg);base64,… URL' });
    }
    if (raw.length > FEEDBACK_SCREENSHOT_MAX_BYTES) {
      return res.status(413).json({ error: `screenshot exceeds ${FEEDBACK_SCREENSHOT_MAX_BYTES} bytes` });
    }
    screenshot = raw;
  }
  const clampedSummary = summary.length > FEEDBACK_SUMMARY_MAX
    ? summary.slice(0, FEEDBACK_SUMMARY_MAX)
    : summary;
  const clampedDetails = detailsRaw.length > FEEDBACK_DETAILS_MAX
    ? detailsRaw.slice(0, FEEDBACK_DETAILS_MAX)
    : detailsRaw;
  try {
    db.prepare(`
      INSERT INTO feedback (created_at, category, summary, details, email, app_version, os_version, client_ip, screenshot_data_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      category,
      clampedSummary,
      clampedDetails || null,
      email,
      telemetryClampStr(body.appVersion),
      telemetryClampStr(body.osVersion),
      telemetryClampStr(req.ip || req.connection?.remoteAddress),
      screenshot
    );
  } catch (err) {
    console.error('[feedback] insert failed:', err.message);
    return res.status(500).json({ error: 'insert failed' });
  }
  res.json({ ok: true });
});

// CLI heartbeat. Sent at most once per day per install. Anonymous —
// the body carries installId (random UUID picked the first time the CLI
// runs), version, os, arch. No keys, no prompts, no usage content.
app.post('/api/cli/heartbeat', telemetryRateLimit, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const installId = telemetryClampStr(body.installId);
  const version = telemetryClampStr(body.version);
  const os = telemetryClampStr(body.os);
  const arch = telemetryClampStr(body.arch);
  if (!installId) return res.status(400).json({ error: 'installId required' });
  const nowIso = new Date().toISOString();
  // Upsert: first row sets first_seen, subsequent rows update last_seen,
  // version (in case the install upgraded), and bump count.
  db.prepare(`
    INSERT INTO cli_heartbeats (install_id, version, os, arch, first_seen, last_seen, count)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(install_id) DO UPDATE SET
      version = excluded.version,
      os = COALESCE(excluded.os, cli_heartbeats.os),
      arch = COALESCE(excluded.arch, cli_heartbeats.arch),
      last_seen = excluded.last_seen,
      count = cli_heartbeats.count + 1
  `).run(installId, version, os, arch, nowIso, nowIso);
  res.json({ ok: true });
});

// Mac app session heartbeat. Client posts every ~60s while the user has the
// app focused (and only if they've opted in via Settings). One row per
// (user, minute) — repeats within a minute are no-ops thanks to INSERT OR
// IGNORE. Active minutes per day is then `COUNT(*) GROUP BY date(minute_bucket * 60)`.
app.post('/api/usage/heartbeat', telemetryRateLimit, (req, res) => {
  const user = getUserFromRequest(db, req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const version = telemetryClampStr(body.version);
  const minuteBucket = Math.floor(Date.now() / 60000);
  db.prepare(`
    INSERT OR IGNORE INTO app_usage_minutes (user_id, minute_bucket, version)
    VALUES (?, ?, ?)
  `).run(user.id, minuteBucket, version);
  res.json({ ok: true });
});

app.get('/api/entitlement', (req, res) => {
  const user = getUserFromRequest(db, req);
  if (!user) {
    // No anonymous access — LingModel requires a signed-in account or BYOK.
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const tier = String(user.tier || 'free').toLowerCase();
  const used = Number(user.hosted_prompts_used || 0);
  const isPro = tier === 'pro' || tier === 'max_pro';
  const limits = loadLingModelLimits(db);
  const tierCaps = paidTierCaps(tier, limits);
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  let proPromptsToday = 0;
  if (isPro && user.lingmodel_pro_day === today) {
    proPromptsToday = Number(user.lingmodel_pro_day_count || 0);
  }
  const proDailyCap = tierCaps.dailyPrompt;
  const proDailyEnforced = isPro && proDailyCap > 0;
  // 5h rolling window state — tighter cap, the one users will hit first.
  const proWindowKey = current5hWindowKey();
  let proPromptsWindow = 0;
  if (isPro && user.lingmodel_pro_window === proWindowKey) {
    proPromptsWindow = Number(user.lingmodel_pro_window_count || 0);
  }
  const proWindowCap = tierCaps.windowPrompt;
  const proWindowEnforced = isPro && proWindowCap > 0;
  // Paid-tier output-token accounting (cost-correlated metric — daily + monthly).
  const proTokensToday = isPro && user.lingmodel_pro_day === today
    ? Number(user.lingmodel_pro_day_output_tokens || 0) : 0;
  const proTokensMonth = isPro && user.lingmodel_pro_month === month
    ? Number(user.lingmodel_pro_month_output_tokens || 0) : 0;
  const proDailyTokenCap = tierCaps.dailyTokens;
  const proMonthlyTokenCap = tierCaps.monthlyTokens;

  const freePromptsToday =
    !isPro && user.lingmodel_free_day === today ? Number(user.lingmodel_free_day_count || 0) : 0;
  const freePromptsLifetime = !isPro ? Number(user.lingmodel_free_lifetime_count || 0) : 0;
  const freeTokensUsedToday =
    !isPro && user.lingmodel_free_day === today
      ? Number(user.lingmodel_free_day_output_tokens || 0)
      : 0;
  const freeTokensUsedMonth =
    !isPro && user.lingmodel_free_month === month
      ? Number(user.lingmodel_free_month_output_tokens || 0)
      : 0;
  const freeDailyPromptCap = LINGMODEL_FREE_DAILY_PROMPT_LIMIT;
  const freeLifetimePromptCap = limits.freeLifetimePromptLimit;
  const freeDailyTokenCap = LINGMODEL_FREE_DAILY_OUTPUT_TOKENS;
  const freeMonthlyTokenCap = LINGMODEL_FREE_MONTHLY_OUTPUT_TOKENS;

  res.json({
    ok: true,
    tier,
    product: 'LingModel',
    hosted_prompts_used: used,
    hosted_prompt_limit: HOSTED_LIMIT,
    hosted_prompts_remaining: isPro || HOSTED_LIMIT <= 0 ? null : Math.max(0, HOSTED_LIMIT - used),
    lingmodel_pro_daily_limit: proDailyEnforced ? proDailyCap : null,
    lingmodel_pro_prompts_today: isPro ? proPromptsToday : null,
    lingmodel_pro_daily_remaining: proDailyEnforced ? Math.max(0, proDailyCap - proPromptsToday) : null,
    // 5h rolling window — Cursor / Claude.ai style cost ceiling for Pro tier.
    lingmodel_pro_window_limit: proWindowEnforced ? proWindowCap : null,
    lingmodel_pro_window_used: isPro ? proPromptsWindow : null,
    lingmodel_pro_window_remaining: proWindowEnforced ? Math.max(0, proWindowCap - proPromptsWindow) : null,
    lingmodel_pro_window_resets_at: isPro ? currentWindowEndMs() : null,
    // Pro output-token accounting — actual cost ceiling (prompt counts can
    // vary 100× in token cost depending on prompt length / context size).
    lingmodel_pro_daily_token_limit: isPro && proDailyTokenCap > 0 ? proDailyTokenCap : null,
    lingmodel_pro_tokens_used_today: isPro ? proTokensToday : null,
    lingmodel_pro_daily_tokens_remaining: isPro && proDailyTokenCap > 0 ? Math.max(0, proDailyTokenCap - proTokensToday) : null,
    lingmodel_pro_monthly_token_limit: isPro && proMonthlyTokenCap > 0 ? proMonthlyTokenCap : null,
    lingmodel_pro_tokens_used_month: isPro ? proTokensMonth : null,
    lingmodel_pro_monthly_tokens_remaining: isPro && proMonthlyTokenCap > 0 ? Math.max(0, proMonthlyTokenCap - proTokensMonth) : null,
    lingmodel_free_daily_prompt_limit: !isPro && freeDailyPromptCap > 0 ? freeDailyPromptCap : null,
    lingmodel_free_prompts_today: !isPro ? freePromptsToday : null,
    lingmodel_free_daily_remaining:
      !isPro && freeDailyPromptCap > 0 ? Math.max(0, freeDailyPromptCap - freePromptsToday) : null,
    // Lifetime cap powers the "100 free prompts, then upgrade" funnel. Null
    // for Pro/Max-Pro (no lifetime gate); null when the env disables it (0).
    lingmodel_free_lifetime_prompt_limit:
      !isPro && freeLifetimePromptCap > 0 ? freeLifetimePromptCap : null,
    lingmodel_free_prompts_lifetime: !isPro ? freePromptsLifetime : null,
    lingmodel_free_lifetime_remaining:
      !isPro && freeLifetimePromptCap > 0
        ? Math.max(0, freeLifetimePromptCap - freePromptsLifetime)
        : null,
    // Single canonical upgrade entry — pricing page hosts the Stripe Checkout
    // button. Clients should open this URL in a browser when they need to
    // route a free user to Pro (lifetime cap hit, or "Upgrade" link).
    upgrade_url: isPro ? null : 'https://lingcode.dev/pricing.html',
    lingmodel_free_daily_token_limit: !isPro && freeDailyTokenCap > 0 ? freeDailyTokenCap : null,
    lingmodel_free_tokens_used_today: !isPro ? freeTokensUsedToday : null,
    lingmodel_free_tokens_remaining_today:
      !isPro && freeDailyTokenCap > 0 ? Math.max(0, freeDailyTokenCap - freeTokensUsedToday) : null,
    lingmodel_free_monthly_token_limit:
      !isPro && freeMonthlyTokenCap > 0 ? freeMonthlyTokenCap : null,
    lingmodel_free_tokens_used_month: !isPro ? freeTokensUsedMonth : null,
    lingmodel_free_monthly_tokens_remaining:
      !isPro && freeMonthlyTokenCap > 0 ? Math.max(0, freeMonthlyTokenCap - freeTokensUsedMonth) : null,
    unlimited_hosted: isPro && proDailyCap === 0
  });
});

app.use('/api/inference', createInferenceRouter(db));

// LingModel image-generation endpoint. Bearer-token auth, per-tier monthly
// quota gating; forwards to OpenAI by default. See image-generation.js for
// the full surface (GET /api/images/quota + POST /api/images/generate).
const { createImageRouter, testUpstream: testImageUpstream } = require('./image-generation');
app.use('/api/images', createImageRouter(db));

// Admin diagnostic: confirm the configured OpenAI key works by sending a
// single test generation. Does NOT charge any user's quota. ~$0.04/click at
// gpt-image-1 rates.
app.post('/api/admin/lingmodel-image-test', requireAdmin, async (req, res) => {
  const result = await testImageUpstream(db);
  if (result.ok) return res.json(result);
  return res.status(502).json(result);
});

// Live-test the LingModel inference upstream (effective URL + key) so the admin
// can confirm a model-routing change works before relying on it.
app.post('/api/admin/lingmodel-test', requireAdmin, async (req, res) => {
  const result = await testLingModelUpstream(db);
  if (result.ok) return res.json(result);
  return res.status(502).json(result);
});

// "Save prototype to GitHub" — used by /try.html's Verdict + Preview UI.
// Routes: /api/github/{status,oauth/start,callback,save-gist,disconnect}
const { registerGithubRoutes } = require('./github-oauth');
registerGithubRoutes(app, db);

// "Connect Supabase" — Phase 2 of /try Lovable parity. OAuth-only routes;
// the supabase-management module reads refresh tokens persisted by this
// flow. All routes return 503 until SUPABASE_OAUTH_CLIENT_ID and
// SUPABASE_OAUTH_CLIENT_SECRET are set in the env.
const { registerSupabaseRoutes } = require('./supabase-oauth');
registerSupabaseRoutes(app, db);

// AI tool dispatcher for Supabase tools (Phase 3). Routes the agent's
// tool_use blocks (apply_migration, apply_rls_template, query_database,
// list_supabase_tables, create_supabase_project, list_organizations) to
// supabase-management.js with the user's persisted refresh token. Same
// 503 gating as the OAuth routes above.
const { registerSupabaseToolRoutes } = require('./supabase-tools');
registerSupabaseToolRoutes(app, db);

// Affiliate / marketer referral links: /r/<code> (click + cookie + redirect to
// DMG), /api/ref/<code> (token-gated marketer stats), /api/admin/referrals
// (mint + list). Attribution stamped on signup via referrals.attributeOnSignup.
const referrals = require('./referrals');
referrals.register(app, db, requireAdmin);

// Per-prototype encrypted secrets vault (Phase 4). User pastes
// STRIPE_SECRET_KEY etc. into the /try secrets UI; the AI's Edge
// Function deploy flow reads them server-side via secrets-vault's
// readSecret(). Routes return 503 until LINGCODE_VAULT_MASTER_KEY is
// set (must be a 32-byte key, hex or base64). The old name
// LINGCODE_SECRETS_KEY is still honored as a fallback.
const { registerSecretsVaultRoutes } = require('./secrets-vault');
registerSecretsVaultRoutes(app, db);

// LingCode Cloud — managed backend control plane + Phase-1 data proxy.
// Routes 503 until CLOUD_PG_ADMIN_URL + CLOUD_JWT_SECRET are set (see
// website/cloud-infra/). The browser console talks only to /api/cloud/*;
// service creds stay here.
const { registerCloudBackendRoutes } = require('./cloud-backend');
registerCloudBackendRoutes(app, db);
// Cloud per-tier limits: enforcement path reads admin overrides from app_config.
const { loadCloudLimits, CLOUD_LIMIT_KEYS, setDb: setCloudLimitsDb } = require('./cloud-limits');
setCloudLimitsDb(db);
const { registerCloudFunctionsRoutes } = require('./cloud-functions-routes');
registerCloudFunctionsRoutes(app, db);
const { registerCloudPushRoutes } = require('./cloud-push');
registerCloudPushRoutes(app, db);
const { registerUpdatePushRoutes } = require('./updates-push');
registerUpdatePushRoutes(app);
const { registerTelemetryOwnerRoutes } = require('./cloud-telemetry');
registerTelemetryOwnerRoutes(app, db);
const { registerCloudToolRoutes } = require('./cloud-tools');
registerCloudToolRoutes(app, db);
const { registerCloudMcpRoutes } = require('./cloud-mcp');
registerCloudMcpRoutes(app, db);
const { registerCloudAccountMcpRoutes } = require('./cloud-account-mcp');
registerCloudAccountMcpRoutes(app, db);
// Public site assistant (grounded RAG chat widget). Loads site-index.json at
// boot; POST /api/site-chat is per-IP + global rate-limited.
const { registerSiteAssistantRoutes } = require('./site-assistant');
registerSiteAssistantRoutes(app, db);
const { registerCloudOAuthRoutes } = require('./cloud-oauth');
registerCloudOAuthRoutes(app, db);

// Custom subdomains for published prototypes (Phase 5b finalize).
// User claims a subdomain → we CNAME it via Cloudflare to their target
// URL. Routes 503 until CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID +
// CLOUDFLARE_ZONE_NAME envs are set.
const { registerDomainsRoutes } = require('./domains-routes');
registerDomainsRoutes(app, db);

// Vercel one-click deploy for /try prototypes.
// Requires VERCEL_API_TOKEN in env; returns 503 if not set so the client
// can fall back to Netlify Drop. Accepts { files: {path: content}, name? }.
{
  const { deployAndWaitUntilReady } = require('./deploy-vercel');
  app.post('/api/try/deploy', async (req, res) => {
    const { files, name, token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'vercel_token_required' });
    if (!files || typeof files !== 'object' || Object.keys(files).length === 0)
      return res.status(400).json({ error: 'files_required' });
    const safeName = String(name || 'proto').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
    const slug = `lingcode-${safeName}-${Date.now().toString(36)}`;
    try {
      const dep = await deployAndWaitUntilReady({ token, name: slug, files });
      res.json({ ok: true, url: 'https://' + dep.url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// Deep Agent — server-side Claude Agent SDK loop for /try. Pro/Max only;
// gated off by default. Routes:
//   POST /api/agent/sdk/sessions
//   POST /api/agent/sdk/sessions/:id/run          (SSE)
//   POST /api/agent/sdk/sessions/:id/tool-results
//   POST /api/agent/sdk/sessions/:id/approvals
//   POST /api/agent/sdk/sessions/:id/close
//   GET  /api/agent/sdk/usage
// Requires ANTHROPIC_API_KEY in env and app_config.deep_agent_enabled='true'.
try {
  const { registerAgentSdkRoutes } = require('./agent-sdk');
  registerAgentSdkRoutes(app, db);
} catch (e) {
  console.warn('[deep-agent] agent-sdk routes not registered (non-fatal):', e && e.message);
}

app.get('/api/account/me', (req, res) => {
  const a = req.session && req.session.account;
  if (!a || !a.email) {
    return res.status(401).json({ ok: false, error: 'Not signed in' });
  }
  const row = db
    .prepare(
      `SELECT id, email, tier, created_at,
        stripe_customer_id, stripe_subscription_id, subscription_status,
        subscription_current_period_end, billing_interval,
        hosted_prompts_used,
        lingmodel_pro_day, lingmodel_pro_day_count,
        lingmodel_free_day, lingmodel_free_day_count, lingmodel_free_day_output_tokens,
        lingmodel_free_month, lingmodel_free_month_output_tokens
      FROM users WHERE id = ?`
    )
    .get(a.userId);
  if (!row) {
    delete req.session.account;
    return req.session.save(() => res.status(401).json({ ok: false, error: 'Session invalid' }));
  }
  if (row.email_verified != null && Number(row.email_verified) === 0) {
    delete req.session.account;
    return req.session.save(() =>
      res.status(401).json({ ok: false, error: 'Email not verified', needs_verification: true })
    );
  }
  if (req.session.account) {
    req.session.account.tier = row.tier;
  }
  res.json({
    ok: true,
    product: 'LingModel',
    email: row.email,
    tier: row.tier,
    userId: row.id,
    created_at: row.created_at,
    subscription_status: row.subscription_status || null,
    subscription_current_period_end: row.subscription_current_period_end || null,
    billing_interval: row.billing_interval || null,
    has_stripe_customer: !!row.stripe_customer_id,
    hosted_prompts_used: Number(row.hosted_prompts_used || 0),
    hosted_prompt_limit: HOSTED_LIMIT,
    lingmodel_pro_daily_limit: (() => {
      const t = String(row.tier || 'free').toLowerCase();
      const cap = paidTierCaps(t, loadLingModelLimits(db)).dailyPrompt;
      return (t === 'pro' || t === 'max_pro') && cap > 0 ? cap : null;
    })(),
    lingmodel_pro_prompts_today: (() => {
      const t = String(row.tier || 'free').toLowerCase();
      return (t === 'pro' || t === 'max_pro') &&
        row.lingmodel_pro_day === new Date().toISOString().slice(0, 10)
        ? Number(row.lingmodel_pro_day_count || 0)
        : null;
    })(),
    ...(() => {
      const isPro = (() => {
        const t = String(row.tier || 'free').toLowerCase();
        return t === 'pro' || t === 'max_pro';
      })();
      const today = new Date().toISOString().slice(0, 10);
      const month = today.slice(0, 7);
      const dayCount =
        !isPro && row.lingmodel_free_day === today ? Number(row.lingmodel_free_day_count || 0) : 0;
      const lifetimeCount = !isPro ? Number(row.lingmodel_free_lifetime_count || 0) : 0;
      const lifetimeCap = loadLingModelLimits(db).freeLifetimePromptLimit;
      const dayTokens =
        !isPro && row.lingmodel_free_day === today
          ? Number(row.lingmodel_free_day_output_tokens || 0)
          : 0;
      const monthTokens =
        !isPro && row.lingmodel_free_month === month
          ? Number(row.lingmodel_free_month_output_tokens || 0)
          : 0;
      return {
        lingmodel_free_daily_prompt_limit:
          !isPro && LINGMODEL_FREE_DAILY_PROMPT_LIMIT > 0 ? LINGMODEL_FREE_DAILY_PROMPT_LIMIT : null,
        lingmodel_free_prompts_today: !isPro ? dayCount : null,
        lingmodel_free_daily_remaining:
          !isPro && LINGMODEL_FREE_DAILY_PROMPT_LIMIT > 0
            ? Math.max(0, LINGMODEL_FREE_DAILY_PROMPT_LIMIT - dayCount)
            : null,
        lingmodel_free_lifetime_prompt_limit: !isPro && lifetimeCap > 0 ? lifetimeCap : null,
        lingmodel_free_prompts_lifetime: !isPro ? lifetimeCount : null,
        lingmodel_free_lifetime_remaining:
          !isPro && lifetimeCap > 0 ? Math.max(0, lifetimeCap - lifetimeCount) : null,
        upgrade_url: isPro ? null : 'https://lingcode.dev/pricing.html',
        lingmodel_free_daily_token_limit:
          !isPro && LINGMODEL_FREE_DAILY_OUTPUT_TOKENS > 0 ? LINGMODEL_FREE_DAILY_OUTPUT_TOKENS : null,
        lingmodel_free_tokens_used_today: !isPro ? dayTokens : null,
        lingmodel_free_tokens_remaining_today:
          !isPro && LINGMODEL_FREE_DAILY_OUTPUT_TOKENS > 0
            ? Math.max(0, LINGMODEL_FREE_DAILY_OUTPUT_TOKENS - dayTokens)
            : null,
        lingmodel_free_monthly_token_limit:
          !isPro && LINGMODEL_FREE_MONTHLY_OUTPUT_TOKENS > 0
            ? LINGMODEL_FREE_MONTHLY_OUTPUT_TOKENS
            : null,
        lingmodel_free_tokens_used_month: !isPro ? monthTokens : null,
        lingmodel_free_monthly_tokens_remaining:
          !isPro && LINGMODEL_FREE_MONTHLY_OUTPUT_TOKENS > 0
            ? Math.max(0, LINGMODEL_FREE_MONTHLY_OUTPUT_TOKENS - monthTokens)
            : null
      };
    })()
  });
});

/**
 * Web session → Mac app: mint api_access_token and return lingcode:// URL (same contract as POST /oauth/complete for app flow).
 * Called from account.html after "Sign in with browser" so users can open the installed app already signed in.
 */
app.post('/api/account/app-handoff', (req, res) => {
  const a = req.session && req.session.account;
  if (!a || !a.userId) {
    return res.status(401).json({ ok: false, error: 'Not signed in' });
  }
  const row = db
    .prepare('SELECT id, email, email_verified FROM users WHERE id = ?')
    .get(a.userId);
  if (!row) {
    delete req.session.account;
    return req.session.save(() => res.status(401).json({ ok: false, error: 'Session invalid' }));
  }
  if (row.email_verified != null && Number(row.email_verified) === 0) {
    return res.status(403).json({ ok: false, error: 'Verify your email before opening the app.' });
  }
  // Reuse existing api_access_token so the Mac app's Keychain stays valid across
  // re-signs. See same logic in /oauth/complete above for full reasoning.
  let accessToken = null;
  try {
    accessToken = db.prepare('SELECT api_access_token FROM users WHERE id = ?').get(row.id)?.api_access_token || null;
  } catch (e) { /* fall through to mint */ }
  if (!accessToken) {
    accessToken = crypto.randomBytes(32).toString('hex');
    try {
      db.prepare('UPDATE users SET api_access_token = ? WHERE id = ?').run(accessToken, row.id);
    } catch (e) {
      console.error('app-handoff token:', e);
      return res.status(500).json({ ok: false, error: 'Could not prepare app link' });
    }
  }
  const params = new URLSearchParams();
  params.set('access_token', accessToken);
  params.set('email', row.email);
  const url = `${LINGCODE_CALLBACK}?${params.toString()}`;
  res.json({ ok: true, url });
});

app.post('/api/account/logout', (req, res) => {
  if (req.session && req.session.account) {
    delete req.session.account;
    return req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Logout failed' });
      res.json({ ok: true });
    });
  }
  res.json({ ok: true });
});

// Permanently delete the signed-in user and all owned data.
// Body: { confirmEmail }. Must match the session user's email (case-insensitive).
// Auto-cancels any active Stripe subscription immediately (no proration / refund).
app.post('/api/account/delete', async (req, res) => {
  const a = req.session && req.session.account;
  if (!a || !a.userId) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  const user = db
    .prepare('SELECT id, email, stripe_subscription_id, subscription_status FROM users WHERE id = ?')
    .get(a.userId);
  if (!user) {
    delete req.session.account;
    return req.session.save(() => res.status(404).json({ error: 'Account not found' }));
  }
  const supplied = String((req.body && req.body.confirmEmail) || '').trim().toLowerCase();
  if (!supplied || supplied !== String(user.email).toLowerCase()) {
    return res.status(400).json({ error: 'Email confirmation does not match' });
  }

  // Best-effort Stripe cancel. We don't block the account delete on a Stripe
  // failure — user can dispute charges directly with Stripe if it errors. Only
  // attempt for statuses that actually have something to cancel.
  if (
    stripe &&
    user.stripe_subscription_id &&
    ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(
      String(user.subscription_status || '').toLowerCase()
    )
  ) {
    try {
      await stripe.subscriptions.cancel(user.stripe_subscription_id);
    } catch (e) {
      console.error('Stripe cancel during account delete failed:', e && e.message);
    }
  }

  // Cascade delete in a single SQLite transaction so a mid-flight failure
  // can't leave dangling rows referencing a vanished users.id.
  const txn = db.transaction((userId) => {
    const protoIds = db.prepare('SELECT id FROM saved_prototypes WHERE user_id = ?').all(userId).map((r) => r.id);
    if (protoIds.length > 0) {
      const ph = protoIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM collab_members WHERE prototype_id IN (${ph})`).run(...protoIds);
      db.prepare(`DELETE FROM prototype_supabase_projects WHERE prototype_id IN (${ph})`).run(...protoIds);
      db.prepare(`DELETE FROM prototype_secrets WHERE prototype_id IN (${ph})`).run(...protoIds);
      db.prepare(`DELETE FROM prototype_domains WHERE prototype_id IN (${ph})`).run(...protoIds);
    }
    db.prepare('DELETE FROM supabase_oauth_tokens WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM collab_members WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM saved_prototypes WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM agent_sdk_user_overrides WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
  try {
    txn(user.id);
  } catch (e) {
    console.error('Account delete txn failed:', e);
    return res.status(500).json({ error: 'Delete failed' });
  }

  delete req.session.account;
  req.session.save(() => res.json({ ok: true }));
});

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const FORGOT_PASSWORD_WINDOW_MS = 60 * 60 * 1000;
const FORGOT_PASSWORD_MAX_PER_WINDOW = 8;
const forgotPasswordBuckets = new Map();

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    return xff.split(',')[0].trim() || req.socket.remoteAddress || '';
  }
  return req.ip || req.socket.remoteAddress || '';
}

function allowForgotPassword(ip) {
  const now = Date.now();
  let b = forgotPasswordBuckets.get(ip);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + FORGOT_PASSWORD_WINDOW_MS };
    forgotPasswordBuckets.set(ip, b);
  }
  b.count += 1;
  return b.count <= FORGOT_PASSWORD_MAX_PER_WINDOW;
}

app.post('/api/account/forgot-password', async (req, res) => {
  if (!process.env.RESEND_API_KEY || !String(process.env.RESEND_API_KEY).trim()) {
    return res.status(503).json({
      ok: false,
      error: 'Password reset email is not configured (set RESEND_API_KEY on the server).'
    });
  }
  const ip = clientIp(req);
  if (!allowForgotPassword(ip)) {
    return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
  }
  const email = String((req.body && req.body.email) || '')
    .trim()
    .toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Invalid email' });
  }
  const row = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
  if (row) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();
    db.prepare(
      'UPDATE users SET password_reset_token = ?, password_reset_expires = ? WHERE id = ?'
    ).run(token, expires, row.id);
    const resetUrl = `${PUBLIC_ORIGIN}/reset-password.html?token=${encodeURIComponent(token)}`;
    const html = `<p>We received a request to reset the password for your LingCode account.</p>
<p><a href="${escapeHtml(resetUrl)}">Set a new password</a></p>
<p>This link expires in one hour. If you did not ask for this, you can ignore this email.</p>
<p style="color:#666;font-size:12px;">If the button does not work, copy this URL:<br>${escapeHtml(resetUrl)}</p>`;
    const sent = await sendResendEmail({
      to: row.email,
      subject: 'Reset your LingCode password',
      html
    });
    if (!sent.ok) {
      console.error('Resend forgot-password:', sent.error);
      db.prepare(
        'UPDATE users SET password_reset_token = NULL, password_reset_expires = NULL WHERE id = ?'
      ).run(row.id);
      return res.status(502).json({ ok: false, error: 'Could not send email. Try again later.' });
    }
  }
  res.json({
    ok: true,
    message: 'If an account exists for that email, we sent a reset link.'
  });
});

app.post('/api/account/reset-password', (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!token || token.length < 20) {
    return res.status(400).json({ ok: false, error: 'Invalid or missing token' });
  }
  if (typeof password !== 'string' || password.length < ACCOUNT_PASSWORD_MIN) {
    return res.status(400).json({
      ok: false,
      error: `Password must be at least ${ACCOUNT_PASSWORD_MIN} characters`
    });
  }
  const row = db
    .prepare(
      'SELECT id, email, password_reset_expires FROM users WHERE password_reset_token = ?'
    )
    .get(token);
  if (!row || !row.password_reset_expires) {
    return res.status(400).json({ ok: false, error: 'Invalid or expired reset link. Request a new one.' });
  }
  const exp = Date.parse(row.password_reset_expires);
  if (Number.isNaN(exp) || exp < Date.now()) {
    return res.status(400).json({ ok: false, error: 'This reset link has expired. Request a new one.' });
  }
  const h = hashAccountPassword(password);
  db.prepare(
    `UPDATE users SET password_hash = ?, password_reset_token = NULL, password_reset_expires = NULL,
     api_access_token = NULL WHERE id = ?`
  ).run(h, row.id);
  res.json({ ok: true });
});

app.get('/api/account/verify-email', (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) {
    return res.redirect(302, `${PUBLIC_ORIGIN}/signin.html?verify=invalid`);
  }
  const row = db
    .prepare('SELECT id, email_verification_expires, email_verification_next FROM users WHERE email_verification_token = ?')
    .get(token);
  if (!row) {
    return res.redirect(302, `${PUBLIC_ORIGIN}/signin.html?verify=invalid`);
  }
  const exp = Date.parse(row.email_verification_expires);
  if (Number.isNaN(exp) || exp < Date.now()) {
    return res.redirect(302, `${PUBLIC_ORIGIN}/signin.html?verify=expired`);
  }
  db.prepare(
    'UPDATE users SET email_verified = 1, email_verification_token = NULL, email_verification_expires = NULL, email_verification_next = NULL WHERE id = ?'
  ).run(row.id);
  // Carry the original `next` (stashed at signup time) on the redirect so
  // /signin.html can route the user back to e.g. /try.html after they sign in.
  const safeNext = (row.email_verification_next || '').toString();
  const nextParam = (safeNext.startsWith('/') && !safeNext.startsWith('//'))
    ? `&next=${encodeURIComponent(safeNext)}` : '';
  res.redirect(302, `${PUBLIC_ORIGIN}/signin.html?verify=ok${nextParam}`);
});

app.post('/api/account/resend-verification', async (req, res) => {
  if (!process.env.RESEND_API_KEY || !String(process.env.RESEND_API_KEY).trim()) {
    return res.status(503).json({ ok: false, error: 'Email not configured on server' });
  }
  const ip = clientIp(req);
  if (!allowForgotPassword(ip)) {
    return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
  }
  const email = String((req.body && req.body.email) || '')
    .trim()
    .toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Invalid email' });
  }
  const row = db.prepare('SELECT id, email, email_verified FROM users WHERE email = ?').get(email);
  if (!row || Number(row.email_verified) === 1) {
    return res.json({
      ok: true,
      message: 'If this account needs verification, we sent an email.'
    });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  db.prepare(
    'UPDATE users SET email_verification_token = ?, email_verification_expires = ? WHERE id = ?'
  ).run(token, expires, row.id);
  const verifyUrl = `${PUBLIC_ORIGIN}/api/account/verify-email?token=${encodeURIComponent(token)}`;
  const html = `<p>Verify your LingCode email:</p><p><a href="${escapeHtml(verifyUrl)}">Verify your email</a></p><p>Expires in 48 hours.</p>`;
  const sent = await sendResendEmail({
    to: row.email,
    subject: 'Verify your LingCode email',
    html
  });
  if (!sent.ok) {
    return res.status(502).json({ ok: false, error: 'Could not send email' });
  }
  res.json({
    ok: true,
    message: 'If this account needs verification, we sent an email.'
  });
});

// /api/account/saved-prototypes/* — see saved-prototypes.js for behavior.
registerSavedPrototypeRoutes(app, db);
// Cloud Apps (built SPAs deployed from the IDE): management + custom-domain
// routes. The /apps/:id/* serving route is registered AFTER the custom-domain
// middleware below so a domain rewrite to /apps/<id>/… is then served.
const { registerCloudAppRoutes, registerCloudAppServingRoute } = require('./cloud-apps');
registerCloudAppRoutes(app, db);
// LingCode Cloud compute (white-label Workers-for-Platforms): deploy full-stack
// /SSR apps as isolated Workers served at <id>.run.lingcode.dev.
const { registerCloudWorkerRoutes } = require('./cloud-workers');
registerCloudWorkerRoutes(app, db);
// Scheduled jobs (cron) for deployed Workers: CRUD routes + the 60s fan-out
// scheduler (Cloudflare can't run per-tenant Cron Triggers on dispatch scripts).
const { registerWorkerCronRoutes, startWorkerCronScheduler } = require('./cloud-worker-cron');
registerWorkerCronRoutes(app, db);
startWorkerCronScheduler(db);

// Managed-backend serverless functions: internal backend-access RPC endpoint
// (powers ctx.db / ctx.storage inside functions) + scheduled-function CRUD and
// their own 60s scheduler (mirrors the worker cron above, but invokes the Deno
// function in-process rather than firing an HTTP call).
require('./cloud-fn-rpc').registerFnRpcRoute(app);
const { registerFunctionCronRoutes, startFunctionCronScheduler } = require('./cloud-function-cron');
registerFunctionCronRoutes(app, db);
startFunctionCronScheduler(db);
// Per-app metering (CF GraphQL poll → worker_usage + daily-quota auto-suspend) and
// the per-app log tail (ingested from the out-of-repo dispatch Tail Worker).
const { registerWorkerUsageRoutes, startWorkerUsagePoller } = require('./cloud-worker-usage');
registerWorkerUsageRoutes(app, db);
startWorkerUsagePoller(db);
const { registerWorkerLogRoutes } = require('./cloud-worker-logs');
registerWorkerLogRoutes(app, db);
// Customer-owned custom domains: install the Host→prototype/app rewrite BEFORE
// the /p/:id + /apps/:id routes so a registered domain serves its mapped app,
// then the management + edge-ask routes.
const { installCustomDomainMiddleware, registerCustomDomainRoutes } = require('./cloud-domains');
installCustomDomainMiddleware(app, db);
registerCustomDomainRoutes(app, db);
// Domainee (domainee.dev) custom-domain edge: when configured, the worker
// domain-add route routes a customer domain through Domainee's proxy (one CNAME,
// auto Let's Encrypt, white-label) to the app's worker URL. Inert until env key set.
const { registerDomaineeRoutes } = require('./cloud-domainee');
registerDomaineeRoutes(app, db);
// Domain Connect (open standard): one-click DNS-write at the user's registrar
// ("Authorize with GoDaddy"), pointing at our edge. Inert until onboarded + keyed.
const { registerDomainConnectRoutes } = require('./cloud-domainconnect');
registerDomainConnectRoutes(app, db);
// GET /apps/<id>/* — real sub-path static serving + SPA fallback for cloud apps.
registerCloudAppServingRoute(app, db);
// GET /p/<id> — public short-link redirect to the share-link form.
registerPublicShareRoute(app, db);

// CLI token: mint/return the user's api_access_token (creates one if
// missing). Auth = session cookie — user must already be signed in via
// the browser. The /cli-token.html page calls this endpoint and shows
// the token in a copy-button. Used by `lingcode auth login --provider
// lingmodel` so the terminal CLI can hit /api/inference with bearer auth.
app.post('/api/account/cli-token', (req, res) => {
  const u = getUserFromRequest(db, req);
  if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
  let token = u.api_access_token;
  if (!token || typeof token !== 'string' || token.length < 32) {
    token = 'lcat_' + crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE users SET api_access_token = ? WHERE id = ?').run(token, u.id);
  }
  res.json({ ok: true, token });
});

// DELETE rotates the token (issues a fresh one, invalidates the old).
app.delete('/api/account/cli-token', (req, res) => {
  const u = getUserFromRequest(db, req);
  if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const token = 'lcat_' + crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE users SET api_access_token = ? WHERE id = ?').run(token, u.id);
  res.json({ ok: true, token });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ ok: !!req.session.admin });
});

app.post('/api/admin/login', (req, res) => {
  const password = (req.body && String(req.body.password)) || '';
  const plain = process.env.ADMIN_PASSWORD;
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (!plain && !hash) {
    return res.status(503).json({
      error: 'Admin not configured. Set ADMIN_PASSWORD or ADMIN_PASSWORD_HASH in .env.'
    });
  }
  let ok = false;
  if (hash) {
    try {
      ok = bcrypt.compareSync(password, hash);
    } catch {
      ok = false;
    }
  } else if (plain) {
    ok = password === plain;
  }
  if (!ok) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  req.session.admin = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {});
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, email, tier, created_at, source,
        stripe_customer_id, stripe_subscription_id, subscription_status,
        subscription_current_period_end, billing_interval
      FROM users ORDER BY datetime(created_at) DESC`
    )
    .all();
  res.json({ users: rows });
});

// DMG download stats. Reads from `download_stats` populated nightly by
// `scripts/aggregate-downloads.js`. Returns:
//   - lifetime totals per filename (count_200 sum, count_206 sum, last_seen day)
//   - daily rows for the requested window (default 90 days, max 3650 = ~10 years)
app.get('/api/admin/download-stats', requireAdmin, (req, res) => {
  const days = Math.max(1, Math.min(3650, parseInt(String(req.query.days || '90'), 10)));
  const sinceDay = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const daily = db.prepare(`
    SELECT day, filename, count_200, count_206, unique_ips
    FROM download_stats
    WHERE day >= ?
    ORDER BY day DESC, filename
  `).all(sinceDay);
  const lifetime = db.prepare(`
    SELECT filename,
           SUM(count_200) AS total_200,
           SUM(count_206) AS total_206,
           SUM(unique_ips) AS total_unique_ip_days,
           MIN(day) AS first_seen,
           MAX(day) AS last_seen
    FROM download_stats
    GROUP BY filename
    ORDER BY total_200 DESC
  `).all();
  const grandTotal = db.prepare(`
    SELECT SUM(count_200) AS total_200, SUM(count_206) AS total_206
    FROM download_stats
  `).get();
  res.json({ days, since: sinceDay, lifetime, daily, grand_total: grandTotal });
});

// Aggregate Mac app usage. Returns per-day active minutes for one user (when
// `?user_id=N`) or the totals across all users for the requested window
// (default 7 days, max 90). Each row in app_usage_minutes is one minute of
// activity, so COUNT(*) === active minutes.
app.get('/api/admin/usage-stats', requireAdmin, (req, res) => {
  const userId = req.query.user_id ? parseInt(String(req.query.user_id), 10) : null;
  const days = Math.max(1, Math.min(90, parseInt(String(req.query.days || '7'), 10)));
  const sinceMinute = Math.floor(Date.now() / 60000) - days * 24 * 60;

  if (userId) {
    const rows = db.prepare(`
      SELECT date(minute_bucket * 60, 'unixepoch') AS day,
             COUNT(*) AS active_minutes
      FROM app_usage_minutes
      WHERE user_id = ? AND minute_bucket >= ?
      GROUP BY day
      ORDER BY day DESC
    `).all(userId, sinceMinute);
    const totalMinutes = rows.reduce((acc, r) => acc + r.active_minutes, 0);
    return res.json({ user_id: userId, days, total_minutes: totalMinutes, daily: rows });
  }

  // Cross-user summary: distinct users active per day + total active minutes per day.
  const rows = db.prepare(`
    SELECT date(minute_bucket * 60, 'unixepoch') AS day,
           COUNT(DISTINCT user_id) AS active_users,
           COUNT(*) AS total_minutes
    FROM app_usage_minutes
    WHERE minute_bucket >= ?
    GROUP BY day
    ORDER BY day DESC
  `).all(sinceMinute);
  res.json({ days, daily: rows });
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const email = String(req.body.email || '')
    .trim()
    .toLowerCase();
  const tier = String(req.body.tier || 'free').trim() || 'free';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  const id = crypto.randomUUID();
  const created = new Date().toISOString();
  try {
    db.prepare(
      'INSERT INTO users (id, email, tier, created_at, source) VALUES (?, ?, ?, ?, ?)'
    ).run(id, email, tier, created, 'admin');
    res.json({ id, email, tier, created_at: created, source: 'admin' });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    throw e;
  }
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const r = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  if (r.changes === 0) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({ ok: true });
});

const ADMIN_USER_TIERS = new Set(['free', 'pro', 'max_pro']);

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const tier = String((req.body && req.body.tier) || '').trim().toLowerCase();
  if (!ADMIN_USER_TIERS.has(tier)) {
    return res.status(400).json({ error: 'Invalid tier. Use: ' + [...ADMIN_USER_TIERS].join(', ') });
  }
  const r = db.prepare('UPDATE users SET tier = ? WHERE id = ?').run(tier, req.params.id);
  if (r.changes === 0) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({ ok: true, id: req.params.id, tier });
});

// Install-stats endpoint for the admin dashboard. Counts first-party signals from
// nginx logs + the users table — no in-app telemetry required. See admin-dashboard.html.
//   • "active installs" = unique IPs of Sparkle clients hitting /appcast.xml
//   • "DMG downloads"   = unique (ip, path, day) tuples across HTTP 200 + 206.
//     Counting both statuses with dedup handles download managers (Free Download
//     Manager, curl --range, Sparkle resume) that emit many HTTP 206 partials per
//     one download without over-counting them.
app.get('/api/admin/install-stats', requireAdmin, (req, res) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const T7 = nowSec - 7 * 86400;
  const T30 = nowSec - 30 * 86400;
  // Single awk pass over all log files. mktime parses nginx's time_local.
  const awkProg = String.raw`
    BEGIN {
      split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", mn, " ");
      for (i=1; i<=12; i++) midx[mn[i]] = i;
    }
    {
      ts = substr($4, 2);
      split(ts, p, /[\/:]/);
      if (!(p[2] in midx)) next;
      t = mktime(p[3] " " midx[p[2]] " " p[1] " " p[4] " " p[5] " " p[6]);
      if (t < T30) next;

      is_sparkle = ($0 ~ /Sparkle\//);
      if ($9 == "200" && $7 ~ /^\/appcast\.xml/ && is_sparkle) {
        if (t >= T7)  ipa7[$1]  = 1;
        if (t >= T30) ipa30[$1] = 1;
      }
      # Download managers split one download into many HTTP 206 partials.
      # Dedup on (ip, path, day) so each user-day-version counts once.
      if (($9 == "200" || $9 == "206") && $7 ~ /^\/LingCode-v[0-9.]+-Installer\.dmg/) {
        day = strftime("%Y-%m-%d", t);
        key = $1 SUBSEP $7 SUBSEP day;
        if (t >= T7  && !(key in seen7))  { dmg7++;  seen7[key]  = 1; }
        if (t >= T30 && !(key in seen30)) { dmg30++; ver30[$7]++; seen30[key] = 1; }
      }
      # CLI install script: curl https://lingcode.dev/install-cli.sh | sh
      # Each successful curl is a fresh install attempt; dedup by (ip, day) so
      # someone re-running the install pipeline isn't counted as 5 users.
      if ($9 == "200" && $7 ~ /^\/install-cli\.sh/) {
        day = strftime("%Y-%m-%d", t);
        ckey = $1 SUBSEP day;
        if (t >= T7  && !(ckey in cli7))  { cli_inst7++;  cli7[ckey]  = 1; }
        if (t >= T30 && !(ckey in cli30)) { cli_inst30++; cli30[ckey] = 1; }
      }
      # CLI tarball downloads. Same 200/206 dedup logic as DMG. Track per
      # platform-arch (darwin-arm64, darwin-x86_64, linux-x86_64).
      if (($9 == "200" || $9 == "206") &&
          $7 ~ /^\/lingcode-cli-(latest|v[0-9.]+)-(darwin|linux)-(arm64|x86_64|aarch64)\.tar\.gz/) {
        day = strftime("%Y-%m-%d", t);
        # Extract platform-arch slug for the breakdown.
        pa = $7;
        sub(/^.*-(darwin|linux)-/, "&", pa);
        sub(/^.*lingcode-cli-(latest|v[0-9.]+)-/, "", pa);
        sub(/\.tar\.gz.*$/, "", pa);
        tkey = $1 SUBSEP $7 SUBSEP day;
        if (t >= T7  && !(tkey in tarseen7))  { cli_tar7++;  tarseen7[tkey]  = 1; }
        if (t >= T30 && !(tkey in tarseen30)) { cli_tar30++; cli_pa30[pa]++; tarseen30[tkey] = 1; }
      }
    }
    END {
      n7 = 0;  for (k in ipa7)  n7++;
      n30 = 0; for (k in ipa30) n30++;
      printf "appcast_7d=%d\n",  n7;
      printf "appcast_30d=%d\n", n30;
      printf "dmg_7d=%d\n",      dmg7+0;
      printf "dmg_30d=%d\n",     dmg30+0;
      for (k in ver30) printf "ver_30d=%s=%d\n", k, ver30[k];
      printf "cli_inst_7d=%d\n",  cli_inst7+0;
      printf "cli_inst_30d=%d\n", cli_inst30+0;
      printf "cli_tar_7d=%d\n",   cli_tar7+0;
      printf "cli_tar_30d=%d\n",  cli_tar30+0;
      for (k in cli_pa30) printf "cli_pa_30d=%s=%d\n", k, cli_pa30[k];
    }
  `;
  // Spawn zcat + awk directly and pipe them — avoids any shell quoting of the awk
  // program (bash would otherwise expand $0/$7/\n inside it).
  const zcatCmd = 'zcat -f /var/log/nginx/access.log /var/log/nginx/access.log.1 /var/log/nginx/access.log.*.gz 2>/dev/null';
  const zcat = spawn('/bin/bash', ['-c', zcatCmd]);
  const awk = spawn('/usr/bin/awk', ['-v', `T7=${T7}`, '-v', `T30=${T30}`, awkProg], { stdio: ['pipe', 'pipe', 'pipe'] });
  zcat.stdout.pipe(awk.stdin);
  zcat.on('error', () => {});
  awk.stdin.on('error', () => {}); // broken pipe if zcat dies early — ignore, awk handles it
  let stdout = '';
  let stderr = '';
  awk.stdout.on('data', (d) => { stdout += d; });
  awk.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => { zcat.kill('SIGKILL'); awk.kill('SIGKILL'); }, 15000);
  awk.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      return res.status(500).json({ error: `awk exited ${code}: ${stderr.slice(0, 500)}` });
    }
    const out = {
      active_installs_7d: 0,
      active_installs_30d: 0,
      dmg_downloads_7d: 0,
      dmg_downloads_30d: 0,
      dmg_by_version_30d: {},
      cli_install_runs_7d: 0,
      cli_install_runs_30d: 0,
      cli_tarball_downloads_7d: 0,
      cli_tarball_downloads_30d: 0,
      cli_by_platform_30d: {},
      signups_7d: 0,
      signups_30d: 0,
      signups_total: 0,
    };
    for (const line of stdout.split('\n')) {
      let m;
      if ((m = line.match(/^appcast_7d=(\d+)/)))  out.active_installs_7d  = +m[1];
      else if ((m = line.match(/^appcast_30d=(\d+)/))) out.active_installs_30d = +m[1];
      else if ((m = line.match(/^dmg_7d=(\d+)/)))      out.dmg_downloads_7d    = +m[1];
      else if ((m = line.match(/^dmg_30d=(\d+)/)))     out.dmg_downloads_30d   = +m[1];
      else if ((m = line.match(/^ver_30d=(\S+)=(\d+)/))) out.dmg_by_version_30d[m[1]] = +m[2];
      else if ((m = line.match(/^cli_inst_7d=(\d+)/)))  out.cli_install_runs_7d   = +m[1];
      else if ((m = line.match(/^cli_inst_30d=(\d+)/))) out.cli_install_runs_30d  = +m[1];
      else if ((m = line.match(/^cli_tar_7d=(\d+)/)))   out.cli_tarball_downloads_7d  = +m[1];
      else if ((m = line.match(/^cli_tar_30d=(\d+)/)))  out.cli_tarball_downloads_30d = +m[1];
      else if ((m = line.match(/^cli_pa_30d=(\S+)=(\d+)/))) out.cli_by_platform_30d[m[1]] = +m[2];
    }
    try {
      out.signups_7d = db.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE datetime(created_at) >= datetime('now', '-7 days')"
      ).get().n;
      out.signups_30d = db.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE datetime(created_at) >= datetime('now', '-30 days')"
      ).get().n;
      out.signups_total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    } catch (_) {}
    res.json(out);
  });
});

// Compute one UTC day's active-install + DMG-download numbers from nginx logs.
// Used by both the nightly scheduler and the back-fill routine below.
function computeDailyLogStats(dateStr) {
  return new Promise((resolve, reject) => {
    const start = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 1000);
    const end = start + 86400;
    const awkProg = String.raw`
      BEGIN {
        split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", mn, " ");
        for (i=1; i<=12; i++) midx[mn[i]] = i;
      }
      {
        ts = substr($4, 2);
        split(ts, p, /[\/:]/);
        if (!(p[2] in midx)) next;
        t = mktime(p[3] " " midx[p[2]] " " p[1] " " p[4] " " p[5] " " p[6]);
        if (t < S || t >= E) next;
        is_sparkle = ($0 ~ /Sparkle\//);
        if ($9 == "200" && $7 ~ /^\/appcast\.xml/ && is_sparkle) ipa[$1] = 1;
        # Dedup resumed downloads: unique (ip, path) within this day.
        if (($9 == "200" || $9 == "206") && $7 ~ /^\/LingCode-v[0-9.]+-Installer\.dmg/) {
          dl[$1 SUBSEP $7] = 1;
        }
      }
      END {
        n = 0; for (k in ipa) n++;
        m = 0; for (k in dl)  m++;
        printf "%d\n%d\n", n, m;
      }
    `;
    const zcat = spawn('/bin/bash', ['-c', 'zcat -f /var/log/nginx/access.log /var/log/nginx/access.log.1 /var/log/nginx/access.log.*.gz 2>/dev/null']);
    const awk = spawn('/usr/bin/awk', ['-v', `S=${start}`, '-v', `E=${end}`, awkProg]);
    zcat.stdout.pipe(awk.stdin);
    zcat.on('error', () => {});
    awk.stdin.on('error', () => {});
    let out = '';
    awk.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { zcat.kill('SIGKILL'); awk.kill('SIGKILL'); }, 15000);
    awk.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`awk exited ${code}`));
      const lines = out.trim().split('\n');
      resolve({
        active_installs: parseInt(lines[0] || '0', 10),
        dmg_downloads: parseInt(lines[1] || '0', 10),
      });
    });
  });
}

async function recordDailyStats(dateStr) {
  const stats = await computeDailyLogStats(dateStr);
  const signups = db.prepare(
    'SELECT COUNT(*) AS n FROM users WHERE date(created_at) = ?'
  ).get(dateStr).n;
  db.prepare(
    'INSERT OR REPLACE INTO stats_daily (date, active_installs, dmg_downloads, signups, collected_at) VALUES (?, ?, ?, ?, ?)'
  ).run(dateStr, stats.active_installs, stats.dmg_downloads, signups, new Date().toISOString());
  return { date: dateStr, ...stats, signups };
}

// Back-fill the last 14 days on startup (only rows that don't already exist), then
// schedule a one-shot for the next 01:10 UTC and a 24h interval after that.
async function bootstrapDailyStats() {
  const now = new Date();
  for (let i = 1; i <= 14; i++) {
    const d = new Date(now.getTime() - i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const existing = db.prepare('SELECT date FROM stats_daily WHERE date = ?').get(dateStr);
    if (existing) continue;
    try { await recordDailyStats(dateStr); }
    catch (_) { /* days outside log retention will fail; skip silently */ }
  }
  // Next 01:10 UTC
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1, 10, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(function tick() {
    const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    recordDailyStats(y).catch((e) => console.error(`[stats] ${y}: ${e.message}`));
    setTimeout(tick, 86400000);
  }, next.getTime() - now.getTime());
}

app.get('/api/admin/stats-history', requireAdmin, (req, res) => {
  const rows = db.prepare(
    "SELECT date, active_installs, dmg_downloads, signups FROM stats_daily WHERE date >= date('now', '-90 days') ORDER BY date ASC"
  ).all();
  res.json({ days: rows });
});

// ─── Model telemetry read routes ─────────────────────────────────────────────
// Powers the "Model Telemetry" section of admin-dashboard.html. All numbers
// derived from rows the Mac app batched into model_telemetry_events.

function telemetryWindowDays(req) {
  const raw = parseInt(String(req.query.days || '30'), 10);
  if (!Number.isFinite(raw) || raw < 1) return 30;
  return Math.min(365, raw);
}

// Active CLI installs from heartbeats. install_id is anonymous; we use it
// as the unique key for "active install" counts and group on version/os to
// show distribution. Admin-only — no public endpoint shows this data.
app.get('/api/admin/cli-installs', requireAdmin, (req, res) => {
  try {
    const active7 = db.prepare(
      "SELECT COUNT(*) AS n FROM cli_heartbeats WHERE datetime(last_seen) >= datetime('now', '-7 days')"
    ).get().n;
    const active30 = db.prepare(
      "SELECT COUNT(*) AS n FROM cli_heartbeats WHERE datetime(last_seen) >= datetime('now', '-30 days')"
    ).get().n;
    const total = db.prepare("SELECT COUNT(*) AS n FROM cli_heartbeats").get().n;
    const byVersion = db.prepare(`
      SELECT version, COUNT(*) AS n FROM cli_heartbeats
      WHERE datetime(last_seen) >= datetime('now', '-30 days')
      GROUP BY version ORDER BY n DESC
    `).all();
    const byOs = db.prepare(`
      SELECT os, arch, COUNT(*) AS n FROM cli_heartbeats
      WHERE datetime(last_seen) >= datetime('now', '-30 days')
      GROUP BY os, arch ORDER BY n DESC
    `).all();
    res.json({
      active_7d: active7,
      active_30d: active30,
      total: total,
      by_version_30d: byVersion,
      by_platform_30d: byOs,
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

app.get('/api/admin/model-telemetry/overview', requireAdmin, (req, res) => {
  const days = telemetryWindowDays(req);
  const since = `datetime('now', '-${days} days')`;

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_events,
      COUNT(DISTINCT install_id) AS unique_installs,
      COUNT(DISTINCT conversation_id) AS unique_conversations,
      SUM(CASE WHEN event_type = 'response' THEN 1 ELSE 0 END) AS responses,
      SUM(CASE WHEN event_type = 'diff_outcome' THEN 1 ELSE 0 END) AS diff_outcomes,
      SUM(CASE WHEN event_type = 'diff_outcome' AND accepted = 1 THEN 1 ELSE 0 END) AS diffs_accepted,
      SUM(CASE WHEN event_type = 'diff_outcome' AND accepted = 0 THEN 1 ELSE 0 END) AS diffs_reverted
    FROM model_telemetry_events
    WHERE datetime(received_at) >= ${since}
  `).get();

  const perModel = db.prepare(`
    SELECT
      provider,
      model,
      SUM(CASE WHEN event_type = 'response' THEN 1 ELSE 0 END) AS responses,
      SUM(CASE WHEN event_type = 'diff_outcome' THEN 1 ELSE 0 END) AS diff_outcomes,
      SUM(CASE WHEN event_type = 'diff_outcome' AND accepted = 1 THEN 1 ELSE 0 END) AS diffs_accepted,
      SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
      SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
      AVG(CASE WHEN event_type = 'response' THEN latency_ms END) AS avg_latency_ms
    FROM model_telemetry_events
    WHERE datetime(received_at) >= ${since} AND provider IS NOT NULL AND model IS NOT NULL
    GROUP BY provider, model
    ORDER BY responses DESC, diff_outcomes DESC
  `).all();

  res.json({ window_days: days, totals, per_model: perModel });
});

// Detect model switches: for each conversation, walk response events in
// client_ts order and emit one "switch" whenever (provider, model) changes
// between consecutive rows. Then aggregate the diff-accept rate in the N
// diff_outcome events that follow each switch within the same conversation,
// so we can answer "switching from Opus → DeepSeek — did diffs still land?"
app.get('/api/admin/model-telemetry/switches', requireAdmin, (req, res) => {
  const days = telemetryWindowDays(req);
  const since = `datetime('now', '-${days} days')`;

  const rows = db.prepare(`
    SELECT conversation_id, event_type, provider, model, accepted, client_ts
    FROM model_telemetry_events
    WHERE datetime(received_at) >= ${since}
    ORDER BY conversation_id ASC, client_ts ASC, id ASC
  `).all();

  // Group by conversation, then scan to find switches and the diff outcomes
  // that followed each switch (until the next switch or end of conversation).
  const pairKey = (p1, m1, p2, m2) => `${p1}::${m1}→${p2}::${m2}`;
  const pairAgg = new Map(); // key → {from_provider, from_model, to_provider, to_model, switches, post_diffs, post_accepted, pre_diffs, pre_accepted}
  const byConv = new Map();
  for (const r of rows) {
    if (!byConv.has(r.conversation_id)) byConv.set(r.conversation_id, []);
    byConv.get(r.conversation_id).push(r);
  }
  for (const [, events] of byConv) {
    let lastResp = null;
    let activeSwitchKey = null;
    let preBufferAgainst = null; // {p,m,diffs,accepted} — last non-switched model's diff outcomes
    for (const e of events) {
      if (e.event_type === 'response') {
        if (lastResp && (lastResp.provider !== e.provider || lastResp.model !== e.model)) {
          const key = pairKey(lastResp.provider, lastResp.model, e.provider, e.model);
          let agg = pairAgg.get(key);
          if (!agg) {
            agg = {
              from_provider: lastResp.provider, from_model: lastResp.model,
              to_provider: e.provider, to_model: e.model,
              switches: 0,
              pre_diffs: 0, pre_accepted: 0,
              post_diffs: 0, post_accepted: 0,
            };
            pairAgg.set(key, agg);
          }
          agg.switches += 1;
          if (preBufferAgainst && preBufferAgainst.p === lastResp.provider && preBufferAgainst.m === lastResp.model) {
            agg.pre_diffs += preBufferAgainst.diffs;
            agg.pre_accepted += preBufferAgainst.accepted;
          }
          activeSwitchKey = key;
          preBufferAgainst = { p: e.provider, m: e.model, diffs: 0, accepted: 0 };
        } else if (!lastResp) {
          preBufferAgainst = { p: e.provider, m: e.model, diffs: 0, accepted: 0 };
        } else if (preBufferAgainst && preBufferAgainst.p === e.provider && preBufferAgainst.m === e.model) {
          // same model — keep accumulating
        }
        lastResp = { provider: e.provider, model: e.model };
      } else if (e.event_type === 'diff_outcome') {
        if (preBufferAgainst) {
          preBufferAgainst.diffs += 1;
          if (e.accepted === 1) preBufferAgainst.accepted += 1;
        }
        if (activeSwitchKey) {
          const agg = pairAgg.get(activeSwitchKey);
          if (agg) {
            agg.post_diffs += 1;
            if (e.accepted === 1) agg.post_accepted += 1;
          }
        }
      }
    }
  }

  const pairs = Array.from(pairAgg.values()).sort((a, b) => b.switches - a.switches);
  res.json({ window_days: days, pairs });
});

// Manual figures pasted weekly from App Store Connect + Stripe. Keys are free-form;
// the admin UI currently writes: app_store_installs_total, app_store_active_devices,
// stripe_mrr_usd, stripe_paying_subscribers.
app.get('/api/admin/manual-stats', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT k, v, updated_at FROM manual_stats').all();
  const out = {};
  rows.forEach((r) => { out[r.k] = { value: r.v, updated_at: r.updated_at }; });
  res.json(out);
});

app.post('/api/admin/manual-stats', requireAdmin, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT INTO manual_stats (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at'
  );
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) {
      if (typeof k !== 'string' || !k.match(/^[a-z0-9_]+$/i)) continue;
      stmt.run(k, String(v ?? ''), now);
    }
  });
  tx(Object.entries(body));
  res.json({ ok: true, updated_at: now });
});

// LingModel tier-mapping config (admin-only). DB row > env > unset. Empty value
// in PUT clears the DB row, falling back to env. Secret keys
// (LINGMODEL_UPSTREAM_API_KEY) are masked in the GET response — only the last 4
// chars are echoed, and the full plaintext is never sent over the wire.
app.get('/api/admin/lingmodel-config', requireAdmin, (req, res) => {
  const maskSecret = (v) => {
    if (!v) return null;
    return v.length <= 4 ? '•'.repeat(v.length) : '••••' + v.slice(-4);
  };
  const out = {};
  for (const k of LINGMODEL_CONFIG_KEYS) {
    const row = db.prepare('SELECT value, updated_at FROM app_config WHERE key = ?').get(k);
    const dbValueRaw = row && typeof row.value === 'string' && row.value.trim() ? row.value.trim() : null;
    const envValueRaw = (process.env[k] || '').trim() || null;
    const isSecret = LINGMODEL_CONFIG_SECRETS.has(k);
    out[k] = {
      effective: isSecret ? maskSecret(dbValueRaw || envValueRaw) : (dbValueRaw || envValueRaw || ''),
      db_value: isSecret ? maskSecret(dbValueRaw) : dbValueRaw,
      env_value: isSecret ? maskSecret(envValueRaw) : envValueRaw,
      source: dbValueRaw ? 'db' : (envValueRaw ? 'env' : 'unset'),
      db_updated_at: row && row.updated_at ? row.updated_at : null,
      secret: isSecret,
    };
  }
  res.json(out);
});

app.put('/api/admin/lingmodel-config', requireAdmin, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const allowed = new Set(LINGMODEL_CONFIG_KEYS);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) return res.status(400).json({ error: `unknown key: ${k}` });
    const v = body[k];
    if (v != null && typeof v !== 'string') {
      return res.status(400).json({ error: `${k} must be string or null` });
    }
  }
  const now = Date.now();
  const upsert = db.prepare(
    'INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  );
  const del = db.prepare('DELETE FROM app_config WHERE key = ?');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(body)) {
      const trimmed = v == null ? '' : String(v).trim();
      if (trimmed === '') del.run(k);
      else upsert.run(k, trimmed, now);
    }
  });
  tx();
  res.json({ ok: true, updated_at: now });
});

// LingModel tier-limit admin endpoints. Same DB-overrides-env pattern as
// lingmodel-config, but for numeric per-tier quotas (daily prompts, 5h
// window prompts, daily/monthly output tokens, burst, anon daily). Empty
// or null value clears the DB row → falls back to env / hard-coded default.
//
// The active values shown in the dashboard come from loadLingModelLimits,
// which is the same function the request handler calls — so what you see
// in the admin UI is what the next request will actually see.
app.get('/api/admin/lingmodel-limits', requireAdmin, (req, res) => {
  // For each key: show the live effective value (number) AND the raw DB
  // override (if any), so the operator can tell "this is set to 100 via
  // dashboard" from "this is 100 because env says so."
  const live = loadLingModelLimits(db);
  const result = { effective: live, overrides: {} };
  for (const k of LINGMODEL_LIMIT_KEYS) {
    const row = db.prepare('SELECT value, updated_at FROM app_config WHERE key = ?').get(k);
    if (row) result.overrides[k] = { value: row.value, updated_at: row.updated_at };
  }
  res.json(result);
});

app.put('/api/admin/lingmodel-limits', requireAdmin, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const allowed = new Set(LINGMODEL_LIMIT_KEYS);
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.has(k)) return res.status(400).json({ error: `unknown key: ${k}` });
    // Allow null/empty (clears the override). Otherwise: non-negative integer.
    if (v == null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return res.status(400).json({ error: `${k} must be a non-negative integer (got ${v})` });
    }
  }
  const now = Date.now();
  const upsert = db.prepare(
    'INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  );
  const del = db.prepare('DELETE FROM app_config WHERE key = ?');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(body)) {
      if (v == null || v === '') { del.run(k); continue; }
      upsert.run(k, String(Number(v)), now);
    }
  });
  tx();
  // Return the new effective state so the dashboard can re-render without
  // a second round-trip.
  const live = loadLingModelLimits(db);
  res.json({ ok: true, updated_at: now, effective: live });
});

// ── Cloud backend limits (per-tier quotas: tables, objects, users, functions,
// emails, function timeout). Same upsert/clear shape as lingmodel-limits; keys
// are `cloud_limit_<tier>_<field>` (allow-listed in cloud-limits.js).
app.get('/api/admin/cloud-limits', requireAdmin, (req, res) => {
  const effective = loadCloudLimits(db);
  const overrides = {};
  for (const k of CLOUD_LIMIT_KEYS) {
    const row = db.prepare('SELECT value, updated_at FROM app_config WHERE key = ?').get(k);
    if (row) overrides[k] = { value: row.value, updated_at: row.updated_at };
  }
  res.json({ effective, overrides });
});

app.put('/api/admin/cloud-limits', requireAdmin, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const allowed = new Set(CLOUD_LIMIT_KEYS);
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.has(k)) return res.status(400).json({ error: `unknown key: ${k}` });
    if (v == null || v === '') continue; // clears the override → revert to default
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return res.status(400).json({ error: `${k} must be a non-negative integer (got ${v})` });
    }
  }
  const now = Date.now();
  const upsert = db.prepare(
    'INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  );
  const del = db.prepare('DELETE FROM app_config WHERE key = ?');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(body)) {
      if (v == null || v === '') { del.run(k); continue; }
      upsert.run(k, String(Number(v)), now);
    }
  });
  tx();
  res.json({ ok: true, updated_at: now, effective: loadCloudLimits(db) });
});

// Deep Agent admin: monthly token caps + kill switch. Same upsert shape
// as lingmodel-config but a separate key allow-list keeps misuse loud
// (a typo'd key 400s instead of silently bloating app_config).
const DEEP_AGENT_CONFIG_KEYS = Object.freeze([
  'deep_agent_enabled',
  'deep_agent_monthly_token_cap_pro',
  'deep_agent_monthly_token_cap_max_pro',
]);

app.get('/api/admin/deep-agent-config', requireAdmin, (req, res) => {
  const out = {};
  for (const k of DEEP_AGENT_CONFIG_KEYS) {
    const row = db.prepare('SELECT value, updated_at FROM app_config WHERE key = ?').get(k);
    const dbValueRaw = row && typeof row.value === 'string' && row.value.trim() ? row.value.trim() : null;
    const envName = k.toUpperCase();
    const envValueRaw = (process.env[envName] || '').trim() || null;
    out[k] = {
      effective: dbValueRaw || envValueRaw || '',
      db_value: dbValueRaw,
      env_value: envValueRaw,
      source: dbValueRaw ? 'db' : (envValueRaw ? 'env' : 'unset'),
      db_updated_at: row && row.updated_at ? row.updated_at : null,
    };
  }
  res.json(out);
});

app.put('/api/admin/deep-agent-config', requireAdmin, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const allowed = new Set(DEEP_AGENT_CONFIG_KEYS);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) return res.status(400).json({ error: `unknown key: ${k}` });
    const v = body[k];
    if (v != null && typeof v !== 'string') {
      return res.status(400).json({ error: `${k} must be string or null` });
    }
    // Sanity-check the cap values so the admin can't accidentally save
    // "two million" or 1.5e9 and break preflight arithmetic.
    if ((k === 'deep_agent_monthly_token_cap_pro' || k === 'deep_agent_monthly_token_cap_max_pro') && v) {
      const n = Number(String(v).replace(/[,_]/g, ''));
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) {
        return res.status(400).json({ error: `${k}: not a finite non-negative integer ≤ 1e9` });
      }
    }
    if (k === 'deep_agent_enabled' && v && !/^(true|false|1|0|yes|no)$/i.test(String(v))) {
      return res.status(400).json({ error: 'deep_agent_enabled must be true/false (or empty to clear)' });
    }
  }
  const now = Date.now();
  const upsert = db.prepare(
    'INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  );
  const del = db.prepare('DELETE FROM app_config WHERE key = ?');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(body)) {
      let trimmed = v == null ? '' : String(v).trim();
      // Normalize numeric caps (strip thousands separators).
      if ((k === 'deep_agent_monthly_token_cap_pro' || k === 'deep_agent_monthly_token_cap_max_pro') && trimmed) {
        trimmed = String(Math.floor(Number(trimmed.replace(/[,_]/g, ''))));
      }
      // Normalize boolean kill switch.
      if (k === 'deep_agent_enabled' && trimmed) {
        trimmed = /^(true|1|yes)$/i.test(trimmed) ? 'true' : 'false';
      }
      if (trimmed === '') del.run(k);
      else upsert.run(k, trimmed, now);
    }
  });
  tx();
  res.json({ ok: true, updated_at: now });
});

// GET /api/admin/deep-agent-usage — current-month usage by user. Joined
// to users.email + tier + any per-user override grant for this month.
// Ordered by total tokens desc so the biggest spenders are first.
app.get('/api/admin/deep-agent-usage', requireAdmin, (req, res) => {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const rows = db.prepare(`
    SELECT u.email, u.tier, u.id AS user_id,
           a.month_yyyy_mm,
           a.input_tokens, a.output_tokens,
           a.cache_read_tokens, a.cache_write_tokens,
           a.turns, a.updated_at,
           (a.input_tokens + a.output_tokens + a.cache_read_tokens + a.cache_write_tokens) AS total_tokens,
           COALESCE(o.bonus_tokens, 0) AS bonus_tokens,
           o.reason AS bonus_reason
      FROM agent_sdk_usage a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN agent_sdk_user_overrides o
        ON o.user_id = a.user_id AND o.month_yyyy_mm = a.month_yyyy_mm
     WHERE a.month_yyyy_mm = ?
     ORDER BY total_tokens DESC
     LIMIT 500
  `).all(month);
  const capPro = (db.prepare('SELECT value FROM app_config WHERE key = ?').get('deep_agent_monthly_token_cap_pro') || {}).value;
  const capMaxPro = (db.prepare('SELECT value FROM app_config WHERE key = ?').get('deep_agent_monthly_token_cap_max_pro') || {}).value;
  res.json({
    month,
    caps: {
      pro: Number(capPro || 2_000_000),
      max_pro: Number(capMaxPro || 8_000_000),
    },
    rows,
  });
});

// GET /api/admin/deep-agent-sessions — live sessions for the admin
// "kill hung session" UI. Joined to users.email for readability.
app.get('/api/admin/deep-agent-sessions', requireAdmin, (req, res) => {
  const sessMod = require('./agent-sdk-session');
  const live = sessMod.listAllSessions();
  // Join to users.email in a single sweep to avoid N queries.
  const emailById = new Map();
  if (live.length) {
    const placeholders = live.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, email FROM users WHERE id IN (${placeholders})`).all(...live.map((s) => s.user_id));
    for (const r of rows) emailById.set(r.id, r.email);
  }
  res.json({
    ok: true,
    sessions: live.map((s) => ({ ...s, email: emailById.get(s.user_id) || null })),
  });
});

// POST /api/admin/deep-agent-sessions/:id/kill — force-close a hung
// session. The SDK loop's abort controller fires, /run's catch maps to
// run_cancelled, and the workspace dir is rm -rf'd.
app.post('/api/admin/deep-agent-sessions/:id/kill', requireAdmin, (req, res) => {
  const sessMod = require('./agent-sdk-session');
  const s = sessMod.getSession(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'session_not_found' });
  sessMod.closeSession(db, s.id, { reason: 'admin_kill' });
  res.json({ ok: true });
});

// POST /api/admin/users/:id/deep-agent-grant — per-user token grant.
// Body: { bonus_tokens: integer >= 0, reason?: string, month?: 'YYYY-MM' }
// Empty bonus_tokens (0 or null) clears the grant for the month.
app.post('/api/admin/users/:id/deep-agent-grant', requireAdmin, (req, res) => {
  const userId = req.params.id;
  const userRow = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!userRow) return res.status(404).json({ error: 'user_not_found' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const monthRaw = typeof body.month === 'string' && /^\d{4}-\d{2}$/.test(body.month) ? body.month : null;
  const month = monthRaw || (() => {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  })();

  const bonusRaw = body.bonus_tokens;
  if (bonusRaw == null || bonusRaw === '') {
    db.prepare('DELETE FROM agent_sdk_user_overrides WHERE user_id = ? AND month_yyyy_mm = ?').run(userId, month);
    return res.json({ ok: true, cleared: true, user_id: userId, month });
  }
  const n = Number(String(bonusRaw).replace(/[,_]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) {
    return res.status(400).json({ error: 'bonus_tokens must be a finite non-negative integer ≤ 1e9' });
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : null;
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO agent_sdk_user_overrides (user_id, month_yyyy_mm, bonus_tokens, reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, month_yyyy_mm) DO UPDATE SET
      bonus_tokens = excluded.bonus_tokens,
      reason       = excluded.reason,
      updated_at   = excluded.updated_at
  `).run(userId, month, Math.floor(n), reason, nowIso, nowIso);
  res.json({ ok: true, user_id: userId, month, bonus_tokens: Math.floor(n), reason });
});

// In-app feedback list for the admin dashboard. Most recent first; supports
// optional ?category= filter and ?limit= (1..500, default 100).
//
// IMPORTANT: this endpoint deliberately does NOT return screenshot_data_url —
// only a boolean `has_screenshot` derived from LENGTH() > 0. Inline-screenshot
// blobs are ~400-500 KB each; including 100 of them inflates the JSON response
// to 50+ MB, which on a high-latency connection caused the dashboard to hang
// on "Loading…" forever. Thumbnails are fetched on demand via
// GET /api/admin/feedback/:id/screenshot, which the <img> tag in the dashboard
// requests lazily via `loading="lazy"`.
app.get('/api/admin/feedback', requireAdmin, (req, res) => {
  const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit || '100'), 10) || 100));
  const category = String(req.query.category || '').toUpperCase();
  let rows;
  if (FEEDBACK_CATEGORIES.has(category)) {
    rows = db.prepare(`
      SELECT id, created_at, category, summary, details, email, app_version, os_version,
             CASE WHEN screenshot_data_url IS NOT NULL AND LENGTH(screenshot_data_url) > 0 THEN 1 ELSE 0 END AS has_screenshot
      FROM feedback
      WHERE category = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(category, limit);
  } else {
    rows = db.prepare(`
      SELECT id, created_at, category, summary, details, email, app_version, os_version,
             CASE WHEN screenshot_data_url IS NOT NULL AND LENGTH(screenshot_data_url) > 0 THEN 1 ELSE 0 END AS has_screenshot
      FROM feedback
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);
  }
  const counts = db.prepare(`
    SELECT category, COUNT(*) AS n FROM feedback GROUP BY category
  `).all();
  res.json({ rows, counts });
});

// Decoded screenshot binary for one feedback row. Admin-only — same guard as
// the list endpoint. Returns raw image bytes (not JSON) with the matching
// Content-Type so the dashboard can use this URL directly as an <img src>
// attribute and let the browser handle decode + caching.
app.get('/api/admin/feedback/:id/screenshot', requireAdmin, (req, res) => {
  const id = parseInt(String(req.params.id || ''), 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const row = db.prepare(`
    SELECT screenshot_data_url FROM feedback WHERE id = ?
  `).get(id);
  if (!row) {
    return res.status(404).json({ error: 'not found' });
  }
  const dataUrl = row.screenshot_data_url;
  if (!dataUrl || typeof dataUrl !== 'string') {
    return res.status(404).json({ error: 'no screenshot on this feedback' });
  }
  // Match the same shape the POST handler enforces:
  //   data:image/(png|jpeg);base64,<payload>
  const m = /^data:image\/(png|jpeg);base64,(.+)$/i.exec(dataUrl);
  if (!m) {
    // Legacy row with malformed payload — surface as 404 rather than throwing.
    return res.status(404).json({ error: 'screenshot payload is not a recognized data URL' });
  }
  const mime = m[1].toLowerCase() === 'jpeg' ? 'image/jpeg' : 'image/png';
  let buf;
  try {
    buf = Buffer.from(m[2], 'base64');
  } catch (_e) {
    return res.status(500).json({ error: 'screenshot decode failed' });
  }
  // Screenshots are immutable after insert, and admin sessions are short, so
  // a 5-minute private cache is safe and cuts repeat fetches when the admin
  // scrolls the table back and forth.
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.end(buf);
});

app.post('/api/register', (req, res) => {
  const expected = process.env.REGISTER_API_KEY;
  if (!expected) {
    return res.status(503).json({ error: 'Registration API not enabled (set REGISTER_API_KEY)' });
  }
  const key = req.headers['x-api-key'] || req.headers['x-lingcode-register-key'];
  if (key !== expected) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  const email = String((req.body && req.body.email) || '')
    .trim()
    .toLowerCase();
  const tier = String((req.body && req.body.tier) || 'free').trim() || 'free';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  const pwdRaw = req.body && req.body.password != null ? String(req.body.password) : '';
  let passwordHash = null;
  if (pwdRaw.length > 0) {
    if (pwdRaw.length < ACCOUNT_PASSWORD_MIN) {
      return res.status(400).json({ error: `Password must be at least ${ACCOUNT_PASSWORD_MIN} characters` });
    }
    passwordHash = hashAccountPassword(pwdRaw);
  }
  const id = crypto.randomUUID();
  const created = new Date().toISOString();
  try {
    if (passwordHash) {
      db.prepare(
        'INSERT INTO users (id, email, tier, created_at, source, password_hash) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(id, email, tier, created, 'api', passwordHash);
    } else {
      db.prepare(
        'INSERT INTO users (id, email, tier, created_at, source) VALUES (?, ?, ?, ?, ?)'
      ).run(id, email, tier, created, 'api');
    }
    referrals.attributeOnSignup(db, req, id); // fresh signup only (guarded)
    res.status(201).json({ id, email, tier, created_at: created, source: 'api' });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const row = db.prepare('SELECT id, email, tier, created_at, source FROM users WHERE email = ?').get(email);
      return res.status(200).json({ ...row, existing: true });
    }
    throw e;
  }
});

registerBillingRoutes(app, {
  db,
  stripe,
  PUBLIC_ORIGIN,
  PRICE_PRO_MONTHLY,
  PRICE_PRO_ANNUAL,
  PRICE_MAX_PRO_MONTHLY,
  PRICE_MAX_PRO_ANNUAL
});

if (process.env.ADMIN_DEV_STATIC === '1') {
  app.use(express.static(path.join(__dirname, '..')));
}

registerCollabRoutes(app, db);
registerRemoteRoutes(app, db); // easy-remote-coding host records

const { registerProjectRoutes } = require('./project-routes');
registerProjectRoutes(app, db);

const { registerCloudEditorRoutes } = require('./cloud-editor');
registerCloudEditorRoutes(app, db);

// JSON error handler — must stay last, after all routes. Express forwards both
// synchronous throws from route handlers (e.g. a SqliteError) and next(err)
// calls here. Returning JSON instead of Express's default HTML error page means
// the admin dashboard's fetch().json() surfaces a real message rather than the
// opaque "The string did not match the expected pattern." SyntaxError.
// (2026-05-25: a corrupt data.db made /api/admin/users 500 with HTML and broke
// the admin console with that exact cryptic string.)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Server error' });
});

const server = http.createServer(app);
initCollabServer(server, db, sessionMiddleware);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LingCode admin API listening on http://127.0.0.1:${PORT}`);
  bootstrapDailyStats().catch((e) => console.error(`[stats] bootstrap: ${e.message}`));
  if (process.env.ADMIN_DEV_STATIC === '1') {
    console.log('ADMIN_DEV_STATIC: serving ../ (admin-signin.html, admin-dashboard.html)');
  }
});
