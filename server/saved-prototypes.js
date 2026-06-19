'use strict';

// Saved-prototype CRUD: signed-in users can persist /try prototypes (just
// the base64 share payload, ~1.5KB/row) and revisit them from /account.html.
// Cap is 50/user; over the cap the create endpoint returns 409 with the
// oldest entry so the client can offer a one-click "delete oldest and save".
//
// Routes are extracted from index.js so the test suite can spin them up
// against an in-memory DB without booting the full server.

const crypto = require('crypto');
const zlib = require('zlib');
const { getUserFromRequest } = require('./auth-helpers');
const cloudDataPlane = require('./cloud-data-plane');

// Large prototypes (> SHARE_INLINE_MAX) are offloaded to the cloud Postgres blob
// store so they don't bloat the disk-tight control-plane SQLite. Small ones stay
// inline as before. Hard ceiling is SHARE_PAYLOAD_MAX.
const SHARE_INLINE_MAX = 200_000;

// Persist a share payload for prototype `id`: inline (small) or offloaded to the
// cloud Postgres blob store (large + Cloud configured). Returns what to store in
// SQLite's share_payload + the payload_external flag, or throws if too large to
// offload. Throws { code:'too_large' } when over inline limit but Cloud is off.
async function persistSharePayload(id, payload) {
  if (payload.length <= SHARE_INLINE_MAX) return { value: payload, external: 0 };
  if (!cloudDataPlane.isConfigured()) { const e = new Error('payload_too_large'); e.code = 'offload_unavailable'; throw e; }
  await cloudDataPlane.putPrototypeBlob(id, payload);
  return { value: '', external: 1 };
}

// Resolve a row's real share payload — from the blob store when offloaded.
async function loadSharePayload(row) {
  if (!row) return '';
  if (row.payload_external) {
    try { return (await cloudDataPlane.getPrototypeBlob(row.id)) || ''; }
    catch { return ''; }
  }
  return row.share_payload || '';
}

// Optional: Tailwind compile-on-publish. Activated when the env var is
// "1". Replaces CDN Tailwind in published HTML with inline compiled
// CSS (~3MB CDN runtime → ~20KB inline). Module is loaded lazily so an
// unset env var means tailwindcss/postcss aren't required to be
// installed.
const TAILWIND_COMPILE_ENABLED = process.env.TAILWIND_COMPILE_ON_PUBLISH === '1';
let _tailwindCompileFn = null;
function getTailwindCompileFn() {
  if (_tailwindCompileFn) return _tailwindCompileFn;
  if (!TAILWIND_COMPILE_ENABLED) return null;
  try {
    _tailwindCompileFn = require('./tailwind-compile').compileTailwindIfPresent;
  } catch {
    return null;
  }
  return _tailwindCompileFn;
}

// Re-encode a share_payload with Tailwind-compiled HTML. Returns the
// new base64 payload, or the original payload unchanged on any failure.
// Handles all three payload versions:
//   v1 = base64(utf8 html)
//   v2 = base64(gzip(utf8 html))
//   v3 = base64(gzip(json { files, initial }))
async function reencodeWithTailwindCompile(payloadB64, version) {
  const compile = getTailwindCompileFn();
  if (!compile) return payloadB64;
  try {
    const buf = Buffer.from(payloadB64, 'base64');
    if (version >= 3) {
      const json = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
      if (!json || typeof json !== 'object' || !json.files) return payloadB64;
      const newFiles = {};
      for (const [path, contents] of Object.entries(json.files)) {
        if (typeof contents === 'string' && /\.html?$/i.test(path)) {
          const r = await compile(contents);
          newFiles[path] = r.compiled ? r.html : contents;
        } else {
          newFiles[path] = contents;
        }
      }
      const reJson = JSON.stringify({ ...json, files: newFiles });
      return zlib.gzipSync(Buffer.from(reJson, 'utf8')).toString('base64');
    }
    if (version >= 2) {
      const html = zlib.gunzipSync(buf).toString('utf8');
      const r = await compile(html);
      if (!r.compiled) return payloadB64;
      return zlib.gzipSync(Buffer.from(r.html, 'utf8')).toString('base64');
    }
    // v1 = raw html
    const html = buf.toString('utf8');
    const r = await compile(html);
    if (!r.compiled) return payloadB64;
    return Buffer.from(r.html, 'utf8').toString('base64');
  } catch {
    return payloadB64;
  }
}

function escapeHtmlAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Published prototypes render in a sandboxed iframe WITHOUT allow-same-origin
// (so user code can't reach lingcode.dev storage/cookies). Side effect: any
// access to localStorage/sessionStorage throws SecurityError and aborts the
// script — so an app's init crashes and handlers like onclick="startGame()"
// become "not defined". This shim runs FIRST and, only when real storage
// throws, swaps in an in-memory replacement so storage-using apps run (non-
// persistent) instead of crashing. It never weakens the sandbox; if storage
// works (e.g. a future separate-origin host), the probe succeeds and it no-ops.
const STORAGE_SHIM_JS = "(function(){try{window.localStorage.getItem('_lc_');}catch(e){var mk=function(){var s={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null;},setItem:function(k,v){s[k]=String(v);},removeItem:function(k){delete s[k];},clear:function(){s={};},key:function(i){return Object.keys(s)[i]||null;},get length(){return Object.keys(s).length;}};};try{Object.defineProperty(window,'localStorage',{value:mk(),configurable:true});Object.defineProperty(window,'sessionStorage',{value:mk(),configurable:true});}catch(_){}}})();";
// Insert the shim as the first thing inside <head> (else after <html>, else at
// the very top) so it executes before any app script.
function injectStorageShim(html) {
  const tag = '<script>' + STORAGE_SHIM_JS + '</' + 'script>';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + tag);
  return tag + html;
}
// Safe-embed for inline <script>{json}</script>: prevents `</script>` in
// any file's body from breaking out of the script tag, and escapes the
// two JS-line-separator code points U+2028 / U+2029 (which JSON allows
// in strings but JavaScript treats as newlines).
const _LS_RE = new RegExp('\\u2028', 'g');
const _PS_RE = new RegExp('\\u2029', 'g');
function escapeJsonForScript(json) {
  return String(json).replace(/<\//g, '<\\/').replace(_LS_RE, '\\u2028').replace(_PS_RE, '\\u2029');
}
// Returns a string (v1/v2 single-file HTML) OR an object { files, initial }
// for v3 (multi-file project). Caller must check the type to know which
// rendering path to use.
function decodePayload(payload, version) {
  const buf = Buffer.from(payload, 'base64');
  if (version >= 2) {
    const decoded = zlib.gunzipSync(buf).toString('utf8');
    if (version >= 3) {
      const obj = JSON.parse(decoded);
      if (!obj || typeof obj !== 'object' || !obj.files) throw new Error('invalid_v3_shape');
      return { files: obj.files, initial: String(obj.initial || pickInitialKey(obj.files)) };
    }
    return decoded;
  }
  return buf.toString('utf8');
}
function pickInitialKey(filesObj) {
  const keys = Object.keys(filesObj || {});
  for (const c of ['index.html', 'index.htm', 'home.html']) if (keys.includes(c)) return c;
  return keys.find((k) => /\.html?$/i.test(k)) || keys[0] || '';
}

const SAVE_CAP_PER_USER = 50;
const SAVE_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const SAVE_RATE_MAX_PER_WINDOW = 60;

const TITLE_MAX = 120;
const PROMPT_MAX = 4000;
const SHARE_PAYLOAD_MAX = 8_000_000; // hard ceiling; > SHARE_INLINE_MAX is offloaded to the cloud Postgres blob store
const PROVIDER_ID_MAX = 64;
const THUMBNAIL_MAX = 200_000;     // ~150KB raw → ~200KB base64. Plenty for a 400×260 webp.
const CHAT_HISTORY_RAW_MAX = 200 * 1024; // 200 KB pre-compression
const CHAT_HISTORY_B64_MAX = 350 * 1024; // 350 KB base64 input ceiling (sanity bound — well above any in-cap blob)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per-user create-rate buckets. Keyed on userId. Same shape as
// forgotPasswordBuckets in index.js, just intent is "stop a runaway client
// from churning the DB" — the 50/user cap is the real abuse limit.
const saveBuckets = new Map();
function allowSave(userId) {
  const now = Date.now();
  let b = saveBuckets.get(userId);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + SAVE_RATE_WINDOW_MS };
    saveBuckets.set(userId, b);
  }
  b.count += 1;
  return b.count <= SAVE_RATE_MAX_PER_WINDOW;
}

function reconstructShareURL(req, payload, version) {
  // Rebuild the share URL using the publicly visible origin and the right
  // hash key for the encoding version: v2 = #gp= (gzip+base64), v1 = #p=
  // (raw base64). Old rows continue to round-trip via the v1 key forever.
  const publicOrigin = String(process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '');
  let origin;
  if (publicOrigin) {
    origin = publicOrigin;
  } else {
    // Fallback for non-prod: derive from host header.
    const proto = (req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')).toString().split(',')[0].trim();
    const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').toString().split(',')[0].trim();
    origin = `${proto}://${host}`;
  }
  const key = (version >= 2) ? 'gp' : 'p';
  return `${origin}/try.html#${key}=${encodeURIComponent(payload)}`;
}

function requireJsonContent(req, res) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) {
    res.status(415).json({ ok: false, error: 'unsupported_media_type' });
    return false;
  }
  return true;
}

