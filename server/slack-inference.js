// Slack bot inference brain.
//
// v1 reuses the backend's LingModel upstream (DeepSeek by default) as a plain,
// non-streaming Anthropic-shape chat completion — the only inference path that
// is actually deployed in production. The opencode coding-agent that the old
// Socket Mode service used is intentionally NOT wired here; it isn't deployed.
//
// Everything Slack-specific is isolated to this one function so the brain can
// be swapped for opencode / the server Agent SDK later without touching the
// webhook plumbing in slack-events.js.

const {
  lingmodelAnthropicMessagesUrl,
  lingmodelUpstreamApiKey,
  loadLingModelConfig,
} = require('./inference-anthropic');

// Slack hard-caps a single message around 40k chars but practical replies
// should stay short; cap output tokens so we don't generate a wall of text.
const MAX_OUTPUT_TOKENS = 1500;
const SLACK_TEXT_LIMIT = 3500; // leave headroom under Slack's ~40k char cap

const SYSTEM_PROMPT =
  "You are LingCode's Slack assistant. You answer questions and help users " +
  'concisely. Keep replies short and Slack-friendly (a few paragraphs at most, ' +
  'use plain text or simple Slack markdown). You cannot edit files or run code.';

/**
 * Generate a plain-text reply for a Slack thread.
 *
 * @param {object} opts
 * @param {Array<{role: 'user'|'assistant', content: string}>} opts.messages
 *        Conversation turns, oldest first. Must end with a user turn.
 * @param {import('better-sqlite3').Database} opts.db
 * @returns {Promise<string>} reply text (already truncated to Slack limits)
 */
async function generateSlackReply({ messages, db }) {
  const apiKey = lingmodelUpstreamApiKey(db);
  if (!apiKey) {
    throw new Error('LingModel upstream API key not configured');
  }
  const url = lingmodelAnthropicMessagesUrl(db);
  const config = loadLingModelConfig(db);
  const model = config.forceModel || config.defaultModel;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      stream: false,
      system: SYSTEM_PROMPT,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`LingModel upstream ${resp.status}: ${detail.slice(0, 300)}`);
  }

  const data = await resp.json();
  // Anthropic Messages shape: content is an array of blocks; concat the text ones.
  const text = Array.isArray(data.content)
    ? data.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
        .trim()
    : '';

  if (!text) {
    throw new Error('LingModel upstream returned no text content');
  }
  return text.length > SLACK_TEXT_LIMIT ? `${text.slice(0, SLACK_TEXT_LIMIT)}…` : text;
}

module.exports = { generateSlackReply };
