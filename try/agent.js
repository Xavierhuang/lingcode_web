// agent.js — multi-provider streaming + minimal tool loop, all client-side.
//
// The unique pitch: same agent loop talks to Anthropic OR any OpenAI-compatible
// endpoint (DeepSeek/OpenAI/Groq/Gemini-via-OpenAI/etc). Every byte goes
// browser → provider; nothing routes through our server.

// ---- Provider catalog --------------------------------------------------

export const PROVIDERS = [
  {
    // LingModel — server-proxied, no key needed. Single tier as of the
    // Standard/Advanced collapse. Free tier limits applied server-side.
    id: 'lingmodel',
    name: 'LingModel',
    model: 'kimi-k2.7',
    shape: 'anthropic',
    proxied: true,
    base: '/api/inference/anthropic/v1/messages',
    keyHint: '',
    color: '#00d084',
    pricePer1M: { input: 0, output: 0 },
    vision: true,
    // Client asks for the Pro ceiling. Server clamps Free to 24K via
    // inference-anthropic.js DEFAULT_MAX_OUT_FREE, so this isn't a leak.
    maxOutputTokens: 65536,
  },
  {
    id: 'claude',
    name: 'Claude',
    model: 'claude-fable-5',
    shape: 'anthropic',
    base: 'https://api.anthropic.com/v1/messages',
    keyHint: 'sk-ant-...',
    color: '#cc785c',
    pricePer1M: { input: 10.00, output: 50.00 },
    vision: true,
    maxOutputTokens: 64000,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek-V4',
    model: 'deepseek-v4-flash',
    shape: 'openai',
    base: 'https://api.deepseek.com/v1/chat/completions',
    keyHint: 'sk-...',
    color: '#4d6bfe',
    pricePer1M: { input: 0.27, output: 1.10 },
    maxOutputTokens: 8192,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    model: 'gpt-4o-mini',
    shape: 'openai',
    base: 'https://api.openai.com/v1/chat/completions',
    keyHint: 'sk-...',
    color: '#10a37f',
    pricePer1M: { input: 0.15, output: 0.60 },
    vision: true,
    maxOutputTokens: 16384,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    model: 'gemini-2.5-flash',
    shape: 'openai',
    // OpenAI-compatible endpoint exposed by Google.
    base: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    keyHint: 'AI...',
    color: '#4285f4',
    pricePer1M: { input: 0.30, output: 2.50 },
    vision: true,
    maxOutputTokens: 8192,
  },
  {
    id: 'groq',
    name: 'Groq',
    model: 'llama-3.3-70b-versatile',
    shape: 'openai',
    base: 'https://api.groq.com/openai/v1/chat/completions',
    keyHint: 'gsk_...',
    color: '#f55036',
    pricePer1M: { input: 0.59, output: 0.79 },
    maxOutputTokens: 8192,
  },
  // ---- Below this line: collapsed by default, revealed via 'More providers' ----
  {
    id: 'mistral',
    name: 'Mistral',
    model: 'mistral-small-latest',
    shape: 'openai',
    base: 'https://api.mistral.ai/v1/chat/completions',
    keyHint: 'sk-...',
    color: '#ff7000',
    pricePer1M: { input: 0.20, output: 0.60 },
    secondary: true,
    maxOutputTokens: 8192,
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    model: 'grok-2-latest',
    shape: 'openai',
    base: 'https://api.x.ai/v1/chat/completions',
    keyHint: 'xai-...',
    color: '#a3a3a3',
    pricePer1M: { input: 2.00, output: 10.00 },
    secondary: true,
    maxOutputTokens: 16384,
  },
  {
    id: 'together',
    name: 'Together',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    shape: 'openai',
    base: 'https://api.together.xyz/v1/chat/completions',
    keyHint: 'tgp-...',
    color: '#5436da',
    pricePer1M: { input: 0.88, output: 0.88 },
    secondary: true,
    maxOutputTokens: 8192,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    model: 'anthropic/claude-haiku-4-5',
    shape: 'openai',
    base: 'https://openrouter.ai/api/v1/chat/completions',
    keyHint: 'sk-or-...',
    color: '#818cf8',
    pricePer1M: { input: 1.00, output: 5.00 },
    secondary: true,
    maxOutputTokens: 32000,
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    model: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
    shape: 'openai',
    base: 'https://api.fireworks.ai/inference/v1/chat/completions',
    keyHint: 'fw_...',
    color: '#ff7a00',
    pricePer1M: { input: 0.90, output: 0.90 },
    secondary: true,
    maxOutputTokens: 8192,
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    model: 'moonshot-v1-8k',
    shape: 'openai',
    base: 'https://api.moonshot.ai/v1/chat/completions',
    keyHint: 'sk-...',
    color: '#16a34a',
    pricePer1M: { input: 0.20, output: 1.00 },
    secondary: true,
    maxOutputTokens: 8192,  // hard 8K — model name says it
  },
  {
    id: 'qwen',
    name: 'Qwen',
    model: 'qwen-max',
    shape: 'openai',
    base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    keyHint: 'sk-...',
    color: '#f97316',
    pricePer1M: { input: 1.60, output: 6.40 },
    secondary: true,
    maxOutputTokens: 8192,
  },
  {
    id: 'zai',
    name: 'z.ai (GLM-5.1)',
    model: 'glm-5.1',
    shape: 'openai',
    base: 'https://api.z.ai/api/paas/v4/chat/completions',
    keyHint: '...',
    color: '#1d4ed8',
    pricePer1M: { input: 0.60, output: 2.20 },  // verify with z.ai pricing
    secondary: true,
    maxOutputTokens: 16384,
  },
];

