// rubric.js — user-customizable quality metrics for the Verdict card.
//
// Four levels of customization, all persisted in localStorage so the user's
// last-picked rubric sticks across visits:
//
//   1. Preset chips      — Default / Concise / Beginner-friendly / etc.
//   2. Free-form text    — "I care about edge cases over code length"
//   3. Weighted criteria — name + weight pairs, judge returns multi-scores
//   4. User-written JS   — score(response) function, run client-side
//
// Modes 1 + 2 reuse the existing single-score judge (just append text to
// the rubric). Mode 3 changes the judge's response schema. Mode 4 skips
// the LLM entirely — everything happens in the browser.

const STORAGE_KEY = 'lingcode.try.rubric';

// ---- Presets (mode 1) --------------------------------------------------

export const PRESETS = [
  { id: 'default',     label: 'Default',          desc: '' },
  { id: 'concise',     label: 'Concise',          desc: 'Above all else, prefer the SHORTEST working code. Penalize verbosity, comments, and explanatory prose.' },
  { id: 'beginner',    label: 'Beginner-friendly', desc: 'Prefer clear variable names, helpful comments, simple control flow over clever one-liners. Penalize density.' },
  { id: 'performance', label: 'Performance',      desc: 'Prefer responses that pre-compute, avoid redundant DOM thrash, batch operations, and use efficient data structures.' },
  { id: 'readability', label: 'Readability',      desc: 'Prefer responses with intuitive structure, sensible naming, and code a code-reviewer would approve without comments.' },
  { id: 'security',    label: 'Security-aware',   desc: 'Prefer responses that escape user input, avoid eval, validate at boundaries, and don\'t leak secrets to logs.' },
];

// ---- Default weighted criteria (mode 3) --------------------------------
// Names are localized at first-state-creation time only. Returning users
// keep whatever they had stored — no destructive migration.

function getDefaultCriteria(t) {
  return [
    { name: t ? t('rubric.criteria.correctness')  : 'Correctness',  weight: 50 },
    { name: t ? t('rubric.criteria.code_quality') : 'Code quality', weight: 30 },
    { name: t ? t('rubric.criteria.conciseness')  : 'Conciseness',  weight: 20 },
  ];
}

// ---- Default code template (mode 4) ------------------------------------

export const CODE_TEMPLATE =
`// User-written scorer. Runs entirely in your browser — no LLM call.
// Receives one response object: { id, providerName, text, prompt }
// Return: { score: 0..10, note?: 'one short sentence' }
//
// Below is a starter — replace with whatever you want to measure.

function score(r) {
  // Example: shorter responses score higher.
  const lines = r.text.split('\\n').length;
  const s = lines < 60 ? 9 : lines < 120 ? 6 : 3;
  return { score: s, note: lines + ' lines' };
}
`;

// ---- Storage -----------------------------------------------------------

export function loadRubric(t) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState(t);
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.mode) return defaultState(t);
    return { ...defaultState(t), ...parsed };
  } catch {
    return defaultState(t);
  }
}

export function saveRubric(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { /* quota exceeded — silently drop */ }
}

function defaultState(t) {
  return {
    mode: 'quick',          // quick | weighted | code
    presetId: 'default',
    customText: '',
    criteria: getDefaultCriteria(t),
    code: CODE_TEMPLATE,
  };
}

// ---- Build a single-score judge prompt addendum (modes 1 + 2) ----------

/// Returns a string to append to the judge's existing system prompt.
/// Empty string for 'default' preset with no custom text — the base
/// rubric already covers the common case.
export function buildSingleScoreAddendum(state) {
  const parts = [];
  if (state.mode === 'quick') {
    if (state.presetId && state.presetId !== 'default') {
      const preset = PRESETS.find((p) => p.id === state.presetId);
      if (preset?.desc) parts.push('Additional rubric instruction: ' + preset.desc);
    }
    if (state.customText && state.customText.trim()) {
      parts.push('User-supplied rubric: ' + state.customText.trim());
    }
  }
  return parts.length ? '\n\n' + parts.join('\n\n') : '';
}

// ---- Mode 3: weighted criteria judge -----------------------------------

/// Builds the system prompt for weighted scoring. The judge returns a
/// per-criterion score per response; we compute the weighted total
/// client-side so the math is auditable.
export function buildWeightedSystemPrompt(criteria) {
  const lines = ['You are an expert code reviewer judging multiple AI responses to the same coding prompt.', ''];
  lines.push('Score each response 0-10 on every criterion below. Be honest — give low scores to bad responses.');
  lines.push('');
  for (const c of criteria) {
    lines.push(`- "${c.name}"`);
  }
  lines.push('');
  lines.push('Output STRICT JSON only. No prose before or after. Schema:');
  lines.push('{');
  lines.push('  "verdicts": [');
  lines.push('    {');
  lines.push('      "id": "<providerId>",');
  lines.push('      "scores": { ' + criteria.map((c) => `"${c.name}": <0..10>`).join(', ') + ' },');
  lines.push('      "note": "<one sentence summary, <= 100 chars>"');
  lines.push('    }, ...');
  lines.push('  ]');
  lines.push('}');
  return lines.join('\n');
}

