// main-checkpoint-dialog.js — "Save checkpoint" name popover + the
// applyCheckpointRestore flow that re-hydrates panes from a stored snapshot.
//
// The actual checkpoint store lives in [checkpoints.js](checkpoints.js).
// This module is the UI shell + restore orchestration glue.
//
// Public API:
//   openCheckpointNameDialog()
//     Triggered by the #checkpoint-btn click handler in main.js.
//   closeCheckpointNameDialog()
//     Programmatic close; also exposed so callers can collapse on Escape.
//   applyCheckpointRestore(checkpoint)
//     Used as the onRestore callback for openHistoryPanel.
//   mountCheckpointDialog({ paneByProvider, ensurePane, clearPanes,
//                           addCopyButtons, updateInlinePreview,
//                           syncTabbedTranscriptChrome,
//                           syncAllPaneFollowupRows, syncTrySessionChrome })
//     Stores tier-0c pane-cluster deps. All eight will collapse into a
//     `paneApi` object once tier 0c lands and exports them as a unit.

import { PROVIDERS } from './agent.js?v=20260602d';
import { backendKind, currentFolderName } from './fs.js?v=20260602d';
import { renderMarkdown } from './markdown.js?v=20260602d';
import {
  buildCheckpointEntry, saveCheckpoint, refreshHistoryPanel, closeHistoryPanel,
} from './checkpoints.js?v=20260602d';

let _paneByProvider = null;
let _ensurePane = () => null;
let _clearPanes = () => {};
let _addCopyButtons = () => {};
let _updateInlinePreview = () => {};
let _syncTabbedTranscriptChrome = () => {};
let _syncAllPaneFollowupRows = () => {};
let _syncTrySessionChrome = () => {};
let _renderInlineFileTabs = () => {};
let _updateInlineFileCountBadge = () => {};

function formatDate(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours === 0) return 'just now';
  if (hours === 1) return '1h ago';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  const d = new Date(timestamp);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function openCheckpointNameDialog() {
  let popover = document.querySelector('.ckpt-name-popover');
  if (!popover) {
    popover = document.createElement('div');
    popover.className = 'ckpt-name-popover';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Checkpoint name';
    const now = new Date();
    const formatted = now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    input.value = formatted;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'ckpt-save-btn';
    saveBtn.textContent = 'Save';

    const onSave = async () => {
      const name = input.value.trim();
      try {
        const entry = buildCheckpointEntry('manual', name, _paneByProvider, backendKind(), currentFolderName());
        await saveCheckpoint(entry);
        refreshHistoryPanel();
        closeCheckpointNameDialog();
      } catch (e) {
        console.warn('[ckpt] save failed', e);
      }
    };

    saveBtn.addEventListener('click', onSave);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onSave();
      if (e.key === 'Escape') closeCheckpointNameDialog();
    });

    popover.append(input, saveBtn);
    document.body.appendChild(popover);
  }

  const btn = document.getElementById('checkpoint-btn');
  if (btn) {
    const rect = btn.getBoundingClientRect();
    popover.style.left = rect.left + 'px';
    popover.style.top = (rect.bottom + 8) + 'px';
  }

  popover.style.display = 'flex';
  popover.querySelector('input').focus();
  popover.querySelector('input').select();

  const handleClickOutside = (e) => {
    if (!popover.contains(e.target) && !btn?.contains(e.target)) {
      closeCheckpointNameDialog();
      document.removeEventListener('click', handleClickOutside);
    }
  };
  document.addEventListener('click', handleClickOutside);
}

export function closeCheckpointNameDialog() {
  const popover = document.querySelector('.ckpt-name-popover');
  if (popover) popover.style.display = 'none';
}

