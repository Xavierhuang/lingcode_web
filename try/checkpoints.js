// Checkpoint / version history for /try.html
// Owns IndexedDB storage and the history panel DOM.

let _db = null;
let _sessionId = null;
let _lastAutoTs = 0;
let _panelOpen = false;

const DB_NAME = 'lingcode-try';
const DB_VERSION = 1;
const STORE_NAME = 'checkpoints';
const MAX_CHECKPOINTS_PER_SESSION = 50;
const MAX_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_ACCUMULATED_MD_KB = 500;
const SNAPSHOT_DEDUP_MS = 500;

export function getSessionId() {
  if (!_sessionId) {
    _sessionId = sessionStorage.getItem('lingcode.try.sessionId');
    if (!_sessionId) {
      _sessionId = crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2);
      sessionStorage.setItem('lingcode.try.sessionId', _sessionId);
    }
  }
  return _sessionId;
}

export async function openCheckpointsDB() {
  if (_db) return _db;

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('by_session', 'sessionId', { unique: false });
        store.createIndex('by_ts', 'timestamp', { unique: false });
      }
    };
  });
}

export function buildCheckpointEntry(kind, name, paneByProvider, workspaceKind, workspaceFolderName) {
  const panes = [];

  for (const [providerId, pane] of paneByProvider) {
    const turns = (pane.turns || []).map((tn) => {
      const md = tn.accumulatedMd || '';
      const maxBytes = MAX_ACCUMULATED_MD_KB * 1024;
      if (md.length > maxBytes) {
        return { userText: tn.userText, accumulatedMd: md.slice(0, maxBytes), _truncated: true };
      }
      return { userText: tn.userText, accumulatedMd: md };
    });

    // Serialize the multi-file Map as [filename, content] pairs so a
    // restored snapshot rebuilds the pane._files map (and the file-tab
    // strip). Same per-entry size guard as turns above to keep huge
    // multi-page projects from blowing the 25 MB ceiling.
    let files = null;
    if (pane._files && pane._files.size) {
      const maxBytes = MAX_ACCUMULATED_MD_KB * 1024;
      files = [];
      for (const [name, content] of pane._files) {
        const s = String(content || '');
        files.push(s.length > maxBytes
          ? [name, s.slice(0, maxBytes), { _truncated: true }]
          : [name, s]);
      }
    }

    panes.push({
      providerId,
      turns,
      history: pane.history || [],
      system: pane.system || '',
      tools: pane.tools || [],
      activeFile: pane._activeFile || null,
      files,
    });
  }

  return {
    id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2),
    sessionId: getSessionId(),
    timestamp: Date.now(),
    name: name || '',
    kind,
    panes,
    workspaceKind: workspaceKind || null,
    workspaceFolderName: workspaceFolderName || null,
  };
}

export async function saveCheckpoint(entry) {
  // Check if we should skip due to size or dedup
  if (entry.kind === 'auto') {
    const now = Date.now();
    if (now - _lastAutoTs < SNAPSHOT_DEDUP_MS) {
      return; // Skip duplicate auto-snapshot within 500ms
    }
    _lastAutoTs = now;
  }

  const jsonStr = JSON.stringify(entry);
  if (jsonStr.length > MAX_SIZE_BYTES) {
    console.warn('[ckpt] Checkpoint too large, skipping auto-save', jsonStr.length);
    return;
  }

  const db = await openCheckpointsDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.add(entry);

    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      // After save, prune if needed
      pruneCheckpoints().catch((e) => console.warn('[ckpt] prune failed', e));
      resolve();
    };

    tx.onerror = () => reject(tx.error);
  });
}

async function pruneCheckpoints() {
  const sessionId = getSessionId();
  const checkpoints = await loadCheckpoints(sessionId);

  if (checkpoints.length <= MAX_CHECKPOINTS_PER_SESSION) return;

  const db = await openCheckpointsDB();
  const toDelete = [];

  // Separate auto and manual
  const autos = checkpoints.filter((c) => c.kind === 'auto');
  const manuals = checkpoints.filter((c) => c.kind === 'manual');

  // Delete oldest autos first until we fit the limit
  let autoDeleteCount = autos.length - Math.max(0, MAX_CHECKPOINTS_PER_SESSION - manuals.length);
  for (let i = autos.length - 1; i >= 0 && autoDeleteCount > 0; i--) {
    toDelete.push(autos[i].id);
    autoDeleteCount--;
  }

  // If still over limit, start deleting oldest manuals
  if (toDelete.length + manuals.length > MAX_CHECKPOINTS_PER_SESSION) {
    const manualDeleteCount = toDelete.length + manuals.length - MAX_CHECKPOINTS_PER_SESSION;
    for (let i = manuals.length - 1; i >= 0 && manuals.length - i <= manualDeleteCount; i--) {
      toDelete.push(manuals[i].id);
    }
  }

  for (const id of toDelete) {
    await deleteCheckpoint(id);
  }
}

