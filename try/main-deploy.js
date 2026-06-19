// main-deploy.js — one-click deploy for /try prototypes.
//
// Public API:
//   deployToVercel(files, name?)  → Promise<deployUrl>   (multi-file; server-side token)
//   deployToNetlify(htmlContent)  → Promise<deployUrl>   (single-file fallback; no auth)
//
// deployToVercel POSTs to /api/try/deploy which proxies to the Vercel API.
// Returns a *.vercel.app URL. Throws { code: 'vercel_not_configured' } if
// the server has no VERCEL_API_TOKEN set — caller should fall back to Netlify.
//
// deployToNetlify wraps HTML in a zip and POSTs to the public Netlify Drop
// endpoint. No auth required. Kept as a fallback for single-file deploys.

// files: Map<path,content> or plain object {path: content}
export async function deployToVercel(files, name = 'proto', token) {
  const filesObj = files instanceof Map ? Object.fromEntries(files) : files;
  const res = await fetch('/api/try/deploy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ files: filesObj, name, token }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (data.error === 'vercel_token_required') {
      const err = new Error('vercel_token_required');
      err.code = 'vercel_token_required';
      throw err;
    }
    throw new Error(data.error || `Deploy failed (${res.status})`);
  }
  const data = await res.json();
  if (!data.url) throw new Error('Deploy returned no URL');
  return data.url;
}

export async function deployToNetlify(htmlContent) {
  const JSZip = window.JSZip || (await import('https://cdn.jsdelivr.net/npm/jszip@3/dist/jszip.min.js')).default;

  const zip = new JSZip();
  zip.file('index.html', htmlContent);
  const blob = await zip.generateAsync({ type: 'blob' });

  const res = await fetch('https://api.netlify.com/api/v1/sites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: blob,
  });

  if (!res.ok) {
    throw new Error(`Netlify Deploy failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  if (!data.url) {
    throw new Error('Netlify response missing URL');
  }

  return data.url;
}

// ── LingCode Cloud (native static hosting) ───────────────────────────────
// Builds a gzip'd tar of the files IN THE BROWSER (the same bundle shape the
// Mac IDE uploads) and POSTs it to /api/account/cloud-apps. Real hosting at
// /apps/<id>/ (not the iframe prototype view). Returns { id, url }.
// Throws { code: 'not_signed_in' } on 401 so the caller can fall back.

function writeOctal(buf, off, len, val) {
  const s = (val >>> 0).toString(8).padStart(len - 1, '0').slice(-(len - 1));
  for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
  buf[off + len - 1] = 0;
}

function buildTar(filesObj) {
  const enc = new TextEncoder();
  const blocks = [];
  for (const [rawPath, data] of Object.entries(filesObj)) {
    const path = String(rawPath).replace(/^\.?\//, '');
    const content = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data);
    const header = new Uint8Array(512);
    header.set(enc.encode(path).subarray(0, 100), 0);  // name
    writeOctal(header, 100, 8, 0o644);                 // mode
    writeOctal(header, 108, 8, 0);                      // uid
    writeOctal(header, 116, 8, 0);                      // gid
    writeOctal(header, 124, 12, content.length);        // size
    writeOctal(header, 136, 12, 0);                     // mtime
    header[156] = 0x30;                                 // typeflag '0' (regular file)
    header[257]=0x75; header[258]=0x73; header[259]=0x74; header[260]=0x61; header[261]=0x72; header[262]=0x00; // "ustar"
    header[263] = 0x30; header[264] = 0x30;             // version "00"
    for (let i = 148; i < 156; i++) header[i] = 0x20;   // checksum field = spaces while summing
    let sum = 0; for (let i = 0; i < 512; i++) sum += header[i];
    const cs = (sum & 0x3ffff).toString(8).padStart(6, '0');
    for (let i = 0; i < 6; i++) header[148 + i] = cs.charCodeAt(i);
    header[154] = 0; header[155] = 0x20;
    blocks.push(header, content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad) blocks.push(new Uint8Array(pad));
  }
  blocks.push(new Uint8Array(1024));                    // two zero blocks = end of archive
  let total = 0; for (const b of blocks) total += b.length;
  const tar = new Uint8Array(total);
  let off = 0; for (const b of blocks) { tar.set(b, off); off += b.length; }
  return tar;
}

async function gzipBytes(u8) {
  const stream = new Response(u8).body.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Persist the current files as a new project SOURCE snapshot version, so a
// browser edit survives + collaborators get the change. Reuses the same gzip-tar
// the deploy path builds; POSTs to the projects source API. Returns { version }.
export async function saveProjectSnapshot(projectId, files) {
  const filesObj = files instanceof Map ? Object.fromEntries(files) : files;
  const gz = await gzipBytes(buildTar(filesObj));
  const res = await fetch('/api/projects/' + encodeURIComponent(projectId) + '/source', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/gzip' },
    body: gz,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.ok) {
    throw new Error((data && (data.message || data.error)) || `Snapshot save failed (${res.status})`);
  }
  return { version: data.version };
}

export async function deployToLingCodeCloud(files, title, existingId) {
  const filesObj = files instanceof Map ? Object.fromEntries(files) : files;
  if (!filesObj['index.html'] && !filesObj['/index.html']) {
    throw new Error('Your app needs an index.html at its root to deploy.');
  }
  const gz = await gzipBytes(buildTar(filesObj));
  const method = existingId ? 'PUT' : 'POST';
  const url = existingId
    ? '/api/account/cloud-apps/' + encodeURIComponent(existingId)
    : '/api/account/cloud-apps';
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/gzip',
      'X-App-Title': encodeURIComponent(title || 'App'),
      'X-App-Index': 'index.html',
    },
    body: gz,
  });
  if (res.status === 401) { const e = new Error('not_signed_in'); e.code = 'not_signed_in'; throw e; }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.ok) {
    throw new Error((data && (data.message || data.error)) || `Cloud deploy failed (${res.status})`);
  }
  return { id: data.id, url: data.url };
}
