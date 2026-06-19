// main-github-push.js — push uncommitted /try workspace edits back to the
// user's GitHub repo (when the workspace was loaded via the GitHub backend).
//
// Public API:
//   syncGitHubPushBtn()
//     Show/hide and dirty-mark the #github-push-btn based on fs.js's current
//     backend + unsaved-writes flag. Call after any workspace mutation —
//     today main.js's renderWorkspaceState() does this.
//   pushToGitHub({ onPushed } = {})
//     Triggered by the button click. Walks: dirty-file gather → connection
//     check (OAuth popup if not connected) → commit-message dialog → POST
//     /api/github/commit. Calls onPushed() after a successful push so the
//     caller can refresh dependent UI (workspace state, etc).
//
// All transport (status / oauth / commit) and dirty-file model live in fs.js
// — this module is purely the UI flow + button state.

import {
  backendKind,
  hasUnsavedWrites,
  getGitHubBackendMeta,
  getDirtyFiles,
  markClean,
} from './fs.js?v=20260602d';

export function syncGitHubPushBtn() {
  const btn = document.getElementById('github-push-btn');
  if (!btn) return;
  const isGitHub = backendKind() === 'github';
  btn.hidden = !isGitHub;
  btn.classList.toggle('dirty', isGitHub && hasUnsavedWrites());
}

export async function pushToGitHub({ onPushed } = {}) {
  const meta = getGitHubBackendMeta();
  if (!meta) return;

  const dirtyFiles = getDirtyFiles();
  if (dirtyFiles.length === 0) return;

  const statusRes = await fetch('/api/github/status', { credentials: 'same-origin' });
  const { connected } = await statusRes.json();

  if (!connected) {
    // OAuth popup — same shape as preview.js's saveToGitHub flow.
    await new Promise((resolve, reject) => {
      const popup = window.open('/api/github/oauth/start?source=try', 'github-oauth',
        'width=700,height=760,left=200,top=100');
      const onMsg = (e) => {
        if (e.data?.kind === 'github-connected') {
          window.removeEventListener('message', onMsg);
          resolve();
        }
      };
      window.addEventListener('message', onMsg);
      const check = setInterval(() => {
        if (popup?.closed) { clearInterval(check); window.removeEventListener('message', onMsg); reject(new Error('Popup closed')); }
      }, 500);
    });
  }

  const message = await openCommitMessageDialog();
  if (!message) return;

  const btn = document.getElementById('github-push-btn');
  btn.disabled = true;
  btn.textContent = '↑ Pushing…';
  try {
    const res = await fetch('/api/github/commit', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: meta.owner,
        repo: meta.repo,
        branch: meta.ref,
        message,
        files: dirtyFiles,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      markClean();
      try { onPushed?.(); } catch { /* caller's responsibility */ }
      btn.textContent = '✓ Pushed';
      setTimeout(() => { btn.textContent = '↑ Push'; btn.disabled = false; }, 2500);
    } else {
      alert(`Push failed: ${data.message || data.error}`);
      btn.textContent = '↑ Push';
      btn.disabled = false;
    }
  } catch (e) {
    alert(`Push error: ${e.message}`);
    btn.textContent = '↑ Push';
    btn.disabled = false;
  }
}

function openCommitMessageDialog() {
  return new Promise((resolve) => {
    let popover = document.querySelector('.gh-commit-popover');
    if (!popover) {
      popover = document.createElement('div');
      popover.className = 'ckpt-name-popover gh-commit-popover';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Commit message';
      const pushBtn = document.createElement('button');
      pushBtn.className = 'ckpt-save-btn';
      pushBtn.textContent = 'Commit & Push';
      popover.append(input, pushBtn);
      document.body.appendChild(popover);
    }
    const input = popover.querySelector('input');
    const pushBtn = popover.querySelector('button');
    input.value = 'Update from LingCode';

    const cleanup = () => { popover.style.display = 'none'; };
    const onPush = () => {
      const msg = input.value.trim();
      if (!msg) return;
      cleanup();
      resolve(msg);
    };
    const onKey = (e) => {
      if (e.key === 'Enter') onPush();
      if (e.key === 'Escape') { cleanup(); resolve(null); }
    };

    pushBtn.onclick = onPush;
    input.onkeydown = onKey;

    const btnEl = document.getElementById('github-push-btn');
    if (btnEl) {
      const r = btnEl.getBoundingClientRect();
      popover.style.left = r.left + 'px';
      popover.style.top = (r.bottom + 8) + 'px';
    }
    popover.style.display = 'flex';
    input.focus();
    input.select();
  });
}
