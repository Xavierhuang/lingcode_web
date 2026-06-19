// main-domains.js — Phase 5b finalize. Custom subdomains UI for the
// currently-active saved prototype.
//
// Three-state dialog driven by:
//   - vault-style probe to /api/prototypes/:id/domains (returns 503 if
//     CLOUDFLARE_API_TOKEN / ZONE_ID / ZONE_NAME unset on server)
//   - the active prototype id (set on publish via setSecretsActivePrototypeId)
//
// State 1: domains_not_configured → shows "Server not configured" message
// State 2: no saved prototype       → shows "Save your prototype first"
// State 3: connected                → list + add form + verify/remove

import { getActivePrototypeId } from './main-secrets.js?v=20260602d';

const LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

let _zoneState = { fetched: false, configured: false, zone: null, signedIn: false };

async function fetchDomainsList(prototypeId) {
  const res = await fetch(`/api/prototypes/${encodeURIComponent(prototypeId)}/domains`, { credentials: 'same-origin' });
  if (res.status === 401) throw Object.assign(new Error('Sign in first'), { code: 'unauthorized' });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw Object.assign(new Error(j.message || `list failed (${res.status})`), { code: j.error });
  }
  const json = await res.json();
  _zoneState = { fetched: true, configured: !!json.configured, zone: json.zone || null, signedIn: true };
  return json.data || [];
}

async function addDomain(prototypeId, label, targetUrl) {
  const res = await fetch(`/api/prototypes/${encodeURIComponent(prototypeId)}/domains`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label, target_url: targetUrl }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw Object.assign(new Error(json.message || `add failed (${res.status})`), { code: json.error });
  return json.data;
}