export async function loadCheckpoints(sessionId) {
  const db = await openCheckpointsDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('by_session');
    const req = index.getAll(sessionId);

    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const checkpoints = req.result;
      checkpoints.sort((a, b) => b.timestamp - a.timestamp); // newest first
      resolve(checkpoints);
    };

    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteCheckpoint(id) {
  const db = await openCheckpointsDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);

    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();

    tx.onerror = () => reject(tx.error);
  });
}

export async function clearSessionCheckpoints(sessionId) {
  const checkpoints = await loadCheckpoints(sessionId);
  for (const ckpt of checkpoints) {
    await deleteCheckpoint(ckpt.id);
  }
}

function formatDate(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (hours === 0) return 'just now';
  if (hours === 1) return '1h ago';
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;

  const d = new Date(timestamp);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatProviders(checkpoint) {
  if (!checkpoint.panes || checkpoint.panes.length === 0) return '';
  const providerIds = checkpoint.panes.map((p) => p.providerId);
  return providerIds.slice(0, 2).join(', ') + (providerIds.length > 2 ? `, +${providerIds.length - 2}` : '');
}

async function renderHistoryPanel() {
  const sessionId = getSessionId();
  const checkpoints = await loadCheckpoints(sessionId);

  const body = document.querySelector('.ckpt-panel-body');
  if (!body) return;

  body.innerHTML = '';

  if (checkpoints.length === 0) {
    body.innerHTML = '<div style="padding: 16px; color: var(--text-muted); font-size: 0.875rem;">No checkpoints yet. Run a prompt to create the first one.</div>';
    return;
  }

  for (const ckpt of checkpoints) {
    const entry = document.createElement('div');
    entry.className = 'ckpt-entry';

    const meta = document.createElement('div');
    meta.className = 'ckpt-entry-meta';

    const name = document.createElement('div');
    name.className = 'ckpt-entry-name';
    name.textContent = ckpt.name || `Checkpoint ${formatDate(ckpt.timestamp)}`;
    meta.appendChild(name);

    const badge = document.createElement('div');
    badge.className = `ckpt-entry-badge ${ckpt.kind}`;
    badge.textContent = ckpt.kind;
    meta.appendChild(badge);

    entry.appendChild(meta);

    const ts = document.createElement('div');
    ts.className = 'ckpt-entry-ts';
    ts.textContent = formatDate(ckpt.timestamp);
    entry.appendChild(ts);

    const panes = document.createElement('div');
    panes.className = 'ckpt-entry-panes';
    const paneCount = ckpt.panes?.length || 0;
    const providerStr = formatProviders(ckpt);
    panes.textContent = `${paneCount} pane${paneCount !== 1 ? 's' : ''} · ${providerStr}`;
    entry.appendChild(panes);

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'ckpt-restore';
    restoreBtn.textContent = 'Restore';
    restoreBtn.addEventListener('click', () => {
      window._onCheckpointRestore?.(ckpt);
    });
    entry.appendChild(restoreBtn);

    body.appendChild(entry);
  }
}

export function openHistoryPanel({ sessionId, onRestore }) {
  window._onCheckpointRestore = onRestore;

  let panel = document.querySelector('.ckpt-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'ckpt-panel';
    panel.innerHTML = `
      <div class="ckpt-panel-head">
        <span>Checkpoints</span>
        <button type="button" style="background: none; border: none; color: var(--text); font-size: 1.2rem; cursor: pointer; padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;" id="ckpt-close-btn">×</button>
      </div>
      <div class="ckpt-panel-body"></div>
      <div class="ckpt-panel-foot">
        <button type="button" style="padding: 6px 10px; background: rgba(28,28,28,.06); border: 1px solid var(--border); border-radius: 5px; color: var(--text); font-size: 0.8rem; cursor: pointer; width: 100%;" id="ckpt-clear-btn">Clear session history</button>
      </div>
    `;
    document.body.appendChild(panel);

    document.getElementById('ckpt-close-btn').addEventListener('click', closeHistoryPanel);
    document.getElementById('ckpt-clear-btn').addEventListener('click', async () => {
      if (window.confirm('Delete all checkpoints from this session?')) {
        await clearSessionCheckpoints(getSessionId());
        renderHistoryPanel();
      }
    });
  }

  panel.classList.add('open');
  _panelOpen = true;
  renderHistoryPanel();

  // Close on backdrop click (outside panel)
  const backdrop = document.createElement('div');
  backdrop.style.cssText = `position: fixed; inset: 0; z-index: 79; background: rgba(0,0,0,0.2);`;
  backdrop.addEventListener('click', closeHistoryPanel);
  backdrop.id = 'ckpt-backdrop';

  if (!document.getElementById('ckpt-backdrop')) {
    document.body.insertBefore(backdrop, panel);
  }
}

export function closeHistoryPanel() {
  const panel = document.querySelector('.ckpt-panel');
  if (panel) panel.classList.remove('open');
  const backdrop = document.getElementById('ckpt-backdrop');
  if (backdrop) backdrop.remove();
  _panelOpen = false;
}

export async function refreshHistoryPanel() {
  if (_panelOpen) {
    await renderHistoryPanel();
  }
}
