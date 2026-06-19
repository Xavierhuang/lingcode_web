// Slack Events API webhook.
//
// Replaces the old standalone Socket Mode service (opencode-dev/packages/slack)
// so the bot works in EVERY workspace that installs it, not just the one whose
// token was hardcoded. On each event we look up the installing workspace's
// bot_token from the slack_installations table (populated by the OAuth callback
// in index.js) and reply with that token.
//
// Mounted in index.js with express.raw() so the raw body is available for
// signature verification — same constraint as the Stripe webhook.

const crypto = require('crypto');
const { generateSlackReply } = require('./slack-inference');

const SLACK_API = 'https://slack.com/api';
// Reject requests whose timestamp is older than this (replay protection).
const MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5;
// Remember recently-processed event ids so Slack's delivery retries don't
// produce duplicate replies. In-memory is fine: the backend is a single
// long-lived systemd process.
const DEDUP_TTL_MS = 60 * 5 * 1000;
const seenEvents = new Map(); // event_id -> firstSeenMs

function rememberEvent(eventId) {
  const now = Date.now();
  for (const [id, ts] of seenEvents) {
    if (now - ts > DEDUP_TTL_MS) seenEvents.delete(id);
  }
  if (seenEvents.has(eventId)) return false; // already processed
  seenEvents.set(eventId, now);
  return true;
}

/**
 * Verify a Slack request signature.
 * @param {Buffer|string} rawBody  exact bytes Slack sent
 * @param {import('http').IncomingHttpHeaders} headers
 * @param {string} signingSecret
 * @returns {boolean}
 */
function verifySlackSignature(rawBody, headers, signingSecret) {
  if (!signingSecret) return false;
  const timestamp = headers['x-slack-request-timestamp'];
  const signature = headers['x-slack-signature'];
  if (!timestamp || !signature) return false;

  const ts = parseInt(String(timestamp), 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const base = `v0:${timestamp}:${body}`;
  const expected =
    'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Strip leading/inline bot mentions like `<@U123>` from the text. */
function stripMentions(text) {
  return String(text || '')
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function postSlackMessage(botToken, { channel, thread_ts, text }) {
  const resp = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel, thread_ts, text }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!data.ok) {
    console.error('Slack chat.postMessage failed:', data.error || resp.status);
  }
  return data;
}

/**
 * Process one Slack event payload (already signature-verified). Fire-and-forget;
 * never throws to the caller — logs and posts a friendly error instead.
 * @param {object} payload  the full Events API envelope
 * @param {import('better-sqlite3').Database} db
 */
async function processSlackEvent(payload, db) {
  const event = payload.event || {};
  const teamId = payload.team_id || event.team;

  // We respond to @-mentions in channels and direct messages.
  const isMention = event.type === 'app_mention';
  const isDM = event.type === 'message' && event.channel_type === 'im';
  if (!isMention && !isDM) return;

  // Ignore anything the bot itself (or any bot) posted, and message edits/joins.
  if (event.bot_id || event.subtype) return;
  if (!event.text || !teamId) return;

  let install;
  try {
    install = db
      .prepare('SELECT bot_token, bot_user_id FROM slack_installations WHERE team_id = ?')
      .get(teamId);
  } catch (err) {
    console.error('Slack installation lookup failed:', err);
    return;
  }
  if (!install || !install.bot_token) {
    console.warn('No Slack installation for team', teamId);
    return;
  }
  // Don't reply to our own messages (DMs echo the bot user too).
  if (install.bot_user_id && event.user === install.bot_user_id) return;

  const channel = event.channel;
  const thread_ts = event.thread_ts || event.ts;
  const prompt = stripMentions(event.text);
  if (!prompt) return;

  // v1: single-turn. messages is an array so adding fetched thread history
  // (conversations.replies) later is a drop-in change.
  const messages = [{ role: 'user', content: prompt }];

  try {
    const reply = await generateSlackReply({ messages, db });
    await postSlackMessage(install.bot_token, { channel, thread_ts, text: reply });
  } catch (err) {
    console.error('Slack reply generation failed:', err);
    await postSlackMessage(install.bot_token, {
      channel,
      thread_ts,
      text: 'Sorry — I had trouble generating a response. Please try again.',
    }).catch(() => {});
  }
}

/**
 * Build the Express handler for POST /api/slack/events. Mount with
 * express.raw({ type: 'application/json' }) so req.body is the raw Buffer.
 * @param {import('better-sqlite3').Database} db
 */
function createSlackEventsHandler(db) {
  return function slackEventsHandler(req, res) {
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (!verifySlackSignature(req.body, req.headers, signingSecret)) {
      return res.status(401).send('invalid signature');
    }

    let payload;
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
      payload = JSON.parse(raw);
    } catch (_) {
      return res.status(400).send('bad payload');
    }

    // URL verification handshake (when you set the Request URL in the console).
    if (payload.type === 'url_verification') {
      return res.status(200).json({ challenge: payload.challenge });
    }

    // Ack within Slack's 3s window, then process asynchronously. Dedup retries.
    res.status(200).send('');
    if (payload.type === 'event_callback') {
      const eventId = payload.event_id;
      if (eventId && !rememberEvent(eventId)) return;
      setImmediate(() => {
        processSlackEvent(payload, db).catch((err) =>
          console.error('Slack event processing error:', err)
        );
      });
    }
  };
}

module.exports = { createSlackEventsHandler, verifySlackSignature };
