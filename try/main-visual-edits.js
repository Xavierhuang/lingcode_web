// main-visual-edits.js — Lovable-style visual edit side panel.
//
// Flow:
//   1. iframe inline-edit script posts `lc-element-picked` when an element
//      in the preview is clicked. We open the panel and populate fields.
//   2. User edits text / typography / colors → we postMessage
//      `lc-element-update` back to that iframe so the element updates live.
//   3. When the user closes the panel (or picks a different element), we
//      postMessage `lc-element-commit` so the iframe persists the change
//      as an `lc-inline-edit` (text only). Style edits are live-preview
//      until the next AI regeneration; the scoped AI chat sends them
//      back to the model with the element context.

let _activeSource = null;        // iframe Window that picked the element
let _activeFingerprint = null;
let _activeTag = '';
let _onAiChat = null;            // (prompt, fingerprint, tag) => void
let _enabled = false;            // whether visual-edits mode is on

const panel        = () => document.getElementById('visual-edits');
const closeBtn     = () => document.getElementById('ve-close');
const tagEl        = () => document.getElementById('ve-tag');
const textEl       = () => document.getElementById('ve-text');
const fontSizeEl   = () => document.getElementById('ve-font-size');
const fontWeightEl = () => document.getElementById('ve-font-weight');
const fontStyleEl  = () => document.getElementById('ve-font-style');
const textAlignEl  = () => document.getElementById('ve-text-align');
const colorEl      = () => document.getElementById('ve-color');
const bgEl         = () => document.getElementById('ve-bg');
const chatEl       = () => document.getElementById('ve-chat');
const chatSendEl   = () => document.getElementById('ve-chat-send');

function show() {
  const p = panel(); if (!p) return;
  p.hidden = false;
  p.setAttribute('aria-hidden', 'false');
}

function hide() {
  const p = panel(); if (!p) return;
  p.setAttribute('aria-hidden', 'true');
  // Keep in DOM after slide-out so the transition can replay next open.
  setTimeout(() => { if (p.getAttribute('aria-hidden') === 'true') p.hidden = true; }, 220);
}

function postToIframe(msg) {
  if (!_activeSource) return;
  try { _activeSource.postMessage(msg, '*'); } catch (_) {}
}

function commitAndClear() {
  postToIframe({ type: 'lc-element-commit' });
  _activeSource = null;
  _activeFingerprint = null;
  _activeTag = '';
}

function populate(data) {
  _activeFingerprint = data.fingerprint || null;
  _activeTag = data.tag || '';
  if (tagEl()) tagEl().textContent = data.tag ? `<${data.tag}>` : '—';
  if (textEl()) textEl().value = data.text || '';
  const s = data.styles || {};
  if (fontSizeEl())   fontSizeEl().value   = s.fontSize    || '';
  if (fontWeightEl()) fontWeightEl().value = matchOption(fontWeightEl(), s.fontWeight);
  if (fontStyleEl())  fontStyleEl().value  = matchOption(fontStyleEl(), s.fontStyle);
  if (textAlignEl())  textAlignEl().value  = matchOption(textAlignEl(), s.textAlign);
  if (colorEl())      colorEl().value      = s.color || '';
  if (bgEl())         bgEl().value         = (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)') ? s.backgroundColor : '';
  if (chatEl())       chatEl().value       = '';
}

function matchOption(selectEl, value) {
  if (!selectEl || !value) return '';
  for (const opt of selectEl.options) {
    if (opt.value && (opt.value === String(value) || value.includes(opt.value))) return opt.value;
  }
  return '';
}

function wireInputs() {
  textEl()?.addEventListener('input', () => {
    postToIframe({ type: 'lc-element-update', text: textEl().value });
  });
  const styleFields = [
    ['fontSize',       fontSizeEl],
    ['fontWeight',     fontWeightEl],
    ['fontStyle',      fontStyleEl],
    ['textAlign',      textAlignEl],
    ['color',          colorEl],
    ['backgroundColor', bgEl],
  ];
  for (const [prop, getter] of styleFields) {
    const el = getter();
    if (!el) continue;
    el.addEventListener('input', () => {
      const styles = {}; styles[prop] = el.value;
      postToIframe({ type: 'lc-element-update', styles });
    });
    el.addEventListener('change', () => {
      const styles = {}; styles[prop] = el.value;
      postToIframe({ type: 'lc-element-update', styles });
    });
  }
  chatSendEl()?.addEventListener('click', () => {
    const prompt = (chatEl()?.value || '').trim();
    if (!prompt || typeof _onAiChat !== 'function') return;
    _onAiChat(prompt, _activeFingerprint, _activeTag);
    chatEl().value = '';
  });
  closeBtn()?.addEventListener('click', () => {
    hide();
    commitAndClear();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const p = panel();
    if (!p || p.getAttribute('aria-hidden') !== 'false') return;
    hide();
    commitAndClear();
  });
}

function enableVisualEdits() {
  _enabled = true;
}

function disableVisualEdits() {
  _enabled = false;
  hide();
  commitAndClear();
}

/**
 * Toggle visual-edits mode on/off.
 * When on: clicking an element in the preview opens the style panel.
 * When off: the panel is hidden and element picks are ignored.
 * @returns {boolean} new enabled state
 */
export function toggleVisualEdits() {
  if (_enabled) disableVisualEdits();
  else enableVisualEdits();
  return _enabled;
}

export function mountVisualEdits({ onAiChat } = {}) {
  _onAiChat = typeof onAiChat === 'function' ? onAiChat : null;
  wireInputs();
  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type !== 'lc-element-picked') return;
    _activeSource = e.source;
    populate(d);
    // `forceShow` comes from previews where the toggle isn't reachable (the
    // design-style gate). Otherwise the panel only opens in visual-edits mode.
    if (_enabled || d.forceShow) show();
  });
}
