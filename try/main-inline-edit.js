// main-inline-edit.js — click-to-edit text content directly in the
// preview iframe, with edits that survive AI regenerations.
//
// FLOW:
//   1. injectInlineEditScript(html) wraps generated HTML with a small
//      script that listens for clicks on text-bearing elements (h1-h6,
//      p, li, a, button, span, em, strong with text-only children) and
//      makes them contenteditable. On blur it postMessages the edit
//      back to the parent: { type: 'lc-inline-edit', fingerprint, newText }.
//
//   2. The parent (main.js) routes the message to the right pane,
//      records the edit on pane._inlineEdits, and updates pane's
//      latest-rendered HTML so iframe re-renders preserve the change.
//
//   3. When the AI emits a NEW HTML (next turn), applyInlineEdits()
//      walks the new DOM and replays each stored edit. Elements are
//      matched by a structural CSS path FIRST, with a text-prefix
//      fallback for cases where the AI restructures markup. Edits that
//      can't be re-targeted are silently skipped (logged to console).
//
// LIMITS (be honest with users about these):
//   - Text-only edits. No styling, layout, or image swaps from this UI.
//   - If the AI rewrites a section heavily (e.g. swaps "Pricing" for
//     "Plans" + adds new tiers), the user's prior edit on that heading
//     may not re-target cleanly. Selector + text-prefix matching catches
//     ~80% of cases; the rest fall through silently.
//   - Edits clear when the user starts a fresh prototype (new turn 0).

const SCRIPT_MARKER = '__lc_inline_edit_v1';

