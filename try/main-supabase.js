// main-supabase.js — Supabase BYO config + OAuth UI wiring for /try.
//
// Two paths coexist:
//   - BYO: user pastes URL + anon key (client-side localStorage). Keeps
//     working without any server-side config. Same flow that's been live.
//   - OAuth: user connects their Supabase account via the server-side
//     flow at /api/supabase/oauth/start. Server persists the refresh
//     token; frontend just sees a "connected" status. The Phase-3 AI
//     tool dispatcher uses the refresh token to provision projects /
//     apply migrations on the user's behalf.
//
// Status fetch is best-effort. /api/supabase/status returns:
//   - 503 supabase_not_configured  → server has no SUPABASE_OAUTH_CLIENT_ID; hide the OAuth section entirely
//   - 401 unauthorized              → user not signed in to lingcode.dev; OAuth section shows a sign-in nudge
//   - 200 { connected: bool }       → render accordingly

import { setSupabaseConfig } from './preview.js?v=20260602d';
import { getActivePrototypeId } from './main-secrets.js?v=20260602d';

// Cached OAuth status so syncSupabaseBtn() can render synchronously.
// Refreshed at startup, after a successful connect, and after disconnect.
let _oauthState = { fetched: false, configured: false, signedIn: false, connected: false };

// ---- BYO config (stored client-side only, never sent to server) ----
export function getSupabaseConfig() {
  return {
    url: localStorage.getItem('lingcode.try.supabase.url') || '',
    key: localStorage.getItem('lingcode.try.supabase.anonKey') || '',
  };
}

export function saveSupabaseConfig(url, key) {
  if (url && key) {
    localStorage.setItem('lingcode.try.supabase.url', url);
    localStorage.setItem('lingcode.try.supabase.anonKey', key);
  } else {
    localStorage.removeItem('lingcode.try.supabase.url');
    localStorage.removeItem('lingcode.try.supabase.anonKey');
  }
  setSupabaseConfig(url, key);
  syncSupabaseBtn();
}

export function initSupabaseConfig() {
  const { url, key } = getSupabaseConfig();
  setSupabaseConfig(url, key);
  // Best-effort OAuth status probe so syncSupabaseBtn() reflects either
  // path. Failures are silent — BYO keeps working regardless.
  refreshOauthState().catch(() => { /* noop */ });
}

// ---- OAuth API (Phase 2) ----------------------------------------------

async function fetchSupabaseOauthStatus() {
  // The console may show `[Error] Failed to load resource (401)` here for
  // anonymous visitors — that's the SERVER correctly answering "you're not
  // signed in", and we handle it below. Browsers log every non-2xx as Error
  // regardless of how the JS handles it; no way to suppress without dropping
  // fetch. Don't try to "fix" the noise — it's invisible to real users.
  try {
    const res = await fetch('/api/supabase/status', { credentials: 'same-origin' });
    if (res.status === 503) return { configured: false, signedIn: true, connected: false };
    if (res.status === 401) return { configured: true, signedIn: false, connected: false };
    if (!res.ok) return { configured: false, signedIn: false, connected: false };
    const json = await res.json();
    return {
      configured: true,
      signedIn: true,
      connected: !!json.connected,
      connected_at: json.connected_at || null,
      scope: json.scope || null,
    };
  } catch {
    return { configured: false, signedIn: false, connected: false };
  }
}

export async function refreshOauthState() {
  _oauthState = { fetched: true, ...(await fetchSupabaseOauthStatus()) };
  syncSupabaseBtn();
  return _oauthState;
}

// Opens the server's OAuth start route in a popup, waits for the
// `supabase-connected` postMessage from the callback page, then refreshes
// the status. Resolves with the new state; rejects if the popup is
// blocked or the user cancels.
export function connectSupabaseViaOAuth() {
  return new Promise((resolve, reject) => {
    const w = 520, h = 680;
    const left = window.screenX + (window.outerWidth - w) / 2;
    const top = window.screenY + (window.outerHeight - h) / 2;
    const popup = window.open(
      '/api/supabase/oauth/start',
      'supabase-oauth',
      `width=${w},height=${h},left=${left},top=${top}`,
    );
    if (!popup) return reject(new Error('Popup blocked. Allow popups for lingcode.dev and retry.'));

    let settled = false;
    const onMessage = (e) => {
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.kind !== 'supabase-connected' && e.data.kind !== 'supabase-error') return;
      cleanup();
      if (e.data.kind === 'supabase-error') return reject(new Error('Supabase OAuth failed.'));
      refreshOauthState().then(resolve).catch(reject);
    };
    const popupWatch = setInterval(() => {
      if (popup.closed && !settled) { cleanup(); reject(new Error('Connection cancelled.')); }
    }, 500);
    function cleanup() {
      settled = true;
      window.removeEventListener('message', onMessage);
      clearInterval(popupWatch);
    }
    window.addEventListener('message', onMessage);
  });
}

