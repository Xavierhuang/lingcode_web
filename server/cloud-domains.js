'use strict';

// cloud-domains.js — CUSTOMER-OWNED custom domains for published prototypes.
// Distinct from domains-routes.js (which CNAMEs vanity SUBDOMAINS on a zone WE
// own to external deploys). Here the customer points THEIR OWN domain
// (myapp.com) at our edge and we serve their LingCode app on it.
//
//   custom_domains: domain → prototype_id (+ owner). The edge proxy issues a
//   TLS cert on-demand after asking GET /api/cloud/domains/verify?domain=<host>
//   (200 = registered). Inbound requests with a registered Host are rewritten
//   to /p/<prototype_id> so the existing public-share renderer serves the app.

const https = require('https');
const dns = require('dns').promises;
const { getUserFromRequest } = require('./auth-helpers');

// RFC-1123 hostname (labels 1–63, alnum + hyphen, ≥2 labels). No wildcards.
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

// The conventional apex↔www sibling we auto-attach so a user gets BOTH forms
// working from a single custom-domain add (shared across worker/app/prototype
// attach routes):
//   www.example.com → example.com       (strip "www." — always the registrable apex)
//   example.com     → www.example.com   (only for a bare 2-label apex)
// Returns null for arbitrary subdomains (api.example.com) — we never invent a www
// there. Multi-part TLDs (example.co.uk) won't auto-expand in the apex→www
// direction; the www→apex strip is always correct regardless of TLD.
function siblingDomain(domain) {
  if (domain.startsWith('www.')) {
    const base = domain.slice(4);
    return base.includes('.') ? base : null;
  }
  if (domain.split('.').length === 2) return 'www.' + domain;
  return null;
}


const APPS_DOMAIN = process.env.LINGCODE_APPS_DOMAIN || 'run.lingcode.dev';

function ownsPrototype(db, prototypeId, userId) {
  return !!db.prepare('SELECT 1 FROM saved_prototypes WHERE id = ? AND user_id = ?').get(prototypeId, userId);
}

function hostOf(req) {
  return String(req.headers.host || '').split(':')[0].trim().toLowerCase();
}
function isOurHost(host) {
  if (!host) return true;
  // Vanity subdomains for static cloud-apps (<slug>.apps.lingcode.dev) are served
  // at ROOT via the custom_domains lookup below — they are NOT first-party traffic,
  // so a routed SPA renders correctly (no /apps/<id>/ sub-path). The bare apex
  // `apps.lingcode.dev` (the custom-domain CNAME target) stays first-party.
  if (host.endsWith('.apps.lingcode.dev')) return false;
  return host === 'lingcode.dev' || host.endsWith('.lingcode.dev') || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
}

// EARLY middleware: a request whose Host is a registered custom domain gets
// served the mapped prototype. Must be installed BEFORE the /p/:id route.
function installCustomDomainMiddleware(app, db) {
  // app_id (cloud apps, served at /apps/<id>/*) takes precedence over the legacy
  // prototype_id (/try prototypes). Column added in migrateCloudAppsTables.
  const lookup = db.prepare("SELECT prototype_id, app_id, worker_id FROM custom_domains WHERE domain = ? AND status = 'active'");
  app.use((req, res, next) => {
    const host = hostOf(req);
    if (isOurHost(host)) return next();           // normal site/API traffic — fast path
    const p = req.path || '/';
    if (p.startsWith('/api/')) return next();      // management/edge API stays on the apex
    let row = null;
    try { row = lookup.get(host); } catch (_) { row = null; }
    if (!row) return next();                       // unknown host → fall through (404)
    if (row.worker_id) return next();              // workers are reverse-proxied earlier (installWorkerDomainProxy)

    // Cloud app: a built SPA needs EVERY path (including /assets/*) routed to its
    // bundle so code-split chunks load and client-side routes hit the SPA fallback.
    if (row.app_id) {
      if (p.startsWith('/apps/')) return next();   // already rewritten / direct hit
      req._customDomain = true;
      const q = req.url.indexOf('?');
      const path = q >= 0 ? req.url.slice(0, q) : req.url;
      const query = q >= 0 ? req.url.slice(q) : '';
      req.url = '/apps/' + row.app_id + path + query;
      return next();
    }

    // Legacy /try prototype: only the root maps to the iframe-srcdoc renderer.
    if (p.startsWith('/p/')) return next();
    if (p === '/' || p === '' || p === '/index.html') {
      req._customDomain = true;                    // /p/:id checks this to drop the Remix button
      const q = req.url.indexOf('?');
      req.url = '/p/' + row.prototype_id + (q >= 0 ? req.url.slice(q) : '');
    }
    return next();
  });
}

