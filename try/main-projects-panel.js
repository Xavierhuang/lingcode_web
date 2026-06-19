// main-projects-panel.js — persistent project save/load/delete panel.
//
// The store (saveProject / listProjects / loadProject / deleteProject)
// lives in [projects.js](projects.js); this module is just the UI shell
// + the snapshot-restore orchestration.
//
// Public API:
//   openProjectsPanel() — wired to the #projects-btn click handler.
//   mountProjectsPanel({ paneByProvider, ensurePane, clearPanes,
//                        addCopyButtons, updateInlinePreview,
//                        syncTabbedTranscriptChrome, syncTrySessionChrome })
//     Stores tier-0c pane-cluster deps. Same shape as
//     mountCheckpointDialog — once tier 0c lands these collapse into a
//     single paneApi object.

import { PROVIDERS } from './agent.js?v=20260602d';
import { renderMarkdown } from './markdown.js?v=20260602d';
import { selected, saveSelection } from './main-providers.js?v=20260602d';
import { buildCheckpointEntry } from './checkpoints.js?v=20260602d';
import { saveProject, listProjects, loadProject, deleteProject } from './projects.js?v=20260602d';

let _paneByProvider = null;
let _ensurePane = () => null;
let _clearPanes = () => {};
let _addCopyButtons = () => {};
let _updateInlinePreview = () => {};
let _syncTabbedTranscriptChrome = () => {};
let _syncTrySessionChrome = () => {};

let _projectsPanelEl = null;

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

function restoreProjectSnapshot(snapshot) {
  for (const pane of _paneByProvider.values()) {
    if (pane.busy) { alert('A generation is in progress — wait for it to finish before loading a project.'); return; }
  }
  _clearPanes();
  for (const snap of (snapshot.panes || [])) {
    const provider = PROVIDERS.find(p => p.id === snap.providerId);
    if (!provider) continue;
    selected.add(snap.providerId);
    const pane = _ensurePane(provider);
    for (const turnSnap of (snap.turns || [])) {
      const turnEl = document.createElement('div');
      turnEl.className = 'turn';
      const userEl = document.createElement('div');
      userEl.className = 'turn-user';
      userEl.textContent = turnSnap.userText || '';
      const mdEl = document.createElement('div');
      mdEl.className = 'md';
      mdEl.innerHTML = renderMarkdown(turnSnap.accumulatedMd || '');
      _addCopyButtons(mdEl);
      turnEl.append(userEl, mdEl);
      pane.body.appendChild(turnEl);
      pane.turns.push({ userText: turnSnap.userText || '', mdEl, accumulatedMd: turnSnap.accumulatedMd || '' });
    }
    pane.history = snap.history || [];
    pane.system = snap.system || '';
    pane.tools = snap.tools || [];
    pane._activeFile = snap.activeFile || null;
    _updateInlinePreview(pane);
    _syncTabbedTranscriptChrome(pane);
    pane.syncFollowupBtn?.();
  }
  saveSelection(selected);
  _syncTrySessionChrome();
}

function closeProjectsPanel() {
  if (_projectsPanelEl) _projectsPanelEl.hidden = true;
}

