// main-attachments.js — image + PDF attachment state, the per-prompt thumb
// strip, and the prompt-row accessory buttons (attach / figma / mic).
//
// Public API:
//   attachedImages, attachedDocs, attachedAssets — mutable shared refs read
//   by the run loop (snapshotted into per-pane state at send time).
//
//   clearAttachedImages(), clearAttachedDocs() — reset after a run dispatches.
//
//   addFollowupFiles(pane, fileList), renderFollowupThumbs(pane),
//   removeFollowupImageAt(pane, idx) — per-pane follow-up composer use.
//
//   mountAttachments({ promptEl, promptRow, openFigmaDialog, updateSendState })
//     Builds the thumbnail strip, attach/figma/mic buttons, and wires
//     paste/drop handlers on the prompt row. Mounts no-op if promptRow null.

import { t } from './i18n.js?v=20260602d';
import { tryExtractRichText, isPdf } from './fs.js?v=20260602d';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;    // 10MB hard cap per image
const MAX_IMAGES = 8;                          // logo + favicon + a few hero photos
const MAX_DOC_BYTES = 25 * 1024 * 1024;       // 25MB hard cap per PDF (raw bytes; extracted text capped to 512KB inside fs.js)
const MAX_DOCS = 4;                            // matches MAX_IMAGES so the chip strip stays readable

export const attachedImages = [];              // [{ name, dataUrl, mimeType, sizeBytes, assetPath }]
export const attachedDocs = [];                // [{ name, text, dataUrl, sizeBytes }]
export const attachedAssets = new Map();       // path -> { dataUrl, mimeType, sizeBytes }

let _imageThumbsEl = null;
let _imageInputEl = null;
let _updateSendState = () => {};

function sanitizeAssetName(name) {
  const base = String(name || 'image').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
  return base.includes('.') ? base : base + '.png';
}

// Extra "taken" sources (each must support .has(path)) let follow-up runs
// avoid colliding with paths already merged into a pane's prior-turn assets
// AND the live draft map being filled in this turn. The global
// `attachedAssets` clears on Run, so without these a follow-up `logo.png`
// would silently reuse `assets/logo.png` and clobber turn-1's logo.
function uniqueAssetPath(name, ...extraTakens) {
  const isTaken = (p) =>
    attachedAssets.has(p) || extraTakens.some((s) => s && s.has(p));
  const initial = `assets/${sanitizeAssetName(name)}`;
  if (!isTaken(initial)) return initial;
  const dot = initial.lastIndexOf('.');
  const stem = initial.slice(0, dot), ext = initial.slice(dot);
  for (let i = 2; i < 99; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!isTaken(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('read_failed'));
    r.readAsDataURL(file);
  });
}

// Per-file ingest used by both the global prompt strip and the per-pane
// follow-up strip. Mutates the supplied `images` array and `assets` map; the
// caller is responsible for re-rendering its own thumb strip after the loop.
async function addImageToCollections(file, { images, assets, max, extraTaken }) {
  if (!file || !file.type || !file.type.startsWith('image/')) return false;
  if (images.length >= (max ?? MAX_IMAGES)) return false;
  if (file.size > MAX_IMAGE_BYTES) {
    alert(t('attach.too_large', file.name || 'image', Math.round(MAX_IMAGE_BYTES / (1024 * 1024))));
    return false;
  }
  try {
    const dataUrl = await fileToDataUrl(file);
    const assetPath = uniqueAssetPath(file.name || 'image', assets, extraTaken);
    images.push({
      name: file.name || 'image',
      dataUrl,
      mimeType: file.type,
      sizeBytes: file.size,
      assetPath,
    });
    assets.set(assetPath, { dataUrl, mimeType: file.type, sizeBytes: file.size });
    return true;
  } catch {
    return false;
  }
}

async function addImageFiles(fileList) {
  const files = [...(fileList || [])].filter((f) => f && f.type && f.type.startsWith('image/'));
  if (!files.length) return;
  for (const f of files) {
    await addImageToCollections(f, { images: attachedImages, assets: attachedAssets, max: MAX_IMAGES });
  }
  renderImageThumbs();
  _updateSendState();
}

