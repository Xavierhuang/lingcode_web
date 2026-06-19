// main-secrets.js — per-prototype encrypted secrets UI for /try.
//
// Secrets are scoped to a saved prototype (Lovable's model). Until the
// user saves the prototype, the dialog shows a "Save first" prompt
// instead of the editor — we don't have a prototype_id to attach to.
//
// Server contract (Phase 4 backend, see server/secrets-vault.js):
//   GET    /api/prototypes/:id/secrets         → { ok, data: [{key, encrypted_len, ...}] }
//   PUT    /api/prototypes/:id/secrets/:key    body { value }
//   DELETE /api/prototypes/:id/secrets/:key
// All routes return 503 until LINGCODE_VAULT_MASTER_KEY env is set on
// the server. The Connect-button UI degrades quietly to "Vault not
// configured" in that case.

let _activePrototypeId = null;
let _vaultConfigured = null; // null=unknown, true/false after first probe

const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export function setActivePrototypeId(id) {
  _activePrototypeId = id || null;
  syncSecretsBtn();
}

export function getActivePrototypeId() {
  return _activePrototypeId;
}

async function probeVaultConfigured() {
  if (_vaultConfigured !== null) return _vaultConfigured;
  // Best-effort probe. The /api/prototypes/<bogus>/secrets path returns
  // 503 if the vault is unconfigured; 401/404 if the user/proto is bad
  // but the vault is configured. We treat any non-503 as "configured."
  try {
    const res = await fetch('/api/prototypes/__probe__/secrets', { credentials: 'same-origin' });
    _vaultConfigured = res.status !== 503;
  } catch {
    _vaultConfigured = false;
  }
  return _vaultConfigured;
}

async function jsonOrThrow(res, route) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    const err = new Error(json.message || `${route} failed (${res.status})`);
    err.code = json.error;
    err.status = res.status;
    throw err;
  }
  return json.data;
}

export async function fetchSecretsList(prototypeId) {
  const res = await fetch(`/api/prototypes/${encodeURIComponent(prototypeId)}/secrets`, { credentials: 'same-origin' });
  return jsonOrThrow(res, 'list secrets');
}

export async function setSecret(prototypeId, key, value) {
  const res = await fetch(`/api/prototypes/${encodeURIComponent(prototypeId)}/secrets/${encodeURIComponent(key)}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  return jsonOrThrow(res, 'set secret');
}

export async function deleteSecret(prototypeId, key) {
  const res = await fetch(`/api/prototypes/${encodeURIComponent(prototypeId)}/secrets/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  return jsonOrThrow(res, 'delete secret');
}

export function syncSecretsBtn() {
  const btn = document.getElementById('secrets-btn');
  if (!btn) return;
  if (_activePrototypeId) {
    btn.classList.remove('disabled-state');
    btn.title = 'Manage encrypted secrets for this prototype';
  } else {
    btn.classList.remove('disabled-state');
    btn.title = 'Save the prototype first to attach secrets';
  }
}

function renderListInto(listEl, items, prototypeId, refresh, onEditRequest) {
  listEl.textContent = '';
  if (!items || items.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:0.78rem;color:var(--text-muted);font-style:italic;padding:4px 0;';
    empty.textContent = 'No secrets pinned yet.';
    listEl.appendChild(empty);
    return;
  }
  for (const it of items) {
    const chip = document.createElement('div');
    chip.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:rgba(28,28,28,0.04);font-size:0.8rem;';
    const left = document.createElement('div');
    left.style.cssText = 'flex:1;min-width:0;';
    const nameSpan = document.createElement('div');
    nameSpan.style.cssText = 'font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;text-decoration:underline dotted;';
    nameSpan.textContent = it.key;
    nameSpan.title = 'Click to update this secret';
    nameSpan.addEventListener('click', () => onEditRequest(it.key));
    const metaSpan = document.createElement('div');
    metaSpan.style.cssText = 'font-size:0.7rem;color:var(--text-muted);';
    const updated = it.updated_at ? new Date(it.updated_at).toLocaleDateString() : '';
    metaSpan.textContent = `${it.encrypted_len ? `${it.encrypted_len}B encrypted` : 'set'}${updated ? ` · ${updated}` : ''}`;
    left.append(nameSpan, metaSpan);
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.style.cssText = 'background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:1rem;padding:2px 6px;';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', async () => {
      removeBtn.disabled = true;
      try { await deleteSecret(prototypeId, it.key); await refresh(); }
      catch (e) { removeBtn.disabled = false; alert(e.message); }
    });
    chip.append(left, removeBtn);
    listEl.appendChild(chip);
  }
}

