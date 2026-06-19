// main-site-config.js — site identity / analytics / forms config for /try.
//
// One per user (localStorage). Injected into the AI's system prompt
// every turn so generated landing pages automatically reference your
// brand, GA4 ID, form submit endpoint, etc. — no manual swap after
// generation.
//
// Also wires a small SEO-meta addendum (separate from site config; this
// one runs whether or not the user has filled in site config) so every
// generated page ships with proper Open Graph + Twitter cards by default.

const STORAGE_KEY = 'lingcode.try.siteconfig';

const FIELDS = [
  { id: 'brand',       label: 'Brand name',         placeholder: 'Helix' },
  { id: 'domain',      label: 'Domain',             placeholder: 'helix.dev', help: 'Used for canonical URLs and og:url.' },
  { id: 'ga4',         label: 'GA4 measurement ID', placeholder: 'G-XXXXXXXXXX' },
  { id: 'gtm',         label: 'GTM container ID',   placeholder: 'GTM-XXXXXXX' },
  { id: 'formAction',  label: 'Form submit endpoint', placeholder: 'https://formspree.io/f/...', help: 'Where contact / signup forms POST to.' },
  { id: 'contactEmail',label: 'Contact email',      placeholder: 'hello@example.com' },
  // Brand asset URLs — text input, one URL each. Skip the upload-to-data-URL
  // flow for v1 since most brand surfaces already have hosted images
  // (Cloudinary, S3, the user's own CDN). For users without hosted assets
  // the AI's Pollinations / Unsplash fallbacks (in seoSystemAddendum) cover
  // the gap.
  { id: 'logoUrl',     label: 'Logo URL',           placeholder: 'https://example.com/logo.png', help: 'Hosted PNG/SVG/WebP. Used in headers and footers.' },
  { id: 'heroImageUrl',label: 'Hero image URL',     placeholder: 'https://example.com/hero.jpg', help: 'Used for above-the-fold hero / og:image.' },
  { id: 'faviconUrl',  label: 'Favicon URL',        placeholder: 'https://example.com/favicon.ico' },
];

export function getSiteConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch { return {}; }
}

export function saveSiteConfig(cfg) {
  if (!cfg || Object.keys(cfg).length === 0) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  syncSiteConfigBtn();
}

export function syncSiteConfigBtn() {
  const btn = document.getElementById('site-config-btn');
  if (!btn) return;
  const cfg = getSiteConfig();
  const filledCount = FIELDS.filter((f) => (cfg[f.id] || '').trim()).length;
  if (filledCount > 0) {
    btn.textContent = `🌐 Site (${filledCount})`;
    btn.classList.add('active');
    btn.title = `${filledCount} of ${FIELDS.length} site fields set — click to edit`;
  } else {
    btn.textContent = '🌐 Site';
    btn.classList.remove('active');
    btn.title = 'Brand, domain, analytics, forms — auto-injected into every generated page';
  }
}

// Always-on SEO + accessibility + images addendum. Runs even when site
// config is empty so every generated page ships with proper meta tags.
// The AI is reminded to use semantic HTML, alt text, lazy-loading, and
// Open Graph + Twitter cards. Plus image-source nudges (Pollinations
// for AI-generated illustrations, Unsplash for real photos) so images
// in landing pages aren't all placeholder boxes.
export function seoSystemAddendum() {
  return `\n\nWhen producing a landing page, marketing site, blog, or any user-facing HTML:
- Always include <title> (under 60 chars) and <meta name="description"> (under 160 chars).
- Always include Open Graph: <meta property="og:title">, og:description, og:type, og:url, og:image.
- Always include Twitter cards: <meta name="twitter:card" content="summary_large_image">, twitter:title, twitter:description, twitter:image.
- Use a placeholder og:image at https://placehold.co/1200x630/png?text=<brand> if no real image is available.
- Use semantic HTML: <header>, <nav>, <main>, <article>, <section>, <footer>.
- Every <img> needs descriptive alt text. Non-hero images get loading="lazy" + decoding="async" + width/height attributes.
- Every <a> to an external site gets rel="noopener noreferrer".
- Use <link rel="canonical" href="..."> when the page would have a real production URL.
- font-display: swap on Google Fonts links to prevent invisible-text-flash.

For images in generated pages:
- For AI-generated illustrations / hero art / product mockups: use https://image.pollinations.ai/prompt/<URL-encoded-prompt>?width=1024&height=576&nologo=true . Free, no API key, returns a real generated image. Example: https://image.pollinations.ai/prompt/futuristic%20office%20interior%2C%20warm%20light?width=1200&height=630&nologo=true
- For real stock photos (people, real objects, locations): use https://source.unsplash.com/<width>x<height>/?<comma-separated-keywords> — also free, no API key. Example: https://source.unsplash.com/1200x630/?developer,laptop
- Always set explicit width and height attributes on <img> tags using these sources to prevent layout shift.
- Pick Pollinations for "imagine this" / branded / abstract; Unsplash for real photos / faces / specific places.`;
}

