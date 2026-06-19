// collab-comments.js — threaded comments anchored to preview iframe elements.
// Comments are stored server-side (REST API). New comments are broadcast to all
// room members via the custom WebSocket message protocol.

import { onRoomEvent } from './collab.js';

const PROTO_API = (protoId) => `/api/prototypes/${protoId}/collab/comments`;

let _protoId = null;
let _currentUser = null;
let _role = null;
let _commentCache = []; // flat list of comment objects
let _indicatorContainer = null; // div overlaid on the iframe parent

// ── Indicator dots ─────────────────────────────────────────────────────────────

function renderIndicators(iframeEl) {
  if (!_indicatorContainer || !iframeEl) return;
  _indicatorContainer.innerHTML = '';

  // Group comments by root thread selector
  const bySelector = new Map();
  for (const c of _commentCache) {
    if (!c.thread_id && c.selector) {
      if (!bySelector.has(c.selector)) bySelector.set(c.selector, []);
      bySelector.get(c.selector).push(c);
    }
  }

  const iframeRect = iframeEl.getBoundingClientRect();
  const parentRect = _indicatorContainer.getBoundingClientRect();

  for (const [, comments] of bySelector) {
    // Try to find element position inside the iframe
    let x = 16, y = 16; // fallback position
    try {
      const iframeDoc = iframeEl.contentDocument;
      if (iframeDoc && comments[0].selector) {
        const el = iframeDoc.querySelector(comments[0].selector);
        if (el) {
          const r = el.getBoundingClientRect();
          // iframe rect relative to the parent container
          x = (iframeRect.left - parentRect.left) + r.left + r.width / 2;
          y = (iframeRect.top - parentRect.top) + r.top;
        }
      }
    } catch (_) {}

    const dot = document.createElement('div');
    dot.className = 'lc-comment-dot';
    dot.style.cssText = [
      'position:absolute',
      `left:${x}px`,
      `top:${y}px`,
      'width:10px',
      'height:10px',
      'border-radius:50%',
      'background:#f97316',
      'border:2px solid #fff',
      'box-shadow:0 1px 4px rgba(0,0,0,.3)',
      'cursor:pointer',
      'z-index:200',
      'transform:translate(-50%,-50%)',
    ].join(';');
    dot.title = `${comments.length} comment${comments.length === 1 ? '' : 's'}`;
    dot.addEventListener('click', () => openCommentThread(comments[0].selector, null, iframeEl));
    _indicatorContainer.appendChild(dot);
  }
}

// ── Popover UI ─────────────────────────────────────────────────────────────────

function openCommentThread(selector, anchorRect, iframeEl) {
  closeAllPopovers();

  const thread = _commentCache.filter(c =>
    c.selector === selector || c.thread_id === _commentCache.find(r => r.selector === selector)?.id
  );

  const pop = document.createElement('div');
  pop.className = 'lc-comment-popover';
  pop.style.cssText = [
    'position:fixed',
    'z-index:9999',
    'background:#fff',
    'border:1px solid #e5e7eb',
    'border-radius:10px',
    'box-shadow:0 8px 24px rgba(0,0,0,.15)',
    'width:300px',
    'max-height:420px',
    'overflow-y:auto',
    'padding:12px',
    'font-family:system-ui,sans-serif',
    'font-size:13px',
    'color:#111',
  ].join(';');

  // Position near the anchor or centre of viewport
  if (anchorRect) {
    pop.style.left = `${Math.min(anchorRect.right + 8, window.innerWidth - 316)}px`;
    pop.style.top = `${Math.max(8, anchorRect.top)}px`;
  } else {
    pop.style.left = '50%';
    pop.style.top = '50%';
    pop.style.transform = 'translate(-50%,-50%)';
  }

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'font-weight:600;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;';
  header.innerHTML = `<span>Comments</span>`;
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:14px;color:#6b7280;padding:0;';
  closeBtn.onclick = () => pop.remove();
  header.appendChild(closeBtn);
  pop.appendChild(header);

  // Thread messages
  const rootComments = thread.filter(c => !c.thread_id);
  for (const c of rootComments) {
    const replies = thread.filter(r => r.thread_id === c.id);
    pop.appendChild(renderCommentRow(c));
    for (const r of replies) pop.appendChild(renderCommentRow(r, true));
  }

  // New comment input (editor+ only)
  if (_role === 'owner' || _role === 'editor') {
    const input = document.createElement('textarea');
    input.placeholder = 'Add a comment…';
    input.rows = 2;
    input.style.cssText = 'width:100%;border:1px solid #d1d5db;border-radius:6px;padding:6px;font-size:13px;resize:vertical;margin-top:8px;box-sizing:border-box;';

    const sendBtn = document.createElement('button');
    sendBtn.textContent = 'Comment';
    sendBtn.style.cssText = 'margin-top:6px;background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:5px 14px;font-size:12px;cursor:pointer;font-weight:600;';
    sendBtn.onclick = async () => {
      const body = input.value.trim();
      if (!body) return;
      const threadId = rootComments.length > 0 ? rootComments[0].id : null;
      await submitComment({ selector, threadId, body }, iframeEl);
      pop.remove();
    };

    pop.appendChild(input);
    pop.appendChild(sendBtn);
  }

  document.body.appendChild(pop);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function dismiss(e) {
      if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('click', dismiss); }
    });
  }, 0);
}

