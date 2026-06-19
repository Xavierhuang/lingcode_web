// website/try/main-build-checklist.js
// 8-step build checklist sidebar + progress bar controller.
// Imported by main.js. CSS lives in try.html <style>.

const STEPS = [
  { id: 'analyze',   label: 'Analyze idea' },
  { id: 'plan',      label: 'Confirm build plan' },
  { id: 'platforms', label: 'Set platforms' },
  { id: 'data',      label: 'Configure data sync' },
  { id: 'designs',   label: 'Generate designs' },
  { id: 'scaffold',  label: 'Scaffold components' },
  { id: 'interact',  label: 'Build interactions' },
  { id: 'polish',    label: 'Final polish' },
];

// 'pending' | 'active' | 'done'
const state = Object.fromEntries(STEPS.map(s => [s.id, 'pending']));

let _checklistEl = null;
let _fillEl      = null;
let _labelEl     = null;
let _barEl       = null;
// Set when a build produces no runnable output — flips the progress label from
// the "% · ETA / ✓ Complete" track to an error message so we never claim a
// failed build succeeded. Cleared by resetChecklist() on the next build.
let _failed      = false;
let _failMessage = '';

// ─── Mount ────────────────────────────────────────────────────────────────────

/**
 * Call once after DOM is ready. Grabs the element refs and renders the initial state.
 */
export function mountChecklist() {
  _checklistEl = document.getElementById('try-checklist');
  _fillEl      = document.getElementById('try-progress-fill');
  _labelEl     = document.getElementById('try-progress-label');
  _barEl       = document.getElementById('try-progress-bar');
  _render();
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function _render() {
  _renderProgress();
  _renderSteps();
}

function _renderProgress() {
  const doneCount = STEPS.filter(s => state[s.id] === 'done').length;
  const pct = Math.round((doneCount / STEPS.length) * 100);

  if (_fillEl) {
    _fillEl.style.width = pct + '%';
  }
  if (_labelEl) {
    _labelEl.style.color = _failed ? '#ef4444' : '';
    if (_failed) {
      _labelEl.textContent = _failMessage;
    } else if (pct === 100) {
      _labelEl.textContent = '✓ Complete';
    } else {
      const remaining = STEPS.length - doneCount;
      // rough 1.5 min / step heuristic
      const etaMin = Math.max(1, Math.round(remaining * 1.5));
      _labelEl.textContent = `${pct}% · ~${etaMin} min remaining`;
    }
  }
  if (_barEl) {
    _barEl.setAttribute('aria-valuenow', String(pct));
    // valuetext mirrors the visible label so screen readers announce the same
    // human-readable status (incl. the failed message), not just a bare number.
    _barEl.setAttribute('aria-valuetext', _labelEl ? _labelEl.textContent : `${pct}%`);
  }
}

function _renderSteps() {
  if (!_checklistEl) return;

  _checklistEl.innerHTML = STEPS.map(s => {
    const st   = state[s.id];
    const icon = st === 'done' ? '✓' : st === 'failed' ? '✕' : st === 'active' ? '●' : '○';
    return (
      `<div class="cl-step cl-step--${st}" data-step="${s.id}">` +
        `<span class="cl-icon">${icon}</span>` +
        `<span class="cl-label">${_escHtml(s.label)}</span>` +
      `</div>`
    );
  }).join('');
}

function _escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── State API ────────────────────────────────────────────────────────────────

/**
 * Set a step's state and re-render.
 * @param {string} stepId  — one of the STEPS[*].id values
 * @param {'pending'|'active'|'done'} newState
 */
export function setStep(stepId, newState) {
  if (!(stepId in state)) return;
  state[stepId] = newState;
  _render();
}

/**
 * Mark `stepId` as done and activate the next step (if any).
 * Convenience wrapper — equivalent to setStep(id,'done') + setStep(next,'active').
 * @param {string} stepId
 */
export function advanceStep(stepId) {
  setStep(stepId, 'done');
  const idx = STEPS.findIndex(s => s.id === stepId);
  if (idx >= 0 && idx + 1 < STEPS.length) {
    setStep(STEPS[idx + 1].id, 'active');
  }
}

/**
 * Mark the build as failed. Stamps the first not-yet-done step with a 'failed'
 * state (red ✕) and swaps the progress ETA for `message`, so a build that
 * produced no runnable output never shows "✓ Complete" or a forever-counting
 * "~2 min remaining". Cleared on the next build via resetChecklist().
 * @param {string} [message]
 */
export function failChecklist(message) {
  _failed = true;
  _failMessage = message || "Build didn't finish — revise and try again.";
  const firstUndone = STEPS.find(s => state[s.id] !== 'done');
  if (firstUndone) state[firstUndone.id] = 'failed';
  _render();
}

/**
 * Returns the current progress as a 0–100 integer.
 * @returns {number}
 */
export function getProgressPct() {
  const done = STEPS.filter(s => state[s.id] === 'done').length;
  return Math.round((done / STEPS.length) * 100);
}

/**
 * Reset all steps to 'pending' and re-render.
 * Called when the user starts a new session.
 */
export function resetChecklist() {
  STEPS.forEach(s => { state[s.id] = 'pending'; });
  _failed = false;
  _failMessage = '';
  _render();
}

/**
 * Mark every step done (progress → 100% → "✓ Complete"). Called when reopening
 * an already-built saved project, so the checklist reflects a finished build
 * instead of resetting to "0% · ~N min remaining".
 */
export function completeChecklist() {
  STEPS.forEach(s => { state[s.id] = 'done'; });
  _failed = false;
  _failMessage = '';
  _render();
}
