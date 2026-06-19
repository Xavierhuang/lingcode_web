// Tests for the isFreshUserTurn helper in inference-anthropic.js.
//
// The helper decides whether an incoming Anthropic /v1/messages request is
// a fresh user turn (should count against the daily prompt cap) or a tool-
// loop continuation (shouldn't — already counted when the turn started).
// Wrong here = users either get blocked mid-loop or get unmetered traffic.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { isFreshUserTurn } = require('../inference-anthropic.js');

describe('isFreshUserTurn', () => {
  test('fresh: plain string content (simple ask)', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    assert.equal(isFreshUserTurn(body), true);
  });

  test('fresh: array with text block', () => {
    const body = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    assert.equal(isFreshUserTurn(body), true);
  });

  test('fresh: array with image block (vision input)', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xxx' } },
          ],
        },
      ],
    };
    assert.equal(isFreshUserTurn(body), true);
  });

  test('continuation: array of tool_result blocks only', () => {
    const body = {
      messages: [
        { role: 'user', content: 'find todos' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: 'Grep', input: {} }] },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'no matches' }],
        },
      ],
    };
    assert.equal(isFreshUserTurn(body), false, 'pure tool_result block should not count');
  });

  test('continuation: multiple tool_results in one turn', () => {
    const body = {
      messages: [
        { role: 'user', content: 'do many things' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'a' },
            { type: 'tool_result', tool_use_id: 't2', content: 'b' },
          ],
        },
      ],
    };
    assert.equal(isFreshUserTurn(body), false);
  });

  test('fresh: mixed tool_result + text (user replied during loop)', () => {
    // Rare but legal — user supplies a follow-up note alongside tool results.
    // Count this as fresh because the user actively contributed new content.
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
            { type: 'text', text: 'actually, also check the auth flow' },
          ],
        },
      ],
    };
    assert.equal(isFreshUserTurn(body), true);
  });

  test('fresh: walks back past assistant turns to find the last user', () => {
    // Multi-turn conversation; the trailing assistant message has no
    // bearing — we look at the user message that came before it.
    const body = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'tell me a joke' },
        { role: 'assistant', content: 'a joke' },
      ],
    };
    assert.equal(isFreshUserTurn(body), true);
  });

  test('permissive: missing body counts as fresh (never silently unmetered)', () => {
    assert.equal(isFreshUserTurn(null), true);
    assert.equal(isFreshUserTurn(undefined), true);
    assert.equal(isFreshUserTurn({}), true);
    assert.equal(isFreshUserTurn({ messages: [] }), true);
  });

  test('permissive: malformed content shapes count as fresh', () => {
    assert.equal(isFreshUserTurn({ messages: [{ role: 'user', content: null }] }), true);
    assert.equal(isFreshUserTurn({ messages: [{ role: 'user', content: [] }] }), true);
    assert.equal(isFreshUserTurn({ messages: [{ role: 'user' }] }), true);
  });

  test('handles all-assistant message arrays gracefully', () => {
    const body = {
      messages: [
        { role: 'assistant', content: 'hi' },
        { role: 'assistant', content: 'still me' },
      ],
    };
    assert.equal(isFreshUserTurn(body), true);
  });
});