function renderCommentRow(comment, isReply = false) {
  const row = document.createElement('div');
  row.style.cssText = [
    `margin-left:${isReply ? 16 : 0}px`,
    'border-left:' + (isReply ? '2px solid #e5e7eb;padding-left:8px;' : 'none;'),
    'margin-bottom:8px',
  ].join(';');

  const authorLine = document.createElement('div');
  authorLine.style.cssText = 'font-weight:600;color:#374151;font-size:12px;margin-bottom:2px;';
  authorLine.textContent = comment.author?.name || comment.author?.email || 'Someone';
  row.appendChild(authorLine);

  const bodyEl = document.createElement('div');
  bodyEl.style.cssText = 'line-height:1.4;color:#111827;';
  bodyEl.textContent = comment.body;
  row.appendChild(bodyEl);

  if (_role === 'owner' || _role === 'editor' || _currentUser?.id === comment.author?.id) {
    const resolveBtn = document.createElement('button');
    resolveBtn.textContent = 'Resolve';
    resolveBtn.style.cssText = 'background:none;border:none;color:#9ca3af;font-size:11px;cursor:pointer;padding:2px 0;';
    resolveBtn.onclick = async () => {
      await fetch(`/api/prototypes/${_protoId}/collab/comments/${comment.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: true }),
      });
      closeAllPopovers();
    };
    row.appendChild(resolveBtn);
  }
  return row;
}

function closeAllPopovers() {
  document.querySelectorAll('.lc-comment-popover').forEach(el => el.remove());
}

// ── API helpers ────────────────────────────────────────────────────────────────

async function fetchComments() {
  try {
    const r = await fetch(PROTO_API(_protoId));
    if (!r.ok) return;
    const data = await r.json();
    if (data.ok && Array.isArray(data.comments)) {
      _commentCache = data.comments;
    }
  } catch (_) {}
}

async function submitComment({ selector, threadId, body }, iframeEl) {
  const payload = { body, selector: selector || null, thread_id: threadId || null };
  if (!threadId && selector) {
    // Capture text prefix from iframe for re-targeting
    try {
      const el = iframeEl.contentDocument.querySelector(selector);
      if (el) payload.text_prefix = (el.textContent || '').trim().slice(0, 80);
    } catch (_) {}
  }
  try {
    const r = await fetch(PROTO_API(_protoId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data.ok) _commentCache.push(data.comment);
  } catch (_) {}
}

// ── Init ───────────────────────────────────────────────────────────────────────

/**
 * @param {string} prototypeId
 * @param {{ id: string, email: string }} currentUser
 * @param {'owner'|'editor'|'viewer'} role
 * @param {HTMLIFrameElement} [iframe]
 */
export async function initComments(prototypeId, currentUser, role, iframe) {
  _protoId = prototypeId;
  _currentUser = currentUser;
  _role = role;

  await fetchComments();

  if (iframe) {
    const parent = iframe.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      _indicatorContainer = document.createElement('div');
      _indicatorContainer.id = 'lc-comment-indicators';
      _indicatorContainer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
      parent.appendChild(_indicatorContainer);
      // Enable pointer events on child dots
      _indicatorContainer.style.pointerEvents = 'none';
      renderIndicators(iframe);

      // Right-click in iframe → intercept via postMessage from inline script.
      // The iframe sends iframe-local coords; translate to viewport coords for
      // popover positioning by adding the iframe's bounding rect offset.
      window.addEventListener('message', (evt) => {
        if (!evt.data || evt.data.type !== 'lc-contextmenu') return;
        const { selector, iframeRect } = evt.data;
        let anchorRect = null;
        if (iframeRect) {
          const iBox = iframe.getBoundingClientRect();
          anchorRect = {
            left:   iBox.left + (iframeRect.left   || 0),
            top:    iBox.top  + (iframeRect.top    || 0),
            right:  iBox.left + (iframeRect.right  || 0),
            bottom: iBox.top  + (iframeRect.bottom || 0),
          };
        }
        openCommentThread(selector, anchorRect, iframe);
      });
    }
  }

  // Live updates from WebSocket room events
  onRoomEvent((event) => {
    if (event.type !== 'lc-comment-broadcast') return;
    if (event.action === 'created' && event.comment) {
      _commentCache.push(event.comment);
    } else if (event.action === 'updated' && event.comment) {
      const idx = _commentCache.findIndex(c => c.id === event.comment.id);
      if (idx >= 0) _commentCache[idx] = event.comment;
      else _commentCache.push(event.comment);
    } else if (event.action === 'deleted' && event.id) {
      _commentCache = _commentCache.filter(c => c.id !== event.id);
    }
    if (iframe) renderIndicators(iframe);
  });
}

/**
 * Re-render the comment indicator dots. Called from main.js when the iframe
 * scrolls/resizes (forwarded as lc-iframe-scroll postMessage from the iframe
 * inline-edit script). Cheap — just reads bounding rects, no API call.
 * @param {HTMLIFrameElement} iframe
 */
export function repositionComments(iframe) {
  if (!iframe || !_indicatorContainer) return;
  renderIndicators(iframe);
}

export function destroyComments() {
  if (_indicatorContainer && _indicatorContainer.parentElement) {
    _indicatorContainer.parentElement.removeChild(_indicatorContainer);
  }
  _indicatorContainer = null;
  _commentCache = [];
  closeAllPopovers();
}
