// main-send.js — send-area UI: swarm toggle, swarm stage progress bar,
// the under-composer hint, the row-highlight for missing keys, and the
// per-provider credential gate.
//
// Note on scope: the pane-composer plumbing (anyPaneBusy, useSingleMainComposer,
// syncMainPromptComposerChrome, syncAllPaneFollowupRows, refreshMainSendButtonLabel,
// triggerTruncationContinue, maybeAutoOpenAdvanced, updateSendState itself)
// stayed in main.js until tier 0c — those read paneByProvider extensively
// and want to land alongside the pane-management cluster.
//
// Public API:
//   mountSend({ DEMO_MODE })
//     Build the swarm toggle + stage bar + hint shell. Caller positions
//     swarmToggle/swarmStageBar in the DOM (sendBtn.parentNode and
//     panesEl.parentNode respectively in main.js).
//   swarmToggle, swarmStageBar (live exports — null until mount runs)
//   getSwarmBuildMode() — read by run orchestration's branch select
//   updateSwarmStageBar(stage, status)
//   updatePaneSwarmStage(pane, stage, status)
//   showHint(text)
//   flagMissingKeys(missingIds)
//   providerHasCredentials(id)
//   _demoScenarioProviders (Set — populated by main-demo-mode.js's mount)

import { PROVIDERS } from './agent.js?v=20260602d';
import { keyInputs, toggles, getLingmodelReady, isUserPro } from './main-providers.js?v=20260602d';

// ---- Module state ----

let _swarmBuildMode = false;
export const getSwarmBuildMode = () => _swarmBuildMode;

// Populated by main-demo-mode.js's mountDemoMode (passed as a mount arg).
// providerHasCredentials reads this to skip the real-credentials gate for
// scripted providers in demo mode.
export const _demoScenarioProviders = new Set();

// Live exports — null until mountSend runs.
export let swarmToggle = null;
export let swarmStageBar = null;

let _hintEl = null;
let _DEMO_MODE = false;

// ---- Public ----

export function showHint(text) {
  if (!_hintEl) {
    _hintEl = document.createElement('div');
    _hintEl.style.cssText = 'margin-top:10px;font-size:0.8125rem;color:#fbbf24;font-family:Geist,sans-serif;';
    const promptRow = document.querySelector('.try-prompt-row');
    if (promptRow && promptRow.parentNode) promptRow.parentNode.insertBefore(_hintEl, promptRow.nextSibling);
  }
  _hintEl.textContent = text || '';
  _hintEl.style.display = text ? 'block' : 'none';
}

export function flagMissingKeys(missingIds) {
  for (const p of PROVIDERS) {
    const row = keyInputs.get(p.id)?.closest('.try-key-row') ?? toggles.get(p.id)?.closest('.try-key-row');
    if (!row) continue;
    if (missingIds.includes(p.id)) {
      row.style.borderColor = 'rgba(251,191,36,0.5)';
      row.style.background = 'rgba(251,191,36,0.05)';
    } else {
      row.style.borderColor = '';
      row.style.background = '';
    }
  }
}

export function providerHasCredentials(id) {
  // Demo mode: every scenario provider "has credentials" — they're served
  // by the scripted runner, not the real API.
  if (_DEMO_MODE && _demoScenarioProviders.has(id)) return true;
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) return false;
  if (p.requiresPro && !isUserPro()) return false;
  if (p.proxied) return getLingmodelReady();
  return !!(keyInputs.get(id)?.value || '').trim();
}

export function updateSwarmStageBar(stage, status) {
  if (!swarmStageBar) return;
  const btn = swarmStageBar.querySelector(`[data-stage="${stage}"]`);
  if (!btn) return;

  btn.classList.toggle('running', status === 'running');
  btn.classList.toggle('done', status === 'done');
  btn.classList.toggle('error', status === 'error');
  if (status !== 'idle') btn.disabled = false;

  const messages = {
    architect: {
      running: '🏗️ Architect (spec) — Analyzing your request... creating component tree, data model, features...',
      done: '✅ Architect (spec) — Done! Spec created.',
    },
    coder: {
      running: '💻 Coder (build) — Building HTML/CSS/JS from spec... implementing all features...',
      done: '✅ Coder (build) — Done! Code generated.',
    },
    reviewer: {
      running: '🔍 Reviewer (check) — Checking for bugs, missing features, accessibility issues...',
      done: '✅ Reviewer (check) — Done! Quality verified.',
    },
  };

  const msg = messages[stage]?.[status];
  if (msg && swarmStageBar._statusEl) {
    swarmStageBar._statusEl.textContent = msg;
  }
}