function checkOrigin(req, res) {
  // Cheap CSRF defense in depth on top of sameSite=lax. If Origin or Referer
  // is present and doesn't match the public origin (or the request host),
  // reject. Missing both → allow (some browsers strip them in same-origin
  // contexts).
  const publicOrigin = String(process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '');
  const host = String(req.headers.host || '').toLowerCase();
  const allowedHosts = new Set();
  if (publicOrigin) {
    try { allowedHosts.add(new URL(publicOrigin).host.toLowerCase()); } catch {}
  }
  if (host) allowedHosts.add(host);
  // Also allow common dev hosts.
  if (process.env.NODE_ENV !== 'production') {
    allowedHosts.add('localhost');
    allowedHosts.add('127.0.0.1');
  }
  const checkUrl = (raw) => {
    if (!raw) return null;
    try { return new URL(raw).host.toLowerCase().replace(/:\d+$/, ''); }
    catch { return null; }
  };
  const originHost = checkUrl(req.headers.origin);
  const refererHost = checkUrl(req.headers.referer);
  const allowedNoPort = new Set([...allowedHosts].map((h) => h.replace(/:\d+$/, '')));
  if (originHost && !allowedNoPort.has(originHost)) {
    res.status(403).json({ ok: false, error: 'forbidden_origin' });
    return false;
  }
  if (!originHost && refererHost && !allowedNoPort.has(refererHost)) {
    res.status(403).json({ ok: false, error: 'forbidden_origin' });
    return false;
  }
  return true;
}

/**
 * Decode a base64+gzip chat_history blob, enforce the 200 KB pre-compression
 * cap by dropping the oldest user/assistant pair (and matching turns entry)
 * in a loop, then re-encode for storage.
 *
 * Returns:
 *   { ok: true, encoded: <base64-string>, truncated: <boolean> }   stored as-is
 *   { ok: false, error: 'chat_history_malformed' }                  400
 *   { ok: false, error: 'chat_history_too_large' }                  413
 */
function enforceChatHistoryCap(b64) {
  if (typeof b64 !== 'string' || b64.length === 0) {
    return { ok: false, error: 'chat_history_malformed' };
  }
  if (b64.length > CHAT_HISTORY_B64_MAX) {
    return { ok: false, error: 'chat_history_too_large' };
  }
  let obj;
  try {
    const bytes = Buffer.from(b64, 'base64');
    // maxOutputLength caps the decompressed buffer at ~800 KB (4× the
    // 200 KB pre-compression cap). Defends against gzip bombs — a small
    // compressed payload that would otherwise expand to gigabytes and
    // exhaust the event loop. RangeError → caught below → reports as
    // chat_history_malformed (400).
    const decoded = zlib.gunzipSync(bytes, {
      maxOutputLength: CHAT_HISTORY_RAW_MAX * 4,
    }).toString('utf8');
    obj = JSON.parse(decoded);
  } catch (_) {
    return { ok: false, error: 'chat_history_malformed' };
  }
  if (!obj || typeof obj !== 'object' || obj.v !== 1) {
    return { ok: false, error: 'chat_history_malformed' };
  }
  if (!Array.isArray(obj.turns) || !Array.isArray(obj.history)) {
    return { ok: false, error: 'chat_history_malformed' };
  }

  let truncated = !!obj.truncated;
  // Drop-oldest loop. Each iteration removes one user/assistant pair from
  // history + the matching turns entry. Stop when under cap OR when only
  // the most recent turn remains (we always keep at least one).
  while (JSON.stringify(obj).length > CHAT_HISTORY_RAW_MAX && obj.turns.length > 1) {
    // Validate the head shape before mutating: history[0] must be the
    // user message that started the oldest turn.
    if (!obj.history[0] || obj.history[0].role !== 'user') {
      return { ok: false, error: 'chat_history_malformed' };
    }
    obj.history.shift(); // user
    // Drop the matching assistant response if it's there (it may not be
    // for an interrupted turn).
    if (obj.history[0] && obj.history[0].role === 'assistant') {
      obj.history.shift();
    }
    obj.turns.shift();
    truncated = true;
  }

  // Final size check — a single huge final turn could still be over cap.
  if (JSON.stringify(obj).length > CHAT_HISTORY_RAW_MAX) {
    return { ok: false, error: 'chat_history_too_large' };
  }

  obj.truncated = truncated;

  // Re-encode for storage.
  const reEncoded = zlib.gzipSync(JSON.stringify(obj)).toString('base64');
  return { ok: true, encoded: reEncoded, truncated };
}

