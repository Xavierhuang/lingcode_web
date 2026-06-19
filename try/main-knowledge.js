// main-knowledge.js — pinned project knowledge for /try.
// User pins .md / .txt files (or pasted text) that get prepended to the
// system prompt every turn. Lovable-equivalent of "Knowledge".
//
// Storage: localStorage (single-user default) OR Y.Map (collab mode).
// Call enableCollabKnowledge(yDoc) after joining a collab room to switch
// to the shared backend. Call disableCollabKnowledge() to revert.

const STORAGE_KEY = 'lingcode.try.knowledge';
const MAX_ITEM_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024;

// ── Collab state ──────────────────────────────────────────────────────────────

let _collabMap = null; // Y.Map<string, { name, content, addedAt, userId }>
let _collabObserver = null;

/** Switch to Y.Map-backed storage for all knowledge operations. */
export function enableCollabKnowledge(yDoc) {
  if (!yDoc) return;
  _collabMap = yDoc.getMap('knowledge-meta');
  _collabObserver = () => syncKnowledgeBtn();
  _collabMap.observe(_collabObserver);
  syncKnowledgeBtn();
}

/** Revert to localStorage-only mode. */
export function disableCollabKnowledge() {
  if (_collabMap && _collabObserver) _collabMap.unobserve(_collabObserver);
  _collabMap = null;
  _collabObserver = null;
}

// ── Storage helpers ───────────────────────────────────────────────────────────

function readStored() {
  if (_collabMap) {
    // Read from Y.Map; each value is { name, content, addedAt, userId }
    const items = [];
    _collabMap.forEach((v) => {
      if (v && typeof v.name === 'string' && typeof v.content === 'string') items.push(v);
    });
    return items.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(it => it && typeof it.name === 'string' && typeof it.content === 'string') : [];
  } catch {
    return [];
  }
}

