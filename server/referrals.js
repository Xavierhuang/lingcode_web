'use strict';

// referrals.js — affiliate / marketer referral links.
//
// Flow:
//   1. Admin mints a code (POST /api/admin/referrals) → share link /r/<code>
//      + a token for the marketer's own dashboard.
//   2. /r/<code> logs a click, sets a 90-day lc_ref cookie, and 302s to the DMG.
//   3. On signup, attributeOnSignup() reads that cookie and stamps
//      users.referred_by = <code> — GUARDED so it can never break signup.
//   4. Marketer checks their own numbers at /partner.html?code=&token= →
//      GET /api/ref/<code>?token= (clicks / signups / paid), token-gated.
//
// "Paid" = a Stripe-active subscription (subscription_status). Downloads aren't
// perfectly attributable (static DMG + edge cache), so clicks = download-intent.

const crypto = require('crypto');

const CODE_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/;
const DMG = '/LingCode-Installer.dmg';
const PAID_SQL = "subscription_status IN ('active','trialing')";

// Branded interstitial served on /r/<code>. Social scrapers (iMessage, Slack,
// Twitter, Discord) read the Open Graph tags to build a preview card; real
// browsers run the inline redirect and land on the DMG download. We serve HTML
// to EVERYONE rather than UA-sniffing because iMessage's link-preview fetcher
// often sends a plain Safari UA, so sniffing would miss the main surface.
// Two destinations off the same card:
//   • default  → straight to the DMG download (/r/<code>)
//   • ?site    → the homepage, so visitors browse first (/r/<code>?site)
// Both set the attribution cookie and count the click identically; only the
// redirect target + the visible "you're being sent…" line differ.
// `ogUrl`/`dest` are built from internal constants + a CODE_RE-validated code,
// so they're safe to embed.
const OG_TITLE = 'LingCode — Real native apps. Not vibe-coded React.';
const OG_DESC = 'Real Swift, real Xcode, real App Store. Web, CLI, and a native Mac IDE.';
const OG_IMAGE = 'https://lingcode.dev/lingcode-feature-graphic-1024x500.png';
function referralInterstitial({ ogUrl, dest, toSite }) {
  const line = toSite ? 'Opening LingCode…' : 'Downloading LingCode…';
  const link = toSite ? 'Continue to LingCode' : "Click here if your download doesn't start.";
  // Redirect strategy differs by variant:
  //  • ?site  → replace the top document with the homepage (the desired landing).
  //  • download → DON'T navigate the top doc; navigating to a .dmg (octet-stream)
  //    starts the download but blanks the tab. Pull it through a hidden iframe so
  //    this branded "Downloading…" page stays visible with its manual fallback.
  const headRedirect = toSite ? `<meta http-equiv="refresh" content="0;url=${dest}">` : '';
  const bodyScript = toSite
    ? `location.replace(${JSON.stringify(dest)});`
    : `var f=document.createElement('iframe');f.style.display='none';f.src=${JSON.stringify(dest)};document.body.appendChild(f);`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${OG_TITLE}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="LingCode">
<meta property="og:title" content="${OG_TITLE}">
<meta property="og:description" content="${OG_DESC}">
<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:url" content="${ogUrl}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${OG_TITLE}">
<meta name="twitter:description" content="${OG_DESC}">
<meta name="twitter:image" content="${OG_IMAGE}">
${headRedirect}
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;
       font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
       background:#0b0b0f;color:#e8e8ea}
  .card{text-align:center;padding:2rem}
  a{color:#7c8cff}
</style>
</head>
<body>
  <div class="card">
    <p>${line}</p>
    <p><a href="${dest}"${toSite ? '' : ' download'}>${link}</a></p>
  </div>
  <script>${bodyScript}</script>
</body>
</html>`;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS referrals (
    code        TEXT PRIMARY KEY,
    label       TEXT,
    token       TEXT NOT NULL,
    clicks      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  )`);
  try {
    const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
    if (!cols.has('referred_by')) db.exec('ALTER TABLE users ADD COLUMN referred_by TEXT');
  } catch (_) { /* additive; ignore if it races */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by)'); } catch (_) {}
}

// Parse the lc_ref cookie from the raw header (no cookie-parser in this app).
function readRefCookie(req) {
  try {
    const m = String((req.headers && req.headers.cookie) || '').match(/(?:^|;\s*)lc_ref=([^;]+)/);
    return m ? decodeURIComponent(m[1]).toLowerCase().slice(0, 41) : null;
  } catch (_) { return null; }
}

