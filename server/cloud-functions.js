'use strict';

// cloud-functions.js — CURATED edge-function templates for LingCode Cloud
// (Phase 5). Deliberately NOT an arbitrary-code runtime: a secure
// multi-tenant sandbox for user-supplied Deno/Node is a separate, much larger
// effort. Instead we ship a vetted registry of named functions (same posture
// as supabase-tools.js's EDGE_FUNCTION_TEMPLATES). The app invokes a deployed
// slug; the control plane runs the template in-process with the tenant's
// vault secrets. To add one: append to TEMPLATES with a `run(input, ctx)`.
//
// ctx = { secrets: { KEY: value, ... }, backendId, allowedHosts: [host, ...] }

const { safeFetch } = require('./safe-fetch');

// Replace {{SECRET_NAME}} tokens in a string with vault secrets from ctx. Only
// env-var-style names resolve; an unknown reference is a 400 (fail loud, never
// silently send an empty credential).
function injectSecrets(str, secrets) {
  return String(str).replace(/\{\{([A-Z][A-Z0-9_]{0,63})\}\}/g, (_m, k) => {
    const v = (secrets || {})[k];
    if (v == null) { const e = new Error(`unknown secret referenced: ${k}`); e.status = 400; throw e; }
    return v;
  });
}

const TEMPLATES = {
  echo: {
    name: 'Echo',
    description: 'Returns whatever JSON you POST. Useful for wiring/testing.',
    requiredSecrets: [],
    async run(input /*, ctx */) { return { echoed: input ?? null, at: new Date().toISOString() }; },
  },
  'send-email': {
    name: 'Send email',
    description: 'Sends an email via LingCode (no API key needed). Body: { to, subject, html }.',
    requiredSecrets: [],
    // Uses the server's shared transactional sender (mail-resend.js) — the app
    // never supplies an email provider key. `from` is forced to the LingCode
    // sender (no caller-supplied `from`) to prevent address spoofing.
    async run(input /*, ctx */) {
      const { to, subject, html } = input || {};
      if (!to || !subject) { const e = new Error('to + subject required'); e.status = 400; throw e; }
      const { sendResendEmail } = require('./mail-resend');
      const sent = await sendResendEmail({ to, subject, html: html || '' });
      if (!sent.ok) { const e = new Error(sent.error || 'email send failed'); e.status = 502; throw e; }
      return { id: sent.id || null };
    },
  },
  'elevenlabs-tts': {
    name: 'ElevenLabs text-to-speech',
    description: 'Synthesize speech with ElevenLabs. Body: { text, voice_id?, model_id? }. Returns { audio_base64, content_type }. Set ELEVENLABS_API_KEY in Secrets first.',
    requiredSecrets: ['ELEVENLABS_API_KEY'],
    async run(input, ctx) {
      const key = (ctx && ctx.secrets && ctx.secrets.ELEVENLABS_API_KEY) || null;
      if (!key) { const e = new Error('ELEVENLABS_API_KEY is not set — add it under the backend Secrets.'); e.status = 400; throw e; }
      const text = input && input.text;
      if (!text || typeof text !== 'string') { const e = new Error('input.text (string) required'); e.status = 400; throw e; }
      const voice = (input && input.voice_id) || '21m00Tcm4TlvDq8ikWAM'; // ElevenLabs "Rachel" default
      const model = (input && input.model_id) || 'eleven_multilingual_v2';
      const r = await safeFetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
        method: 'POST', allowedHosts: ['api.elevenlabs.io'],            // fixed, vetted host
        headers: { 'xi-api-key': key, 'content-type': 'application/json', 'accept': 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: model }),
        timeoutMs: 30000, maxBytes: 12 * 1024 * 1024,
      });
      if (r.status >= 400) { const e = new Error(`ElevenLabs error ${r.status}: ${r.buf.toString('utf8').slice(0, 300)}`); e.status = 502; throw e; }
      return { audio_base64: r.buf.toString('base64'), content_type: r.contentType || 'audio/mpeg', voice_id: voice, model_id: model };
    },
  },
  'twilio-sms': {
    name: 'Twilio — send SMS',
    description: 'Send an SMS via Twilio. Body: { to, body, from? | messaging_service_sid? }. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in Secrets first; set TWILIO_FROM (an E.164 number or Messaging Service SID) to omit `from` per call.',
    requiredSecrets: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
    async run(input, ctx) {
      const secrets = (ctx && ctx.secrets) || {};
      const sid = secrets.TWILIO_ACCOUNT_SID;
      const token = secrets.TWILIO_AUTH_TOKEN;
      if (!sid || !token) { const e = new Error('TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN must be set under the backend Secrets.'); e.status = 400; throw e; }
      const to = input && input.to;
      const text = input && input.body;
      if (!to || typeof to !== 'string') { const e = new Error('input.to (E.164 phone, string) required'); e.status = 400; throw e; }
      if (!text || typeof text !== 'string') { const e = new Error('input.body (string) required'); e.status = 400; throw e; }
      // Twilio needs either a From number or a Messaging Service SID. Accept
      // per-call values, else fall back to the TWILIO_FROM / TWILIO_MESSAGING_SERVICE_SID secrets.
      const msid = (input && input.messaging_service_sid) || secrets.TWILIO_MESSAGING_SERVICE_SID || null;
      const from = (input && input.from) || secrets.TWILIO_FROM || null;
      if (!msid && !from) { const e = new Error('Provide input.from (E.164) or input.messaging_service_sid (or set TWILIO_FROM / TWILIO_MESSAGING_SERVICE_SID in Secrets).'); e.status = 400; throw e; }
      const form = new URLSearchParams();
      form.set('To', to);
      if (msid) form.set('MessagingServiceSid', msid); else form.set('From', from);
      form.set('Body', text);
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const r = await safeFetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST', allowedHosts: ['api.twilio.com'],               // fixed, vetted host
        headers: { 'authorization': `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        timeoutMs: 15000, maxBytes: 256 * 1024,
      });
      let j = null; try { j = JSON.parse(r.buf.toString('utf8')); } catch (_) { /* non-JSON error body */ }
      if (r.status >= 400) { const e = new Error(`Twilio error ${r.status}: ${(j && j.message) || r.buf.toString('utf8').slice(0, 300)}`); e.status = 502; throw e; }
      return { sid: j && j.sid, status: j && j.status, to: j && j.to, from: j && j.from };
    },
  },
  'resend-byo': {
    name: 'Resend — send from your own account',
    description: 'Send email via YOUR Resend account/domain (unlike the built-in send-email, which uses LingCode\'s sender). Body: { from, to, subject, html?, text? }. Set RESEND_API_KEY in Secrets first; `from` must be a verified Resend domain.',
    requiredSecrets: ['RESEND_API_KEY'],
    async run(input, ctx) {
      const key = (ctx && ctx.secrets && ctx.secrets.RESEND_API_KEY) || null;
      if (!key) { const e = new Error('RESEND_API_KEY is not set — add it under the backend Secrets.'); e.status = 400; throw e; }
      const { from, to, subject, html, text } = input || {};
      if (!from || !to || !subject) { const e = new Error('input.from, input.to, and input.subject are required'); e.status = 400; throw e; }
      if (!html && !text) { const e = new Error('provide input.html or input.text'); e.status = 400; throw e; }
      const payload = { from, to, subject };
      if (html) payload.html = html;
      if (text) payload.text = text;
      const r = await safeFetch('https://api.resend.com/emails', {
        method: 'POST', allowedHosts: ['api.resend.com'],               // fixed, vetted host
        headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 15000, maxBytes: 256 * 1024,
      });
      let j = null; try { j = JSON.parse(r.buf.toString('utf8')); } catch (_) { /* non-JSON */ }
      if (r.status >= 400) { const e = new Error(`Resend error ${r.status}: ${(j && (j.message || j.name)) || r.buf.toString('utf8').slice(0, 300)}`); e.status = 502; throw e; }
      return { id: j && j.id };
    },
  },
  'stripe-checkout': {
    name: 'Stripe — create a Checkout Session',
    description: 'Create a Stripe Checkout Session and return { id, url } — redirect the buyer to `url`. Body: { price_id, success_url, cancel_url, mode?, quantity?, customer_email?, metadata? }. mode is "payment" (one-time, default) or "subscription". Set STRIPE_SECRET_KEY in Secrets first.',
    requiredSecrets: ['STRIPE_SECRET_KEY'],
    async run(input, ctx) {
      const key = (ctx && ctx.secrets && ctx.secrets.STRIPE_SECRET_KEY) || null;
      if (!key) { const e = new Error('STRIPE_SECRET_KEY is not set — add it under the backend Secrets.'); e.status = 400; throw e; }
      const { price_id, success_url, cancel_url } = input || {};
      if (!price_id || !success_url || !cancel_url) { const e = new Error('input.price_id, input.success_url, and input.cancel_url are required'); e.status = 400; throw e; }
      const mode = ((input && input.mode) === 'subscription') ? 'subscription' : 'payment';
      const quantity = Math.max(1, Math.floor(Number((input && input.quantity) ?? 1)) || 1);
      const form = new URLSearchParams();
      form.set('mode', mode);
      form.set('line_items[0][price]', String(price_id));
      form.set('line_items[0][quantity]', String(quantity));
      form.set('success_url', String(success_url));
      form.set('cancel_url', String(cancel_url));
      if (input && input.customer_email) form.set('customer_email', String(input.customer_email));
      if (input && input.metadata && typeof input.metadata === 'object') {
        for (const [k, v] of Object.entries(input.metadata)) form.set(`metadata[${k}]`, String(v));
      }
      const r = await safeFetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST', allowedHosts: ['api.stripe.com'],               // fixed, vetted host
        headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        timeoutMs: 15000, maxBytes: 256 * 1024,
      });
      let j = null; try { j = JSON.parse(r.buf.toString('utf8')); } catch (_) { /* non-JSON error body */ }
      if (r.status >= 400) { const e = new Error(`Stripe error ${r.status}: ${(j && j.error && j.error.message) || r.buf.toString('utf8').slice(0, 300)}`); e.status = 502; throw e; }
      return { id: j && j.id, url: j && j.url };
    },
  },
  'http-fetch': {
    name: 'Call an external API',
    description: 'THE GENERIC way to integrate ANY third-party REST API with a server-side secret — use this instead of asking for a new per-vendor function. Make an HTTPS request to an allow-listed host. Body: { url, method?, headers?, body? }. Header/body values may reference vault secrets as {{SECRET_NAME}} (e.g. Authorization: "Bearer {{MY_API_KEY}}"), so the key never reaches the client. The owner adds the domain under Settings → Allowed fetch hosts first (SSRF guard).',
    requiredSecrets: [],
    async run(input, ctx) {
      const url = input && input.url;
      if (!url || typeof url !== 'string') { const e = new Error('input.url (https) required'); e.status = 400; throw e; }
      const allowedHosts = (ctx && ctx.allowedHosts) || [];
      if (!allowedHosts.length) { const e = new Error('No allow-listed fetch hosts. Add a domain under Settings → Allowed fetch hosts first.'); e.status = 403; throw e; }
      const method = String((input && input.method) || 'GET').toUpperCase();
      const secrets = (ctx && ctx.secrets) || {};
      const headers = {};
      const inHeaders = (input && input.headers && typeof input.headers === 'object') ? input.headers : {};
      for (const [k, v] of Object.entries(inHeaders)) headers[String(k)] = injectSecrets(String(v), secrets);
      let body;
      if (input && input.body != null) body = (typeof input.body === 'string') ? injectSecrets(input.body, secrets) : JSON.stringify(input.body);
      const r = await safeFetch(url, { method, headers, body, allowedHosts, timeoutMs: 15000, maxBytes: 5 * 1024 * 1024 });
      const ct = (r.contentType || '').toLowerCase();
      const out = { status: r.status, headers: r.headers };
      if (/json|text|xml|javascript|csv|urlencoded/.test(ct)) {
        const t = r.buf.toString('utf8');
        out.body = t;
        if (/json/.test(ct)) { try { out.json = JSON.parse(t); } catch (_) { /* leave as text */ } }
      } else {
        out.body_base64 = r.buf.toString('base64');
      }
      return out;
    },
  },
};

function listTemplates() {
  return Object.entries(TEMPLATES).map(([slug, t]) => ({
    slug, name: t.name, description: t.description, required_secrets: t.requiredSecrets,
  }));
}

function getTemplate(slug) {
  return TEMPLATES[slug] || null;
}

async function runTemplate(slug, input, ctx) {
  const t = getTemplate(slug);
  if (!t) { const e = new Error('unknown function'); e.status = 404; throw e; }
  return t.run(input, ctx);
}

module.exports = { listTemplates, getTemplate, runTemplate, TEMPLATES };