// ---- Cost helper -------------------------------------------------------

export function estimateCostUSD(provider, inputTokens, outputTokens) {
  const p = provider.pricePer1M;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export function formatCost(usd) {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

// ---- Tool schemas ------------------------------------------------------
// JSON Schema works in both Anthropic ('input_schema') and OpenAI shapes.

export const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file from the workspace.',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path within the workspace.' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the workspace.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'List files in a directory of the workspace.',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative dir, "" for root.' } },
      required: ['path'],
    },
  },
];

// Image generation tool — always included (no workspace needed).
// The executor constructs a Pollinations.ai URL and returns it as JSON;
// the model embeds it directly in <img src="..."> tags.
export const IMAGE_TOOLS = [
  {
    name: 'generate_image',
    description: 'Generate an image from a text prompt using AI. Returns a JSON object with a "url" field you can use directly in an <img src="..."> tag. Use for hero images, illustrations, product shots, backgrounds, avatars — any visual asset the design calls for.',
    schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image. Include style, lighting, subject, color palette. More detail = better result.',
        },
        width: {
          type: 'number',
          description: 'Width in pixels. Defaults to 1024. Use 1920 for full-width banners, 512 for thumbnails.',
        },
        height: {
          type: 'number',
          description: 'Height in pixels. Defaults to 1024.',
        },
      },
      required: ['prompt'],
    },
  },
];