async function addPdfFiles(fileList) {
  const files = [...(fileList || [])].filter((f) => f && (f.type === 'application/pdf' || isPdf(f.name || '')));
  if (!files.length) return;
  for (const f of files) {
    if (attachedDocs.length >= MAX_DOCS) break;
    if (f.size > MAX_DOC_BYTES) {
      alert(t('attach.too_large', f.name || 'pdf', Math.round(MAX_DOC_BYTES / (1024 * 1024))));
      continue;
    }
    try {
      // Extract text once for any provider that can't accept document blocks.
      // Also keep the raw bytes as a data URL so native Claude can receive
      // the PDF unmodified via its document content block.
      const text = await tryExtractRichText(f.name || 'document.pdf', f);
      if (!text) {
        alert(t('attach.pdf_no_text', f.name || 'pdf') || `Couldn't extract text from "${f.name || 'pdf'}" — likely scanned or image-only.`);
        continue;
      }
      const dataUrl = await fileToDataUrl(f);
      attachedDocs.push({
        name: f.name || 'document.pdf',
        text,
        dataUrl,
        sizeBytes: f.size,
      });
    } catch (e) {
      console.warn('pdf attach failed:', e);
    }
  }
  renderImageThumbs();
  _updateSendState();
}

async function addAttachments(fileList) {
  await Promise.all([addImageFiles(fileList), addPdfFiles(fileList)]);
}

function removeDocAt(idx) {
  if (idx < 0 || idx >= attachedDocs.length) return;
  attachedDocs.splice(idx, 1);
  renderImageThumbs();
  _updateSendState();
}

export function clearAttachedDocs() {
  if (!attachedDocs.length) return;
  attachedDocs.length = 0;
  renderImageThumbs();
}

function removeImageAt(idx) {
  if (idx < 0 || idx >= attachedImages.length) return;
  const removed = attachedImages.splice(idx, 1)[0];
  if (removed && removed.assetPath) attachedAssets.delete(removed.assetPath);
  renderImageThumbs();
  _updateSendState();
}

export function clearAttachedImages() {
  if (!attachedImages.length) return;
  attachedImages.length = 0;
  attachedAssets.clear();
  renderImageThumbs();
}

function renderImageThumbs() {
  if (!_imageThumbsEl) return;
  _imageThumbsEl.innerHTML = '';
  if (attachedImages.length === 0 && attachedDocs.length === 0) {
    _imageThumbsEl.style.display = 'none';
    return;
  }
  _imageThumbsEl.style.display = '';
  attachedImages.forEach((im, idx) => {
    const tile = document.createElement('div');
    tile.className = 'try-attach-thumb';
    tile.title = im.assetPath ? `${im.name} → ${im.assetPath}` : im.name;
    const img = document.createElement('img');
    img.src = im.dataUrl;
    img.alt = im.name;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'try-attach-x';
    x.title = t('attach.remove');
    x.setAttribute('aria-label', t('attach.remove'));
    x.textContent = '×';
    x.addEventListener('click', (e) => { e.preventDefault(); removeImageAt(idx); });
    tile.append(img, x);
    if (im.assetPath) {
      const cap = document.createElement('div');
      cap.className = 'try-attach-thumb-cap';
      cap.textContent = im.assetPath;
      cap.title = im.assetPath;
      tile.append(cap);
    }
    _imageThumbsEl.append(tile);
  });
  attachedDocs.forEach((doc, idx) => {
    const tile = document.createElement('div');
    tile.className = 'try-attach-thumb try-attach-thumb-doc';
    tile.title = `${doc.name} · ${(doc.text.length / 1024).toFixed(1)} KB extracted`;
    tile.style.display = 'flex';
    tile.style.alignItems = 'center';
    tile.style.justifyContent = 'center';
    tile.style.padding = '0 10px';
    tile.style.fontSize = '0.78rem';
    tile.style.gap = '6px';
    tile.textContent = `📄 ${doc.name}`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'try-attach-x';
    x.title = t('attach.remove');
    x.setAttribute('aria-label', t('attach.remove'));
    x.textContent = '×';
    x.addEventListener('click', (e) => { e.preventDefault(); removeDocAt(idx); });
    tile.append(x);
    _imageThumbsEl.append(tile);
  });
}

