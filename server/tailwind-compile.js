'use strict';

// tailwind-compile.js — replace CDN Tailwind script in published HTML
// with an inline <style> containing only the classes the page actually
// uses. ~3MB of CDN CSS → ~5-30KB of compiled CSS, depending on how many
// utility classes the page touches.
//
// Triggered from saved-prototypes.js POST when the
// TAILWIND_COMPILE_ON_PUBLISH env var is set. Defensive — any failure
// path returns the original HTML unchanged so a botched compile never
// corrupts a saved prototype.
//
// What it handles:
//   - <script src="https://cdn.tailwindcss.com"> with optional ?plugins= / ?v= query
//   - Inline tailwind.config = {...} customizations (extracted via sandboxed vm.runInContext)
//   - Multiple HTML blobs in a v3 multi-file payload (caller iterates per file)
//
// What it does NOT handle (safe-passes through unchanged):
//   - CDN script that uses ?plugins= for tailwindcss-animate etc.
//     (we'd need to install matching plugin packages; deferred to v2)
//   - HTML where the inline tailwind.config has function values
//     (require() / arbitrary JS) — sandbox eval throws, falls back to default theme

const vm = require('node:vm');

const CDN_SCRIPT_RE = /<script\s+src=["']https:\/\/cdn\.tailwindcss\.com[^"']*["'][^>]*><\/script>\s*/gi;
const INLINE_CONFIG_RE = /<script[^>]*>\s*tailwind\.config\s*=\s*(\{[\s\S]*?\});?\s*<\/script>\s*/gi;
const HEAD_OPEN_RE = /<head\b[^>]*>/i;

function _hasCdnTailwind(html) {
  return /cdn\.tailwindcss\.com/.test(html);
}

// Pull out the inline `tailwind.config = {...}` object via vm sandbox.
// The sandbox has only a stub `tailwind` global — no require, no process,
// no fs. timeout=100ms limits runaway code. Returns null on any error so
// the caller can fall back to the default Tailwind theme.
function _extractInlineConfig(html) {
  const m = html.match(/tailwind\.config\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i);
  if (!m) return null;
  try {
    const ctx = { tailwind: {} };
    vm.createContext(ctx);
    vm.runInContext(`tailwind.config = ${m[1]};`, ctx, { timeout: 100 });
    return ctx.tailwind.config && typeof ctx.tailwind.config === 'object' ? ctx.tailwind.config : null;
  } catch {
    return null;
  }
}

// Strip the CDN script + any inline tailwind.config block from HTML.
function _removeTailwindCdn(html) {
  return html
    .replace(CDN_SCRIPT_RE, '')
    .replace(INLINE_CONFIG_RE, '');
}

// Inject a <style> block right after <head>. Falls back to prepending
// to the document if no <head> tag is found (rare but possible for
// fragments).
function _injectStyle(html, cssBlock) {
  const styleTag = `<style data-tailwind-compiled>${cssBlock}</style>`;
  if (HEAD_OPEN_RE.test(html)) {
    return html.replace(HEAD_OPEN_RE, (m) => `${m}\n${styleTag}`);
  }
  return styleTag + html;
}

/**
 * Compile Tailwind for the given HTML. Returns the optimized HTML, or
 * the original HTML unchanged if anything goes wrong.
 *
 * @param {string} html
 * @returns {Promise<{ html: string, compiled: boolean, originalSize: number, finalSize: number, error?: string }>}
 */
async function compileTailwindIfPresent(html) {
  if (typeof html !== 'string' || html.length === 0) {
    return { html, compiled: false, originalSize: 0, finalSize: 0 };
  }
  const originalSize = Buffer.byteLength(html, 'utf8');
  if (!_hasCdnTailwind(html)) {
    return { html, compiled: false, originalSize, finalSize: originalSize };
  }

  let tailwindcss, postcss;
  try {
    tailwindcss = require('tailwindcss');
    postcss = require('postcss');
  } catch (err) {
    return { html, compiled: false, originalSize, finalSize: originalSize, error: 'tailwindcss/postcss not installed' };
  }

  const userConfig = _extractInlineConfig(html);
  const config = {
    content: [{ raw: html, extension: 'html' }],
    // Sensible defaults that match the templates we ship; user config below overrides.
    darkMode: ['class'],
    ...(userConfig || {}),
    // Force content to be the html string regardless of what userConfig says
    // (otherwise a copied-over `content: ['./src/**/*']` from a real Vite project
    // would point at a missing filesystem path)
    content: [{ raw: html, extension: 'html' }],
  };

  try {
    const result = await postcss([
      tailwindcss(config),
    ]).process('@tailwind base;\n@tailwind components;\n@tailwind utilities;', {
      from: undefined,
    });
    const css = result.css;
    if (!css || css.length === 0) {
      return { html, compiled: false, originalSize, finalSize: originalSize, error: 'compile produced empty CSS' };
    }

    // Sanity cap on compiled CSS size — if Tailwind emitted >500KB of
    // CSS, something likely went wrong (config matched no content and
    // shipped the full utilities bundle, or content extraction failed).
    // The doc itself grows on inline because we're trading a 3MB CDN
    // runtime download for inline CSS, so doc-size deltas are NOT the
    // right signal — only absolute compiled-CSS size is.
    if (Buffer.byteLength(css, 'utf8') > 500_000) {
      return { html, compiled: false, originalSize, finalSize: originalSize, error: `compiled CSS too large (${(Buffer.byteLength(css, 'utf8') / 1024).toFixed(0)}KB)` };
    }

    const stripped = _removeTailwindCdn(html);
    const finalHtml = _injectStyle(stripped, css);
    const finalSize = Buffer.byteLength(finalHtml, 'utf8');

    return { html: finalHtml, compiled: true, originalSize, finalSize, cssSize: Buffer.byteLength(css, 'utf8') };
  } catch (err) {
    return { html, compiled: false, originalSize, finalSize: originalSize, error: err.message || 'compile failed' };
  }
}

module.exports = {
  compileTailwindIfPresent,
  // test seams
  _hasCdnTailwind,
  _extractInlineConfig,
  _removeTailwindCdn,
};