function writeStored(items) {
  if (_collabMap) {
    // Sync Y.Map keys: replace all entries
    const existingKeys = new Set(_collabMap.keys());
    const newKeys = new Set(items.map(it => sanitizeKey(it.name)));
    // Delete removed keys
    for (const k of existingKeys) if (!newKeys.has(k)) _collabMap.delete(k);
    // Set new/updated keys
    for (const it of items) _collabMap.set(sanitizeKey(it.name), it);
    return;
  }
  if (items.length === 0) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function sanitizeKey(name) {
  return String(name).toLowerCase().replace(/\s+/g, '-').slice(0, 80) || 'note';
}

// ── Public API (unchanged signatures) ─────────────────────────────────────────

export function getKnowledge() {
  return readStored();
}

export function addKnowledge(name, content) {
  const trimmed = String(content || '').slice(0, MAX_ITEM_BYTES);
  const cleanName = String(name || 'note').trim().slice(0, 80) || 'note';
  if (!trimmed.trim()) return { ok: false, reason: 'empty' };
  const items = readStored();
  const totalAfter = items.reduce((n, it) => n + it.content.length, 0) + trimmed.length;
  if (totalAfter > MAX_TOTAL_BYTES) return { ok: false, reason: 'over-budget' };
  if (_collabMap) {
    _collabMap.set(sanitizeKey(cleanName), { name: cleanName, content: trimmed, addedAt: Date.now() });
  } else {
    items.push({ name: cleanName, content: trimmed, addedAt: Date.now() });
    writeStored(items);
  }
  syncKnowledgeBtn();
  return { ok: true };
}

export function removeKnowledgeAt(index) {
  const items = readStored();
  if (index < 0 || index >= items.length) return;
  if (_collabMap) {
    _collabMap.delete(sanitizeKey(items[index].name));
  } else {
    items.splice(index, 1);
    writeStored(items);
  }
  syncKnowledgeBtn();
}

export function clearKnowledge() {
  if (_collabMap) {
    for (const k of [..._collabMap.keys()]) _collabMap.delete(k);
  } else {
    writeStored([]);
  }
  syncKnowledgeBtn();
}

export function knowledgeSystemAddendum() {
  const items = readStored();
  if (items.length === 0) return '';
  const blocks = items.map(it => `### ${it.name}\n${it.content.trim()}`).join('\n\n');
  return `\n\n## Project knowledge\n\nThe following project context applies to every turn. Use it to inform brand voice, design decisions, and technical constraints. Treat it as authoritative when it contradicts your defaults.\n\n${blocks}`;
}

export function syncKnowledgeBtn() {
  const btn = document.getElementById('knowledge-btn');
  if (!btn) return;
  const items = readStored();
  if (items.length > 0) {
    btn.textContent = `📚 Knowledge (${items.length})`;
    btn.classList.add('active');
    btn.title = `${items.length} file${items.length === 1 ? '' : 's'} pinned to system prompt — click to manage`;
  } else {
    btn.textContent = '📚 Knowledge';
    btn.classList.remove('active');
    btn.title = 'Pin .md / .txt files or notes that apply to every turn (brand guidelines, API docs, design system)';
  }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export function openKnowledgeDialog() {
  let pop = document.querySelector('.knowledge-popover');
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'ckpt-name-popover knowledge-popover';
    pop.style.width = '380px';
    pop.style.maxHeight = '70vh';
    pop.style.overflowY = 'auto';

    const intro = document.createElement('div');
    intro.style.cssText = 'font-size:0.78rem;color:var(--text-muted);line-height:1.4;';
    intro.textContent = 'Pinned knowledge is sent with every turn. Use it for brand voice, design system rules, API docs, or anything the AI should never forget.';

    const list = document.createElement('div');
    list.className = 'knowledge-list';
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Title (e.g. Brand voice)';

    const contentInput = document.createElement('textarea');
    contentInput.placeholder = 'Paste content here, or upload a .md / .txt file below…';
    contentInput.style.cssText = 'min-height:90px;resize:vertical;font-family:inherit;font-size:0.82rem;line-height:1.4;';

    const errLine = document.createElement('div');
    errLine.style.cssText = 'font-size:0.75rem;color:#d6604f;display:none;';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.md,.txt,.mdx,.markdown,text/plain,text/markdown';
    fileInput.multiple = true;
    fileInput.style.display = 'none';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;';

    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.style.cssText = 'padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--text-muted);font-size:0.8rem;cursor:pointer;font-family:inherit;';
    uploadBtn.textContent = '↑ Upload .md/.txt';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'ckpt-save-btn';
    addBtn.style.flex = '1';
    addBtn.textContent = 'Pin';

    row.append(uploadBtn, addBtn);
    pop.append(intro, list, nameInput, contentInput, errLine, fileInput, row);
    document.body.appendChild(pop);

    function refreshList() {
      list.textContent = '';
      const items = readStored();
      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:0.78rem;color:var(--text-muted);font-style:italic;padding:4px 0;';
        empty.textContent = 'Nothing pinned yet.';
        list.appendChild(empty);
        return;
      }
      items.forEach((it, i) => {
        const chip = document.createElement('div');
        chip.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:rgba(28,28,28,0.04);font-size:0.8rem;';

        const left = document.createElement('div');
        left.style.cssText = 'flex:1;min-width:0;';
        const nameSpan = document.createElement('div');
        nameSpan.style.cssText = 'font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        nameSpan.textContent = it.name;
        const metaSpan = document.createElement('div');
        metaSpan.style.cssText = 'font-size:0.72rem;color:var(--text-muted);';
        metaSpan.textContent = `${(it.content.length / 1024).toFixed(1)} KB`;
        left.append(nameSpan, metaSpan);

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.style.cssText = 'background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:1rem;padding:2px 6px;';
        removeBtn.textContent = '✕';
        removeBtn.title = 'Remove';
        removeBtn.addEventListener('click', () => {
          removeKnowledgeAt(i);
          refreshList();
        });

        chip.append(left, removeBtn);
        list.appendChild(chip);
      });
    }

    function showErr(msg) {
      errLine.textContent = msg;
      errLine.style.display = msg ? 'block' : 'none';
    }

    addBtn.addEventListener('click', () => {
      const result = addKnowledge(nameInput.value, contentInput.value);
      if (!result.ok) {
        showErr(result.reason === 'empty' ? 'Content is empty.' : 'Total knowledge would exceed 96KB. Remove items first.');
        return;
      }
      showErr('');
      nameInput.value = '';
      contentInput.value = '';
      refreshList();
    });

    uploadBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      for (const f of files) {
        try {
          const text = await readFileAsText(f);
          const result = addKnowledge(f.name.replace(/\.(md|mdx|txt|markdown)$/i, ''), text);
          if (!result.ok) {
            showErr(result.reason === 'empty' ? `${f.name} is empty.` : `Skipped ${f.name} — over 96KB total budget.`);
          }
        } catch {
          showErr(`Could not read ${f.name}.`);
        }
      }
      refreshList();
    });

    document.addEventListener('click', (e) => {
      if (!pop.contains(e.target) && !document.getElementById('knowledge-btn')?.contains(e.target)) {
        pop.style.display = 'none';
      }
    });

    pop._refresh = refreshList;
  }

  pop._refresh?.();

  const btn = document.getElementById('knowledge-btn');
  if (btn) {
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.max(8, r.left) + 'px';
    pop.style.top = (r.bottom + 8) + 'px';
  }
  pop.style.display = 'flex';
  pop.style.flexDirection = 'column';
  pop.style.gap = '8px';
}
