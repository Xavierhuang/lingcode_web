// main-upgrade-modal.js — paywall modal for the "100 free LingModel prompts"
// funnel. Listens for the `lingmodel:upgrade-required` window event dispatched
// from agent.js when the proxy returns a 402 with `upgrade_required: true`.
//
// The modal is built lazily on first show; the module is a single import in
// main.js with no exports — side-effect-only registration.

import { isUserPro } from './main-providers.js?v=20260602d';

const EVENT_NAME = 'lingmodel:upgrade-required';

let modalEl = null;
let lastFocusedEl = null;

// Headline + CTA depend on who hit the wall. A paying user who hits a
// (usually time-windowed) cap should NOT be told "you're out of free prompts /
// Upgrade to Pro" — that reads as broken or double-charging. Free/anon users
// get the upgrade funnel. Tier is read from the client's resolved entitlement
// state (isUserPro covers both pro and max_pro).
function copyForScenario() {
  if (isUserPro()) {
    return {
      title: 'You’ve hit your LingModel limit',
      // Neutral plans link — lets a Pro user step up to Max Pro without the
      // "Upgrade to Pro" copy implying they aren't already paying.
      ctaLabel: 'View plans',
    };
  }
  return { title: 'You’ve used your free LingModel prompts', ctaLabel: 'Upgrade to Pro' };
}

function buildModal() {
  const wrap = document.createElement('div');
  wrap.id = 'lingmodel-upgrade-modal';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-labelledby', 'lm-upgrade-title');
  wrap.style.cssText = [
    'position: fixed', 'inset: 0', 'z-index: 9999',
    'display: none', 'align-items: center', 'justify-content: center',
    'background: rgba(0, 0, 0, 0.55)',
    'backdrop-filter: blur(4px)',
    '-webkit-backdrop-filter: blur(4px)',
    'animation: lm-upgrade-fade 0.18s ease-out',
  ].join(';');

  // The card is intentionally narrow and uses the site's existing font stack
  // via inheritance — no font-family override here, so it tracks theme changes
  // without needing its own CSS file.
  wrap.innerHTML = `
    <style>
      @keyframes lm-upgrade-fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes lm-upgrade-pop  { from { opacity: 0; transform: scale(0.96); }
                                   to   { opacity: 1; transform: scale(1); } }
    </style>
    <div style="
      max-width: 420px; width: calc(100% - 32px);
      background: var(--bg-card, #1a1a1c);
      color: var(--fg, #f5f5f7);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 28px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.45);
      animation: lm-upgrade-pop 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
    ">
      <div style="font-size: 32px; margin-bottom: 8px; line-height: 1;">✨</div>
      <h2 id="lm-upgrade-title" style="
        margin: 0 0 8px;
        font-size: 22px;
        font-weight: 600;
        letter-spacing: -0.01em;
      ">You've used your 100 free LingModel prompts</h2>
      <p id="lm-upgrade-body" style="
        margin: 0 0 20px;
        font-size: 14px;
        line-height: 1.5;
        color: var(--fg-muted, #a8a8b3);
      ">Upgrade to Pro to keep building. You can also bring your own API key
      from any provider — that path stays free.</p>
      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button id="lm-upgrade-cancel" style="
          padding: 9px 16px;
          background: transparent;
          color: var(--fg, #f5f5f7);
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 8px;
          font-size: 14px;
          cursor: pointer;
        ">Not now</button>
        <button id="lm-upgrade-go" style="
          padding: 9px 18px;
          background: var(--accent, #00d084);
          color: #000;
          border: 0;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
        ">Upgrade to Pro</button>
      </div>
    </div>
  `;

  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close();
  });
  wrap.querySelector('#lm-upgrade-cancel').addEventListener('click', close);

  document.body.appendChild(wrap);
  modalEl = wrap;
  return wrap;
}

function close() {
  if (!modalEl) return;
  modalEl.style.display = 'none';
  if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') {
    lastFocusedEl.focus();
  }
  lastFocusedEl = null;
}

function open({ message, upgradeUrl }) {
  const el = modalEl || buildModal();
  const copy = copyForScenario();
  const titleEl = el.querySelector('#lm-upgrade-title');
  if (titleEl) titleEl.textContent = copy.title;
  const body = el.querySelector('#lm-upgrade-body');
  if (body) {
    // The server-supplied message (e.g. "…resets at 00:00 UTC") replaces the
    // default body when present. Keep the BYOK suffix so users always see the
    // free escape hatch.
    body.textContent = message
      ? `${message} You can also bring your own API key from any provider — that path stays free.`
      : 'You can also bring your own API key from any provider — that path stays free, no subscription needed.';
  }
  const goBtn = el.querySelector('#lm-upgrade-go');
  if (goBtn) {
    goBtn.textContent = copy.ctaLabel;
    goBtn.onclick = () => {
      const url = upgradeUrl || 'https://lingcode.dev/pricing.html';
      // New tab so the user doesn't lose their in-progress prototype.
      window.open(url, '_blank', 'noopener');
    };
  }
  lastFocusedEl = document.activeElement;
  el.style.display = 'flex';
  // Give the browser a tick to render before focusing — focusing a hidden
  // element is a no-op in some browsers.
  setTimeout(() => goBtn?.focus(), 0);
}

window.addEventListener(EVENT_NAME, (e) => {
  open(e.detail || {});
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalEl && modalEl.style.display !== 'none') close();
});
