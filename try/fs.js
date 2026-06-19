// fs.js — multi-source workspace backend. Pluggable backends: real folder
// (File System Access API), in-memory virtual FS (file picker / drop /
// paste), and GitHub repo (read from API + writable in-memory overlay).
// All paths are relative to the active backend's root.

let backend = null;
let onChange = null;

const READ_MAX = 256 * 1024;

// File extensions we know aren't readable as text. Reading them and shoving
// the bytes into conversation history blows up the upstream's payload limit
// (DeepSeek 413s) AND wastes the model's context. Better to return a clear
// placeholder telling the user to convert / paste the text content.
const BINARY_EXTS = new Set([
  // Office (ZIP-wrapped XML or proprietary binary). pdf/xlsx/pptx are
  // handled by the rich-text dispatcher in each backend before the binary
  // check runs, so they're intentionally absent here.
  'docx','doc','xls','ppt','odt','ods','odp','rtf','pages','numbers','keynote',
  // Images
  'png','jpg','jpeg','gif','webp','bmp','ico','tiff','tif','heic','heif',
  // A/V
  'mp3','mp4','mov','m4a','m4v','wav','ogg','webm','avi','mkv','flac',
  // Archives
  'zip','tar','gz','tgz','bz2','xz','7z','rar','jar','war',
  // Fonts
  'woff','woff2','ttf','otf','eot',
  // Binaries / installers / dbs
  'exe','dmg','pkg','msi','deb','rpm','app','dll','dylib','so','class','o','a','lib','sqlite','db','mdb',
]);
function looksBinaryByPath(path) {
  const m = String(path || '').match(/\.([a-z0-9]+)$/i);
  return !!m && BINARY_EXTS.has(m[1].toLowerCase());
}
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return Math.round(bytes / 1024 / 1024) + ' MB';
}
function binaryPlaceholder(path, size) {
  const sz = size != null ? ` (${fmtSize(size)})` : '';
  const officeHint = /\.(doc|xls|ppt|odt|ods|odp|rtf)$/i.test(path)
    ? ' Open the file, copy the text, and paste it via the Paste tab so the agent can read it.'
    : '';
  return `[binary file: ${path}${sz} — not readable as text.${officeHint}]`;
}
// Lazy ESM imports — fetched the first time a matching file is touched.
// On rejection we null the cache so a transient CDN failure doesn't
// permanently disable the format for the rest of the session.
let _mammothPromise = null;
function loadMammoth() {
  if (!_mammothPromise) {
    _mammothPromise = import('https://cdn.jsdelivr.net/npm/mammoth@1.8.0/+esm')
      .catch(e => { _mammothPromise = null; throw e; });
  }
  return _mammothPromise;
}
let _pdfPromise = null;
function loadPdfJs() {
  if (!_pdfPromise) {
    _pdfPromise = import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/+esm')
      .then(mod => {
        // pdf.js refuses to parse without a worker URL set first.
        mod.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';
        return mod;
      })
      .catch(e => { _pdfPromise = null; throw e; });
  }
  return _pdfPromise;
}
let _xlsxPromise = null;
function loadSheetJs() {
  if (!_xlsxPromise) {
    _xlsxPromise = import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm')
      .catch(e => { _xlsxPromise = null; throw e; });
  }
  return _xlsxPromise;
}
let _jszipPromise = null;
function loadJSZip() {
  if (!_jszipPromise) {
    _jszipPromise = import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm')
      .catch(e => { _jszipPromise = null; throw e; });
  }
  return _jszipPromise;
}

// Extractors. Return a plain string on success, or null on failure / empty
// content — callers fall back to binaryPlaceholder.

// DOCX has no notion of pages, only content — output is one long string.
async function extractDocxText(blobOrFile) {
  try {
    const mod = await loadMammoth();
    const arrayBuffer = await blobOrFile.arrayBuffer();
    const result = await (mod.default || mod).extractRawText({ arrayBuffer });
    const value = result && result.value;
    if (value && value.trim().length > 0) return value;
  } catch (e) {
    console.warn('docx extraction failed:', e);
  }
  return null;
}

