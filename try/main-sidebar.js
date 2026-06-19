// main-sidebar.js — left sidebar for /try.html listing the signed-in user's
// cloud-saved prototypes (data from /api/account/saved-prototypes).
//
// Public API:
//   mountSidebar()
//     Called once from main.js. Probes /api/entitlement; if signed in,
//     reveals the #try-sidebar element, fetches the prototype list, and
//     renders it. No-op when signed out.

const COLLAPSE_KEY = 'lingcode.try.sidebar';

let _el = null;
let _listEl = null;
let _footEmailEl = null;
let _footAvatarEl = null;

function buildShell() {
  _el.innerHTML = '';

  // ─── Header ───────────────────────────────────────────────────────────
  const head = document.createElement('div');
  head.className = 'try-sidebar-head';
  const brand = document.createElement('span');
  brand.className = 'try-sidebar-brand';
  brand.textContent = 'LingCode /try';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'try-sidebar-toggle';
  toggle.setAttribute('aria-label', 'Collapse sidebar');
  toggle.textContent = '◀';
  toggle.addEventListener('click', toggleCollapsed);
  head.append(brand, toggle);

  // ─── + New project ───────────────────────────────────────────────────
  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'try-sidebar-newproj';
  newBtn.title = 'Start a new /try project (clears current workspace)';
  newBtn.innerHTML = '<span aria-hidden="true">+</span> <span class="try-sidebar-newproj-label">New project</span>';
  newBtn.addEventListener('click', () => {
    if (window.confirm('Start a new /try project? Current workspace state will be cleared.')) {
      window.location.href = '/try.html';
    }
  });

  // ─── Recents section ─────────────────────────────────────────────────
  const sectionLabel = document.createElement('div');
  sectionLabel.className = 'try-sidebar-section-label';
  sectionLabel.textContent = 'Recents';

  _listEl = document.createElement('div');
  _listEl.className = 'try-sidebar-list';
  // Initially a skeleton placeholder until the fetch resolves.
  _listEl.innerHTML =
    '<ul class="try-sidebar-skeleton">' +
    '<li><div class="try-sidebar-skeleton-thumb"></div><div class="try-sidebar-skeleton-line"></div></li>'.repeat(3) +
    '</ul>';

  // ─── Footer (avatar + email + Account link) ──────────────────────────
  const foot = document.createElement('div');
  foot.className = 'try-sidebar-foot';
  _footAvatarEl = document.createElement('div');
  _footAvatarEl.className = 'try-sidebar-avatar';
  _footAvatarEl.textContent = '?';
  _footEmailEl = document.createElement('span');
  _footEmailEl.className = 'try-sidebar-foot-email';
  const acctLink = document.createElement('a');
  acctLink.className = 'try-sidebar-foot-link';
  acctLink.href = '/account.html';
  acctLink.textContent = 'Account';
  foot.append(_footAvatarEl, _footEmailEl, acctLink);

  _el.append(head, newBtn, sectionLabel, _listEl, foot);

  // Apply persisted collapsed state.
  const collapsed = localStorage.getItem(COLLAPSE_KEY) === 'collapsed';
  if (collapsed) applyCollapsed(true);
}

function applyCollapsed(collapsed) {
  if (collapsed) {
    _el.dataset.collapsed = '1';
    document.body.classList.add('sidebar-collapsed');
  } else {
    delete _el.dataset.collapsed;
    document.body.classList.remove('sidebar-collapsed');
  }
  localStorage.setItem(COLLAPSE_KEY, collapsed ? 'collapsed' : 'expanded');
  const toggle = _el.querySelector('.try-sidebar-toggle');
  if (toggle) {
    toggle.textContent = collapsed ? '▶' : '◀';
    toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  }
}

