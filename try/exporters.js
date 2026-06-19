// exporters.js — PDF and PPTX export for the live preview.
//
// PDF: triggers the browser's print dialog on the preview iframe; the user
// picks "Save as PDF". No external deps. `Window.print` is one of the
// cross-origin-accessible window methods, so this works even though the
// preview iframe is sandboxed without allow-same-origin.
//
// PPTX: lazy-loads html2canvas + pptxgenjs from a CDN on first click,
// renders the prototype HTML into a hidden temp iframe with allow-same-origin
// (necessary so html2canvas can walk the DOM), screenshots each <section>
// into its own slide, and emits a .pptx. The temp iframe is torn down right
// after capture; sensitive localStorage entries are wiped for the duration
// and restored after, so the briefly-trusted iframe can't exfiltrate keys.

const PPTX_DEPS = [
  'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
  'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js',
];

let depsPromise = null;
function loadPptxDeps() {
  if (depsPromise) return depsPromise;
  depsPromise = Promise.all(PPTX_DEPS.map((src) => new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-exporter="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.dataset.exporter = src;
    s.onload = () => resolve();
    s.onerror = () => {
      depsPromise = null;
      reject(new Error(`Failed to load ${src}`));
    };
    document.head.append(s);
  })));
  return depsPromise;
}

export async function exportToPDF(iframeEl) {
  if (!iframeEl?.contentWindow) throw new Error('Preview not ready.');
  iframeEl.contentWindow.focus();
  iframeEl.contentWindow.print();
}

// Wipe ling-* / lingcode-* entries from localStorage for the duration of
// the export, then restore. Protects API keys & GitHub tokens from a
// rogue script in the rendered HTML during the same-origin window.
function shieldLocalStorage() {
  const saved = [];
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (!k) continue;
    saved.push([k, localStorage.getItem(k)]);
    localStorage.removeItem(k);
  }
  return () => { for (const [k, v] of saved) localStorage.setItem(k, v); };
}

function makeExportIframe(html, w, h) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.style.cssText = `position:fixed; left:-99999px; top:0; width:${w}px; height:${h}px; border:0; pointer-events:none;`;
  iframe.srcdoc = html;
  return iframe;
}

function waitForLoad(iframe, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    iframe.addEventListener('load', finish, { once: true });
    setTimeout(finish, timeoutMs);
  });
}

export async function exportToPPTX(html, { fileName = 'prototype.pptx' } = {}) {
  await loadPptxDeps();

  const SLIDE_W = 1280;
  const SLIDE_H = 720;
  const restoreStorage = shieldLocalStorage();
  const iframe = makeExportIframe(html, SLIDE_W, SLIDE_H);
  document.body.append(iframe);

  try {
    await waitForLoad(iframe);
    // Give fonts, images, and any inline scripts a moment to settle.
    await new Promise((r) => setTimeout(r, 800));

    const doc = iframe.contentDocument;
    if (!doc) throw new Error('Could not access export iframe document.');

    const explicit = doc.querySelectorAll('section, .slide, [data-slide]');
    const targets = explicit.length ? Array.from(explicit) : [doc.body];

    const PptxGenJS = window.PptxGenJS;
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: 'LING_16_9', width: 13.333, height: 7.5 });
    pptx.layout = 'LING_16_9';

    for (const target of targets) {
      const canvas = await window.html2canvas(target, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        allowTaint: false,
        logging: false,
        windowWidth: SLIDE_W,
        windowHeight: SLIDE_H,
      });
      const dataUrl = canvas.toDataURL('image/png');
      const slide = pptx.addSlide();
      slide.addImage({ data: dataUrl, x: 0, y: 0, w: 13.333, h: 7.5 });
    }

    await pptx.writeFile({ fileName });
  } finally {
    iframe.remove();
    restoreStorage();
  }
}