// PDF: per-page text with `--- Page N ---` separators so the model sees
// page boundaries. Image-only / scanned PDFs return null (no text layer)
// rather than emitting header-only output.
async function extractPdfText(blobOrFile) {
  try {
    const mod = await loadPdfJs();
    const data = await blobOrFile.arrayBuffer();
    const doc = await mod.getDocument({ data }).promise;
    const parts = [];
    let bodyChars = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map(it => it.str).join(' ').trim();
      bodyChars += text.length;
      parts.push(`--- Page ${i} ---\n${text}`);
    }
    await doc.destroy();
    if (bodyChars === 0) return null;
    return parts.join('\n\n');
  } catch (e) {
    console.warn('pdf extraction failed:', e);
    return null;
  }
}

// XLSX: each sheet rendered as CSV with `--- Sheet: NAME ---` separators,
// followed by a `--- Sheet: NAME (formulas) ---` block when any cells in
// that sheet have formulas. SheetNames preserves the workbook's tab order.
// Encrypted workbooks prompt the user for a password (once, retried) and
// fall through to placeholder if cancelled or wrong.
async function extractXlsxText(blobOrFile) {
  try {
    const mod = await loadSheetJs();
    const XLSX = mod.default || mod;
    const data = await blobOrFile.arrayBuffer();
    let wb;
    try {
      wb = XLSX.read(data, { type: 'array' });
    } catch (e) {
      // sheetjs throws "File is password-protected" on encrypted workbooks.
      if (/password/i.test(String(e && e.message))) {
        const pw = typeof window !== 'undefined' && window.prompt
          ? window.prompt('This spreadsheet is password-protected. Enter password:')
          : null;
        if (!pw) return null;
        wb = XLSX.read(data, { type: 'array', password: pw });
      } else {
        throw e;
      }
    }
    if (!wb.SheetNames || wb.SheetNames.length === 0) return null;
    const parts = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      const csv = XLSX.utils.sheet_to_csv(sheet).trim();
      parts.push(`--- Sheet: ${name} ---\n${csv || '(empty)'}`);
      const formulas = collectFormulas(sheet);
      if (formulas.length > 0) {
        parts.push(`--- Sheet: ${name} (formulas) ---\n${formulas.join('\n')}`);
      }
    }
    return parts.join('\n\n');
  } catch (e) {
    console.warn('xlsx extraction failed:', e);
    return null;
  }
}

// Walk a sheet's cells, emit `A1: =SUM(B1:B10)` lines for every cell with
// a formula. Skips the values-only common case (returns []) so the output
// stays clean for plain data sheets.
function collectFormulas(sheet) {
  const out = [];
  if (!sheet || !sheet['!ref']) return out;
  for (const addr of Object.keys(sheet)) {
    if (addr.startsWith('!')) continue;
    const cell = sheet[addr];
    if (cell && cell.f) out.push(`${addr}: =${cell.f}`);
  }
  return out;
}

// PPTX: walk slides in numeric filename order and pull <a:t> text nodes
// per slide, with `--- Slide N ---` separators. PowerPoint rewrites slide
// files when the user reorders, so filename order matches presentation
// order in practice — skipping the sldIdLst manifest parse keeps this
// small. Speaker notes intentionally omitted; flip INCLUDE_NOTES below to
// add them as `--- Slide N (notes) ---`.
async function extractPptxText(blobOrFile) {
  const INCLUDE_NOTES = false;
  try {
    const mod = await loadJSZip();
    const JSZip = mod.default || mod;
    const zip = await JSZip.loadAsync(await blobOrFile.arrayBuffer());
    const slideFiles = Object.keys(zip.files)
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/slide(\d+)\.xml$/)[1], 10)
                    - parseInt(b.match(/slide(\d+)\.xml$/)[1], 10));
    const parser = new DOMParser();
    const parts = [];
    let bodyChars = 0;
    for (let i = 0; i < slideFiles.length; i++) {
      const xml = await zip.file(slideFiles[i]).async('string');
      const doc = parser.parseFromString(xml, 'application/xml');
      const text = [...doc.getElementsByTagName('a:t')]
        .map(n => n.textContent).filter(Boolean).join('\n').trim();
      bodyChars += text.length;
      parts.push(`--- Slide ${i + 1} ---\n${text}`);
      if (INCLUDE_NOTES) {
        const notesEntry = zip.file(`ppt/notesSlides/notesSlide${i + 1}.xml`);
        if (notesEntry) {
          const notesXml = await notesEntry.async('string');
          const notesDoc = parser.parseFromString(notesXml, 'application/xml');
          const notesText = [...notesDoc.getElementsByTagName('a:t')]
            .map(n => n.textContent).filter(Boolean).join('\n').trim();
          if (notesText) {
            bodyChars += notesText.length;
            parts.push(`--- Slide ${i + 1} (notes) ---\n${notesText}`);
          }
        }
      }
    }
    if (bodyChars === 0) return null;
    return parts.join('\n\n');
  } catch (e) {
    console.warn('pptx extraction failed:', e);
    return null;
  }
}

