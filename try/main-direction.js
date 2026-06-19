// main-direction.js — "Direction summary" scope-confirmation gate for /try.
//
// After the user's FIRST prompt of a fresh session, an AI call produces a
// structured 5-field scope summary. The user reviews/edits the fields inline,
// then either Confirms (build to that scope) or Revises (regenerate with a
// note). runDirectionGate() renders the panel and resolves its Promise only on
// a terminal choice:
//   { approved:true, summary, scopeBlock }   — Confirm
//   { approved:false }                        — Cancel/close
//
// The confirmed summary is turned into an "[Approved scope]" block by
// buildScopeBlock() and prepended to the build prompt by the caller (main.js),
// so both the normal per-provider run and the swarm Architect build to it.

import { runAgent } from './agent.js?v=20260602d';
import { runDesignGate, buildDesignBlock } from './main-design.js?v=20260602d';
import {
  postChatMessage, postChatQuestion,
} from './main-chat.js?v=20260602d';
import { advanceStep } from './main-build-checklist.js?v=20260602d';

// Field order + labels match the design. `key` is the JSON key the model emits.
const FIELDS = [
  { key: 'whatItIs',     label: 'What it is' },
  { key: 'whoFor',       label: "Who it's for" },
  { key: 'coreWorkflow', label: 'Core workflow' },
  { key: 'keyExtras',    label: 'Key extras' },
  { key: 'outOfScope',   label: 'Out of scope for v1' },
];

const EMPTY_SUMMARY = { whatItIs: '', whoFor: '', coreWorkflow: '', keyExtras: '', outOfScope: '' };

// Lovable-style full-screen scope focus: while `body.try-scope-focus` is set
// (the caller adds it around the gate), hide the marketing chrome and center the
// scope/clarify panels as a focused card. Injected once.
// Render the scope/clarify/design gate as a full-screen modal overlay (dimmed,
// blurred backdrop, centered card). This covers the whole viewport regardless of
// page layout — no dependence on #workspace visibility or hiding individual
// sections. Injected once; body.try-scope-focus locks background scroll.
function ensureScopeFocusStyle() {
  if (document.getElementById('lc-scope-focus-style')) return;
  const st = document.createElement('style');
  st.id = 'lc-scope-focus-style';
  st.textContent =
    'body.try-scope-focus{overflow:hidden!important}' +
    '.lc-gate-overlay{position:fixed;inset:0;z-index:10000;display:flex;' +
    'align-items:flex-start;justify-content:center;overflow:auto;padding:6vh 20px;' +
    'background:rgba(8,8,14,0.6);-webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px)}' +
    '.lc-gate-overlay>*{margin:auto!important;max-width:760px;width:100%}' +
    // Shared loading animations for every "waiting" state in the gate flow.
    '@keyframes lc-spin{to{transform:rotate(360deg)}}' +
    '.lc-spin{display:inline-block;width:13px;height:13px;margin-right:8px;vertical-align:-2px;' +
    'border:2px solid var(--border);border-top-color:var(--accent,#7c3aed);border-radius:50%;' +
    'animation:lc-spin .7s linear infinite}' +
    '@keyframes lc-pulse{0%,100%{opacity:.4}50%{opacity:1}}' +
    '.lc-pulse{animation:lc-pulse 1.3s ease-in-out infinite}' +
    '@keyframes lc-panel-in{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}';
  document.head.appendChild(st);
}

// Wrap a gate panel in a fixed full-screen overlay and mount it on <body>.
export function mountGateOverlay(panel) {
  ensureScopeFocusStyle();
  const overlay = document.createElement('div');
  overlay.className = 'lc-gate-overlay';
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  return overlay;
}