/// Combine per-criterion scores with user-defined weights into a 0-10
/// total. Picks the verdict with the highest total as the winner.
export function applyWeights(judgeResult, criteria) {
  if (!judgeResult || !Array.isArray(judgeResult.verdicts)) return null;
  const sumWeight = criteria.reduce((a, c) => a + (Number(c.weight) || 0), 0) || 1;
  const totals = judgeResult.verdicts.map((v) => {
    let t = 0;
    for (const c of criteria) {
      const s = Number(v.scores?.[c.name] ?? 0);
      t += (Number(c.weight) || 0) * s;
    }
    return { id: v.id, total: t / sumWeight, scores: v.scores || {}, note: v.note || '' };
  });
  totals.sort((a, b) => b.total - a.total);
  const winner = totals[0];
  return {
    verdicts: totals.map((x) => ({ id: x.id, score: Math.round(x.total * 10) / 10, note: x.note, scores: x.scores })),
    winner: winner?.id,
    winner_reason: winner ? `Highest weighted score: ${winner.total.toFixed(1)}/10.` : '',
    criteria,
  };
}

// ---- Mode 4: user-written JS scorer ------------------------------------

/// Runs the user's `score(response)` function on each response and builds
/// a verdict in the same shape as the LLM judge. Catches errors per
/// response so one bad response doesn't kill the whole verdict.
// ---- Rubric panel UI ---------------------------------------------------

/// Renders the rubric panel into `host` (a container element). Calls
/// `onChange()` whenever the user picks a new rubric or hits "Re-judge".
/// Re-renders in place when state changes — callers don't need to manage
/// the DOM directly.
export function renderRubricPanel(host, t, onChange) {
  const state = loadRubric(t);
  host.innerHTML = '';
  host.className = 'try-rubric-panel';

  const head = document.createElement('div');
  head.className = 'rubric-head';
  head.innerHTML = `
    <span class="rubric-title">${escapeHtml(t('rubric.title'))}</span>
    <div class="rubric-mode-tabs" role="tablist">
      ${['quick', 'weighted', 'code'].map((m) => `
        <button type="button" data-mode="${m}" class="rubric-mode-tab${state.mode === m ? ' active' : ''}">${escapeHtml(t('rubric.mode.' + m))}</button>
      `).join('')}
    </div>`;
  host.append(head);

  const body = document.createElement('div');
  body.className = 'rubric-body';
  host.append(body);

  for (const tab of head.querySelectorAll('.rubric-mode-tab')) {
    tab.addEventListener('click', () => {
      state.mode = tab.dataset.mode;
      saveRubric(state);
      renderRubricPanel(host, t, onChange);
      onChange(state);
    });
  }

  if (state.mode === 'quick')    renderQuickMode(body, state, t, onChange);
  if (state.mode === 'weighted') renderWeightedMode(body, state, t, onChange);
  if (state.mode === 'code')     renderCodeMode(body, state, t, onChange);
  return state;
}

function renderQuickMode(body, state, t, onChange) {
  const chips = document.createElement('div');
  chips.className = 'rubric-chips';
  for (const p of PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rubric-chip' + (state.presetId === p.id ? ' active' : '');
    btn.textContent = t('rubric.preset.' + p.id);
    btn.title = p.desc;
    btn.addEventListener('click', () => {
      state.presetId = p.id;
      saveRubric(state);
      for (const c of chips.querySelectorAll('.rubric-chip')) c.classList.remove('active');
      btn.classList.add('active');
      onChange(state);
    });
    chips.append(btn);
  }
  body.append(chips);

  const customWrap = document.createElement('div');
  customWrap.className = 'rubric-custom';
  customWrap.innerHTML = `
    <label class="rubric-custom-label">${escapeHtml(t('rubric.custom_label'))}</label>
    <textarea class="rubric-custom-input" rows="2" placeholder="${escapeHtml(t('rubric.custom_placeholder'))}">${escapeHtml(state.customText || '')}</textarea>
    <button type="button" class="rubric-apply">${escapeHtml(t('rubric.apply'))}</button>`;
  body.append(customWrap);
  const ta = customWrap.querySelector('textarea');
  customWrap.querySelector('.rubric-apply').addEventListener('click', () => {
    state.customText = ta.value;
    saveRubric(state);
    onChange(state);
  });
}