export async function openProjectsPanel() {
  if (!_projectsPanelEl) {
    const panel = document.createElement('div');
    panel.className = 'projects-panel';
    panel.hidden = true;

    const header = document.createElement('div');
    header.className = 'projects-header';
    const titleEl = document.createElement('span');
    titleEl.className = 'projects-title';
    titleEl.textContent = 'Projects';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'projects-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closeProjectsPanel);
    header.append(titleEl, closeBtn);

    const saveSection = document.createElement('div');
    saveSection.className = 'projects-save-section';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Project name…';
    nameInput.className = 'projects-name-input';
    const notesInput = document.createElement('textarea');
    notesInput.className = 'projects-notes-input';
    notesInput.placeholder = 'Notes (optional)…';
    notesInput.rows = 2;
    const saveBtn = document.createElement('button');
    saveBtn.className = 'ckpt-save-btn projects-save-btn';
    saveBtn.textContent = 'Save current session';
    const saveStatus = document.createElement('p');
    saveStatus.className = 'projects-save-status';
    saveSection.append(nameInput, notesInput, saveBtn, saveStatus);

    const listHeader = document.createElement('div');
    listHeader.className = 'projects-list-header';
    const listHeaderTitle = document.createElement('span');
    listHeaderTitle.textContent = 'Saved Projects';
    const sortSelect = document.createElement('select');
    sortSelect.className = 'projects-sort-select';
    ['Date ↓', 'Date ↑', 'Name A–Z'].forEach((label, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = label;
      sortSelect.appendChild(o);
    });
    sortSelect.addEventListener('change', () => refreshProjectsList(_projectsPanelEl?.querySelector('.projects-search-input')?.value || ''));
    listHeader.append(listHeaderTitle, sortSelect);

    const searchInput = document.createElement('input');
    searchInput.className = 'projects-search-input';
    searchInput.type = 'text';
    searchInput.placeholder = 'Filter projects…';
    searchInput.addEventListener('input', () => refreshProjectsList(searchInput.value));

    const listEl = document.createElement('div');
    listEl.className = 'projects-list';

    panel.append(header, saveSection, listHeader, searchInput, listEl);
    document.body.appendChild(panel);
    _projectsPanelEl = panel;

    saveBtn.addEventListener('click', async () => {
      const firstUserText = [..._paneByProvider.values()][0]?.turns[0]?.userText || '';
      const name = nameInput.value.trim() || firstUserText.slice(0, 60).trim() || 'Untitled';
      const hasPanes = [..._paneByProvider.values()].some(p => p.turns.length > 0);
      if (!hasPanes) { saveStatus.textContent = 'Nothing to save — run a prompt first.'; return; }
      saveBtn.disabled = true;
      saveStatus.textContent = 'Saving…';
      try {
        const entry = buildCheckpointEntry('project', name, _paneByProvider, null, null);
        entry.id = crypto.randomUUID();
        entry.notes = notesInput.value.trim();
        await saveProject(entry);
        nameInput.value = '';
        notesInput.value = '';
        saveStatus.textContent = `✓ Saved "${name}"`;
        setTimeout(() => { saveStatus.textContent = ''; }, 3000);
        await refreshProjectsList(_projectsPanelEl?.querySelector('.projects-search-input')?.value || '');
      } catch (err) {
        if (err.code === 'cap_reached') saveStatus.textContent = `Limit reached (${err.max} projects). Delete one first.`;
        else saveStatus.textContent = 'Save failed.';
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  const nameInput = _projectsPanelEl.querySelector('.projects-name-input');
  if (!nameInput.value) {
    const firstUserText = [..._paneByProvider.values()][0]?.turns[0]?.userText || '';
    nameInput.value = firstUserText.slice(0, 60).trim();
  }

  await refreshProjectsList();
  _projectsPanelEl.hidden = false;
}

function renderProjectDetail(container, proj) {
  container.innerHTML = '';

  // Tab bar
  const tabs = ['Preview', 'Files', 'Code', 'More'];
  const tabBar = document.createElement('div');
  tabBar.className = 'proj-tabs';

  const contents = tabs.map(label => {
    const btn = document.createElement('button');
    btn.className = 'proj-tab';
    btn.type = 'button';
    btn.textContent = label;
    btn.dataset.tab = label.toLowerCase();
    tabBar.appendChild(btn);

    const content = document.createElement('div');
    content.className = 'proj-tab-content';
    content.hidden = true;
    content.dataset.tabContent = label.toLowerCase();
    return { btn, content };
  });

  container.appendChild(tabBar);
  contents.forEach(({ content }) => container.appendChild(content));

  // Wire tab switching
  function showTab(name) {
    contents.forEach(({ btn, content }) => {
      const active = btn.dataset.tab === name;
      btn.classList.toggle('proj-tab--active', active);
      content.hidden = !active;
    });
  }
  tabBar.addEventListener('click', e => {
    const btn = e.target.closest('.proj-tab');
    if (btn) showTab(btn.dataset.tab);
  });

  // ── Preview tab ──────────────────────────────────────────────────────────
  const previewContent = contents.find(c => c.btn.dataset.tab === 'preview')?.content;
  if (previewContent) {
    const pane0 = proj.panes?.[0];
    const lastTurn = pane0?.turns?.[pane0.turns.length - 1];
    const md = lastTurn?.accumulatedMd || '';
    const html = _extractHtmlFromMd(md);

    if (html) {
      const frame = document.createElement('iframe');
      frame.className = 'proj-preview-frame';
      frame.sandbox = 'allow-scripts allow-same-origin';
      frame.srcdoc = html;
      previewContent.appendChild(frame);
    } else {
      const msg = document.createElement('p');
      msg.style.cssText = 'color:var(--text-muted,#6b7280);font-size:13px;padding:8px 0;';
      msg.textContent = 'No preview available for this project.';
      previewContent.appendChild(msg);
    }
  }

  // ── Files tab ────────────────────────────────────────────────────────────
  const filesContent = contents.find(c => c.btn.dataset.tab === 'files')?.content;
  if (filesContent) {
    const pane0 = proj.panes?.[0];
    const lastTurn = pane0?.turns?.[pane0.turns.length - 1];
    const md = lastTurn?.accumulatedMd || '';
    // Extract filenames from code-fence headers: ```filename.ext
    const fileNames = [...md.matchAll(/```([^\n`]+)\n/g)]
      .map(m => m[1].trim())
      .filter(n => n && !['html', 'css', 'js', 'javascript', 'typescript', 'ts', 'json', 'bash', 'sh', 'python', 'py', 'jsx', 'tsx'].includes(n.toLowerCase()));

    if (fileNames.length) {
      const list = document.createElement('ul');
      list.style.cssText = 'list-style:none;padding:0;margin:0;font-size:13px;display:flex;flex-direction:column;gap:4px;';
      fileNames.forEach(name => {
        const li = document.createElement('li');
        li.style.cssText = 'padding:5px 8px;border-radius:6px;background:var(--surface-raised,#f9f8f4);font-family:monospace;font-size:12px;';
        li.textContent = name;
        list.appendChild(li);
      });
      filesContent.appendChild(list);
    } else {
      const msg = document.createElement('p');
      msg.style.cssText = 'color:var(--text-muted,#6b7280);font-size:13px;padding:8px 0;';
      msg.textContent = 'No named files found in this project.';
      filesContent.appendChild(msg);
    }
  }

  // ── Code tab ─────────────────────────────────────────────────────────────
  const codeContent = contents.find(c => c.btn.dataset.tab === 'code')?.content;
  if (codeContent) {
    const pane0 = proj.panes?.[0];
    const lastTurn = pane0?.turns?.[pane0.turns.length - 1];
    const raw = lastTurn?.accumulatedMd || '(empty)';
    const pre = document.createElement('pre');
    pre.style.cssText = 'font-size:11px;overflow:auto;max-height:200px;background:var(--surface-raised,#f9f8f4);padding:10px;border-radius:8px;margin:0;white-space:pre-wrap;word-break:break-all;';
    pre.textContent = raw.slice(0, 4000) + (raw.length > 4000 ? '\n…(truncated)' : '');
    codeContent.appendChild(pre);
  }

  // ── More tab ─────────────────────────────────────────────────────────────
  const moreContent = contents.find(c => c.btn.dataset.tab === 'more')?.content;
  if (moreContent) {
    const deleteBtn2 = document.createElement('button');
    deleteBtn2.type = 'button';
    deleteBtn2.textContent = '🗑 Delete project';
    deleteBtn2.style.cssText = 'padding:6px 12px;border-radius:7px;background:none;border:1px solid #ef4444;color:#ef4444;cursor:pointer;font-family:inherit;font-size:13px;';
    deleteBtn2.addEventListener('click', async () => {
      if (!confirm(`Delete "${proj.name || 'Untitled'}"? This cannot be undone.`)) return;
      await deleteProject(proj.id).catch(() => {});
      await refreshProjectsList(_projectsPanelEl?.querySelector('.projects-search-input')?.value || '');
    });
    moreContent.appendChild(deleteBtn2);
  }

  // Show Preview tab by default
  showTab('preview');
}

// Extract HTML content from AI-generated markdown (looks for the first code block or raw html)
function _extractHtmlFromMd(md) {
  // Try fenced code block labelled html
  const htmlFence = md.match(/```html\n([\s\S]*?)```/i);
  if (htmlFence) return htmlFence[1].trim();
  // Try any fenced code block containing <!DOCTYPE or <html
  const anyFence = md.match(/```[^\n]*\n([\s\S]*?)```/);
  if (anyFence && /<html|<!doctype/i.test(anyFence[1])) return anyFence[1].trim();
  // Try raw HTML in the text
  const raw = md.match(/<!DOCTYPE[^>]*>[\s\S]*/i) || md.match(/<html[\s\S]*/i);
  if (raw) return raw[0];
  return null;
}

async function refreshProjectsList(filter = '') {
  if (!_projectsPanelEl) return;
  const listEl = _projectsPanelEl.querySelector('.projects-list');
  listEl.innerHTML = '';
  let projects;
  try { projects = await listProjects(); } catch { projects = []; }

  if (filter) {
    const q = filter.toLowerCase();
    projects = projects.filter(p => (p.name || '').toLowerCase().includes(q));
  }

  const sortVal = Number(_projectsPanelEl.querySelector('.projects-sort-select')?.value || 0);
  if (sortVal === 1) projects = [...projects].reverse();
  if (sortVal === 2) projects = [...projects].sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  if (projects.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'projects-empty';
    empty.textContent = 'No saved projects yet.';
    listEl.appendChild(empty);
    const titleEl = _projectsPanelEl.querySelector('.projects-title');
    if (titleEl) titleEl.textContent = 'Projects';
    return;
  }

  const titleEl = _projectsPanelEl.querySelector('.projects-title');
  if (titleEl) titleEl.textContent = `Projects (${projects.length})`;

  // Group by recency: < 7 days = "Recently viewed", else "Older"
  const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const groups = [
    { label: 'Recently viewed', items: projects.filter(p => p.timestamp > recentCutoff) },
    { label: 'Older',           items: projects.filter(p => p.timestamp <= recentCutoff) },
  ];

  for (const group of groups) {
    if (!group.items.length) continue;
    const heading = document.createElement('div');
    heading.className = 'proj-group-label';
    heading.textContent = group.label;
    listEl.appendChild(heading);

    for (const proj of group.items) {
      const item = document.createElement('div');
      item.className = 'project-item';

      const info = document.createElement('div');
      info.className = 'project-item-info';
      info.style.cursor = 'pointer';
      const nameEl = document.createElement('div');
      nameEl.className = 'project-item-name';
      nameEl.textContent = proj.name || 'Untitled';
      const dateEl = document.createElement('div');
      dateEl.className = 'project-item-date';
      dateEl.textContent = formatDate(proj.timestamp);
      info.append(nameEl, dateEl);

      if (proj.notes) {
        const notesEl = document.createElement('div');
        notesEl.className = 'project-item-notes';
        notesEl.textContent = proj.notes;
        info.appendChild(notesEl);
      }

      const actions = document.createElement('div');
      actions.className = 'project-item-actions';

      const loadBtn = document.createElement('button');
      loadBtn.className = 'project-load-btn';
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', async () => {
        if (!confirm(`Load "${proj.name}"?\nCurrent session will be cleared.`)) return;
        try {
          const full = await loadProject(proj.id);
          if (!full) throw new Error('not_found');
          closeProjectsPanel();
          restoreProjectSnapshot(full);
        } catch (err) {
          alert('Failed to load project: ' + err.message);
        }
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'project-delete-btn';
      deleteBtn.title = 'Delete project';
      deleteBtn.textContent = '🗑';
      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete "${proj.name}"? This cannot be undone.`)) return;
        await deleteProject(proj.id).catch(() => {});
        await refreshProjectsList(_projectsPanelEl?.querySelector('.projects-search-input')?.value || '');
      });

      actions.append(loadBtn, deleteBtn);

      const detailEl = document.createElement('div');
      detailEl.className = 'proj-detail';
      detailEl.hidden = true;

      info.addEventListener('click', async () => {
        if (!detailEl.hidden) { detailEl.hidden = true; return; }
        const full = await loadProject(proj.id).catch(() => null);
        if (!full) return;
        renderProjectDetail(detailEl, full);
        detailEl.hidden = false;
      });

      item.append(info, actions, detailEl);
      listEl.appendChild(item);
    }
  }
}

export function mountProjectsPanel({
  paneByProvider, ensurePane, clearPanes, addCopyButtons,
  updateInlinePreview, syncTabbedTranscriptChrome, syncTrySessionChrome,
}) {
  _paneByProvider = paneByProvider;
  _ensurePane = ensurePane;
  _clearPanes = clearPanes;
  _addCopyButtons = addCopyButtons;
  _updateInlinePreview = updateInlinePreview;
  _syncTabbedTranscriptChrome = syncTabbedTranscriptChrome;
  _syncTrySessionChrome = syncTrySessionChrome;
}