const DIRECTION_SUMMARY_SYSTEM = `You are a product scoping assistant in a browser code playground.
Given a user's build request, infer a concrete, thorough, buildable v1 scope and output ONLY valid JSON — no prose, no markdown fences.

Be specific and detailed — name actual screens, features, data fields, and interactions the way a real product brief would. Don't undersell: "coreWorkflow" should read like a walkthrough of the main experience, and "keyExtras" should list several concrete features.

Schema (every value is plain text):
{
  "whatItIs": "what this app/site is, named specifically (1 sentence)",
  "whoFor": "the primary audience or user",
  "coreWorkflow": "the main experience in detail — the key screen(s) and the specific things a user sees and does there, with concrete data/fields where relevant (2-4 sentences)",
  "keyExtras": "4-6 concrete supporting features, separated by semicolons",
  "outOfScope": "what is intentionally NOT in v1 (several items)"
}

Stay faithful to the user's request: "whatItIs" MUST name the exact thing the user asked for (echo their core subject), and every other field must elaborate on THAT product — never substitute a different app idea. Infer sensible specifics; keep it tight enough to build in one pass. Return ONLY the JSON object.`;

// Robust parse, mirroring swarm.js's Architect fallback: strict parse first,
// then extract the first {...} block, then fall back to empty editable fields
// so the panel always renders.
// Strip leading/trailing markdown bold markers (**) that models sometimes
// emit even when the system prompt says "plain text".
function cleanField(s) {
  return String(s || '').replace(/^\*+\s*/, '').replace(/\s*\*+$/, '').trim();
}

function parseSummaryJson(text) {
  let obj = null;
  try {
    obj = JSON.parse(String(text || '').trim());
  } catch {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch {} }
  }
  return {
    whatItIs: cleanField(obj?.whatItIs),
    whoFor: cleanField(obj?.whoFor),
    coreWorkflow: cleanField(obj?.coreWorkflow),
    keyExtras: cleanField(obj?.keyExtras),
    outOfScope: cleanField(obj?.outOfScope),
  };
}

// Cheap faithfulness check: do any meaningful words from the user's prompt
// appear in the core summary fields? This is a miss-DETECTOR, not a semantic
// grader — a single overlap is enough to treat the summary as on-topic. It only
// flags the rare total miss (a blank parse, or a coherent-but-unrelated spec),
// and stays quiet on normal extensive summaries that mention the prompt's subject.
const SUMMARY_STOPWORDS = new Set([
  'make', 'build', 'create', 'want', 'need', 'please', 'give', 'show', 'using',
  'with', 'that', 'this', 'from', 'your', 'have', 'some', 'like', 'just', 'will',
  'should', 'would', 'could', 'into', 'about', 'app', 'application', 'site',
  'website', 'web', 'page', 'simple', 'basic', 'really', 'very', 'thing', 'stuff',
]);

function summaryReflectsPrompt(prompt, s) {
  const core = `${s.whatItIs} ${s.coreWorkflow} ${s.keyExtras}`.toLowerCase();
  if (!core.trim()) return false; // blank summary → definitely a miss
  const words = [...new Set((String(prompt).toLowerCase().match(/[a-z0-9]{3,}/g) || []))]
    .filter((w) => !SUMMARY_STOPWORDS.has(w));
  if (words.length === 0) return true; // nothing concrete to match on — don't block
  return words.some((w) => core.includes(w));
}

