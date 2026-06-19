// main-workspace.js — workspace input picker (folder / files / paste / GitHub)
// + the "More options" outer disclosure that wraps Providers + Workspace.
//
// Public API:
//   renderWorkspaceState()
//     Repaint the workspace pill (folder name, suffix, save/zip/clear
//     visibility). Wired into fs.js's setOnChange at mount time and called
//     externally after a successful GitHub push to refresh dirty state.
//   showError(msg)
//     Render an error string into the workspace pill. Used by the template
//     loader (main.js) as an onError fallback.
//   openAdvanced (live ES-module export)
//     Re-assigned by mountWorkspace. Callers can `import { openAdvanced }`
//     and invoke it after mount to force-open the outer disclosure on
//     credential errors. Initial value is a no-op.
//   mountWorkspace({ promptEl })
//     Wire all listeners, build the disclosure, do the initial render.
//     `promptEl` is needed by the auto-action chips (deck/arch/readme) to
//     fill the prompt textarea.

import {
  fsaSupported, pickFolder, currentFolderName, backendKind, hasWorkspace, hasUnsavedWrites,
  loadFromInputFiles, loadFromDataTransfer, loadFromGitHub, loadFromPaste,
  clearWorkspace, downloadAsZip, setOnChange,
} from './fs.js?v=20260602d';
import { t } from './i18n.js?v=20260602d';
import { track } from './main-analytics.js?v=20260602d';
import { syncGitHubPushBtn } from './main-github-push.js?v=20260602d';

// Live binding — importers see the updated function after mountWorkspace runs.
export let openAdvanced = () => {};

// ---- DOM refs (resolved on mount) ----

let _workspaceToggle = null;
let _folderRow = null;
let _folderState = null;
let _folderTabs = null;
let _folderFoot = null;
let _folderActions = null;
let _footNote = null;
let _saveZipBtn = null;
let _clearBtn = null;
let _folderHint = null;
let _autoDeckBtn = null;
let _autoArchBtn = null;
let _autoReadmeBtn = null;
let _pickFolderBtn = null;
let _pickFilesBtn = null;
let _filesInput = null;
let _pasteInput = null;
let _pasteLoadBtn = null;
let _githubInput = null;
let _githubLoadBtn = null;
let _hasModernWorkspaceMarkup = false;

// ---- Public functions ----

export function renderWorkspaceState() {
  if (!_folderState || !_folderRow) return;
  if (!hasWorkspace()) {
    _folderState.textContent = t('folder.empty');
    _folderState.classList.remove('set-display');
    _folderRow.classList.remove('set');
    if (_folderFoot) _folderFoot.style.display = 'none';
    if (_folderActions) _folderActions.style.display = 'none';
    if (_saveZipBtn) _saveZipBtn.style.display = 'none';
    return;
  }
  const name = currentFolderName();
  const kind = backendKind();
  let suffix;
  if (kind === 'fsa') suffix = t('folder.set_suffix');
  else if (kind === 'github') suffix = t('folder.github_suffix');
  else suffix = t('folder.virtual_suffix');
  const display = kind === 'fsa' ? `${name}/  ${suffix}` : `${name}  ${suffix}`;
  _folderState.textContent = display;
  _folderState.classList.add('set-display');
  _folderRow.classList.add('set');
  if (_folderFoot) _folderFoot.style.display = 'flex';
  if (_folderActions) _folderActions.style.display = 'flex';
  if (_saveZipBtn) _saveZipBtn.style.display = (kind !== 'fsa' && hasUnsavedWrites()) ? 'inline-block' : 'none';
  if (_footNote) _footNote.textContent = '';
  syncGitHubPushBtn();
}

export function showError(msg) {
  if (!_folderState) return;
  _folderState.textContent = `error: ${msg}`;
  _folderState.classList.remove('set-display');
}

// ---- Mount ----

