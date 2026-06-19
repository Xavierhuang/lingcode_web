'use strict';

// cloud-editor.js — server-side agent for the in-browser project editor.
//
// The browser opens a deployed project (/try.html?edit=<projectId>, source loaded
// via GET /api/projects/:id/source/files). When the user prompts, the browser
// streams the request here: we run an Anthropic Messages tool-use loop SERVER-SIDE
// over an in-memory copy of the project's files, and stream text + file changes
// back over SSE. The browser applies `file_update` events to its preview.
//
// Phase 0 = static projects: the agent edits TEXT files only (no shell/build), so
// an in-memory { path: content } map is enough and keeps untrusted execution off
// the box entirely. (SSR build runs in a Cloudflare Sandbox later — see plan.)
//
// LLM access reuses the LingModel Anthropic-shape proxy (same key/URL/model as the
// rest of the server) via inference-anthropic helpers.

const { getUserFromRequest } = require('./auth-helpers');
const { projectRole, roleAtLeast } = require('./project-access');
const { lingmodelAnthropicMessagesUrl, lingmodelUpstreamApiKey, loadLingModelConfig } = require('./inference-anthropic');

const SESSIONS = new Map();              // sessionId -> { projectId, userId, files, createdAt, lastActive }
const SESSION_TTL_MS = 60 * 60 * 1000;   // GC idle sessions after 1h
const MAX_FILES = 600;
const MAX_FILE_BYTES = 512 * 1024;       // per file we'll hand the agent / accept back
const MAX_STEPS = 12;                    // tool-loop iterations per run (runaway guard)
const MAX_TOKENS = 4096;

function gcSessions() {
  const now = Date.now();
  for (const [id, s] of SESSIONS) if (now - s.lastActive > SESSION_TTL_MS) SESSIONS.delete(id);
}

// ── Agent tools (Anthropic tool schema) ──────────────────────────────────────
const TOOLS = [
  { name: 'list_files', description: 'List all file paths in the project.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'read_file', description: 'Read a file\'s full contents.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'write_file', description: 'Create or overwrite a file with the given full contents.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'edit_file', description: 'Replace the first exact occurrence of old_string with new_string in a file. old_string must match exactly and be unique enough to target one spot.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'], additionalProperties: false } },
];

// Run one tool against the session's in-memory files. Returns
// { content: <string for tool_result>, isError?, changedPath? }.
function runTool(session, name, input) {
  const files = session.files;
  input = input || {};
  if (name === 'list_files') {
    return { content: Object.keys(files).sort().join('\n') || '(empty project)' };
  }
  if (name === 'read_file') {
    const p = String(input.path || '');
    if (!(p in files)) return { content: `File not found: ${p}`, isError: true };
    return { content: files[p] };
  }
  if (name === 'write_file') {
    const p = String(input.path || '');
    const content = String(input.content == null ? '' : input.content);
    if (!p) return { content: 'Missing path.', isError: true };
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return { content: 'File too large (>512KB).', isError: true };
    if (!(p in files) && Object.keys(files).length >= MAX_FILES) return { content: 'Project file limit reached.', isError: true };
    files[p] = content;
    return { content: `Wrote ${p} (${content.length} chars).`, changedPath: p };
  }
  if (name === 'edit_file') {
    const p = String(input.path || '');
    if (!(p in files)) return { content: `File not found: ${p}`, isError: true };
    const oldStr = String(input.old_string == null ? '' : input.old_string);
    const newStr = String(input.new_string == null ? '' : input.new_string);
    const idx = files[p].indexOf(oldStr);
    if (oldStr === '' || idx < 0) return { content: `old_string not found in ${p}.`, isError: true };
    files[p] = files[p].slice(0, idx) + newStr + files[p].slice(idx + oldStr.length);
    return { content: `Edited ${p}.`, changedPath: p };
  }
  return { content: `Unknown tool: ${name}`, isError: true };
}

function systemPrompt(session) {
  const tree = Object.keys(session.files).sort().join('\n');
  return [
    'You are LingCode\'s in-browser project editor agent. You edit the source files of a',
    'user\'s DEPLOYED web project. Make the change the user asks for, using the tools.',
    'Keep changes focused and minimal; do not rewrite unrelated files. Prefer edit_file for',
    'small changes and write_file for new files or full rewrites. After making the change,',
    'briefly say what you did. The project is live — be careful.',
    '',
    'Current files:',
    tree || '(empty)',
  ].join('\n');
}