// The script that runs INSIDE the preview iframe. Stringified so we can
// inject it. Pure DOM JS, no dependencies.
const INLINE_EDIT_SCRIPT = `
(function() {
  if (window.${SCRIPT_MARKER}) return;
  window.${SCRIPT_MARKER} = true;

  // Collab on/off flag — parent flips via postMessage { type:'lc-collab-state', active }.
  // Initially false so right-click shows the browser default menu for non-collab users.
  window.__LC_COLLAB__ = false;
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'lc-collab-state') {
      window.__LC_COLLAB__ = !!e.data.active;
    }
  });

  var SKIP_TAGS = new Set([
    'HTML', 'BODY', 'HEAD', 'SCRIPT', 'STYLE', 'NOSCRIPT',
    'IMG', 'SVG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME',
    'INPUT', 'TEXTAREA', 'SELECT', 'OPTION',
  ]);

  function isLeafText(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return false;
    var t = (el.textContent || '').trim();
    if (!t) return false;
    // Reject elements containing block-level children — editing them
    // collapses layout. Inline children (a, span, em, strong, etc.) are fine.
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      var disp = '';
      try { disp = window.getComputedStyle(child).display; } catch (_) {}
      if (disp && disp !== 'inline' && disp !== 'inline-block' && disp !== 'contents') {
        return false;
      }
    }
    return true;
  }

  // Compute a structural CSS-path selector + text-prefix fingerprint
  // for an element. The selector is precise; the prefix lets us
  // re-find the element after AI restructures the markup.
  function fingerprint(el) {
    var path = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
      var tag = cur.tagName.toLowerCase();
      var idx = 1;
      var sib = cur.previousElementSibling;
      while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
      path.unshift(tag + ':nth-of-type(' + idx + ')');
      cur = cur.parentElement;
    }
    return {
      selector: path.join('>'),
      tag: el.tagName.toLowerCase(),
      textPrefix: (el.textContent || '').trim().slice(0, 80),
    };
  }

  // Hover outline — subtle blue, only when over an editable leaf
  var hoverEl = null;
  // Throttle for collab cursor-presence postMessage (100ms)
  var lastCursorPostTs = 0;
  function postCursor(sel) {
    if (!window.__LC_COLLAB__) return; // skip when collab off — nobody listening
    var now = Date.now();
    if (now - lastCursorPostTs < 100) return;
    lastCursorPostTs = now;
    try { window.parent.postMessage({ type: 'lc-cursor-hover', selector: sel || null }, '*'); } catch (e) {}
  }
  document.addEventListener('mouseover', function(e) {
    var t = e.target;
    while (t && t.nodeType === 1 && !isLeafText(t)) t = t.parentElement;
    if (!t || t === hoverEl) return;
    if (hoverEl) hoverEl.style.outline = '';
    hoverEl = t;
    hoverEl.style.outline = '2px solid rgba(59,130,246,0.45)';
    hoverEl.style.outlineOffset = '1px';
    hoverEl.style.cursor = 'text';
    postCursor(fingerprint(t).selector);
  });
  document.addEventListener('mouseout', function(e) {
    if (hoverEl && !hoverEl.contains(e.relatedTarget)) {
      hoverEl.style.outline = '';
      hoverEl.style.cursor = '';
      hoverEl = null;
      postCursor(null);
    }
  });

  // Right-click on a text-bearing leaf → forward to parent so the collab
  // comment popover can open. Only intercepted when collab is active —
  // otherwise the browser's default context menu shows so users keep
  // right-click-to-copy and inspect-element on text.
  document.addEventListener('contextmenu', function(e) {
    if (!window.__LC_COLLAB__) return; // collab off — browser default menu
    var t = e.target;
    while (t && t.nodeType === 1 && !isLeafText(t)) t = t.parentElement;
    if (!t) return; // not a text leaf — let browser menu show
    e.preventDefault();
    var fp = fingerprint(t);
    var r = t.getBoundingClientRect();
    try {
      window.parent.postMessage({
        type: 'lc-contextmenu',
        selector: fp.selector,
        textPrefix: fp.textPrefix,
        iframeRect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      }, '*');
    } catch (e) {}
  }, true);

  // Notify parent when iframe content scrolls or resizes so collab comment
  // dots can reposition over their elements. Debounced 100ms.
  var scrollPostPending = false;
  function postScroll() {
    if (scrollPostPending) return;
    scrollPostPending = true;
    setTimeout(function() {
      scrollPostPending = false;
      try { window.parent.postMessage({ type: 'lc-iframe-scroll' }, '*'); } catch (e) {}
    }, 100);
  }
  window.addEventListener('scroll', postScroll, true);
  window.addEventListener('resize', postScroll);

  // Currently-picked element (so parent → iframe updates know which node to mutate).
  var _pickedEl = null;
  var _pickedOldText = '';
  var _pickedFingerprint = null;

  function clearPickHighlight() {
    if (_pickedEl) {
      _pickedEl.style.outline = '';
      _pickedEl.style.outlineOffset = '';
    }
  }

  function pickElement(t) {
    clearPickHighlight();
    _pickedEl = t;
    _pickedOldText = t.textContent;
    _pickedFingerprint = fingerprint(t);
    t.style.outline = '2px solid rgb(59,130,246)';
    t.style.outlineOffset = '2px';
    var cs = window.getComputedStyle(t);
    try {
      window.parent.postMessage({
        type: 'lc-element-picked',
        forceShow: window.__LC_FORCE_VE__ === true,
        fingerprint: _pickedFingerprint,
        tag: t.tagName.toLowerCase(),
        text: _pickedOldText,
        styles: {
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          fontStyle: cs.fontStyle,
          textAlign: cs.textAlign,
          color: cs.color,
          backgroundColor: cs.backgroundColor,
          margin: cs.margin,
          padding: cs.padding,
        },
        ts: Date.now(),
      }, '*');
    } catch (e) {}
  }

  // Apply updates from parent panel → iframe element.
  window.addEventListener('message', function(e) {
    var d = e.data || {};
    if (d.type === 'lc-element-update' && _pickedEl) {
      if (typeof d.text === 'string' && d.text !== _pickedEl.textContent) {
        _pickedEl.textContent = d.text;
      }
      if (d.styles && typeof d.styles === 'object') {
        for (var k in d.styles) {
          try { _pickedEl.style[k] = d.styles[k]; } catch (_) {}
        }
      }
    } else if (d.type === 'lc-element-commit' && _pickedEl) {
      var newText = _pickedEl.textContent;
      if (newText !== _pickedOldText) {
        try {
          window.parent.postMessage({
            type: 'lc-inline-edit',
            fingerprint: _pickedFingerprint,
            oldText: _pickedOldText,
            newText: newText,
            ts: Date.now(),
          }, '*');
        } catch (e) {}
      }
      clearPickHighlight();
      _pickedEl = null;
    } else if (d.type === 'lc-element-clear') {
      clearPickHighlight();
      _pickedEl = null;
    }
  });

  // Click → pick element + notify parent panel.
  document.addEventListener('click', function(e) {
    var t = e.target;
    while (t && t.nodeType === 1 && !isLeafText(t)) t = t.parentElement;
    if (!t) return;
    // Don't intercept link clicks unless the user holds Alt.
    if (t.tagName === 'A' && !e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    pickElement(t);
  }, true);
})();
`;

/**
 * Wrap HTML with the inline-edit script. Inserts at end of <body>.
 * @param {string} html
 * @param {{forcePanel?: boolean}} [opts] — when forcePanel is true, picked
 *   elements open the visual-edits panel regardless of the toggle state.
 *   Used by the design-style preview, where the toggle isn't reachable.
 * @returns {string}
 */