function isDocx(path) { return /\.docx$/i.test(path); }
export function isPdf(path)  { return /\.pdf$/i.test(path); }
function isXlsx(path) { return /\.xlsx$/i.test(path); }
function isPptx(path) { return /\.pptx$/i.test(path); }
function hasRichExtractor(path) { return isDocx(path) || isPdf(path) || isXlsx(path) || isPptx(path); }

// Cap on extracted text. PDF/XLSX/PPTX can produce many MB, which blows
// up the upstream payload (DeepSeek 413). DOCX rarely hits this in
// practice so existing behavior is preserved.
const RICH_MAX = 512 * 1024;
function capRich(text) {
  if (text.length <= RICH_MAX) return text;
  return text.slice(0, RICH_MAX) + `\n\n[extraction truncated: ${text.length} chars total, showing first ${RICH_MAX}]`;
}

// Single-call dispatcher used by every backend's readFile. Returns a
// fully formatted "[extracted from ...]" string, or null when extraction
// yielded nothing usable. Callers paired with hasRichExtractor() route a
// null return to binaryPlaceholder.
//
// Exported so the chat-attach UI in main.js can extract text from a PDF
// (or other rich format) the user drops onto the prompt — the text gets
// prepended to the user message so providers without document-block
// support (e.g. DeepSeek's /anthropic compat) still receive the content.
export async function tryExtractRichText(path, blob) {
  let text = null;
  if (isDocx(path)) text = await extractDocxText(blob);
  else if (isPdf(path))  text = await extractPdfText(blob);
  else if (isXlsx(path)) text = await extractXlsxText(blob);
  else if (isPptx(path)) text = await extractPptxText(blob);
  else return null;
  if (text && text.trim()) return `[extracted from ${path}]\n\n${capRich(text)}`;
  return null;
}

// Catches unknown-extension binaries that slip past the path check. Sniffs
// the first 1KB for null bytes / replacement chars / control chars.
function looksBinaryByContent(text) {
  if (!text) return false;
  const sample = text.slice(0, 1024);
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return true;                       // null byte → certainly binary
    if (c === 0xFFFD) bad++;                        // UTF-8 replacement char
    else if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) bad++;
  }
  return bad / sample.length > 0.1;
}

export function fsaSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

// Kept for backward compat: now means "any workspace input mode is usable."
// Always true because the virtual backend works in every browser.
export function isSupported() { return true; }

export function hasWorkspace() { return backend !== null; }
export function currentFolderName() { return backend?.displayName || ''; }
export function backendKind() { return backend?.kind || null; }
export function backendCapabilities() { return backend?.capabilities || { write: false, list: false }; }
export function hasUnsavedWrites() { return !!backend?.hasUnsavedWrites?.(); }
export function clearWorkspace() { backend = null; notifyChange(); }
export function setOnChange(cb) { onChange = cb; }
export function markClean() { backend?.markClean?.(); }
export function getGitHubBackendMeta() {
  if (backend?.kind !== 'github') return null;
  return { owner: backend.owner, repo: backend.repo, ref: backend.ref };
}
export function getDirtyFiles() {
  if (!backend?.files) return [];
  const out = [];
  for (const [path, content] of backend.files) out.push({ path, content });
  return out;
}
function notifyChange() { if (onChange) onChange(); }

// ---- FSA backend (real folder, current behavior) ----

