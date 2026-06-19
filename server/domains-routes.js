'use strict';

// domains-routes.js — Phase 5b finalize. CRUD for custom subdomains
// attached to a saved prototype. Subdomains live on a zone we own
// (configured via CLOUDFLARE_ZONE_ID); user picks a label, we CNAME
// label.<our-zone> to whatever target URL they paste (typically a
// Netlify deploy URL from the existing Deploy button).
//
// Three env vars activate this surface:
//   CLOUDFLARE_API_TOKEN   token with Zone:Read + Zone:DNS:Edit on the zone
//   CLOUDFLARE_ZONE_ID     the zone where subdomains land (e.g. apps.lingcode.dev)
//   CLOUDFLARE_ZONE_NAME   the zone's apex (so we can construct full hostnames)
// All three unset → routes return 503. Anything broken at the CF API
// surface returns 502 with the upstream error message.
//
// Persistence: prototype_domains table (already migrated). UNIQUE
// constraint on hostname prevents two prototypes from claiming the same
// subdomain.

const { getUserFromRequest } = require('./auth-helpers');
const cf = require('./cloudflare-domains');
const crypto = require('crypto');

// Hostname label rules: per RFC 1035 + Cloudflare's UI conventions.
// 1-63 chars, lowercase alphanumeric + hyphen, no leading/trailing hyphen.
const LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

// Reserve some labels so a user can't claim e.g. www.apps.lingcode.dev or
// admin.apps.lingcode.dev. Add more as needed.
const RESERVED_LABELS = new Set([
  'www', 'admin', 'api', 'mail', 'ftp', 'dashboard', 'app', 'docs', 'help',
  'support', 'status', 'auth', 'login', 'signup', 'pay', 'billing', 'static',
  'cdn', 'assets', 'mx', 'ns', 'ns1', 'ns2', 'staging', 'dev', 'test', 'lingcode',
]);

function isConfigured() {
  return !!process.env.CLOUDFLARE_API_TOKEN
    && !!process.env.CLOUDFLARE_ZONE_ID
    && !!process.env.CLOUDFLARE_ZONE_NAME;
}

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function ownsPrototype(db, prototypeId, userId) {
  return !!db.prepare('SELECT 1 FROM saved_prototypes WHERE id = ? AND user_id = ?').get(prototypeId, userId);
}

