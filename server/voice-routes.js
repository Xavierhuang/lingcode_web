'use strict';

// voice-routes.js — LingCode-branded speech proxy for hands-free voice mode.
//
// Two routes, both session- or Bearer-authed:
//   POST /api/voice/transcribe   audio bytes  -> { text }
//   POST /api/voice/speak        { text }     -> audio bytes
//
// Why a proxy at all, rather than calling a speech vendor from the client:
//   - The vendor is never named in anything a user can see, matching the
//     LingModel rule. Clients only ever know "voice".
//   - The vendor API key stays server-side. A desktop client shipping a key
//     is a key leak, and per-user BYO keys would make voice mode a chore to
//     turn on.
//   - Swapping vendors is an env change here, not a client release. LingCodeBaby
//     ships via NSIS/AppImage; a client release is days, not minutes.
//
// Egress goes through safeFetch with an explicit host allow-list — same rule as
// the in-process function templates. Nothing here takes a URL from the client.

// Host modules are required lazily, inside registerVoiceRoutes. The pure
// helpers below (extractAudio, parseShaped, opaqueUpstreamError, …) then stay
// importable with nothing installed, which is what lets the unit tests run
// standalone. The host app already has all three loaded at registration time.

// ── Vendor wiring (env only; never echoed to a client) ─────────────────────
// Deliberately mirrors the LingModel pattern: operators point these at whatever
// speech service they've contracted with. Absent config => 503 "not configured",
// which the client renders as "voice is unavailable" with no vendor detail.
// Auth scheme is configurable because vendors differ: some want
// `Authorization: Bearer <key>`, others `Basic <key>` (where the key is already
// a base64 blob and must NOT be re-encoded). Default Bearer.
function authHeader(key, scheme) {
  if (!key) return {};
  const s = String(scheme || 'Bearer').trim();
  return { authorization: `${s} ${key}` };
}

function sttConfig() {
  return {
    url: process.env.LINGCODE_VOICE_STT_URL || '',
    key: process.env.LINGCODE_VOICE_STT_KEY || '',
    scheme: process.env.LINGCODE_VOICE_STT_AUTH_SCHEME || 'Bearer',
    model: process.env.LINGCODE_VOICE_STT_MODEL || '',
    // Comma-separated. Must be set alongside the URL so egress stays pinned.
    hosts: (process.env.LINGCODE_VOICE_STT_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean),
    // Some speech APIs take audio as base64 inside a JSON body rather than
    // multipart. Set to a field name (e.g. "audio") to use that shape.
    jsonAudioField: process.env.LINGCODE_VOICE_STT_JSON_AUDIO_FIELD || '',
  };
}