// Single one-shot model call (no tools / no executor → runAgent returns after
// one turn). Accumulates text deltas and parses the JSON summary. On the initial
// generation only, if the result is blank or clearly ignores the prompt, re-asks
// once with a firmer instruction before giving up.
async function generateSummary({ prompt, provider, apiKey, priorSummary = null, note = null }) {
  let userPrompt = `User's build request:\n${prompt}`;
  if (priorSummary && note) {
    userPrompt +=
      `\n\nPrevious summary (JSON):\n${JSON.stringify(priorSummary)}` +
      `\n\nUser revision note: ${note}` +
      `\n\nRegenerate the full summary incorporating the note. Output ONLY the JSON object.`;
  }

  const askOnce = async (extra) => {
    let text = '';
    await runAgent({
      provider,
      apiKey,
      userPrompt: extra ? userPrompt + extra : userPrompt,
      system: DIRECTION_SUMMARY_SYSTEM,
      tools: [],
      abortSignal: null,
      onEvent: (e) => { if (e.kind === 'text') text += e.text; },
    });
    return parseSummaryJson(text);
  };

  let summary = await askOnce();
  // Faithfulness retry — initial generation only (a revise is user-directed, so
  // honor it as-is). At most one extra turn, and only when the first result is a
  // genuine miss; normal summaries never trigger it.
  if (!priorSummary && !summaryReflectsPrompt(prompt, summary)) {
    const focus =
      `\n\nIMPORTANT: Scope ONLY the request above ("${String(prompt).slice(0, 200).replace(/\s+/g, ' ').trim()}"). ` +
      `Every field must describe THAT product — do not substitute a different app idea.`;
    summary = await askOnce(focus);
  }
  return summary;
}

// Turn a confirmed summary into the prompt preamble the agents build against.
export function buildScopeBlock(s) {
  return [
    '[Approved scope — build to this; the user reviewed and confirmed it]',
    `What it is: ${s.whatItIs}`,
    `Who it's for: ${s.whoFor}`,
    `Core workflow: ${s.coreWorkflow}`,
    `Key extras: ${s.keyExtras}`,
    `Out of scope for v1: ${s.outOfScope}`,
  ].join('\n');
}