// Pull the host part out of an arbitrary URL or bare hostname.
function targetHost(targetUrl) {
  try {
    const u = new URL(/^https?:\/\//i.test(targetUrl) ? targetUrl : `https://${targetUrl}`);
    return u.hostname;
  } catch { return null; }
}

/**
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
function registerDomainsRoutes(app, db) {
  // GET — list domains attached to this prototype
  app.get('/api/prototypes/:id/domains', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const prototypeId = String(req.params.id || '');
    if (!ownsPrototype(db, prototypeId, u.id)) {
      return res.status(404).json({ ok: false, error: 'prototype_not_found' });
    }
    const rows = db.prepare(`
      SELECT id, hostname, target_type, target_value, status, created_at, verified_at
      FROM prototype_domains WHERE prototype_id = ? ORDER BY created_at DESC
    `).all(prototypeId);
    res.json({ ok: true, configured: isConfigured(), zone: process.env.CLOUDFLARE_ZONE_NAME || null, data: rows });
  });

  // POST — claim a subdomain. body: { label, target_url }
  app.post('/api/prototypes/:id/domains', async (req, res) => {
    if (!isConfigured()) return res.status(503).json({ ok: false, error: 'domains_not_configured' });
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const prototypeId = String(req.params.id || '');
    if (!ownsPrototype(db, prototypeId, u.id)) {
      return res.status(404).json({ ok: false, error: 'prototype_not_found' });
    }
    const label = String((req.body || {}).label || '').toLowerCase().trim();
    const targetUrl = String((req.body || {}).target_url || '').trim();
    if (!LABEL_RE.test(label)) {
      return res.status(400).json({ ok: false, error: 'invalid_label', message: 'Label: 1–63 chars, lowercase + digits + hyphens, no leading/trailing hyphen.' });
    }
    if (RESERVED_LABELS.has(label)) {
      return res.status(409).json({ ok: false, error: 'label_reserved' });
    }
    const target = targetHost(targetUrl);
    if (!target) return res.status(400).json({ ok: false, error: 'invalid_target_url' });

    const zoneName = envOrThrow('CLOUDFLARE_ZONE_NAME');
    const hostname = `${label}.${zoneName}`;
    const existing = db.prepare('SELECT 1 FROM prototype_domains WHERE hostname = ?').get(hostname);
    if (existing) return res.status(409).json({ ok: false, error: 'hostname_taken' });

    let cfRecord;
    try {
      cfRecord = await cf.createDnsRecord({
        token: envOrThrow('CLOUDFLARE_API_TOKEN'),
        zoneId: envOrThrow('CLOUDFLARE_ZONE_ID'),
        type: 'CNAME',
        name: hostname,
        content: target,
        proxied: true,
        comment: `lingcode prototype ${prototypeId} (user ${u.id.slice(0, 8)})`,
      });
    } catch (err) {
      const status = err.status >= 400 && err.status < 500 ? err.status : 502;
      return res.status(status).json({ ok: false, error: 'cloudflare_error', message: err.message });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO prototype_domains
        (id, prototype_id, user_id, hostname, target_type, target_value, cloudflare_record_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, prototypeId, u.id, hostname, 'cname', target, cfRecord?.id || null, now);

    res.status(201).json({
      ok: true,
      data: { id, hostname, target_value: target, status: 'pending', visit_url: `https://${hostname}` },
    });
  });

  // POST verify — recheck DNS propagation. Updates status from pending → live
  app.post('/api/prototypes/:id/domains/:hostname/verify', async (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const prototypeId = String(req.params.id || '');
    const hostname = String(req.params.hostname || '');
    if (!ownsPrototype(db, prototypeId, u.id)) {
      return res.status(404).json({ ok: false, error: 'prototype_not_found' });
    }
    const row = db.prepare('SELECT * FROM prototype_domains WHERE prototype_id = ? AND hostname = ?').get(prototypeId, hostname);
    if (!row) return res.status(404).json({ ok: false, error: 'domain_not_found' });

    let result;
    try {
      result = await cf.verifyDnsCNAME({ hostname, expectedTarget: row.target_value });
    } catch (err) {
      return res.status(502).json({ ok: false, error: 'verify_failed', message: err.message });
    }
    if (result.propagated) {
      db.prepare('UPDATE prototype_domains SET status = ?, verified_at = ? WHERE id = ?')
        .run('live', new Date().toISOString(), row.id);
    }
    res.json({ ok: true, data: { propagated: result.propagated, observed: result.observed, status: result.propagated ? 'live' : row.status } });
  });

  // DELETE — remove a domain. Best-effort delete the CF record too;
  // if CF delete fails, we still remove the DB row so the user can re-claim.
  app.delete('/api/prototypes/:id/domains/:hostname', async (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const prototypeId = String(req.params.id || '');
    const hostname = String(req.params.hostname || '');
    if (!ownsPrototype(db, prototypeId, u.id)) {
      return res.status(404).json({ ok: false, error: 'prototype_not_found' });
    }
    const row = db.prepare('SELECT * FROM prototype_domains WHERE prototype_id = ? AND hostname = ?').get(prototypeId, hostname);
    if (!row) return res.status(404).json({ ok: false, error: 'domain_not_found' });

    if (isConfigured() && row.cloudflare_record_id) {
      try {
        await cf.deleteDnsRecord({
          token: envOrThrow('CLOUDFLARE_API_TOKEN'),
          zoneId: envOrThrow('CLOUDFLARE_ZONE_ID'),
          recordId: row.cloudflare_record_id,
        });
      } catch (err) {
        // Log + continue — don't block the user's row deletion on a CF API
        // hiccup. They can re-claim the same hostname; if the record really
        // exists in CF we'll fail with hostname_taken on the re-create and
        // can clean up manually.
        console.warn('[domains] cf delete failed (continuing):', err.message);
      }
    }
    db.prepare('DELETE FROM prototype_domains WHERE id = ?').run(row.id);
    res.json({ ok: true });
  });
}

module.exports = { registerDomainsRoutes, isConfigured };