// Called from signup paths. NEVER throws — swallows everything so a referral
// hiccup can't break account creation.
function attributeOnSignup(db, req, userId) {
  try {
    const code = readRefCookie(req);
    if (!code || !userId || !CODE_RE.test(code)) return;
    if (!db.prepare('SELECT 1 FROM referrals WHERE code = ?').get(code)) return;
    db.prepare("UPDATE users SET referred_by = ? WHERE id = ? AND (referred_by IS NULL OR referred_by = '')")
      .run(code, userId);
  } catch (_) { /* never break signup */ }
}

function statsFor(db, code) {
  const ref = db.prepare('SELECT code, label, clicks, created_at FROM referrals WHERE code = ?').get(code);
  if (!ref) return null;
  const signups = db.prepare('SELECT COUNT(*) AS n FROM users WHERE referred_by = ?').get(code).n;
  const paid = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE referred_by = ? AND ${PAID_SQL}`).get(code).n;
  return { code: ref.code, label: ref.label || '', clicks: ref.clicks, signups, paid, created_at: ref.created_at };
}

function register(app, db, requireAdmin) {
  migrate(db);

  // ── Marketer link: log click + set cookie + serve a branded interstitial ──
  // Returns HTML (not a 302) so social scrapers get an Open Graph preview card;
  // browsers run the inline redirect. Two destinations off the same link:
  //   /r/<code>       → straight to the DMG download (default)
  //   /r/<code>?site  → the homepage, so visitors browse before downloading
  // Both count the click + set the attribution cookie identically.
  app.get('/r/:code', (req, res) => {
    const code = String(req.params.code || '').toLowerCase();
    const valid = CODE_RE.test(code);
    const exists = valid && db.prepare('SELECT 1 FROM referrals WHERE code = ?').get(code);
    if (exists) {
      try { db.prepare('UPDATE referrals SET clicks = clicks + 1 WHERE code = ?').run(code); } catch (_) {}
      // Lax so it survives the redirect + a later top-level signup navigation.
      res.setHeader('Set-Cookie', `lc_ref=${encodeURIComponent(code)}; Path=/; Max-Age=${90 * 24 * 3600}; SameSite=Lax`);
    }
    const toSite = req.query.site !== undefined;
    const dest = toSite ? '/' : DMG;
    // Unknown/invalid codes still get the branded card (no cookie), matching the
    // old "always redirect" behaviour. Sanitize the code we echo into og:url.
    const safeCode = valid ? code : '';
    const ogUrl = `https://lingcode.dev/r/${safeCode}${toSite ? '?site' : ''}`;
    res.type('html').send(referralInterstitial({ ogUrl, dest, toSite }));
  });

  // ── Marketer self-serve stats (token-gated, no login) ──
  app.get('/api/ref/:code', (req, res) => {
    const code = String(req.params.code || '').toLowerCase();
    const token = String((req.query && req.query.token) || '');
    const ref = db.prepare('SELECT token FROM referrals WHERE code = ?').get(code);
    if (!ref) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!token || token !== ref.token) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.json({ ok: true, data: statsFor(db, code) });
  });

  // ── Admin: mint a marketer code (+ token + the two links) ──
  app.post('/api/admin/referrals', requireAdmin, (req, res) => {
    const label = String((req.body && req.body.label) || '').slice(0, 80).trim();
    let code = String((req.body && req.body.code) || '').toLowerCase().trim();
    if (!code) {
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
      code = (slug || 'm') + '-' + crypto.randomBytes(2).toString('hex');
    }
    if (!CODE_RE.test(code)) return res.status(400).json({ ok: false, error: 'invalid_code', message: 'code = lowercase letters/digits/-/_ , 2–41 chars' });
    if (db.prepare('SELECT 1 FROM referrals WHERE code = ?').get(code)) return res.status(409).json({ ok: false, error: 'code_taken', message: 'That code is taken.' });
    const token = crypto.randomBytes(18).toString('base64url');
    db.prepare('INSERT INTO referrals (code, label, token, clicks, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(code, label, token, new Date().toISOString());
    res.json({ ok: true, data: { code, label, token } });
  });

  // ── Admin: list all marketers with stats (+ token, so admin can copy links) ──
  app.get('/api/admin/referrals', requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT code, token FROM referrals ORDER BY created_at DESC').all();
    res.json({ ok: true, data: rows.map((r) => ({ ...statsFor(db, r.code), token: r.token })) });
  });

  app.delete('/api/admin/referrals/:code', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM referrals WHERE code = ?').run(String(req.params.code || '').toLowerCase());
    res.json({ ok: true });
  });
}

module.exports = { register, attributeOnSignup };
