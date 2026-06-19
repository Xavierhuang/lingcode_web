'use strict';

// site-assistant.js — grounded RAG endpoint for the public lingcode.dev chat
// widget. A prebuilt embedding index (site-index.json, made by
// build-site-index.js) is loaded into memory at boot; per question we embed it,
// retrieve the top-k site chunks by cosine, and ask LingModel to answer ONLY
// from that context with citations. Public + unauthenticated → per-IP +
// global rate limiting, and the prompt refuses anything not in the context so
// it can't hallucinate about the product.

const fs = require('fs');
const path = require('path');
const { lingmodelAnthropicMessagesUrl, lingmodelUpstreamApiKey } = require('./inference-anthropic');

const INDEX_PATH = process.env.SITE_INDEX_PATH || path.join(__dirname, 'site-index.json');
const EMBED_MODEL = process.env.CLOUD_EMBEDDINGS_MODEL || 'text-embedding-3-small';
const EMBED_URL = process.env.CLOUD_EMBEDDINGS_API_URL || 'https://api.openai.com/v1/embeddings';
const CHAT_MODEL = process.env.SITE_CHAT_MODEL || 'claude-3-5-haiku-20241022';

// Reuse the same OpenAI-compatible embeddings key as the cloud data plane.
function embeddingsKey(db) {
  let key = process.env.CLOUD_EMBEDDINGS_API_KEY || '';
  if (!key && db) { try { const r = db.prepare('SELECT value FROM app_config WHERE key = ?').get('LINGMODEL_IMAGE_UPSTREAM_KEY'); if (r && r.value && r.value.trim()) key = r.value.trim(); } catch (_) {} }
  if (!key) key = process.env.LINGMODEL_IMAGE_UPSTREAM_KEY || process.env.OPENAI_API_KEY || '';
  return key;
}

// Embed one or more strings. Used by the route (single query) and the
// ingestion script (batches).
async function embedTexts(inputs, { db, apiKey } = {}) {
  const key = apiKey || embeddingsKey(db);
  if (!key) throw Object.assign(new Error('embeddings not configured'), { status: 503 });
  const r = await fetch(EMBED_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ model: EMBED_MODEL, input: inputs }) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !Array.isArray(j.data)) throw Object.assign(new Error('embeddings request failed'), { status: 502 });
  return j.data.map((d) => d.embedding);
}

// ---- in-memory index (loaded once) ------------------------------------
let _index = null; // { chunks: [{url,title,text}], vecs: [Float32Array] }
function loadIndex() {
  if (_index) return _index;
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    const chunks = Array.isArray(raw.chunks) ? raw.chunks : [];
    _index = { chunks: chunks.map((c) => ({ url: c.url, title: c.title, text: c.text })), vecs: chunks.map((c) => Float32Array.from(c.embedding || [])) };
  } catch (_) { _index = { chunks: [], vecs: [] }; }
  return _index;
}
function indexReady() { return loadIndex().chunks.length > 0; }

function cosineTopK(queryVec, k) {
  const idx = loadIndex();
  const q = Float32Array.from(queryVec);
  let qn = 0; for (let i = 0; i < q.length; i++) qn += q[i] * q[i]; qn = Math.sqrt(qn) || 1;
  const scored = idx.vecs.map((v, i) => {
    let dot = 0, vn = 0; const n = Math.min(v.length, q.length);
    for (let j = 0; j < n; j++) { dot += v[j] * q[j]; vn += v[j] * v[j]; }
    return { i, score: dot / ((Math.sqrt(vn) || 1) * qn) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => Object.assign({ score: s.score }, idx.chunks[s.i]));
}

// ---- rate limiting (per-IP hourly + global daily) ---------------------
const _ipBuckets = new Map();
let _globalCount = 0, _globalReset = 0;
const IP_LIMIT = Number(process.env.SITE_CHAT_IP_LIMIT || 15);
const IP_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_DAILY = Number(process.env.SITE_CHAT_GLOBAL_DAILY || 3000);
function rateLimit(ip, now) {
  if (now > _globalReset) { _globalCount = 0; _globalReset = now + 24 * 60 * 60 * 1000; }
  if (_globalCount >= GLOBAL_DAILY) return 'global';
  let b = _ipBuckets.get(ip);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + IP_WINDOW_MS }; _ipBuckets.set(ip, b); }
  if (b.count >= IP_LIMIT) return 'ip';
  b.count++; _globalCount++; return null;
}

const SYSTEM_PROMPT =
  'You are the assistant for LingCode (lingcode.dev), a native macOS AI coding IDE with a CLI, iPad/Android apps, and a managed Cloud backend. ' +
  'Answer the user\'s question ONLY using the CONTEXT below — excerpts from the LingCode website. ' +
  'If the answer is not in the context, say you\'re not sure and point them to the docs (/docs.html) or support — do NOT invent features, pricing, or commands. ' +
  'Be concise and friendly (2–5 sentences). Refuse anything unrelated to LingCode.';

