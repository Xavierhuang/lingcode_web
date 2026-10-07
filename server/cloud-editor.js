'use strict';

// cloud-editor.js — server-side agent for building and editing web projects
// without a Mac: the in-browser project editor (/try.html?edit=<projectId>) and
// the iPhone app's Build screen.
//
// A client opens a session on a project (an existing one, or a new one created
// here for a "build" session), then streams prompts to it: we run an Anthropic
// Messages tool-use loop SERVER-SIDE over an in-memory copy of the project's
// files and stream text + file changes back over SSE.
//
// Phase 0 = static projects: the agent edits TEXT files only (no shell/build), so
// an in-memory { path: content } map is enough and keeps untrusted execution off
// the box entirely. (SSR build runs in a Cloudflare Sandbox later — see plan.)
//
// Everything that costs money or touches storage goes through this server's own
// public routes on loopback, carrying the caller's credentials, so it is billed,
// capped and validated exactly as if the client had called it directly:
//   • model calls → /api/inference/anthropic/v1/messages (LingModel plan limits,
//     credits, burst; tool-loop continuations don't count as new prompts)
//   • new project  → POST /api/projects
//   • load / save  → GET|POST /api/projects/:id/source[/files] (every changed run
//     is saved as a snapshot, so a server restart loses no work)
//   • deploy       → POST|PUT /api/account/cloud-apps (deploy rate limits, app cap,
//     <slug>.lingcode.app address)

const crypto = require('crypto');
const zlib = require('zlib');
const tar = require('tar-stream');
const { getUserFromRequest } = require('./auth-helpers');
const { projectRole, roleAtLeast } = require('./project-access');
const express = require('express');
const { PUBLIC_APEX } = require('./cloud-apps');

const SESSIONS = new Map();              // sessionId -> { projectId, userId, mode, files, history, appId, ... }
const SESSION_TTL_MS = 60 * 60 * 1000;   // GC idle sessions after 1h
const MAX_FILES = 600;
const MAX_FILE_BYTES = 512 * 1024;       // per file we'll hand the agent / accept back
const MAX_STEPS = 12;                    // tool-loop iterations per run (runaway guard)
// A whole page is often written in one tool call (5–15K tokens). The proxy clamps
// this to the caller's plan (free 24,576 by default). Thinking is capped
// separately: LingModel's reasoning models otherwise take up to max_tokens - 512
// for thinking, which left ~500 tokens for the page and cut it off mid-file.
const MAX_TOKENS = 24000;
const THINKING_BUDGET = 4000;
// While the model writes a file, its partial content is streamed at most this often.
const PROGRESS_INTERVAL_MS = 400;
const MAX_HISTORY_TURNS = 12;            // prompt/reply pairs carried into the next run
const MAX_PROMPT_CHARS = 8000;
const MAX_UNDO = 10;                     // earlier file states kept per session
// The user's own documents (product brief, notes) and images (logo, photos).
// Documents live under DOCS_DIR: the agent reads them, they are saved with the
// project, and they are never published. Images are published with the site.
const DOCS_DIR = '.lingcode/docs/';
const PRIVATE_PREFIX = '.lingcode/';
const MAX_DOC_BYTES = 200 * 1024;
const MAX_DOCS = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ASSET_TOTAL = 25 * 1024 * 1024;
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon' };
// `auto` = the LingModel default the proxy is configured with.
const MODEL = process.env.CLOUD_EDITOR_MODEL || 'auto';

// This process, reached directly (index.js listens on 127.0.0.1:PORT).
function selfOrigin() {
  return (process.env.CLOUD_EDITOR_SELF_ORIGIN || `http://127.0.0.1:${parseInt(process.env.PORT || '3000', 10)}`).replace(/\/$/, '');
}

// Call one of this server's own routes as the requesting user: same bearer token
// or session cookie, so the route authenticates, bills and limits them.
function selfFetch(req, path, init = {}) {
  const headers = Object.assign({}, init.headers || {});
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  if (req.headers.cookie) headers.cookie = req.headers.cookie;
  return fetch(selfOrigin() + path, Object.assign({}, init, { headers }));
}

async function readJson(r) {
  try { return await r.json(); } catch (_) { return {}; }
}