function makeFSABackend(handle) {
  async function resolvePath(path, { wantFile, create = false }) {
    const cleaned = path.replace(/^\.?\/?/, '').replace(/\/$/, '');
    if (cleaned === '' || cleaned === '.') {
      if (wantFile) throw new Error('Expected a file path, got root.');
      return handle;
    }
    const parts = cleaned.split('/');
    const last = parts.pop();
    let dir = handle;
    for (const seg of parts) {
      if (!seg) continue;
      dir = await dir.getDirectoryHandle(seg, { create });
    }
    if (wantFile) return await dir.getFileHandle(last, { create });
    return await dir.getDirectoryHandle(last, { create });
  }
  return {
    kind: 'fsa',
    displayName: handle.name,
    capabilities: { write: true, list: true, downloadZip: false },
    async readFile(path) {
      const fh = await resolvePath(path, { wantFile: true });
      const file = await fh.getFile();
      if (hasRichExtractor(path)) {
        const rich = await tryExtractRichText(path, file);
        return rich != null ? rich : binaryPlaceholder(path, file.size);
      }
      if (looksBinaryByPath(path)) return binaryPlaceholder(path, file.size);
      const slice = file.size > READ_MAX ? file.slice(0, READ_MAX) : file;
      const text = await slice.text();
      if (looksBinaryByContent(text)) return binaryPlaceholder(path, file.size);
      if (file.size > READ_MAX) {
        return text + `\n\n[file truncated: ${file.size} bytes total, showing first ${READ_MAX}]`;
      }
      return text;
    },
    async writeFile(path, content) {
      const fh = await resolvePath(path, { wantFile: true, create: true });
      const w = await fh.createWritable();
      await w.write(content);
      await w.close();
      return `wrote ${content.length} chars to ${path}`;
    },
    async listFiles(path) {
      const dir = await resolvePath(path || '', { wantFile: false });
      const out = [];
      for await (const [name, h] of dir.entries()) {
        out.push(h.kind === 'directory' ? `${name}/` : name);
      }
      out.sort();
      return out.length ? out.join('\n') : '[empty directory]';
    },
  };
}

// ---- Virtual FS backend (in-memory Map<path, content>) ----

function makeVirtualBackend({ files, displayName, kind = 'virtual' }) {
  let dirty = false;
  const norm = (p) => p.replace(/^\.?\/?/, '').replace(/\/$/, '');

  return {
    kind,
    displayName,
    capabilities: { write: true, list: true, downloadZip: true },
    files,
    hasUnsavedWrites() { return dirty; },
    markClean() { dirty = false; },
    markDirty() { dirty = true; },
    async readFile(path) {
      const p = norm(path);
      if (!files.has(p)) throw new Error(`File not found: ${path}`);
      const text = files.get(p);
      // The loader stores a placeholder for known-binary files so this
      // return is already safe; this is the belt-and-suspenders check.
      if (looksBinaryByPath(p) && !text.startsWith('[binary file:')) {
        return binaryPlaceholder(p);
      }
      if (text.length > READ_MAX) {
        return text.slice(0, READ_MAX) + `\n\n[file truncated: ${text.length} chars total, showing first ${READ_MAX}]`;
      }
      return text;
    },
    async writeFile(path, content) {
      const p = norm(path);
      files.set(p, content);
      dirty = true;
      return `wrote ${content.length} chars to ${path} (in memory)`;
    },
    async listFiles(path) {
      return listVirtual(files.keys(), norm(path || ''));
    },
  };
}