function toggleCollapsed() {
  applyCollapsed(_el.dataset.collapsed !== '1');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function relTime(iso) {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (isNaN(ts)) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 7) return days + 'd ago';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function fetchAndRenderList() {
  if (!_listEl) return;
  try {
    const r = await fetch('/api/account/saved-prototypes', { credentials: 'same-origin' });
    if (r.status === 401) {
      // User signed out under us. Hide the sidebar entirely.
      _el.hidden = true;
      document.body.classList.remove('has-sidebar');
      document.body.classList.remove('sidebar-collapsed');
      return;
    }
    if (!r.ok) throw new Error('http_' + r.status);
    const j = await r.json();
    renderList(j && j.items ? j.items : []);
  } catch (e) {
    console.warn('[sidebar] list fetch failed', e);
    renderError();
  }
}

function renderList(items) {
  if (!_listEl) return;
  if (!items.length) {
    _listEl.innerHTML = '<p class="try-sidebar-empty">Nothing saved yet. Click ↗ Publish on any generation to add it here.</p>';
    return;
  }
  const html = ['<ul class="try-sidebar-rows">'];
  for (const it of items) {
    const idAttr = escapeHtml(it.id);             // safe inside HTML attributes
    const idPath = encodeURIComponent(it.id);     // semantically correct in URL path
    const title = escapeHtml(it.title || 'Untitled');
    const age = escapeHtml(relTime(it.created_at));
    const thumbStyle = it.thumbnail && /^data:image\//i.test(it.thumbnail)
      ? `background-image:url('${escapeHtml(it.thumbnail)}')`
      : '';
    // Actions live OUTSIDE the <a> so their clicks don't navigate.
    html.push(
      `<li class="try-sidebar-row-li">` +
        `<a class="try-sidebar-row" href="/p/${idPath}" target="_blank" rel="noopener" title="${title}">` +
          `<span class="try-sidebar-thumb" style="${thumbStyle}"></span>` +
          `<span class="try-sidebar-meta">` +
            `<span class="try-sidebar-title">${title}</span>` +
            `<span class="try-sidebar-age">${age}</span>` +
          `</span>` +
        `</a>` +
        `<div class="try-sidebar-row-actions">` +
          `<button type="button" class="try-sidebar-row-act" data-act="continue" data-id="${idAttr}" title="Continue editing in /try">✏️</button>` +
          `<button type="button" class="try-sidebar-row-act" data-act="rename" data-id="${idAttr}" title="Rename">✎</button>` +
          `<button type="button" class="try-sidebar-row-act" data-act="delete" data-id="${idAttr}" title="Delete">🗑</button>` +
        `</div>` +
      `</li>`
    );
  }
  html.push('</ul>');
  _listEl.innerHTML = html.join('');
}

// Delegated handler for the per-row Rename / Delete buttons. Attached once
// in mountSidebar; survives every list re-render since it lives on _listEl.
async function onRowAction(e) {
  const btn = e.target.closest('.try-sidebar-row-act');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  if (!id) return;
  if (act === 'continue') {
    // Navigate to /try.html?continue=<id> — the destination's IIFE in
    // main.js fetches the saved prototype, decodes its share_payload,
    // and hydrates a fresh pane. Full reload semantics match "+ New
    // project" so we don't have to tear down the current workspace.
    window.location.href = '/try.html?continue=' + encodeURIComponent(id);
    return;
  }
  if (act === 'rename') {
    const li = btn.closest('.try-sidebar-row-li');
    const currentEl = li?.querySelector('.try-sidebar-title');
    const current = currentEl ? currentEl.textContent : '';
    const next = window.prompt('Rename prototype:', current);
    if (next == null) return;
    const trimmed = String(next).trim();
    if (!trimmed || trimmed === current) return;
    try {
      const r = await fetch('/api/account/saved-prototypes/' + encodeURIComponent(id), {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!r.ok) throw new Error('http_' + r.status);
      fetchAndRenderList();
    } catch (err) {
      console.warn('[sidebar] rename failed', err);
      alert('Could not rename.');
    }
  } else if (act === 'delete') {
    if (!window.confirm('Delete this saved prototype? This cannot be undone.')) return;
    try {
      const r = await fetch('/api/account/saved-prototypes/' + encodeURIComponent(id), {
        method: 'DELETE', credentials: 'same-origin',
      });
      if (!r.ok) throw new Error('http_' + r.status);
      fetchAndRenderList();
    } catch (err) {
      console.warn('[sidebar] delete failed', err);
      alert('Could not delete.');
    }
  }
}

function renderError() {
  if (!_listEl) return;
  _listEl.innerHTML =
    '<p class="try-sidebar-error">Couldn\'t load projects. <a class="try-sidebar-retry">Retry</a></p>';
  const retry = _listEl.querySelector('.try-sidebar-retry');
  if (retry) retry.addEventListener('click', fetchAndRenderList);
}

async function fetchAndRenderFooter() {
  try {
    const r = await fetch('/api/account/me', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (!j || !j.ok) return;
    const email = j.email || '';
    if (_footEmailEl) {
      _footEmailEl.textContent = email;
      _footEmailEl.title = email;
    }
    if (_footAvatarEl && email) {
      _footAvatarEl.textContent = email[0] || '?';
    }
  } catch (_) {}
}

export async function mountSidebar() {
  _el = document.getElementById('try-sidebar');
  if (!_el) return;

  let signedIn = false;
  try {
    const r = await fetch('/api/entitlement', { credentials: 'same-origin' });
    signedIn = r.ok;
  } catch (_) {}
  if (!signedIn) return;

  buildShell();
  _el.hidden = false;
  document.body.classList.add('has-sidebar');

  // Delegated rename/delete handler — _listEl survives every re-render so
  // the listener is bound once and catches all future row buttons.
  if (_listEl) _listEl.addEventListener('click', onRowAction);

  fetchAndRenderList();
  fetchAndRenderFooter();

  // Refresh list when /try.html dispatches a publish-success event.
  // Debounced — handlePublish + resume IIFE could both fire in quick
  // succession in pathological cases, no need to thrash the API.
  let refreshTimer = null;
  window.addEventListener('lingcode:prototype-saved', () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      fetchAndRenderList();
    }, 250);
  });
}