export function siteConfigSystemAddendum() {
  const cfg = getSiteConfig();
  const set = FIELDS.filter((f) => (cfg[f.id] || '').trim());
  if (set.length === 0) return '';
  const lines = [];
  lines.push('\n\nThe user has set site identity / analytics config — use these in generated pages:');
  if (cfg.brand)        lines.push(`- Brand name: ${cfg.brand}`);
  if (cfg.domain)       lines.push(`- Domain: ${cfg.domain} (use https://${cfg.domain} for canonical + og:url)`);
  if (cfg.ga4)          lines.push(`- Google Analytics 4: include the gtag snippet for ID ${cfg.ga4} in <head>`);
  if (cfg.gtm)          lines.push(`- Google Tag Manager: include the GTM snippet for ID ${cfg.gtm} (head + noscript fallback)`);
  if (cfg.formAction)   lines.push(`- Form submit endpoint: ${cfg.formAction} (use as <form action> for contact / signup forms; method="POST")`);
  if (cfg.contactEmail) lines.push(`- Contact email: ${cfg.contactEmail} (use in mailto: links and footer text)`);
  if (cfg.logoUrl)      lines.push(`- Logo URL: ${cfg.logoUrl} (use in <header> brand link, footer, and as schema.org Organization.logo). Prefer this over Pollinations or placeholder boxes for any "logo" / "brand mark" image position.`);
  if (cfg.heroImageUrl) lines.push(`- Hero image URL: ${cfg.heroImageUrl} (use as primary above-the-fold image AND as <meta property="og:image"> + <meta name="twitter:image">). Prefer this over Unsplash/Pollinations for the main hero image.`);
  if (cfg.faviconUrl)   lines.push(`- Favicon URL: ${cfg.faviconUrl} (use as <link rel="icon">). Prefer this over generated favicon URLs.`);
  return lines.join('\n');
}

export function openSiteConfigDialog() {
  let pop = document.querySelector('.site-config-popover');
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'ckpt-name-popover site-config-popover';
    pop.style.cssText = 'width:380px;max-height:70vh;overflow-y:auto;flex-direction:column;gap:8px;';
    document.body.appendChild(pop);
    document.addEventListener('click', (e) => {
      if (!pop.contains(e.target) && !document.getElementById('site-config-btn')?.contains(e.target)) {
        pop.style.display = 'none';
      }
    });
  }
  pop.textContent = '';

  const heading = document.createElement('div');
  heading.style.cssText = 'font-size:0.82rem;font-weight:600;color:var(--text);';
  heading.textContent = '🌐 Site identity';
  pop.append(heading);

  const blurb = document.createElement('div');
  blurb.style.cssText = 'font-size:0.74rem;color:var(--text-muted);line-height:1.4;';
  blurb.textContent = 'Auto-injected into every generated page. Skip any field — only filled-in ones get used.';
  pop.append(blurb);

  const cfg = getSiteConfig();
  const inputs = {};
  for (const f of FIELDS) {
    const label = document.createElement('label');
    label.style.cssText = 'font-size:0.75rem;color:var(--text-muted);margin:6px 0 -4px 0;display:block;';
    label.textContent = f.label;
    if (f.help) label.title = f.help;
    pop.append(label);
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = f.placeholder;
    input.value = cfg[f.id] || '';
    input.style.cssText = 'font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;font-size:0.78rem;';
    inputs[f.id] = input;
    pop.append(input);
  }

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'ckpt-save-btn';
  saveBtn.style.flex = '1';
  saveBtn.textContent = 'Save';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.style.cssText = 'padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:0.8rem;cursor:pointer;font-family:inherit;';
  clearBtn.textContent = 'Clear all';
  row.append(saveBtn, clearBtn);
  pop.append(row);

  saveBtn.addEventListener('click', () => {
    const next = {};
    for (const f of FIELDS) {
      const v = (inputs[f.id].value || '').trim();
      if (v) next[f.id] = v;
    }
    saveSiteConfig(next);
    pop.style.display = 'none';
  });
  clearBtn.addEventListener('click', () => {
    saveSiteConfig({});
    for (const id of Object.keys(inputs)) inputs[id].value = '';
  });

  const btn = document.getElementById('site-config-btn');
  if (btn) {
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.max(8, r.left) + 'px';
    pop.style.top = (r.bottom + 8) + 'px';
  }
  pop.style.display = 'flex';
}