// Per-pane follow-up thumb strip — mirrors renderImageThumbs but reads from
// per-pane state so each pane's Continue input has its own attached images.
export function renderFollowupThumbs(pane) {
  const el = pane._followupThumbsEl;
  if (!el) return;
  el.innerHTML = '';
  if (!pane._followupImages.length) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  pane._followupImages.forEach((im, idx) => {
    const tile = document.createElement('div');
    tile.className = 'try-attach-thumb';
    tile.title = im.assetPath ? `${im.name} → ${im.assetPath}` : im.name;
    const img = document.createElement('img');
    img.src = im.dataUrl;
    img.alt = im.name;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'try-attach-x';
    x.title = t('attach.remove');
    x.setAttribute('aria-label', t('attach.remove'));
    x.textContent = '×';
    x.addEventListener('click', (e) => { e.preventDefault(); removeFollowupImageAt(pane, idx); });
    tile.append(img, x);
    if (im.assetPath) {
      const cap = document.createElement('div');
      cap.className = 'try-attach-thumb-cap';
      cap.textContent = im.assetPath;
      cap.title = im.assetPath;
      tile.append(cap);
    }
    el.append(tile);
  });
}

export function removeFollowupImageAt(pane, idx) {
  if (idx < 0 || idx >= pane._followupImages.length) return;
  const removed = pane._followupImages.splice(idx, 1)[0];
  if (removed && removed.assetPath) pane._followupAssets.delete(removed.assetPath);
  renderFollowupThumbs(pane);
}

export async function addFollowupFiles(pane, fileList) {
  const files = [...(fileList || [])].filter((f) => f && f.type && f.type.startsWith('image/'));
  if (!files.length) return;
  for (const f of files) {
    await addImageToCollections(f, {
      images: pane._followupImages,
      assets: pane._followupAssets,
      max: MAX_IMAGES,
      // Prior-turn paths must also be off-limits — without this a second
      // `logo.png` would clobber turn-1's logo in pane._assets when merged.
      extraTaken: pane._assets,
    });
  }
  renderFollowupThumbs(pane);
}