// Pack a { path: content } map, plus binary assets, as a .tar.gz (what the
// source and deploy routes take). `forDeploy` leaves out the private folder.
function packFiles(files, assets = {}, { forDeploy = false } = {}) {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const gz = zlib.createGzip();
    const chunks = [];
    gz.on('data', (c) => chunks.push(c));
    gz.on('end', () => resolve(Buffer.concat(chunks)));
    gz.on('error', reject);
    pack.pipe(gz);
    const keep = (p) => !(forDeploy && p.startsWith(PRIVATE_PREFIX));
    for (const p of Object.keys(files).sort()) if (keep(p)) pack.entry({ name: p, mode: 0o644 }, files[p]);
    for (const p of Object.keys(assets).sort()) if (keep(p)) pack.entry({ name: p, mode: 0o644 }, assets[p]);
    pack.finalize();
  });
}

function isImagePath(p) {
  return Object.prototype.hasOwnProperty.call(IMAGE_TYPES, String(p).split('.').pop().toLowerCase());
}

// A .tar.gz back into text files and binary assets (images, and anything that
// isn't UTF-8 text). The inverse of packFiles.
function unpackFiles(tgz) {
  return new Promise((resolve, reject) => {
    const files = {};
    const assets = {};
    const ex = tar.extract();
    ex.on('entry', (h, stream, next) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const name = String(h.name || '').replace(/^\.\//, '');
        if (h.type === 'file' && name && !name.split('/').includes('..')) {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          const isText = !isImagePath(name) && !text.includes('\uFFFD') && buf.length <= MAX_FILE_BYTES;
          if (isText) files[name] = text; else assets[name] = buf;
        }
        next();
      });
      stream.resume();
    });
    ex.on('finish', () => resolve({ files, assets }));
    ex.on('error', reject);
    try { ex.end(zlib.gunzipSync(tgz)); } catch (e) { reject(e); }
  });
}

// Projects started from the Build screen, so the unpublished ones can be listed
// and reopened ("drafts"). Published ones are found through cloud_apps.
function migrateBuildSites(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_editor_sites (
    project_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    has_files INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cloud_editor_sites_user ON cloud_editor_sites (user_id, updated_at)');
}

const DEFAULT_SITE_TITLE = 'New site';

function appUrl(slug, id) {
  return slug ? `https://${slug}.${PUBLIC_APEX}/` : `${String(process.env.PUBLIC_ORIGIN || 'https://lingcode.dev').replace(/\/$/, '')}/apps/${id}/`;
}

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
  const assets = session.assets || {};
  input = input || {};
  if (name === 'list_files') {
    const lines = Object.keys(files).sort()
      .concat(Object.keys(assets).sort().map((p) => `${p} (image, ${Math.ceil(assets[p].length / 1024)} KB)`));
    return { content: lines.join('\n') || '(empty project)' };
  }
  const p0 = String(input.path || '');
  if (p0 in assets) {
    if (name === 'read_file') {
      return { content: `${p0} is an image the user uploaded (${Math.ceil(assets[p0].length / 1024)} KB). Use it by its path, e.g. <img src="${p0}" alt="…">.` };
    }
    return { content: `${p0} is an image and can't be edited. Reference it by its path instead.`, isError: true };
  }
  if ((name === 'write_file' || name === 'edit_file') && p0.startsWith(PRIVATE_PREFIX)) {
    return { content: `${PRIVATE_PREFIX} holds the user's own documents and is read-only.`, isError: true };
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
  const intro = session.mode === 'build'
    ? [
      'You are LingCode\'s website builder. You build and change a small static website',
      '(HTML, CSS and JavaScript) from the user\'s plain-English requests, using the tools.',
      'The entry point is index.html at the project root; keep the site working when opened',
      'directly in a browser. No build step and no server: plain files only. Tailwind via',
      '<script src="https://cdn.tailwindcss.com"></script> and other libraries from a CDN are',
      'fine. Make it look polished and work on a phone screen first. Use real-sounding copy,',
      'not lorem ipsum. Prefer one index.html plus a few files over many. For a change,',
      'prefer edit_file; use write_file for new files or full rewrites. When done, say in one',
      'or two sentences what you made or changed — the user is not a developer.',
    ]
    : [
      'You are LingCode\'s in-browser project editor agent. You edit the source files of a',
      'user\'s DEPLOYED web project. Make the change the user asks for, using the tools.',
      'Keep changes focused and minimal; do not rewrite unrelated files. Prefer edit_file for',
      'small changes and write_file for new files or full rewrites. After making the change,',
      'briefly say what you did. The project is live — be careful.',
    ];
  const docs = Object.keys(session.files).filter((p) => p.startsWith(DOCS_DIR)).sort();
  const images = Object.keys(session.assets || {}).sort();
  const extra = [];
  if (docs.length) {
    extra.push('', 'The user attached these documents (their product brief, notes or copy). Read them with',
      'read_file before building and use their facts: names, features, prices, tone. They are private:',
      'never link to or copy the files themselves into the site.', ...docs.map((p) => `- ${p}`));
  }
  if (images.length) {
    extra.push('', 'The user uploaded these images. Use them where they fit (a logo in the header, photos',
      'in sections) by their paths, e.g. <img src="images/logo.png">:', ...images.map((p) => `- ${p}`));
  }
  return [...intro, '', 'Current files:', tree || '(empty)', ...extra].join('\n');
}

// The value of a JSON string field in a tool call's partial input, decoded as
// far as it has arrived ("content":"<h1>Hel → "<h1>Hel"). Null until the field
// has started. Used to show a file while the model is still writing it.
function partialStringField(json, field) {
  const m = new RegExp('"' + field + '"\\s*:\\s*"').exec(json);
  if (!m) return null;
  let raw = json.slice(m.index + m[0].length);
  // Stop at the closing quote if it has arrived.
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') { i++; continue; }
    if (raw[i] === '"') { raw = raw.slice(0, i); break; }
  }
  // Drop a half-received escape at the end ("\\" or "\\u00").
  raw = raw.replace(/\\u[0-9a-fA-F]{0,3}$/, '');
  if (/(^|[^\\])(\\\\)*\\$/.test(raw)) raw = raw.slice(0, -1);
  try { return JSON.parse('"' + raw + '"'); } catch (_) { return null; }
}