// One streamed upstream turn. Parses the Anthropic SSE, streams text deltas to the
// browser, and assembles the assistant message (text + tool_use blocks). Resolves
// { content, stopReason } where content is the Anthropic content array.
async function streamTurn(db, res, messages, signal) {
  const url = lingmodelAnthropicMessagesUrl(db);
  const key = lingmodelUpstreamApiKey(db);
  const model = (loadLingModelConfig(db) || {}).defaultModel || 'kimi-k2.7';
  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'authorization': 'Bearer ' + key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, stream: true, system: messages.system, tools: TOOLS, messages: messages.turns }),
    signal,
  });
  if (!upstream.ok || !upstream.body) {
    let detail = ''; try { detail = (await upstream.text()).slice(0, 300); } catch (_) {}
    throw new Error(`upstream ${upstream.status}: ${detail}`);
  }
  const blocks = [];
  let stopReason = null;
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev; try { ev = JSON.parse(payload); } catch (_) { continue; }
      if (ev.type === 'content_block_start') {
        const cb = ev.content_block || {};
        blocks[ev.index] = cb.type === 'tool_use'
          ? { type: 'tool_use', id: cb.id, name: cb.name, _json: '' }
          : { type: 'text', text: '' };
      } else if (ev.type === 'content_block_delta') {
        const b = blocks[ev.index]; if (!b) continue;
        if (ev.delta.type === 'text_delta' && ev.delta.text) { b.text += ev.delta.text; sse(res, 'text', { text: ev.delta.text }); }
        else if (ev.delta.type === 'input_json_delta' && ev.delta.partial_json) { b._json += ev.delta.partial_json; }
      } else if (ev.type === 'content_block_stop') {
        const b = blocks[ev.index];
        if (b && b.type === 'tool_use') { try { b.input = JSON.parse(b._json || '{}'); } catch (_) { b.input = {}; } delete b._json; sse(res, 'tool', { name: b.name, input: b.input }); }
      } else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) {
        stopReason = ev.delta.stop_reason;
      }
    }
  }
  // Clean content array for the next request (drop empty text blocks).
  const content = blocks.filter(Boolean).map((b) => b.type === 'tool_use'
    ? { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} }
    : { type: 'text', text: b.text || '' }).filter((b) => b.type !== 'text' || b.text);
  return { content, stopReason };
}

function sse(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
}

async function runAgent(db, res, session, prompt, signal) {
  const turns = [{ role: 'user', content: prompt }];
  const messages = { system: systemPrompt(session), turns };
  const changed = new Set();
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) return;
    let turn;
    try { turn = await streamTurn(db, res, messages, signal); }
    catch (e) { if (!signal.aborted) sse(res, 'error', { message: String((e && e.message) || e).slice(0, 300) }); return; }
    if (signal.aborted) return;
    turns.push({ role: 'assistant', content: turn.content.length ? turn.content : [{ type: 'text', text: '' }] });
    const toolUses = turn.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) { sse(res, 'done', { changed: Array.from(changed) }); return; }
    const toolResults = [];
    for (const tu of toolUses) {
      const r = runTool(session, tu.name, tu.input);
      if (r.changedPath) { changed.add(r.changedPath); sse(res, 'file_update', { path: r.changedPath, content: session.files[r.changedPath] }); }
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: String(r.content || ''), is_error: !!r.isError });
    }
    turns.push({ role: 'user', content: toolResults });
  }
  sse(res, 'done', { changed: Array.from(changed), note: 'Reached step limit.' });
}

// ── Routes ───────────────────────────────────────────────────────────────────
function registerCloudEditorRoutes(app, db) {
  // Open an edit session: auth editor+ on the project, take the browser's current
  // files as the working copy. Returns a session id used for /run.
  app.post('/api/cloud-editor/sessions', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const projectId = String((req.body && req.body.projectId) || '');
    const role = projectRole(db, projectId, u.id);
    if (!role) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!roleAtLeast(role, 'editor')) return res.status(403).json({ ok: false, error: 'forbidden' });
    const incoming = (req.body && req.body.files) || {};
    const files = {};
    let n = 0;
    for (const k of Object.keys(incoming)) {
      if (n >= MAX_FILES) break;
      const v = incoming[k];
      if (typeof v !== 'string') continue;
      if (Buffer.byteLength(v, 'utf8') > MAX_FILE_BYTES) continue;
      files[String(k)] = v; n++;
    }
    gcSessions();
    const id = require('crypto').randomUUID();
    SESSIONS.set(id, { projectId, userId: u.id, files, createdAt: Date.now(), lastActive: Date.now() });
    res.json({ ok: true, sessionId: id, files: n });
  });

  // Run one prompt against the session. SSE: text / tool / file_update / done / error.
  app.post('/api/cloud-editor/sessions/:id/run', async (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const session = SESSIONS.get(String(req.params.id || ''));
    if (!session || session.userId !== u.id) return res.status(404).json({ ok: false, error: 'session_not_found' });
    const prompt = String((req.body && req.body.prompt) || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, error: 'empty_prompt' });
    // Optional: sync the browser's latest hand-edits before the run.
    if (req.body && req.body.files && typeof req.body.files === 'object') {
      for (const k of Object.keys(req.body.files)) {
        const v = req.body.files[k];
        if (typeof v === 'string' && Buffer.byteLength(v, 'utf8') <= MAX_FILE_BYTES) session.files[String(k)] = v;
      }
    }
    session.lastActive = Date.now();

    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache, no-transform');
    res.set('Connection', 'keep-alive');
    res.set('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const ac = new AbortController();
    req.on('close', () => ac.abort());
    await runAgent(db, res, session, prompt, ac.signal);
    session.lastActive = Date.now();
    try { res.end(); } catch (_) {}
  });

  // Return the session's current files (post-run sync / save source).
  app.get('/api/cloud-editor/sessions/:id/files', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const session = SESSIONS.get(String(req.params.id || ''));
    if (!session || session.userId !== u.id) return res.status(404).json({ ok: false, error: 'session_not_found' });
    session.lastActive = Date.now();
    res.json({ ok: true, files: session.files });
  });

  app.post('/api/cloud-editor/sessions/:id/close', (req, res) => {
    SESSIONS.delete(String(req.params.id || ''));
    res.json({ ok: true });
  });
}

module.exports = { registerCloudEditorRoutes };