// Shared "give me one level" lister used by virtual + github backends.
function listVirtual(pathIter, prefix) {
  const seen = new Set();
  const out = [];
  for (const p of pathIter) {
    if (prefix && !p.startsWith(prefix + '/') && p !== prefix) continue;
    const rel = prefix ? p.slice(prefix.length + 1) : p;
    if (!rel) continue;
    const seg = rel.split('/')[0];
    if (!seg) continue;
    const isDir = rel.includes('/');
    const key = isDir ? seg + '/' : seg;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  out.sort();
  return out.length ? out.join('\n') : '[empty directory]';
}

// ---- GitHub backend (read from API + writable virtual overlay) ----

function makeGitHubBackend({ owner, repo, ref, treePaths }) {
  const overlay = makeVirtualBackend({
    files: new Map(),
    displayName: `${owner}/${repo}@${ref}`,
    kind: 'github-overlay',
  });
  const cache = new Map(); // path -> text

  return {
    kind: 'github',
    owner,
    repo,
    ref,
    displayName: `${owner}/${repo}@${ref}`,
    capabilities: { write: true, list: true, downloadZip: true },
    overlay,
    files: overlay.files, // exposed for downloadAsZip
    hasUnsavedWrites() { return overlay.hasUnsavedWrites(); },
    markClean() { overlay.markClean(); },
    async readFile(path) {
      const p = path.replace(/^\.?\/?/, '');
      if (overlay.files.has(p)) return overlay.readFile(p);
      if (cache.has(p)) return cache.get(p);
      // Rich-text formats (docx/pdf/xlsx/pptx) need the bytes — fetch
      // then extract.
      if (hasRichExtractor(p)) {
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`GitHub fetch failed: ${resp.status} ${resp.statusText} for ${p}`);
        const blob = await resp.blob();
        const rich = await tryExtractRichText(p, blob);
        const out = rich != null ? rich : binaryPlaceholder(p, blob.size);
        cache.set(p, out);
        return out;
      }
      // Skip the fetch entirely for known-binary paths — saves bandwidth
      // and keeps history clean.
      if (looksBinaryByPath(p)) {
        const placeholder = binaryPlaceholder(p);
        cache.set(p, placeholder);
        return placeholder;
      }
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`GitHub fetch failed: ${resp.status} ${resp.statusText} for ${p}`);
      const text = await resp.text();
      if (looksBinaryByContent(text)) {
        const placeholder = binaryPlaceholder(p);
        cache.set(p, placeholder);
        return placeholder;
      }
      const out = text.length > READ_MAX
        ? text.slice(0, READ_MAX) + `\n\n[file truncated: ${text.length} chars total, showing first ${READ_MAX}]`
        : text;
      cache.set(p, out);
      return out;
    },
    async writeFile(path, content) {
      return overlay.writeFile(path, content);
    },
    async listFiles(path) {
      const all = new Set(treePaths);
      for (const p of overlay.files.keys()) all.add(p);
      const prefix = path.replace(/^\.?\/?/, '').replace(/\/$/, '');
      return listVirtual(all, prefix);
    },
  };
}

// ---- Loaders ----

