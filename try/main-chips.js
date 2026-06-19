// main-chips.js — top-bar connection-status chips (Supabase / GitHub / Collab).
//
// Extracted verbatim from main.js. Cheap polling instead of a subscriber
// pattern: cost is one localStorage read + one cached fetch every ~3s while
// app-view is visible. Avoids touching main-supabase.js / main-github-push.js
// / collab.js to add subscribers, which keeps the diff small and reversible.
//
// DI seam: cross-module helpers are injected. Returns `onView(mode)` which the
// router calls on every view change to start/stop polling — this replaces the
// old in-place setTryView wrapper, preserving identical behavior.

export function mountChips({ getSupabaseConfig, openSupabaseDialog, saveToGitHub, getAwareness }) {
  let _ghChipFetchInFlight = false;
  let _ghChipConnected = null;
  async function _refreshGithubConnected() {
    if (_ghChipFetchInFlight) return _ghChipConnected;
    _ghChipFetchInFlight = true;
    try {
      const r = await fetch('/api/github/status', { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        _ghChipConnected = !!(j && j.connected);
      }
    } catch (_) { /* offline or signed-out — leave previous value */ }
    finally { _ghChipFetchInFlight = false; }
    return _ghChipConnected;
  }

  function _setChip(el, { connected, label, onClick }) {
    if (!el) return;
    el.hidden = false;
    el.dataset.connected = connected ? '1' : '0';
    const labelEl = el.querySelector('.chip-label');
    if (labelEl && label) labelEl.textContent = label;
    if (onClick && !el.dataset.wired) {
      el.addEventListener('click', onClick);
      el.dataset.wired = '1';
    }
  }

  function refreshSupabaseChip() {
    let cfg = null;
    try { cfg = getSupabaseConfig(); } catch (_) {}
    const connected = !!(cfg && cfg.url);
    _setChip(document.getElementById('chip-supabase'), {
      connected,
      label: 'Supabase',
      onClick: () => {
        try { openSupabaseDialog(); } catch (e) { console.warn('[try] openSupabaseDialog failed', e); }
      },
    });
  }

  function refreshGithubChip() {
    _setChip(document.getElementById('chip-github'), {
      connected: !!_ghChipConnected,
      label: 'GitHub',
      onClick: async () => {
        // Save the current preview as a private gist. saveToGitHub handles the
        // full OAuth → save flow, including opening a popup when not yet
        // connected. We hand it a minimal shim that proxies textContent updates
        // onto the chip's label span (chip itself has a more complex DOM than
        // the legacy button it was modeled around).
        const chip = document.getElementById('chip-github');
        const labelEl = chip?.querySelector('.chip-label');
        if (!labelEl) return;
        const original = labelEl.textContent;
        const shim = {
          classList: { add() {}, remove() {} },
          get textContent() { return labelEl.textContent; },
          set textContent(s) { labelEl.textContent = s; },
        };
        try {
          await saveToGitHub(shim);
        } catch (e) {
          console.warn('[try] github chip save failed', e);
          labelEl.textContent = original;
        } finally {
          // The chip's connected state polls /api/github/status every 3s, so
          // it'll flip to green on its own. Force a refresh now so it doesn't
          // lag behind a successful OAuth.
          _refreshGithubConnected().then(refreshGithubChip);
        }
      },
    });
  }

  function refreshCollabChip() {
    let remote = 0;
    try {
      const aw = (typeof getAwareness === 'function') ? getAwareness() : null;
      if (aw && typeof aw.getStates === 'function') {
        // Remote count = total awareness states minus our own.
        remote = Math.max(0, aw.getStates().size - 1);
      }
    } catch (_) {}
    const el = document.getElementById('chip-collab');
    if (!el) return;
    if (remote <= 0) { el.hidden = true; return; }
    _setChip(el, {
      connected: true,
      label: 'Collab · ' + remote,
      onClick: () => {
        const legacy = document.getElementById('collab-btn');
        if (legacy) legacy.click();
      },
    });
  }

  function refreshAllChips() {
    refreshSupabaseChip();
    refreshGithubChip();
    refreshCollabChip();
  }

  let _chipPollTid = null;
  function startChipPolling() {
    refreshAllChips();
    _refreshGithubConnected().then(refreshGithubChip);
    if (_chipPollTid) return;
    _chipPollTid = setInterval(() => {
      refreshAllChips();
      _refreshGithubConnected().then(refreshGithubChip);
    }, 3000);
  }
  function stopChipPolling() {
    if (_chipPollTid) { clearInterval(_chipPollTid); _chipPollTid = null; }
  }

  // Storage event fires on localStorage writes from other tabs; useful for
  // reflecting a Supabase connect that happened in a sibling window.
  window.addEventListener('storage', refreshSupabaseChip);

  // Start/stop chip polling based on which view is active. The router calls
  // this at the end of every setTryView (was an in-place setTryView wrapper).
  function onView(mode) {
    if (mode === 'app') startChipPolling();
    else stopChipPolling();
  }

  // Apply once for the initial route, since setTryView already ran before this
  // module mounted.
  if (!document.getElementById('app-view').hidden) startChipPolling();

  return { onView, refreshAllChips, startChipPolling, stopChipPolling };
}