export function injectInlineEditScript(html, opts) {
  if (typeof html !== 'string' || !html) return html;
  const force = opts && opts.forcePanel ? `<script>window.__LC_FORCE_VE__=true;</script>` : '';
  const tag = force + `<script>${INLINE_EDIT_SCRIPT}</script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, tag + '</body>');
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, tag + '</html>');
  return html + tag;
}

// Apply a list of {fingerprint, newText} edits onto a fresh HTML string
// produced by an AI regeneration. Edits that can't be re-targeted are
// skipped (logged). Returns the modified HTML.
export function applyInlineEdits(html, edits) {
  if (typeof html !== 'string' || !html || !Array.isArray(edits) || edits.length === 0) return html;
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return html;
  }
  if (!doc || !doc.body) return html;
  let appliedCount = 0;
  for (const edit of edits) {
    if (!edit || !edit.fingerprint || typeof edit.newText !== 'string') continue;
    const target = _findElement(doc, edit.fingerprint);
    if (!target) {
      console.warn('[inline-edit] could not re-target', edit.fingerprint.selector, '— skipping');
      continue;
    }
    // Replace text content while preserving inline-formatting children.
    // Simplest: set textContent (drops inline children — acceptable for v1
    // since editable elements were already leaf-text).
    target.textContent = edit.newText;
    appliedCount += 1;
  }
  if (appliedCount === 0) return html;
  // Serialize back. Preserve doctype if the original had one.
  const serialized = doc.documentElement.outerHTML;
  const docType = html.match(/^\s*(<!doctype[^>]*>)/i);
  return (docType ? docType[1] + '\n' : '') + serialized;
}

// Try selector first, then text-prefix fallback if AI restructured markup.
function _findElement(doc, fp) {
  if (fp.selector) {
    try {
      const el = doc.querySelector(fp.selector);
      if (el) return el;
    } catch { /* malformed selector */ }
  }
  if (fp.tag && fp.textPrefix) {
    const candidates = doc.querySelectorAll(fp.tag);
    const prefix = fp.textPrefix.trim().slice(0, 40);
    if (!prefix) return null;
    for (const c of candidates) {
      const ct = (c.textContent || '').trim();
      if (ct.startsWith(prefix) || prefix.startsWith(ct.slice(0, 40))) return c;
    }
  }
  return null;
}

// System prompt addendum so the AI knows the user has been doing inline
// edits and shouldn't blindly overwrite their text changes.
export function inlineEditsSystemAddendum(edits) {
  if (!Array.isArray(edits) || edits.length === 0) return '';
  const lines = ['\n\nThe user has made these inline text edits to your previous output. Preserve them in your next response unless the user explicitly asks for different text:'];
  for (const e of edits.slice(-12)) { // cap to most recent 12 to keep prompt size sane
    lines.push(`- "${e.oldText.slice(0, 80)}" → "${e.newText.slice(0, 80)}"`);
  }
  return lines.join('\n');
}

// ── Collab extension ──────────────────────────────────────────────────────────
// enableCollabInlineEdits binds a Y.Map to pane._inlineEdits so remote edits
// from other collaborators propagate into the pane's edit history and trigger
// a preview re-render.

const _collabBindings = new Map(); // pane → { yMap, observer, updatePreview }

/**
 * @param {Y.Doc} yDoc
 * @param {object} pane — the pane object from main.js
 * @param {function(pane: object, immediate: boolean): void} updatePreviewFn
 */
export function enableCollabInlineEdits(yDoc, pane, updatePreviewFn) {
  if (!yDoc || !pane) return;
  const yMap = yDoc.getMap('inline-edits-map');

  const observer = (changes) => {
    changes.forEach((change, key) => {
      if (change.action === 'delete') return;
      const val = yMap.get(key);
      if (!val || typeof val.newText !== 'string') return;
      // Upsert into pane._inlineEdits (avoid duplicates by selector key)
      if (!Array.isArray(pane._inlineEdits)) pane._inlineEdits = [];
      const idx = pane._inlineEdits.findIndex(e => e.fingerprint && e.fingerprint.selector === key);
      if (idx >= 0) {
        pane._inlineEdits[idx] = { ...pane._inlineEdits[idx], newText: val.newText };
      } else {
        pane._inlineEdits.push({ fingerprint: { selector: key }, oldText: val.oldText || '', newText: val.newText });
      }
    });
    if (typeof updatePreviewFn === 'function') updatePreviewFn(pane, true);
  };

  yMap.observe(observer);
  _collabBindings.set(pane, { yMap, observer, updatePreviewFn });
}

/**
 * Write a local inline edit to the shared Y.Map so collaborators see it.
 * Called from main.js's lc-inline-edit postMessage handler.
 * @param {object} fingerprint
 * @param {string} newText
 * @param {string} oldText
 * @param {string} userId
 */
export function writeCollabInlineEdit(fingerprint, newText, oldText, userId) {
  for (const { yMap } of _collabBindings.values()) {
    if (!fingerprint || !fingerprint.selector) continue;
    yMap.set(fingerprint.selector, { newText, oldText, ts: Date.now(), userId });
  }
}

export function disableCollabInlineEdits(pane) {
  const binding = _collabBindings.get(pane);
  if (!binding) return;
  binding.yMap.unobserve(binding.observer);
  _collabBindings.delete(pane);
}