export async function pickFolder() {
  if (!fsaSupported()) {
    throw new Error('Your browser does not support the File System Access API.');
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  backend = makeFSABackend(handle);
  notifyChange();
  return backend.displayName;
}

export async function loadFromInputFiles(fileList) {
  const files = new Map();
  for (const f of fileList) {
    const path = (f.webkitRelativePath && f.webkitRelativePath.length > 0) ? f.webkitRelativePath : f.name;
    files.set(path, await readFileSafely(f, path));
  }
  if (files.size === 0) throw new Error('No files selected.');
  applyVirtualFromMap(files);
  return backend.displayName;
}

export async function loadFromDataTransfer(dataTransfer) {
  // Prefer FSA directory handle when the browser exposes it.
  if (fsaSupported() && dataTransfer.items) {
    for (const it of dataTransfer.items) {
      if (it.kind === 'file' && typeof it.getAsFileSystemHandle === 'function') {
        const h = await it.getAsFileSystemHandle();
        if (h && h.kind === 'directory') {
          backend = makeFSABackend(h);
          notifyChange();
          return backend.displayName;
        }
      }
    }
  }
  // Fall back to webkit entry walk (handles nested folders in Safari/Firefox).
  const files = new Map();
  if (dataTransfer.items) {
    for (const it of dataTransfer.items) {
      const entry = it.webkitGetAsEntry?.();
      if (entry) await walkEntry(entry, '', files);
    }
  }
  if (files.size === 0) {
    for (const f of dataTransfer.files || []) {
      files.set(f.name, await readFileSafely(f, f.name));
    }
  }
  if (files.size === 0) throw new Error('No files in drop.');
  applyVirtualFromMap(files);
  return backend.displayName;
}

export async function loadFromGitHub(input, refOverride = '') {
  const parsed = parseGitHubInput(input);
  if (!parsed) throw new Error('Could not parse — try owner/repo or a github.com URL.');
  const { owner, repo } = parsed;
  const ref = refOverride || parsed.ref || await resolveDefaultBranch(owner, repo);
  const treeResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`);
  if (!treeResp.ok) {
    if (treeResp.status === 403) {
      const body = await treeResp.json().catch(() => ({}));
      throw new Error(body.message || 'GitHub rate limit exceeded.');
    }
    if (treeResp.status === 404) throw new Error(`Not found: ${owner}/${repo}@${ref}`);
    throw new Error(`GitHub tree fetch failed: ${treeResp.status} ${treeResp.statusText}`);
  }
  const treeJson = await treeResp.json();
  const treePaths = (treeJson.tree || []).filter(e => e.type === 'blob').map(e => e.path);
  backend = makeGitHubBackend({ owner, repo, ref, treePaths });
  notifyChange();
  return { displayName: backend.displayName, fileCount: treePaths.length, truncated: !!treeJson.truncated };
}

export async function loadFromPaste(text) {
  const files = parsePastedFiles(text);
  if (files.size === 0) {
    throw new Error('Nothing parsed. Use a line "--- path/to/file.ext" before each file\'s content.');
  }
  applyVirtualFromMap(files, /* keepRoot */ true);
  return backend.displayName;
}

function applyVirtualFromMap(files, keepRoot = false) {
  let displayName;
  let useFiles = files;
  if (!keepRoot) {
    const root = guessCommonRoot([...files.keys()]);
    if (root) {
      useFiles = new Map([...files].map(([k, v]) => [k.slice(root.length + 1), v]));
      displayName = root;
    } else {
      displayName = `${files.size} file${files.size === 1 ? '' : 's'}`;
    }
  } else {
    displayName = `${files.size} pasted file${files.size === 1 ? '' : 's'}`;
  }
  backend = makeVirtualBackend({ files: useFiles, displayName });
  notifyChange();
}

// ---- Helpers ----

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

// Wrapper used by all virtual-backend loaders. Extracts text from .docx
// via mammoth so multi-page Word docs are readable. Skips text-reading
// for other binary paths (.pdf/.png/etc) and stores a placeholder so
// conversation history doesn't bloat the upstream payload (413).
async function readFileSafely(file, path) {
  if (hasRichExtractor(path)) {
    const rich = await tryExtractRichText(path, file);
    return rich != null ? rich : binaryPlaceholder(path, file.size);
  }
  if (looksBinaryByPath(path)) {
    return binaryPlaceholder(path, file.size);
  }
  const text = await readFileAsText(file);
  if (looksBinaryByContent(text)) {
    return binaryPlaceholder(path, file.size);
  }
  return text;
}

async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const path = prefix + entry.name;
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.set(path, await readFileSafely(file, path));
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    // readEntries returns batches; loop until empty.
    while (true) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walkEntry(e, prefix + entry.name + '/', out);
    }
  }
}

function guessCommonRoot(paths) {
  if (paths.length === 0) return '';
  const first = paths[0];
  const idx = first.indexOf('/');
  if (idx < 0) return '';
  const candidate = first.slice(0, idx);
  if (paths.every(p => p === candidate || p.startsWith(candidate + '/'))) return candidate;
  return '';
}

function parseGitHubInput(input) {
  const trimmed = input.trim();
  // owner/repo, github.com/owner/repo, https://github.com/owner/repo, /tree/ref
  const urlMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)(?:\/tree\/([^/\s?]+))?/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/, ''), ref: urlMatch[3] };
  }
  const slugMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (slugMatch) {
    return { owner: slugMatch[1], repo: slugMatch[2].replace(/\.git$/, ''), ref: '' };
  }
  return null;
}

async function resolveDefaultBranch(owner, repo) {
  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
  if (!resp.ok) {
    if (resp.status === 403) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.message || 'GitHub rate limit exceeded.');
    }
    if (resp.status === 404) throw new Error(`Repo not found: ${owner}/${repo}`);
    throw new Error(`GitHub repo lookup failed: ${resp.status}`);
  }
  const json = await resp.json();
  return json.default_branch || 'main';
}

function parsePastedFiles(text) {
  // Headers: a line that is exactly "--- path" (optionally "a/path" / "b/path"
  // from a unified diff). Everything until the next header or EOF is content.
  const out = new Map();
  const lines = text.split(/\r?\n/);
  let cur = null;
  let buf = [];
  const flush = () => { if (cur) out.set(cur, buf.join('\n').replace(/\n+$/, '')); };
  for (const line of lines) {
    const m = line.match(/^---\s+(.+?)\s*$/);
    if (m) {
      flush();
      cur = m[1].trim().replace(/^[ab]\//, '');
      buf = [];
    } else if (cur !== null) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

// ---- Tool dispatch (unchanged shape) ----

export async function execTool(toolCall) {
  if (!backend) throw new Error('No workspace selected. Pick or drop a folder, paste files, or load a GitHub repo first.');
  const { name, args } = toolCall;
  switch (name) {
    case 'read_file':  return await backend.readFile(args.path);
    case 'write_file': return await backend.writeFile(args.path, args.content || '');
    case 'list_files': return await backend.listFiles(args.path || '');
    default:           throw new Error(`Unknown tool: ${name}`);
  }
}

// ---- Save virtual edits as a zip download ----

export async function downloadAsZip() {
  if (!backend) throw new Error('Nothing to download.');
  const files = backend.files;
  if (!files || files.size === 0) throw new Error('No files to save.');
  await downloadFilesAsZip(files, `lingcode-workspace-${Date.now()}.zip`);
  if (backend.markClean) backend.markClean();
  notifyChange();
}

/// Generic zip-and-trigger-download for any Map<filename, content>. Used
/// by the workspace download flow above and by the multi-file preview
/// modal's "Download as zip" button — same encoder, different inputs.
export async function downloadFilesAsZip(filesMap, fileName) {
  if (!filesMap || filesMap.size === 0) throw new Error('No files to download.');
  const blob = await buildZip(filesMap);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || `lingcode-${Date.now()}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Minimal STORE-method ZIP encoder. ~80 lines, no compression. Adequate for
// "download my edits" — text files, modest sizes.
async function buildZip(files) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;
  for (const [path, content] of files) {
    const nameBytes = enc.encode(path);
    const dataBytes = enc.encode(content);
    const crc = crc32(dataBytes);
    const header = makeLocalHeader(nameBytes, dataBytes, crc);
    local.push(header, dataBytes);
    central.push(makeCentralEntry(nameBytes, dataBytes.length, crc, offset));
    offset += header.length + dataBytes.length;
  }
  const cdStart = offset;
  let cdLen = 0; for (const c of central) cdLen += c.length;
  const end = makeEndRecord(central.length, cdLen, cdStart);
  return new Blob([...local, ...central, end], { type: 'application/zip' });
}

function makeLocalHeader(nameBytes, dataBytes, crc) {
  const buf = new ArrayBuffer(30 + nameBytes.length);
  const v = new DataView(buf);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true); v.setUint16(6, 0, true); v.setUint16(8, 0, true);
  v.setUint16(10, 0, true); v.setUint16(12, 0, true);
  v.setUint32(14, crc, true);
  v.setUint32(18, dataBytes.length, true);
  v.setUint32(22, dataBytes.length, true);
  v.setUint16(26, nameBytes.length, true); v.setUint16(28, 0, true);
  new Uint8Array(buf, 30).set(nameBytes);
  return new Uint8Array(buf);
}

function makeCentralEntry(nameBytes, size, crc, offset) {
  const buf = new ArrayBuffer(46 + nameBytes.length);
  const v = new DataView(buf);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0, true);
  v.setUint16(10, 0, true); v.setUint16(12, 0, true); v.setUint16(14, 0, true);
  v.setUint32(16, crc, true);
  v.setUint32(20, size, true); v.setUint32(24, size, true);
  v.setUint16(28, nameBytes.length, true);
  v.setUint16(30, 0, true); v.setUint16(32, 0, true);
  v.setUint16(34, 0, true); v.setUint16(36, 0, true);
  v.setUint32(38, 0, true);
  v.setUint32(42, offset, true);
  new Uint8Array(buf, 46).set(nameBytes);
  return new Uint8Array(buf);
}

function makeEndRecord(count, cdLen, cdStart) {
  const buf = new ArrayBuffer(22);
  const v = new DataView(buf);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(4, 0, true); v.setUint16(6, 0, true);
  v.setUint16(8, count, true); v.setUint16(10, count, true);
  v.setUint32(12, cdLen, true); v.setUint32(16, cdStart, true);
  v.setUint16(20, 0, true);
  return new Uint8Array(buf);
}

let _crcTable = null;
function crc32(bytes) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = _crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
