// Monaco editor + file tree sidebar for multi-file prototypes.
//
// API:
//   attachMonacoToggle(pane, updatePreview) — call once per pane after pane is created
//   refreshMonacoPane(pane)                 — call from updateInlinePreview when in code mode

const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  html: 'html', htm: 'html',
  css: 'css', scss: 'css', less: 'css',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown',
  py: 'python', sh: 'shell', bash: 'shell',
  xml: 'xml', svg: 'xml', yaml: 'yaml', yml: 'yaml',
};

function langFromPath(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return EXT_LANG[ext] || 'plaintext';
}

let _monacoLoadPromise = null;

function loadMonaco() {
  if (window.monaco) return Promise.resolve();
  if (_monacoLoadPromise) return _monacoLoadPromise;
  _monacoLoadPromise = new Promise((resolve) => {
    const cfg = document.createElement('script');
    cfg.textContent = `var require = { paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs' } };`;
    document.head.appendChild(cfg);
    const loader = document.createElement('script');
    loader.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs/loader.js';
    loader.onload = () => {
      // eslint-disable-next-line no-undef
      require(['vs/editor/editor.main'], () => resolve());
    };
    document.head.appendChild(loader);
  });
  return _monacoLoadPromise;
}

export function attachMonacoToggle(pane, updatePreview) {
  if (pane._monacoState) return;

  // "Code" toggle button — inserted as first child of pp-actions
  const codeBtn = document.createElement('button');
  codeBtn.type = 'button';
  codeBtn.className = 'pp-code-btn';
  codeBtn.textContent = '</>';
  codeBtn.title = 'Open code editor';
  codeBtn.disabled = true;
  codeBtn.style.display = 'none';
  const previewActions = pane.previewCol.querySelector('.pp-actions');
  if (previewActions) previewActions.insertBefore(codeBtn, previewActions.firstChild);

  // Monaco panel — flex row: file tree | editor host
  const monacoPanel = document.createElement('div');
  monacoPanel.className = 'pane-monaco-wrap';
  monacoPanel.style.display = 'none';

  // File tree with header (title + new-file button)
  const fileTreeEl = document.createElement('div');
  fileTreeEl.className = 'monaco-file-tree';

  const treeHeader = document.createElement('div');
  treeHeader.className = 'monaco-tree-header';
  treeHeader.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;padding:4px 8px 2px;' +
    'font-size:0.65rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;' +
    'color:var(--text-dim);border-bottom:1px solid var(--border);flex-shrink:0;';

  const treeTitle = document.createElement('span');
  treeTitle.textContent = 'Files';

  const newFileBtn = document.createElement('button');
  newFileBtn.type = 'button';
  newFileBtn.title = 'New file';
  newFileBtn.textContent = '+';
  newFileBtn.style.cssText =
    'background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:1rem;' +
    'line-height:1;padding:0 2px;border-radius:3px;';
  newFileBtn.addEventListener('mouseenter', () => { newFileBtn.style.color = 'var(--signal)'; });
  newFileBtn.addEventListener('mouseleave', () => { newFileBtn.style.color = 'var(--text-muted)'; });

  treeHeader.append(treeTitle, newFileBtn);

  const treeList = document.createElement('div');
  treeList.className = 'monaco-tree-list';
  treeList.style.cssText = 'flex:1;overflow-y:auto;overflow-x:hidden;';

  fileTreeEl.append(treeHeader, treeList);

  const editorHost = document.createElement('div');
  editorHost.className = 'monaco-editor-host';

  monacoPanel.append(fileTreeEl, editorHost);
  pane.previewFileTabs.after(monacoPanel);

  let editorInstance = null;
  let activeFile = null;

  function selectFile(path) {
    if (!pane._files || !editorInstance) return;
    const content = pane._files.get(path) ?? '';
    activeFile = path;
    const lang = langFromPath(path);
    const oldModel = editorInstance.getModel();
    const newModel = window.monaco.editor.createModel(content, lang);
    editorInstance.setModel(newModel);
    if (oldModel) oldModel.dispose();
    treeList.querySelectorAll('.monaco-file-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.path === path);
    });
  }

  function promptNewFile() {
    if (!pane._files) return;
    const name = window.prompt('New file name (e.g. styles.css):');
    if (!name || !name.trim()) return;
    const path = name.trim();
    if (pane._files.has(path)) { selectFile(path); return; }
    pane._files.set(path, '');
    buildFileTree();
    selectFile(path);
  }

  function deleteFile(path) {
    if (!pane._files || pane._files.size <= 1) return;
    if (!window.confirm(`Delete "${path}"?`)) return;
    pane._files.delete(path);
    if (activeFile === path) {
      activeFile = null;
      const first = pane._files.keys().next().value;
      if (first) selectFile(first);
    }
    buildFileTree();
  }

  function startRename(path, nameEl) {
    const input = document.createElement('input');
    input.value = path;
    input.style.cssText =
      'font-size:0.72rem;font-family:inherit;background:var(--bg-card);border:1px solid var(--signal);' +
      'border-radius:3px;padding:1px 4px;width:100%;color:var(--text);outline:none;';

    const finish = () => {
      const newPath = input.value.trim();
      if (newPath && newPath !== path && pane._files) {
        const content = pane._files.get(path) ?? '';
        pane._files.delete(path);
        pane._files.set(newPath, content);
        if (activeFile === path) activeFile = newPath;
      }
      buildFileTree();
      if (activeFile) selectFile(activeFile);
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(); }
      if (e.key === 'Escape') buildFileTree();
    });
    input.addEventListener('blur', finish);

    nameEl.replaceWith(input);
    input.focus();
    input.select();
  }

  function buildFileTree() {
    if (!pane._files) return;
    treeList.innerHTML = '';
    for (const path of pane._files.keys()) {
      const item = document.createElement('div');
      item.className = 'monaco-file-item';
      if (path === activeFile) item.classList.add('active');
      item.dataset.path = path;
      item.style.cssText = 'position:relative;display:flex;align-items:baseline;';

      const slash = path.lastIndexOf('/');
      const nameWrap = document.createElement('span');
      nameWrap.style.cssText = 'display:flex;align-items:baseline;gap:2px;flex:1;min-width:0;overflow:hidden;';

      if (slash >= 0) {
        const dir = document.createElement('span');
        dir.className = 'monaco-file-dir';
        dir.textContent = path.slice(0, slash + 1);
        nameWrap.appendChild(dir);
      }
      const name = document.createElement('span');
      name.className = 'monaco-file-name';
      name.textContent = slash >= 0 ? path.slice(slash + 1) : path;
      nameWrap.appendChild(name);

      // Delete button (appears on hover via CSS)
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = '×';
      delBtn.title = `Delete ${path}`;
      delBtn.className = 'monaco-file-del';
      delBtn.style.cssText =
        'background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:0.9rem;' +
        'padding:0 3px;line-height:1;opacity:0;transition:opacity 0.1s;flex-shrink:0;';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteFile(path); });

      item.append(nameWrap, delBtn);

      item.addEventListener('click', () => selectFile(path));
      item.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRename(path, name);
      });
      item.addEventListener('mouseenter', () => { delBtn.style.opacity = '1'; });
      item.addEventListener('mouseleave', () => { delBtn.style.opacity = '0'; });

      treeList.appendChild(item);
    }
  }

  newFileBtn.addEventListener('click', promptNewFile);

  async function showCodeEditor() {
    await loadMonaco();
    if (!editorInstance) {
      editorInstance = window.monaco.editor.create(editorHost, {
        value: '',
        language: 'html',
        theme: document.documentElement.dataset.theme === 'dark' ? 'vs-dark' : 'vs',
        fontSize: 12.5,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        automaticLayout: true,
        lineNumbers: 'on',
        renderLineHighlight: 'line',
        padding: { top: 8, bottom: 8 },
        fontFamily: "'Geist Mono', 'Fira Code', monospace",
      });

      // Sync theme when dark mode is toggled
      const themeBtn = document.getElementById('try-theme-btn');
      if (themeBtn) {
        themeBtn.addEventListener('click', () => {
          const dark = document.documentElement.dataset.theme === 'dark';
          window.monaco?.editor.setTheme(dark ? 'vs-dark' : 'vs');
        });
      }

      // Two-way sync: Monaco edits → pane._files
      editorInstance.onDidChangeModelContent(() => {
        if (!activeFile || !pane._files || !pane._monacoCodeMode) return;
        pane._files.set(activeFile, editorInstance.getValue());
        clearTimeout(pane._monacoState._previewTimer);
      });
    }

    buildFileTree();
    if (!activeFile || !pane._files?.has(activeFile)) {
      activeFile = pane._activeFile ?? (pane._files ? [...pane._files.keys()][0] : null);
    }
    if (activeFile) selectFile(activeFile);

    pane._monacoCodeMode = true;
    monacoPanel.style.display = '';
    pane.previewFileTabs.style.display = 'none';
    codeBtn.classList.add('active');
    codeBtn.title = 'Back to preview';
  }

  function showPreview() {
    pane._monacoCodeMode = false;
    monacoPanel.style.display = 'none';
    codeBtn.classList.remove('active');
    codeBtn.title = 'Open code editor';
    pane._previewLastSrc = '';
    updatePreview(pane, true);
  }

  codeBtn.addEventListener('click', () => {
    if (pane._monacoCodeMode) showPreview();
    else showCodeEditor();
  });

  pane._monacoCodeMode = false;
  pane._monacoState = {
    codeBtn,
    monacoPanel,
    _previewTimer: null,

    refresh() {
      const hasFiles = pane._files && pane._files.size > 1;
      codeBtn.style.display = hasFiles ? '' : 'none';
      codeBtn.disabled = false;

      if (pane._monacoCodeMode && editorInstance) {
        buildFileTree();
        if (!pane._files?.has(activeFile)) {
          activeFile = pane._activeFile ?? (pane._files ? [...pane._files.keys()][0] : null);
        }
        if (activeFile) {
          const current = editorInstance.getValue();
          const incoming = pane._files?.get(activeFile) ?? '';
          if (current !== incoming) selectFile(activeFile);
        }
      }
    },
  };
}

export function refreshMonacoPane(pane) {
  pane._monacoState?.refresh();
}
