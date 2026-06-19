// collab-presence.js — live avatar strip + cursor awareness for collab rooms.
// Renders a floating strip of user initials circles positioned above the preview
// pane. Updates in real-time via the Yjs awareness protocol.

import { sendRoomEvent } from './collab.js';

// Deterministic color from a user ID string
function userColor(userId) {
  const COLORS = ['#7c3aed','#db2777','#0284c7','#059669','#d97706','#dc2626','#7c3aed','#0891b2'];
  let h = 0;
  for (let i = 0; i < (userId || '').length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

const MAX_VISIBLE_AVATARS = 5;
let _awareness = null;
let _stripEl = null;
let _iframeParent = null;
let _cursorOverlay = null;
let _cursorIframe = null;

/**
 * @param {import('y-protocols/awareness').Awareness} awareness
 * @param {{ id: string, email: string }} currentUser
 */
export function initPresence(awareness, currentUser) {
  if (!awareness) return;
  _awareness = awareness;

  const name = currentUser.email ? currentUser.email.split('@')[0] : 'You';
  const initials = getInitials(name);
  awareness.setLocalStateField('lc', {
    name,
    initials,
    color: userColor(currentUser.id),
    userId: currentUser.id,
    activeSelector: null,
  });
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Mount the avatar strip relative to a preview iframe's parent container.
 * @param {HTMLIFrameElement} iframe
 */
export function mountPresenceOverlay(iframe) {
  if (!iframe || !_awareness) return;

  // Parent that contains the iframe
  _iframeParent = iframe.parentElement;
  if (!_iframeParent) return;

  // Make parent position:relative if needed
  const pos = getComputedStyle(_iframeParent).position;
  if (pos === 'static') _iframeParent.style.position = 'relative';

  // Create avatar strip
  _stripEl = document.createElement('div');
  _stripEl.id = 'lc-presence-strip';
  _stripEl.style.cssText = [
    'position:absolute',
    'top:8px',
    'right:8px',
    'display:flex',
    'gap:4px',
    'align-items:center',
    'z-index:100',
    'pointer-events:none',
  ].join(';');
  _iframeParent.appendChild(_stripEl);

  _awareness.on('change', renderStrip);
  renderStrip();
}

function renderStrip() {
  if (!_stripEl || !_awareness) return;
  const states = Array.from(_awareness.getStates().values())
    .map(s => s.lc)
    .filter(Boolean);

  _stripEl.innerHTML = '';

  const visible = states.slice(0, MAX_VISIBLE_AVATARS);
  const overflow = states.length - visible.length;

  for (const s of visible) {
    const avatar = document.createElement('div');
    avatar.title = s.name || s.initials;
    avatar.style.cssText = [
      `background:${s.color}`,
      'width:28px',
      'height:28px',
      'border-radius:50%',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'color:#fff',
      'font-size:11px',
      'font-weight:600',
      'font-family:system-ui,sans-serif',
      'border:2px solid #fff',
      'box-shadow:0 1px 3px rgba(0,0,0,.25)',
      'flex-shrink:0',
    ].join(';');
    avatar.textContent = s.initials || '?';
    _stripEl.appendChild(avatar);
  }

  if (overflow > 0) {
    const more = document.createElement('div');
    more.title = `${overflow} more collaborator${overflow === 1 ? '' : 's'}`;
    more.style.cssText = [
      'background:#6b7280',
      'width:28px',
      'height:28px',
      'border-radius:50%',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'color:#fff',
      'font-size:10px',
      'font-weight:600',
      'font-family:system-ui,sans-serif',
      'border:2px solid #fff',
      'box-shadow:0 1px 3px rgba(0,0,0,.25)',
    ].join(';');
    more.textContent = `+${overflow}`;
    _stripEl.appendChild(more);
  }
}

/**
 * Update the awareness cursor selector (called when the user hovers an element).
 * @param {string|null} selector
 */
export function updateCursorSelector(selector) {
  if (!_awareness) return;
  const local = _awareness.getLocalState();
  if (!local || !local.lc) return;
  _awareness.setLocalStateField('lc', { ...local.lc, activeSelector: selector });
  sendRoomEvent({ type: 'lc-cursor', selector });
}

/**
 * Mount a cursor-overlay layer that draws a colored outline + name label on
 * whichever element each OTHER collaborator is currently hovering. Reads
 * awareness state; updates on awareness change. Repositions on scroll/resize
 * via repositionCursors().
 * @param {HTMLIFrameElement} iframe
 */
export function mountCursorOverlay(iframe) {
  if (!iframe || !_awareness) return;
  _cursorIframe = iframe;
  const parent = iframe.parentElement;
  if (!parent) return;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

  _cursorOverlay = document.createElement('div');
  _cursorOverlay.id = 'lc-cursor-overlay';
  _cursorOverlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99;';
  parent.appendChild(_cursorOverlay);

  _awareness.on('change', renderCursors);
  renderCursors();
}

function renderCursors() {
  if (!_cursorOverlay || !_cursorIframe || !_awareness) return;
  _cursorOverlay.innerHTML = '';

  const localID = _awareness.clientID;
  const states = _awareness.getStates();
  const iframeBox = _cursorIframe.getBoundingClientRect();
  const containerBox = _cursorOverlay.getBoundingClientRect();
  const dx = iframeBox.left - containerBox.left;
  const dy = iframeBox.top - containerBox.top;

  let doc;
  try { doc = _cursorIframe.contentDocument; } catch { return; }
  if (!doc) return;

  for (const [clientID, state] of states) {
    if (clientID === localID) continue;
    const lc = state && state.lc;
    if (!lc || !lc.activeSelector) continue;

    let el;
    try { el = doc.querySelector(lc.activeSelector); } catch { continue; }
    if (!el) continue;

    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;

    const left = dx + r.left;
    const top = dy + r.top;
    const color = lc.color || '#7c3aed';

    const outline = document.createElement('div');
    outline.style.cssText = [
      'position:absolute',
      `left:${left}px`,
      `top:${top}px`,
      `width:${r.width}px`,
      `height:${r.height}px`,
      `outline:2px solid ${color}`,
      'outline-offset:1px',
      'border-radius:2px',
      'transition:outline 80ms ease-out',
    ].join(';');
    _cursorOverlay.appendChild(outline);

    const label = document.createElement('div');
    label.style.cssText = [
      'position:absolute',
      `left:${left}px`,
      `top:${Math.max(0, top - 18)}px`,
      `background:${color}`,
      'color:#fff',
      'font-size:10px',
      'font-weight:600',
      'padding:1px 6px',
      'border-radius:3px',
      'font-family:system-ui,sans-serif',
      'white-space:nowrap',
      'line-height:1.4',
    ].join(';');
    label.textContent = lc.name || lc.initials || '?';
    _cursorOverlay.appendChild(label);
  }
}

/** Re-run cursor rendering — called on iframe scroll/resize. */
export function repositionCursors() {
  renderCursors();
}

export function destroyPresence() {
  if (_awareness && typeof _awareness.off === 'function') {
    _awareness.off('change', renderStrip);
    _awareness.off('change', renderCursors);
  }
  if (_stripEl && _stripEl.parentElement) _stripEl.parentElement.removeChild(_stripEl);
  if (_cursorOverlay && _cursorOverlay.parentElement) _cursorOverlay.parentElement.removeChild(_cursorOverlay);
  _stripEl = null;
  _cursorOverlay = null;
  _cursorIframe = null;
  _iframeParent = null;
  _awareness = null;
}