function registerSiteAssistantRoutes(app, db) {
  app.get('/api/site-chat/health', (_req, res) => res.json({ ok: true, ready: indexReady(), chunks: loadIndex().chunks.length }));

  app.post('/api/site-chat', async (req, res) => {
    const now = Date.now();
    const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const limited = rateLimit(ip, now);
    if (limited) return res.status(429).json({ ok: false, error: 'rate_limited', message: limited === 'global' ? 'The assistant is busy right now — please try again later.' : 'You\'ve asked a lot in a short time — give it a minute.' });

    const question = (req.body && typeof req.body.question === 'string') ? req.body.question.trim() : '';
    if (!question || question.length > 1000) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'question (1–1000 chars) required' });
    if (!indexReady()) return res.status(503).json({ ok: false, error: 'index_not_ready', message: 'The assistant is still warming up.' });
    const upstreamKey = lingmodelUpstreamApiKey(db);
    if (!upstreamKey) return res.status(503).json({ ok: false, error: 'assistant_not_configured' });

    try {
      const [qvec] = await embedTexts([question], { db });
      const hits = cosineTopK(qvec, 6).filter((h) => h.score > 0.15);
      const sources = []; const seen = new Set();
      for (const h of hits) { if (h.url && !seen.has(h.url)) { seen.add(h.url); sources.push({ title: h.title, url: h.url }); } }
      if (!hits.length) return res.json({ ok: true, data: { answer: 'I\'m not sure about that one — try the docs at /docs.html or ask support.', sources: [] } });
      const context = hits.map((h, i) => `[${i + 1}] ${h.title} (${h.url})\n${h.text}`).join('\n\n---\n\n').slice(0, 12000);

      // Ask upstream to stream; relay token deltas to the widget as SSE.
      const upstream = await fetch(lingmodelAnthropicMessagesUrl(db), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': upstreamKey, 'authorization': 'Bearer ' + upstreamKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: CHAT_MODEL, max_tokens: 500, stream: true, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: `CONTEXT:\n${context}\n\nQUESTION: ${question}` }] }),
      });
      if (!upstream.ok || !upstream.body) return res.status(502).json({ ok: false, error: 'assistant_failed' });

      res.set('Content-Type', 'text/event-stream');
      res.set('Cache-Control', 'no-cache, no-transform');
      res.set('Connection', 'keep-alive');
      res.set('X-Accel-Buffering', 'no'); // disable nginx buffering so tokens flush live
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      let buf = '', emitted = 0, aborted = false;
      req.on('close', () => { aborted = true; try { reader.cancel(); } catch (_) {} });
      // Parse the upstream Anthropic SSE; forward each text delta.
      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const ev = JSON.parse(payload);
            const text = ev.type === 'content_block_delta' && ev.delta && (ev.delta.text || ev.delta.partial_json);
            if (typeof text === 'string' && text) { res.write(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`); emitted += text.length; }
          } catch (_) { /* skip non-JSON keepalive lines */ }
        }
      }
      if (!aborted) {
        if (!emitted) res.write(`event: delta\ndata: ${JSON.stringify({ text: 'Sorry, I couldn\'t generate an answer.' })}\n\n`);
        res.write(`event: done\ndata: ${JSON.stringify({ sources: sources.slice(0, 4) })}\n\n`);
        res.end();
      }
    } catch (err) {
      if (res.headersSent) { try { res.write(`event: error\ndata: ${JSON.stringify({ message: 'stream interrupted' })}\n\n`); res.end(); } catch (_) {} }
      else res.status(err.status || 500).json({ ok: false, error: 'assistant_error', message: err.message });
    }
  });

  // Non-streaming JSON sibling of /api/site-chat. Same RAG retrieval, but returns
  // the whole answer in one body — for programmatic callers (the in-app
  // `lingcode_docs` agent tool) that don't want to parse SSE. Same guards.
  app.post('/api/site-chat/ask', async (req, res) => {
    const now = Date.now();
    const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const limited = rateLimit(ip, now);
    if (limited) return res.status(429).json({ ok: false, error: 'rate_limited', message: limited === 'global' ? 'The assistant is busy right now — please try again later.' : 'You\'ve asked a lot in a short time — give it a minute.' });

    const question = (req.body && typeof req.body.question === 'string') ? req.body.question.trim() : '';
    if (!question || question.length > 1000) return res.status(400).json({ ok: false, error: 'invalid_request', message: 'question (1–1000 chars) required' });
    if (!indexReady()) return res.status(503).json({ ok: false, error: 'index_not_ready', message: 'The assistant is still warming up.' });
    const upstreamKey = lingmodelUpstreamApiKey(db);
    if (!upstreamKey) return res.status(503).json({ ok: false, error: 'assistant_not_configured' });

    try {
      const [qvec] = await embedTexts([question], { db });
      const hits = cosineTopK(qvec, 6).filter((h) => h.score > 0.15);
      const sources = []; const seen = new Set();
      for (const h of hits) { if (h.url && !seen.has(h.url)) { seen.add(h.url); sources.push({ title: h.title, url: h.url }); } }
      if (!hits.length) return res.json({ ok: true, data: { answer: 'I\'m not sure about that one — try the docs at /docs.html or ask support.', sources: [] } });
      const context = hits.map((h, i) => `[${i + 1}] ${h.title} (${h.url})\n${h.text}`).join('\n\n---\n\n').slice(0, 12000);

      const upstream = await fetch(lingmodelAnthropicMessagesUrl(db), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': upstreamKey, 'authorization': 'Bearer ' + upstreamKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: CHAT_MODEL, max_tokens: 500, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: `CONTEXT:\n${context}\n\nQUESTION: ${question}` }] }),
      });
      const j = await upstream.json().catch(() => null);
      if (!upstream.ok || !j) return res.status(502).json({ ok: false, error: 'assistant_failed' });
      const answer = Array.isArray(j.content)
        ? j.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim()
        : '';
      return res.json({ ok: true, data: { answer: answer || 'Sorry, I couldn\'t generate an answer.', sources: sources.slice(0, 4) } });
    } catch (err) {
      res.status(err.status || 500).json({ ok: false, error: 'assistant_error', message: err.message });
    }
  });
}

module.exports = { registerSiteAssistantRoutes, embedTexts, loadIndex, cosineTopK, indexReady, INDEX_PATH };
