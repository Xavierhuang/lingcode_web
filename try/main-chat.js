// website/try/main-chat.js
// Persistent chat column — message renderer, question bubbles, skip affordances.
// All UI state lives in #try-chat-history. No external dependencies.

const historyEl = () => document.getElementById('try-chat-history');

// One-shot intercept: set by captureOneChatReply while waiting for a reply.
// When set, mountChatInput's handler routes here instead of onUserMessage.
let _intercept = null;

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scrollToBottom() {
  const el = historyEl();
  if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

// ─── Plain messages ───────────────────────────────────────────────────────────

/**
 * Append a plain message bubble to the chat history.
 * @param {string} text
 * @param {'ai'|'user'|'status'} role
 * @returns {HTMLElement} the wrapper div (caller can call .remove() or update it)
 */
export function postChatMessage(text, role = 'ai') {
  const el = historyEl();
  if (!el) return null;
  const wrap = document.createElement('div');
  wrap.className = `chat-msg chat-msg--${role}`;
  wrap.innerHTML = `<span class="chat-bubble">${escHtml(text)}</span>`;
  el.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

/**
 * Show a typing indicator for `delayMs` ms, then replace it with the real message.
 * @param {string} text
 * @param {'ai'|'user'|'status'} role
 * @param {number} delayMs
 * @returns {Promise<HTMLElement>}
 */
export async function postChatMessageDelayed(text, role = 'ai', delayMs = 600) {
  const el = historyEl();
  if (!el) return postChatMessage(text, role);

  const typing = document.createElement('div');
  typing.className = 'chat-msg chat-msg--ai chat-msg--typing';
  typing.innerHTML =
    '<span class="chat-bubble">' +
    '<span class="dot"></span><span class="dot"></span><span class="dot"></span>' +
    '</span>';
  el.appendChild(typing);
  scrollToBottom();

  await new Promise(r => setTimeout(r, delayMs));

  if (el.contains(typing)) el.removeChild(typing);
  return postChatMessage(text, role);
}

// ─── Question bubble ──────────────────────────────────────────────────────────

/**
 * Post a question bubble with radio-style option buttons and an optional Skip link.
 * Returns a Promise that resolves to:
 *   { answer: string, index: number }  — user picked an option
 *   { skipped: true }                  — user clicked Skip
 *
 * @param {string} question
 * @param {Array<{label: string, description?: string, recommended?: boolean}>} options
 * @param {{ skippable?: boolean }} opts
 * @returns {Promise<{answer?:string, index?:number, skipped?:boolean}>}
 */
export function postChatQuestion(question, options = [], { skippable = true } = {}) {
  return new Promise(resolve => {
    const el = historyEl();
    if (!el) { resolve({ skipped: true }); return; }

    const optionHtml = options.map((o, i) => `
      <button class="chat-q-opt${o.recommended ? ' chat-q-opt--rec' : ''}" data-idx="${i}" type="button">
        ${escHtml(o.label)}${o.recommended ? ' <em>Recommended</em>' : ''}
        ${o.description ? `<span class="chat-q-desc">${escHtml(o.description)}</span>` : ''}
      </button>`).join('');

    const wrap = document.createElement('div');
    wrap.className = 'chat-msg chat-msg--question';
    wrap.innerHTML =
      '<span class="chat-bubble chat-bubble--question">' +
        `<p class="chat-q-text">${escHtml(question)}</p>` +
        `<div class="chat-q-options">${optionHtml}</div>` +
        (skippable ? '<button class="chat-q-skip" type="button">Skip</button>' : '') +
      '</span>';
    el.appendChild(wrap);
    scrollToBottom();

    function lockAndResolve(result) {
      wrap.querySelectorAll('button').forEach(b => { b.disabled = true; });
      wrap.classList.add('chat-msg--answered');
      resolve(result);
    }

    wrap.querySelectorAll('.chat-q-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        btn.classList.add('chat-q-opt--selected');
        postChatMessage(options[idx].label, 'user');
        lockAndResolve({ answer: options[idx].label, index: idx });
      });
    });

    const skipBtn = wrap.querySelector('.chat-q-skip');
    if (skipBtn) {
      skipBtn.addEventListener('click', () => {
        postChatMessage('Skip', 'user');
        lockAndResolve({ skipped: true });
      });
    }
  });
}

