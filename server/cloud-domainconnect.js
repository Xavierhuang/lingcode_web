'use strict';

// cloud-domainconnect.js — Domain Connect (open standard, domainconnect.org) for
// one-click DNS at the user's registrar. Unlike Domainee (proxy + manual CNAME),
// Domain Connect WRITES our records into the user's DNS provider after they
// "Authorize with GoDaddy" — the free version of Entri, using the open spec.
//
// We use the SYNCHRONOUS, signed flow:
//   1. discover()  — TXT _domainconnect.<domain> → provider API host → GET settings
//                    → { providerId, urlSyncUX, … }; supported iff we've onboarded a
//                    template with that provider (LINGCODE_DC_PROVIDERS).
//   2. buildApplyUrl() — construct the apply URL and RSA-SHA256-sign the query string
//                    (the provider verifies it against our public-key TXT record).
//   3. The browser visits it; the provider authenticates the user, shows the records
//      from our REGISTERED template (apex A + www CNAME — values live in the template,
//      not the URL), applies them, and redirects back to our callback with `state`.
//
// INERT until onboarded: isConfigured() is false (and every route 503s / reports
// unsupported) unless the signing key + pubkey domain + redirect + ≥1 provider are
// set. The private key lives ONLY here, server-side.

const crypto = require('crypto');
const dns = require('dns').promises;
const { getUserFromRequest } = require('./auth-helpers');