// One streamed upstream turn. Parses the Anthropic SSE, streams text deltas to the
// browser, and assembles the assistant message (text + tool_use blocks). Resolves
// { content, stopReason } where content is the Anthropic content array.
async function streamTurn(req, res, messages, signal) {
  const upstream = await selfFetch(req, '/api/inference/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: MAX_TOKENS, stream: true,
      thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET },
      system: messages.system, tools: TOOLS, messages: messages.turns,
    }),
    signal,
  });
  if (!upstream.ok || !upstream.body) {
    // The proxy's plan-limit and auth errors are user-facing JSON; pass them on
    // with their status so a client can offer sign-in or an upgrade.
    const body = await readJson(upstream);
    const err = new Error(body.message || body.error || `Model request failed (HTTP ${upstream.status}).`);
    err.status = upstream.status;
    err.code = typeof body.error === 'string' && /^[a-z_]+$/.test(body.error) ? body.error : null;
    throw err;
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
        else if (ev.delta.type === 'input_json_delta' && ev.delta.partial_json) {
          b._json += ev.delta.partial_json;
          announceProgress(res, b);
        }
      } else if (ev.type === 'content_block_stop') {
        const b = blocks[ev.index];
        if (b && b.type === 'tool_use') {
          try { b.input = JSON.parse(b._json || '{}'); } catch (_) { b.input = {}; b.truncated = true; }
          delete b._json;
          sse(res, 'tool', { name: b.name, input: b.input });
        }
      } else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) {
        stopReason = ev.delta.stop_reason;
      }
    }
  }
  // A tool call still open when the stream ended was cut off (out of tokens).
  for (const b of blocks) {
    if (b && b.type === 'tool_use' && b._json !== undefined) {
      try { b.input = JSON.parse(b._json || '{}'); } catch (_) { b.input = {}; b.truncated = true; }
      delete b._json;
    }
  }
  // Clean content array for the next request (drop empty text blocks).
  const content = blocks.filter(Boolean).map((b) => b.type === 'tool_use'
    ? { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} }
    : { type: 'text', text: b.text || '' }).filter((b) => b.type !== 'text' || b.text);
  const truncated = new Set(blocks.filter((b) => b && b.truncated).map((b) => b.id));
  return { content, stopReason, truncated };
}