// VERY EARLY middleware (installed BEFORE the body parsers, so raw webhook
// bodies stream through intact): a request whose Host is a customer domain
// mapped to a hosted Worker is reverse-proxied to that worker's Cloudflare
// origin (<id>.run.lingcode.dev), Host header rewritten so the dispatch router
// targets the right tenant script. The whole app — incl. /api/* and raw POST
// webhooks (Stripe) — then runs on the customer's domain. Apex/site traffic
// (isOurHost) returns immediately and never touches the DB.
function installWorkerDomainProxy(app, db) {
  const lookup = db.prepare("SELECT worker_id FROM custom_domains WHERE domain = ? AND status = 'active'");
  app.use((req, res, next) => {
    const host = hostOf(req);
    if (isOurHost(host)) return next();
    let row = null;
    try { row = lookup.get(host); } catch (_) { row = null; }
    if (!row || !row.worker_id) return next();     // not a worker custom domain → normal flow

    let target;
    try { target = new URL(req.url, `https://${row.worker_id}.${APPS_DOMAIN}`); }
    catch (_) { res.statusCode = 502; return res.end('Bad gateway'); }
    const headers = { ...req.headers, host: target.host };  // dispatch routes by Host
    const up = https.request(target, { method: req.method, headers }, (pr) => {
      res.writeHead(pr.statusCode || 502, pr.headers);
      pr.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) { res.statusCode = 502; res.end('Bad gateway'); } });
    req.pipe(up);
  });
}