async function verifyDomain(prototypeId, hostname) {
  const res = await fetch(`/api/prototypes/${encodeURIComponent(prototypeId)}/domains/${encodeURIComponent(hostname)}/verify`, {
    method: 'POST', credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw Object.assign(new Error(json.message || `verify failed (${res.status})`), { code: json.error });
  return json.data;
}

async function deleteDomain(prototypeId, hostname) {
  const res = await fetch(`/api/prototypes/${encodeURIComponent(prototypeId)}/domains/${encodeURIComponent(hostname)}`, {
    method: 'DELETE', credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw Object.assign(new Error(json.message || `delete failed (${res.status})`), { code: json.error });
}

export function syncDomainsBtn() {
  const btn = document.getElementById('domains-btn');
  if (!btn) return;
  btn.title = 'Claim a subdomain for your published prototype (CNAME via Cloudflare)';
}

function renderDomainList(listEl, items, prototypeId, refresh, zone) {
  listEl.textContent = '';
  if (!items || items.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:0.78rem;color:var(--text-muted);font-style:italic;padding:4px 0;';
    empty.textContent = 'No domains yet.';
    listEl.appendChild(empty);
    return;
  }
  for (const it of items) {
    const chip = document.createElement('div');
    chip.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:rgba(28,28,28,0.04);font-size:0.8rem;';
    const left = document.createElement('div');
    left.style.cssText = 'flex:1;min-width:0;';
    const link = document.createElement('a');
    link.href = `https://${it.hostname}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = it.hostname;
    link.style.cssText = 'color:var(--text);font-weight:500;text-decoration:underline;word-break:break-all;';
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:0.7rem;color:var(--text-muted);margin-top:2px;';
    const statusColor = it.status === 'live' ? 'var(--signal,#10b981)' : '#f59e0b';
    meta.innerHTML = `<span style="color:${statusColor};">●</span> ${it.status} · → ${it.target_value}`;
    left.append(link, meta);
    chip.append(left);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:4px;';

    if (it.status !== 'live') {
      const verifyBtn = document.createElement('button');
      verifyBtn.type = 'button';
      verifyBtn.style.cssText = 'background:none;border:1px solid var(--border);border-radius:4px;color:var(--text-muted);cursor:pointer;font-size:0.72rem;padding:2px 6px;font-family:inherit;';
      verifyBtn.textContent = 'Verify';
      verifyBtn.title = 'Recheck DNS propagation (CNAME usually live within 1-5 min on Cloudflare-proxied subdomains)';
      verifyBtn.addEventListener('click', async () => {
        verifyBtn.disabled = true;
        verifyBtn.textContent = '…';
        try {
          const r = await verifyDomain(prototypeId, it.hostname);
          if (r.propagated) await refresh();
          else { verifyBtn.textContent = 'Not yet'; setTimeout(() => { verifyBtn.disabled = false; verifyBtn.textContent = 'Verify'; }, 2000); }
        } catch (e) { verifyBtn.textContent = '✗'; }
      });
      actions.append(verifyBtn);
    }

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.style.cssText = 'background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:1rem;padding:2px 6px;';
    rm.textContent = '✕';
    rm.title = 'Remove';
    rm.addEventListener('click', async () => {
      if (!confirm(`Remove ${it.hostname}? The CNAME will be deleted.`)) return;
      rm.disabled = true;
      try { await deleteDomain(prototypeId, it.hostname); await refresh(); }
      catch (e) { rm.disabled = false; alert(e.message); }
    });
    actions.append(rm);
    chip.append(actions);
    listEl.appendChild(chip);
  }
}

export function openDomainsDialog() {
  let pop = document.querySelector('.domains-popover');
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'ckpt-name-popover domains-popover';
    pop.style.cssText = 'width:420px;max-height:70vh;overflow-y:auto;flex-direction:column;gap:8px;';
    document.body.appendChild(pop);
    document.addEventListener('click', (e) => {
      if (!pop.contains(e.target) && !document.getElementById('domains-btn')?.contains(e.target)) {
        pop.style.display = 'none';
      }
    });
  }
  pop.textContent = '';

  const heading = document.createElement('div');
  heading.style.cssText = 'font-size:0.82rem;font-weight:600;color:var(--text);';
  heading.textContent = '🌍 Custom subdomain';
  pop.append(heading);

  const blurb = document.createElement('div');
  blurb.style.cssText = 'font-size:0.74rem;color:var(--text-muted);line-height:1.4;';
  pop.append(blurb);

  const prototypeId = getActivePrototypeId();
  if (!prototypeId) {
    blurb.textContent = 'Save your prototype first (↗ Publish on a pane), then come back to claim a subdomain.';
    positionPop(pop);
    pop.style.display = 'flex';
    return;
  }

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  pop.append(list);

  const errLine = document.createElement('div');
  errLine.style.cssText = 'font-size:0.75rem;color:#d6604f;display:none;';
  pop.append(errLine);
  function showErr(msg) { errLine.textContent = msg || ''; errLine.style.display = msg ? 'block' : 'none'; }

  // Add-form (only if configured) — built once, refreshed per render.
  let formEl = null;

  async function refresh() {
    showErr('');
    try {
      const items = await fetchDomainsList(prototypeId);
      renderDomainList(list, items, prototypeId, refresh, _zoneState.zone);

      if (!_zoneState.configured) {
        if (formEl) { formEl.remove(); formEl = null; }
        blurb.textContent = 'Custom subdomains aren\'t configured on the server (CLOUDFLARE_API_TOKEN / ZONE_ID / ZONE_NAME env vars).';
        return;
      }
      blurb.textContent = `Claim a subdomain on .${_zoneState.zone}, point it at any URL (your Netlify deploy works). Cloudflare-proxied → free TLS.`;

      if (!formEl) {
        formEl = document.createElement('div');
        formEl.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);';

        const labelRow = document.createElement('div');
        labelRow.style.cssText = 'display:flex;align-items:center;gap:4px;';
        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.placeholder = 'myapp';
        labelInput.style.cssText = 'flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;text-transform:lowercase;';
        const suffix = document.createElement('span');
        suffix.style.cssText = 'font-size:0.78rem;color:var(--text-muted);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;';
        suffix.textContent = '.' + (_zoneState.zone || 'apps.example');
        labelRow.append(labelInput, suffix);

        const targetInput = document.createElement('input');
        targetInput.type = 'url';
        targetInput.placeholder = 'https://your-site.netlify.app';

        const submit = document.createElement('button');
        submit.type = 'button';
        submit.className = 'ckpt-save-btn';
        submit.textContent = 'Claim';

        submit.addEventListener('click', async () => {
          const label = (labelInput.value || '').trim().toLowerCase();
          const target = (targetInput.value || '').trim();
          if (!LABEL_RE.test(label)) { showErr('Label must be 1–63 chars, lowercase + digits + hyphens.'); return; }
          if (!target) { showErr('Target URL required.'); return; }
          submit.disabled = true;
          try {
            await addDomain(prototypeId, label, target);
            labelInput.value = '';
            targetInput.value = '';
            await refresh();
          } catch (e) {
            showErr(e.message || 'Failed to claim');
          } finally { submit.disabled = false; }
        });

        formEl.append(
          Object.assign(document.createElement('div'), { textContent: 'Subdomain', style: 'font-size:0.74rem;color:var(--text-muted);margin-bottom:-4px;' }),
          labelRow,
          Object.assign(document.createElement('div'), { textContent: 'Target URL', style: 'font-size:0.74rem;color:var(--text-muted);margin:6px 0 -4px 0;' }),
          targetInput,
          submit,
        );
        pop.append(formEl);
      }
    } catch (e) {
      showErr(e.message);
    }
  }

  refresh();
  positionPop(pop);
  pop.style.display = 'flex';
}

function positionPop(pop) {
  const btn = document.getElementById('domains-btn');
  if (btn) {
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.max(8, r.left) + 'px';
    pop.style.top = (r.bottom + 8) + 'px';
  }
}