// ---- Panel ----
// Styling intentionally mirrors #lc-architect-panel (var(--border)/--accent),
// inserted just before #panes so it occupies the same spot the panes will.
function buildPanel({ onConfirm, onRevise, onCancel }) {
  const panel = document.createElement('div');
  panel.id = 'lc-direction-panel';
  // Solid card — it floats on a dimmed modal backdrop, so no translucent bg.
  panel.style.cssText = [
    'box-sizing:border-box', 'padding:24px 26px',
    'border:1px solid var(--border)', 'border-radius:16px',
    'background:var(--bg-card, var(--bg, #ffffff))',
    'font-family:system-ui,-apple-system,sans-serif', 'color:var(--text)',
    'animation:lc-panel-in 0.35s ease',
    'margin-bottom:8px',
  ].join(';');

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;';
  const title = document.createElement('div');
  title.textContent = 'Direction summary';
  title.style.cssText = 'font-weight:700;font-size:13px;color:var(--accent,#7c3aed);text-transform:uppercase;letter-spacing:0.04em;';
  const headerRight = document.createElement('div');
  headerRight.style.cssText = 'display:flex;align-items:center;gap:12px;';
  const editablePill = document.createElement('span');
  editablePill.textContent = 'Editable';
  editablePill.style.cssText = 'font-size:11px;color:var(--text-muted);';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Cancel');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'border:none;background:none;color:var(--text-muted);font-size:14px;cursor:pointer;line-height:1;padding:0;';
  closeBtn.addEventListener('click', () => onCancel());
  headerRight.append(editablePill, closeBtn);
  header.append(title, headerRight);

  // Status line (loading / error messaging)
  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;color:var(--text-muted);margin-bottom:12px;display:none;';

  // Fields
  const fieldsWrap = document.createElement('div');
  fieldsWrap.style.cssText = 'display:flex;flex-direction:column;gap:12px;';
  const fieldEls = {};
  for (const f of FIELDS) {
    const row = document.createElement('div');
    const label = document.createElement('div');
    label.textContent = f.label;
    label.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px;';
    const ta = document.createElement('textarea');
    // Prose-heavy fields hold a few sentences now that summaries are extensive;
    // give them more height so the content isn't clipped to two lines.
    ta.rows = (f.key === 'coreWorkflow' || f.key === 'keyExtras') ? 4 : 2;
    ta.style.cssText = [
      'width:100%', 'box-sizing:border-box', 'resize:vertical',
      'padding:8px 10px', 'border:1px solid var(--border)', 'border-radius:8px',
      'background:var(--bg,#0d0d0f)', 'color:var(--text)',
      'font-family:inherit', 'font-size:13px', 'line-height:1.45',
    ].join(';');
    row.append(label, ta);
    fieldsWrap.append(row);
    fieldEls[f.key] = ta;
  }

  // Footer question
  const question = document.createElement('div');
  question.textContent = 'Does this capture what you want to build?';
  question.style.cssText = 'font-weight:700;font-size:14px;margin:18px 0 10px;';

  // Radio options
  const choiceName = 'lc-dir-choice';
  function optionCard(value, labelText, badge, subtitle, checked) {
    const card = document.createElement('label');
    card.style.cssText = [
      'display:flex', 'gap:10px', 'align-items:flex-start',
      'padding:12px 14px', 'border:1px solid var(--border)', 'border-radius:10px',
      'cursor:pointer', 'margin-bottom:8px',
    ].join(';');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = choiceName;
    radio.value = value;
    radio.checked = !!checked;
    radio.style.cssText = 'margin-top:2px;';
    const text = document.createElement('div');
    const head = document.createElement('div');
    head.style.cssText = 'font-weight:600;font-size:13px;display:flex;align-items:center;gap:8px;';
    head.append(document.createTextNode(labelText));
    if (badge) {
      const b = document.createElement('span');
      b.textContent = badge;
      b.style.cssText = 'font-size:10px;font-weight:600;color:var(--accent,#7c3aed);border:1px solid var(--accent,#7c3aed);border-radius:999px;padding:1px 7px;text-transform:uppercase;letter-spacing:0.03em;';
      head.append(b);
    }
    const sub = document.createElement('div');
    sub.textContent = subtitle;
    sub.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:2px;';
    text.append(head, sub);
    card.append(radio, text);
    return { card, radio };
  }

  const confirmOpt = optionCard('confirm', 'Confirm and continue', 'Recommended', 'Approve this scope and move to design', true);
  const reviseOpt = optionCard('revise', 'Revise this summary', '', 'Loop back with updated scope', false);

  // Revise note (shown only when "Revise" is selected)
  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.placeholder = 'What should change? (optional)';
  noteInput.style.cssText = [
    'width:100%', 'box-sizing:border-box', 'display:none',
    'padding:8px 10px', 'margin-bottom:10px',
    'border:1px solid var(--border)', 'border-radius:8px',
    'background:var(--bg,#0d0d0f)', 'color:var(--text)',
    'font-family:inherit', 'font-size:13px',
  ].join(';');

  // Confirm / regenerate button
  const actionBtn = document.createElement('button');
  actionBtn.type = 'button';
  actionBtn.textContent = 'Confirm & continue';
  actionBtn.style.cssText = [
    'padding:10px 18px', 'border:none', 'border-radius:8px',
    'background:var(--accent,#7c3aed)', 'color:#fff',
    'font-family:inherit', 'font-size:13px', 'font-weight:600', 'cursor:pointer',
  ].join(';');

  function syncMode() {
    const revising = reviseOpt.radio.checked;
    noteInput.style.display = revising ? 'block' : 'none';
    actionBtn.textContent = revising ? 'Regenerate summary' : 'Confirm & continue';
  }
  confirmOpt.radio.addEventListener('change', syncMode);
  reviseOpt.radio.addEventListener('change', syncMode);

  function readFields() {
    const out = {};
    for (const f of FIELDS) out[f.key] = fieldEls[f.key].value.trim();
    return out;
  }

  actionBtn.addEventListener('click', () => {
    if (reviseOpt.radio.checked) {
      onRevise(readFields(), noteInput.value.trim());
    } else {
      onConfirm(readFields());
    }
  });

  panel.append(header, status, fieldsWrap, question, confirmOpt.card, reviseOpt.card, noteInput, actionBtn);

  // Render inline inside the chat history column (not as a fixed modal overlay).
  ensureScopeFocusStyle(); // ensure animation keyframe is injected
  const chatHistory = document.getElementById('try-chat-history');
  if (chatHistory) {
    chatHistory.appendChild(panel);
    // Smooth-scroll the new panel into view within the chat column.
    requestAnimationFrame(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }

  // Controller the gate uses to drive the panel.
  return {
    setFields(summary) {
      for (const f of FIELDS) fieldEls[f.key].value = (summary && summary[f.key]) || '';
    },
    setBusy(label) {
      actionBtn.disabled = !!label;
      actionBtn.style.opacity = label ? '0.6' : '1';
      actionBtn.style.cursor = label ? 'default' : 'pointer';
      if (label) {
        actionBtn.textContent = label;
        status.textContent = '';
        const sp = document.createElement('span');
        sp.className = 'lc-spin';
        status.append(sp, document.createTextNode(label));
        status.style.display = 'block';
      } else {
        status.style.display = 'none';
        syncMode();
      }
    },
    showStatus(msg) { status.textContent = msg; status.style.display = 'block'; },
    resetToConfirm() { confirmOpt.radio.checked = true; reviseOpt.radio.checked = false; syncMode(); },
    remove() { panel.remove(); },
  };
}

// ---- Clarifying questions ----
// After the scope is confirmed, ask 0-3 multiple-choice questions, but ONLY
// where the spec has a genuine product fork. The model returns [] when the
// scope is already clear enough to build well.
const CLARIFY_SYSTEM = `You are a product scoping assistant in a browser code playground. You are given a user's build request and an approved scope summary. Identify clarifying questions whose answers would MATERIALLY change how the app is built — genuine product forks or ambiguities, not trivia.

Output ONLY valid JSON — an array (possibly empty), no prose, no markdown fences:
[
  {
    "question": "the question to ask the user",
    "options": [
      { "label": "short choice (1-5 words)", "description": "what choosing this means", "recommended": true }
    ]
  }
]

Rules: 0-3 questions. Each question has 2-4 options. Exactly one option per question has "recommended": true. Ask only what you cannot reasonably assume from the request. If nothing is genuinely ambiguous, return [].`;

function parseQuestionsJson(text) {
  let arr = null;
  try {
    arr = JSON.parse(String(text || '').trim());
  } catch {
    const m = String(text || '').match(/\[[\s\S]*\]/);
    if (m) { try { arr = JSON.parse(m[0]); } catch {} }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((q) => q && typeof q.question === 'string' && Array.isArray(q.options))
    .slice(0, 3)
    .map((q) => ({
      question: q.question.trim(),
      options: q.options.slice(0, 4).map((o) => ({
        label: String(o?.label || '').trim() || 'Option',
        description: String(o?.description || '').trim(),
        recommended: !!o?.recommended,
      })),
    }))
    .filter((q) => q.question && q.options.length >= 2);
}

async function generateQuestions({ prompt, summary, provider, apiKey }) {
  const userPrompt = `User's build request:\n${prompt}\n\nApproved scope (JSON):\n${JSON.stringify(summary)}`;
  let text = '';
  await runAgent({
    provider,
    apiKey,
    userPrompt,
    system: CLARIFY_SYSTEM,
    tools: [],
    abortSignal: null,
    onEvent: (e) => { if (e.kind === 'text') text += e.text; },
  });
  return parseQuestionsJson(text);
}

// Append answered clarifications to the scope block so the build honors them.
function clarificationsBlock(answers) {
  if (!answers || !answers.length) return '';
  const lines = ['', '[Clarifications — the user answered these before building]'];
  for (const a of answers) { lines.push(`Q: ${a.question}`); lines.push(`A: ${a.answer}`); }
  return lines.join('\n');
}

// One-at-a-time wizard. Resolves to an array of { question, answer } once every
// question is answered, or null if the user closes it.
function runQuestionWizard({ questions }) {
  return new Promise((resolve) => {
    const answers = [];
    let idx = 0;

    const panel = document.createElement('div');
    panel.id = 'lc-clarify-panel';
    // Solid card on the dimmed modal backdrop.
    panel.style.cssText = [
      'box-sizing:border-box', 'padding:24px 26px',
      'border:1px solid var(--border)', 'border-radius:16px',
      'background:var(--bg-card, var(--bg, #ffffff))',
      'box-shadow:0 16px 56px rgba(0,0,0,0.28)',
      'font-family:system-ui,-apple-system,sans-serif', 'color:var(--text)',
    ].join(';');
    const overlay = mountGateOverlay(panel);

    const cleanup = () => { overlay.remove(); };

    function renderQuestion() {
      panel.innerHTML = '';
      const q = questions[idx];

      // Header: lead-in / progress + close
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px;';
      const lead = document.createElement('div');
      lead.style.cssText = 'font-size:13px;color:var(--text-muted);';
      lead.textContent = idx === 0
        ? 'Locked in. One quick thing before I build —'
        : (questions.length > 1 ? `Question ${idx + 1} of ${questions.length}` : '');
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', 'Skip questions');
      closeBtn.textContent = '✕';
      closeBtn.style.cssText = 'border:none;background:none;color:var(--text-muted);font-size:14px;cursor:pointer;line-height:1;padding:0;';
      closeBtn.addEventListener('click', () => { cleanup(); resolve(null); });
      header.append(lead, closeBtn);

      // Question text
      const qText = document.createElement('div');
      qText.textContent = q.question;
      qText.style.cssText = 'font-weight:700;font-size:14px;margin-bottom:12px;';

      // Option cards
      const name = `lc-clarify-${idx}`;
      const radios = [];
      const optsWrap = document.createElement('div');
      optsWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
      for (const opt of q.options) {
        const card = document.createElement('label');
        card.style.cssText = 'display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border:1px solid var(--border);border-radius:10px;cursor:pointer;';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = name;
        radio.style.cssText = 'margin-top:2px;';
        radio.addEventListener('change', () => { sendBtn.disabled = false; sendBtn.style.opacity = '1'; sendBtn.style.cursor = 'pointer'; });
        radios.push({ radio, opt });
        const text = document.createElement('div');
        const head = document.createElement('div');
        head.style.cssText = 'font-weight:600;font-size:13px;display:flex;align-items:center;gap:8px;';
        head.append(document.createTextNode(opt.label));
        if (opt.recommended) {
          const b = document.createElement('span');
          b.textContent = 'Recommended';
          b.style.cssText = 'font-size:10px;font-weight:600;color:var(--accent,#7c3aed);border:1px solid var(--accent,#7c3aed);border-radius:999px;padding:1px 7px;';
          head.append(b);
        }
        const sub = document.createElement('div');
        sub.textContent = opt.description;
        sub.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:2px;';
        text.append(head, sub);
        card.append(radio, text);
        optsWrap.append(card);
      }

      // Send button (disabled until a choice is made)
      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.textContent = idx + 1 < questions.length ? 'Send' : 'Send & build';
      sendBtn.disabled = true;
      sendBtn.style.cssText = 'margin-top:14px;padding:10px 18px;border:none;border-radius:8px;background:var(--accent,#7c3aed);color:#fff;font-family:inherit;font-size:13px;font-weight:600;opacity:0.6;cursor:default;';
      sendBtn.addEventListener('click', () => {
        const chosen = radios.find((r) => r.radio.checked);
        if (!chosen) return;
        answers.push({ question: q.question, answer: chosen.opt.label });
        idx += 1;
        if (idx < questions.length) {
          renderQuestion();
        } else {
          cleanup();
          resolve(answers);
        }
      });

      panel.append(header, qText, optsWrap, sendBtn);
    }

    renderQuestion();
  });
}

// Entry point awaited by the #send handler. Generates the summary, renders the
// gate, then (on confirm) asks any clarifying questions before resolving with a
// scope block. Resolves only when the user makes a terminal choice.
// Chat-driven direction gate (replaces the modal overlay approach).
// All interactions happen in the persistent #try-chat-col column.
export async function runDirectionGate({ prompt, provider, apiKey }) {
  // ── 1. Generate scope summary ──────────────────────────────────────────────
  const analyzingMsg = postChatMessage('Analyzing your idea…', 'status');
  let summary;
  try {
    summary = await generateSummary({ prompt, provider, apiKey });
  } catch (e) {
    // Quota / sign-in errors must NOT fail silently into an empty summary.
    // agent.js already pops the upgrade paywall on a 402; here we add a visible
    // chat message and abort the gate so the build doesn't proceed with an
    // empty scope. Other (transient) errors keep the lenient empty fallback.
    if (e && (e.quota || e.upgradeRequired || e.needsSignin)) {
      analyzingMsg?.remove();
      postChatMessage(e.message || "You've reached your limit.", 'error');
      throw e;
    }
    summary = { ...EMPTY_SUMMARY };
  }
  analyzingMsg?.remove();
  // analyze step done → plan step becomes active (checklist advance)
  advanceStep('analyze');

  // ── 2. Show formatted editable summary panel (confirm / revise loop) ────────
  // Uses the modal overlay card (buildPanel) so each field is editable.
  // The "Analyzing…" chat message above gives feedback while it generates;
  // the panel then appears on top for the confirm/revise interaction.
  let finalSummary = await new Promise((resolve) => {
    let ctrl = null;

    function showPanel(s) {
      if (ctrl) ctrl.remove();
      ctrl = buildPanel({
        onConfirm: (edited) => {
          ctrl.remove();
          // Echo a brief confirmation into chat so there's a record.
          postChatMessage(`Building: ${edited.whatItIs}`, 'status');
          resolve(edited);
        },
        onRevise: async (edited, note) => {
          ctrl.setBusy('Regenerating…');
          let updated = edited;
          try {
            updated = await generateSummary({
              prompt, provider, apiKey,
              priorSummary: edited, note,
            });
          } catch { /* keep edited fields on error */ }
          ctrl.setFields(updated);
          ctrl.setBusy(null);
          ctrl.resetToConfirm();
        },
        onCancel: () => {
          ctrl.remove();
          resolve(s); // proceed with what we had
        },
      });
      ctrl.setFields(s);
    }

    showPanel(summary);
  });

  // ── 3. Clarifying questions (one at a time in chat) ─────────────────────────
  advanceStep('plan'); // plan done → platforms active
  let questions = [];
  try { questions = await generateQuestions({ prompt, summary: finalSummary, provider, apiKey }); }
  catch { questions = []; }

  const answers = [];
  for (const q of questions) {
    const result = await postChatQuestion(q.question, q.options, { skippable: true });
    if (!result.skipped) answers.push({ question: q.question, answer: result.answer });
  }

  advanceStep('platforms'); // platforms done → data active
  advanceStep('data');      // data done → designs active

  // ── 4. Design gate ──────────────────────────────────────────────────────────
  let chosen = null;
  console.log('[build-style] runDesignGate starting…');
  try {
    chosen = await runDesignGate({ prompt, summary: finalSummary, provider, apiKey });
    console.log('[build-style] runDesignGate resolved →', chosen ? `"${chosen.name}"` : 'null (no style picked)');
  } catch (e) {
    console.error('[build-style] runDesignGate threw:', e);
    chosen = null;
  }

  return {
    approved: true,
    summary: finalSummary,
    scopeBlock: buildScopeBlock(finalSummary)
      + clarificationsBlock(answers)
      + buildDesignBlock(chosen),
    clarifications: answers,
    design: chosen,
  };
}