// ── "Smart manual" registrar detection ───────────────────────────────────────
// We can't WRITE a user's DNS for free (GoDaddy gatekeeps onboarding + offers no
// delegated-OAuth consent; only paid Entri holds that integration). But we CAN
// detect WHERE their DNS lives from the zone's NS records and deep-link them
// straight to that host's DNS editor — turning "paste these records somewhere"
// into "detect → click through → paste". Free, first-party, every registrar.
//
// Per-host fields:
//   label/url   — deep-link to the host's DNS editor.
//   apex        — strategy the host supports for APEX (root) domains:
//                   'cname-flattening' — host follows the CNAME at root (Cloudflare-style ANAME).
//                   'alias'            — host has ALIAS/ANAME record type pointing-but-not-CNAME.
//                   'no-apex-cname'    — host's default DNS only supports A/AAAA at apex; user
//                                        needs a paid upgrade OR to delegate the zone elsewhere.
//                   'manual-a'         — host supports A records at apex; user must set the
//                                        explicit IP (works but fragile across edge IP rotations).
//                   'unknown'          — fallback for unrecognized hosts.
//   apexNote    — human-readable apex-setup instruction shown in the dialog when the user adds a
//                 2-label apex domain. Should be 1-3 sentences, end-user-facing tone.
const APEX_TARGET = 'edge.domainee.dev';
const DNS_HOST_HINTS = [
  { rx: /(^|\.)domaincontrol\.com$/i,             label: 'GoDaddy',           url: (d) => `https://dcc.godaddy.com/control/${d}/dns`,
    apex: 'cname-flattening', apexNote: `Apex: GoDaddy supports CNAME-at-root via its "Forward" type. Easier: add CNAME @ → ${APEX_TARGET} and GoDaddy resolves it. SSL is auto-issued.` },
  { rx: /(^|\.)ns\.cloudflare\.com$/i,            label: 'Cloudflare',        url: ()  => 'https://dash.cloudflare.com',
    apex: 'cname-flattening', apexNote: `Apex: in Cloudflare DNS add CNAME @ → ${APEX_TARGET} with Proxy DISABLED (gray cloud — orange will break SSL). Cloudflare flattens it natively.` },
  { rx: /(^|\.)registrar-servers\.com$/i,         label: 'Namecheap BasicDNS', url: (d) => `https://ap.www.namecheap.com/domains/domaincontrolpanel/${d}/advancedns`,
    apex: 'no-apex-cname', apexNote: `Apex: Namecheap BasicDNS can't put a CNAME at root. Three options: (a) Use Namecheap's URL Forward to redirect apex → https://www.${'${d}'} — works for http:// but BREAKS https://apex.  (b) Upgrade to Namecheap PremiumDNS ($5/yr) for ALIAS support.  (c) Move DNS to Cloudflare (free) for CNAME flattening.` },
  { rx: /(^|\.)googledomains\.com$/i,             label: 'Google Domains',    url: ()  => 'https://domains.google.com/registrar',
    apex: 'manual-a', apexNote: `Apex: Google Domains doesn't support ALIAS/ANAME. Add A record @ → 138.197.107.228 (our edge IP — may rotate, prefer Cloudflare-flattened CNAME for resilience).` },
  { rx: /(^|\.)awsdns-?\d*\.[a-z]+$/i,            label: 'AWS Route 53',      url: ()  => 'https://console.aws.amazon.com/route53/v2/hostedzones',
    apex: 'alias', apexNote: `Apex: in Route 53 add an ALIAS A record at root targeting ${APEX_TARGET} (Route 53's ALIAS resolves CNAMEs server-side).` },
  { rx: /(^|\.)digitalocean\.com$/i,              label: 'DigitalOcean',      url: (d) => `https://cloud.digitalocean.com/networking/domains/${d}`,
    apex: 'manual-a', apexNote: `Apex: DO DNS doesn't support ALIAS. Add A record @ → 138.197.107.228 (our edge IP).` },
  { rx: /(^|\.)vercel-dns\.com$/i,                label: 'Vercel',            url: ()  => 'https://vercel.com/dashboard/domains',
    apex: 'cname-flattening', apexNote: `Apex: Vercel DNS resolves CNAMEs at root. Add CNAME @ → ${APEX_TARGET}.` },
  { rx: /(^|\.)dnsimple\.com$/i,                  label: 'DNSimple',          url: ()  => 'https://dnsimple.com/dashboard',
    apex: 'alias', apexNote: `Apex: in DNSimple add ALIAS record @ → ${APEX_TARGET}. SSL is auto-issued.` },
  { rx: /(^|\.)gandi\.net$/i,                     label: 'Gandi',             url: (d) => `https://admin.gandi.net/domain/${d}/records`,
    apex: 'manual-a', apexNote: `Apex: Gandi's LiveDNS doesn't support ALIAS. Add A record @ → 138.197.107.228 (our edge IP).` },
  { rx: /(^|\.)name\.com$/i,                      label: 'Name.com',          url: (d) => `https://www.name.com/account/domain/details/${d}`,
    apex: 'manual-a', apexNote: `Apex: Name.com DNS doesn't support ALIAS. Add A record @ → 138.197.107.228 (our edge IP).` },
  { rx: /(^|\.)porkbun\.com$/i,                   label: 'Porkbun',           url: ()  => 'https://porkbun.com/account/domainsSpeedy',
    apex: 'alias', apexNote: `Apex: in Porkbun add ALIAS record @ → ${APEX_TARGET}. (Porkbun calls it "ALIAS" in the dropdown.)` },
  { rx: /(^|\.)(ui-dns\.(com|de|org|biz)|1and1)/i, label: 'IONOS',           url: ()  => 'https://my.ionos.com',
    apex: 'manual-a', apexNote: `Apex: IONOS doesn't support ALIAS. Add A record @ → 138.197.107.228 (our edge IP).` },
  { rx: /(^|\.)hover\.com$/i,                     label: 'Hover',             url: ()  => 'https://www.hover.com/control_panel/domains',
    apex: 'manual-a', apexNote: `Apex: Hover doesn't support ALIAS. Add A record @ → 138.197.107.228 (our edge IP).` },
  { rx: /(^|\.)(hostinger|dns-parking\.com)/i,    label: 'Hostinger',         url: ()  => 'https://hpanel.hostinger.com',
    apex: 'manual-a', apexNote: `Apex: Hostinger DNS doesn't support ALIAS. Add A record @ → 138.197.107.228 (our edge IP).` },
  { rx: /(^|\.)wixdns\.net$/i,                    label: 'Wix',               url: ()  => 'https://www.wix.com/account/domains',
    apex: 'no-apex-cname', apexNote: `Apex: Wix DNS doesn't expose ALIAS/ANAME and locks down editing. Move DNS to Cloudflare (free) or your registrar for full control.` },
  { rx: /(^|\.)squarespacedns\.com$/i,            label: 'Squarespace',       url: ()  => 'https://account.squarespace.com/domains',
    apex: 'no-apex-cname', apexNote: `Apex: Squarespace DNS is restrictive. Move DNS to Cloudflare (free) or your registrar for ALIAS / CNAME-flattening support.` },
  { rx: /(^|\.)worldnic\.com$/i,                  label: 'Network Solutions', url: ()  => 'https://www.networksolutions.com/my-account',
    apex: 'manual-a', apexNote: `Apex: Network Solutions DNS doesn't support ALIAS. Add A record @ → 138.197.107.228 (our edge IP).` },
  { rx: /(^|\.)dreamhost\.com$/i,                 label: 'DreamHost',         url: ()  => 'https://panel.dreamhost.com/index.cgi?tree=domain.manage',
    apex: 'manual-a', apexNote: `Apex: DreamHost DNS doesn't support ALIAS. Add A record @ → 138.197.107.228 (our edge IP).` },
  { rx: /(^|\.)bluehost\.com$/i,                  label: 'Bluehost',          url: ()  => 'https://my.bluehost.com',
    apex: 'manual-a', apexNote: `Apex: Bluehost DNS doesn't support ALIAS. Add A record @ → 138.197.107.228 (our edge IP).` },
  { rx: /(^|\.)ovh\.net$/i,                       label: 'OVH',               url: ()  => 'https://www.ovh.com/manager',
    apex: 'manual-a', apexNote: `Apex: OVH DNS doesn't expose ALIAS. Add A record @ → 138.197.107.228 (our edge IP).` },
];

