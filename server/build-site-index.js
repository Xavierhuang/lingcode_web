'use strict';

// build-site-index.js — one-shot ingestion for the site assistant. Crawls the
// public website HTML (root pages + tutorials/), strips to readable text,
// chunks it, embeds each chunk, and writes site-index.json (consumed by
// site-assistant.js at boot). Re-run after a content change.
//
// Usage (locally or on the droplet, from website/server/):
//   CLOUD_EMBEDDINGS_API_KEY=sk-... node build-site-index.js [--site <dir>] [--out <file>]
//   # on the droplet the site lives at /var/www/html:
//   node build-site-index.js --site /var/www/html --out /opt/lingcode-api/site-index.json
//
// The output is plain JSON: { built_at, model, dim, chunks: [{url,title,text,embedding}] }.

const fs = require('fs');
const path = require('path');
const { embedTexts } = require('./site-assistant');

function arg(name, dflt) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; }
const SITE_DIR = arg('--site', path.resolve(__dirname, '..'));
const OUT = arg('--out', path.join(__dirname, 'site-index.json'));
const DB_PATH = arg('--db', path.join(__dirname, 'data.db'));
// Open the control-plane DB read-only so embedTexts can resolve the embeddings
// key from app_config (the same key the app uses) — no need to pass a secret.
let _db = null;
try { _db = require('better-sqlite3')(DB_PATH, { readonly: true, fileMustExist: true }); } catch (_) { _db = null; }

// Pages we don't want the assistant quoting (the assistant's own tooling, raw
// data, the console app, etc.). Everything else under SITE_DIR is fair game.
const SKIP = new Set(['backends.html', 'account.html', 'try.html', '404.html', 'sitemap.html']);
const SKIP_DIRS = new Set(['server', 'marketing', 'pagefind', 'sdk', 'assets', 'images', 'img', 'fonts']);

function listHtml(dir, baseUrl) {
  const out = [];
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) out.push(...listHtml(path.join(dir, e.name), baseUrl + e.name + '/')); }
    else if (e.isFile() && e.name.endsWith('.html') && !SKIP.has(e.name)) out.push({ file: path.join(dir, e.name), url: baseUrl + e.name });
  }
  return out;
}

// Crude but effective HTML → text: drop script/style/nav/footer, strip tags,
// collapse whitespace, decode the few common entities. (No deps.)
function htmlToText(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, ' ').replace(/<footer[\s\S]*?<\/footer>/gi, ' ').replace(/<head[\s\S]*?<\/head>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\/(p|div|li|h[1-6]|section|article|tr|br)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&mdash;/g, '—').replace(/&[a-z]+;/gi, ' ');
  return s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).join('\n').trim();
}
function titleOf(html, fallback) {
  const m = html.match(/<title>([^<]*)<\/title>/i) || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return (m ? m[1].replace(/<[^>]+>/g, '').replace(/\s*[|—-]\s*LingCode.*$/i, '').trim() : '') || fallback;
}

// ~600-word chunks with ~60-word overlap, split on paragraph boundaries.
function chunk(text, title, url) {
  const words = text.split(/\s+/);
  const SIZE = 600, OVERLAP = 60, chunks = [];
  for (let i = 0; i < words.length; i += (SIZE - OVERLAP)) {
    const slice = words.slice(i, i + SIZE).join(' ').trim();
    if (slice.length > 80) chunks.push({ url, title, text: `${title}\n${slice}` });
    if (i + SIZE >= words.length) break;
  }
  return chunks;
}

async function main() {
  const pages = listHtml(SITE_DIR, '/').filter((p) => !p.url.includes('/tutorials/') || true);
  console.log(`Scanning ${pages.length} HTML pages under ${SITE_DIR}`);
  let chunks = [];
  for (const p of pages) {
    const html = fs.readFileSync(p.file, 'utf8');
    const text = htmlToText(html);
    if (text.length < 120) continue; // skip near-empty pages
    chunks.push(...chunk(text, titleOf(html, p.url), p.url));
  }
  console.log(`Built ${chunks.length} chunks; embedding in batches…`);
  const BATCH = 64; let dim = 0;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const vecs = await embedTexts(batch.map((c) => c.text.slice(0, 8000)), { db: _db });
    batch.forEach((c, j) => { c.embedding = vecs[j]; });
    dim = (vecs[0] && vecs[0].length) || dim;
    process.stdout.write(`  embedded ${Math.min(i + BATCH, chunks.length)}/${chunks.length}\r`);
  }
  const out = { built_at: new Date().toISOString(), model: process.env.CLOUD_EMBEDDINGS_MODEL || 'text-embedding-3-small', dim, chunks };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`\nWrote ${OUT} (${chunks.length} chunks, dim ${dim}, ${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
}

if (require.main === module) main().catch((e) => { console.error('\nbuild-site-index failed:', e.message); process.exit(1); });

module.exports = { htmlToText, titleOf, chunk, listHtml };