// While a write_file call streams in: say which file once its path is known
// (`tool_start`), then send its content so far (`file_progress`), throttled.
function announceProgress(res, b) {
  if (b.name !== 'write_file' && b.name !== 'edit_file') return;
  if (!b._path) {
    const path = partialStringField(b._json, 'path');
    // Only a finished path: the closing quote has arrived.
    if (path && new RegExp('"path"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"').test(b._json)) {
      b._path = path;
      sse(res, 'tool_start', { name: b.name, path });
    }
  }
  if (b.name !== 'write_file' || !b._path) return;
  const now = Date.now();
  if (b._lastProgress && now - b._lastProgress < PROGRESS_INTERVAL_MS) return;
  const content = partialStringField(b._json, 'content');
  if (content === null) return;
  b._lastProgress = now;
  sse(res, 'file_progress', { path: b._path, content });
}

function sse(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
}

async function runAgent(req, res, session, prompt, signal) {
  // Earlier prompts and replies, text only: the files themselves are the state,
  // and the agent reads what it needs.
  const turns = [];
  for (const h of session.history) {
    turns.push({ role: 'user', content: h.prompt });
    turns.push({ role: 'assistant', content: h.reply || '(done)' });
  }
  turns.push({ role: 'user', content: prompt });
  const messages = { system: systemPrompt(session), turns };
  const changed = new Set();
  let reply = '';
  const finish = (extra) => {
    session.history.push({ prompt, reply: reply.trim().slice(0, 2000) });
    if (session.history.length > MAX_HISTORY_TURNS) session.history.splice(0, session.history.length - MAX_HISTORY_TURNS);
    return Object.assign({ changed: Array.from(changed) }, extra || {});
  };
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) return finish();
    let turn;
    try { turn = await streamTurn(req, res, messages, signal); }
    catch (e) {
      if (!signal.aborted) sse(res, 'error', { message: String((e && e.message) || e).slice(0, 300), status: (e && e.status) || null, code: (e && e.code) || null });
      return changed.size ? finish() : null;
    }
    if (signal.aborted) return finish();
    const text = turn.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) reply = text;
    turns.push({ role: 'assistant', content: turn.content.length ? turn.content : [{ type: 'text', text: '' }] });
    const toolUses = turn.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) return finish();
    const toolResults = [];
    for (const tu of toolUses) {
      // Cut off mid-call: don't run half a file; tell the model to write less at once.
      const r = turn.truncated.has(tu.id)
        ? { content: 'This tool call was cut off because it was too long, and nothing was written. Write the file in smaller pieces: a shorter first version with write_file, then add sections with edit_file, or move CSS and JavaScript into separate files.', isError: true }
        : runTool(session, tu.name, tu.input);
      if (turn.truncated.has(tu.id)) sse(res, 'tool_cut_off', { name: tu.name });
      if (r.changedPath) { changed.add(r.changedPath); sse(res, 'file_update', { path: r.changedPath, content: session.files[r.changedPath] }); }
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: String(r.content || ''), is_error: !!r.isError });
    }
    turns.push({ role: 'user', content: toolResults });
  }
  return finish({ note: 'Reached step limit.' });
}

// Save the session's files as a new project source snapshot. Returns the version,
// or null (logged) — a failed save must not fail the run the user just watched.
async function saveSnapshot(req, session) {
  if (!Object.keys(session.files).length && !Object.keys(session.assets || {}).length) return null;
  try {
    const r = await selfFetch(req, `/api/projects/${encodeURIComponent(session.projectId)}/source`, {
      method: 'POST', headers: { 'content-type': 'application/gzip' }, body: await packFiles(session.files, session.assets),
    });
    const body = await readJson(r);
    if (!r.ok) { console.warn('[cloud-editor] snapshot save failed', r.status, body.error); return null; }
    session.dirty = false;
    return body.version || null;
  } catch (e) {
    console.warn('[cloud-editor] snapshot save failed', e && e.message);
    return null;
  }
}