function dnsHostFromNameservers(nameservers) {
  for (const ns of nameservers || []) {
    const host = String(ns || '').toLowerCase().replace(/\.$/, '');
    for (const h of DNS_HOST_HINTS) if (h.rx.test(host)) {
      return { label: h.label, url: h.url, apex: h.apex || 'unknown', apexNote: h.apexNote || null };
    }
  }
  return null;
}

// Returns true if `domain` is a 2-label apex (example.com), false otherwise
// (www.example.com, api.example.com, example.co.uk). The dialog uses this to
// decide whether the apex-specific note is even relevant — for subdomains, the
// generic CNAME instruction is always correct and the apex note is noise.
// Multi-part public suffixes (co.uk, com.au) deliberately don't count as apex
// here — they'd usually be entered as 3-label registrable names.
function isBareApex(domain) {
  return String(domain || '').split('.').length === 2;
}

// HEAD probe of https://{domain}/ — surfaces TLS / origin / Namecheap-apex-wart
// failures separately from "DNS doesn't point at us." Used by the per-app and
// per-worker status endpoints so the dialog's status badge can be 3-state
// (Active / DNS-OK-but-HTTPS-fails / Verifying) instead of binary.
//
// Why HEAD: any status < 500 means the LingCode edge accepted the request and
// terminated TLS — the EDGE is reachable even if the user's app returned 404
// for /. We only flag failures that look like infrastructure (TLS, timeout,
// origin unreachable). Origin 4xx is "working from a DNS+TLS perspective."
//
// 5s timeout: long enough for cold-start TLS + handshake, short enough to
// avoid blocking the dialog poll. Returns { ok, status, error } where `ok`
// is true on any 2xx/3xx/4xx response, false on timeout/ECONNREFUSED/TLS error.
async function probeHttps(domain, timeoutMs) {
  const t = typeof timeoutMs === 'number' ? timeoutMs : 5000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), t);
  try {
    const res = await fetch(`https://${domain}/`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return { ok: res.status < 500, status: res.status, error: null };
  } catch (e) {
    clearTimeout(timer);
    const msg = (e && (e.message || String(e))) || 'unknown';
    return { ok: false, status: null, error: msg.slice(0, 200) };
  }
}

// NS records live at the zone apex; querying a subdomain usually returns ENODATA.
// Walk from the entered name up toward the registrable apex until NS resolves.
// Tries the full name first, so example.co.uk resolves before the co.uk cut.
async function resolveZoneNameservers(domain) {
  const parts = domain.split('.');
  for (let i = 0; i + 2 <= parts.length; i++) {
    const cand = parts.slice(i).join('.');
    try {
      const ns = await dns.resolveNs(cand);
      if (ns && ns.length) return { zone: cand, nameservers: ns };
    } catch (_) { /* not a zone cut here — try the parent */ }
  }
  return { zone: null, nameservers: [] };
}