export function mountWorkspace({ promptEl }) {
  _workspaceToggle = document.getElementById('workspace-toggle');
  _folderRow   = document.getElementById('folder-row');
  _folderState = document.getElementById('folder-state');
  _folderTabs  = document.getElementById('folder-tabs');
  _folderFoot  = document.getElementById('folder-foot');
  _folderActions = document.getElementById('folder-actions');
  _footNote    = document.getElementById('folder-foot-note');
  _saveZipBtn  = document.getElementById('save-zip');
  _clearBtn    = document.getElementById('clear-workspace');
  _folderHint  = document.getElementById('folder-pane-hint');
  _autoDeckBtn   = document.getElementById('auto-deck');
  _autoArchBtn   = document.getElementById('auto-arch');
  _autoReadmeBtn = document.getElementById('auto-readme');

  _pickFolderBtn = document.getElementById('pick-folder');
  _pickFilesBtn  = document.getElementById('pick-files');
  _filesInput    = document.getElementById('files-input');
  _pasteInput    = document.getElementById('paste-input');
  _pasteLoadBtn  = document.getElementById('paste-load');
  _githubInput   = document.getElementById('github-input');
  _githubLoadBtn = document.getElementById('github-load');

  // Modern workspace markup is gated on #folder-tabs. Legacy markup (zh/try.html
  // still on the single-button layout) lacks it; the function and listeners
  // below fall back gracefully so the legacy page doesn't crash.
  _hasModernWorkspaceMarkup = !!_folderTabs;

  // Workspace section is collapsible — same pattern as Providers. Default
  // closed for everyone; explicit toggles persist. Hidden via inline display
  // rather than [hidden] because .try-folder { display: flex } would override.
  if (_workspaceToggle && _folderRow) {
    const WS_OPEN_KEY = 'lingcode.try.workspaceOpen';
    const setWorkspaceOpen = (open, persist = true) => {
      _folderRow.style.display = open ? '' : 'none';
      _folderRow.hidden = !open;
      _workspaceToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (persist) localStorage.setItem(WS_OPEN_KEY, open ? '1' : '0');
    };
    setWorkspaceOpen(localStorage.getItem(WS_OPEN_KEY) === '1', /* persist */ false);
    _workspaceToggle.addEventListener('click', () => setWorkspaceOpen(_folderRow.hidden));
  }

  // ---- "More options" outer disclosure (wraps Providers + Workspace) ----
  // Lovable-style empty state hides chrome until the user asks for it. The
  // inner per-section toggles still persist independently — opening this
  // outer disclosure restores the user's last per-section state.
  (() => {
    const wrap = document.getElementById('advanced-disclosure');
    const summary = wrap?.querySelector('.try-advanced-summary');
    if (!wrap || !summary) return;
    const ADV_OPEN_KEY = 'lingcode.try.advancedOpen';
    const setOpen = (open, persist = true) => {
      wrap.setAttribute('aria-expanded', open ? 'true' : 'false');
      summary.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (persist) localStorage.setItem(ADV_OPEN_KEY, open ? '1' : '0');
    };
    setOpen(localStorage.getItem(ADV_OPEN_KEY) === '1', /* persist */ false);
    summary.addEventListener('click', () => {
      const wasOpen = wrap.getAttribute('aria-expanded') === 'true';
      setOpen(!wasOpen);
    });
    // Reassign the live ES-module export so consumers (showHint, entitlement
    // error path) see the real implementation. force=true forces open without
    // overwriting the user's saved preference.
    openAdvanced = (force = false) => {
      if (force) setOpen(true, /* persist */ false);
      else setOpen(true, true);
    };
  })();

  setOnChange(renderWorkspaceState);
  renderWorkspaceState();

  // Folder mode: FSA when supported, webkitdirectory upload otherwise.
  const handleFolderPick = async () => {
    try {
      if (fsaSupported()) {
        await pickFolder();
      } else {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.multiple = true;
        const picked = new Promise((res) => { input.onchange = () => res(input.files); });
        input.click();
        const files = await picked;
        if (files && files.length) await loadFromInputFiles(files);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') showError(err.message);
    }
  };
  _pickFolderBtn?.addEventListener('click', handleFolderPick);

  if (_hasModernWorkspaceMarkup) {
    // Tab switcher: show the active pane, hide the others.
    _folderTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-mode]');
      if (!btn) return;
      for (const b of _folderTabs.querySelectorAll('button')) b.classList.toggle('active', b === btn);
      const mode = btn.dataset.mode;
      for (const pane of _folderRow.querySelectorAll('.try-folder-pane')) {
        pane.classList.toggle('active', pane.dataset.pane === mode);
      }
    });

    // Hide-the-FSA-only-affordances notice on Safari/Firefox.
    if (!fsaSupported() && _folderHint) {
      _folderHint.textContent = t('folder.no_fsa_hint');
    }

    // Files mode.
    _pickFilesBtn.addEventListener('click', () => _filesInput.click());
    _filesInput.addEventListener('change', async () => {
      if (!_filesInput.files || !_filesInput.files.length) return;
      try {
        await loadFromInputFiles(_filesInput.files);
        _filesInput.value = '';
      } catch (err) { showError(err.message); }
    });

    // Paste mode.
    _pasteLoadBtn.addEventListener('click', async () => {
      const text = _pasteInput.value;
      if (!text.trim()) { showError(t('folder.paste_empty')); return; }
      try {
        await loadFromPaste(text);
      } catch (err) { showError(err.message); }
    });

    // GitHub mode.
    _githubLoadBtn.addEventListener('click', async () => {
      const v = _githubInput.value.trim();
      if (!v) { showError(t('folder.github_empty')); return; }
      _githubLoadBtn.disabled = true;
      const prevLabel = _githubLoadBtn.textContent;
      _githubLoadBtn.textContent = t('folder.github_loading');
      try {
        const { fileCount, truncated } = await loadFromGitHub(v);
        _footNote.textContent = truncated
          ? t('folder.github_truncated', fileCount)
          : t('folder.github_loaded', fileCount);
      } catch (err) {
        showError(err.message);
      } finally {
        _githubLoadBtn.disabled = false;
        _githubLoadBtn.textContent = prevLabel;
      }
    });
    _githubInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); _githubLoadBtn.click(); }
    });

    // Drop target — the whole row, regardless of which tab is active.
    ['dragenter', 'dragover'].forEach((ev) => {
      _folderRow.addEventListener(ev, (e) => {
        if (!e.dataTransfer) return;
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault();
          _folderRow.classList.add('drag-over');
        }
      });
    });
    ['dragleave', 'drop'].forEach((ev) => {
      _folderRow.addEventListener(ev, () => _folderRow.classList.remove('drag-over'));
    });
    _folderRow.addEventListener('drop', async (e) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      try {
        await loadFromDataTransfer(e.dataTransfer);
      } catch (err) { showError(err.message); }
    });

    // Save / clear actions.
    _saveZipBtn.addEventListener('click', async () => {
      try { await downloadAsZip(); } catch (err) { showError(err.message); }
    });
    _clearBtn.addEventListener('click', () => clearWorkspace());

    // Auto-actions: one click → curated prompt that tells the agent to introspect
    // the workspace via list_files/read_file and produce a polished deliverable.
    const fillPrompt = (text) => {
      promptEl.value = text;
      promptEl.focus();
      promptEl.dispatchEvent(new Event('input', { bubbles: true }));
      promptEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    _autoDeckBtn.addEventListener('click', () => { track('auto_action_clicked', { action: 'deck' }); fillPrompt(t('auto.deck_prompt')); });
    _autoArchBtn.addEventListener('click', () => { track('auto_action_clicked', { action: 'arch' }); fillPrompt(t('auto.arch_prompt')); });
    _autoReadmeBtn.addEventListener('click', () => { track('auto_action_clicked', { action: 'readme' }); fillPrompt(t('auto.readme_prompt')); });
  }
}
