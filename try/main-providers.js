// main-providers.js — provider key UI + LingModel entitlement state.
//
// Owns the per-provider key inputs, the selection set, the LingModel state
// badge, and the entitlement primitives (lingmodelReady, userIsPro,
// lingmodelEntitlementSettled). Other modules — entitlement check, send
// button, run loop, demo mode — read state via the exported getters and
// (for the entitlement check only) write via the setters.
//
// Public API:
//
//   State (mutable refs — share-by-reference is intentional)
//     selected            : Set<providerId>
//     keyInputs           : Map<providerId, HTMLInputElement>
//     toggles             : Map<providerId, HTMLDivElement>
//     proGateBadges       : Map<providerId, HTMLSpanElement>
//     lingmodelStateBadge : HTMLSpanElement (the LingModel-row status pill)
//
//   Primitives (use getters/setters — `let` exports also work but the
//   getter shape lets us add notifications later without breaking callers)
//     getLingmodelReady() / setLingmodelReady(v)
//     isUserPro()         / setUserPro(v)
//     getLingmodelEntitlementSettled() / setLingmodelEntitlementSettled(v)
//
//   localStorage helpers
//     loadKey(id)         / saveKey(id, k)
//     loadSelection()     / saveSelection(set)
//
//   Formatters (used by entitlement-check display)
//     formatTokens(n)     // 412K, 1.3M
//     formatResetIn(ms)   // 23m, 2h 15m
//
//   Refresh + UI
//     refreshProGates()        // re-paint Pro-locked rows after entitlement
//     syncProvidersSummary()   // outer disclosure summary text/warn class
//     setProvidersOpen(open, persist?)
//     mountProviders({ updateSendState })
//
// Migration note: `selected` is loaded from localStorage at module-load,
// migrating any legacy 'lingmodel-pro' id to 'lingmodel-advanced', and
// defaulting to {'lingmodel'} for first-time visitors.

import { PROVIDERS } from './agent.js?v=20260602d';
import { t } from './i18n.js?v=20260602d';

// ---- localStorage helpers ----

const KEY_PREFIX = 'lingcode.try.key.';
const SELECTED_KEY = 'lingcode.try.selected';

export function loadKey(id) { return localStorage.getItem(KEY_PREFIX + id) || ''; }
export function saveKey(id, k) {
  if (k) localStorage.setItem(KEY_PREFIX + id, k);
  else localStorage.removeItem(KEY_PREFIX + id);
}
export function loadSelection() {
  try { return new Set(JSON.parse(localStorage.getItem(SELECTED_KEY) || '[]')); }
  catch { return new Set(); }
}
export function saveSelection(set) {
  localStorage.setItem(SELECTED_KEY, JSON.stringify([...set]));
}

// ---- Formatters ----

// Compact token formatter — "412K", "1.3M" — for the Pro budget badge.
export function formatTokens(n) {
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return (m >= 10 ? m.toFixed(0) : m.toFixed(1)) + 'M';
  }
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(Math.round(n));
}

