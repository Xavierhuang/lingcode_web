// main-leak-scan.js — pre-publish credential scanner.
//
// Runs 6 high-signal vendor regexes over each `scanTargets[i].text` before
// /try.html's ↗ Publish POSTs the share_payload + chat_history. If any match,
// shows a Cancel-by-default modal listing redacted snippets grouped by source;
// the caller's onProceed only fires after an explicit "Publish anyway" click.
//
// Public API:
//   scanForSecrets(text)  → [{ name, snippet, index }]
//   confirmPublishWithLeakScan({ scanTargets, onProceed, onCancel })
//     - scanTargets: [{ label: string, text: string }]
//     - zero matches across all targets → onProceed() fires synchronously, no modal
//     - any matches → modal opens; Cancel + Escape + outside-click → onCancel();
//       Publish-anyway button → onProceed()

const PATTERNS = [
  { name: 'AWS Access Key',     re: /\b(AKIA[0-9A-Z]{16})\b/g },
  { name: 'GitHub Token',       re: /\b(gh[pousr]_[A-Za-z0-9_]{36,})\b/g },
  // Negative lookahead `(?!ant-)` keeps this from also matching Anthropic
  // keys (which start `sk-ant-`) — Anthropic has its own dedicated pattern
  // below and we don't want a single key to fire two matches.
  { name: 'OpenAI API Key',     re: /\b(sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{40,})\b/g },
  { name: 'Anthropic API Key',  re: /\b(sk-ant-api03-[A-Za-z0-9_-]{50,})\b/g },
  { name: 'Stripe Secret Key',  re: /\b(sk_(?:live|test)_[A-Za-z0-9]{24,})\b/g },
  { name: 'Google API Key',     re: /\b(AIza[0-9A-Za-z_-]{35})\b/g },
];

export function scanForSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const matches = [];
  for (const { name, re } of PATTERNS) {
    // Reset lastIndex defensively — RegExp objects with the /g flag are
    // stateful across exec() calls, and this module's patterns are reused
    // across multiple scanForSecrets() invocations within a single publish.
    re.lastIndex = 0;
    let m;
    try {
      while ((m = re.exec(text)) !== null) {
        const full = m[1];
        // Redacted snippet: enough to recognize, not enough to copy-paste.
        const snippet = full.length > 10
          ? full.slice(0, 6) + '…' + full.slice(-4)
          : full[0] + '…';
        matches.push({ name, snippet, index: m.index });
      }
    } catch (e) {
      console.warn('[leak-scan] regex failed', name, e);
    }
  }
  return matches;
}

// Tracked element references so re-opening the modal cleanly closes the
// prior instance. Module-scope is fine — only one publish flow runs at a
// time.
let _modalEl = null;
let _backdropEl = null;
let _onKeydown = null;

function closeModal() {
  if (_modalEl) { _modalEl.remove(); _modalEl = null; }
  if (_backdropEl) { _backdropEl.remove(); _backdropEl = null; }
  if (_onKeydown) { document.removeEventListener('keydown', _onKeydown); _onKeydown = null; }
}

function buildModal(matchesByLabel, onProceed, onCancel) {
  // Build group sections — only labels that actually had matches show up.
  const groupHtml = [];
  for (const [label, matches] of matchesByLabel) {
    if (!matches.length) continue;
    const items = matches
      .map((m) =>
        `<li class="leak-scan-match"><strong>${escapeHtml(m.name)}</strong> — <code>${escapeHtml(m.snippet)}</code></li>`
      )
      .join('');
    groupHtml.push(
      `<div class="leak-scan-group"><div class="leak-scan-group-label">${escapeHtml(label)}:</div><ul>${items}</ul></div>`
    );
  }

  const modal = document.createElement('div');
  modal.className = 'leak-scan-modal';
  modal.setAttribute('role', 'alertdialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'leak-scan-title');
  modal.innerHTML =
    '<h3 id="leak-scan-title">⚠ Possible secrets detected</h3>' +
    '<p>Your prototype includes strings that look like API keys. Publishing makes the code public; chat history is saved to your account only (not the public viewer).</p>' +
    groupHtml.join('') +
    '<div class="leak-scan-actions">' +
      '<button type="button" class="btn leak-scan-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-warn leak-scan-proceed">Publish anyway</button>' +
    '</div>';

  const backdrop = document.createElement('div');
  backdrop.className = 'leak-scan-backdrop';

  document.body.append(backdrop, modal);
  _modalEl = modal;
  _backdropEl = backdrop;

  const cancelBtn = modal.querySelector('.leak-scan-cancel');
  const proceedBtn = modal.querySelector('.leak-scan-proceed');

  const fireCancel = () => { closeModal(); if (typeof onCancel === 'function') onCancel(); };
  const fireProceed = () => { closeModal(); if (typeof onProceed === 'function') onProceed(); };

  cancelBtn.addEventListener('click', fireCancel);
  proceedBtn.addEventListener('click', fireProceed);
  backdrop.addEventListener('click', fireCancel);
  _onKeydown = (e) => { if (e.key === 'Escape') fireCancel(); };
  document.addEventListener('keydown', _onKeydown);

  // Focus Cancel by default — destructive override requires explicit click.
  cancelBtn.focus();
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function confirmPublishWithLeakScan({ scanTargets, onProceed, onCancel }) {
  // Re-opening closes any stale instance — single-modal invariant.
  closeModal();

  const matchesByLabel = new Map();
  let total = 0;
  for (const t of (scanTargets || [])) {
    const ms = scanForSecrets(t && t.text);
    matchesByLabel.set(t.label || 'Source', ms);
    total += ms.length;
  }

  if (total === 0) {
    // No matches — invisible to the user. Fire proceed synchronously so the
    // caller's existing flow continues without an extra event-loop hop.
    if (typeof onProceed === 'function') onProceed();
    return;
  }

  try {
    buildModal(matchesByLabel, onProceed, onCancel);
  } catch (e) {
    // Defensive: if DOM construction fails (extremely unlikely after page
    // load), fail-open to proceed so the user isn't permanently stuck.
    console.warn('[leak-scan] modal build failed, proceeding without confirm', e);
    if (typeof onProceed === 'function') onProceed();
  }
}