// ─── Confirm bubble ───────────────────────────────────────────────────────────

/**
 * Post a confirm/cancel action row in the chat.
 * Returns Promise<{ confirmed: boolean }>.
 *
 * @param {string} promptText
 * @param {{ confirmLabel?: string, cancelLabel?: string }} opts
 * @returns {Promise<{confirmed: boolean}>}
 */
export function postChatConfirm(promptText, {
  confirmLabel = 'Confirm',
  cancelLabel  = 'Cancel',
} = {}) {
  return new Promise(resolve => {
    const el = historyEl();
    if (!el) { resolve({ confirmed: false }); return; }

    const wrap = document.createElement('div');
    wrap.className = 'chat-msg chat-msg--confirm';
    wrap.innerHTML =
      '<span class="chat-bubble chat-bubble--confirm">' +
        `<p>${escHtml(promptText)}</p>` +
        '<div class="chat-confirm-row">' +
          `<button class="chat-confirm-btn" type="button">${escHtml(confirmLabel)}</button>` +
          `<button class="chat-cancel-btn"  type="button">${escHtml(cancelLabel)}</button>` +
        '</div>' +
      '</span>';
    el.appendChild(wrap);
    scrollToBottom();

    function lockAndResolve(confirmed) {
      wrap.querySelectorAll('button').forEach(b => { b.disabled = true; });
      wrap.classList.add('chat-msg--answered');
      postChatMessage(confirmed ? confirmLabel : cancelLabel, 'user');
      resolve({ confirmed });
    }

    wrap.querySelector('.chat-confirm-btn').addEventListener('click', () => lockAndResolve(true));
    wrap.querySelector('.chat-cancel-btn') .addEventListener('click', () => lockAndResolve(false));
  });
}

// ─── Free-form text capture ───────────────────────────────────────────────────

/**
 * Capture one free-form text reply from the chat input.
 * Posts a status prompt in the chat, then resolves with the user's typed text.
 * The normal mountChatInput handler is suspended for this one reply.
 *
 * @param {string} promptText  — shown as an AI bubble before waiting
 * @returns {Promise<string>}
 */
export function captureOneChatReply(promptText) {
  return new Promise(resolve => {
    postChatMessage(promptText, 'ai');
    const form  = document.getElementById('try-chat-form');
    const input = document.getElementById('try-chat-input');
    if (!form || !input) { resolve(''); return; }
    // Set the intercept so the global mountChatInput handler routes here
    // instead of calling onUserMessage (which would fire a build).
    _intercept = (text) => resolve(text);
  });
}

// ─── Chat input wiring ────────────────────────────────────────────────────────

/**
 * Wire the #try-chat-form submit to call `onUserMessage(text)`.
 * Call once during page init. Safe to call before the form exists (no-op).
 *
 * @param {(text: string) => void} onUserMessage
 */
export function mountChatInput(onUserMessage) {
  const form  = document.getElementById('try-chat-form');
  const input = document.getElementById('try-chat-input');
  if (!form || !input) return;

  form.addEventListener('submit', e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    if (_intercept) {
      const fn = _intercept;
      _intercept = null;
      postChatMessage(text, 'user');
      fn(text);
      return;
    }
    postChatMessage(text, 'user');
    onUserMessage(text);
  });

  // Auto-expand textarea up to 140px
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });

  // ⌘+Enter or Ctrl+Enter also submits
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit?.() ?? form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Clear all messages from the chat history. */
export function clearChatHistory() {
  const el = historyEl();
  if (el) el.innerHTML = '';
}