/**
 * Register the 5 saved-prototype routes on `app`, backed by `db`.
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
function registerSavedPrototypeRoutes(app, db) {
  // GET list — never returns share_payload (keeps payload small + payloads
  // shouldn't be cached in browser history of /account.html).
  app.get('/api/account/saved-prototypes', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const rows = db.prepare(`
      SELECT id, title, source_prompt, provider_id, created_at, last_opened_at, thumbnail, is_public
      FROM saved_prototypes WHERE user_id = ? ORDER BY created_at DESC
    `).all(u.id);
    res.json({ ok: true, items: rows, cap: SAVE_CAP_PER_USER });
  });

  // GET by id — bumps last_opened_at, returns reconstructed share_url.
  app.get('/api/account/saved-prototypes/:id', async (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const row = db.prepare(`
      SELECT * FROM saved_prototypes WHERE id = ? AND user_id = ?
    `).get(id, u.id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    db.prepare('UPDATE saved_prototypes SET last_opened_at = ? WHERE id = ?')
      .run(Date.now(), id);
    const sharePayload = await loadSharePayload(row);
    res.json({
      ok: true,
      item: {
        id: row.id,
        title: row.title,
        source_prompt: row.source_prompt,
        provider_id: row.provider_id,
        share_payload: sharePayload,
        share_version: row.share_version,
        // Offloaded payloads are too large to embed in a #-hash URL → use /p/<id>.
        share_url: row.payload_external ? `${req.protocol}://${req.get('host')}/p/${id}` : reconstructShareURL(req, sharePayload, row.share_version),
        created_at: row.created_at,
        last_opened_at: Date.now(),
        // Owner-only; never returned by the list endpoint or by /p/<id>.
        // null for any row published before this column landed.
        chat_history: row.chat_history || null,
      },
    });
  });

  // POST create — 50/user cap (409), 60/hour rate limit (429).
  app.post('/api/account/saved-prototypes', async (req, res) => {
    if (!requireJsonContent(req, res)) return;
    if (!checkOrigin(req, res)) return;
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!allowSave(u.id)) return res.status(429).json({ ok: false, error: 'rate_limited' });

    const body = req.body || {};
    let title = String(body.title || '').trim();
    let sharePayload = String(body.share_payload || '');
    const shareVersion = Number.isFinite(body.share_version) ? Math.max(1, Math.floor(body.share_version)) : 1;
    const sourcePrompt = body.source_prompt == null ? null : String(body.source_prompt).slice(0, PROMPT_MAX);
    const providerId = body.provider_id == null ? null : String(body.provider_id).slice(0, PROVIDER_ID_MAX);
    // Optional thumbnail data URL (image/webp typically). Silently dropped
    // if the client sent something obviously wrong rather than 400'ing —
    // the row is still useful without a thumb.
    let thumbnail = null;
    if (typeof body.thumbnail === 'string' && body.thumbnail.length > 0 && body.thumbnail.length <= THUMBNAIL_MAX) {
      if (/^data:image\/(webp|png|jpe?g);/i.test(body.thumbnail)) thumbnail = body.thumbnail;
    }

    // Optional chat_history blob: base64-encoded gzip of the publish-time
    // pane state. Capped at 200 KB pre-compression in enforceChatHistoryCap;
    // missing / malformed / too-large values fail soft (save without
    // history) UNLESS the client explicitly opted in by setting the field.
    let chatHistory = null;
    if (typeof body.chat_history === 'string' && body.chat_history.length > 0) {
      const r = enforceChatHistoryCap(body.chat_history);
      if (!r.ok) {
        return res.status(r.error === 'chat_history_too_large' ? 413 : 400)
          .json({ ok: false, error: r.error });
      }
      chatHistory = r.encoded;
    }

    if (!title || title.length > TITLE_MAX) {
      return res.status(400).json({ ok: false, error: 'invalid_title' });
    }
    if (!sharePayload || sharePayload.length > SHARE_PAYLOAD_MAX) {
      return res.status(400).json({ ok: false, error: 'invalid_payload' });
    }

    // Cap check: hard-fail with the oldest row's id so the client can offer
    // "Delete X and save?" as a one-click resolution.
    const count = db.prepare('SELECT COUNT(*) AS n FROM saved_prototypes WHERE user_id = ?').get(u.id).n;
    if (count >= SAVE_CAP_PER_USER) {
      const oldest = db.prepare(`
        SELECT id, title, created_at FROM saved_prototypes
        WHERE user_id = ? ORDER BY created_at ASC LIMIT 1
      `).get(u.id);
      return res.status(409).json({
        ok: false, error: 'cap_reached', cap: SAVE_CAP_PER_USER, oldest,
      });
    }

    // Optional Tailwind compile-on-publish: when TAILWIND_COMPILE_ON_PUBLISH=1
    // is set, swap CDN Tailwind for inline compiled CSS in any HTML files.
    // Failures are silent — original payload is used unchanged so a botched
    // compile never blocks the save.
    sharePayload = await reencodeWithTailwindCompile(sharePayload, shareVersion);
    if (sharePayload.length > SHARE_PAYLOAD_MAX) {
      // Re-check the cap after compile in case the payload grew past it.
      // This is rare for normal pages but possible if compiled CSS happens
      // to be very large. Fall back to the original by re-reading body.
      sharePayload = String(req.body?.share_payload || '');
    }

    const isPublic = req.body?.is_public === false || req.body?.is_public === 0 ? 0 : 1;
    const id = crypto.randomUUID();
    const now = Date.now();
    // Offload large payloads to the cloud Postgres blob store (await before the
    // sync sqlite transaction). When Cloud is off and it's too big to inline, 413.
    let stored;
    try { stored = await persistSharePayload(id, sharePayload); }
    catch (e) {
      if (e.code === 'offload_unavailable') return res.status(413).json({ ok: false, error: 'payload_too_large' });
      throw e;
    }
    db.transaction(() => {
      db.prepare(`
        INSERT INTO saved_prototypes
          (id, user_id, title, share_payload, share_version, source_prompt, provider_id, created_at, thumbnail, chat_history, is_public, payload_external)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, u.id, title, stored.value, shareVersion, sourcePrompt, providerId, now, thumbnail, chatHistory, isPublic, stored.external);
      // Auto-grant owner role for collaboration
      db.prepare('INSERT OR IGNORE INTO collab_members (id, prototype_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), id, u.id, 'owner', now);
    })();
    res.status(201).json({ ok: true, id });
  });

  // PUT — update an existing prototype IN PLACE, reusing its id. Lets re-publish
  // keep the same id so a backend / secrets / collab bound to prototype_id (1:1)
  // survive edits. Owner-gated; no cap check (not creating a row). thumbnail /
  // chat_history are COALESCE'd so omitting them doesn't wipe existing values.
  app.put('/api/account/saved-prototypes', async (req, res) => {
    if (!requireJsonContent(req, res)) return;
    if (!checkOrigin(req, res)) return;
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!allowSave(u.id)) return res.status(429).json({ ok: false, error: 'rate_limited' });

    const body = req.body || {};
    const id = String(body.id || '').trim();
    if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const owned = db.prepare('SELECT id FROM saved_prototypes WHERE id = ? AND user_id = ?').get(id, u.id);
    if (!owned) return res.status(404).json({ ok: false, error: 'not_found' });

    let title = String(body.title || '').trim();
    let sharePayload = String(body.share_payload || '');
    const shareVersion = Number.isFinite(body.share_version) ? Math.max(1, Math.floor(body.share_version)) : 1;
    const sourcePrompt = body.source_prompt == null ? null : String(body.source_prompt).slice(0, PROMPT_MAX);
    const providerId = body.provider_id == null ? null : String(body.provider_id).slice(0, PROVIDER_ID_MAX);
    let thumbnail = null;
    if (typeof body.thumbnail === 'string' && body.thumbnail.length > 0 && body.thumbnail.length <= THUMBNAIL_MAX) {
      if (/^data:image\/(webp|png|jpe?g);/i.test(body.thumbnail)) thumbnail = body.thumbnail;
    }
    // Distinguish "field omitted" from "field explicitly null/invalid". Older
    // clients sometimes don't capture a thumbnail and just omit the field — we
    // want to keep the existing row's thumbnail in that case. But when a client
    // DID try to capture (failed → null, or sent us a bad thumb they want
    // cleared), the field is present and we should overwrite. Without this the
    // SQL COALESCE below silently preserves stale half-white thumbnails forever.
    const thumbnailExplicit = Object.prototype.hasOwnProperty.call(body, 'thumbnail');
    let chatHistory = null;
    if (typeof body.chat_history === 'string' && body.chat_history.length > 0) {
      const r = enforceChatHistoryCap(body.chat_history);
      if (!r.ok) return res.status(r.error === 'chat_history_too_large' ? 413 : 400).json({ ok: false, error: r.error });
      chatHistory = r.encoded;
    }
    if (!title || title.length > TITLE_MAX) return res.status(400).json({ ok: false, error: 'invalid_title' });
    if (!sharePayload || sharePayload.length > SHARE_PAYLOAD_MAX) return res.status(400).json({ ok: false, error: 'invalid_payload' });

    sharePayload = await reencodeWithTailwindCompile(sharePayload, shareVersion);
    if (sharePayload.length > SHARE_PAYLOAD_MAX) sharePayload = String(req.body?.share_payload || '');

    const isPublic = req.body?.is_public === false || req.body?.is_public === 0 ? 0 : 1;
    const now = Date.now();
    let stored;
    try { stored = await persistSharePayload(id, sharePayload); }
    catch (e) {
      if (e.code === 'offload_unavailable') return res.status(413).json({ ok: false, error: 'payload_too_large' });
      throw e;
    }
    // If it shrank back to inline, drop any stale blob to reclaim space.
    if (!stored.external) cloudDataPlane.deletePrototypeBlob(id);
    // Branch on whether the client included `thumbnail`: explicit overwrite vs.
    // COALESCE-preserve. Two separate prepared statements keep the SQL readable
    // and avoid CASE-with-bind-position juggling.
    if (thumbnailExplicit) {
      db.prepare(`
        UPDATE saved_prototypes
        SET title = ?, share_payload = ?, share_version = ?, source_prompt = ?,
            provider_id = ?, thumbnail = ?,
            chat_history = COALESCE(?, chat_history), is_public = ?, payload_external = ?, last_opened_at = ?
        WHERE id = ? AND user_id = ?
      `).run(title, stored.value, shareVersion, sourcePrompt, providerId, thumbnail, chatHistory, isPublic, stored.external, now, id, u.id);
    } else {
      db.prepare(`
        UPDATE saved_prototypes
        SET title = ?, share_payload = ?, share_version = ?, source_prompt = ?,
            provider_id = ?, thumbnail = COALESCE(?, thumbnail),
            chat_history = COALESCE(?, chat_history), is_public = ?, payload_external = ?, last_opened_at = ?
        WHERE id = ? AND user_id = ?
      `).run(title, stored.value, shareVersion, sourcePrompt, providerId, thumbnail, chatHistory, isPublic, stored.external, now, id, u.id);
    }
    res.json({ ok: true, id });
  });

  // PATCH — rename only (title). Other columns are immutable from the API.
  app.patch('/api/account/saved-prototypes/:id', (req, res) => {
    if (!requireJsonContent(req, res)) return;
    if (!checkOrigin(req, res)) return;
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const title = String((req.body || {}).title || '').trim();
    if (!title || title.length > TITLE_MAX) {
      return res.status(400).json({ ok: false, error: 'invalid_title' });
    }
    const result = db.prepare(`
      UPDATE saved_prototypes SET title = ? WHERE id = ? AND user_id = ?
    `).run(title, id, u.id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true });
  });

  // PATCH thumbnail — overwrite ONLY the thumbnail column for an existing
  // owned prototype. Used by the /try ?continue= resume flow to backfill the
  // many rows saved with the old broken capture (foreignObject fallback or
  // parent-document html2canvas with wrong font metrics). Avoiding PUT here
  // is deliberate: PUT re-serializes the entire share_payload and runs the
  // content_too_small guard, which would refuse near-empty captures and risk
  // clobbering a good save. PATCH carries no payload, so it can't clobber.
  //
  // Accepts the same data URL shape as POST/PUT's `thumbnail` field; an
  // explicit `null` clears the column (lets the dashboard fall back to its
  // deterministic gradient placeholder when a recapture failed).
  app.patch('/api/account/saved-prototypes/:id/thumbnail', (req, res) => {
    if (!requireJsonContent(req, res)) return;
    if (!checkOrigin(req, res)) return;
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const body = req.body || {};
    let thumbnail = null;
    if (body.thumbnail === null) {
      thumbnail = null;
    } else if (typeof body.thumbnail === 'string' && body.thumbnail.length > 0 && body.thumbnail.length <= THUMBNAIL_MAX) {
      if (!/^data:image\/(webp|png|jpe?g);/i.test(body.thumbnail)) {
        return res.status(400).json({ ok: false, error: 'invalid_thumbnail' });
      }
      thumbnail = body.thumbnail;
    } else {
      return res.status(400).json({ ok: false, error: 'invalid_thumbnail' });
    }
    const result = db.prepare(`
      UPDATE saved_prototypes SET thumbnail = ? WHERE id = ? AND user_id = ?
    `).run(thumbnail, id, u.id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true });
  });

  // PATCH visibility — toggle is_public (0 = private / owner only, 1 = public).
  app.patch('/api/account/saved-prototypes/:id/visibility', (req, res) => {
    if (!requireJsonContent(req, res)) return;
    if (!checkOrigin(req, res)) return;
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const isPublic = req.body?.is_public ? 1 : 0;
    const result = db.prepare(`
      UPDATE saved_prototypes SET is_public = ? WHERE id = ? AND user_id = ?
    `).run(isPublic, id, u.id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, is_public: isPublic });
  });

  // DELETE.
  app.delete('/api/account/saved-prototypes/:id', (req, res) => {
    if (!checkOrigin(req, res)) return;
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    // Tear down any LingCode Cloud backend attached to this prototype before
    // the row goes away, so we don't orphan a Postgres schema/role (cost +
    // leak risk). Best-effort: schema drop is async; control rows go now.
    let _backendToDrop = null;
    try {
      const be = db.prepare('SELECT id FROM prototype_backends WHERE prototype_id = ? AND user_id = ?').get(id, u.id);
      if (be) {
        _backendToDrop = be.id;
        db.prepare('DELETE FROM backend_logs WHERE backend_id = ?').run(be.id);
        db.prepare('DELETE FROM backend_usage WHERE backend_id = ?').run(be.id);
        db.prepare('DELETE FROM backend_objects WHERE backend_id = ?').run(be.id);
        db.prepare('DELETE FROM backend_signing_secrets WHERE backend_id = ?').run(be.id);
        db.prepare('DELETE FROM prototype_backends WHERE id = ?').run(be.id);
      }
    } catch (e) { /* tables may not exist on older DBs — non-fatal */ }

    // Clear every row that references this prototype before deleting it — with
    // foreign_keys ON (better-sqlite3's default), an orphaned child blocks the
    // delete with a FK error. A collab_members owner row is created on EVERY
    // save, so this matters for ordinary prototypes, not just shared ones.
    // Per-table try so a table missing on an older DB doesn't skip the rest.
    for (const t of ['collab_members', 'collab_ydoc_state', 'collab_ydoc_state_v2', 'collab_comments', 'collab_history', 'collab_pending_invites', 'prototype_secrets', 'prototype_supabase_projects', 'prototype_domains', 'prototype_backends']) {
      try { db.prepare(`DELETE FROM ${t} WHERE prototype_id = ?`).run(id); } catch (_) { /* table absent — skip */ }
    }

    const result = db.prepare(`
      DELETE FROM saved_prototypes WHERE id = ? AND user_id = ?
    `).run(id, u.id);
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'not_found' });

    if (_backendToDrop) {
      try {
        const cloudDataPlane = require('./cloud-data-plane');
        if (cloudDataPlane.isConfigured()) {
          cloudDataPlane.dropBackend(_backendToDrop).catch((e) => console.error('[cloud] dropBackend failed (non-fatal):', e && e.message));
        }
        // Purge object storage too (metadata rows were already cleared above), or
        // the deleted backend's files keep costing us in object storage.
        const cloudStorage = require('./cloud-storage');
        if (cloudStorage.isConfigured()) {
          cloudStorage.removePrefix(_backendToDrop).catch((e) => console.error('[cloud] storage purge failed (non-fatal):', e && e.message));
        }
      } catch (e) { console.error('[cloud] teardown skipped:', e && e.message); }
    }
    res.json({ ok: true });
  });
}