export async function disconnectSupabaseOAuth() {
  await fetch('/api/supabase/disconnect', { method: 'POST', credentials: 'same-origin' });
  await refreshOauthState();
}

// ---- Auto-provision (Phase 3) -----------------------------------------

async function postSupabaseTool(toolName, body) {
  const res = await fetch(`/api/supabase/tools/${toolName}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    const err = new Error(json.message || `Tool ${toolName} failed (${res.status})`);
    err.code = json.error;
    err.status = res.status;
    throw err;
  }
  return json.data;
}

export async function listSupabaseOrgs() {
  return postSupabaseTool('list_organizations', {});
}

// Polls /api/supabase/tools/get_anon_key every `intervalMs` until the
// project finishes provisioning (anon_key non-null) or the timeout
// elapses. Returns { project_url, anon_key } on success.
export async function pollAnonKey(projectRef, { intervalMs = 3000, timeoutMs = 90_000, onTick } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await postSupabaseTool('get_anon_key', { project_ref: projectRef });
    if (data && data.anon_key) return data;
    onTick?.(Math.round((Date.now() - start) / 1000));
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Project provisioning timed out — check the Supabase dashboard.');
}

// Extract the Supabase project ref from a https://<ref>.supabase.co URL.
// Used by Stripe-checkout deploy + future Edge Function flows.
function extractProjectRef(url) {
  if (!url) return null;
  const m = String(url).match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  return m ? m[1] : null;
}

// Calls /api/supabase/tools/add_stripe_checkout. Validates the three
// prereqs locally first so we can surface specific actionable errors
// without burning a server roundtrip:
//   - saved prototype id required (vault is keyed on it)
//   - project ref derivable (auto-provision or BYO must be set)
// The fourth prereq (STRIPE_SECRET_KEY in vault) is checked server-side
// and surfaces as a 412 missing_secret response that the UI catches.
export async function addStripeCheckout({ onStatus } = {}) {
  const prototypeId = getActivePrototypeId();
  if (!prototypeId) throw new Error('Save your prototype first to attach Stripe.');
  const { url } = getSupabaseConfig();
  const projectRef = extractProjectRef(url);
  if (!projectRef) throw new Error('Connect or provision a Supabase project first.');
  onStatus?.('Deploying Stripe checkout function…');
  const data = await postSupabaseTool('add_stripe_checkout', {
    project_ref: projectRef,
    prototype_id: prototypeId,
  });
  return data;
}

// Creates a Supabase project and waits until its anon key is reachable,
// then writes both into the local BYO config so generated prototypes
// pick up window.SUPABASE_URL / window.SUPABASE_ANON_KEY.
export async function provisionSupabaseProject({ organizationId, name, region, onStatus } = {}) {
  if (!organizationId) throw new Error('organization required');
  if (!name || name.length < 2) throw new Error('project name required');
  onStatus?.('Creating project…');
  const created = await postSupabaseTool('create_supabase_project', {
    organization_id: organizationId, name, region: region || 'us-east-1',
  });
  const projectRef = created?.project_ref;
  if (!projectRef) throw new Error('create_supabase_project returned no project_ref');
  onStatus?.(`Provisioning ${projectRef}… (~30s)`);
  const { project_url, anon_key } = await pollAnonKey(projectRef, {
    onTick: (sec) => onStatus?.(`Waiting for database to come up… ${sec}s`),
  });
  saveSupabaseConfig(project_url, anon_key);
  onStatus?.(`Connected to ${projectRef}.`);
  return { project_ref: projectRef, project_url, anon_key };
}

export function supabaseSystemAddendum() {
  const { url, key } = getSupabaseConfig();
  if (!url || !key) return '';
  return `\n\nThe user's app has Supabase connected. You may use Supabase for auth, database, and storage. Load the SDK via CDN (already works in browser, no build step needed):
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
Initialize: const { createClient } = supabase; const client = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
These globals are pre-injected into the preview — never hardcode URL or key values in your output.
For auth, use client.auth.signUp / signInWithPassword / signInWithOAuth. For data, use client.from('table').select(). Enable RLS on all tables.`;
}

export function injectSupabaseGlobals(html) {
  const { url, key } = getSupabaseConfig();
  if (!url || !key) return html;
  const s = `<script>window.SUPABASE_URL=${JSON.stringify(url)};window.SUPABASE_ANON_KEY=${JSON.stringify(key)};<\/script>`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, m => `${m}\n${s}`);
  return s + html;
}

// ---- Header button + popover ----
export function syncSupabaseBtn() {
  const btn = document.getElementById('supabase-btn');
  if (!btn) return;
  const { url } = getSupabaseConfig();
  if (url) {
    const ref = url.match(/https?:\/\/([^.]+)\.supabase\.co/)?.[1] || 'project';
    btn.textContent = `⚡ ${ref}`;
    btn.classList.add('active');
    btn.title = `Supabase connected (BYO): ${url}\nClick to change or disconnect`;
  } else if (_oauthState.connected) {
    btn.textContent = '⚡ Connected';
    btn.classList.add('active');
    btn.title = 'Supabase account connected via OAuth — click to manage';
  } else {
    btn.textContent = '⚡ Supabase';
    btn.classList.remove('active');
    btn.title = 'Connect a Supabase project for live auth and database';
  }
}

function renderProvisionForm(container) {
  // Insert the form below whatever's already in the container so the
  // existing connected-status text + Disconnect button stay visible.
  const form = document.createElement('div');
  form.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:6px;padding-top:8px;border-top:1px dashed var(--border);';

  const nameLabel = document.createElement('label');
  nameLabel.style.cssText = 'font-size:0.75rem;color:var(--text-muted);margin-bottom:-4px;';
  nameLabel.textContent = 'Project name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'my-app';
  nameInput.value = 'lingcode-' + Math.random().toString(36).slice(2, 8);

  const orgLabel = document.createElement('label');
  orgLabel.style.cssText = 'font-size:0.75rem;color:var(--text-muted);margin-bottom:-4px;';
  orgLabel.textContent = 'Organization';
  const orgSelect = document.createElement('select');
  orgSelect.style.cssText = 'padding:7px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:inherit;font-size:0.82rem;';
  const placeholderOpt = document.createElement('option');
  placeholderOpt.value = '';
  placeholderOpt.textContent = 'Loading…';
  orgSelect.append(placeholderOpt);

  const status = document.createElement('div');
  status.style.cssText = 'font-size:0.74rem;color:var(--text-muted);min-height:1.1em;';

  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'ckpt-save-btn';
  submit.textContent = 'Create project';
  submit.disabled = true;

  form.append(nameLabel, nameInput, orgLabel, orgSelect, status, submit);
  container.append(form);

  listSupabaseOrgs().then((orgs) => {
    orgSelect.textContent = '';
    if (!Array.isArray(orgs) || orgs.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No organizations found';
      orgSelect.append(opt);
      status.textContent = 'You need at least one Supabase org. Create one at supabase.com.';
      return;
    }
    for (const o of orgs) {
      const opt = document.createElement('option');
      opt.value = o.id || o.slug || '';
      opt.textContent = o.name || o.slug || o.id;
      orgSelect.append(opt);
    }
    submit.disabled = false;
  }).catch((err) => {
    status.textContent = 'Could not load organizations: ' + (err.message || 'unknown');
  });

  submit.addEventListener('click', async () => {
    submit.disabled = true;
    nameInput.disabled = true;
    orgSelect.disabled = true;
    try {
      await provisionSupabaseProject({
        organizationId: orgSelect.value,
        name: nameInput.value.trim() || 'lingcode-app',
        onStatus: (msg) => { status.textContent = msg; },
      });
      // setSupabaseConfig has run; close + re-open will show the project as BYO-connected.
      const pop = document.querySelector('.supabase-popover');
      if (pop) pop.style.display = 'none';
    } catch (err) {
      status.textContent = 'Failed: ' + (err.message || 'unknown');
      submit.disabled = false;
      nameInput.disabled = false;
      orgSelect.disabled = false;
    }
  });
}

function renderOauthSection(container) {
  container.textContent = '';
  if (!_oauthState.fetched) {
    refreshOauthState().then(() => renderOauthSection(container)).catch(() => {});
    const loading = document.createElement('div');
    loading.style.cssText = 'font-size:0.78rem;color:var(--text-muted);';
    loading.textContent = 'Checking Supabase connection…';
    container.append(loading);
    return;
  }
  if (!_oauthState.configured) return; // server has no OAuth app — hide entirely

  const heading = document.createElement('div');
  heading.style.cssText = 'font-size:0.82rem;font-weight:600;color:var(--text);';
  heading.textContent = 'Connect your Supabase account';
  container.append(heading);

  const blurb = document.createElement('div');
  blurb.style.cssText = 'font-size:0.74rem;color:var(--text-muted);line-height:1.4;';
  container.append(blurb);

  if (!_oauthState.signedIn) {
    blurb.textContent = 'Sign in to lingcode.dev first to connect your Supabase account.';
    const signInBtn = document.createElement('a');
    signInBtn.href = '/signin.html?next=' + encodeURIComponent('/try.html');
    signInBtn.textContent = 'Sign in';
    signInBtn.style.cssText = 'display:inline-block;margin-top:6px;padding:7px 12px;border-radius:6px;background:var(--text);color:var(--bg);text-decoration:none;font-size:0.8rem;font-weight:500;';
    container.append(signInBtn);
    return;
  }

  if (_oauthState.connected) {
    blurb.textContent = 'Connected. The AI can now provision projects and apply migrations on your behalf.';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
    container.append(btnRow);

    const provisionBtn = document.createElement('button');
    provisionBtn.type = 'button';
    provisionBtn.className = 'ckpt-save-btn';
    provisionBtn.style.cssText = 'flex:1;';
    provisionBtn.textContent = '+ Provision a project for this app';
    btnRow.append(provisionBtn);

    const disBtn = document.createElement('button');
    disBtn.type = 'button';
    disBtn.style.cssText = 'padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:0.8rem;cursor:pointer;font-family:inherit;';
    disBtn.textContent = 'Disconnect';
    disBtn.addEventListener('click', async () => {
      disBtn.disabled = true;
      try { await disconnectSupabaseOAuth(); } finally { renderOauthSection(container); }
    });
    btnRow.append(disBtn);

    provisionBtn.addEventListener('click', () => {
      provisionBtn.disabled = true;
      provisionBtn.style.display = 'none';
      renderProvisionForm(container);
    });

    // ── + Add Stripe checkout (Phase 5) ────────────────────────────
    // Only useful once a project is configured (auto-provisioned or
    // BYO) AND a saved prototype exists AND STRIPE_SECRET_KEY is in the
    // vault. We surface the button always and let the click validate
    // because the alternative (probing all 3 prereqs on every popover
    // open) burns API calls.
    const stripeBtn = document.createElement('button');
    stripeBtn.type = 'button';
    stripeBtn.style.cssText = 'margin-top:6px;padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--text);font-size:0.8rem;cursor:pointer;font-family:inherit;width:100%;text-align:left;';
    stripeBtn.textContent = '+ Add Stripe checkout';
    stripeBtn.title = 'Deploy a curated Stripe checkout Edge Function. Requires STRIPE_SECRET_KEY in 🔐 Secrets and a configured Supabase project.';
    container.append(stripeBtn);

    const stripeStatus = document.createElement('div');
    stripeStatus.style.cssText = 'font-size:0.74rem;color:var(--text-muted);min-height:1.1em;line-height:1.4;';
    container.append(stripeStatus);

    // Scaffold Auth — sends a follow-up prompt that wires Supabase Auth into
    // the current prototype (login/signup forms + session persistence).
    const authBtn = document.createElement('button');
    authBtn.type = 'button';
    authBtn.style.cssText = 'margin-top:4px;padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--text);font-size:0.8rem;cursor:pointer;font-family:inherit;width:100%;text-align:left;';
    authBtn.textContent = '+ Scaffold Auth (login / signup)';
    authBtn.title = 'Add Supabase email+password auth to this prototype — login page, session, protected content.';
    authBtn.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('lingcode:scaffold-auth'));
      document.querySelector('.supabase-popover')?.remove();
    });
    container.append(authBtn);

    stripeBtn.addEventListener('click', async () => {
      stripeBtn.disabled = true;
      stripeStatus.style.color = 'var(--text-muted)';
      try {
        const data = await addStripeCheckout({
          onStatus: (msg) => { stripeStatus.textContent = msg; },
        });
        stripeStatus.style.color = 'var(--signal,#10b981)';
        const url = data?.url;
        stripeStatus.innerHTML = '';
        const ok = document.createElement('div');
        ok.textContent = '✓ Deployed at:';
        const link = document.createElement('a');
        link.href = url;
        link.textContent = url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.style.cssText = 'word-break:break-all;color:var(--text);text-decoration:underline;';
        stripeStatus.append(ok, link);
      } catch (err) {
        stripeStatus.style.color = '#d6604f';
        if (err.code === 'missing_secret') {
          stripeStatus.textContent = `Pin ${err.message.match(/Pin (\S+)/)?.[1] || 'STRIPE_SECRET_KEY'} in 🔐 Secrets first, then retry.`;
        } else {
          stripeStatus.textContent = err.message || 'Deploy failed.';
        }
      } finally {
        stripeBtn.disabled = false;
      }
    });
  } else {
    blurb.textContent = 'One-click OAuth — gives the AI permission to create projects and tables in your Supabase org.';
    const connBtn = document.createElement('button');
    connBtn.type = 'button';
    connBtn.className = 'ckpt-save-btn';
    connBtn.style.cssText = 'margin-top:6px;width:100%;';
    connBtn.textContent = '⚡ Connect Supabase';
    connBtn.addEventListener('click', async () => {
      connBtn.disabled = true;
      try { await connectSupabaseViaOAuth(); } catch (e) {
        const errEl = document.createElement('div');
        errEl.style.cssText = 'font-size:0.74rem;color:#d6604f;margin-top:4px;';
        errEl.textContent = e.message || 'Connection failed';
        container.append(errEl);
      } finally { renderOauthSection(container); }
    });
    container.append(connBtn);
  }
}

export function openSupabaseDialog() {
  let pop = document.querySelector('.supabase-popover');
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'ckpt-name-popover supabase-popover';
    pop.style.width = '360px';

    // OAuth section (Phase 2). Auto-hides when the server has no OAuth
    // app registered, so existing BYO users see no change.
    const oauthSection = document.createElement('div');
    oauthSection.className = 'supabase-oauth-section';
    oauthSection.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding-bottom:10px;border-bottom:1px solid var(--border);margin-bottom:8px;';
    pop.append(oauthSection);
    pop._oauthSection = oauthSection;

    const byoHeading = document.createElement('div');
    byoHeading.style.cssText = 'font-size:0.74rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;font-weight:500;';
    byoHeading.textContent = 'Or paste credentials directly';
    pop.append(byoHeading);

    const urlLabel = document.createElement('label');
    urlLabel.style.cssText = 'font-size:0.78rem;color:var(--text-muted);margin-bottom:-4px;';
    urlLabel.textContent = 'Project URL';

    const urlInput = document.createElement('input');
    urlInput.type = 'url';
    urlInput.placeholder = 'https://xxxx.supabase.co';

    const keyLabel = document.createElement('label');
    keyLabel.style.cssText = 'font-size:0.78rem;color:var(--text-muted);margin-bottom:-4px;';
    keyLabel.textContent = 'Anon Key (public — safe to expose)';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.placeholder = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;';

    const connectBtn = document.createElement('button');
    connectBtn.className = 'ckpt-save-btn';
    connectBtn.style.flex = '1';
    connectBtn.textContent = 'Connect';

    const disconnectBtn = document.createElement('button');
    disconnectBtn.style.cssText = 'padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:0.8rem;cursor:pointer;font-family:inherit;';
    disconnectBtn.textContent = 'Disconnect';

    row.append(connectBtn, disconnectBtn);
    pop.append(urlLabel, urlInput, keyLabel, keyInput, row);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.style.cssText = 'position:absolute;top:8px;right:8px;width:24px;height:24px;border:0;background:transparent;color:var(--text-muted);font-size:18px;line-height:1;cursor:pointer;padding:0;border-radius:4px;';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => { pop.style.display = 'none'; });
    pop.append(closeBtn);

    document.body.appendChild(pop);

    connectBtn.addEventListener('click', () => {
      const url = urlInput.value.trim().replace(/\/$/, '');
      const key = keyInput.value.trim();
      if (!url || !key) return;
      saveSupabaseConfig(url, key);
      pop.style.display = 'none';
    });

    disconnectBtn.addEventListener('click', () => {
      saveSupabaseConfig('', '');
      pop.style.display = 'none';
    });

    document.addEventListener('click', (e) => {
      if (!pop.contains(e.target)
        && !document.getElementById('supabase-btn')?.contains(e.target)
        && !document.getElementById('chip-supabase')?.contains(e.target)) {
        pop.style.display = 'none';
      }
    });
  }

  const { url, key } = getSupabaseConfig();
  pop.querySelector('input[type=url]').value = url;
  pop.querySelector('input[type=text]').value = key;
  if (pop._oauthSection) renderOauthSection(pop._oauthSection);

  const btn = document.getElementById('supabase-btn')
    || document.getElementById('chip-supabase');
  if (btn) {
    const r = btn.getBoundingClientRect();
    pop.style.left = r.left + 'px';
    pop.style.top = (r.bottom + 8) + 'px';
  }
  pop.style.display = 'flex';
}
