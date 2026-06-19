// main-db-sidecar.js — post-run sidecar that asks a cheap provider to
// generate a Supabase-compatible PostgreSQL schema for the just-built app.
//
// Runs concurrently with the judge after the main race finishes. Picks
// LingModel Standard if available (free), else the first selected provider
// with credentials. Output renders into a card injected after #panes.
//
// Public API:
//   runDbSidecar(originalPrompt, generatedCode)
//     Awaitable. Caller (run orchestration) fires-and-forgets via .catch().
//   mountDbSidecar({ panesEl })
//     Stores the DOM ref the schema card injects after.
//
// Phase-1 tool-format note: when /try Phase 1 picks XML-in-text vs
// Anthropic tools, the DB_ARCHITECT_SYSTEM_PROMPT below may need a refresh
// — it currently relies on the model emitting a single ```sql fenced
// block, which works under either format but should be re-verified after
// the choice lands.

import { PROVIDERS, runAgent } from './agent.js?v=20260602d';
import { selected, keyInputs } from './main-providers.js?v=20260602d';
import { providerHasCredentials } from './main-send.js?v=20260602d';
import { getSupabaseConfig } from './main-supabase.js?v=20260602d';

let _panesEl = null;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function ensureDbSchemaCard() {
  let card = document.getElementById('try-db-schema');
  if (card) {
    card.remove();
  }
  card = document.createElement('div');
  card.id = 'try-db-schema';
  card.className = 'try-db-schema-card';
  if (_panesEl?.parentNode) {
    _panesEl.parentNode.insertBefore(card, _panesEl.nextSibling);
  }
  return card;
}

function setDbSchemaPlaceholder(card, msg) {
  card.innerHTML = `
    <div class="db-schema-head">
      <span class="db-schema-icon">🗄️</span>
      <span class="db-schema-title">Database Schema (Supabase)</span>
      <span class="db-schema-status">${escapeHtml(msg)}</span>
    </div>`;
}

function renderDbSchemaCard(card, sqlContent) {
  const escapedSql = escapeHtml(sqlContent);
  const { url: sbUrl } = getSupabaseConfig();
  const sbRef = sbUrl?.match(/https?:\/\/([^.]+)\.supabase\.co/)?.[1];
  const sqlEditorBtn = sbRef
    ? `<a class="db-schema-btn" href="https://supabase.com/dashboard/project/${sbRef}/sql/new" target="_blank" rel="noopener">↗ SQL Editor</a>`
    : '';
  card.innerHTML = `
    <div class="db-schema-head">
      <span class="db-schema-icon">🗄️</span>
      <span class="db-schema-title">Database Schema (Supabase)</span>
      <div class="db-schema-actions">
        <button class="db-schema-copy" title="Copy SQL to clipboard">📋 Copy</button>
        <button class="db-schema-download" title="Download as .sql file">⬇️ Download</button>
        ${sqlEditorBtn}
      </div>
    </div>
    <pre class="db-schema-pre"><code>${escapedSql}</code></pre>`;

  const copyBtn = card.querySelector('.db-schema-copy');
  const downloadBtn = card.querySelector('.db-schema-download');

  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(sqlContent);
        const originalText = copyBtn.textContent;
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => { copyBtn.textContent = originalText; }, 2000);
      } catch (e) {
        console.error('Copy failed:', e);
      }
    });
  }

  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      const blob = new Blob([sqlContent], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'schema.sql';
      a.click();
      URL.revokeObjectURL(url);
    });
  }
}

const DB_ARCHITECT_SYSTEM_PROMPT = `You are a database architect. Given a user's web app request and the code that was generated, output a Supabase-compatible PostgreSQL schema.

Output ONLY a single \`\`\`sql code block. No prose, no markdown fence markers in the output other than the opening \`\`\`sql and closing \`\`\`.

Requirements:
- Use UUID primary keys with DEFAULT gen_random_uuid()
- Add created_at TIMESTAMPTZ DEFAULT now() to each table
- Enable RLS (Row-Level Security) on each table
- Add RLS policies for authenticated users (SELECT, INSERT, UPDATE, DELETE as appropriate)
- Include 5-10 rows of representative INSERT sample data
- Add appropriate indexes (GIN for text search, BTREE for foreign keys and common filter columns)
- Use snake_case for all identifiers (tables, columns, indexes)
- Include comments explaining the schema structure

Output the complete schema that could be pasted directly into the Supabase SQL editor.`;

export async function runDbSidecar(originalPrompt, generatedCode) {
  let selectedProvider = null;
  let selectedKey = '';

  // Prefer LingModel Standard (free, no key needed)
  const lingmodel = PROVIDERS.find((p) => p.id === 'lingmodel');
  if (lingmodel && providerHasCredentials('lingmodel')) {
    selectedProvider = lingmodel;
    selectedKey = '';
  } else {
    // Fall back to first selected provider with credentials
    for (const id of selected) {
      const provider = PROVIDERS.find((p) => p.id === id);
      if (provider && providerHasCredentials(id)) {
        selectedProvider = provider;
        selectedKey = (keyInputs.get(id)?.value || '').trim();
        break;
      }
    }
  }

  if (!selectedProvider) return;

  const card = ensureDbSchemaCard();
  setDbSchemaPlaceholder(card, 'Generating schema…');

  try {
    const userPrompt = `User request: ${originalPrompt}\n\nGenerated code:\n\`\`\`html\n${generatedCode}\n\`\`\`\n\nCreate a Supabase PostgreSQL schema for this application.`;

    let sqlContent = '';
    for await (const event of runAgent({
      provider: selectedProvider,
      apiKey: selectedKey,
      userPrompt,
      system: DB_ARCHITECT_SYSTEM_PROMPT,
      tools: [],
      abortSignal: null,
      onEvent: (e) => {
        if (e.kind === 'text') {
          sqlContent += e.text;
        }
      },
    })) {
      // Stream events handled in onEvent above
    }

    // Extract SQL from markdown fence if present
    let extracted = sqlContent;
    const sqlMatch = sqlContent.match(/```(?:sql)?\n([\s\S]*?)\n```/);
    if (sqlMatch) {
      extracted = sqlMatch[1].trim();
    }

    renderDbSchemaCard(card, extracted || sqlContent);
  } catch (error) {
    console.error('DB schema generation failed:', error);
    setDbSchemaPlaceholder(card, `Error: ${error.message}`);
  }
}

export function mountDbSidecar({ panesEl }) {
  _panesEl = panesEl;
}