const SERVICE_ID = process.env.LINGCODE_DC_SERVICE_ID || 'lingcode';
const PROVIDERS = (process.env.LINGCODE_DC_PROVIDERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// The private key may arrive as: raw PEM, PEM with escaped "\n" (systemd/.env), or
// base64-encoded PEM (single-line, systemd-safe — the recommended form). Normalize
// all three to a real PEM so crypto.sign accepts it.
function decodePrivateKey(raw) {
  if (!raw) return '';
  if (raw.includes('BEGIN')) return raw.replace(/\\n/g, '\n');
  try { const d = Buffer.from(raw, 'base64').toString('utf8'); return d.includes('BEGIN') ? d : raw; } catch (_) { return raw; }
}
const PRIVATE_KEY = decodePrivateKey(process.env.LINGCODE_DC_PRIVATE_KEY || '');  // RSA PEM (PKCS8)
const PUBKEY_DOMAIN = process.env.LINGCODE_DC_PUBKEY_DOMAIN || '';    // syncPubKeyDomain, e.g. _dck.lingcode.dev
const KEY_ID = process.env.LINGCODE_DC_KEY_ID || '1';                 // TXT lives at <KEY_ID>.<PUBKEY_DOMAIN>
const REDIRECT_URI = process.env.LINGCODE_DC_REDIRECT_URI || '';      // our callback; its host must be in the template's syncRedirectDomain

function isConfigured() { return !!(PRIVATE_KEY && PUBKEY_DOMAIN && REDIRECT_URI && PROVIDERS.length); }

// ── Discovery ────────────────────────────────────────────────────────────────
// Resolve the DNS provider for a domain and whether we can drive it. Returns
// { found, providerId, providerName, urlSyncUX, supported }.
async function discover(domain, deps = {}) {
  const resolveTxt = deps.resolveTxt || dns.resolveTxt;
  const doFetch = deps.fetch || fetch;
  let apiHost = '';
  try {
    const txt = await resolveTxt(`_domainconnect.${domain}`);
    apiHost = (txt[0] || []).join('').trim();
  } catch (_) { return { found: false }; }
  if (!apiHost) return { found: false };
  let settings;
  try {
    const r = await doFetch(`https://${apiHost}/v2/${encodeURIComponent(domain)}/settings`);
    if (!r.ok) return { found: false };
    settings = await r.json();
  } catch (_) { return { found: false }; }
  const providerId = String(settings.providerId || '').toLowerCase();
  return {
    found: true,
    providerId,
    providerName: settings.providerName || settings.providerDisplayName || providerId,
    urlSyncUX: settings.urlSyncUX || '',
    supported: !!settings.urlSyncUX && PROVIDERS.includes(providerId),
  };
}

// ── Signed apply URL ──────────────────────────────────────────────────────────
// Canonical query string (the part the provider signs/verifies): fixed insertion
// order, values URL-encoded, empty values dropped, EXCLUDING sig/key.
function canonicalQuery(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');
}

// RSA-SHA256 over the canonical query string → base64. Defaults to the env key;
// accepts an explicit key for tests.
function signQuery(qs, privateKeyPem = PRIVATE_KEY) {
  const s = crypto.createSign('RSA-SHA256');
  s.update(qs);
  s.end();
  return s.sign(privateKeyPem, 'base64');
}

// Build the full signed synchronous apply URL. Record VALUES are not sent — they
// live in the template the provider already has; we send only the identity params.
function buildApplyUrl(urlSyncUX, providerId, domain, opts = {}) {
  const params = { domain, redirect_uri: REDIRECT_URI, state: opts.state || '' };
  if (opts.host) params.host = opts.host;
  const qs = canonicalQuery(params);
  const sig = signQuery(qs, opts.privateKey || PRIVATE_KEY);
  const base = `${urlSyncUX}/v2/domainTemplates/providers/${encodeURIComponent(providerId)}/services/${encodeURIComponent(SERVICE_ID)}/apply`;
  return `${base}?${qs}&sig=${encodeURIComponent(sig)}&key=${encodeURIComponent(KEY_ID)}`;
}

// ── Routes ──────────────────────────────────────────────────────────────────
function registerDomainConnectRoutes(app, db) {
  // Render-time probe.
  app.get('/api/account/domainconnect/config', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.json({ ok: true, available: isConfigured() });
  });

  // Discover + (if supported) hand back a signed apply URL. The caller passes the
  // worker the domain is for; we stash {domain, workerId} + a random state in the
  // session so the callback can attach it after the provider applies the template.
  app.get('/api/account/domainconnect/discover', async (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!isConfigured()) return res.status(503).json({ ok: false, error: 'dc_not_configured' });
    const domain = String(req.query.domain || '').trim().toLowerCase().replace(/\.$/, '');
    const workerId = String(req.query.workerId || '').trim();
    if (!domain) return res.status(400).json({ ok: false, error: 'invalid_domain' });
    const d = await discover(domain);
    if (!d.found || !d.supported) {
      return res.json({ ok: true, supported: false, providerName: d.providerName || null });
    }
    const state = crypto.randomBytes(16).toString('hex');
    if (req.session) req.session.dcPending = { domain, workerId, state, userId: u.id };
    const applyUrl = buildApplyUrl(d.urlSyncUX, d.providerId, domain, { state });
    res.json({ ok: true, supported: true, providerName: d.providerName, applyUrl });
  });

  // Provider redirects here after applying (or erroring). Validate state, then
  // register the domain on the worker (our edge then serves it + issues TLS).
  app.get('/api/account/domainconnect/callback', (req, res) => {
    const pending = req.session && req.session.dcPending;
    const state = String(req.query.state || '');
    const error = String(req.query.error || '');
    const ok = pending && state && state === pending.state && !error;
    if (req.session) delete req.session.dcPending;
    if (ok && pending.workerId) {
      try {
        const { attachWorkerDomain, siblingDomain } = require('./cloud-workers');
        attachWorkerDomain(db, pending.workerId, pending.userId, pending.domain);
        const sib = siblingDomain(pending.domain);
        if (sib) attachWorkerDomain(db, pending.workerId, pending.userId, sib);   // apex/www pair (records cover both)
      } catch (_) { /* best-effort; DNS is already set either way */ }
    }
    // Land the user back in the console with a status flag for a toast.
    const flag = ok ? 'dc=applied' : `dc=error&msg=${encodeURIComponent(error || 'cancelled')}`;
    res.redirect(`/account.html?${flag}`);
  });
}

module.exports = {
  registerDomainConnectRoutes, isConfigured,
  // exported for tests
  discover, canonicalQuery, signQuery, buildApplyUrl, decodePrivateKey,
};