/**
 * Register the public short-link route on `app`. GET /p/<uuid> looks up
 * a saved-prototype row (by id only — no auth, the UUID is the secret),
 * decodes the prototype HTML, and renders it inside a sandboxed iframe
 * on the /p/<uuid> page itself. The short URL stays in the address bar:
 * no redirect to a long /try.html#... URL, no LingCode chrome around it.
 *
 * Sandbox model: the iframe loads the prototype as srcdoc with sandbox=
 * "allow-scripts allow-modals allow-forms allow-popups
 * allow-popups-to-escape-sandbox" (no allow-same-origin), so the
 * prototype runs as a unique origin — can't read lingcode.dev cookies,
 * localStorage, or DOM. Same posture as the in-modal preview.
 *
 * Why no auth on the read: a saved prototype's UUID is unguessable; if
 * you have the URL, you have the right to view. To revoke access, the
 * owner deletes the row.
 *
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
function registerPublicShareRoute(app, db) {
  // Public payload endpoint — UUID is the secret. Returns share_payload +
  // chat_history so /try.html?remix=<id> can load any published prototype.
  app.get('/api/p/:id', async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'not_found' });
    const row = db.prepare(
      'SELECT share_payload, payload_external, share_version, chat_history, title, provider_id, user_id, is_public FROM saved_prototypes WHERE id = ?'
    ).get(id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (!row.is_public) {
      const u = getUserFromRequest(db, req);
      if (!u || u.id !== row.user_id) return res.status(403).json({ error: 'private' });
    }
    const sharePayload = row.payload_external ? ((await cloudDataPlane.getPrototypeBlob(id)) || '') : row.share_payload;
    res.json({ id, share_payload: sharePayload, share_version: row.share_version,
               chat_history: row.chat_history || null, title: row.title || '', provider_id: row.provider_id || null });
  });

  app.get('/p/:id', async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      return res.status(404).type('html').send(notFoundPage('Not found.'));
    }
    const row = db.prepare(`
      SELECT share_payload, payload_external, share_version, title, is_public, user_id FROM saved_prototypes WHERE id = ?
    `).get(id);
    if (!row) {
      return res.status(404).type('html').send(notFoundPage('Prototype not found, or deleted by the owner.'));
    }
    if (!row.is_public) {
      const u = getUserFromRequest(db, req);
      if (!u || u.id !== row.user_id) {
        return res.status(403).type('html').send(notFoundPage('This prototype is private.'));
      }
    }
    // Bump last_opened_at so the owner can see "last viewed" on their list.
    db.prepare('UPDATE saved_prototypes SET last_opened_at = ? WHERE id = ?').run(Date.now(), id);
    const sharePayload = row.payload_external ? ((await cloudDataPlane.getPrototypeBlob(id)) || '') : row.share_payload;
    let decoded;
    try {
      decoded = decodePayload(sharePayload, row.share_version);
    } catch {
      return res.status(500).type('html').send(notFoundPage('Could not decode prototype.'));
    }
    const titleAttr = escapeHtmlAttr(row.title || 'Prototype');
    // No "Remix" badge when served on the owner's own custom domain — it's their app.
    const remixBtn = req._customDomain ? '' : `<a href="/try.html?remix=${id}" style="position:fixed;bottom:16px;right:16px;z-index:9999;background:#7C3AED;color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-family:'Geist',system-ui,sans-serif;font-size:13px;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,0.25);opacity:0.9;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.9'">Remix →</a>`;
    if (typeof decoded === 'string') {
      // v1 / v2 single-file path: inline HTML in a sandboxed iframe srcdoc.
      const srcdoc = escapeHtmlAttr(injectStorageShim(decoded));
      return res.type('html').send(
`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${titleAttr} · LingCode</title>
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="X-Frame-Options" content="SAMEORIGIN">
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#fff}iframe{border:0;width:100%;height:100vh;display:block}</style>
</head>
<body>
<iframe sandbox="allow-scripts allow-modals allow-forms allow-popups allow-popups-to-escape-sandbox" srcdoc="${srcdoc}" title="${titleAttr}"></iframe>
${remixBtn}
</body>
</html>`);
    }
    // v3 multi-file path: render a wrapper page that embeds the FILES map
    // + initial filename. The iframe's srcdoc is set on every internal
    // nav (postMessage from the link interceptor injected into each file).
    // URL stays at /p/<id>; nav happens inside the iframe.
    const filesObj = decoded.files || {};
    const initialKey = decoded.initial || pickInitialKey(filesObj);
    const filesJson = escapeJsonForScript(JSON.stringify(filesObj));
    const initialJson = escapeJsonForScript(JSON.stringify(initialKey));
    return res.type('html').send(
`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${titleAttr} · LingCode</title>
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="X-Frame-Options" content="SAMEORIGIN">
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#fff}iframe{border:0;width:100%;height:100vh;display:block}</style>
</head>
<body>
<iframe id="ff" sandbox="allow-scripts allow-modals allow-forms allow-popups allow-popups-to-escape-sandbox" title="${titleAttr}"></iframe>
<script>
(function(){
  var FILES = ${filesJson};
  var INITIAL = ${initialJson};
  var STORAGE_SHIM = ${escapeJsonForScript(JSON.stringify(STORAGE_SHIM_JS))};
  // Inject the storage shim first inside <head> so each navigated file runs it
  // before its own scripts (same reason as the v1/v2 server-side inject).
  function withStorageShim(html){
    var tag = '<' + 'script>' + STORAGE_SHIM + '<' + '/script>';
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, function(m){ return m + tag; });
    if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, function(m){ return m + tag; });
    return tag + html;
  }
  function norm(h){ return String(h||'').replace(/^\\.?\\//, '').split(/[?#]/)[0]; }
  function inlineSiblings(html){
    var keys = Object.keys(FILES);
    if (keys.length <= 1) return html;
    var out = html.replace(/<link\\b[^>]*?\\bhref=(['"])([^'"]+)\\1[^>]*?>/gi, function(full, q, href){
      var t = norm(href);
      if (!FILES[t] || !/\\.css$/i.test(t)) return full;
      return '<style data-inlined-from="' + t + '">' + FILES[t] + '</style>';
    });
    out = out.replace(/<script\\b([^>]*?)\\bsrc=(['"])([^'"]+)\\2([^>]*?)>\\s*<\\/script>/gi, function(full, before, q, src, after){
      var t = norm(src);
      if (!FILES[t] || !/\\.(js|mjs)$/i.test(t)) return full;
      var attrs = (before + after).replace(/\\bsrc=(['"])[^'"]+\\1/gi, '').trim();
      return '<script ' + attrs + ' data-inlined-from="' + t + '">' + FILES[t] + '<' + '/script>';
    });
    return out;
  }
  function withLinkInterceptor(html){
    var s = '<' + 'script>(function(){document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a");if(!a)return;var h=a.getAttribute("href");if(!h||/^(https?:|mailto:|tel:|#|javascript:|data:|blob:)/i.test(h))return;e.preventDefault();parent.postMessage({type:"lingcode-nav",href:h},"*");});})();<' + '/script>';
    if (/<\\/body>/i.test(html)) return html.replace(/<\\/body>/i, s + '</body>');
    return html + s;
  }
  function show(name){
    if (!FILES[name]) return;
    document.getElementById('ff').srcdoc = withLinkInterceptor(withStorageShim(inlineSiblings(FILES[name])));
  }
  window.addEventListener('message', function(e){
    if (!e || !e.data || e.data.type !== 'lingcode-nav') return;
    var t = norm(e.data.href);
    if (FILES[t]) show(t);
  });
  show(INITIAL);
})();
</script>
${remixBtn}
</body>
</html>`);
  });
}

function notFoundPage(msg) {
  const m = escapeHtmlAttr(msg);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Not found · LingCode</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0a;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;padding:24px;text-align:center}h1{font-size:1.5rem;margin:0 0 8px;font-weight:500}p{color:#888;margin:0 0 24px}a{color:#00d084;text-decoration:none}a:hover{text-decoration:underline}</style></head><body><h1>404</h1><p>${m}</p><a href="/try.html">Build something on /try →</a></body></html>`;
}

// Test seam: lets the test suite reset the in-memory rate-limit state
// between cases without restarting the process.
function _resetRateLimits() { saveBuckets.clear(); }

module.exports = {
  registerSavedPrototypeRoutes,
  registerPublicShareRoute,
  SAVE_CAP_PER_USER,
  SAVE_RATE_MAX_PER_WINDOW,
  _resetRateLimits,
};
