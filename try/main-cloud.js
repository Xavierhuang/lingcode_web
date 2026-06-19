// main-cloud.js — LingCode Cloud console for /try (Phase 1).
//
// A tabbed sheet for the managed backend attached to a saved prototype:
// Overview · Database · SQL editor are live; the rest (Users, Storage,
// Secrets, Edge functions, Logs, Usage) show a "coming soon" placeholder so
// the surface matches the target shape. Talks ONLY to /api/cloud/* on our
// server (session-authed); service creds never reach the browser.
//
// Generated apps reach their backend through the injected globals
// window.LINGCODE_BACKEND_URL + window.LINGCODE_BACKEND_ANON_KEY (Phase-1
// data path = the control-plane proxy at <url>/select|insert).

import { getActivePrototypeId } from './main-secrets.js?v=20260602d';

const cfgKey = (pid) => `lingcode.try.cloud.${pid}`;

// ---- backend config cache (for injection) -----------------------------
function readBackendConfig(prototypeId) {
  if (!prototypeId) return null;
  try { return JSON.parse(localStorage.getItem(cfgKey(prototypeId)) || 'null'); }
  catch { return null; }
}
function writeBackendConfig(prototypeId, cfg) {
  try { localStorage.setItem(cfgKey(prototypeId), JSON.stringify(cfg)); } catch {}
}
function activeBackendConfig() {
  return readBackendConfig(getActivePrototypeId());
}

// Versioned SDK URL. The filename carries the major version (bump to -v2 only on
// a breaking change); ?b= dodges the 4h Cloudflare edge cache for in-version
// updates. injectBackendGlobals loads this then pre-wires window.lingcode.
const SDK_URL = 'https://lingcode.dev/sdk/lingcode-v1.js?b=20260531a';