export async function applyCheckpointRestore(checkpoint, { silent = false } = {}) {
  if ([..._paneByProvider.values()].some((p) => p.busy)) {
    if (!silent) alert('Cannot restore while a run is in progress.');
    return;
  }

  const name = checkpoint.name || `Checkpoint ${formatDate(checkpoint.timestamp)}`;
  if (!silent && !window.confirm(`Restore to "${name}"? Current workspace state will be replaced.`)) {
    return;
  }

  let fsa_warn = '';
  if (checkpoint.workspaceKind === 'fsa') {
    fsa_warn = 'Workspace folder references cannot be restored — reconnect the folder from the Workspace section.';
  }

  _clearPanes();

  for (const paneSnapshot of checkpoint.panes) {
    const provider = PROVIDERS.find((p) => p.id === paneSnapshot.providerId);
    if (!provider) {
      console.warn('[ckpt] provider not found:', paneSnapshot.providerId);
      continue;
    }

    const pane = _ensurePane(provider);

    for (const turnSnapshot of paneSnapshot.turns) {
      const turn = document.createElement('div');
      turn.className = 'turn';

      const userLine = document.createElement('div');
      userLine.className = 'turn-user';
      userLine.textContent = `› ${turnSnapshot.userText}`;

      const mdEl = document.createElement('div');
      mdEl.className = 'md';
      mdEl.innerHTML = renderMarkdown(turnSnapshot.accumulatedMd || '');
      _addCopyButtons(mdEl);

      if (turnSnapshot._truncated) {
        const warn = document.createElement('div');
        warn.style.cssText = 'padding: 10px; margin: 10px 0; background: rgba(255,165,0,0.1); border-left: 3px solid var(--signal); font-size: 0.875rem; color: var(--text-muted);';
        warn.textContent = '⚠️ Response was truncated (exceeded 500 KB)';
        mdEl.insertBefore(warn, mdEl.firstChild);
      }

      turn.append(userLine, mdEl);
      pane.body.insertBefore(turn, pane.cursor);

      const turnState = {
        userText: turnSnapshot.userText,
        mdEl,
        accumulatedMd: turnSnapshot.accumulatedMd || '',
      };
      pane.turns.push(turnState);
    }

    pane.history = paneSnapshot.history || [];
    pane.system = paneSnapshot.system || '';
    pane.tools = checkpoint.workspaceKind === 'fsa' ? [] : (paneSnapshot.tools || []);
    pane._activeFile = paneSnapshot.activeFile || null;

    // Rehydrate multi-file Map so the file-tab strip + active-file iframe
    // come back as the user left them. Drops the optional third tuple slot
    // (truncation marker — informational only).
    if (Array.isArray(paneSnapshot.files) && paneSnapshot.files.length) {
      pane._files = new Map(paneSnapshot.files.map(([n, c]) => [n, c]));
      _renderInlineFileTabs(pane);
      _updateInlineFileCountBadge(pane);
    } else {
      pane._files = null;
    }

    _updateInlinePreview(pane, true);
    _syncTabbedTranscriptChrome(pane);
    pane.syncFollowupBtn?.();

    _syncAllPaneFollowupRows();
  }

  _syncTrySessionChrome();
  if (!silent) closeHistoryPanel();

  if (fsa_warn) {
    const panel = document.querySelector('.ckpt-panel');
    if (panel) {
      const warn = document.createElement('div');
      warn.style.cssText = 'padding: 10px; margin: 10px 0; background: rgba(255,165,0,0.1); border-left: 3px solid var(--signal); font-size: 0.875rem;';
      warn.textContent = fsa_warn;
      const body = panel.querySelector('.ckpt-panel-body');
      body?.insertBefore(warn, body.firstChild);
    }
  }
}

export function mountCheckpointDialog({
  paneByProvider, ensurePane, clearPanes, addCopyButtons,
  updateInlinePreview, syncTabbedTranscriptChrome,
  syncAllPaneFollowupRows, syncTrySessionChrome,
  renderInlineFileTabs, updateInlineFileCountBadge,
}) {
  _paneByProvider = paneByProvider;
  _ensurePane = ensurePane;
  _clearPanes = clearPanes;
  _addCopyButtons = addCopyButtons;
  _updateInlinePreview = updateInlinePreview;
  _syncTabbedTranscriptChrome = syncTabbedTranscriptChrome;
  _syncAllPaneFollowupRows = syncAllPaneFollowupRows;
  _syncTrySessionChrome = syncTrySessionChrome;
  if (renderInlineFileTabs) _renderInlineFileTabs = renderInlineFileTabs;
  if (updateInlineFileCountBadge) _updateInlineFileCountBadge = updateInlineFileCountBadge;
}