export function mountAttachments({ promptEl, promptRow, openFigmaDialog, updateSendState }) {
  if (!promptRow) return;
  if (typeof updateSendState === 'function') _updateSendState = updateSendState;

  // Thumbnail strip — sits ABOVE the prompt row in the same parent.
  _imageThumbsEl = document.createElement('div');
  _imageThumbsEl.className = 'try-attach-thumbs';
  _imageThumbsEl.style.display = 'none';
  promptRow.parentNode.insertBefore(_imageThumbsEl, promptRow);

  // Hidden file input + visible 📎 button placed inside the prompt row
  // so it sits next to the textarea without disturbing the layout grid.
  _imageInputEl = document.createElement('input');
  _imageInputEl.type = 'file';
  _imageInputEl.accept = 'image/*,.pdf,application/pdf';
  _imageInputEl.multiple = true;
  _imageInputEl.style.display = 'none';
  _imageInputEl.addEventListener('change', async () => {
    await addAttachments(_imageInputEl.files);
    _imageInputEl.value = '';  // allow picking the same file again
  });
  document.body.append(_imageInputEl);

  const attachBtn = document.createElement('button');
  attachBtn.type = 'button';
  attachBtn.className = 'try-attach-btn';
  attachBtn.title = t('attach.title');
  attachBtn.setAttribute('aria-label', t('attach.title'));
  attachBtn.innerHTML = '+';
  attachBtn.addEventListener('click', () => _imageInputEl.click());

  // Wrap all action buttons in a single container.
  const promptInner = promptRow.querySelector('.try-prompt-inner');
  const promptActions = document.createElement('div');
  promptActions.className = 'try-prompt-actions';
  if (promptInner) promptInner.appendChild(promptActions);
  promptActions.appendChild(attachBtn);

  // Figma import button — same prompt-row actions container.
  const figmaBtn = document.createElement('button');
  figmaBtn.type = 'button';
  figmaBtn.className = 'try-figma-btn';
  figmaBtn.title = 'Import a Figma frame as a layout description';
  figmaBtn.textContent = '✦';
  promptActions.appendChild(figmaBtn);
  figmaBtn.addEventListener('click', () => openFigmaDialog(figmaBtn, promptEl));

  // Mic button — voice input via SpeechRecognition.
  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognitionAPI && promptInner) {
    const micBtn = document.createElement('button');
    micBtn.type = 'button';
    micBtn.className = 'try-mic-btn';
    micBtn.title = 'Voice input';
    micBtn.innerHTML = '🎙';
    promptActions.appendChild(micBtn);

    const langSelect = document.createElement('select');
    langSelect.className = 'try-mic-lang';
    langSelect.title = 'Voice language';
    [
      ['en-US', 'EN'],
      ['zh-CN', '中文'],
      ['es-ES', 'ES'],
      ['fr-FR', 'FR'],
      ['de-DE', 'DE'],
      ['ja-JP', 'JP'],
      ['ko-KR', 'KO'],
      ['pt-BR', 'PT'],
    ].forEach(([val, label]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      langSelect.appendChild(opt);
    });
    langSelect.value = localStorage.getItem('lingcode.try.voiceLang') || 'en-US';
    langSelect.addEventListener('change', () => {
      localStorage.setItem('lingcode.try.voiceLang', langSelect.value);
    });
    promptActions.appendChild(langSelect);

    let recognition = null;
    let micActive = false;

    micBtn.addEventListener('click', () => {
      if (micActive) {
        recognition?.stop();
        return;
      }
      recognition = new SpeechRecognitionAPI();
      recognition.lang = langSelect.value;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      micActive = true;
      micBtn.classList.add('try-mic-listening');

      recognition.onresult = (e) => {
        let interim = '';
        let final = '';
        for (const r of e.results) {
          if (r.isFinal) final += r[0].transcript;
          else interim += r[0].transcript;
        }
        if (final) {
          const cur = promptEl.value;
          promptEl.value = cur ? cur + ' ' + final.trim() : final.trim();
          promptEl.dispatchEvent(new Event('input', { bubbles: true }));
          console.log('[voice] transcript:', final.trim());
        }
        micBtn.title = interim ? interim.slice(0, 60) : 'Voice input';
      };

      recognition.onend = () => {
        micActive = false;
        micBtn.classList.remove('try-mic-listening');
        micBtn.title = 'Voice input';
        recognition = null;
      };

      recognition.onerror = (e) => {
        micActive = false;
        micBtn.classList.remove('try-mic-listening');
        if (e.error === 'not-allowed') {
          micBtn.title = 'Mic permission denied — check browser settings';
          micBtn.classList.add('try-mic-error');
          setTimeout(() => micBtn.classList.remove('try-mic-error'), 3000);
        } else if (e.error === 'no-speech') {
          micBtn.classList.add('try-mic-error');
          setTimeout(() => micBtn.classList.remove('try-mic-error'), 1500);
        }
        recognition = null;
      };

      recognition.start();
    });
  }

  // Paste images from clipboard directly into the prompt.
  promptEl.addEventListener('paste', (e) => {
    if (!e.clipboardData || !e.clipboardData.items) return;
    const files = [];
    for (const item of e.clipboardData.items) {
      if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addImageFiles(files);
    }
  });

  // Drag-and-drop onto the prompt row. Highlight on dragover for affordance.
  ['dragenter', 'dragover'].forEach((ev) => {
    promptRow.addEventListener(ev, (e) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      promptRow.classList.add('try-attach-drag');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    promptRow.addEventListener(ev, () => promptRow.classList.remove('try-attach-drag'));
  });
  promptRow.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    const supported = [...e.dataTransfer.files].filter((f) =>
      f.type.startsWith('image/') || f.type === 'application/pdf' || isPdf(f.name || '')
    );
    if (!supported.length) return;
    e.preventDefault();
    addAttachments(supported);
  });
}