export function openSecretsDialog() {
  let pop = document.querySelector('.secrets-popover');
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'ckpt-name-popover secrets-popover';
    pop.style.cssText = 'width:380px;max-height:70vh;overflow-y:auto;flex-direction:column;gap:8px;';
    document.body.appendChild(pop);
    document.addEventListener('click', (e) => {
      if (!pop.contains(e.target) && !document.getElementById('secrets-btn')?.contains(e.target)) {
        pop.style.display = 'none';
      }
    });
  }
  pop.textContent = '';

  const heading = document.createElement('div');
  heading.style.cssText = 'font-size:0.82rem;font-weight:600;color:var(--text);';
  heading.textContent = '🔐 Prototype secrets';
  pop.append(heading);

  const blurb = document.createElement('div');
  blurb.style.cssText = 'font-size:0.74rem;color:var(--text-muted);line-height:1.4;';
  pop.append(blurb);

  // ── State 1: vault not configured on the server ──
  probeVaultConfigured().then((configured) => {
    if (!configured) {
      blurb.textContent = 'Server-side secrets vault is not configured. Set LINGCODE_VAULT_MASTER_KEY in the server env to enable.';
      return;
    }
    if (!_activePrototypeId) {
      // ── State 2: no saved prototype ──
      blurb.textContent = 'Save your prototype to attach encrypted secrets like STRIPE_SECRET_KEY or OPENAI_API_KEY. The AI uses these when scaffolding Edge Functions.';
      const saveHint = document.createElement('div');
      saveHint.style.cssText = 'font-size:0.74rem;color:var(--text-muted);line-height:1.4;';
      saveHint.textContent = 'Open the 📂 Projects panel to save the current prototype first.';
      pop.append(saveHint);
      return;
    }
    // ── State 3: connected ──
    blurb.textContent = 'AES-256-GCM encrypted at rest. Values are never sent back to the browser.';

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    pop.append(list);

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.placeholder = 'STRIPE_SECRET_KEY';
    keyInput.style.cssText = 'font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;text-transform:uppercase;';
    keyInput.addEventListener('input', () => { keyInput.value = keyInput.value.toUpperCase(); });

    // Password-masked value input with show/hide toggle
    const valueRow = document.createElement('div');
    valueRow.style.cssText = 'display:flex;gap:4px;align-items:center;';
    const valueInput = document.createElement('input');
    valueInput.type = 'password';
    valueInput.placeholder = 'Paste the secret value';
    valueInput.style.cssText = 'flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;font-size:0.78rem;';
    const toggleVisBtn = document.createElement('button');
    toggleVisBtn.type = 'button';
    toggleVisBtn.style.cssText = 'background:none;border:1px solid var(--border);border-radius:6px;padding:4px 7px;cursor:pointer;font-size:0.85rem;color:var(--text-muted);flex-shrink:0;';
    toggleVisBtn.textContent = '👁';
    toggleVisBtn.title = 'Show / hide value';
    toggleVisBtn.addEventListener('click', () => {
      const showing = valueInput.type === 'text';
      valueInput.type = showing ? 'password' : 'text';
      toggleVisBtn.textContent = showing ? '👁' : '🙈';
    });
    valueRow.append(valueInput, toggleVisBtn);

    const actionRow = document.createElement('div');
    actionRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
    const setBtn = document.createElement('button');
    setBtn.type = 'button';
    setBtn.className = 'ckpt-save-btn';
    setBtn.textContent = 'Pin secret';
    const cancelEditBtn = document.createElement('button');
    cancelEditBtn.type = 'button';
    cancelEditBtn.style.cssText = 'background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:0.78rem;padding:0 4px;display:none;';
    cancelEditBtn.textContent = 'Cancel';
    actionRow.append(setBtn, cancelEditBtn);

    const errLine = document.createElement('div');
    errLine.style.cssText = 'font-size:0.75rem;color:#d6604f;display:none;';

    pop.append(keyInput, valueRow, actionRow, errLine);

    function showErr(msg) {
      errLine.textContent = msg || '';
      errLine.style.display = msg ? 'block' : 'none';
    }

    function resetEditMode() {
      keyInput.value = '';
      keyInput.disabled = false;
      keyInput.style.opacity = '';
      valueInput.value = '';
      valueInput.type = 'password';
      toggleVisBtn.textContent = '👁';
      valueInput.placeholder = 'Paste the secret value';
      setBtn.textContent = 'Pin secret';
      cancelEditBtn.style.display = 'none';
      showErr('');
    }

    function onEditRequest(key) {
      keyInput.value = key;
      keyInput.disabled = true;
      keyInput.style.opacity = '0.5';
      valueInput.value = '';
      valueInput.type = 'password';
      toggleVisBtn.textContent = '👁';
      valueInput.placeholder = 'Enter new value to update';
      setBtn.textContent = 'Update secret';
      cancelEditBtn.style.display = 'inline-block';
      showErr('');
      valueInput.focus();
    }

    cancelEditBtn.addEventListener('click', resetEditMode);

    async function refresh() {
      showErr('');
      try {
        const items = await fetchSecretsList(_activePrototypeId);
        renderListInto(list, items, _activePrototypeId, refresh, onEditRequest);
      } catch (e) { showErr(e.message); }
    }

    setBtn.addEventListener('click', async () => {
      const key = (keyInput.value || '').trim().toUpperCase();
      const value = (valueInput.value || '').trim();
      if (!KEY_PATTERN.test(key)) {
        showErr('Key must match /^[A-Z][A-Z0-9_]{0,63}$/ — e.g. STRIPE_SECRET_KEY.');
        return;
      }
      if (!value) { showErr('Value is empty.'); return; }
      setBtn.disabled = true;
      try {
        await setSecret(_activePrototypeId, key, value);
        resetEditMode();
        await refresh();
      } catch (e) { showErr(e.message); }
      finally { setBtn.disabled = false; }
    });

    refresh();
    keyInput.focus();
  });

  // ESC closes the popover
  function onEsc(e) {
    if (e.key === 'Escape') {
      pop.style.display = 'none';
      document.removeEventListener('keydown', onEsc);
    }
  }
  document.addEventListener('keydown', onEsc);

  const btn = document.getElementById('secrets-btn');
  if (btn) {
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.max(8, r.left) + 'px';
    pop.style.top = (r.bottom + 8) + 'px';
  }
  pop.style.display = 'flex';
}