// Injected into the preview the same way injectSupabaseGlobals works.
// Keeps the two raw globals (back-compat for fetch-based apps) AND loads the
// client SDK, exposing window.lingcode already pointed at this backend.
export function injectBackendGlobals(html) {
  const cfg = activeBackendConfig();
  if (!cfg || !cfg.url || !cfg.key) return html;
  const s = `<script>window.LINGCODE_BACKEND_URL=${JSON.stringify(cfg.url)};window.LINGCODE_BACKEND_ANON_KEY=${JSON.stringify(cfg.key)};<\/script>`
    + `\n<script src=${JSON.stringify(SDK_URL)}><\/script>`
    + `\n<script>try{window.lingcode=LingCode.createClient(window.LINGCODE_BACKEND_URL,window.LINGCODE_BACKEND_ANON_KEY);}catch(e){}<\/script>`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${s}`);
  return s + html;
}

export function backendSystemAddendum() {
  const cfg = activeBackendConfig();
  if (!cfg || !cfg.url || !cfg.key) return '';
  return `\n\nThe user's app has a LingCode managed backend (Postgres + auth + storage + realtime). The client SDK is PRE-INJECTED into the preview as the global \`window.lingcode\` — already connected to this app's backend. Use it directly; NEVER hardcode URLs or keys, never re-create the client, never add a <script> for it. Methods return { data, error } (check error before using data). It is Supabase-shaped, so write idiomatic code:

DATA — window.lingcode.from('<table>'):
  SELECT:  const { data, error } = await window.lingcode.from('todos').eq('done', false).order('created_at', { ascending:false }).limit(50).select();
  Filters chain before .select(): .eq(col,v) .neq .gt .gte .lt .lte .like(col,'%x%') .ilike .in(col,[...]) .is(col,null) (IS NULL) / .is(col,'not_null'). Multiple filters AND together. Omit filters to fetch all (up to limit, max 200). .match({ a:1, b:2 }) sets several equals at once.
  INSERT:  await window.lingcode.from('todos').insert({ title:'Buy milk' });   // or .insert([ {…}, {…} ])
  UPDATE (filter REQUIRED):  await window.lingcode.from('todos').eq('id', 1).update({ done:true });
  DELETE (filter REQUIRED):  await window.lingcode.from('todos').eq('id', 1).delete();
  Use the backend for ALL persistent/shared data — never localStorage for that. Set the backend up yourself: call the apply_migration tool to CREATE/ALTER the tables this app needs (BEFORE writing app code), and list_tables / query_database to inspect schema and data. Never CREATE tables from app runtime code — only via apply_migration.

AUTH — window.lingcode.auth (the SDK stores the session and auto-attaches it to later calls, so subsequent .from() runs act as the signed-in user; RLS keys off their id). Each returns { data:{ user, token }, error }:
  • Password:  await window.lingcode.auth.signUp({ email, password })  /  await window.lingcode.auth.signIn({ email, password }).
  • Magic link (passwordless, simplest UX — prefer this):  await window.lingcode.auth.sendMagicLink({ email }) emails a sign-in link. The SDK auto-finalizes the link on return (reads ?lc_magic and stores the session) — you do NOT handle the redirect. Await window.lingcode.ready on load, then window.lingcode.auth.getUser().
  • Social — Google / GitHub / Apple (managed, no setup, OPTIONAL):  const p = await window.lingcode.auth.getProviders(); render only buttons where p.google.available (etc.) is true. Each button calls window.lingcode.auth.signInWithOAuth('google') (top-level navigation). On return the SDK auto-stores the session; check window.lingcode.auth.lastError() for a failure code.
  • Email code (OTP, always available):  await window.lingcode.auth.sendOtp({ email }) emails a 6-digit code; then await window.lingcode.auth.verifyOtp({ email, code }).
  • Session:  window.lingcode.auth.getUser() → { id, email } | null;  window.lingcode.auth.signOut().  Always \`await window.lingcode.ready\` once on load before reading getUser() (it resolves after any redirect session is consumed).

REALTIME — live updates (use instead of polling for chat, collaborative lists, dashboards). RLS-filtered server-side, so a signed-in user only receives their own rows:
  const off = window.lingcode.from('todos').subscribe(({ type, row }) => { /* type: INSERT|UPDATE|DELETE — patch the UI */ });
  // call off() on teardown.

STORAGE — window.lingcode.storage.from('<bucket>') (bucket defaults to 'public'):
  const { data } = await window.lingcode.storage.from('public').upload('avatars/me.png', fileInput.files[0]);  // data.url is public
  const url = window.lingcode.storage.from('public').getPublicUrl('avatars/me.png');  // or .download(path) → { data: Blob }

FUNCTIONS — server-side logic that runs on LingCode (no server of your own). await window.lingcode.functions.invoke('send-email', { to, subject, html }) sends email via LingCode with NO API key or setup. invoke('echo', payload) is the demo function. Other builtins: 'elevenlabs-tts' (text→speech) and 'http-fetch' — the GENERIC way to integrate ANY third-party API with a server-side secret (prefer it over a bespoke function for typical integrations): invoke('http-fetch', { url, method, headers:{ Authorization:'Bearer {{MY_KEY}}' }, body }); the {{SECRET}} is filled from the vault so the key never reaches the client. The owner must add the API's host under the backend's Allowed fetch hosts first. For payments: const { data } = await window.lingcode.functions.invoke('stripe-checkout', { price_id, success_url, cancel_url, mode }) → redirect the buyer to data.url (mode defaults to 'payment'; use 'subscription' for recurring). SECRETS: vendor keys (STRIPE_SECRET_KEY, RESEND_API_KEY, ELEVENLABS_API_KEY, …) are set by the owner in the Cloud → Secrets tab and read by functions server-side — so secret-holding logic does NOT need an external server. Custom Edge functions (sandboxed Deno, ≤ ~30s, authored in the IDE/Cloud console) are full server endpoints, not just compute: inside one, ctx.db.query(sql, params) runs arbitrary SQL — JOINs, aggregations, transactions — as the tenant role under RLS (the way to do relational work the client CRUD API can't); ctx.storage reads/writes files; ctx.request exposes the raw inbound HTTP request so a function is a real endpoint + webhook receiver (verify Stripe/GitHub signatures off rawBody) and can return { __http:true, status, headers, body }; and a function can run on a CRON schedule (digests, cleanup). Reach for a custom function for webhooks, validations, multi-table logic, or scheduled jobs.

HOSTING — the app itself deploys to LingCode Cloud (full-stack Worker/SSR, served at <slug>.lingcode.app with custom domains) from the LingCode Mac app's "Deploy to LingCode Cloud", which AUTO-DETECTS the framework — Next.js, SvelteKit, Nuxt, Astro, Remix/React Router 7, TanStack Start, or a plain static site — and builds it for the Workers runtime (SSR pages, API routes, server code all run). Two honest constraints: the runtime is Cloudflare Workers (a V8 isolate, NOT Node — the supported frameworks are auto-adapted, but a hand-rolled plain Express/Node server outside those, or a non-JS backend like Python/Rails/Go, still needs porting or a server you run), and requests are short-lived (~30s, no long-running processes/queues/sockets). Don't tell the user they need a separate host for secrets, Stripe, or ordinary server logic — those run here.

VECTOR / semantic search (pgvector — "search my notes by meaning", RAG, recommendations): in apply_migration create a vector column, e.g. CREATE TABLE docs (id serial primary key, content text, user_id uuid, embedding vector(1536)); (optionally CREATE INDEX ON docs USING hnsw (embedding vector_cosine_ops);). Insert the embedding as a bracketed string: await window.lingcode.from('docs').insert({ content, embedding:'['+vec.join(',')+']' }). Search: const { data } = await window.lingcode.vector.search({ table:'docs', column:'embedding', embedding:[...queryVec], limit:5, metric:'cosine' }) → rows nearest-first with a _distance field. To turn TEXT into a vector with no model setup: const { data } = await window.lingcode.vector.embed('some text') → data.embedding (only if managed embeddings are enabled; otherwise embed client-side).

LIMITS — the runtime data API is per-table CRUD (no raw SQL at runtime), so write code accordingly: NO JOINs across tables — fetch each table separately and join in memory, or denormalize in apply_migration; NO upserts / ON CONFLICT — insert, and on a duplicate-key error fetch-then-update; .select() returns at most 200 rows — page with .limit()/.offset() and do counts/sums in app code. Anything relational or heavy (views, multi-table queries, indexes, constraints, seed data) goes in apply_migration (full Postgres SQL), NOT in app-runtime calls.

(The raw globals window.LINGCODE_BACKEND_URL / _ANON_KEY are still injected for advanced use, but PREFER the SDK.)`;
}