// Supabase tools — appended to the model's tool list when the user has
// connected their Supabase account via /api/supabase/oauth (Phase 2). The
// executor for these tools POSTs to /api/supabase/tools/<name>; the
// server resolves the user's refresh token and proxies via
// supabase-management.js. Never exposed to anonymous users — gated
// client-side on the OAuth-connected status.
export const SUPABASE_TOOLS = [
  {
    name: 'list_organizations',
    description: 'List Supabase organizations the user belongs to. Use before create_project to pick organization_id.',
    schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'create_supabase_project',
    description: 'Create a new Supabase project under the given organization. Returns project_ref + anon_key. Project provisioning takes ~30s before the database is reachable.',
    schema: {
      type: 'object',
      properties: {
        organization_id: { type: 'string', description: 'From list_organizations.' },
        name: { type: 'string', description: 'Display name; will be slugified by Supabase.' },
        region: { type: 'string', description: 'AWS region, e.g. us-east-1, eu-west-1, ap-southeast-1. Default us-east-1.' },
      },
      required: ['organization_id', 'name'],
    },
  },
  {
    name: 'list_supabase_tables',
    description: 'List tables (and their columns) in the public schema of the given project. Use to discover existing schema before issuing migrations.',
    schema: {
      type: 'object',
      properties: {
        project_ref: { type: 'string' },
        schema: { type: 'string', description: 'Default "public".' },
      },
      required: ['project_ref'],
    },
  },
  {
    name: 'apply_migration',
    description: 'Run a CREATE/ALTER/DROP SQL migration against the project database. Logged into supabase/migrations history. Prefer apply_rls_template for RLS — it picks from a vetted set of policy patterns instead of freeforming SQL.',
    schema: {
      type: 'object',
      properties: {
        project_ref: { type: 'string' },
        name: { type: 'string', description: 'Migration filename (e.g. "create_notes_table"). Lowercased + snake_case.' },
        sql: { type: 'string', description: 'Full SQL text. Multi-statement allowed.' },
      },
      required: ['project_ref', 'name', 'sql'],
    },
  },
  {
    name: 'apply_rls_template',
    description: 'Apply one of the vetted RLS policy templates to a table. Templates: user-owns-row, team-scoped, public-read-auth-write, soft-delete-aware, read-self-write-self, service-role-only. Pass params (TABLE, USER_COL, etc.) per template; values must be snake_case identifiers.',
    schema: {
      type: 'object',
      properties: {
        project_ref: { type: 'string' },
        template_id: {
          type: 'string',
          enum: ['user-owns-row', 'team-scoped', 'public-read-auth-write', 'soft-delete-aware', 'read-self-write-self', 'service-role-only'],
        },
        params: {
          type: 'object',
          description: 'Template params. Keys are uppercase (TABLE, USER_COL, …); values must match /^[a-z_][a-z0-9_]*$/.',
        },
      },
      required: ['project_ref', 'template_id', 'params'],
    },
  },
  {
    name: 'query_database',
    description: 'Run a read-only SELECT against the project database. Use sparingly — for schema introspection prefer list_supabase_tables. Returns up to 1000 rows.',
    schema: {
      type: 'object',
      properties: {
        project_ref: { type: 'string' },
        sql: { type: 'string', description: 'Single SELECT statement.' },
      },
      required: ['project_ref', 'sql'],
    },
  },
  {
    name: 'get_anon_key',
    description: 'Fetch the public anon key for the project. Use after create_supabase_project to wire the client SDK. Returns null while the project is still provisioning (≤30s after create).',
    schema: {
      type: 'object',
      properties: {
        project_ref: { type: 'string' },
      },
      required: ['project_ref'],
    },
  },
  {
    name: 'add_stripe_checkout',
    description: 'Deploy a curated Stripe checkout-session Edge Function to the project. Reads STRIPE_SECRET_KEY from the prototype\'s 🔐 Secrets vault and pushes it into the project\'s Edge Function env, then deploys the function at /functions/v1/stripe-checkout. Body shape the deployed function expects: { price_id, quantity?, success_url, cancel_url }. Tell the user to pin STRIPE_SECRET_KEY in 🔐 Secrets first if missing.',
    schema: {
      type: 'object',
      properties: {
        project_ref: { type: 'string' },
        prototype_id: { type: 'string', description: 'The saved-prototype id whose 🔐 Secrets vault holds STRIPE_SECRET_KEY.' },
      },
      required: ['project_ref', 'prototype_id'],
    },
  },
];

// Tier-2 tools: Tier-1 set + run_command (a WebContainer shell). Used when
// the prototype graduates to a real Vite + React + TS + Tailwind + shadcn
// project running under @stackblitz/sdk. The executor that backs these
// lives in webcontainer-host.js (Phase 1, not yet wired). Tool *schemas*
// are intentionally shipped ahead of the dispatcher so the prompt
// surface and provider-side validation stabilize first.
export const TIER2_TOOLS = [
  ...TOOLS,
  {
    name: 'run_command',
    description: 'Run a shell command inside the WebContainer (Tier-2 only). Use for npm install, npm run dev, npx supabase db push, git, etc. Long-running processes (vite dev server) should be started with start:true and their pid returned.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Argv-0 (e.g. "npm", "npx", "node", "git").' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Argument list, no shell expansion. Example: ["install"] or ["run", "build"].',
        },
        cwd: { type: 'string', description: 'Working directory relative to project root. Default "".' },
        start: {
          type: 'boolean',
          description: 'If true, spawn as a background process and return immediately with a pid. If false (default), run to completion and return stdout/stderr/exitCode.',
        },
      },
      required: ['command', 'args'],
    },
  },
];

