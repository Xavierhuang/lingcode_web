// preview.js — extract HTML/CSS/JS code blocks from a pane and open a
// sandboxed iframe + editable code pane so the user can see AND tweak
// their prototype.
//
// Sandbox is `allow-scripts allow-modals allow-forms allow-popups` plus
// `allow-popups-to-escape-sandbox`. No `allow-same-origin` — iframe cannot
// read parent cookies/localStorage. postMessage from iframe→parent still
// works without `allow-same-origin`; we identify by event.source equality.

import { t } from './i18n.js?v=20260602d';
import { exportToPPTX } from './exporters.js?v=20260602d';

// ---- Supabase config (set from main.js; never sent to server) ----------
let _supabaseUrl = '';
let _supabaseAnonKey = '';

export function setSupabaseConfig(url, key) {
  _supabaseUrl = url || '';
  _supabaseAnonKey = key || '';
}

// ---- Extraction --------------------------------------------------------

const HTML_LANGS = new Set(['html', 'xhtml', 'liquid']);
const CSS_LANGS  = new Set(['css', 'scss', 'sass', 'less']);
const JS_LANGS   = new Set(['javascript', 'js', 'jsx', 'mjs', 'ecmascript']);

function langOf(codeEl) {
  const cls = codeEl.className || '';
  const m = cls.match(/language-([a-z0-9]+)/i);
  return m ? m[1].toLowerCase() : '';
}

export function extractFromScope(scope) {
  if (!scope) return null;
  const htmlBlocks = [];
  const cssBlocks  = [];
  const jsBlocks   = [];
  for (const code of scope.querySelectorAll('pre code')) {
    const lang = langOf(code);
    const text = code.innerText || code.textContent || '';
    if (!text.trim()) continue;
    if (HTML_LANGS.has(lang)) htmlBlocks.push(text);
    else if (CSS_LANGS.has(lang)) cssBlocks.push(text);
    else if (JS_LANGS.has(lang))  jsBlocks.push(text);
  }
  if (!htmlBlocks.length && !cssBlocks.length && !jsBlocks.length) return null;
  return assemble({ htmlBlocks, cssBlocks, jsBlocks });
}

export function extractRunnable(paneBodyEl) {
  if (!paneBodyEl) return null;
  const turns = paneBodyEl.querySelectorAll('.turn');
  if (!turns.length) return extractFromScope(paneBodyEl);
  // Scan turns newest→oldest and return the most recent one that actually
  // yields runnable HTML. The automatic "Final polish" turn (and ordinary
  // chat turns) can land as the last turn without re-emitting a full code
  // block; looking only at turns[last] would orphan the app built one turn
  // earlier — Expand/preview go dead even though the HTML exists. Falling back
  // to the latest turn that DOES contain HTML keeps the polished version when
  // present and the build output otherwise.
  for (let i = turns.length - 1; i >= 0; i--) {
    const html = extractFromScope(turns[i]);
    if (html) return html;
  }
  return null;
}

function assemble({ htmlBlocks, cssBlocks, jsBlocks }) {
  const css = cssBlocks.join('\n\n');
  const js  = jsBlocks.join('\n\n');

  const fullDocs = htmlBlocks.filter((h) => /<!doctype|<html\b/i.test(h));
  if (fullDocs.length) {
    let base = fullDocs.sort((a, b) => b.length - a.length)[0];
    if (css) {
      const styleTag = `<style>\n${css}\n</style>`;
      if (/<\/head>/i.test(base)) base = base.replace(/<\/head>/i, `${styleTag}\n</head>`);
      else base = styleTag + '\n' + base;
    }
    if (js) {
      const scriptTag = `<script>\n${js}\n</script>`;
      if (/<\/body>/i.test(base)) base = base.replace(/<\/body>/i, `${scriptTag}\n</body>`);
      else base = base + '\n' + scriptTag;
    }
    return base;
  }

  const bodyHtml = htmlBlocks.join('\n\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Preview</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; margin: 16px; }
${css}
</style>
</head>
<body>
${bodyHtml}
<script>
${js}
</script>
</body></html>`;
}

// In-memory localStorage / sessionStorage polyfill. The preview iframe is
// sandboxed without `allow-same-origin` (so a hostile prototype can't reach
// lingcode.dev cookies), which gives it an opaque origin. Real localStorage
// throws SecurityError in opaque origins, so vanilla TODO apps that use
// `localStorage.setItem(...)` blow up inside the preview. The shim makes
// such apps run for the duration of the preview session (data is lost on
// close — for persistence the user can click "Open in new window").
const STORAGE_POLYFILL_SCRIPT = `
<script>
(function(){
  function makeStore(){
    var m = new Map();
    var api = {
      get length(){ return m.size; },
      key: function(i){ return Array.from(m.keys())[i] || null; },
      getItem: function(k){ k = String(k); return m.has(k) ? m.get(k) : null; },
      setItem: function(k,v){ m.set(String(k), String(v)); },
      removeItem: function(k){ m.delete(String(k)); },
      clear: function(){ m.clear(); }
    };
    return new Proxy(api, {
      get: function(t,p){ return p in t ? t[p] : (m.has(String(p)) ? m.get(String(p)) : undefined); },
      set: function(t,p,v){ if (p in t) return false; m.set(String(p), String(v)); return true; },
      deleteProperty: function(t,p){ m.delete(String(p)); return true; }
    });
  }
  try { Object.defineProperty(window, 'localStorage',   { value: makeStore(), configurable: true }); } catch(e){}
  try { Object.defineProperty(window, 'sessionStorage', { value: makeStore(), configurable: true }); } catch(e){}
}());
</script>`;

// Inject a small script into the prototype that reports cmd/ctrl-clicked
// elements back to the parent. Only added when the modal is open so static
// previews + downloads stay clean.
const ELEMENT_PICKER_SCRIPT = `
<script>
(function(){
  if (window.__lingcodePicker) return;
  window.__lingcodePicker = true;
  let last = null;
  function clear() { if (last) { last.style.outline = ''; last.style.outlineOffset = ''; last = null; } }
  document.addEventListener('mousemove', (e) => {
    if (!(e.metaKey || e.ctrlKey)) { clear(); return; }
    if (e.target === last) return;
    clear();
    last = e.target;
    last.style.outline = '2px solid #00d084';
    last.style.outlineOffset = '1px';
  }, true);
  document.addEventListener('keyup', () => clear(), true);
  document.addEventListener('click', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.target;
    const html = (el.outerHTML || '').slice(0, 4000);
    parent.postMessage({ kind: 'lingcode-pick', outerHTML: html, tag: el.tagName.toLowerCase() }, '*');
    clear();
  }, true);
}());
</script>`;

// Top-level error reporter. The preview is a sandboxed iframe; if the model's
// generated JS throws or rejects unhandled, the page goes blank with no
// signal to the user. This script captures those errors and posts them out
// to the parent so we can show a "Fix with AI" banner. Kept narrow on
// purpose — does NOT report console.error / image 404s / network failures
// (too noisy; users would dismiss the banner more often than they'd use it).
const ERROR_REPORTER_SCRIPT = `
<script>
(function(){
  if (window.__lingcodeErrorReporter) return;
  window.__lingcodeErrorReporter = true;
  var seen = new Set();
  function report(kind, message, stack, source) {
    var key = kind + '|' + (message || '');
    if (seen.has(key)) return;  // dedupe within a single render
    seen.add(key);
    try {
      parent.postMessage({
        kind: 'lingcode-error',
        errorKind: kind,
        message: String(message || 'unknown error').slice(0, 800),
        stack: stack ? String(stack).slice(0, 4000) : '',
        source: String(source || ''),
      }, '*');
    } catch (e) {}
  }
  window.addEventListener('error', function(e){
    report('error', e.message, e.error && e.error.stack, e.filename);
  });
  window.addEventListener('unhandledrejection', function(e){
    var r = e.reason;
    var msg = (r && r.message) ? r.message : String(r);
    report('unhandledrejection', msg, r && r.stack, '');
  });
}());
</script>`;

// Tame horizontal bleed from hero decorations; viewport normalization (above)
// is the primary fix for mobile frame width — this mainly clips decorative
// off-canvas while allowing normal text to wrap via overflow-wrap.
const OVERFLOW_FIX_STYLE = `
<style>
  html, body { margin: 0; max-width: 100%; }
  body { overflow-x: hidden; overflow-wrap: anywhere; word-wrap: break-word; }
</style>`;

// Posts intrinsic document size so the parent can scale the iframe when fixed-
// width model output (e.g. 1280px slides) is wider than the preview column.
// Uses html + body maxima so layouts that collapse height onto <body> (common
// with min-height:100vh + flex hero) still measure correctly across viewport
// mode switches (Fluid vs fixed-width presets).
const IFRAME_METRICS_SCRIPT = `<script>(function(){
  function size(){
    if(window.parent===window)return;
    var d=document.documentElement;
    var b=document.body;
    var bw=b?Math.max(b.scrollWidth,b.clientWidth,0):0;
    var bh=b?Math.max(b.scrollHeight,b.offsetHeight||0,b.clientHeight||0,0):0;
    var w=Math.max(d.scrollWidth,d.clientWidth,bw);
    var h=Math.max(d.scrollHeight,d.clientHeight,bh);
    window.parent.postMessage({type:'__lc_ifrh',h:Math.max(200,Math.round(h)),w:Math.max(1,Math.round(w))},'*');
  }
  window.addEventListener('load',size);
  window.addEventListener('resize',size);
  if(typeof ResizeObserver!=='undefined'){
    new ResizeObserver(size).observe(document.documentElement);
    if(document.body)new ResizeObserver(size).observe(document.body);
  }
}());<\/script>`;

/** Ensures mobile-friendly layout inside sandboxed srcdoc iframes.
 *  Replaces *any* existing viewport meta — models often emit fixed widths
 *  (e.g. width=1280) which makes the document wider than our mobile/tablet
 *  frame; combined with body overflow-x:hidden the user only sees a clipped
 *  strip. Always normalize to device-width.
 *
 *  Also injects a small CSS shim that:
 *    - Caps html/body width to 100% so wide content can't bleed past the viewport
 *    - Forces overflow-x:auto on body so users can horizontally scroll if content
 *      genuinely needs more width than the preset (tablet/mobile) provides
 *  This makes the desktop/tablet/mobile preview presets render reliably for
 *  AI-generated pages that aren't fully responsive. */
export function ensureViewportMeta(html) {
  const s = String(html || '');
  const canon = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  const fitShim = `<style>html,body{max-width:100%!important;}body{overflow-x:auto;}img,video,iframe,table{max-width:100%;height:auto;}</style>`;
  const head = `${canon}\n${fitShim}`;
  const stripped = s.replace(
    /<meta(?=[^>]*\bname\s*=\s*["']viewport["'])[^>]*>/gi,
    ''
  );
  if (/<head\b[^>]*>/i.test(stripped)) {
    return stripped.replace(/<head\b[^>]*>/i, (m) => `${m}\n${head}`);
  }
  if (/<html\b[^>]*>/i.test(stripped)) {
    return stripped.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}</head><body>${stripped}</body></html>`;
}