export function syncCloudBtn() {
  const btn = document.getElementById('cloud-btn');
  if (!btn) return;
  const cfg = activeBackendConfig();
  if (cfg && cfg.url) { btn.textContent = '☁ Cloud'; btn.classList.add('active'); btn.title = 'Managed backend connected — click to open the Cloud console'; }
  else { btn.textContent = '☁ Cloud'; btn.classList.remove('active'); btn.title = 'Provision a managed backend (database, SQL) for this prototype'; }
}

// ---- API helpers ------------------------------------------------------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  if (!res.ok || !json || json.ok === false) {
    const err = new Error((json && (json.message || json.error)) || `HTTP ${res.status}`);
    err.code = json && json.error;
    err.status = res.status;
    throw err;
  }
  return json.data;
}

// ---- AI tool surface --------------------------------------------------
// The agent can drive the backend itself (create tables, run migrations,
// inspect schema/data) when a backend is live for the active prototype.
// These names mirror the routes in server/cloud-tools.js.
export const CLOUD_TOOL_NAMES = new Set(['provision_backend', 'list_tables', 'get_backend_info', 'apply_migration', 'query_database']);

// True when the active prototype has a provisioned backend — gates whether
// CLOUD_TOOLS are offered to the model this turn.
export function cloudToolsActive() {
  const cfg = activeBackendConfig();
  return !!(cfg && cfg.url && cfg.key);
}

// Seam set by main.js: mints a (stable) prototype id by auto-saving the active
// pane, for cold-start provisioning where nothing has been published yet.
let _ensurePrototypeId = null;
export function setEnsurePrototypeId(fn) { _ensurePrototypeId = (typeof fn === 'function') ? fn : null; }

// Executor for a CLOUD_TOOLS tool call. Resolves the prototype itself (the
// server enforces ownership), so runAgent's executor contract is unchanged.
// Returns the data envelope; throws on failure so the agent loop records
// { error } and can recover.
export async function execCloudTool(tc) {
  let prototypeId = getActivePrototypeId();
  // Cold start: a brand-new build has no id yet. Auto-save one so the agent can
  // provision a backend in the same turn (the id is stable — later publishes
  // update it in place, keeping the backend attached).
  if (!prototypeId && _ensurePrototypeId) {
    try { prototypeId = await _ensurePrototypeId(); } catch (_) { /* fall through to the error below */ }
  }
  if (!prototypeId) throw new Error('Save this prototype before using backend tools.');
  const data = await api(`/api/cloud/tools/${tc.name}`, {
    method: 'POST',
    body: JSON.stringify({ prototype_id: prototypeId, ...(tc.args || {}) }),
  });
  // provision_backend just created (or returned) the backend — cache its config
  // so the preview gets the injected globals and cloudToolsActive() flips true
  // for the rest of the session (subsequent runs offer the full cloud toolset).
  if (tc.name === 'provision_backend' && data && data.gateway_url && data.anon_key) {
    writeBackendConfig(prototypeId, { url: data.gateway_url, key: data.anon_key });
    syncCloudBtn();
  }
  return data;
}

// System-prompt addendum injected when the user CAN provision (signed-in) but
// no backend exists yet — tells the model it can set one up itself. main.js
// gates injection on sign-in and stops once backendSystemAddendum() (the live
// one) takes over.
export function cloudProvisionAddendum() {
  return `\n\nThis app can have a LingCode managed backend — Postgres with built-in email/password & passwordless magic-link auth, file storage, and email — no external service or API keys. It also covers server-side logic: an encrypted secrets vault (hold STRIPE_SECRET_KEY, RESEND_API_KEY, etc.) plus serverless functions (Stripe checkout, email, text-to-speech, server-side http-fetch, and custom functions) — so secrets/payments/most server work need NO external server. If the app needs to persist data or support user accounts/login, set it up yourself: call the provision_backend tool FIRST, then apply_migration to CREATE the tables it needs, then write the app against the backend (the backend URL + anon key are auto-injected into the preview; a usage guide is added once the backend is live). Prefer this over localStorage for any shared or persisted data.`;
}

// ---- console UI -------------------------------------------------------
const TABS = [
  { id: 'overview', label: 'Overview', live: true },
  { id: 'database', label: 'Database', live: true },
  { id: 'sql',      label: 'SQL editor', live: true },
  { id: 'users',    label: 'Users', live: true },
  { id: 'storage',  label: 'Storage', live: true },
  { id: 'secrets',  label: 'Secrets', live: true },
  { id: 'functions',label: 'Edge functions', live: true },
  { id: 'domains',  label: 'Domains', live: true },
  { id: 'logs',     label: 'Logs', live: true },
  { id: 'usage',    label: 'Usage', live: true },
];