function renderWeightedMode(body, state, t, onChange) {
  const intro = document.createElement('p');
  intro.className = 'rubric-intro';
  intro.textContent = t('rubric.weighted_intro');
  body.append(intro);

  const list = document.createElement('div');
  list.className = 'rubric-criteria-list';
  function rebuild() {
    list.innerHTML = '';
    state.criteria.forEach((c, idx) => {
      const row = document.createElement('div');
      row.className = 'rubric-criterion';
      row.innerHTML = `
        <input type="text" class="crit-name" value="${escapeHtml(c.name)}" placeholder="${escapeHtml(t('rubric.criterion_name'))}">
        <input type="number" class="crit-weight" value="${Number(c.weight) || 0}" min="0" max="100" step="5">
        <span class="crit-pct">%</span>
        <button type="button" class="crit-del" aria-label="Remove">×</button>`;
      row.querySelector('.crit-name').addEventListener('input', (e) => { c.name = e.target.value; saveRubric(state); });
      row.querySelector('.crit-weight').addEventListener('input', (e) => { c.weight = Number(e.target.value) || 0; saveRubric(state); });
      row.querySelector('.crit-del').addEventListener('click', () => { state.criteria.splice(idx, 1); saveRubric(state); rebuild(); });
      list.append(row);
    });
    const sum = state.criteria.reduce((a, c) => a + (Number(c.weight) || 0), 0);
    const total = document.createElement('div');
    total.className = 'rubric-criteria-total';
    total.textContent = t('rubric.weights_total', sum);
    if (sum !== 100) total.classList.add('warn');
    list.append(total);
  }
  rebuild();
  body.append(list);

  const actions = document.createElement('div');
  actions.className = 'rubric-actions';
  actions.innerHTML = `
    <button type="button" class="rubric-add-crit">+ ${escapeHtml(t('rubric.add_criterion'))}</button>
    <button type="button" class="rubric-apply">${escapeHtml(t('rubric.apply'))}</button>`;
  actions.querySelector('.rubric-add-crit').addEventListener('click', () => {
    state.criteria.push({ name: t('rubric.new_criterion', state.criteria.length + 1), weight: 0 });
    saveRubric(state);
    rebuild();
  });
  actions.querySelector('.rubric-apply').addEventListener('click', () => {
    saveRubric(state);
    onChange(state);
  });
  body.append(actions);
}

function renderCodeMode(body, state, t, onChange) {
  const intro = document.createElement('p');
  intro.className = 'rubric-intro';
  intro.textContent = t('rubric.code_intro');
  body.append(intro);

  const ta = document.createElement('textarea');
  ta.className = 'rubric-code-input';
  ta.spellcheck = false;
  ta.value = state.code || CODE_TEMPLATE;
  ta.rows = 14;
  body.append(ta);

  const actions = document.createElement('div');
  actions.className = 'rubric-actions';
  actions.innerHTML = `
    <button type="button" class="rubric-reset-code">${escapeHtml(t('rubric.reset_template'))}</button>
    <button type="button" class="rubric-apply">${escapeHtml(t('rubric.apply'))}</button>`;
  actions.querySelector('.rubric-reset-code').addEventListener('click', () => {
    ta.value = CODE_TEMPLATE;
    state.code = CODE_TEMPLATE;
    saveRubric(state);
  });
  actions.querySelector('.rubric-apply').addEventListener('click', () => {
    state.code = ta.value;
    saveRubric(state);
    onChange(state);
  });
  body.append(actions);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function runCodeJudge(code, prompt, responses) {
  let scoreFn;
  try {
    // Build a function that, when called, evals the user's code in its
    // own scope and returns the resulting `score` symbol. `new Function`
    // skips the surrounding closure so the user can't reach app state.
    const factory = new Function(`${code}\nreturn typeof score === 'function' ? score : null;`);
    scoreFn = factory();
  } catch (e) {
    return { error: 'Rubric code failed to parse: ' + (e?.message || e) };
  }
  if (typeof scoreFn !== 'function') {
    return { error: 'Rubric code must define a function named `score`.' };
  }

  const verdicts = [];
  let bestScore = -Infinity;
  let winnerId = null;
  for (const r of responses) {
    let v = { score: 0, note: '' };
    try {
      const out = scoreFn({ id: r.id, providerName: r.providerName || r.id, text: r.text, prompt });
      if (out && typeof out === 'object') {
        v.score = Math.max(0, Math.min(10, Number(out.score) || 0));
        v.note = String(out.note || '').slice(0, 200);
      } else if (typeof out === 'number') {
        v.score = Math.max(0, Math.min(10, out));
      }
    } catch (e) {
      v.note = 'error: ' + (e?.message || e).slice(0, 80);
    }
    if (v.score > bestScore) { bestScore = v.score; winnerId = r.id; }
    verdicts.push({ id: r.id, score: v.score, note: v.note });
  }
  return {
    verdicts,
    winner: winnerId,
    winner_reason: winnerId ? `Top score: ${bestScore.toFixed(1)}/10 from your scorer.` : '',
  };
}