// A Build-screen draft got saved files: list it, and name it after its first
// request if it still has the default name.
function noteBuildSiteSaved(db, projectId, prompt) {
  try {
    const title = String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 60) || DEFAULT_SITE_TITLE;
    db.prepare(`UPDATE cloud_editor_sites SET has_files = 1, updated_at = ?,
      title = CASE WHEN title = ? THEN ? ELSE title END WHERE project_id = ?`)
      .run(Date.now(), DEFAULT_SITE_TITLE, title, projectId);
  } catch (_) { /* listing is a convenience; never fail a run over it */ }
}

function sessionFor(db, req, res) {
  const u = getUserFromRequest(db, req);
  if (!u) { res.status(401).json({ ok: false, error: 'unauthorized' }); return null; }
  const session = SESSIONS.get(String(req.params.id || ''));
  if (!session || session.userId !== u.id) { res.status(404).json({ ok: false, error: 'session_not_found' }); return null; }
  session.lastActive = Date.now();
  return session;
}

// The image type from its first bytes (not the name the client sent).
function imageExtension(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && b.slice(0, 6).toString('latin1').startsWith('GIF8')) return 'gif';
  if (b.length >= 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function cleanFiles(incoming) {
  const files = {};
  let n = 0;
  for (const k of Object.keys(incoming || {})) {
    if (n >= MAX_FILES) break;
    const v = incoming[k];
    if (typeof v !== 'string') continue;
    if (Buffer.byteLength(v, 'utf8') > MAX_FILE_BYTES) continue;
    files[String(k)] = v; n++;
  }
  return files;
}

// ── Routes ───────────────────────────────────────────────────────────────────
function registerCloudEditorRoutes(app, db) {
  migrateBuildSites(db);
  const gcTimer = setInterval(gcSessions, 5 * 60 * 1000);
  if (gcTimer.unref) gcTimer.unref();

  // Open a session. Three shapes:
  //   { projectId, files }          — the browser editor's working copy (as before)
  //   { projectId }                 — reopen: files load from the latest snapshot
  //   { mode: 'build', name }       — a new site: creates the project first
  // `mode` is 'edit' (default, a deployed project) or 'build' (making a site).
  // Responds with the session id, project id, files, and the site it deploys to.
  app.post('/api/cloud-editor/sessions', async (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const body = req.body || {};
    const mode = body.mode === 'build' ? 'build' : 'edit';
    let projectId = String(body.projectId || '');
    let files;
    let assets = {};

    if (!projectId) {
      if (mode !== 'build') return res.status(400).json({ ok: false, error: 'missing_project' });
      const name = String(body.name || DEFAULT_SITE_TITLE).trim().slice(0, 120) || DEFAULT_SITE_TITLE;
      const r = await selfFetch(req, '/api/projects', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
      });
      const created = await readJson(r);
      if (!r.ok || !created.project) return res.status(r.status || 500).json({ ok: false, error: created.error || 'project_create_failed' });
      projectId = created.project.id;
      files = {};
      const now = Date.now();
      db.prepare('INSERT OR IGNORE INTO cloud_editor_sites (project_id, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run(projectId, u.id, name, now, now);
    } else {
      const role = projectRole(db, projectId, u.id);
      if (!role) return res.status(404).json({ ok: false, error: 'not_found' });
      if (!roleAtLeast(role, 'editor')) return res.status(403).json({ ok: false, error: 'forbidden' });
      if (body.files && typeof body.files === 'object') {
        files = cleanFiles(body.files);
      } else {
        // The whole saved archive, so images come back too (the /source/files
        // view is text-only).
        const r = await selfFetch(req, `/api/projects/${encodeURIComponent(projectId)}/source`);
        if (r.ok) {
          try {
            const unpacked = await unpackFiles(Buffer.from(await r.arrayBuffer()));
            files = cleanFiles(unpacked.files);
            assets = unpacked.assets;
          } catch (_) {
            return res.status(500).json({ ok: false, error: 'source_unreadable' });
          }
        } else {
          const snap = await readJson(r);
          if (r.status === 404 && snap.error === 'no_snapshot') files = {};
          else return res.status(r.status || 500).json({ ok: false, error: snap.error || 'source_load_failed' });
        }
      }
    }

    // The site this project already deploys to, so Deploy updates it in place.
    let site = null;
    try {
      site = db.prepare('SELECT id, slug, title FROM cloud_apps WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1').get(projectId) || null;
    } catch (_) {}

    gcSessions();
    const id = crypto.randomUUID();
    SESSIONS.set(id, {
      projectId, userId: u.id, mode, files, assets, history: [], undo: [], appId: site ? site.id : null,
      running: false, dirty: false, createdAt: Date.now(), lastActive: Date.now(),
    });
    res.json({
      ok: true, sessionId: id, projectId, mode, files, assets: Object.keys(assets).sort(),
      site: site ? { id: site.id, title: site.title, url: appUrl(site.slug, site.id) } : null,
    });
  });

  // Run one prompt against the session. SSE: text / tool / file_update / done / error.
  // `done` carries { changed, saved } — saved is the snapshot version written.
  app.post('/api/cloud-editor/sessions/:id/run', async (req, res) => {
    const session = sessionFor(db, req, res);
    if (!session) return;
    const prompt = String((req.body && req.body.prompt) || '').trim().slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return res.status(400).json({ ok: false, error: 'empty_prompt' });
    if (session.running) return res.status(409).json({ ok: false, error: 'busy', message: 'This project is already working on a request.' });
    // Optional: sync the browser's latest hand-edits before the run.
    if (req.body && req.body.files && typeof req.body.files === 'object') {
      for (const k of Object.keys(req.body.files)) {
        const v = req.body.files[k];
        if (typeof v === 'string' && Buffer.byteLength(v, 'utf8') <= MAX_FILE_BYTES) { session.files[String(k)] = v; session.dirty = true; }
      }
    }

    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache, no-transform');
    res.set('Connection', 'keep-alive');
    res.set('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // Keep going if the client disconnects (a phone locking mid-run): the work
    // is saved and the client picks it up from /files. Only an explicit
    // /cancel stops the run.
    const ac = new AbortController();
    session.abort = ac;
    session.running = true;
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
    const before = { files: Object.assign({}, session.files), assets: Object.assign({}, session.assets) };
    try {
      const result = await runAgent(req, res, session, prompt, ac.signal);
      if (result) {
        if (result.changed.length) {
          session.dirty = true;
          session.undo.push(before);
          if (session.undo.length > MAX_UNDO) session.undo.shift();
        }
        const saved = session.dirty ? await saveSnapshot(req, session) : null;
        if (saved) noteBuildSiteSaved(db, session.projectId, prompt);
        sse(res, 'done', Object.assign(result, { saved, canUndo: session.undo.length > 0 }));
      }
    } finally {
      clearInterval(heartbeat);
      session.running = false;
      session.abort = null;
      session.lastActive = Date.now();
      try { res.end(); } catch (_) {}
    }
  });

  app.post('/api/cloud-editor/sessions/:id/cancel', (req, res) => {
    const session = sessionFor(db, req, res);
    if (!session) return;
    if (session.abort) session.abort.abort();
    res.json({ ok: true });
  });

  // The session's current files and state (post-run sync, or a client catching
  // up after its stream dropped).
  app.get('/api/cloud-editor/sessions/:id/files', (req, res) => {
    const session = sessionFor(db, req, res);
    if (!session) return;
    res.json({
      ok: true, files: session.files, assets: Object.keys(session.assets).sort(), running: session.running, canUndo: session.undo.length > 0,
      history: session.history.map((h) => ({ prompt: h.prompt, reply: h.reply })),
    });
  });

  // Put the files back as they were before the last change that changed them,
  // and save that as a new snapshot. Responds with the files.
  app.post('/api/cloud-editor/sessions/:id/undo', async (req, res) => {
    const session = sessionFor(db, req, res);
    if (!session) return;
    if (session.running) return res.status(409).json({ ok: false, error: 'busy', message: 'Wait for the current request to finish.' });
    if (!session.undo.length) return res.status(400).json({ ok: false, error: 'nothing_to_undo', message: 'There is nothing to undo.' });
    const previous = session.undo.pop();
    session.files = previous.files;
    session.assets = previous.assets;
    session.dirty = true;
    // The model should know the last change is gone.
    session.history.push({ prompt: '(The user undid the last change.)', reply: 'Reverted the files to how they were before that change.' });
    const saved = await saveSnapshot(req, session);
    res.json({ ok: true, files: session.files, assets: Object.keys(session.assets).sort(), saved, canUndo: session.undo.length > 0 });
  });

  // Attach a document or an image. Raw body; ?kind=doc|image&name=<file name>.
  // A document is UTF-8 text (the app extracts a PDF's text first) and is saved
  // under .lingcode/docs/; an image is saved under images/. Responds { path }.
  // Both are saved with the project; an attachment can be undone like a change.
  app.post('/api/cloud-editor/sessions/:id/attach', express.raw({ type: () => true, limit: MAX_IMAGE_BYTES + 1024 }), async (req, res) => {
    const session = sessionFor(db, req, res);
    if (!session) return;
    if (session.running) return res.status(409).json({ ok: false, error: 'busy', message: 'Wait for the current request to finish.' });
    const kind = String(req.query.kind || '');
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!bytes.length) return res.status(400).json({ ok: false, error: 'empty', message: 'The file is empty.' });
    const rawName = String(req.query.name || '').split(/[\\/]/).pop();
    const stem = rawName.replace(/\.[^.]*$/, '').toLowerCase()
      .normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || (kind === 'doc' ? 'brief' : 'image');
    const unique = (dir, ext, taken) => {
      let path = `${dir}${stem}.${ext}`;
      for (let i = 2; taken(path); i++) path = `${dir}${stem}-${i}.${ext}`;
      return path;
    };
    const before = { files: Object.assign({}, session.files), assets: Object.assign({}, session.assets) };
    let path;
    if (kind === 'doc') {
      if (bytes.length > MAX_DOC_BYTES) return res.status(413).json({ ok: false, error: 'too_large', message: 'Documents can be up to 200 KB of text.' });
      const text = bytes.toString('utf8');
      if (text.includes('\uFFFD')) return res.status(400).json({ ok: false, error: 'not_text', message: 'Only text documents can be attached (Markdown, text, or a PDF\'s text).' });
      if (Object.keys(session.files).filter((p) => p.startsWith(DOCS_DIR)).length >= MAX_DOCS) {
        return res.status(409).json({ ok: false, error: 'too_many', message: `A site can have up to ${MAX_DOCS} documents.` });
      }
      path = unique(DOCS_DIR, 'md', (p) => p in session.files);
      session.files[path] = text;
    } else if (kind === 'image') {
      const ext = imageExtension(bytes);
      if (!ext) return res.status(400).json({ ok: false, error: 'not_image', message: 'Upload a PNG, JPEG, GIF or WebP image.' });
      if (bytes.length > MAX_IMAGE_BYTES) return res.status(413).json({ ok: false, error: 'too_large', message: 'Images can be up to 5 MB.' });
      const total = Object.values(session.assets).reduce((n, b) => n + b.length, 0);
      if (total + bytes.length > MAX_ASSET_TOTAL) return res.status(413).json({ ok: false, error: 'too_large', message: 'A site can hold up to 25 MB of images.' });
      path = unique('images/', ext, (p) => p in session.assets || p in session.files);
      session.assets[path] = bytes;
    } else {
      return res.status(400).json({ ok: false, error: 'bad_kind' });
    }
    session.undo.push(before);
    if (session.undo.length > MAX_UNDO) session.undo.shift();
    session.dirty = true;
    const saved = await saveSnapshot(req, session);
    // Lists the draft; its name still comes from the first request.
    if (saved) noteBuildSiteSaved(db, session.projectId, '');
    res.json({ ok: true, path, kind, bytes: bytes.length, saved, canUndo: true });
  });

  // One uploaded image, for the client's preview.
  app.get('/api/cloud-editor/sessions/:id/asset', (req, res) => {
    const session = sessionFor(db, req, res);
    if (!session) return;
    const path = String(req.query.path || '');
    const buf = session.assets[path];
    if (!buf) return res.status(404).json({ ok: false, error: 'not_found' });
    res.set('Content-Type', IMAGE_TYPES[path.split('.').pop().toLowerCase()] || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  });

  // Publish the session's files as a static site: the first deploy creates it at
  // <slug>.lingcode.app, later ones update the same site. Body: { title?, slug? }.
  app.post('/api/cloud-editor/sessions/:id/deploy', async (req, res) => {
    const session = sessionFor(db, req, res);
    if (!session) return;
    if (session.running) return res.status(409).json({ ok: false, error: 'busy', message: 'Wait for the current request to finish.' });
    if (!('index.html' in session.files)) {
      return res.status(400).json({ ok: false, error: 'missing_index', message: 'The site needs an index.html before it can be published.' });
    }
    if (session.dirty) await saveSnapshot(req, session);
    const title = String((req.body && req.body.title) || '').trim().slice(0, 120);
    const slug = String((req.body && req.body.slug) || '').trim().toLowerCase();
    const headers = { 'content-type': 'application/gzip', 'x-lingcode-project-id': session.projectId };
    if (title) headers['x-app-title'] = encodeURIComponent(title);
    if (slug) headers['x-app-slug'] = encodeURIComponent(slug);
    const path = session.appId ? `/api/account/cloud-apps/${encodeURIComponent(session.appId)}` : '/api/account/cloud-apps';
    let r = await selfFetch(req, path, { method: session.appId ? 'PUT' : 'POST', headers, body: await packFiles(session.files, session.assets, { forDeploy: true }) });
    let body = await readJson(r);
    // The linked site was deleted since: publish a new one.
    if (session.appId && r.status === 404) {
      session.appId = null;
      r = await selfFetch(req, '/api/account/cloud-apps', { method: 'POST', headers, body: await packFiles(session.files, session.assets, { forDeploy: true }) });
      body = await readJson(r);
    }
    if (!r.ok) return res.status(r.status).json(Object.assign({ ok: false }, body));
    session.appId = body.id || session.appId;
    res.json({ ok: true, id: body.id, url: body.url, slug: body.slug || null });
  });

  app.post('/api/cloud-editor/sessions/:id/close', (req, res) => {
    const session = sessionFor(db, req, res);
    if (!session) return;
    if (session.abort) session.abort.abort();
    SESSIONS.delete(String(req.params.id));
    res.json({ ok: true });
  });

  // The caller's published static sites, with the project each one is built
  // from (so a client can reopen it in a session). Newest first.
  app.get('/api/cloud-editor/sites', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const rows = db.prepare(`
      SELECT DISTINCT ca.id, ca.title, ca.slug, ca.project_id, ca.updated_at
      FROM cloud_apps ca
      LEFT JOIN project_members pm ON ca.project_id = pm.project_id AND pm.user_id = @uid
      WHERE ca.user_id = @uid OR (pm.user_id IS NOT NULL AND pm.role IN ('owner', 'editor'))
      ORDER BY ca.updated_at DESC
      LIMIT 100
    `).all({ uid: u.id });
    // Unpublished Build-screen sites the user can still open (editor+).
    const drafts = db.prepare(`
      SELECT s.project_id, s.title, s.updated_at FROM cloud_editor_sites s
      JOIN project_members pm ON pm.project_id = s.project_id AND pm.user_id = @uid AND pm.role IN ('owner', 'editor')
      WHERE s.has_files = 1
        AND NOT EXISTS (SELECT 1 FROM cloud_apps ca WHERE ca.project_id = s.project_id)
      ORDER BY s.updated_at DESC
      LIMIT 100
    `).all({ uid: u.id });
    res.json({ ok: true, items: [
      ...rows.map((r) => ({
        id: r.id, title: r.title, projectId: r.project_id || null, updatedAt: r.updated_at, url: appUrl(r.slug, r.id), published: true,
      })),
      ...drafts.map((d) => ({
        id: `draft:${d.project_id}`, title: d.title, projectId: d.project_id, updatedAt: d.updated_at, url: null, published: false,
      })),
    ] });
  });
}

module.exports = { registerCloudEditorRoutes, _sessions: SESSIONS, _packFiles: packFiles, _systemPrompt: systemPrompt };