// Navigate to the dedicated Cloud page (hash route). The console itself is
// rendered by mountCloudConsole() when the router enters #cloud. Keeping this
// export means the existing #cloud-btn wiring + More-menu delegate are unchanged.
// Remember the view the user was on before entering the Cloud console, so the
// "← Back" button returns there (the build, or the dashboard) instead of a
// fixed destination — and so it never dumps you on the dashboard when there's
// no prototype id.
let _returnHash = null;
export function openCloudConsole() {
  const cur = String(location.hash || '');
  if (!cur.replace(/^#/, '').startsWith('cloud')) _returnHash = cur;
  location.hash = 'cloud=' + (getActivePrototypeId() || '');
}

// Render the Cloud console into `rootEl` (the #cloud-view full-screen view).
// Called by the router (mountCloud DI hook) on every entry to #cloud=<id>.
export function mountCloudConsole(rootEl, prototypeId) {
  if (!rootEl) return;
  rootEl.innerHTML = '';
  rootEl.classList.add('cloud-view');

  // Header: ← back to the build + title
  const header = document.createElement('div');
  header.className = 'cloud-view-head';
  const back = document.createElement('button');
  back.type = 'button'; back.className = 'cloud-view-back'; back.textContent = '← Back';
  back.title = 'Back to the build';
  back.addEventListener('click', () => {
    // Return to the view we came from (build or dashboard). Fall back to the
    // app for this prototype, or the dashboard, if we were deep-linked here.
    if (_returnHash != null && !_returnHash.replace(/^#/, '').startsWith('cloud')) {
      location.hash = _returnHash;
    } else {
      location.hash = prototypeId ? 'app=' + prototypeId : '';
    }
  });
  const title = document.createElement('div');
  title.className = 'cloud-view-title'; title.textContent = 'Cloud';
  header.append(back, title);

  // Body: left rail + content
  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'cloud-view-body';
  const rail = document.createElement('div');
  rail.className = 'cloud-view-rail';
  const content = document.createElement('div');
  content.className = 'cloud-view-content';
  bodyWrap.append(rail, content);

  rootEl.append(header, bodyWrap);

  // State
  let backend = null;       // public backend row once live
  let activeTab = 'overview';
  const railButtons = new Map();

  function setActive(id) {
    activeTab = id;
    for (const [tid, b] of railButtons) {
      const on = tid === id;
      b.style.background = on ? 'var(--accent,#7c3aed)' : 'none';
      b.style.color = on ? '#fff' : 'var(--text)';
    }
    renderTab();
  }

  for (const tab of TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = tab.label + (tab.live ? '' : ' ·');
    b.style.cssText = 'text-align:left;border:none;background:none;color:var(--text);font-family:inherit;font-size:13px;padding:8px 10px;border-radius:8px;cursor:pointer;';
    b.addEventListener('click', () => setActive(tab.id));
    rail.append(b);
    railButtons.set(tab.id, b);
  }

  function note(text, muted = true) {
    const d = document.createElement('div');
    d.textContent = text;
    d.style.cssText = `font-size:13px;color:${muted ? 'var(--text-muted)' : 'var(--text)'};`;
    return d;
  }

  // Provision / status gate shown when there's no live backend.
  async function renderGate() {
    content.innerHTML = '';
    if (!prototypeId) {
      content.append(note('Save this prototype first (it needs an id to attach a backend to).'));
      return;
    }
    content.append(note('Checking backend status…'));
    let status;
    try { status = await api(`/api/cloud/backends/${prototypeId}`); }
    catch (err) {
      content.innerHTML = '';
      if (err.status === 503) content.append(note('LingCode Cloud is not configured on this server yet.'));
      else content.append(note(`Couldn't reach Cloud: ${err.message}`));
      return;
    }
    if (status && status.status === 'live') { onLive(status); return; }
    if (status && status.status === 'provisioning') { pollProvision(); return; }

    content.innerHTML = '';
    content.append(note('No backend yet for this prototype.'));
    const btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = 'Provision a backend';
    btn.style.cssText = 'margin-top:12px;padding:10px 18px;border:none;border-radius:8px;background:var(--accent,#7c3aed);color:#fff;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;';
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Provisioning…';
      try {
        const data = await api('/api/cloud/backends', { method: 'POST', body: JSON.stringify({ prototype_id: prototypeId }) });
        onLive(data);
      } catch (err) { btn.disabled = false; btn.textContent = 'Provision a backend'; content.append(note(`Provision failed: ${err.message}`, false)); }
    });
    content.append(btn);
  }

  async function pollProvision() {
    content.innerHTML = '';
    content.append(note('Provisioning your backend…'));
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const s = await api(`/api/cloud/backends/${prototypeId}`);
        if (s && s.status === 'live') { onLive(s); return; }
        if (s && s.status === 'failed') break;
      } catch {}
    }
    content.innerHTML = '';
    content.append(note('Provisioning did not complete — try again.'));
  }

  function onLive(data) {
    backend = data;
    writeBackendConfig(prototypeId, { url: data.gateway_url, key: data.anon_key });
    syncCloudBtn();
    setActive(activeTab);
  }

  // ---- tabs ----
  function renderTab() {
    const tab = TABS.find((t) => t.id === activeTab);
    // Domains attach to the PROTOTYPE, not the backend — available even before a
    // backend is provisioned, so handle it before the backend gate.
    if (tab && tab.id === 'domains') return renderDomains();
    if (!backend) { renderGate(); return; }
    if (!tab.live) { content.innerHTML = ''; content.append(note(`${tab.label} — coming soon.`)); return; }
    if (tab.id === 'overview') return renderOverview();
    if (tab.id === 'database') return renderDatabase();
    if (tab.id === 'sql') return renderSql();
    if (tab.id === 'users') return renderUsers();
    if (tab.id === 'storage') return renderStorage();
    if (tab.id === 'secrets') return renderSecrets();
    if (tab.id === 'functions') return renderFunctions();
    if (tab.id === 'logs') return renderLogs();
    if (tab.id === 'usage') return renderUsage();
  }

  async function renderOverview() {
    content.innerHTML = '';
    content.append(note('Loading…'));
    try {
      const data = await api(`/api/cloud/backends/${prototypeId}/overview`);
      content.innerHTML = '';
      const rows = [
        ['Status', data.status],
        ['Backend ID', data.backend_id],
        ['Schema', data.schema],
        ['Gateway URL', data.gateway_url],
        ['Tables', data.table_count],
        ['Rows read / written', `${data.usage?.reads ?? 0} / ${data.usage?.writes ?? 0}`],
      ];
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
      for (const [k, v] of rows) {
        const r = document.createElement('div');
        r.style.cssText = 'display:flex;gap:12px;font-size:13px;';
        const kk = document.createElement('div'); kk.textContent = k; kk.style.cssText = 'flex:0 0 150px;color:var(--text-muted);';
        const vv = document.createElement('div'); vv.textContent = String(v ?? '—'); vv.style.cssText = 'word-break:break-all;';
        r.append(kk, vv); wrap.append(r);
      }
      // MCP "easy connect" card — paste URL + header into any MCP client.
      const mcpCard = document.createElement('div');
      mcpCard.style.cssText = 'margin-top:16px;padding:12px 14px;border:1px solid var(--border);border-radius:10px;';
      const mcpTitle = document.createElement('div');
      mcpTitle.textContent = 'Connect from Claude Desktop / Cursor (MCP)';
      mcpTitle.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:8px;';
      mcpCard.append(mcpTitle);
      const mkCopy = (label, value) => {
        const r = document.createElement('div');
        r.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0;';
        const lab = document.createElement('span'); lab.textContent = label; lab.style.cssText = 'flex:0 0 64px;color:var(--text-muted);font-size:12px;';
        const code = document.createElement('code'); code.textContent = value; code.style.cssText = 'flex:1;font-family:ui-monospace,monospace;font-size:12px;word-break:break-all;';
        const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Copy';
        btn.style.cssText = 'flex:0 0 auto;border:1px solid var(--border);background:none;color:var(--text-muted);border-radius:6px;font-size:11px;padding:3px 8px;cursor:pointer;';
        btn.addEventListener('click', async () => { try { await navigator.clipboard.writeText(value); btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200); } catch {} });
        r.append(lab, code, btn);
        return r;
      };
      mcpCard.append(mkCopy('URL', `${data.gateway_url || ''}/mcp`));
      mcpCard.append(mkCopy('Header', `Authorization: Bearer ${data.anon_key || ''}`));
      const mcpHint = document.createElement('div');
      mcpHint.textContent = 'Add as a remote (streamable-HTTP) MCP server with that URL + Authorization header. Tools: list_tables, query, select, insert, update, delete — RLS-scoped by the key.';
      mcpHint.style.cssText = 'margin-top:8px;font-size:11px;color:var(--text-muted);line-height:1.5;';
      mcpCard.append(mcpHint);

      const hint = note('Anon key is injected into the preview as window.LINGCODE_BACKEND_ANON_KEY — your app reads/writes via fetch. Create tables in the SQL editor (Run migration).');
      hint.style.marginTop = '12px';
      content.append(wrap, mcpCard, hint);
    } catch (err) { content.innerHTML = ''; content.append(note(`Overview error: ${err.message}`)); }
  }

  async function renderDatabase() {
    content.innerHTML = '';
    content.append(note('Loading tables…'));
    let tables;
    try { tables = await api(`/api/cloud/backends/${prototypeId}/tables`); }
    catch (err) { content.innerHTML = ''; content.append(note(`Database error: ${err.message}`)); return; }
    content.innerHTML = '';
    if (!tables.length) { content.append(note('No tables yet. Create one in the SQL editor (Run migration).')); return; }
    const layout = document.createElement('div');
    layout.style.cssText = 'display:flex;gap:16px;align-items:flex-start;';
    const list = document.createElement('div');
    list.style.cssText = 'flex:0 0 180px;display:flex;flex-direction:column;gap:4px;';
    const view = document.createElement('div');
    view.style.cssText = 'flex:1;min-width:0;overflow:auto;';
    layout.append(list, view);
    content.append(layout);

    async function showTable(t) {
      view.innerHTML = '';
      view.append(note(`Loading ${t.name}…`));
      try {
        const data = await api(`/api/cloud/backends/${prototypeId}/tables/${encodeURIComponent(t.name)}/rows?limit=50`);
        view.innerHTML = '';
        const h = document.createElement('div'); h.textContent = `${t.name} — ${data.rows.length} row(s)`; h.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:8px;';
        view.append(h, buildTable(data.fields, data.rows));
      } catch (err) { view.innerHTML = ''; view.append(note(`Error: ${err.message}`)); }
    }
    tables.forEach((t, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = t.name;
      b.style.cssText = 'text-align:left;border:1px solid var(--border);background:none;color:var(--text);font-family:inherit;font-size:13px;padding:7px 10px;border-radius:8px;cursor:pointer;';
      b.addEventListener('click', () => showTable(t));
      list.append(b);
      if (i === 0) showTable(t);
    });
  }

  function buildTable(fields, rows) {
    const table = document.createElement('table');
    table.style.cssText = 'border-collapse:collapse;font-size:12px;width:100%;';
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (const f of fields) {
      const th = document.createElement('th');
      th.textContent = f;
      th.style.cssText = 'text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);color:var(--text-muted);white-space:nowrap;';
      htr.append(th);
    }
    thead.append(htr); table.append(thead);
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const f of fields) {
        const td = document.createElement('td');
        const v = row[f];
        td.textContent = v === null || v === undefined ? '∅' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        td.style.cssText = 'padding:6px 8px;border-bottom:1px solid var(--border);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    return table;
  }

  function renderSql() {
    content.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

    const ta = document.createElement('textarea');
    ta.placeholder = 'SELECT * FROM notes;   — read-only here';
    ta.rows = 5;
    ta.style.cssText = 'width:100%;box-sizing:border-box;font-family:ui-monospace,monospace;font-size:13px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg,#0d0d0f);color:var(--text);resize:vertical;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;align-items:center;';
    const runBtn = document.createElement('button');
    runBtn.type = 'button'; runBtn.textContent = 'Run query';
    runBtn.style.cssText = 'padding:8px 14px;border:none;border-radius:8px;background:var(--accent,#7c3aed);color:#fff;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;';
    const migBtn = document.createElement('button');
    migBtn.type = 'button'; migBtn.textContent = 'Run migration (writes)';
    migBtn.style.cssText = 'padding:8px 14px;border:1px solid var(--border);border-radius:8px;background:none;color:var(--text);font-family:inherit;font-size:13px;cursor:pointer;';
    btnRow.append(runBtn, migBtn);

    const out = document.createElement('div');
    out.style.cssText = 'overflow:auto;';

    wrap.append(ta, btnRow, out);
    content.append(wrap);

    async function run(kind) {
      const sql = ta.value.trim();
      if (!sql) return;
      out.innerHTML = ''; out.append(note('Running…'));
      runBtn.disabled = migBtn.disabled = true;
      try {
        if (kind === 'query') {
          const data = await api(`/api/cloud/backends/${prototypeId}/sql/query`, { method: 'POST', body: JSON.stringify({ sql }) });
          out.innerHTML = '';
          out.append(buildTable(data.fields || [], data.rows || []));
        } else {
          await api(`/api/cloud/backends/${prototypeId}/sql/migrate`, { method: 'POST', body: JSON.stringify({ sql }) });
          out.innerHTML = '';
          out.append(note('Migration applied.', false));
        }
      } catch (err) { out.innerHTML = ''; out.append(note(`${err.code === 'read_only_violation' ? 'Read-only: use Run migration for writes. ' : ''}${err.message}`, false)); }
      runBtn.disabled = migBtn.disabled = false;
    }
    runBtn.addEventListener('click', () => run('query'));
    migBtn.addEventListener('click', () => run('migrate'));
  }

  async function renderUsers() {
    content.innerHTML = ''; content.append(note('Loading users…'));
    try {
      const users = await api(`/api/cloud/backends/${prototypeId}/auth/users`);
      content.innerHTML = '';
      content.append(note('End users who signed up to this app (email + password auth).'));
      if (!users.length) { content.append(note('No users yet.')); return; }
      const list = document.createElement('div'); list.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:10px;';
      for (const u of users) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;';
        const left = document.createElement('div'); left.textContent = u.email; left.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
        const del = document.createElement('button'); del.type = 'button'; del.textContent = 'Delete';
        del.style.cssText = 'border:1px solid var(--border);background:none;color:var(--text-muted);border-radius:6px;font-size:12px;padding:4px 8px;cursor:pointer;';
        del.addEventListener('click', async () => { try { await api(`/api/cloud/backends/${prototypeId}/auth/users/${u.id}`, { method: 'DELETE' }); renderUsers(); } catch (e) { alert(e.message); } });
        row.append(left, del); list.append(row);
      }
      content.append(list);
    } catch (err) { content.innerHTML = ''; content.append(note(`Users error: ${err.message}`)); }
  }

  async function renderStorage() {
    content.innerHTML = ''; content.append(note('Loading objects…'));
    try {
      const objs = await api(`/api/cloud/backends/${prototypeId}/storage/objects`);
      content.innerHTML = '';
      content.append(note('Files your app uploaded (bucket / path / size). Upload from app code via /storage/upload.'));
      if (!objs.length) { content.append(note('No objects yet.')); return; }
      content.append(buildTable(['bucket', 'path', 'content_type', 'bytes', 'created_at'],
        objs.map((o) => ({ bucket: o.bucket, path: o.path, content_type: o.content_type, bytes: o.bytes, created_at: o.created_at }))));
    } catch (err) { content.innerHTML = ''; content.append(note(`Storage error: ${err.message}`)); }
  }

  async function renderSecrets() {
    content.innerHTML = '';
    if (!prototypeId) { content.append(note('Save your prototype first.')); return; }
    content.append(note('Encrypted secrets for this backend (e.g. RESEND_API_KEY for the email function). Values are never shown back.'));
    const form = document.createElement('div'); form.style.cssText = 'display:flex;gap:6px;margin:10px 0;';
    const keyIn = document.createElement('input'); keyIn.placeholder = 'KEY_NAME'; keyIn.style.cssText = 'flex:0 0 200px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg,#0d0d0f);color:var(--text);font-family:inherit;';
    const valIn = document.createElement('input'); valIn.type = 'password'; valIn.placeholder = 'value'; valIn.style.cssText = 'flex:1;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg,#0d0d0f);color:var(--text);font-family:inherit;';
    const add = document.createElement('button'); add.type = 'button'; add.textContent = 'Pin'; add.style.cssText = 'padding:8px 14px;border:none;border-radius:8px;background:var(--accent,#7c3aed);color:#fff;font-family:inherit;font-size:13px;cursor:pointer;';
    form.append(keyIn, valIn, add);
    const listEl = document.createElement('div'); listEl.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    content.append(form, listEl);

    async function refresh() {
      listEl.innerHTML = '';
      try {
        const items = await api(`/api/prototypes/${prototypeId}/secrets`);
        for (const it of items) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;';
          const k = document.createElement('span'); k.textContent = it.key; k.style.fontFamily = 'ui-monospace,monospace';
          const del = document.createElement('button'); del.type = 'button'; del.textContent = 'Delete';
          del.style.cssText = 'border:1px solid var(--border);background:none;color:var(--text-muted);border-radius:6px;font-size:12px;padding:4px 8px;cursor:pointer;';
          del.addEventListener('click', async () => { try { await api(`/api/prototypes/${prototypeId}/secrets/${it.key}`, { method: 'DELETE' }); refresh(); } catch (e) { alert(e.message); } });
          row.append(k, del); listEl.append(row);
        }
      } catch (err) { listEl.append(note(err.status === 503 ? 'Secrets vault not configured on this server.' : err.message)); }
    }
    add.addEventListener('click', async () => {
      const key = keyIn.value.trim(); const value = valIn.value;
      if (!key || !value) return;
      try { await api(`/api/prototypes/${prototypeId}/secrets/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ value }) }); keyIn.value = ''; valIn.value = ''; refresh(); }
      catch (e) { alert(e.message); }
    });
    refresh();
  }

  async function renderDomains() {
    content.innerHTML = '';
    if (!prototypeId) { content.append(note('Save your prototype first (a domain attaches to a saved prototype).')); return; }
    content.append(note('Serve this app on your own domain. Add it, point your DNS at LingCode, and HTTPS is issued automatically on the first request.'));
    const form = document.createElement('div'); form.style.cssText = 'display:flex;gap:6px;margin:10px 0;';
    const input = document.createElement('input'); input.placeholder = 'app.yoursite.com'; input.style.cssText = 'flex:1;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg,#0d0d0f);color:var(--text);font-family:inherit;';
    const add = document.createElement('button'); add.type = 'button'; add.textContent = 'Add'; add.style.cssText = 'padding:8px 14px;border:none;border-radius:8px;background:var(--accent,#7c3aed);color:#fff;font-family:inherit;font-size:13px;cursor:pointer;';
    form.append(input, add);
    const dns = document.createElement('div');
    dns.style.cssText = 'font-size:12px;color:var(--text-muted);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:0 0 10px;font-family:ui-monospace,monospace;line-height:1.7;';
    dns.innerHTML = 'Then point DNS at LingCode:<br>'
      + 'Subdomain (recommended): <b>CNAME</b> your host → <b>apps.lingcode.dev</b><br>'
      + 'Root domain: <b>A</b> your host → <b>138.197.107.228</b><br>'
      + 'On Cloudflare, set the record to <b>DNS-only</b> (grey cloud) so the edge can issue TLS.';
    const listEl = document.createElement('div'); listEl.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    content.append(form, dns, listEl);

    async function refresh() {
      listEl.innerHTML = '';
      let rows;
      try { rows = await api(`/api/account/prototypes/${prototypeId}/custom-domains`); }
      catch (err) { listEl.append(note(err.status === 401 ? 'Sign in to manage custom domains.' : err.message)); return; }
      if (!rows || !rows.length) { listEl.append(note('No custom domains attached yet.')); return; }
      for (const it of rows) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;';
        const left = document.createElement('div');
        const host = document.createElement('a'); host.href = 'https://' + it.domain; host.target = '_blank'; host.rel = 'noopener';
        host.textContent = it.domain; host.style.cssText = 'font-family:ui-monospace,monospace;color:var(--accent,#7c3aed);text-decoration:none;';
        const st = document.createElement('span'); st.textContent = it.status || 'active'; st.style.cssText = 'font-size:11px;color:var(--text-muted);margin-left:10px;';
        left.append(host, st);
        const del = document.createElement('button'); del.type = 'button'; del.textContent = 'Remove';
        del.style.cssText = 'border:1px solid var(--border);background:none;color:var(--text-muted);border-radius:6px;font-size:12px;padding:4px 8px;cursor:pointer;';
        del.addEventListener('click', async () => {
          if (!confirm('Remove ' + it.domain + '?')) return;
          try { await api(`/api/account/prototypes/${prototypeId}/custom-domains/${encodeURIComponent(it.domain)}`, { method: 'DELETE' }); refresh(); }
          catch (e) { alert(e.message); }
        });
        row.append(left, del); listEl.append(row);
      }
    }
    add.addEventListener('click', async () => {
      const domain = input.value.trim().toLowerCase();
      if (!domain) return;
      try { await api(`/api/account/prototypes/${prototypeId}/custom-domains`, { method: 'POST', body: JSON.stringify({ domain }) }); input.value = ''; refresh(); }
      catch (e) { alert(e.message); }
    });
    refresh();
  }

  async function renderFunctions() {
    content.innerHTML = ''; content.append(note('Loading functions…'));
    try {
      const fns = await api(`/api/cloud/backends/${prototypeId}/functions`);
      content.innerHTML = '';
      content.append(note('Curated server functions your app can invoke. Call from app code: POST <BACKEND_URL>/functions/<slug>.'));
      const list = document.createElement('div'); list.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:10px;';
      for (const f of fns) {
        const card = document.createElement('div');
        card.style.cssText = 'padding:10px 12px;border:1px solid var(--border);border-radius:10px;';
        const h = document.createElement('div'); h.textContent = `${f.name}  ·  ${f.slug}`; h.style.cssText = 'font-weight:600;font-size:13px;';
        const d = document.createElement('div'); d.textContent = f.description; d.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:2px;';
        card.append(h, d);
        if (f.required_secrets && f.required_secrets.length) {
          const s = document.createElement('div'); s.textContent = `Requires secret: ${f.required_secrets.join(', ')}`; s.style.cssText = 'font-size:11px;color:var(--text-muted);margin-top:4px;';
          card.append(s);
        }
        list.append(card);
      }
      content.append(list);
    } catch (err) { content.innerHTML = ''; content.append(note(`Functions error: ${err.message}`)); }
  }

  async function renderLogs() {
    content.innerHTML = ''; content.append(note('Loading logs…'));
    try {
      const logs = await api(`/api/cloud/backends/${prototypeId}/logs`);
      content.innerHTML = '';
      if (!logs.length) { content.append(note('No log entries yet.')); return; }
      const pre = document.createElement('div'); pre.style.cssText = 'font-family:ui-monospace,monospace;font-size:12px;display:flex;flex-direction:column;gap:2px;';
      for (const l of logs) {
        const line = document.createElement('div');
        line.textContent = `${l.ts}  [${l.source}/${l.level}]  ${l.message}`;
        line.style.color = l.level === 'error' ? '#f87171' : 'var(--text-muted)';
        pre.append(line);
      }
      content.append(pre);
    } catch (err) { content.innerHTML = ''; content.append(note(`Logs error: ${err.message}`)); }
  }

  async function renderUsage() {
    content.innerHTML = ''; content.append(note('Loading usage…'));
    try {
      const data = await api(`/api/cloud/backends/${prototypeId}/overview`);
      content.innerHTML = '';
      const rows = [
        ['Tables', data.table_count ?? '—'],
        ['Rows read (all-time)', data.usage?.reads ?? 0],
        ['Rows written (all-time)', data.usage?.writes ?? 0],
      ];
      const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
      for (const [k, v] of rows) {
        const r = document.createElement('div'); r.style.cssText = 'display:flex;gap:12px;font-size:13px;';
        const kk = document.createElement('div'); kk.textContent = k; kk.style.cssText = 'flex:0 0 200px;color:var(--text-muted);';
        const vv = document.createElement('div'); vv.textContent = String(v);
        r.append(kk, vv); wrap.append(r);
      }
      content.append(wrap);
    } catch (err) { content.innerHTML = ''; content.append(note(`Usage error: ${err.message}`)); }
  }

  // Initial paint
  setActive('overview');
}