// Cloud tools — appended to the model's tool list when the active prototype
// has a live LingCode Cloud backend (managed Postgres). The executor
// (execCloudTool in main-cloud.js) POSTs these to /api/cloud/tools/<name>,
// injecting the prototype_id server-side from the session. Lets the model set
// up and inspect the backend itself — create tables, run migrations, read
// data — instead of only emitting fetch() code. Mutually exclusive with
// SUPABASE_TOOLS (apply_migration/query_database names overlap); one backend
// per prototype.
export const CLOUD_TOOLS = [
  {
    name: 'provision_backend',
    description: "Create the managed Postgres backend (with built-in email/password & magic-link auth) for this app. Call this FIRST, before apply_migration, whenever the app needs to persist data or support user accounts. Idempotent — safe to call once; returns the existing backend if already provisioned. After this, the backend URL + anon key are injected into the preview automatically.",
    schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_tables',
    description: "List the tables (and their columns) in this prototype's managed backend. Use to discover existing schema before writing migrations or app code.",
    schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_backend_info',
    description: 'Get the backend URL, anon key, and schema name for this prototype. The URL + anon key are already injected into the preview as window.LINGCODE_BACKEND_URL / window.LINGCODE_BACKEND_ANON_KEY — never hardcode them in app code.',
    schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'apply_migration',
    description: 'Run a CREATE/ALTER/DROP SQL migration against the backend Postgres. This is how you create the tables your app needs — do it before generating app code that reads/writes them. Multi-statement SQL allowed (≤200KB).',
    schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Full SQL migration text, e.g. CREATE TABLE notes (id serial primary key, body text, created_at timestamptz default now()).' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'query_database',
    description: 'Run a read-only SELECT/WITH query against the backend Postgres and get the rows back (≤50KB SQL). Use to verify schema or inspect data; use apply_migration for any writes.',
    schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single read-only SELECT or WITH statement.' },
      },
      required: ['sql'],
    },
  },
];

// ---- Streaming helpers -------------------------------------------------

async function* sseLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data: ')) {
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') return;
        try { yield JSON.parse(payload); } catch { /* skip malformed */ }
      }
    }
  }
}

// ---- Anthropic shape ---------------------------------------------------