function registerCustomDomainRoutes(app, db) {
  // ── Edge ask: gate on-demand TLS issuance to registered domains only ──
  app.get('/api/cloud/domains/verify', (req, res) => {
    const domain = String((req.query && req.query.domain) || '').trim().toLowerCase();
    const ok = domain && db.prepare("SELECT 1 FROM custom_domains WHERE domain = ? AND status = 'active'").get(domain);
    if (ok) return res.status(200).send('ok');
    return res.status(403).send('not registered');
  });

  // ── Detect a domain's DNS host so the UI can deep-link to its DNS editor ──
  // Pure NS lookup (no third-party API, no key). Returns the friendly host label
  // + a deep link; host=null when we don't recognize the nameservers.
  app.get('/api/cloud/domains/registrar', async (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const domain = String((req.query && req.query.domain) || '').trim().toLowerCase().replace(/\.$/, '');
    if (!HOST_RE.test(domain)) return res.status(400).json({ ok: false, error: 'invalid_domain' });
    try {
      const { zone, nameservers } = await resolveZoneNameservers(domain);
      const hit = dnsHostFromNameservers(nameservers);
      // Per-domain apex strategy + note: when the dialog renders for a 2-label
      // apex (example.com) the client swaps the generic "use registrar
      // forwarding" message with the host-specific instruction. Subdomains
      // (www.example.com, api.example.com) get apex=null and the dialog hides
      // the apex note entirely — the generic CNAME message is sufficient.
      const apex = isBareApex(domain) && hit ? hit.apex : null;
      const apexNote = apex && hit && hit.apexNote
        ? String(hit.apexNote).replace(/\$\{d\}/g, domain)
        : null;
      res.json({
        ok: true, zone, nameservers,
        host: hit ? hit.label : null,
        dnsUrl: hit ? hit.url(zone || domain) : null,
        apex, apexNote,
      });
    } catch (_) {
      res.json({ ok: true, host: null, dnsUrl: null, apex: null, apexNote: null });
    }
  });

  // ── List a prototype's custom domains (owner) ────────────────────────
  app.get('/api/account/prototypes/:id/custom-domains', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const prototypeId = String(req.params.id || '');
    if (!ownsPrototype(db, prototypeId, u.id)) return res.status(404).json({ ok: false, error: 'prototype_not_found' });
    const rows = db.prepare('SELECT domain, status, created_at FROM custom_domains WHERE prototype_id = ? ORDER BY created_at DESC').all(prototypeId);
    res.json({ ok: true, data: rows });
  });

  // ── Attach a customer-owned domain (owner) ───────────────────────────
  app.post('/api/account/prototypes/:id/custom-domains', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const prototypeId = String(req.params.id || '');
    if (!ownsPrototype(db, prototypeId, u.id)) return res.status(404).json({ ok: false, error: 'prototype_not_found' });
    const domain = String((req.body && req.body.domain) || '').trim().toLowerCase().replace(/\.$/, '');
    if (!HOST_RE.test(domain)) return res.status(400).json({ ok: false, error: 'invalid_domain', message: 'Enter a valid domain like app.yoursite.com' });
    if (domain === 'lingcode.dev' || domain.endsWith('.lingcode.dev')) return res.status(400).json({ ok: false, error: 'reserved_domain' });
    const existing = db.prepare('SELECT user_id FROM custom_domains WHERE domain = ?').get(domain);
    if (existing) return res.status(409).json({ ok: false, error: 'domain_taken', message: 'That domain is already attached.' });
    const dnsFor = (d) => ({ cname: { name: d, value: 'apps.lingcode.dev' }, a: { name: d, value: '138.197.107.228' } });
    db.prepare('INSERT INTO custom_domains (domain, prototype_id, user_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(domain, prototypeId, u.id, 'active', new Date().toISOString());
    // Convenience: also attach the apex↔www sibling so both forms work from one add.
    // Best-effort — a taken/invalid sibling silently no-ops and never fails the primary.
    const sib = siblingDomain(domain);
    const also = [];
    if (sib && HOST_RE.test(sib) && sib !== 'lingcode.dev' && !sib.endsWith('.lingcode.dev')
        && !db.prepare('SELECT 1 FROM custom_domains WHERE domain = ?').get(sib)) {
      db.prepare('INSERT INTO custom_domains (domain, prototype_id, user_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(sib, prototypeId, u.id, 'active', new Date().toISOString());
      also.push({ domain: sib, status: 'active', dns: dnsFor(sib) });
    }
    res.json({ ok: true, data: { domain, status: 'active', dns: dnsFor(domain), also: also } });
  });

  // ── Detach a domain (owner) ──────────────────────────────────────────
  app.delete('/api/account/prototypes/:id/custom-domains/:domain', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const prototypeId = String(req.params.id || '');
    const domain = String(req.params.domain || '').trim().toLowerCase();
    const row = db.prepare('SELECT user_id FROM custom_domains WHERE domain = ? AND prototype_id = ?').get(domain, prototypeId);
    if (!row || row.user_id !== u.id) return res.status(404).json({ ok: false, error: 'not_found' });
    db.prepare('DELETE FROM custom_domains WHERE domain = ?').run(domain);
    res.json({ ok: true });
  });
}

module.exports = { installCustomDomainMiddleware, installWorkerDomainProxy, registerCustomDomainRoutes, HOST_RE, siblingDomain, probeHttps };
