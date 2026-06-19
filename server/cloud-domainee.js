'use strict';

// cloud-domainee.js — Domainee (domainee.dev) custom-domain edge integration.
//
// Domainee is an edge-proxy: a customer points ONE CNAME (`<domain> → edge.domainee.dev`)
// and Domainee terminates TLS (auto Let's Encrypt, white-label) and proxies to an
// origin URL we specify — the app's worker URL (https://<id>.run.lingcode.dev). So
// for Domainee-managed domains, OUR Caddy edge is NOT in the path; Domainee handles
// the cert and routing. We just (a) create the connection server-side with our key,
// (b) store its id, (c) show the user the CNAME, (d) poll Domainee for status.
//
// The API key (sk_live_…) lives only here, server-side. INERT until
// LINGCODE_DOMAINEE_KEY is set — every helper reports not-configured and the
// console falls back to the manual LingCode-edge DNS instructions.

const { getUserFromRequest } = require('./auth-helpers');

const KEY = process.env.LINGCODE_DOMAINEE_KEY || '';
const API = process.env.LINGCODE_DOMAINEE_API || 'https://api.domainee.dev';

function isConfigured() { return !!KEY; }

async function dmFetch(path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((body && body.message) || `domainee_${r.status}`);
    e.status = r.status; e.body = body;
    throw e;
  }
  return body;
}

// Create a proxy connection: customer `hostname` → Domainee edge → `originUrl`.
// redirectWww lets Domainee handle the www↔apex redirect at its edge. Returns the
// domain object { id, dnsRecords:[{name,value,type}], status, ... }.
async function createConnection(hostname, originUrl) {
  const body = await dmFetch('/v1/domains', { method: 'POST', body: JSON.stringify({ hostname, originUrl, redirectWww: true }) });
  return body.domain || body;
}

// Force an immediate verification/SSL check. Returns the refreshed domain object.
async function checkDomain(id) {
  const body = await dmFetch(`/v1/domains/${encodeURIComponent(id)}/check`, { method: 'POST' });
  return body.domain || body;
}

// Best-effort teardown — a failure here never blocks the LingCode-side delete.
async function deleteConnection(id) {
  try { await dmFetch(`/v1/domains/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (_) {}
}

// Map a Domainee domain object to our { status, cname } the UI understands.
// 'active' once Domainee reports the cert/edge live; 'pending' otherwise.
function summarize(domain) {
  const rec = (domain && Array.isArray(domain.dnsRecords) && domain.dnsRecords[0]) || {};
  const live = !!(domain && (domain.pointsToEdge || domain.status === 'active' || domain.status === 'live' || domain.status === 'verified'));
  return { status: live ? 'active' : 'pending', cname: rec.value || 'edge.domainee.dev' };
}

function registerDomaineeRoutes(app, db) {
  // Render-time probe so the console knows whether the Domainee path is active.
  app.get('/api/account/domainee-config', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.json({ ok: true, available: isConfigured() });
  });
}

module.exports = {
  registerDomaineeRoutes, isConfigured,
  createConnection, checkDomain, deleteConnection, summarize,
};