// Coarse "resets in 2h 15m" / "23m" formatter for the Pro 5h window
// countdown shown in the LingModel state badge.
export function formatResetIn(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const totalMin = Math.ceil(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ---- Entitlement primitives ----

// Tracks whether the LingModel free path is usable — set by checkEntitlement.
// When false, the LingModel row is auto-deselected so the Send button isn't
// stuck enabled with a provider that will 401 on click.
let _lingmodelReady = false;
export const getLingmodelReady = () => _lingmodelReady;
export const setLingmodelReady = (v) => { _lingmodelReady = !!v; };

// Distinguishes "checkEntitlement hasn't run yet" (assume LingModel works)
// from "checkEntitlement said it doesn't work" (show warn). Without this
// flag the outer summary would render "LingModel unavailable" on initial
// load even for users who actually have free queries left.
let _lingmodelEntitlementSettled = false;
export const getLingmodelEntitlementSettled = () => _lingmodelEntitlementSettled;
export const setLingmodelEntitlementSettled = (v) => { _lingmodelEntitlementSettled = !!v; };

// Pro tier gate — set by checkEntitlement on /api/account/me success.
// Drives the LingModel Advanced row's clickability (free users bounce to
// /account#billing when they tap that toggle).
let _userIsPro = false;
export const isUserPro = () => _userIsPro;
export const setUserPro = (v) => { _userIsPro = !!v; };

// ---- State (mutable shared refs) ----

// Selection persists in localStorage. Migrate legacy 'lingmodel-pro' →
// 'lingmodel-advanced' on the way in. Default to {'lingmodel'} for fresh
// visitors so the Send button is enabled out of the box.
export const selected = loadSelection();
let _migratedProviderSelection = false;
if (selected.delete('lingmodel-pro')) {
  selected.add('lingmodel-advanced');
  _migratedProviderSelection = true;
}
if (_migratedProviderSelection) saveSelection(selected);
if (selected.size === 0) {
  selected.add('lingmodel');
  saveSelection(selected);
}

export const keyInputs = new Map();   // id → input element
export const toggles = new Map();     // id → toggle div
export const proGateBadges = new Map();

// The LingModel row's status pill — entitlement check writes textContent
// + style.color into it as the entitlement state evolves.
export const lingmodelStateBadge = document.createElement('span');
lingmodelStateBadge.className = 'try-lingmodel-status';
lingmodelStateBadge.style.color = 'var(--text-muted)';
lingmodelStateBadge.textContent = t('lingmodel.checking');

// ---- Internal DOM refs (resolved on mount) ----

let _keyGrid = null;
let _providersToggle = null;
let _providersSummary = null;

// Closured at mount() so refreshProGates() and the row click handlers can
// fire it without a forward-decl typeof guard.
let _updateSendState = () => {};

// Persists the user's expand-state for the provider list across visits.
// v2 forces a fresh collapsed default; old `providersOpen` values are wiped.
const PROVIDERS_OPEN_KEY = 'lingcode.try.providersOpen.v2';
const SECONDARY_OPEN_KEY = 'lingcode.try.secondaryOpen';
let _secondaryOpen = localStorage.getItem(SECONDARY_OPEN_KEY) === '1';

// ---- refreshProGates / syncProvidersSummary / setProvidersOpen ----

export function refreshProGates() {
  for (const p of PROVIDERS) {
    if (!p.requiresPro) continue;
    const badge = proGateBadges.get(p.id);
    if (badge) {
      badge.textContent = _userIsPro ? t('pro.ready') : t('pro.upgrade_cta');
      badge.classList.toggle('locked', !_userIsPro);
    }
    const row = toggles.get(p.id)?.closest('.try-key-row');
    if (row) row.classList.toggle('pro-locked', !_userIsPro);
    // If a free user previously had this selected (e.g., they upgraded then
    // downgraded), drop it so Run doesn't waste a click on a locked row.
    if (!_userIsPro && selected.has(p.id)) {
      selected.delete(p.id);
      toggles.get(p.id)?.classList.remove('on');
      saveSelection(selected);
    }
  }
  _updateSendState();
  syncProvidersSummary();
}

export function syncProvidersSummary() {
  const ready = [];
  for (const p of PROVIDERS) {
    if (!selected.has(p.id)) continue;
    if (p.id === 'lingmodel' || (keyInputs.get(p.id)?.value || '').trim()) ready.push(p.name);
  }
  if (_providersSummary) {
    if (ready.length === 0) {
      _providersSummary.textContent = t('providers.summary_none');
    } else if (ready.length === 1) {
      _providersSummary.textContent = t('providers.summary_one', ready[0]);
    } else {
      _providersSummary.textContent = t('providers.summary_many', ready.length, ready.join(', '));
    }
  }
  // Outer "More options" disclosure summary — warn-tinted when LingModel
  // is the default selection but unavailable, so the disclosure label
  // self-advertises that the user needs to expand it to fix credentials.
  // Critical: only show "unavailable" AFTER checkEntitlement has resolved.
  // Without that gate, the initial paint (lingmodelReady=false because the
  // async fetch hasn't returned yet) would falsely warn for every user.
  const outerSummary = document.getElementById('advanced-state-summary');
  const outerBtn = document.querySelector('#advanced-disclosure .try-advanced-summary');
  if (outerSummary) {
    const onlyLingmodelSelected = selected.size === 1 && selected.has('lingmodel');
    const lingmodelBroken = onlyLingmodelSelected
      && _lingmodelEntitlementSettled
      && _lingmodelReady === false;
    if (lingmodelBroken) {
      outerSummary.textContent = t('advanced.summary_unavailable');
      outerBtn?.classList.add('warn');
    } else if (ready.length === 0) {
      outerSummary.textContent = t('providers.summary_none');
      outerBtn?.classList.remove('warn');
    } else if (onlyLingmodelSelected) {
      outerSummary.textContent = t('advanced.summary_lingmodel_only');
      outerBtn?.classList.remove('warn');
    } else {
      outerSummary.textContent = t('advanced.summary_with_providers', ready.length, ready.join(', '));
      outerBtn?.classList.remove('warn');
    }
  }
}

export function setProvidersOpen(open, persist = true) {
  if (!_keyGrid || !_providersToggle) return;
  // Inline style beats `.try-keys { display: grid }` (same specificity, page
  // CSS wins source-order over the UA's [hidden]{display:none}, so plain
  // `hidden` doesn't actually hide the grid).
  _keyGrid.style.display = open ? '' : 'none';
  _keyGrid.hidden = !open;
  _providersToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open) syncProvidersSummary();  // refresh on close so it reflects latest state
  if (persist) localStorage.setItem(PROVIDERS_OPEN_KEY, open ? '1' : '0');
}

// ---- Mount ----

export function mountProviders({ updateSendState }) {
  _updateSendState = typeof updateSendState === 'function' ? updateSendState : () => {};

  _keyGrid = document.getElementById('key-grid');
  _providersToggle = document.getElementById('providers-toggle');
  _providersSummary = document.getElementById('providers-summary');
  if (!_keyGrid) return;  // markup absent — bail silently (legacy /try)

  // If the user had previously selected any secondary provider (or has a
  // saved key for one), auto-expand so they don't lose track of saved keys.
  if (!_secondaryOpen) {
    for (const p of PROVIDERS) {
      if (p.secondary && (selected.has(p.id) || loadKey(p.id))) { _secondaryOpen = true; break; }
    }
  }

  let __idx = 0;
  for (const p of PROVIDERS) {
    const row = document.createElement('div');
    row.className = 'try-key-row';
    if (loadKey(p.id)) row.classList.add('saved');
    if (p.proxied) row.classList.add('featured');
    if (p.secondary) row.classList.add('secondary');
    row.style.animationDelay = `${__idx * 50}ms`;
    __idx++;

    const toggle = document.createElement('div');
    toggle.className = 'toggle' + (selected.has(p.id) ? ' on' : '');
    toggle.title = p.requiresPro
      ? 'Pro tier required — click to upgrade'
      : 'Click to include this provider in the run';
    toggle.addEventListener('click', () => {
      if (p.requiresPro && !_userIsPro) {
        sessionStorage.setItem('lingcode.next', '/try.html');
        window.location.href = '/account.html#billing';
        return;
      }
      if (selected.has(p.id)) { selected.delete(p.id); toggle.classList.remove('on'); }
      else                    { selected.add(p.id);    toggle.classList.add('on'); }
      saveSelection(selected);
      _updateSendState();
      syncProvidersSummary();
    });
    toggles.set(p.id, toggle);

    const dot = document.createElement('div');
    dot.className = 'brand-dot';
    if (p.color) dot.style.color = p.color;
    dot.style.background = p.color || 'var(--text-dim)';

    const label = document.createElement('label');
    label.textContent = p.name;

    if (p.proxied) {
      const tag = document.createElement('span');
      tag.className = 'featured-tag';
      tag.textContent = p.requiresPro ? 'PRO' : 'FREE';
      if (p.requiresPro) tag.classList.add('featured-tag-pro');
      const slot = document.createElement('div');
      slot.className = 'try-key-meta-slot';
      if (p.requiresPro) {
        const proBadge = document.createElement('span');
        proBadge.className = 'pro-gate-badge locked';
        proBadge.textContent = t('pro.upgrade_cta');
        proBadge.style.cursor = 'pointer';
        proBadge.addEventListener('click', (e) => {
          if (!_userIsPro) {
            e.stopPropagation();
            window.location.href = '/account.html#billing';
          }
        });
        proGateBadges.set(p.id, proBadge);
        slot.append(proBadge);
      } else {
        slot.append(lingmodelStateBadge);
      }
      row.append(toggle, dot, label, tag, slot);
      _keyGrid.append(row);
      continue;
    }

    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = p.keyHint;
    input.value = loadKey(p.id);
    input.spellcheck = false;
    input.autocomplete = 'off';

    const savedBadge = document.createElement('span');
    savedBadge.className = 'saved-badge';
    savedBadge.textContent = '✓ saved';

    let pendingFlash = null;
    function flashSaved() {
      savedBadge.classList.add('show');
      if (pendingFlash) clearTimeout(pendingFlash);
      pendingFlash = setTimeout(() => savedBadge.classList.remove('show'), 1200);
    }

    input.addEventListener('input', () => {
      const v = input.value.trim();
      saveKey(p.id, v);
      if (v) row.classList.add('saved'); else row.classList.remove('saved');
      _updateSendState();
      syncProvidersSummary();
    });
    input.addEventListener('blur', () => { if (input.value.trim()) flashSaved(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) { flashSaved(); input.blur(); }
    });
    keyInputs.set(p.id, input);

    const eyeBtn = document.createElement('button');
    eyeBtn.type = 'button';
    eyeBtn.className = 'icon-btn';
    eyeBtn.innerHTML = '👁';
    eyeBtn.title = 'Show / hide key';
    eyeBtn.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn danger';
    delBtn.innerHTML = '×';
    delBtn.style.fontSize = '20px';
    delBtn.style.lineHeight = '1';
    delBtn.title = 'Delete this saved key from your browser';
    delBtn.addEventListener('click', () => {
      if (!input.value && !loadKey(p.id)) return;
      if (!confirm(`Delete the saved ${p.name} key from this browser? You'll need to paste it again to use ${p.name}.`)) return;
      input.value = '';
      saveKey(p.id, '');
      row.classList.remove('saved');
      _updateSendState();
    });

    row.append(toggle, dot, label, input, savedBadge, eyeBtn, delBtn);
    _keyGrid.append(row);
  }

  // "More providers" / "Hide" toggle that controls .secondary-row visibility.
  // Sits at the end of the grid spanning full width.
  const secondaryCount = PROVIDERS.filter((p) => p.secondary).length;
  if (secondaryCount) {
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'try-more-providers';
    function syncMoreBtn() {
      moreBtn.textContent = _secondaryOpen
        ? `▾ ${(t('providers.hide') || 'Hide extra providers')}`
        : `▸ ${(t('providers.more') || 'More providers')} (+${secondaryCount})`;
      document.body.classList.toggle('show-secondary-providers', _secondaryOpen);
    }
    moreBtn.addEventListener('click', () => {
      _secondaryOpen = !_secondaryOpen;
      localStorage.setItem(SECONDARY_OPEN_KEY, _secondaryOpen ? '1' : '0');
      syncMoreBtn();
    });
    syncMoreBtn();
    _keyGrid.append(moreBtn);
  }

  // Disclosure: collapsed by default for everyone. v2 key forces a fresh
  // collapsed default; old `providersOpen` values are wiped.
  try { localStorage.removeItem('lingcode.try.providersOpen'); } catch {}
  const initialOpen = localStorage.getItem(PROVIDERS_OPEN_KEY) === '1';
  setProvidersOpen(initialOpen, /* persist */ false);
  // setProvidersOpen only refreshes the summary on close, so do an explicit
  // pass at init to render the pill row regardless of initial state.
  syncProvidersSummary();
  _providersToggle?.addEventListener('click', () => {
    setProvidersOpen(_keyGrid.hidden);
  });
}