function ttsConfig() {
  return {
    url: process.env.LINGCODE_VOICE_TTS_URL || '',
    key: process.env.LINGCODE_VOICE_TTS_KEY || '',
    scheme: process.env.LINGCODE_VOICE_TTS_AUTH_SCHEME || 'Bearer',
    voice: process.env.LINGCODE_VOICE_TTS_VOICE || '',
    modelId: process.env.LINGCODE_VOICE_TTS_MODEL || '',
    hosts: (process.env.LINGCODE_VOICE_TTS_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

// Vendors split into two response shapes: raw audio bytes, or JSON carrying
// base64. Handle both so swapping providers stays an env change.
const B64_AUDIO_KEYS = ['audioContent', 'audio_content', 'audioData', 'audio', 'data', 'content'];

function extractAudio(buf, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.startsWith('audio/')) return { buf, contentType: ct };
  // Not audio — try JSON-with-base64 before giving up.
  let parsed;
  try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { return null; }
  for (const k of B64_AUDIO_KEYS) {
    const v = parsed?.[k] ?? parsed?.result?.[k];
    if (typeof v === 'string' && v.length > 64) {
      // Tolerate a data: URI wrapper as well as bare base64.
      const bare = v.startsWith('data:') ? v.slice(v.indexOf(',') + 1) : v;
      const audio = Buffer.from(bare, 'base64');
      if (audio.length > 0) {
        const mime = v.startsWith('data:') ? v.slice(5, v.indexOf(';')) : sniffAudio(audio);
        return { buf: audio, contentType: mime || 'audio/mpeg' };
      }
    }
  }
  return null;
}

// Identify the container from magic bytes so the <audio> element gets a
// content-type it will actually decode.
function sniffAudio(b) {
  if (b.length < 12) return 'audio/mpeg';
  const ascii = (o, n) => b.subarray(o, o + n).toString('ascii');
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(4, 4) === 'ftyp') return 'audio/mp4';
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return 'audio/mpeg';
}

// Pull {prompt, summary} out of a model reply. Models wrap JSON in prose or code
// fences often enough that naive JSON.parse fails in real use, so find the first
// balanced object instead. Falls back to the raw transcript, because a degraded
// prompt is recoverable and a crashed voice session is not.
function parseShaped(modelText, heard) {
  const fallback = { prompt: heard, summary: heard, degraded: true };
  if (typeof modelText !== 'string' || !modelText.trim()) return fallback;
  const start = modelText.indexOf('{');
  if (start === -1) return fallback;
  // Walk to the matching close brace, respecting strings and escapes.
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < modelText.length; i++) {
    const ch = modelText[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return fallback;
  let obj;
  try { obj = JSON.parse(modelText.slice(start, end + 1)); } catch (_) { return fallback; }
  const prompt = typeof obj.prompt === 'string' ? obj.prompt.trim() : '';
  let summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (!prompt) return fallback;
  if (!summary) summary = prompt;
  // The summary is spoken aloud; keep it listenable.
  if (summary.length > 200) summary = summary.slice(0, 200).trimEnd() + '…';
  return { prompt, summary };
}

// Audio containers the STT route accepts. The spike's chosen MediaRecorder mime
// type must appear here — WebView2 typically lands on audio/webm;codecs=opus.
const ALLOWED_AUDIO = new Set([
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/flac',
]);

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;   // ~8 min of opus; a spoken instruction is seconds
const MAX_TTS_CHARS = 1200;                // one spoken summary, not a document

// Strip any vendor identity out of an upstream failure before it reaches a
// client. We keep the status class (so the client can distinguish "try again"
// from "your input was wrong") and nothing else.
function opaqueUpstreamError(status) {
  if (status === 401 || status === 403) return 'voice_service_unavailable';
  if (status === 429) return 'voice_rate_limited';
  if (status >= 500) return 'voice_service_unavailable';
  return 'voice_request_failed';
}

function registerVoiceRoutes(app, db) {
  const { safeFetch } = require('./safe-fetch');
  const { getUserFromRequest } = require('./auth-helpers');

  // Shared auth gate. Voice is an account feature: it costs money per utterance,
  // so it is never anonymous.
  function requireUser(req, res) {
    const user = getUserFromRequest(db, req);
    if (!user) { res.status(401).json({ ok: false, error: 'unauthorized' }); return null; }
    return user;
  }

  // ── POST /api/voice/transcribe ───────────────────────────────────────────
  // Body is raw audio bytes; Content-Type identifies the container. We use a
  // raw body parser scoped to this route so the global JSON parser doesn't try
  // to parse audio.
  // Required lazily: only route registration needs express, so the pure helpers
  // above stay importable (and unit-testable) with no dependencies installed.
  const rawAudio = require('express').raw({
    type: (req) => {
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      return ALLOWED_AUDIO.has(ct);
    },
    limit: MAX_AUDIO_BYTES,
  });

  app.post('/api/voice/transcribe', rawAudio, async (req, res) => {
    if (!requireUser(req, res)) return;

    const cfg = sttConfig();
    if (!cfg.url || !cfg.hosts.length) {
      return res.status(503).json({ ok: false, error: 'voice_not_configured' });
    }

    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_AUDIO.has(contentType)) {
      return res.status(415).json({ ok: false, error: 'unsupported_audio_type', accepted: [...ALLOWED_AUDIO] });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ ok: false, error: 'empty_audio' });
    }

    // Two request shapes, chosen by env. Default is multipart/form-data (the
    // common shape); vendors that want base64-in-JSON set STT_JSON_AUDIO_FIELD.
    if (cfg.jsonAudioField) {
      try {
        const upstream = await safeFetch(cfg.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeader(cfg.key, cfg.scheme) },
          body: JSON.stringify({
            [cfg.jsonAudioField]: req.body.toString('base64'),
            ...(cfg.model ? { model: cfg.model } : {}),
            mimeType: contentType,
          }),
          allowedHosts: cfg.hosts,
          timeoutMs: 30000,
          maxBytes: 1 * 1024 * 1024,
        });
        if (upstream.status < 200 || upstream.status >= 300) {
          console.error('[voice] transcribe upstream failed', upstream.status, upstream.buf.subarray(0, 400).toString('utf8'));
          return res.status(502).json({ ok: false, error: opaqueUpstreamError(upstream.status) });
        }
        const parsed = JSON.parse(upstream.buf.toString('utf8'));
        const text = parsed.text || parsed.transcript
          || parsed?.results?.[0]?.alternatives?.[0]?.transcript || '';
        return res.json({ ok: true, text: String(text).trim() });
      } catch (e) {
        console.error('[voice] transcribe error', e.status || '', e.message);
        return res.status(e.status && e.status < 500 ? e.status : 502)
          .json({ ok: false, error: e.code === 'fetch_blocked' ? 'voice_egress_blocked' : 'voice_request_failed' });
      }
    }

    // multipart/form-data assembled by hand: avoids a form-data dependency.
    const boundary = '----LingCodeVoice' + Math.random().toString(36).slice(2);
    const ext = contentType.split('/')[1].replace('x-', '');
    const parts = [];
    const field = (name, value) =>
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.${ext}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`));
    parts.push(req.body);
    parts.push(Buffer.from('\r\n'));
    if (cfg.model) field('model', cfg.model);
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    try {
      const upstream = await safeFetch(cfg.url, {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          ...authHeader(cfg.key, cfg.scheme),
        },
        body,
        allowedHosts: cfg.hosts,
        timeoutMs: 30000,
        maxBytes: 1 * 1024 * 1024,
      });

      if (upstream.status < 200 || upstream.status >= 300) {
        // Log the real detail server-side; return nothing vendor-identifying.
        console.error('[voice] transcribe upstream failed', upstream.status, upstream.buf.subarray(0, 400).toString('utf8'));
        return res.status(502).json({ ok: false, error: opaqueUpstreamError(upstream.status) });
      }

      let text = '';
      try {
        const parsed = JSON.parse(upstream.buf.toString('utf8'));
        text = parsed.text || parsed.transcript
          || parsed?.results?.[0]?.alternatives?.[0]?.transcript || '';
      } catch (_) {
        text = upstream.buf.toString('utf8').trim();   // plain-text responder
      }
      return res.json({ ok: true, text: String(text).trim() });
    } catch (e) {
      // safeFetch throws with .status for blocked/failed egress.
      console.error('[voice] transcribe error', e.status || '', e.message);
      return res.status(e.status && e.status < 500 ? e.status : 502)
        .json({ ok: false, error: e.code === 'fetch_blocked' ? 'voice_egress_blocked' : 'voice_request_failed' });
    }
  });

  // ── POST /api/voice/speak ────────────────────────────────────────────────
  // { text } -> audio bytes. The webview plays the response as a blob, which is
  // the one playback path that works identically in WebView2, webkit2gtk and
  // WKWebView (speechSynthesis does not).
  app.post('/api/voice/speak', async (req, res) => {
    if (!requireUser(req, res)) return;

    const cfg = ttsConfig();
    if (!cfg.url || !cfg.hosts.length) {
      return res.status(503).json({ ok: false, error: 'voice_not_configured' });
    }

    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'empty_text' });
    if (text.length > MAX_TTS_CHARS) {
      return res.status(413).json({ ok: false, error: 'text_too_long', max: MAX_TTS_CHARS });
    }

    // The URL may carry a {voice} placeholder so operators can pin a voice
    // without the client ever choosing one.
    const url = cfg.url.replace('{voice}', encodeURIComponent(cfg.voice || ''));

    try {
      const upstream = await safeFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader(cfg.key, cfg.scheme) },
        body: JSON.stringify({
          text,
          ...(cfg.voice ? { voice: cfg.voice, voiceId: cfg.voice } : {}),
          ...(cfg.modelId ? { modelId: cfg.modelId, model_id: cfg.modelId } : {}),
        }),
        allowedHosts: cfg.hosts,
        timeoutMs: 30000,
        maxBytes: 4 * 1024 * 1024,
      });

      if (upstream.status < 200 || upstream.status >= 300) {
        console.error('[voice] speak upstream failed', upstream.status, upstream.buf.subarray(0, 400).toString('utf8'));
        return res.status(502).json({ ok: false, error: opaqueUpstreamError(upstream.status) });
      }

      // Raw audio bytes OR JSON carrying base64 — extractAudio handles both so
      // changing provider stays an env change.
      const audio = extractAudio(upstream.buf, upstream.contentType);
      if (!audio) {
        console.error('[voice] speak: no audio in a 2xx response',
          upstream.contentType, upstream.buf.subarray(0, 200).toString('utf8'));
        return res.status(502).json({ ok: false, error: 'voice_service_unavailable' });
      }
      res.setHeader('content-type', audio.contentType);
      res.setHeader('cache-control', 'no-store');
      return res.send(audio.buf);
    } catch (e) {
      console.error('[voice] speak error', e.status || '', e.message);
      return res.status(e.status && e.status < 500 ? e.status : 502)
        .json({ ok: false, error: e.code === 'fetch_blocked' ? 'voice_egress_blocked' : 'voice_request_failed' });
    }
  });

  // ── POST /api/voice/shape ────────────────────────────────────────────────
  // Loose speech -> a well-formed agent prompt plus a one-line spoken read-back.
  //
  // The read-back is the cheapest guard in the whole feature: it lets the user
  // hear what's about to be asked and say "no" before the agent edits files. A
  // mis-transcription caught here costs a second; caught later it costs a diff.
  //
  // Routed through LingModel (reusing the same two helpers slack-inference.js
  // uses) so shaping runs on the managed provider rather than a second vendor.
  app.post('/api/voice/shape', async (req, res) => {
    if (!requireUser(req, res)) return;

    const heard = String(req.body?.text || '').trim();
    if (!heard) return res.status(400).json({ ok: false, error: 'empty_text' });
    if (heard.length > 2000) return res.status(413).json({ ok: false, error: 'text_too_long' });

    let messagesUrl, apiKey, cfg;
    try {
      const infer = require('./inference-anthropic');
      messagesUrl = infer.lingmodelAnthropicMessagesUrl(db);
      apiKey = infer.lingmodelUpstreamApiKey(db);
      cfg = infer.loadLingModelConfig(db);
    } catch (e) {
      console.error('[voice] shape: LingModel helpers unavailable', e.message);
      return res.status(503).json({ ok: false, error: 'voice_not_configured' });
    }
    if (!messagesUrl || !apiKey) {
      return res.status(503).json({ ok: false, error: 'voice_not_configured' });
    }

    const system =
      'You convert spoken developer instructions into a precise coding-agent prompt. ' +
      'The input is raw speech-to-text: it may contain filler words, false starts, and ' +
      'mis-transcribed technical terms (for example "use effect" for useEffect, ' +
      '"pee bee ex proj" for pbxproj). Correct obvious mis-transcriptions. ' +
      'Do not invent requirements, do not add scope, and do not ask questions. ' +
      'Reply with ONLY a JSON object: ' +
      '{"prompt": "<the instruction, rewritten clearly for a coding agent>", ' +
      '"summary": "<one short sentence, under 20 words, that will be READ ALOUD to ' +
      'confirm intent before running>"}';

    try {
      const upstream = await safeFetch(messagesUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          authorization: `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: (cfg && (cfg.LINGMODEL_FORCE_MODEL || cfg.LINGMODEL_DEFAULT_MODEL)) || undefined,
          max_tokens: 400,
          system,
          messages: [{ role: 'user', content: heard }],
        }),
        // Same host the LingModel proxy already talks to.
        allowedHosts: [new URL(messagesUrl).hostname],
        timeoutMs: 20000,
        maxBytes: 256 * 1024,
      });

      if (upstream.status < 200 || upstream.status >= 300) {
        console.error('[voice] shape upstream failed', upstream.status, upstream.buf.subarray(0, 300).toString('utf8'));
        return res.status(502).json({ ok: false, error: opaqueUpstreamError(upstream.status) });
      }

      const parsed = JSON.parse(upstream.buf.toString('utf8'));
      const text = Array.isArray(parsed.content)
        ? parsed.content.map(c => (c && c.type === 'text' ? c.text : '')).join('')
        : String(parsed.completion || '');
      const shaped = parseShaped(text, heard);
      return res.json({ ok: true, ...shaped });
    } catch (e) {
      console.error('[voice] shape error', e.status || '', e.message);
      // Degrade rather than block: the raw transcript is still usable, and a
      // failed shaping step should not end the hands-free session.
      return res.json({ ok: true, prompt: heard, summary: heard, degraded: true });
    }
  });

  // ── GET /api/voice/status ────────────────────────────────────────────────
  // Lets the client disable the mic button up front rather than failing on the
  // first utterance. Reports only whether voice works — never any vendor detail.
  app.get('/api/voice/status', (req, res) => {
    if (!requireUser(req, res)) return;
    const stt = sttConfig(), tts = ttsConfig();
    res.json({
      ok: true,
      transcribe: !!(stt.url && stt.hosts.length),
      speak: !!(tts.url && tts.hosts.length),
      acceptedAudio: [...ALLOWED_AUDIO],
      maxTextChars: MAX_TTS_CHARS,
    });
  });
}

module.exports = {
  registerVoiceRoutes, ALLOWED_AUDIO, MAX_TTS_CHARS,
  opaqueUpstreamError, authHeader, extractAudio, sniffAudio, parseShaped,
};
