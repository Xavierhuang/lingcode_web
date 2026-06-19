// collab-history.js — audit log timeline panel for collab rooms.
// Fetches aggregated edit history from the REST API and renders a
// right-side drawer with a timeline of who changed what when.

let _protoId = null;
let _drawerEl = null;

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

async function fetchHistory(since = 0, limit = 50) {
  const r = await fetch(`/api/prototypes/${_protoId}/collab/history?since=${since}&limit=${limit}`);
  if (!r.ok) return [];
  const data = await r.json();
  return data.ok ? data.timeline : [];
}

function renderTimeline(entries, containerEl) {
  containerEl.innerHTML = '';
  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.style.cssText = 'color:#6b7280;font-size:13px;text-align:center;margin-top:24px;';
    empty.textContent = 'No edit history yet.';
    containerEl.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f3f4f6;';

    const avatar = document.createElement('div');
    avatar.style.cssText = [
      'width:28px;height:28px;border-radius:50%;',
      'background:#7c3aed;color:#fff;',
      'font-size:11px;font-weight:600;',
      'display:flex;align-items:center;justify-content:center;',
      'flex-shrink:0;font-family:system-ui,sans-serif;',
    ].join('');
    avatar.textContent = entry.initials || '?';
    row.appendChild(avatar);

    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';

    const name = document.createElement('div');
    name.style.cssText = 'font-weight:600;font-size:12px;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    name.textContent = entry.displayName || 'Someone';
    info.appendChild(name);

    const detail = document.createElement('div');
    detail.style.cssText = 'font-size:11px;color:#6b7280;margin-top:1px;';
    detail.textContent = `${entry.editCount} edit${entry.editCount === 1 ? '' : 's'} · ${timeAgo(entry.windowStart)}`;
    info.appendChild(detail);

    row.appendChild(info);
    containerEl.appendChild(row);
  }
}

export async function openHistoryPanel(prototypeId) {
  _protoId = prototypeId;
  closeHistoryPanel();

  const drawer = document.createElement('div');
  drawer.id = 'lc-history-drawer';
  drawer.style.cssText = [
    'position:fixed;top:0;right:0;width:300px;height:100vh;',
    'background:#fff;border-left:1px solid #e5e7eb;',
    'box-shadow:-4px 0 16px rgba(0,0,0,.1);',
    'z-index:9900;display:flex;flex-direction:column;',
    'font-family:system-ui,sans-serif;',
  ].join('');

  const header = document.createElement('div');
  header.style.cssText = 'padding:16px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;';

  const title = document.createElement('h3');
  title.style.cssText = 'margin:0;font-size:14px;font-weight:600;color:#111827;';
  title.textContent = 'Edit History';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:16px;color:#6b7280;padding:0;';
  closeBtn.onclick = closeHistoryPanel;

  header.appendChild(title);
  header.appendChild(closeBtn);
  drawer.appendChild(header);

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = '↺ Refresh';
  refreshBtn.style.cssText = 'margin:10px 16px 0;background:none;border:1px solid #e5e7eb;border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer;color:#374151;';

  const content = document.createElement('div');
  content.style.cssText = 'flex:1;overflow-y:auto;padding:0 16px 16px;';

  const loading = document.createElement('p');
  loading.style.cssText = 'color:#6b7280;font-size:13px;text-align:center;margin-top:24px;';
  loading.textContent = 'Loading…';
  content.appendChild(loading);

  refreshBtn.onclick = async () => {
    content.innerHTML = '';
    const spinner = document.createElement('p');
    spinner.style.cssText = 'color:#6b7280;font-size:13px;text-align:center;margin-top:24px;';
    spinner.textContent = 'Loading…';
    content.appendChild(spinner);
    const entries = await fetchHistory();
    renderTimeline(entries, content);
  };

  drawer.appendChild(refreshBtn);
  drawer.appendChild(content);
  document.body.appendChild(drawer);
  _drawerEl = drawer;

  const entries = await fetchHistory();
  renderTimeline(entries, content);
}

export function closeHistoryPanel() {
  if (_drawerEl && _drawerEl.parentElement) _drawerEl.parentElement.removeChild(_drawerEl);
  _drawerEl = null;
}

export function refreshHistoryPanel() {
  if (!_drawerEl || !_protoId) return;
  const content = _drawerEl.querySelector('div[style*="flex:1"]');
  if (!content) return;
  fetchHistory().then((entries) => renderTimeline(entries, content));
}