async function* runAnthropic({ provider, apiKey, messages, system, tools, abortSignal }) {
  const body = {
    model: provider.model,
    // Per-provider cap (provider.maxOutputTokens). 8192 is the LCD; modern
    // Claude / Haiku 4.5 can stretch to 32K without 400-ing. Anything higher
    // and the request fails for restrictive backends like the LingModel proxy.
    max_tokens: provider.maxOutputTokens || 8192,
    stream: true,
    messages,
  };
  if (system) body.system = system;
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema,
    }));
  }

  // LingModel-proxied path uses our server's session cookie; everything else
  // talks direct to Anthropic with the user's pasted key.
  const headers = provider.proxied
    ? { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };

  const res = await fetch(provider.base, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: abortSignal,
    credentials: provider.proxied ? 'include' : 'omit',
  });
  if (!res.ok) {
    const errText = await res.text();
    if (provider.proxied) {
      // 401 = signed out, 402 = quota used — surface friendly messages. When
      // the server sets `upgrade_required: true` (lifetime-cap hit, not the
      // daily one), also dispatch a window event so main-upgrade-modal.js
      // shows the paywall — distinct from the error toast which always fires.
      try {
        const j = JSON.parse(errText);
        if (res.status === 401) {
          const err = new Error(j.message || 'Sign in to use LingModel (free queries for signed-in users). Or paste your own key for any other provider.');
          err.needsSignin = true;
          throw err;
        }
        if (res.status === 402) {
          const err = new Error(j.message || "You've reached your LingModel limit. Upgrade to keep building, or paste your own key for any other provider.");
          err.quota = true;
          err.upgradeRequired = !!j.upgrade_required;
          err.upgradeUrl = j.upgrade_url;
          // Always surface the upgrade/paywall modal on a quota hit — not only
          // when the server flags upgrade_required — so the user is never left
          // staring at a silent failure. main-upgrade-modal.js listens for this.
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('lingmodel:upgrade-required', {
              detail: { message: err.message, upgradeUrl: err.upgradeUrl }
            }));
          }
          throw err;
        }
        throw new Error(j.error || j.message || `LingModel HTTP ${res.status}`);
      } catch (e) {
        // Preserve our tagged, user-facing errors (signin / quota / upgrade) so
        // callers can introspect them and the friendly message survives; only
        // unparseable bodies fall through to the generic message.
        if (e && (e.upgradeRequired || e.quota || e.needsSignin)) throw e;
        throw new Error(`LingModel HTTP ${res.status}: ${errText.slice(0, 240)}`);
      }
    }
    throw new Error(`${provider.name} HTTP ${res.status}: ${errText.slice(0, 240)}`);
  }

  const toolCalls = []; // [{id, name, args: {}}]
  // DeepSeek V4 emits `thinking` content blocks (its internal CoT) and the
  // anthropic-compat endpoint requires those blocks to be echoed back in
  // the assistant message on the next agentic turn — otherwise it 400s with
  // "content[].thinking must be passed back". We capture them here and
  // forward via `thinkingBlocks` so runAgent can replay them.
  const thinkingBlocks = []; // [{type:'thinking', thinking, signature?}]
  let textOut = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let currentBlock = null; // {kind:'tool'|'thinking', ...}
  let stopReason = null;   // "end_turn" | "max_tokens" | "tool_use" | "stop_sequence"

  for await (const evt of sseLines(res)) {
    const t = evt.type;
    if (t === 'content_block_start') {
      const cbType = evt.content_block?.type;
      if (cbType === 'tool_use') {
        currentBlock = { kind: 'tool', id: evt.content_block.id, name: evt.content_block.name, partialJson: '' };
      } else if (cbType === 'thinking') {
        currentBlock = { kind: 'thinking', thinking: evt.content_block.thinking || '', signature: '' };
      } else {
        currentBlock = null;
      }
    } else if (t === 'content_block_delta') {
      const dt = evt.delta?.type;
      if (dt === 'text_delta') {
        textOut += evt.delta.text || '';
        yield { kind: 'text', text: evt.delta.text || '' };
      } else if (dt === 'input_json_delta' && currentBlock?.kind === 'tool') {
        currentBlock.partialJson += evt.delta.partial_json || '';
      } else if (dt === 'thinking_delta' && currentBlock?.kind === 'thinking') {
        currentBlock.thinking += evt.delta.thinking || '';
      } else if (dt === 'signature_delta' && currentBlock?.kind === 'thinking') {
        currentBlock.signature += evt.delta.signature || '';
      }
    } else if (t === 'content_block_stop') {
      if (currentBlock?.kind === 'tool') {
        let args = {};
        try { args = currentBlock.partialJson ? JSON.parse(currentBlock.partialJson) : {}; } catch {}
        toolCalls.push({ id: currentBlock.id, name: currentBlock.name, args });
        yield { kind: 'tool_call', name: currentBlock.name, args };
      } else if (currentBlock?.kind === 'thinking') {
        const block = { type: 'thinking', thinking: currentBlock.thinking };
        if (currentBlock.signature) block.signature = currentBlock.signature;
        thinkingBlocks.push(block);
      }
      currentBlock = null;
    } else if (t === 'message_delta') {
      if (evt.usage?.input_tokens != null) inputTokens = evt.usage.input_tokens;
      if (evt.usage?.output_tokens != null) outputTokens = evt.usage.output_tokens;
      if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
    }
  }
  yield { kind: 'done', text: textOut, toolCalls, thinkingBlocks, inputTokens, outputTokens, stopReason };
}

// ---- OpenAI shape ------------------------------------------------------

