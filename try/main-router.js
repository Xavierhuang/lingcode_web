// main-router.js — /try dashboard ↔ app-view hash router + dashboard render.
//
// Extracted verbatim from main.js. /try.html is one document with two
// top-level views (#dashboard-view, #app-view); `location.hash` drives which
// one is visible. No backend routes, no history library — just a stable parse
// helper + a setView.
//
// Dependency-injection seam: main.js owns `_loadedAppTitle` / `setAppName` and
// the chip-polling side effects, so they're injected. `onView(mode)` runs at
// the end of every setTryView so a view change can drive external side effects
// (chip polling start/stop) exactly as the old in-place setTryView wrapper did
// — extracting setTryView into this module means routeFromHash's internal
// setTryView call no longer sees main.js's reassigned binding, so the hook is
// how that behavior is preserved.

export function mountRouter({ getLoadedAppTitle, setAppName, openPreview, track, renderTemplatesGrid, onView, mountCloud }) {
  function parseTryHash(hash) {
    const raw = (hash || '').replace(/^#/, '');
    if (!raw) {
      // Legacy querystring entry points (?continue=, ?prompt=) belong in the
      // builder, not the dashboard. Detect them here so a deep-link from
      // marketing or "continue editing" lands in app-view directly.
      try {
        const params = new URLSearchParams(location.search);
        if (params.get('continue') || params.get('prompt') || params.get('demo') || params.get('edit')) {
          return { mode: 'app', appId: 'draft' };
        }
      } catch (_) {}
      // Post-signin publish-resume: handlePublish() stashes this flag before
      // it bounces an unauthed user to /signin.html. When they return to /try
      // we must NOT show the dashboard — the resume-IIFE is about to
      // rehydrate panes into #workspace and they'd be hidden behind it.
      try {
        if (sessionStorage.getItem('lingcode.try.resumePublish')) {
          return { mode: 'app', appId: 'draft', resuming: true };
        }
      } catch (_) {}
      return { mode: 'dashboard' };
    }
    if (raw === 'new') return { mode: 'dashboard', openNew: true };
    if (raw.startsWith('app=')) {
      const id = raw.slice(4);
      return id ? { mode: 'app', appId: id } : { mode: 'dashboard' };
    }
    // Cloud backend console (dedicated full-screen view). #cloud=<id> targets a
    // saved prototype's backend; bare #cloud shows the "save first" gate.
    if (raw === 'cloud') return { mode: 'cloud', appId: '' };
    if (raw.startsWith('cloud=')) return { mode: 'cloud', appId: raw.slice(6) };
    // Existing share-link payload (#p=…) is app-mode — the share-loader IIFE
    // handles the actual hydration; we just make sure app-view is visible.
    if (raw.startsWith('p=')) return { mode: 'app', shared: raw.slice(2) };
    return { mode: 'dashboard' };
  }

  function setTryView(mode) {
    const dash = document.getElementById('dashboard-view');
    const app = document.getElementById('app-view');
    const cloud = document.getElementById('cloud-view');
    if (!dash || !app) return;
    if (mode === 'cloud') {
      dash.hidden = true;
      app.hidden = true;
      if (cloud) cloud.hidden = false;
    } else if (mode === 'app') {
      dash.hidden = true;
      app.hidden = false;
      if (cloud) cloud.hidden = true;
    } else {
      dash.hidden = false;
      app.hidden = true;
      if (cloud) cloud.hidden = true;
    }
    // Start/stop chip polling based on which view is active (was an in-place
    // setTryView wrapper in main.js).
    if (typeof onView === 'function') onView(mode);
  }

  function routeFromHash() {
    const parsed = parseTryHash(location.hash);
    console.debug('[try] route', parsed);
    setTryView(parsed.mode);
    if (parsed.mode === 'dashboard') {
      renderDashboard();
    } else if (parsed.mode === 'app') {
      // Prefer the loaded project's real title (set by the continue-IIFE / on
      // rename); fall back to generic. Never show the raw id.
      setAppName(getLoadedAppTitle() || 'Untitled app');
    } else if (parsed.mode === 'cloud') {
      // Render the Cloud console into #cloud-view for the targeted prototype.
      if (typeof mountCloud === 'function') mountCloud(parsed.appId);
    }
    return parsed;
  }

  function _dashFormatRelativeTime(iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return '';
    const day = 86400000;
    if (ms < day) return 'today';
    if (ms < 7 * day) return Math.floor(ms / day) + 'd ago';
    if (ms < 30 * day) return Math.floor(ms / (7 * day)) + 'w ago';
    return Math.floor(ms / (30 * day)) + 'mo ago';
  }

  // One outside-click closer for all card menus on the page. Set once per
  // dashboard render — re-registering on every menu open would leak listeners.
  // The handler is harmless when no menu is open (closeOpenCardMenu no-ops).
  let _openCardMenu = null;
  function closeOpenCardMenu() {
    if (_openCardMenu) { try { _openCardMenu.remove(); } catch (_) {} _openCardMenu = null; }
  }
  if (!document._lcCardMenuCloserBound) {
    document.addEventListener('click', closeOpenCardMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOpenCardMenu(); });
    document._lcCardMenuCloserBound = true;
  }

  async function renderDashboardYourApps(anchor, section) {
    if (!anchor || !section) return;
    let items = [];
    try {
      const r = await fetch('/api/account/saved-prototypes', { credentials: 'same-origin' });
      if (r.status === 401) { section.hidden = true; return; }
      if (!r.ok) throw new Error('http_' + r.status);
      const j = await r.json();
      items = (j && j.items) || [];
    } catch (e) {
      console.debug('[try] dashboard your-apps fetch failed', e);
      section.hidden = true;
      return;
    }
    if (!items.length) { section.hidden = true; return; }
    section.hidden = false;
    anchor.replaceChildren();
    for (const it of items) {
      const card = document.createElement('a');
      card.className = 'dash-card';
      card.href = '/try.html?continue=' + encodeURIComponent(it.id);
      const thumb = document.createElement('div');
      thumb.className = 'dash-card-thumb';
      if (it.thumbnail && /^data:image\//i.test(it.thumbnail)) {
        thumb.style.backgroundImage = "url('" + it.thumbnail.replace(/'/g, "\\'") + "')";
      } else {
        // Default cover for imageless projects: a deterministic gradient (stable
        // per project) with the title initial, so it reads as intentional art.
        let h = 0; const seed = String(it.id || it.title || '');
        for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
        thumb.style.backgroundImage = `linear-gradient(135deg,hsl(${h},62%,58%),hsl(${(h + 38) % 360},62%,48%))`;
        thumb.style.color = '#fff';
        thumb.textContent = (it.title || 'A').slice(0, 1).toUpperCase();
      }
      const title = document.createElement('div');
      title.className = 'dash-card-title';
      title.textContent = it.title || 'Untitled app';
      const meta = document.createElement('div');
      meta.className = 'dash-card-meta';
      meta.textContent = _dashFormatRelativeTime(it.created_at);
      card.append(thumb, title, meta);

      // Overflow menu button (bottom-right). Lives INSIDE the <a> card — every
      // click handler preventDefault + stopPropagation to suppress the card's
      // own navigation. Currently only Delete; structured as a menu so future
      // Rename / Make public actions can land here without rearranging the tile.
      const menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'dash-card-menu-btn';
      menuBtn.setAttribute('aria-label', 'More options');
      menuBtn.setAttribute('title', 'More');
      menuBtn.textContent = '⋯';
      menuBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Toggle: a second click on the same card's "…" closes the menu it
        // already opened. Otherwise close any sibling card's open menu first.
        const wasMine = _openCardMenu && _openCardMenu.parentElement === card;
        closeOpenCardMenu();
        if (wasMine) return;
        const menu = document.createElement('div');
        menu.className = 'dash-card-menu';
        menu.setAttribute('role', 'menu');
        // Swallow clicks inside the menu so the outside-click closer doesn't
        // immediately close it on the same event tick.
        menu.addEventListener('click', (ev) => ev.stopPropagation());

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'dash-card-menu-item danger';
        delBtn.setAttribute('role', 'menuitem');
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const label = it.title && it.title.trim() ? it.title : 'this project';
          if (!window.confirm('Delete "' + label + '"? This cannot be undone.')) {
            closeOpenCardMenu();
            return;
          }
          closeOpenCardMenu();
          try {
            const r = await fetch('/api/account/saved-prototypes/' + encodeURIComponent(it.id), {
              method: 'DELETE', credentials: 'same-origin',
            });
            if (!r.ok) throw new Error('http_' + r.status);
            card.remove();
            if (!anchor.children.length) section.hidden = true;
          } catch (err) {
            console.warn('[try] delete failed', err);
            window.alert('Could not delete this project. Please try again.');
          }
        });
        menu.appendChild(delBtn);

        card.appendChild(menu);
        _openCardMenu = menu;
      });
      card.appendChild(menuBtn);

      anchor.append(card);
    }
  }

  let _dashTemplatesRendered = false;
  function renderDashboard() {
    const tplAnchor = document.getElementById('dash-templates-grid');
    if (tplAnchor && !_dashTemplatesRendered) {
      renderTemplatesGrid(tplAnchor, {
        onPick: ({ id, label, html }) => {
          openPreview({ html, providerName: label });
          try { track && track('template_opened', { template_id: id, source: 'dashboard' }); } catch (_) {}
        },
        onError: () => {
          console.warn('[try] template load failed');
        },
      });
      _dashTemplatesRendered = true;
    }
    const appsAnchor = document.getElementById('dash-your-apps-grid');
    const appsSection = document.getElementById('dash-your-apps-section');
    renderDashboardYourApps(appsAnchor, appsSection);
    // Focus the prompt textarea so first-time visitors can type immediately.
    // Use requestAnimationFrame so the hidden→visible transition has resolved.
    requestAnimationFrame(() => {
      document.getElementById('dash-prompt')?.focus();
    });
  }

  return { setTryView, routeFromHash };
}