function withInjections(html) {
  // 0. Viewport — must apply before any layout so narrow panes aren't zoom-cropped.
  // 1. Storage polyfill must run BEFORE any user script — inject as the
  //    first thing inside <head>. Falls through to prepending if there's
  //    no <head> tag.
  const supabaseGlobals = (_supabaseUrl && _supabaseAnonKey)
    ? `<script>window.SUPABASE_URL=${JSON.stringify(_supabaseUrl)};window.SUPABASE_ANON_KEY=${JSON.stringify(_supabaseAnonKey)};</script>`
    : '';
  let out = ensureViewportMeta(html);
  if (/<head\b[^>]*>/i.test(out)) {
    out = out.replace(/<head\b[^>]*>/i, (m) => `${m}\n${OVERFLOW_FIX_STYLE}\n${supabaseGlobals}\n${STORAGE_POLYFILL_SCRIPT}\n${ERROR_REPORTER_SCRIPT}`);
  } else if (/<html\b[^>]*>/i.test(out)) {
    out = out.replace(/<html\b[^>]*>/i, (m) => `${m}${OVERFLOW_FIX_STYLE}${supabaseGlobals}${STORAGE_POLYFILL_SCRIPT}${ERROR_REPORTER_SCRIPT}`);
  } else {
    out = OVERFLOW_FIX_STYLE + supabaseGlobals + STORAGE_POLYFILL_SCRIPT + ERROR_REPORTER_SCRIPT + out;
  }

  // 2. Element picker is a passive listener — append at end so user code
  //    runs first and the picker overlay sits on top of fully-loaded DOM.
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${IFRAME_METRICS_SCRIPT}\n${ELEMENT_PICKER_SCRIPT}\n</body>`);
  } else {
    out = out + IFRAME_METRICS_SCRIPT + ELEMENT_PICKER_SCRIPT;
  }
  return out;
}


// ---- Modal -------------------------------------------------------------

let modalEl = null;
// Element focus was on when the preview modal opened — restored on close so
// keyboard/AT users land back on the Expand button instead of page top.
let _modalReturnFocus = null;

function onModalIframeMetrics(ev) {
  if (!modalEl?.classList.contains('open') || ev.data?.type !== '__lc_ifrh') return;
  const main = modalEl.querySelector('.try-preview-frame');
  const cmp = modalEl.querySelector('.try-preview-frame-compare');
  let iframe = null;
  if (main && ev.source === main.contentWindow) iframe = main;
  else if (cmp && ev.source === cmp.contentWindow) iframe = cmp;
  if (!iframe) return;
  iframe._docW = Math.max(1, Math.round(Number(ev.data.w) || 0));
  iframe._contentH = Math.max(200, Math.round(Number(ev.data.h) || 0));
  layoutModalPreviewIframes();
}

/// Desktop / tablet / mobile presets: CSS fixes the frame *width* but the
/// iframe must use the srcdoc's scrollHeight as an explicit height — otherwise
/// height:100% only fills the viewport and the outer pane cannot scroll the
/// full page.
function layoutModalPresetViewports() {
  if (!modalEl || !modalEl.classList.contains('open')) return;
  const wrap = modalEl.querySelector('.try-preview-frame-wrap');
  if (!wrap) return;
  const vp = wrap.dataset.viewport;
  if (!vp || vp === 'fluid') return;

  const list = [];
  if (modalEl.classList.contains('compare-on')) {
    const c = modalEl.querySelector('.try-preview-frame-compare');
    if (c?.srcdoc) list.push(c);
  }
  const main = modalEl.querySelector('.try-preview-frame');
  if (main?.srcdoc) list.push(main);

  for (const iframe of list) {
    const h = iframe._contentH;
    if (h) {
      iframe.style.height = `${Math.round(h)}px`;
      iframe.style.flex = 'none';
    } else {
      iframe.style.removeProperty('height');
      iframe.style.removeProperty('flex');
    }
  }
}

function layoutModalPreviewIframes() {
  if (!modalEl || !modalEl.classList.contains('open')) return;
  const vp = modalEl.querySelector('.try-preview-frame-wrap')?.dataset.viewport;
  if (vp === 'fluid') {
    layoutModalFluidIframes();
    return;
  }
  layoutModalPresetViewports();
  nudgeModalIframeResize();
}

/** Prompt srcdoc to remeasure (tablet/mobile/desktop width changed). */
function nudgeModalIframeResize() {
  if (!modalEl) return;
  for (const sel of ['.try-preview-frame', '.try-preview-frame-compare']) {
    const f = modalEl.querySelector(sel);
    if (!f?.contentWindow || !f.srcdoc) continue;
    try {
      f.contentWindow.dispatchEvent(new Event('resize'));
    } catch {
      /* ignore */
    }
  }
}

function layoutModalFluidIframes() {
  if (!modalEl || !modalEl.classList.contains('open')) return;
  const wrap = modalEl.querySelector('.try-preview-frame-wrap');
  const inner = modalEl.querySelector('.try-preview-frame-inner');
  if (!inner || !wrap || wrap.dataset.viewport !== 'fluid') {
    if (inner) inner.style.removeProperty('min-height');
    return;
  }
  inner.style.removeProperty('min-height');

  const innerW = inner.clientWidth;
  if (!innerW) return;

  const list = [];
  if (modalEl.classList.contains('compare-on')) {
    const c = modalEl.querySelector('.try-preview-frame-compare');
    if (c?.srcdoc) list.push(c);
  }
  const main = modalEl.querySelector('.try-preview-frame');
  if (main?.srcdoc) list.push(main);

  const n = list.length;
  if (!n) return;
  const gap = modalEl.classList.contains('compare-on') && n > 1 ? 8 : 0;
  const slotW = Math.max(1, (innerW - gap * (n - 1)) / n);

  for (const iframe of list) {
    const colW = slotW;
    const docW = iframe._docW;
    const h = iframe._contentH;
    if (!docW || !h) continue;
    if (docW > colW + 2) {
      const s = colW / docW;
      iframe.style.width = docW + 'px';
      iframe.style.maxWidth = 'none';
      iframe.style.height = h + 'px';
      iframe.style.flex = 'none';
      iframe.style.removeProperty('margin-left');
      iframe.style.removeProperty('margin-right');
      iframe.style.removeProperty('align-self');
      iframe.style.transform = `scale(${s.toFixed(5)})`;
      iframe.style.transformOrigin = 'top center';
    } else {
      iframe.style.removeProperty('width');
      iframe.style.removeProperty('max-width');
      iframe.style.removeProperty('flex');
      iframe.style.removeProperty('transform');
      iframe.style.removeProperty('transform-origin');
      iframe.style.removeProperty('align-self');
      iframe.style.removeProperty('margin-left');
      iframe.style.removeProperty('margin-right');
      iframe.style.height = h + 'px';
    }
  }
}

function resetModalIframeFit(iframe) {
  if (!iframe) return;
  iframe._docW = 0;
  iframe._contentH = 0;
  iframe.style.removeProperty('width');
  iframe.style.removeProperty('height');
  iframe.style.removeProperty('max-width');
  iframe.style.removeProperty('margin-left');
  iframe.style.removeProperty('margin-right');
  iframe.style.removeProperty('flex');
  iframe.style.removeProperty('transform');
  iframe.style.removeProperty('transform-origin');
  iframe.style.removeProperty('align-self');
}
// Live-edited HTML (current iframe content).
let liveSrc = '';
// Snapshot of the currently-loaded turn's assembled HTML — Reset target.
let originalSrc = '';
// State for turn navigation.
let turnEls = [];
let turnIdx = 0;
let providerNameCache = '';
// Callback fired when the user submits an element-level refinement.
let onEditSubmitCb = null;
// Callback fired whenever the live editable HTML diverges from (or returns
// to) the original AI-generated turn. Lets main.js include the user's
// manual code edits in the next follow-up.
let onCodeEditCb = null;
// Callback fired when the user clicks "Fix with AI" on the preview-error
// banner. Receives { message, stack, source, errorKind, activeFile } and
// is expected to dispatch a follow-up turn through main.js's runFollowup.
let onAutoFixCb = null;
// Most recent unhandled error from the modal iframe — null when no banner
// is visible. Cleared on any new render (setIframe) and on banner dismiss.
let currentPreviewError = null;
// The pane body element the modal is currently associated with — used by
// maybeStreamUpdate() to decide whether an in-flight streaming text token
// belongs to the modal that's open right now.
let currentPaneBodyEl = null;
// Multi-file preview state — populated when the model emits multi-page
// websites via ```html name=index.html blocks. null in single-file mode.
let currentFiles = null;     // Map<filename, content> | null
let activeFile = null;       // string | null
let navHistory = [];         // visited files in chronological order
let navIdx = -1;             // current position in navHistory
// User-attached image assets keyed by relative path (e.g. assets/logo.png).
// Set on openPreview from opts.assets; consumed by every inlineSiblingFiles
// call AND every single-file setIframe so paths the model emitted resolve
// to the actual data URLs inside the sandboxed srcdoc.
let currentAssets = null;    // Map<path, { dataUrl, mimeType, sizeBytes }> | null
// Apply asset rewriting for single-file paths in the modal — wraps the raw
// HTML so we don't have to special-case every setIframe call site.
function applyAssets(html) {
  if (!currentAssets || currentAssets.size === 0) return html;
  return inlineSiblingFiles(html, null, currentAssets);
}
// Source prompt + provider context for the currently-open modal — used by
// the Save button to populate `source_prompt` and `provider_id` on the
// saved-prototype row.
let currentPrompt = '';
let currentProviderId = '';

// main.js registers a getter that returns the active pane's chat-history
// snapshot ({v,providerId,turns,history,system,tools}) so the ☆ Save / 🔗
// Short-link paths can persist it too — not just the Deploy path. Returns
// null when there's nothing to save.
let _chatHistorySnapshotFn = null;
export function setChatHistorySnapshotProvider(fn) { _chatHistorySnapshotFn = fn; }
// Returns a Promise<dataURL|null> screenshotting the live preview iframe
// (html2canvas). Lets the modal Save path reuse the same capture as Deploy.
let _liveThumbnailFn = null;
export function setLiveThumbnailProvider(fn) { _liveThumbnailFn = fn; }
// Auth state mirrored from main.js's checkEntitlement → setNavAuthState
// flow, dispatched as `lingcode:auth-changed`. Initial render assumes anon
// (safer default — flickers to "Save" once entitlement resolves, ~150ms).
let signedIn = false;
if (typeof window !== 'undefined') {
  window.addEventListener('lingcode:auth-changed', (e) => {
    signedIn = !!(e && e.detail && e.detail.signedIn);
    if (!modalEl) return;
    const saveBtn = modalEl.querySelector('[data-act="save"]');
    if (saveBtn && saveBtn.dataset.busy !== '1' && !saveBtn.classList.contains('saved')) {
      saveBtn.textContent = signedIn ? t('save.label') : t('save.signin');
    }
    // Short-link button label is constant — sign-in is handled inline at
    // click time. Just bail; no swap needed.
  });
}
export function pickInitialFile(filesMap) {
  if (!filesMap || filesMap.size === 0) return null;
  for (const candidate of ['index.html', 'index.htm', 'home.html']) {
    if (filesMap.has(candidate)) return candidate;
  }
  return filesMap.keys().next().value;
}

/** Map <a href> from the iframe to a key in filesMap (/ and ./ → entry page). */
export function resolveTryNavHref(href, filesMap) {
  if (!filesMap || filesMap.size === 0) return null;
  let pathPart = String(href || '').trim().split(/[?#]/)[0];
  pathPart = pathPart.replace(/^\.\//, '').replace(/^\/+/, '');
  while (pathPart.startsWith('../')) pathPart = pathPart.slice(3);
  if (!pathPart) return pickInitialFile(filesMap);
  if (filesMap.has(pathPart)) return pathPart;
  const slash = pathPart.lastIndexOf('/');
  const basename = slash >= 0 ? pathPart.slice(slash + 1) : pathPart;
  if (basename !== pathPart && filesMap.has(basename)) return basename;
  if (!pathPart.includes('.') && filesMap.has(`${pathPart}.html`)) return `${pathPart}.html`;
  const lower = pathPart.toLowerCase();
  if (filesMap.has(lower)) return lower;
  return null;
}

export function previewNavLooksLikeSiteRoot(href) {
  let pathPart = String(href || '').trim().split(/[?#]/)[0];
  pathPart = pathPart.replace(/^\.\//, '').replace(/^\/+/, '');
  while (pathPart.startsWith('../')) pathPart = pathPart.slice(3);
  return !pathPart || /^(index\.html|index\.htm|home\.html)$/i.test(pathPart);
}

function modalIframeForNavSource(win) {
  if (!modalEl?.classList.contains('open') || !win) return null;
  for (const sel of ['.try-preview-frame', '.try-preview-frame-compare']) {
    const f = modalEl.querySelector(sel);
    if (f?.contentWindow === win) return f;
  }
  return null;
}
// Inject a tiny click interceptor that postMessages to the parent so we
// can swap the iframe to a sibling file instead of letting the browser
// 404-navigate inside srcdoc.
export function withLinkInterceptor(html) {
  const script = `<script>(function(){document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a');if(!a)return;var h=a.getAttribute('href');if(!h||/^(https?:|mailto:|tel:|#|javascript:|data:|blob:)/i.test(h))return;e.preventDefault();parent.postMessage({type:'lingcode-nav',href:h},'*');});})();<\/script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, script + '</body>');
  return html + script;
}
// Models sometimes ignore the "inline all CSS" instruction and emit
// <link rel="stylesheet" href="styles.css"> across files. The iframe srcdoc
// has no base URL, so those 404. We inline any <link>/<script src> pointing
// at a sibling file from the multi-file Map before rendering. Same trick
// for <img src="logo.svg"> when the SVG was emitted as a separate file.
//
// `assets` (optional) is a Map<path, { dataUrl, mimeType }> of user-attached
// images exposed at deterministic paths (e.g. assets/logo.png). The model
// references them by path; we swap the path for the data URL here so they
// resolve inside srcdoc, which has no base URL to fetch them from.
function buildImportMapHtml(pkgJsonStr) {
  let pkg;
  try { pkg = JSON.parse(pkgJsonStr); } catch { return ''; }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.peerDependencies || {}) };
  if (!Object.keys(deps).length) return '';
  const imports = {};
  for (const [name, ver] of Object.entries(deps)) {
    const v = String(ver).replace(/^[\^~>=<v\s]+/, '').split(/[\s,|]+/)[0] || 'latest';
    imports[name] = `https://esm.sh/${name}@${v}`;
    imports[`${name}/`] = `https://esm.sh/${name}@${v}/`;
  }
  console.log('[importmap] injecting:', Object.keys(imports).filter(k => !k.endsWith('/')).map(k => `${k}@${imports[k].split('@').pop()}`).join(', '));
  return `<script type="importmap">${JSON.stringify({ imports })}</script>`;
}

export function inlineSiblingFiles(html, files, assets) {
  const f = files || new Map();
  const a = assets || new Map();
  if (f.size <= 1 && a.size === 0) return html;
  const pkgJson = f.get('package.json');
  if (pkgJson) {
    const importMapHtml = buildImportMapHtml(pkgJson);
    if (importMapHtml) {
      if (/<head\b[^>]*>/i.test(html)) {
        html = html.replace(/(<head\b[^>]*>)/i, `$1\n${importMapHtml}`);
      } else {
        html = importMapHtml + '\n' + html;
      }
    }
  }
  const norm = (h) => String(h || '').replace(/^\.?\/?/, '').split(/[?#]/)[0];
  // <link rel="stylesheet" href="…"> → <style>{contents}</style>
  let out = html.replace(
    /<link\b[^>]*?\bhref=(["'])([^"']+)\1[^>]*?>/gi,
    (full, _q, href) => {
      const target = norm(href);
      if (!f.has(target) || !/\.css$/i.test(target)) return full;
      return `<style data-inlined-from="${target}">${f.get(target)}</style>`;
    }
  );
  // <script src="…"></script> → <script>{contents}</script>
  out = out.replace(
    /<script\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*?)>\s*<\/script>/gi,
    (full, before, _q, src, after) => {
      const target = norm(src);
      if (!f.has(target) || !/\.(js|mjs)$/i.test(target)) return full;
      // Preserve type/module attribute; drop the src.
      const attrs = (before + after).replace(/\bsrc=(["'])[^"']+\1/gi, '').trim();
      return `<script ${attrs} data-inlined-from="${target}">${f.get(target)}</script>`;
    }
  );
  // <img src="…"> — three resolution paths:
  //   1. sibling SVG file → inline the <svg> markup (existing behavior)
  //   2. user-attached asset → swap path for data URL
  //   3. otherwise → leave the src alone
  out = out.replace(
    /<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*?)>/gi,
    (full, before, q, src, after) => {
      const target = norm(src);
      // 1: SVG sibling file inlining
      if (f.has(target) && /\.svg$/i.test(target)) {
        const content = f.get(target);
        if (/^\s*<svg/i.test(content)) {
          const attrs = (before + after).replace(/\bsrc=(["'])[^"']+\1/gi, '').trim();
          return content.replace(/^<svg\b/i, `<svg data-inlined-from="${target}" ${attrs}`);
        }
      }
      // 2: user-attached asset → data URL
      if (a.has(target)) {
        return `<img${before}src=${q}${a.get(target).dataUrl}${q}${after}>`;
      }
      return full;
    }
  );
  // <img srcset="…"> / <source srcset="…"> — swap each candidate URL whose
  // path matches an asset. Format: "url 1x, url2 2x" (descriptors optional).
  if (a.size > 0) {
    out = out.replace(
      /\bsrcset=(["'])([^"']+)\1/gi,
      (_full, q, val) => {
        const swapped = val.split(',').map((part) => {
          const m = part.trim().match(/^(\S+)(\s.*)?$/);
          if (!m) return part;
          const target = norm(m[1]);
          if (!a.has(target)) return part;
          return a.get(target).dataUrl + (m[2] || '');
        }).join(', ');
        return `srcset=${q}${swapped}${q}`;
      }
    );
    // CSS url(...) — covers <style>, inline style="…", inlined <link>
    out = out.replace(
      /url\(\s*(["']?)([^)"']+)\1\s*\)/gi,
      (full, q, ref) => {
        const target = norm(ref);
        if (!a.has(target)) return full;
        return `url(${q}${a.get(target).dataUrl}${q})`;
      }
    );
  }
  return out;
}
// Listen for nav requests from any open iframe — single registration.
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'lingcode-nav') return;
    const hrefRaw = String(d.href || '');
    if (currentFiles && currentFiles.size > 0) {
      const target = resolveTryNavHref(hrefRaw, currentFiles);
      if (target) switchActiveFile(target);
      return;
    }
    const modalIframe = modalIframeForNavSource(e.source);
    if (modalIframe && previewNavLooksLikeSiteRoot(hrefRaw)) {
      try {
        e.source.scrollTo({ top: 0, left: 0 });
      } catch {
        /* ignore — cross-origin iframe (shouldn't happen here) */
      }
    }
  });
}
function switchActiveFile(name, opts) {
  if (!currentFiles || !currentFiles.has(name)) return;
  activeFile = name;
  // Push to nav history unless caller passed { fromHistory: true } — that
  // flag is set by the back/forward arrows themselves so they don't double-
  // push and corrupt the stack.
  if (!opts || !opts.fromHistory) {
    // Truncate forward history when navigating after a back; this is the
    // standard browser behavior — clicking a link after pressing back loses
    // the forward path.
    navHistory = navHistory.slice(0, navIdx + 1);
    navHistory.push(name);
    navIdx = navHistory.length - 1;
  }
  const html = currentFiles.get(name);
  liveSrc = html;
  originalSrc = html;
  // Clear any prior error banner — switching files is a fresh render context.
  hidePreviewErrorBanner();
  if (modalEl) {
    const codeEl = modalEl.querySelector('.try-preview-code');
    if (codeEl && document.activeElement !== codeEl) codeEl.value = html;
    setIframe(inlineSiblingFiles(html, currentFiles, currentAssets));
    renderFileTabs();
  }
}
function navBack() {
  if (navIdx <= 0) return;
  navIdx--;
  switchActiveFile(navHistory[navIdx], { fromHistory: true });
}
function navForward() {
  if (navIdx >= navHistory.length - 1) return;
  navIdx++;
  switchActiveFile(navHistory[navIdx], { fromHistory: true });
}
function renderFileTabs() {
  if (!modalEl) return;
  const wrap = modalEl.querySelector('.try-preview-files');
  if (!wrap) return;
  if (!currentFiles || currentFiles.size <= 1) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  wrap.innerHTML = '';
  // Back / forward arrows — disabled at endpoints, mirror browser semantics.
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'try-preview-file-tab try-preview-file-nav';
  back.textContent = '←';
  back.title = 'Back';
  back.disabled = navIdx <= 0;
  back.addEventListener('click', navBack);
  wrap.append(back);
  const fwd = document.createElement('button');
  fwd.type = 'button';
  fwd.className = 'try-preview-file-tab try-preview-file-nav';
  fwd.textContent = '→';
  fwd.title = 'Forward';
  fwd.disabled = navIdx >= navHistory.length - 1;
  fwd.addEventListener('click', navForward);
  wrap.append(fwd);
  for (const name of currentFiles.keys()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'try-preview-file-tab' + (name === activeFile ? ' active' : '');
    btn.textContent = name;
    btn.addEventListener('click', () => switchActiveFile(name));
    wrap.append(btn);
  }
  // Right-aligned "Download as zip" — packages all files in one click.
  const spacer = document.createElement('span');
  spacer.style.cssText = 'flex:1';
  wrap.append(spacer);
  const zipBtn = document.createElement('button');
  zipBtn.type = 'button';
  zipBtn.className = 'try-preview-file-tab try-preview-file-zip';
  zipBtn.textContent = '💾 ' + t('preview.download_zip');
  zipBtn.addEventListener('click', async () => {
    try {
      const fs = await import('./fs.js?v=20260602d');
      await fs.downloadFilesAsZip(currentFiles, `lingcode-site-${Date.now()}.zip`);
    } catch (e) {
      alert('zip failed: ' + e.message);
    }
  });
  wrap.append(zipBtn);
}
function fireEditState() {
  if (onCodeEditCb) onCodeEditCb(liveSrc !== originalSrc ? liveSrc : null);
}
let renderDebounce = null;
// Side-by-side compare: when on, the modal shows two iframes — left = the
// turn before turnIdx (read-only), right = the live current turn (turnIdx).
// prev/next nav advances both together. Auto-disabled when only 1 turn.
let compareMode = false;

// Injected once. Lives here (not in try.html) so the markup stays
// localized to preview.js — touching CSS in two places (en + zh) was
// the kind of duplication this whole file is designed to avoid.
function ensureCompareCSS() {
  if (document.getElementById('try-compare-css')) return;
  const s = document.createElement('style');
  s.id = 'try-compare-css';
  s.textContent = `
    .try-preview-frame-compare {
      display: none;
      height: 100%; border: none; background: white;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
      min-width: 0;
      max-width: 100%;
    }
    .try-preview-modal.compare-on .try-preview-frame-inner {
      flex-direction: row; gap: 8px; align-items: flex-start;
    }
    .try-preview-modal.compare-on .try-preview-frame,
    .try-preview-modal.compare-on .try-preview-frame-compare {
      flex: 1 1 0;
      min-width: 0;
      min-height: 0;
    }
    .try-preview-modal.compare-on .try-preview-frame-wrap[data-viewport="desktop"] .try-preview-frame,
    .try-preview-modal.compare-on .try-preview-frame-wrap[data-viewport="desktop"] .try-preview-frame-compare,
    .try-preview-modal.compare-on .try-preview-frame-wrap[data-viewport="tablet"] .try-preview-frame,
    .try-preview-modal.compare-on .try-preview-frame-wrap[data-viewport="tablet"] .try-preview-frame-compare,
    .try-preview-modal.compare-on .try-preview-frame-wrap[data-viewport="mobile"] .try-preview-frame,
    .try-preview-modal.compare-on .try-preview-frame-wrap[data-viewport="mobile"] .try-preview-frame-compare {
      width: auto;
      max-width: none;
    }
    .try-preview-modal.compare-on .try-preview-frame-compare { display: block; }
    @media (max-width: 720px) {
      .try-preview-modal.compare-on .try-preview-frame-inner {
        flex-direction: column;
        align-items: stretch;
      }
      .try-preview-modal.compare-on .try-preview-frame,
      .try-preview-modal.compare-on .try-preview-frame-compare {
        flex: none;
        width: 100%;
        min-height: 0;
      }
    }
    .try-preview-modal .compare-toggle {
      position: relative;
    }
    .try-preview-modal .compare-toggle.active {
      background: rgba(0,208,132,0.18) !important;
      color: var(--signal) !important;
      border-color: rgba(0,208,132,0.35) !important;
    }
    .try-preview-modal .compare-toggle:disabled {
      opacity: 0.4; cursor: not-allowed;
    }
    /* Multi-file tab strip — only shown when the modal is rendering a
       multi-page website. Single-file mode keeps the modal unchanged. */
    .try-preview-files {
      display: flex; gap: 4px; padding: 8px 14px; flex-wrap: wrap;
      border-bottom: 1px solid var(--border);
      background: rgba(255,255,255,0.015);
    }
    .try-preview-file-tab {
      background: transparent; border: 1px solid transparent;
      padding: 4px 10px; border-radius: 6px;
      color: var(--text-muted); font-family: 'Geist Mono', monospace;
      font-size: 0.78rem; cursor: pointer;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
    }
    .try-preview-file-tab:hover { color: var(--text); background: rgba(255,255,255,0.04); }
    .try-preview-file-tab.active {
      background: rgba(0,208,132,0.16); color: var(--signal);
      border-color: rgba(0,208,132,0.35);
    }
    .try-preview-file-tab.try-preview-file-zip {
      font-family: 'Geist', sans-serif;
      color: var(--signal);
      border-color: rgba(0,208,132,0.35);
    }
    .try-preview-file-tab.try-preview-file-zip:hover {
      background: rgba(0,208,132,0.22); border-color: rgba(0,208,132,0.55);
    }
    .try-preview-file-tab.try-preview-file-nav {
      font-family: 'Geist', sans-serif; font-size: 0.875rem;
      padding: 4px 8px; min-width: 28px;
    }
    .try-preview-file-tab.try-preview-file-nav:disabled {
      opacity: 0.35; cursor: not-allowed;
    }
    .try-preview-file-tab.try-preview-file-nav:disabled:hover {
      background: transparent; color: var(--text-muted); border-color: transparent;
    }
    /* Auto-fix banner — sits above the iframe when the model's last output
       threw a top-level JS error, offers a one-click follow-up to fix it. */
    .try-preview-error {
      display: none; align-items: center; gap: 10px;
      padding: 8px 14px; margin: 0;
      background: rgba(255,90,90,0.08);
      border-bottom: 1px solid rgba(255,90,90,0.35);
      color: #ff8a8a; font-size: 0.82rem;
    }
    .try-preview-error.open { display: flex; }
    .try-preview-error .err-msg {
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-family: 'Geist Mono', monospace; font-size: 0.78rem;
    }
    .try-preview-error .err-fix {
      flex-shrink: 0; padding: 4px 12px; border-radius: 6px;
      background: var(--signal); color: white; border: 0;
      font-weight: 600; font-size: 0.78rem; cursor: pointer;
    }
    .try-preview-error .err-fix:hover { filter: brightness(1.1); }
    .try-preview-error .err-dismiss {
      flex-shrink: 0; padding: 4px 8px; border-radius: 6px;
      background: transparent; color: var(--text-muted); border: 1px solid var(--border);
      font-size: 0.78rem; cursor: pointer;
    }
    .try-preview-error .err-dismiss:hover { color: var(--text); border-color: var(--border-strong); }
  `;
  document.head.append(s);
}

function ensureModal() {
  if (modalEl) return modalEl;
  ensureCompareCSS();
  modalEl = document.createElement('div');
  modalEl.className = 'try-preview-modal';
  modalEl.setAttribute('role', 'dialog');
  modalEl.setAttribute('aria-modal', 'true');
  modalEl.setAttribute('aria-label', 'App preview');
  modalEl.innerHTML = `
    <div class="try-preview-backdrop"></div>
    <div class="try-preview-shell">
      <div class="try-preview-head">
        <span class="try-preview-title"></span>
        <div class="try-preview-turn-nav">
          <button type="button" class="turn-nav-btn" data-turn-act="prev" aria-label="Previous">‹</button>
          <span class="turn-nav-label"></span>
          <button type="button" class="turn-nav-btn" data-turn-act="next" aria-label="Next">›</button>
        </div>
        <div class="try-preview-view-toggle" role="tablist">
          <button type="button" class="view-mode" data-mode="code"></button>
          <button type="button" class="view-mode" data-mode="split"></button>
          <button type="button" class="view-mode" data-mode="preview"></button>
        </div>
        <div class="try-preview-actions">
          <button type="button" class="try-preview-btn" data-act="reset"></button>
          <button type="button" class="try-preview-btn primary-action" data-act="save"></button>
          <button type="button" class="try-preview-btn" data-act="shortlink"></button>
          <button type="button" class="try-preview-btn" data-act="github"></button>
          <button type="button" class="try-preview-btn" data-act="pptx"></button>
          <button type="button" class="try-preview-btn" data-act="open"></button>
          <button type="button" class="try-preview-close" data-act="close" aria-label="Close">×</button>
        </div>
      </div>
      <div class="try-preview-files" style="display:none"></div>
      <div class="try-preview-error">
        <span class="err-msg"></span>
        <button type="button" class="err-fix"></button>
        <button type="button" class="err-dismiss"></button>
      </div>
      <div class="try-preview-body" data-view="preview">
        <div class="try-preview-code-wrap">
          <textarea class="try-preview-code" spellcheck="false" wrap="off"></textarea>
        </div>
        <div class="try-preview-divider"></div>
        <div class="try-preview-frame-wrap" data-viewport="fluid">
          <div class="try-preview-viewport-bar">
            <div class="vp-left">
              <button type="button" class="viewport" data-vp="fluid"></button>
              <button type="button" class="viewport" data-vp="desktop"></button>
              <button type="button" class="viewport" data-vp="tablet"></button>
              <button type="button" class="viewport" data-vp="mobile"></button>
            </div>
            <span class="vp-edit-hint"></span>
          </div>
          <div class="try-preview-frame-inner">
            <iframe class="try-preview-frame-compare"
                    sandbox="allow-scripts allow-modals allow-forms allow-popups allow-popups-to-escape-sandbox"
                    title="Previous turn"></iframe>
            <iframe class="try-preview-frame"
                    sandbox="allow-scripts allow-modals allow-forms allow-popups allow-popups-to-escape-sandbox"
                    title="Current turn"></iframe>
          </div>
        </div>
      </div>
      <div class="try-preview-edit-overlay" data-open="false">
        <div class="edit-card">
          <div class="edit-head">
            <span class="edit-title"></span>
            <button type="button" class="edit-close" data-edit-act="cancel">×</button>
          </div>
          <pre class="edit-selection"></pre>
          <textarea class="edit-input" rows="3"></textarea>
          <div class="edit-actions">
            <button type="button" class="try-preview-btn" data-edit-act="cancel"></button>
            <button type="button" class="try-preview-btn primary" data-edit-act="send"></button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.append(modalEl);

  modalEl.querySelector('[data-mode="code"]').textContent    = t('preview.view_code');
  modalEl.querySelector('[data-mode="split"]').textContent   = t('preview.view_split');
  modalEl.querySelector('[data-mode="preview"]').textContent = t('preview.view_preview');
  modalEl.querySelector('[data-act="reset"]').textContent    = t('preview.reset_edits');
  modalEl.querySelector('[data-act="save"]').textContent     = signedIn ? t('save.label') : t('save.signin');
  modalEl.querySelector('[data-act="shortlink"]').textContent = t('shortlink.label');
  modalEl.querySelector('[data-act="github"]').textContent   = t('preview.save_github');
  modalEl.querySelector('[data-act="pptx"]').textContent     = t('preview.save_pptx');
  modalEl.querySelector('[data-act="open"]').textContent     = t('preview.open_window');
  modalEl.querySelector('[data-vp="fluid"]').textContent     = t('preview.viewport_fluid');
  modalEl.querySelector('[data-vp="desktop"]').textContent   = t('preview.viewport_desktop');
  modalEl.querySelector('[data-vp="tablet"]').textContent    = t('preview.viewport_tablet');
  modalEl.querySelector('[data-vp="mobile"]').textContent    = t('preview.viewport_mobile');
  modalEl.querySelector('.vp-edit-hint').textContent         = t('preview.edit_hint');
  modalEl.querySelector('.edit-title').textContent           = t('preview.edit_selection');
  modalEl.querySelector('[data-edit-act="cancel"].try-preview-btn').textContent = t('preview.edit_cancel');
  modalEl.querySelector('[data-edit-act="send"]').textContent = t('preview.edit_send');
  modalEl.querySelector('.edit-input').placeholder = t('preview.edit_placeholder');

  for (const btn of modalEl.querySelectorAll('.view-mode')) {
    btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
  }
  setViewMode('preview');

  for (const btn of modalEl.querySelectorAll('.viewport')) {
    btn.addEventListener('click', () => setViewport(btn.dataset.vp));
  }
  setViewport('fluid');

  modalEl.querySelector('[data-turn-act="prev"]').addEventListener('click', () => goToTurn(turnIdx - 1));
  modalEl.querySelector('[data-turn-act="next"]').addEventListener('click', () => goToTurn(turnIdx + 1));

  const codeEl = modalEl.querySelector('.try-preview-code');
  codeEl.addEventListener('input', () => {
    liveSrc = codeEl.value;
    if (renderDebounce) clearTimeout(renderDebounce);
    renderDebounce = setTimeout(() => { setIframe(liveSrc); }, 350);
    fireEditState();
  });

  modalEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('try-preview-backdrop')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (!modalEl.classList.contains('open')) return;
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key === 'Tab') trapModalTab(e);
  });

  // Listen for cmd/ctrl-click selection messages from inside the iframe.
  // Sandbox without allow-same-origin still permits postMessage; we identify
  // the sender by checking the iframe's contentWindow.
  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (!data || data.kind !== 'lingcode-pick') return;
    const iframe = modalEl.querySelector('.try-preview-frame');
    if (ev.source !== iframe.contentWindow) return;
    showEditOverlay(data);
  });

  // Listen for top-level errors from inside the iframe (window.onerror /
  // unhandledrejection) injected via ERROR_REPORTER_SCRIPT. Show the banner
  // only when the modal is open AND the error came from the active iframe
  // (postMessage source check) AND the parent isn't currently streaming a
  // new turn into this pane (signaled by main.js via setPreviewBusyForErrors).
  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (!data || data.kind !== 'lingcode-error') return;
    if (!modalEl || !modalEl.classList.contains('open')) return;
    const iframe = modalEl.querySelector('.try-preview-frame');
    if (ev.source !== iframe.contentWindow) return;
    if (previewBusyForErrors) return;  // suppress mid-stream noise
    showPreviewErrorBanner({
      message: data.message || 'unknown error',
      stack: data.stack || '',
      source: data.source || '',
      errorKind: data.errorKind || 'error',
      activeFile: activeFile || null,
    });
  });

  const errFix = modalEl.querySelector('.try-preview-error .err-fix');
  const errDismiss = modalEl.querySelector('.try-preview-error .err-dismiss');
  errFix.textContent = t('preview.error_fix_btn');
  errDismiss.textContent = t('preview.error_dismiss');
  errFix.addEventListener('click', () => {
    if (!currentPreviewError || !onAutoFixCb) { hidePreviewErrorBanner(); return; }
    const ctx = currentPreviewError;
    hidePreviewErrorBanner();
    try { onAutoFixCb(ctx); } catch {}
  });
  errDismiss.addEventListener('click', hidePreviewErrorBanner);

  modalEl.querySelector('[data-edit-act="cancel"].try-preview-btn').addEventListener('click', hideEditOverlay);
  modalEl.querySelector('[data-edit-act="cancel"].edit-close').addEventListener('click', hideEditOverlay);
  modalEl.querySelector('[data-edit-act="send"]').addEventListener('click', submitEditOverlay);
  modalEl.querySelector('.edit-input').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitEditOverlay(); }
  });

  // Monitor modal size changes (triggered by window resize since modal uses position: fixed)
  // to ensure the preview layout responds to viewport changes.
  const shell = modalEl.querySelector('.try-preview-shell');
  if (shell) {
    new ResizeObserver(() => {
      void shell.offsetHeight;
      layoutModalPreviewIframes();
    }).observe(shell);
  }

  window.addEventListener('message', onModalIframeMetrics);

  return modalEl;
}

function showPreviewErrorBanner(err) {
  if (!modalEl) return;
  currentPreviewError = err;
  const banner = modalEl.querySelector('.try-preview-error');
  if (!banner) return;
  banner.querySelector('.err-msg').textContent = t('preview.error_banner', err.message);
  banner.classList.add('open');
}

function hidePreviewErrorBanner() {
  currentPreviewError = null;
  if (!modalEl) return;
  const banner = modalEl.querySelector('.try-preview-error');
  if (banner) banner.classList.remove('open');
}

// main.js flips this true while a follow-up turn is streaming into the pane
// the modal is showing. While true, error postMessages from the iframe are
// ignored (partial HTML routinely throws — those errors are noise).
let previewBusyForErrors = false;
export function setPreviewBusyForErrors(busy) {
  previewBusyForErrors = !!busy;
  if (busy) hidePreviewErrorBanner();  // a new turn started — clear stale errors
}

// Inject the error reporter into a raw HTML string for inline (non-modal) previews.
// The modal path uses withInjections() which already includes ERROR_REPORTER_SCRIPT;
// inline previews use a lighter pipeline that skips withInjections.
export function injectErrorReporter(html) {
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, m => `${m}\n${ERROR_REPORTER_SCRIPT}`);
  return ERROR_REPORTER_SCRIPT + html;
}

function setViewMode(mode) {
  if (!modalEl) return;
  modalEl.querySelector('.try-preview-body').dataset.view = mode;
  for (const btn of modalEl.querySelectorAll('.view-mode')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }
  queueMicrotask(() => layoutModalPreviewIframes());
}

function setViewport(vp) {
  if (!modalEl) return;
  modalEl.querySelector('.try-preview-frame-wrap').dataset.viewport = vp;
  for (const btn of modalEl.querySelectorAll('.viewport')) {
    btn.classList.toggle('active', btn.dataset.vp === vp);
  }
  const inner = modalEl.querySelector('.try-preview-frame-inner');
  if (inner) inner.style.removeProperty('min-height');
  for (const sel of ['.try-preview-frame', '.try-preview-frame-compare']) {
    const f = modalEl.querySelector(sel);
    if (!f) continue;
    resetModalIframeFit(f);
  }
  const restyle = () => {
    nudgeModalIframeResize();
    layoutModalPreviewIframes();
  };
  queueMicrotask(() => {
    restyle();
    requestAnimationFrame(() => {
      restyle();
      requestAnimationFrame(restyle);
      setTimeout(restyle, 120);
    });
  });
}

function setIframe(src) {
  // Apply asset rewriting LAST so single-file callers don't each have to.
  // Multi-file callers (switchActiveFile, openPreview multi-file branch,
  // maybeStreamUpdateFiles) already pass currentAssets through
  // inlineSiblingFiles before reaching us; calling applyAssets again is a
  // no-op there because the asset paths have already been replaced with
  // data URLs that don't match the path regex.
  const iframe = modalEl.querySelector('.try-preview-frame');
  resetModalIframeFit(iframe);
  iframe.srcdoc = withInjections(withLinkInterceptor(applyAssets(src)));
}

function setCompareIframe(src) {
  if (!modalEl) return;
  const f = modalEl.querySelector('.try-preview-frame-compare');
  if (!f) return;
  resetModalIframeFit(f);
  f.srcdoc = src ? withInjections(withLinkInterceptor(applyAssets(src))) : '';
}

/// Toggle side-by-side compare. When `on`, loads the previous turn's
/// HTML into the left iframe; right iframe stays at the current turn.
/// Caller is responsible for ensuring turnIdx >= 1 (we no-op otherwise).
function setCompareMode(on) {
  if (!modalEl) return;
  if (on && (turnEls.length < 2 || turnIdx < 1)) return;
  compareMode = on;
  modalEl.classList.toggle('compare-on', on);
  const btn = modalEl.querySelector('[data-act="compare"]');
  if (btn) btn.classList.toggle('active', on);
  if (on) {
    const prevHtml = extractFromScope(turnEls[turnIdx - 1]);
    setCompareIframe(prevHtml || '');
  } else {
    setCompareIframe('');
  }
  queueMicrotask(() => layoutModalPreviewIframes());
}

// Keep Tab focus inside the open modal so keyboard/AT users can't tab into the
// page behind it. Cycles at the boundaries and pulls focus back if it drifted.
function trapModalTab(e) {
  const shell = modalEl.querySelector('.try-preview-shell');
  if (!shell) return;
  const focusable = Array.from(shell.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((el) => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (!shell.contains(active)) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}

function closeModal() {
  if (!modalEl) return;
  modalEl.classList.remove('open');
  // Restore focus to whatever opened the modal (the Expand button).
  if (_modalReturnFocus && typeof _modalReturnFocus.focus === 'function') {
    _modalReturnFocus.focus();
  }
  _modalReturnFocus = null;
  const inner = modalEl.querySelector('.try-preview-frame-inner');
  if (inner) inner.style.removeProperty('min-height');
  resetModalIframeFit(modalEl.querySelector('.try-preview-frame'));
  resetModalIframeFit(modalEl.querySelector('.try-preview-frame-compare'));
  modalEl.querySelector('.try-preview-frame').srcdoc = '';
  setCompareIframe('');
  setCompareMode(false);
  if (renderDebounce) { clearTimeout(renderDebounce); renderDebounce = null; }
  hideEditOverlay();
  hidePreviewErrorBanner();
  onEditSubmitCb = null;
  onAutoFixCb = null;
  currentPaneBodyEl = null;
  currentFiles = null;
  currentAssets = null;
  activeFile = null;
  navHistory = [];
  navIdx = -1;
  const fb = modalEl.querySelector('.try-preview-files');
  if (fb) { fb.style.display = 'none'; fb.innerHTML = ''; }
}

/// Live-update the modal's iframe + code editor with the current partial
/// HTML extracted from a pane that's still streaming. No-ops unless the
/// modal is open AND associated with the pane that's emitting tokens.
/// main.js calls this on each text event (throttled).
export function maybeStreamUpdate(paneBodyEl, partialHtml) {
  if (!modalEl || !modalEl.classList.contains('open')) return;
  if (currentPaneBodyEl !== paneBodyEl) return;
  // If the modal is in multi-file mode, ignore single-file updates — the
  // multi-file streamer handles them.
  if (currentFiles) return;
  if (!partialHtml || partialHtml === liveSrc) return;
  liveSrc = partialHtml;
  originalSrc = partialHtml;  // streaming output is the new "original"
  const codeEl = modalEl.querySelector('.try-preview-code');
  // Don't clobber what the user is actively typing in the code editor.
  if (codeEl && document.activeElement !== codeEl) {
    codeEl.value = partialHtml;
  }
  setIframe(partialHtml);
}

/// Live-update for multi-file streams. Called by main.js on each text
/// event when the parser detects ```html name=foo blocks. Adds new files
/// to the tab strip and refreshes the active file's iframe in place.
export function maybeStreamUpdateFiles(paneBodyEl, filesMap) {
  if (!modalEl || !modalEl.classList.contains('open')) return;
  if (currentPaneBodyEl !== paneBodyEl) return;
  if (!filesMap || filesMap.size === 0) return;
  if (!currentFiles) currentFiles = new Map();
  let tabsChanged = false;
  let activeChanged = false;
  for (const [name, content] of filesMap) {
    const prior = currentFiles.get(name);
    if (prior === content) continue;
    if (prior === undefined) tabsChanged = true;
    currentFiles.set(name, content);
    if (name === activeFile) activeChanged = true;
  }
  if (!activeFile && currentFiles.size > 0) {
    activeFile = pickInitialFile(currentFiles);
    if (navHistory.length === 0) { navHistory = [activeFile]; navIdx = 0; }
    activeChanged = true;
    tabsChanged = true;
  }
  if (tabsChanged) renderFileTabs();
  if (activeChanged && activeFile) {
    const html = currentFiles.get(activeFile) || '';
    liveSrc = html;
    originalSrc = html;
    const codeEl = modalEl.querySelector('.try-preview-code');
    if (codeEl && document.activeElement !== codeEl) codeEl.value = html;
    setIframe(inlineSiblingFiles(html, currentFiles, currentAssets));
  }
}

function updateTurnNav() {
  const nav = modalEl.querySelector('.try-preview-turn-nav');
  if (turnEls.length <= 1) { nav.style.display = 'none'; return; }
  nav.style.display = '';
  const label = compareMode
    ? t('preview.compare_label', turnIdx, turnIdx + 1, turnEls.length)
    : t('preview.turn_label', turnIdx + 1, turnEls.length);
  modalEl.querySelector('.turn-nav-label').textContent = label;
  modalEl.querySelector('[data-turn-act="prev"]').disabled = turnIdx === (compareMode ? 1 : 0);
  modalEl.querySelector('[data-turn-act="next"]').disabled = turnIdx === turnEls.length - 1;
  // Compare requires at least 2 turns AND not being on the first turn.
  const compareBtn = modalEl.querySelector('[data-act="compare"]');
  if (compareBtn) compareBtn.disabled = turnEls.length < 2;
}

function goToTurn(idx) {
  if (idx < 0 || idx >= turnEls.length) return;
  const html = extractFromScope(turnEls[idx]);
  if (!html) return;  // turn has no runnable code; ignore
  turnIdx = idx;
  originalSrc = html;
  liveSrc = html;
  modalEl.querySelector('.try-preview-code').value = html;
  setIframe(html);
  fireEditState();
  // In compare mode, keep the left iframe one turn behind the right.
  if (compareMode) {
    if (turnIdx < 1) {
      setCompareMode(false);
    } else {
      setCompareIframe(extractFromScope(turnEls[turnIdx - 1]) || '');
    }
  }
  updateTurnNav();
}

// ---- Public: openPreview -----------------------------------------------

/// Opens the preview modal. Call shapes include:
///   openPreview({ paneBodyEl, ... })                      ← DOM turns with fenced code
///   openPreview({ html, paneBodyEl?, ... })            ← assembled doc when sidebar hides fences
///   openPreview({ files, paneBodyEl?, ... })           ← multi-file
///   openPreview({ html, providerName })                 ← URL share only
/// onEditSubmit is invoked when the user submits a cmd-click refinement.
/// onCodeEdit is invoked with the edited HTML (or null when clean) so the
/// pane can include manual code edits in the next follow-up.
export function openPreview(opts) {
  const m = ensureModal();
  providerNameCache = opts.providerName || '';
  currentPrompt = opts.sourcePrompt || '';
  currentProviderId = opts.providerId || '';
  onEditSubmitCb = opts.onEditSubmit || null;
  onCodeEditCb = opts.onCodeEdit || null;
  onAutoFixCb = opts.onAutoFix || null;
  hidePreviewErrorBanner();  // any prior session's error is stale on re-open
  // User-attached image assets for this modal session — paths the model
  // referenced (assets/logo.png) get rewritten to data URLs at render time.
  currentAssets = (opts.assets && opts.assets.size > 0) ? new Map(opts.assets) : null;
  // Reset the Save + Short-link buttons to idle labels on every open — a
  // previous session might have left them as "✓ Saved" / "✓ Copied".
  const saveBtnInit = m.querySelector('[data-act="save"]');
  if (saveBtnInit) {
    saveBtnInit.classList.remove('saved');
    saveBtnInit.disabled = false;
    saveBtnInit.dataset.busy = '0';
    saveBtnInit.textContent = signedIn ? t('save.label') : t('save.signin');
  }
  const shortBtnInit = m.querySelector('[data-act="shortlink"]');
  if (shortBtnInit) {
    shortBtnInit.classList.remove('saved');
    shortBtnInit.disabled = false;
    shortBtnInit.dataset.busy = '0';
    shortBtnInit.textContent = t('shortlink.label');
  }

  m.querySelector('.try-preview-title').textContent = providerNameCache
    ? `${t('preview.title')} — ${providerNameCache}`
    : t('preview.title');

  // Default to preview-only on every open. Code/Split are opt-in via the
  // header chips — clicking "Preview" should mean "show me the rendered
  // thing," not "show me the rendered thing next to a code editor."
  setViewMode('preview');

  // Multi-file path. opts.files is a Map<filename, content> emitted by the
  // model via ```html name=index.html blocks. Render a tab strip; clicking
  // a tab swaps the iframe to that file. Internal <a href="page.html"> nav
  // is intercepted via postMessage and re-routed to switchActiveFile.
  if (opts.files && opts.files.size > 0) {
    currentPaneBodyEl = opts.paneBodyEl || null;
    currentFiles = new Map(opts.files);
    turnEls = [];
    turnIdx = 0;
    activeFile = pickInitialFile(currentFiles);
    navHistory = activeFile ? [activeFile] : [];
    navIdx = activeFile ? 0 : -1;
    const html = currentFiles.get(activeFile) || '';
    originalSrc = html;
    liveSrc = html;
    m.querySelector('.try-preview-code').value = html;
    setIframe(inlineSiblingFiles(html, currentFiles, currentAssets));
    renderFileTabs();
  } else if (opts.html != null && String(opts.html).trim()) {
    // Explicit HTML wins over paneBody DOM — tabbed /try can hide fenced blocks
    // in the sidebar while preview still uses accumulatedMd-as-markdown.
    currentPaneBodyEl = opts.paneBodyEl || null;
    turnEls = [];
    turnIdx = 0;
    originalSrc = opts.html;
    liveSrc = opts.html;
    m.querySelector('.try-preview-code').value = opts.html;
    setIframe(opts.html);
  } else if (opts.paneBodyEl) {
    currentPaneBodyEl = opts.paneBodyEl;
    turnEls = Array.from(opts.paneBodyEl.querySelectorAll('.turn'))
                  .filter((tEl) => extractFromScope(tEl));
    if (!turnEls.length) { showEmptyPreview(); return; }
    turnIdx = turnEls.length - 1;
    const html = extractFromScope(turnEls[turnIdx]);
    originalSrc = html;
    liveSrc = html;
    m.querySelector('.try-preview-code').value = html;
    setIframe(html);
  } else {
    return;
  }
  updateTurnNav();
  _modalReturnFocus = document.activeElement;
  m.classList.add('open');
  // Move focus into the dialog (close button) so keyboard/AT users start inside
  // it; the Tab trap keeps them there until close restores focus.
  const _closeBtn = m.querySelector('[data-act="close"]');
  requestAnimationFrame(() => { try { _closeBtn?.focus(); } catch { /* no-op */ } });

  // Wire action buttons each open — simpler than tracking handler state.
  m.querySelector('[data-act="reset"]').onclick = () => {
    if (liveSrc !== originalSrc && !confirm(t('preview.reset_confirm'))) return;
    liveSrc = originalSrc;
    m.querySelector('.try-preview-code').value = originalSrc;
    setIframe(originalSrc);
    fireEditState();
  };
  m.querySelector('[data-act="open"]').onclick = () => {
    const blob = new Blob([liveSrc], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const pptxBtn = m.querySelector('[data-act="pptx"]');
  pptxBtn.onclick = async () => {
    if (pptxBtn.dataset.busy === '1') return;
    pptxBtn.dataset.busy = '1';
    const orig = pptxBtn.textContent;
    pptxBtn.textContent = t('preview.exporting');
    pptxBtn.disabled = true;
    try {
      // Rewrite asset paths to data URLs first — exportToPPTX spins up its
      // own iframe with no asset map, so <img src="assets/logo.png"> would
      // 404 there. PDF export goes through the live preview iframe whose
      // srcdoc already has assets applied, so it doesn't need this dance.
      await exportToPPTX(applyAssets(liveSrc));
    } catch (err) {
      alert(t('preview.export_failed') + ' ' + err.message);
    } finally {
      pptxBtn.dataset.busy = '0';
      pptxBtn.textContent = orig;
      pptxBtn.disabled = false;
    }
  };
  // Save current liveSrc to the user's account. Stores the base64 share
  // payload (~1.5KB/row) so the saved row is portable across SHARE_KEY
  // rotations. Anon users get bounced to /signin?next=/try.html on click.
  const saveBtn = m.querySelector('[data-act="save"]');
  saveBtn.onclick = () => saveToAccount(saveBtn);
  const shortBtn = m.querySelector('[data-act="shortlink"]');
  shortBtn.onclick = () => shortenLink(shortBtn);

  // Save current liveSrc to the user's GitHub as a gist. First click
  // triggers an OAuth popup; subsequent clicks save directly. Each save
  // creates a new gist (gist's own revision history serves as tags).
  const githubBtn = m.querySelector('[data-act="github"]');
  githubBtn.onclick = () => saveToGitHub(githubBtn);

  m.querySelector('[data-act="close"]').onclick = closeModal;
}

export function showEmptyPreview() {
  alert(t('preview.empty'));
}

// ---- URL hash share ----------------------------------------------------
// Encodes the prototype HTML into the URL hash. No backend involved —
// recipient's browser decodes on load.
//
// Two formats coexist:
//   #gp=<base64-of-gzip>   v2 (default)  — ~6-8x smaller than raw base64
//   #p=<base64>            v1 (legacy)   — kept for old shared URLs
// readSharedHTML tries gp= first, falls back to p=. URLs in the wild
// (chats, emails, bookmarks) keep working forever.

const SHARE_KEY_V1 = 'p';
const SHARE_KEY_V2 = 'gp';
export const SHARE_VERSION_CURRENT = 2;
// Raw single-file HTML cap before gzip. Large apps gzip well under the server's
// hard ceiling and big payloads are offloaded server-side to the cloud Postgres
// blob store (so they no longer bloat the control-plane SQLite).
const SHARE_MAX = 16 * 1024 * 1024;
// Modern browsers expose CompressionStream natively (Chrome 80+, Safari
// 16.4+, Firefox 113+). Older browsers fall back to v1 raw base64.
const HAS_GZIP = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

function utf8ToB64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

// Gzip a string + base64-encode. Returns the base64 payload.
async function utf8ToB64Gzip(str) {
  const enc = new TextEncoder().encode(str);
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(enc); writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  // Concatenate chunks into one Uint8Array, then convert to base64.
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  // btoa on a binary string — process in 16K slices so we don't blow the
  // String.fromCharCode arg limit on large blobs.
  let bin = '';
  for (let i = 0; i < merged.length; i += 16_384) {
    bin += String.fromCharCode.apply(null, merged.subarray(i, i + 16_384));
  }
  return btoa(bin);
}

// Inverse: base64 → gzip-decode → utf8 string.
async function b64GzipToUtf8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(u8); writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return new TextDecoder().decode(merged);
}

// Compute and return the share-link payload (base64) using the current
// encoding version. Used by Save flows that store the payload server-side.
export async function buildSharePayload(html) {
  if (!html || html.length > SHARE_MAX) return null;
  if (!HAS_GZIP) {
    // Legacy fallback for browsers without CompressionStream.
    try { return { payload: utf8ToB64(html), version: 1 }; } catch { return null; }
  }
  try { return { payload: await utf8ToB64Gzip(html), version: SHARE_VERSION_CURRENT }; }
  catch { return null; }
}

// Multi-file save payload (v3): encodes ALL files in the current project
// as a JSON `{files, initial}` blob → gzip+base64. The /p/<id> server
// route knows v3 means multi-file and renders the wrapper page that lets
// internal `<a href="other.html">` clicks navigate inside the iframe.
// Falls back to single-file (v2) when only one file exists or browser has
// no gzip support. activeFile may be overridden via opts.activeFile, and
// activeFileHtml lets the caller substitute liveSrc (user-edited current
// file) for the snapshot in the files map.
export async function buildMultiFileSharePayload(filesMap, opts) {
  if (!filesMap || filesMap.size === 0) return null;
  if (filesMap.size === 1) {
    // Only one file — fall back to single-file save (smaller, simpler).
    const only = [...filesMap.values()][0];
    return buildSharePayload((opts && opts.activeFileHtml) || only);
  }
  if (!HAS_GZIP) return null;
  const filesObj = {};
  for (const [name, content] of filesMap) filesObj[name] = content;
  const activeFile = (opts && opts.activeFile) || pickInitialFile(filesMap);
  if (opts && opts.activeFileHtml && activeFile && filesObj[activeFile] !== undefined) {
    filesObj[activeFile] = opts.activeFileHtml;
  }
  const json = JSON.stringify({ files: filesObj, initial: activeFile });
  // Large multi-file payloads are offloaded server-side (cloud Postgres blob
  // store); the hard server ceiling is ~8MB compressed.
  try {
    const payload = await utf8ToB64Gzip(json);
    if (payload.length > 7_500_000) return null;
    return { payload, version: 3 };
  } catch { return null; }
}

// Build a fully-formed share URL (with #gp= or #p= depending on version).
// Async because gzip is async.
export async function buildShareURL(html) {
  const built = await buildSharePayload(html);
  if (!built) return null;
  const key = built.version >= 2 ? SHARE_KEY_V2 : SHARE_KEY_V1;
  const base = `${location.origin}${location.pathname}`;
  return `${base}#${key}=${encodeURIComponent(built.payload)}`;
}

/// Reads the URL hash on page load. Returns the decoded HTML or null.
/// Tries v2 (gp=) first, falls back to v1 (p=) for backward compat.
export async function readSharedHTML() {
  const h = location.hash;
  if (!h) return null;
  // v2: gp=<base64-gzip>
  if (HAS_GZIP) {
    const m2 = h.match(new RegExp(`(?:^#|&)${SHARE_KEY_V2}=([^&]+)`));
    if (m2) {
      try { return await b64GzipToUtf8(decodeURIComponent(m2[1])); }
      catch { /* fall through to v1 attempt */ }
    }
  }
  // v1: p=<base64-raw>
  const m1 = h.match(new RegExp(`(?:^#|&)${SHARE_KEY_V1}=([^&]+)`));
  if (m1) {
    try { return b64ToUtf8(decodeURIComponent(m1[1])); }
    catch { return null; }
  }
  return null;
}

// ---- Element-level edit overlay ---------------------------------------

function showEditOverlay(pick) {
  const overlay = modalEl.querySelector('.try-preview-edit-overlay');
  overlay.dataset.open = 'true';
  overlay.dataset.selection = pick.outerHTML;
  modalEl.querySelector('.edit-selection').textContent = pick.outerHTML;
  const input = modalEl.querySelector('.edit-input');
  input.value = '';
  input.focus();
}

function hideEditOverlay() {
  if (!modalEl) return;
  const overlay = modalEl.querySelector('.try-preview-edit-overlay');
  overlay.dataset.open = 'false';
}

function submitEditOverlay() {
  const overlay = modalEl.querySelector('.try-preview-edit-overlay');
  const input = modalEl.querySelector('.edit-input');
  const userRequest = input.value.trim();
  if (!userRequest) return;
  const selection = overlay.dataset.selection || '';
  hideEditOverlay();
  if (typeof onEditSubmitCb === 'function') {
    onEditSubmitCb({ selection, userRequest });
  }
}

// Chat history should be *conversation text*, not a copy of the whole app in
// every turn. The build transcript stores each turn's full generated HTML
// (often 100s of KB) twice (turn markdown + raw history), so an elaborate build
// balloons to tens of MB. Truncate large fenced code blocks to a stub — the
// live code already rides in share_payload, so "Continue editing" memory is
// unaffected; this keeps the history light enough to actually preserve.
function _slimCodeText(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/```[\s\S]*?```/g, (block) =>
    block.length > 1500 ? block.slice(0, 200) + '\n… [' + (block.length - 200) + ' chars of code omitted] …\n```' : block);
}
function slimChatHistory(snap) {
  if (!snap || typeof snap !== 'object') return snap;
  const out = { ...snap };
  if (Array.isArray(snap.turns)) {
    out.turns = snap.turns.map((t) => (t && typeof t === 'object') ? { ...t, accumulatedMd: _slimCodeText(t.accumulatedMd) } : t);
  }
  if (Array.isArray(snap.history)) {
    out.history = snap.history.map((m) => {
      if (!m || typeof m !== 'object') return m;
      if (typeof m.content === 'string') return { ...m, content: _slimCodeText(m.content) };
      if (Array.isArray(m.content)) return { ...m, content: m.content.map((b) => (b && typeof b === 'object' && typeof b.text === 'string') ? { ...b, text: _slimCodeText(b.text) } : b) };
      return m;
    });
  }
  return out;
}

// Publish a prototype from the inline pane (no modal state required).
// Serialize the saved-prototype POST body so it fits under the server's body
// limit (SAVE_BODY_BUDGET, just under the 16mb express.json cap). The thumbnail
// is a live html2canvas screenshot — for canvas-heavy apps/games it can be
// several MB and is the most expendable field, so shed it first, then the chat
// history; only the (already-capped) share_payload is essential. Without this a
// big thumbnail balloons the body and 413s at the edge ("http_413") instead of
// degrading gracefully.
const SAVE_BODY_BUDGET = 15 * 1024 * 1024;
function fitSavedPrototypeBody(fields) {
  let body = fields;
  let str = JSON.stringify(body);
  if (str.length <= SAVE_BODY_BUDGET) return str;
  if (body.thumbnail) { body = { ...body, thumbnail: null }; str = JSON.stringify(body); if (str.length <= SAVE_BODY_BUDGET) return str; }
  if (body.chat_history) { body = { ...body, chat_history: null }; str = JSON.stringify(body); if (str.length <= SAVE_BODY_BUDGET) return str; }
  throw Object.assign(new Error('too_large'), { code: 'too_large' });
}

// Builds the share payload, POSTs to /api/account/saved-prototypes, and
// returns { id, url }. Throws with a .code property on all expected failures
// (unauthorized, rate_limited, cap_reached, too_large) — caller handles UI.
export async function publishPrototypeFrom({ html, files, prompt, providerId, chatHistory, thumbnail: thumbOverride, activePrototypeId }) {
  let built;
  if (files && files.size > 1) {
    built = await buildMultiFileSharePayload(files, {});
  } else {
    if (!html) throw Object.assign(new Error('no_content'), { code: 'no_content' });
    built = await buildSharePayload(html);
  }
  if (!built) throw Object.assign(new Error('too_large'), { code: 'too_large' });
  const { payload, version: shareVersion } = built;
  const title = buildTitleFromPrompt(prompt || '');
  // Live-preview screenshot from the caller (html2canvas in the iframe's
  // own window context — captures JS-driven content with correct fonts).
  // No foreignObject fallback: it rendered with broken text metrics and
  // huge whitespace bands, producing thumbnails worse than the dashboard's
  // gradient placeholder. Null here → server stores null → placeholder UI.
  const thumbnail = thumbOverride || null;
  // Encode the optional chat-history JSON (already shaped by the caller).
  // Skip if missing / encoding fails — save still succeeds without history.
  let encodedChatHistory = null;
  if (chatHistory && typeof chatHistory === 'object') {
    try {
      encodedChatHistory = await utf8ToB64Gzip(JSON.stringify(slimChatHistory(chatHistory)));
    } catch (_) { encodedChatHistory = null; }
  }
  // Cap at the server's CHAT_HISTORY_B64_MAX (350KB) — an oversized history
  // would push the request past the edge body limit and 413 before the route
  // can trim it. Save proceeds without history rather than failing.
  if (encodedChatHistory && encodedChatHistory.length > 350 * 1024) encodedChatHistory = null;
  // Update in place when we already own this prototype's id (PUT, reuses the id
  // so a bound backend/secrets/collab survive) — otherwise create (POST).
  const updating = !!activePrototypeId;
  // Data-loss guard: never overwrite an existing saved project with a near-empty
  // extraction. A real prototype is always KBs of HTML; a sub-1KB body on an
  // UPDATE means the live preview failed to produce runnable content (e.g. a
  // reopened project whose preview was blank). Saving that would clobber the good
  // share_payload — which is exactly how a project's game once got destroyed.
  if (updating) {
    const rawLen = (files && files.size)
      ? [...files.values()].reduce((n, c) => n + (c ? c.length : 0), 0)
      : (html ? html.length : 0);
    if (rawLen < 1024) {
      throw Object.assign(
        new Error("This project's preview looks empty — saving now would overwrite your saved version. Reopen it and wait for the app to load before saving."),
        { code: 'content_too_small' }
      );
    }
  }
  const r = await fetch('/api/account/saved-prototypes', {
    method: updating ? 'PUT' : 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: fitSavedPrototypeBody({
      ...(updating ? { id: activePrototypeId } : {}),
      title, share_payload: payload, share_version: shareVersion,
      source_prompt: prompt || null, provider_id: providerId || null, thumbnail,
      chat_history: encodedChatHistory,
    }),
  });
  if (r.status === 401) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
  if (r.status === 429) throw Object.assign(new Error('rate_limited'), { code: 'rate_limited' });
  if (r.status === 409) {
    const body = await r.json().catch(() => ({}));
    throw Object.assign(new Error('cap_reached'), { code: 'cap_reached', oldest: body.oldest });
  }
  if (!r.ok) throw new Error('http_' + r.status);
  const j = await r.json();
  return { id: j.id, url: `${location.origin}/p/${j.id}` };
}

/// Called by main.js after a follow-up turn completes — re-extract the
/// latest turn so the modal reflects the model's response. Keeps the modal
/// open as a "live workspace" instead of forcing a re-open.
export function refreshFromLatestTurn(paneBodyEl) {
  if (!modalEl || !modalEl.classList.contains('open')) return;
  const all = Array.from(paneBodyEl.querySelectorAll('.turn')).filter((tEl) => extractFromScope(tEl));
  if (!all.length) return;
  turnEls = all;
  turnIdx = all.length - 1;
  const html = extractFromScope(turnEls[turnIdx]);
  originalSrc = html;
  liveSrc = html;
  modalEl.querySelector('.try-preview-code').value = html;
  setIframe(html);
  updateTurnNav();
}

// ---- Save to GitHub ----------------------------------------------------
// First-time flow opens an OAuth popup, then auto-retries the save once
// the popup posts back 'github-connected'. Subsequent saves go straight
// through. Errors surface as alerts — no toast system to lean on.

// Trim a prompt into a Lovable-style title: drop "Build a/Make me a/Create"
// prefixes, soft-trim at last word boundary before 50 chars, hard-cap 60.
function buildTitleFromPrompt(prompt) {
  if (!prompt) return 'Untitled prototype';
  let t = String(prompt).trim()
    .replace(/^(build( a| me a| me an)?|make( a| me a| me an)?|create( a| me a| me an)?|design( a| me a| me an)?|generate( a| me a| me an)?|write( a| me a| me an)?)\s+/i, '');
  // Strip leading articles left over after the prefix strip.
  t = t.replace(/^(the|an|a)\s+/i, '');
  // First sentence only.
  const firstSentence = t.split(/[.\n!?]/)[0].trim();
  if (firstSentence) t = firstSentence;
  if (t.length > 60) {
    const cut = t.slice(0, 50);
    const lastSpace = cut.lastIndexOf(' ');
    t = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + '…';
  }
  // Capitalize first letter.
  if (t) t = t[0].toUpperCase() + t.slice(1);
  return t || 'Untitled prototype';
}

// Module cache: map a payload string → its saved row id. Lets the Save
// button and the Short-link button share work — a Short-link click after
// a Save (with no edits in between) reuses the same row instead of
// creating a duplicate, which would burn through the 50-cap.
let _lastSavedPayload = '';
let _lastSavedId = '';

// (Removed: SVG-foreignObject `captureThumbnail` fallback. It rendered text
// with broken metrics — italic glyphs at wrong x-positions, missing word-
// spacing — and couldn't run scripts, producing huge white bands for
// JS-driven prototypes. The live-iframe html2canvas path in main.js
// `captureLiveThumbnail` now owns all capture; null → server-side gradient
// placeholder, which is a better worst case than the foreignObject artifact.)

// Shared POST flow for both ☆ Save and 🔗 Short link. Handles auth,
// payload building, 409 cap-reached confirm-and-evict retry, 401/429.
// Returns { id, payloadCacheHit } on success, or null on auth-bounce / abort.
// Throws on unrecoverable error (caller alerts).
async function _persistToAccount() {
  if (!signedIn) {
    sessionStorage.setItem('lingcode.next', '/try.html');
    window.location.href = '/signin.html?next=/try.html';
    return null;
  }
  // Multi-file: bundle ALL files (v3 JSON payload) so the short link opens
  // the whole project, not just the active page. activeFileHtml carries the
  // user's in-editor edits if they tweaked the current file.
  let built;
  if (currentFiles && currentFiles.size > 1) {
    built = await buildMultiFileSharePayload(currentFiles, {
      activeFile,
      activeFileHtml: liveSrc,
    });
  } else {
    const html = liveSrc;
    if (!html) return null;
    built = await buildSharePayload(html);
  }
  if (!built) {
    const err = new Error('too_large');
    err.code = 'too_large';
    throw err;
  }
  const payload = built.payload;
  const shareVersion = built.version;

  // Cache hit — same payload was just saved this session, reuse the id.
  if (_lastSavedPayload === payload && _lastSavedId) {
    return { id: _lastSavedId, payloadCacheHit: true };
  }

  const title = buildTitleFromPrompt(currentPrompt);
  // Live-preview screenshot (html2canvas in the iframe). Null falls through
  // to server-side placeholder UI — better than the old foreignObject fallback
  // which produced broken text + whitespace bands.
  let thumbnail = null;
  try { thumbnail = _liveThumbnailFn ? await _liveThumbnailFn() : null; } catch (_) { thumbnail = null; }
  // Persist chat history too (parity with Deploy) so reopening restores model
  // memory. Best-effort: skip on missing snapshot / encode failure.
  let chat_history = null;
  try {
    const snap = _chatHistorySnapshotFn && _chatHistorySnapshotFn();
    if (snap && typeof snap === 'object') chat_history = await utf8ToB64Gzip(JSON.stringify(slimChatHistory(snap)));
  } catch (_) { chat_history = null; }
  // Drop a chat history bigger than the server accepts (CHAT_HISTORY_B64_MAX,
  // 350KB). Otherwise the whole request balloons past the body limit and 413s
  // at the edge before the route can trim it — saving still works without it.
  if (chat_history && chat_history.length > 350 * 1024) chat_history = null;
  // Shed an oversized thumbnail/history so a canvas-game screenshot can't 413
  // the request; throws too_large only if the payload itself is over budget.
  const postBody = fitSavedPrototypeBody({
    title, share_payload: payload, share_version: shareVersion,
    source_prompt: currentPrompt, provider_id: currentProviderId,
    thumbnail, chat_history,
  });
  let r = await fetch('/api/account/saved-prototypes', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: postBody,
  });
  if (r.status === 409) {
    const body = await r.json().catch(() => null);
    const oldestTitle = (body && body.oldest && body.oldest.title) || '?';
    if (!window.confirm(t('save.cap_reached_body', oldestTitle))) {
      const err = new Error('cancelled');
      err.code = 'cancelled';
      throw err;
    }
    const oldestId = body.oldest.id;
    const del = await fetch(`/api/account/saved-prototypes/${encodeURIComponent(oldestId)}`, {
      method: 'DELETE', credentials: 'same-origin',
    });
    if (!del.ok) throw new Error('delete_oldest_failed');
    r = await fetch('/api/account/saved-prototypes', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: postBody,
    });
  }
  if (r.status === 401) {
    sessionStorage.setItem('lingcode.next', '/try.html');
    window.location.href = '/signin.html?next=/try.html';
    return null;
  }
  if (r.status === 429) {
    const err = new Error('rate_limited');
    err.code = 'rate_limited';
    throw err;
  }
  if (!r.ok) throw new Error('http_' + r.status);
  const j = await r.json();
  _lastSavedPayload = payload;
  _lastSavedId = j.id;
  return { id: j.id, payloadCacheHit: false };
}

async function saveToAccount(btn) {
  if (btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  const orig = btn.textContent;
  btn.textContent = '…';
  try {
    const result = await _persistToAccount();
    if (!result) { btn.textContent = orig; btn.dataset.busy = '0'; return; }
    btn.classList.add('saved');
    btn.textContent = t('save.saved');
    setTimeout(() => {
      btn.classList.remove('saved');
      btn.textContent = signedIn ? t('save.label') : t('save.signin');
      btn.dataset.busy = '0';
    }, 2500);
  } catch (err) {
    btn.textContent = orig;
    btn.dataset.busy = '0';
    if (err.code === 'cancelled') return;
    if (err.code === 'too_large') {
      btn.disabled = true;
      btn.title = t('save.too_large');
      btn.textContent = t('save.too_large');
      return;
    }
    if (err.code === 'rate_limited') { alert(t('save.rate_limited')); return; }
    alert(t('save.error') + ' ' + (err && err.message ? err.message : 'unknown'));
  }
}

async function shortenLink(btn) {
  if (btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  const orig = btn.textContent;
  btn.textContent = '…';
  try {
    const result = await _persistToAccount();
    if (!result) { btn.textContent = orig; btn.dataset.busy = '0'; return; }
    const url = `${location.origin}/p/${result.id}`;
    try { await navigator.clipboard.writeText(url); }
    catch { window.prompt(t('shortlink.label'), url); }
    btn.classList.add('saved');
    btn.textContent = t('shortlink.copied');
    setTimeout(() => {
      btn.classList.remove('saved');
      btn.textContent = t('shortlink.label');
      btn.dataset.busy = '0';
    }, 2500);
  } catch (err) {
    btn.textContent = orig;
    btn.dataset.busy = '0';
    if (err.code === 'cancelled') return;
    if (err.code === 'too_large') {
      btn.disabled = true;
      btn.title = t('save.too_large');
      btn.textContent = t('save.too_large');
      return;
    }
    if (err.code === 'rate_limited') { alert(t('save.rate_limited')); return; }
    alert(t('shortlink.error') + ' ' + (err && err.message ? err.message : 'unknown'));
  }
}

export async function saveToGitHub(btn) {
  const original = btn.textContent;
  const setLabel = (s) => { btn.textContent = s; };
  const restore = () => { btn.textContent = original; btn.classList.remove('copied'); };

  // Nothing to save yet. Bail with a quick visible hint instead of POSTing an
  // empty gist that the server would happily create.
  if (!liveSrc) {
    setLabel('No preview yet');
    setTimeout(restore, 1600);
    return;
  }

  setLabel(t('preview.gh_checking'));
  let status;
  try {
    const r = await fetch('/api/github/status', { credentials: 'same-origin' });
    if (r.status === 401) {
      restore();
      alert(t('preview.gh_signin_first'));
      return;
    }
    if (r.status === 404) {
      // Most likely cause: API service hasn't been restarted with the new
      // routes. Tell the operator clearly so they don't chase ghosts.
      restore();
      alert('Server route /api/github/status not found (404). The lingcode-api service may need a restart.');
      return;
    }
    if (r.status === 503) {
      restore();
      alert('GitHub OAuth is not configured on the server. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to /opt/lingcode-api/.env, then restart lingcode-api.');
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    status = await r.json();
  } catch (e) {
    restore();
    alert(t('preview.gh_unreachable') + ' (' + (e?.message || e) + ')');
    return;
  }

  if (!status?.connected) {
    setLabel(t('preview.gh_authorizing'));
    try {
      await openGithubOAuthPopup();
    } catch (e) {
      restore();
      alert(t('preview.gh_authorize_failed'));
      return;
    }
  }

  setLabel(t('preview.gh_saving'));
  let saved;
  try {
    const r = await fetch('/api/github/save-gist', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: liveSrc,
        filename: 'prototype.html',
        description: providerNameCache
          ? `LingCode prototype — ${providerNameCache} — ${new Date().toISOString().slice(0, 10)}`
          : `LingCode prototype — ${new Date().toISOString().slice(0, 10)}`,
        public: false,
      }),
    });
    saved = await r.json();
    if (!r.ok || !saved?.ok) throw new Error(saved?.message || saved?.error || 'save_failed');
  } catch (e) {
    restore();
    alert(t('preview.gh_save_failed') + '\n\n' + (e?.message || e));
    return;
  }

  // Success — show confirmation + open in new tab.
  btn.textContent = t('preview.gh_saved');
  btn.classList.add('copied');
  setTimeout(() => restore(), 2200);
  window.open(saved.url, '_blank', 'noopener,noreferrer');
}

function openGithubOAuthPopup() {
  return new Promise((resolve, reject) => {
    const w = 700, h = 760;
    const left = Math.max(0, (screen.width - w) / 2);
    const top  = Math.max(0, (screen.height - h) / 2);
    const popup = window.open(
      '/api/github/oauth/start',
      'lingcode-github-oauth',
      `width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`
    );
    if (!popup) { reject(new Error('popup_blocked')); return; }
    let resolved = false;
    const onMsg = (ev) => {
      if (!ev.data || typeof ev.data !== 'object') return;
      if (ev.data.kind === 'github-connected') {
        resolved = true;
        cleanup();
        resolve(ev.data.username || '');
      } else if (ev.data.kind === 'github-error') {
        resolved = true;
        cleanup();
        reject(new Error(ev.data.message || 'oauth_error'));
      }
    };
    const closedTimer = setInterval(() => {
      if (popup.closed && !resolved) { cleanup(); reject(new Error('popup_closed')); }
    }, 500);
    const cleanup = () => {
      window.removeEventListener('message', onMsg);
      clearInterval(closedTimer);
    };
    window.addEventListener('message', onMsg);
  });
}