async function* runOpenAI({ provider, apiKey, messages, system, tools, abortSignal }) {
  const allMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const body = {
    model: provider.model,
    messages: allMessages,
    stream: true,
    stream_options: { include_usage: true },
    // Per-provider cap. Most OpenAI-shape backends silently clamp if asked
    // above the model's natural limit, so over-asking here is safer than
    // under-asking and triggering a "truncated by output cap" badge.
    max_tokens: provider.maxOutputTokens || 8192,
  };
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.schema },
    }));
  }

  const res = await fetch(provider.base, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: abortSignal,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${provider.name} HTTP ${res.status}: ${errText.slice(0, 240)}`);
  }

  const partials = new Map(); // index → {id, name, args:''}
  let textOut = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = null; // normalized to Anthropic vocab: "max_tokens" / "end_turn" / "tool_use"

  for await (const evt of sseLines(res)) {
    const usage = evt.usage;
    if (usage) {
      if (usage.prompt_tokens != null) inputTokens = usage.prompt_tokens;
      if (usage.completion_tokens != null) outputTokens = usage.completion_tokens;
    }
    const choice = evt.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) {
      // Map OpenAI's vocabulary onto Anthropic's so consumers don't need to handle both.
      const fr = choice.finish_reason;
      stopReason = fr === 'length' ? 'max_tokens'
        : fr === 'tool_calls' ? 'tool_use'
        : fr === 'stop' ? 'end_turn'
        : fr;
    }
    const delta = choice.delta || {};
    if (delta.content) {
      textOut += delta.content;
      yield { kind: 'text', text: delta.content };
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const cur = partials.get(idx) || { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        partials.set(idx, cur);
      }
    }
  }

  const toolCalls = [];
  for (const p of partials.values()) {
    let args = {};
    try { args = p.args ? JSON.parse(p.args) : {}; } catch {}
    toolCalls.push({ id: p.id, name: p.name, args });
    yield { kind: 'tool_call', name: p.name, args };
  }
  yield { kind: 'done', text: textOut, toolCalls, inputTokens, outputTokens, stopReason };
}

// ---- Public entry point ------------------------------------------------

// Demo-mode hook. When set (by demo.js for /try.html?demo=1), runOnce
// delegates to the scripted runner instead of calling real provider APIs.
// Lets the page replay cached benchmark runs without burning quota — the
// pane code can't tell the difference because the event shape is identical.
let _demoRunner = null;
export function setDemoRunner(fn) { _demoRunner = fn; }

export async function* runOnce({ provider, apiKey, messages, system, tools, abortSignal }) {
  if (_demoRunner) {
    yield* _demoRunner({ provider, apiKey, messages, system, tools, abortSignal });
    return;
  }
  if (provider.shape === 'anthropic') {
    yield* runAnthropic({ provider, apiKey, messages, system, tools, abortSignal });
  } else {
    yield* runOpenAI({ provider, apiKey, messages, system, tools, abortSignal });
  }
}

// ---- Multi-turn agent loop --------------------------------------------
// Calls runOnce, executes any tool calls via the supplied executor, loops
// until the model produces a final text answer with no further tool calls
// or until maxTurns is hit.

// Repair orphaned tool calls in a rehydrated history before it goes upstream.
// Upstreams (Kimi/Moonshot, DeepSeek-anthropic, OpenAI) HARD-400 if an
// assistant turn announces a tool call whose id never gets a matching result
// message — "tool_call_ids did not have response". A saved/resumed session
// (pane.history) can be truncated mid-tool-call, leaving exactly that shape,
// which kills every subsequent build with no visible cause. For each orphan we
// SYNTHESIZE a stub result ("[interrupted]") so the pairing is valid and the
// conversation context is preserved. Handles both wire shapes. No-op on a
// well-formed array, so it's safe to run unconditionally.
function repairOrphanedToolCalls(messages, isAnthropic) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const out = [];

  if (isAnthropic) {
    // Anthropic: assistant content[] has {type:'tool_use', id}; the matching
    // result is {type:'tool_result', tool_use_id} in the NEXT user message.
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      out.push(msg);
      const blocks = msg && msg.role === 'assistant' && Array.isArray(msg.content) ? msg.content : null;
      if (!blocks) continue;
      const callIds = blocks.filter((b) => b && b.type === 'tool_use' && b.id).map((b) => b.id);
      if (!callIds.length) continue;
      const next = messages[i + 1];
      const answered = new Set();
      if (next && next.role === 'user' && Array.isArray(next.content)) {
        for (const b of next.content) {
          if (b && b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id);
        }
      }
      const missing = callIds.filter((id) => !answered.has(id));
      if (!missing.length) continue;
      const stubs = missing.map((id) => ({ type: 'tool_result', tool_use_id: id, content: '[interrupted]' }));
      if (next && next.role === 'user' && Array.isArray(next.content)) {
        next.content = [...stubs, ...next.content]; // results must precede other blocks
      } else {
        out.push({ role: 'user', content: stubs });
      }
    }
    return out;
  }

  // OpenAI: assistant message carries tool_calls[{id}]; each needs a following
  // {role:'tool', tool_call_id} message before the next assistant/user turn.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    out.push(msg);
    const calls = msg && msg.role === 'assistant' && Array.isArray(msg.tool_calls) ? msg.tool_calls : null;
    if (!calls || !calls.length) continue;
    const answered = new Set();
    for (let j = i + 1; j < messages.length; j++) {
      const m = messages[j];
      if (m && m.role === 'tool' && m.tool_call_id) { answered.add(m.tool_call_id); continue; }
      break; // tool results are contiguous right after the assistant turn
    }
    for (const c of calls) {
      if (c && c.id && !answered.has(c.id)) {
        out.push({ role: 'tool', tool_call_id: c.id, content: '[interrupted]' });
      }
    }
  }
  return out;
}

// Splits a "data:image/xxx;base64,YYYY" data URL into { mediaType, data }.
function parseDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;,]+)(?:;base64)?,(.+)$/);
  if (!m) return null;
  return { mediaType: m[1] || 'image/png', data: m[2] };
}

// Build a single user-message in the provider-specific multipart format.
// images: array of { dataUrl, name? }
// docs:   array of { name, text, dataUrl? } where dataUrl is "data:application/pdf;base64,..."
//
// Native Anthropic (proxied=false): docs ride as `document` content blocks —
//   Claude reads images/layout/tables in the PDF natively.
// Proxied Anthropic (LingModel → DeepSeek) + OpenAI-shape providers: PDFs
//   are sent as plain extracted text prepended to the message — the upstream
//   APIs don't support document blocks.
function buildUserMessage({ shape, proxied = false, text, images, docs }) {
  const safeImages = images || [];
  const safeDocs = docs || [];

  // Whether this provider can natively accept PDFs as document content blocks.
  // Only native Anthropic (Claude direct) does; proxied Anthropic (LingModel)
  // forwards to DeepSeek which silently drops document blocks.
  const nativePdf = shape === 'anthropic' && !proxied;

  // For non-native-PDF providers, prepend extracted PDF text to the user
  // message so the model receives the content as plain text.
  const composedText = (!nativePdf && safeDocs.length > 0)
    ? safeDocs.map((d) => d.text).join('\n\n') + '\n\n---\n\n' + text
    : text;

  if (!safeImages.length && (!nativePdf || safeDocs.length === 0)) {
    // No multipart content needed — single text block (or plain string for OpenAI).
    return shape === 'anthropic'
      ? { role: 'user', content: [{ type: 'text', text: composedText }] }
      : { role: 'user', content: composedText };
  }

  if (shape === 'anthropic') {
    // Anthropic multipart. Order: documents → images → text (matches their
    // docs' recommended ordering for grounding-before-instruction).
    const content = [];
    if (nativePdf) {
      for (const d of safeDocs) {
        if (!d.dataUrl) continue;
        const m = /^data:([^;]+);base64,(.+)$/.exec(d.dataUrl);
        if (!m) continue;
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: m[1] || 'application/pdf', data: m[2] },
          title: d.name || undefined,
        });
      }
    }
    for (const im of safeImages) {
      const parsed = parseDataUrl(im.dataUrl);
      if (!parsed) continue;
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data },
      });
    }
    content.push({ type: 'text', text: composedText });
    return { role: 'user', content };
  }

  // OpenAI-shape: no document support; PDF text already prepended above.
  const content = [{ type: 'text', text: composedText }];
  for (const im of safeImages) {
    if (!im.dataUrl) continue;
    content.push({ type: 'image_url', image_url: { url: im.dataUrl } });
  }
  return { role: 'user', content };
}

export async function runAgent({ provider, apiKey, userPrompt, userImages = [], userDocs = [], priorMessages = [], system, tools, executor, maxTurns = 6, abortSignal, onEvent }) {
  console.log('[build-style] runAgent start:', provider?.name || provider?.id, '| shape:', provider?.shape, '| maxTurns:', maxTurns);
  // Lightweight tap: log only the first few stream events so we can see the
  // build loop actually started, without flooding the console.
  if (onEvent) {
    const _origOnEvent = onEvent;
    let _tapped = 0;
    onEvent = (e) => {
      if (_tapped < 4 && (e.kind === 'text' || e.kind === 'tool_call')) {
        _tapped++;
        if (e.kind === 'text') console.log('[build-style] runAgent event[text]:', (e.text || '').slice(0, 60));
        else console.log('[build-style] runAgent event[tool_call]:', e.name || e.toolName || '');
      }
      return _origOnEvent(e);
    };
  }
  const userBlocks = userPrompt;
  const isAnthropic = provider.shape === 'anthropic';
  // Continuity: prepend any prior turns the caller persisted, then append
  // the new user message in the provider-specific shape. If the caller
  // passed image attachments AND the provider supports vision, reshape
  // the user message into the multipart format both shapes accept; if the
  // provider can't handle vision, silently drop the images and run text-only
  // so the prompt still goes through.
  const messages = repairOrphanedToolCalls([...priorMessages], isAnthropic);
  const safeImages = Array.isArray(userImages) ? userImages.filter((im) => im && im.dataUrl) : [];
  const visionImages = provider.vision ? safeImages : [];
  // PDF docs: native Anthropic gets raw bytes via document blocks (Claude
  // sees images, layout, tables that text extraction loses). Proxied
  // Anthropic (LingModel → DeepSeek) and OpenAI-shape providers don't honor
  // document blocks, so they get the extracted text prepended to the prompt
  // — buildUserMessage routes by `proxied`.
  const safeDocs = Array.isArray(userDocs) ? userDocs.filter((d) => d && d.text) : [];
  messages.push(buildUserMessage({ shape: provider.shape, proxied: !!provider.proxied, text: userBlocks, images: visionImages, docs: safeDocs }));

  let totalIn = 0;
  let totalOut = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    let assistantText = '';
    let toolCalls = [];
    let thinkingBlocks = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = null;

    for await (const piece of runOnce({ provider, apiKey, messages, system, tools, abortSignal })) {
      if (piece.kind === 'text') {
        assistantText += piece.text;
        if (onEvent) onEvent({ kind: 'text', text: piece.text });
      } else if (piece.kind === 'tool_call') {
        if (onEvent) onEvent({ kind: 'tool_call', name: piece.name, args: piece.args });
      } else if (piece.kind === 'done') {
        toolCalls = piece.toolCalls;
        thinkingBlocks = piece.thinkingBlocks || [];
        inputTokens = piece.inputTokens;
        outputTokens = piece.outputTokens;
        stopReason = piece.stopReason || null;
      }
    }
    totalIn += inputTokens;
    totalOut += outputTokens;
    if (onEvent) onEvent({ kind: 'usage', inputTokens, outputTokens });

    if (!toolCalls.length || !executor) {
      // Final answer — push the assistant turn into messages so the caller
      // can persist it for follow-up turns.
      if (assistantText) {
        messages.push(isAnthropic
          ? { role: 'assistant', content: [{ type: 'text', text: assistantText }] }
          : { role: 'assistant', content: assistantText });
      }
      if (onEvent) onEvent({ kind: 'history', messages });
      // stopReason="max_tokens" lets the UI show a "truncated by output cap"
      // banner instead of letting the user think the model just stopped early.
      if (onEvent) onEvent({ kind: 'final', text: assistantText, stopReason });
      return;
    }

    // Append the assistant message + tool results in the right shape.
    if (isAnthropic) {
      const blocks = [];
      // Thinking blocks must come FIRST in the content array per Anthropic
      // spec — DeepSeek V4's anthropic-compat endpoint enforces this and
      // 400s with "content[].thinking must be passed back" if we omit them.
      for (const tb of thinkingBlocks) blocks.push(tb);
      if (assistantText) blocks.push({ type: 'text', text: assistantText });
      for (const tc of toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      messages.push({ role: 'assistant', content: blocks });

      const resultBlocks = [];
      for (const tc of toolCalls) {
        let result;
        try { result = await executor(tc); } catch (e) { result = { error: String(e?.message || e) }; }
        const resultText = typeof result === 'string' ? result : JSON.stringify(result);
        if (onEvent) onEvent({ kind: 'tool_result', name: tc.name, result: resultText });
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: resultText,
        });
      }
      messages.push({ role: 'user', content: resultBlocks });
    } else {
      messages.push({
        role: 'assistant',
        content: assistantText,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });
      for (const tc of toolCalls) {
        let result;
        try { result = await executor(tc); } catch (e) { result = { error: String(e?.message || e) }; }
        const resultText = typeof result === 'string' ? result : JSON.stringify(result);
        if (onEvent) onEvent({ kind: 'tool_result', name: tc.name, result: resultText });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultText,
        });
      }
    }
  }
  if (onEvent) onEvent({ kind: 'history', messages });
  if (onEvent) onEvent({ kind: 'final', text: '[stopped: max turns reached]' });
}