export function updatePaneSwarmStage(pane, stage, status) {
  if (!pane?.previewSwarm) return;
  const stageEl = pane.previewSwarm.querySelector(`[data-stage="${stage}"]`);
  if (stageEl) stageEl.className = `pp-stage pp-stage-${status}`;

  const msgs = {
    'architect/running': 'Designing your app architecture...',
    'architect/done':    'Spec ready — writing the code now...',
    'coder/running':     'Writing HTML, CSS, and JavaScript...',
    'coder/done':        'Code complete — reviewing for quality...',
    'reviewer/running':  'Checking for bugs and missing features...',
    'reviewer/done':     'All done! Loading your preview...',
  };

  const msgEl = pane.previewSwarm.querySelector('.pp-swarm-msg');
  if (msgEl) msgEl.textContent = msgs[`${stage}/${status}`] || '';
}

// ---- Mount ----

export function mountSend({ DEMO_MODE }) {
  _DEMO_MODE = !!DEMO_MODE;

  // Swarm toggle button
  swarmToggle = document.createElement('button');
  swarmToggle.type = 'button';
  swarmToggle.className = 'try-swarm-toggle';
  swarmToggle.textContent = '🐝 Swarm';
  swarmToggle.title = 'Multi-agent pipeline: Architect → Coder → Reviewer';
  swarmToggle.setAttribute('aria-pressed', 'false');
  swarmToggle.style.cssText = `
    background: transparent; border: 1px solid var(--border);
    padding: 6px 12px; border-radius: 6px; margin-right: 8px;
    font-size: 0.8rem; font-weight: 500; cursor: pointer;
    transition: all 0.15s ease; color: var(--text-muted);
    font-family: 'Geist', sans-serif;
  `;
  swarmToggle.addEventListener('click', () => {
    _swarmBuildMode = !_swarmBuildMode;
    swarmToggle.setAttribute('aria-pressed', _swarmBuildMode ? 'true' : 'false');
    swarmToggle.style.background = _swarmBuildMode ? 'rgba(0,208,132,0.1)' : 'transparent';
    swarmToggle.style.borderColor = _swarmBuildMode ? 'rgba(0,208,132,0.4)' : 'var(--border)';
    swarmToggle.style.color = _swarmBuildMode ? 'var(--signal)' : 'var(--text-muted)';
  });

  // Stage progress bar — shown during swarm run
  swarmStageBar = document.createElement('div');
  swarmStageBar.className = 'try-swarm-stage-bar';
  swarmStageBar.style.cssText = `
    display: none; margin-bottom: 12px;
    flex-direction: column; gap: 8px;
  `;

  const buttonsDiv = document.createElement('div');
  buttonsDiv.style.cssText = `display: flex; gap: 8px; font-size: 0.8rem;`;
  buttonsDiv.innerHTML = `
    <button class="swarm-stage" data-stage="architect" disabled>🏗️ Architect (spec)</button>
    <button class="swarm-stage" data-stage="coder" disabled>💻 Coder (build)</button>
    <button class="swarm-stage" data-stage="reviewer" disabled>🔍 Reviewer (check)</button>
  `;

  const statusEl = document.createElement('div');
  statusEl.style.cssText = `
    font-size: 0.75rem; color: var(--text-muted); padding: 6px 8px;
    background: rgba(0,208,132,0.05); border-radius: 4px; font-style: italic;
  `;
  statusEl.textContent = '⏳ Waiting to start...';

  swarmStageBar.appendChild(buttonsDiv);
  swarmStageBar.appendChild(statusEl);
  swarmStageBar._statusEl = statusEl;
}
