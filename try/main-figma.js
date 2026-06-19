// main-figma.js — Figma frame import popover for /try.
//
// Lets the user paste a Figma file/design/proto URL plus a personal access
// token. Fetches the frame, converts the layout to a text outline, and
// prepends it to the prompt textarea so the model recreates the design as
// HTML/CSS.
//
// Public API:
//   openFigmaDialog(anchorEl, promptEl)
//     anchorEl — the button click was raised from; popover anchors above it
//     promptEl — caller's prompt textarea; we mutate .value + dispatch input
//
// Token persists in localStorage under 'lingcode.try.figma.token'.

function getFigmaToken() {
  return localStorage.getItem('lingcode.try.figma.token') || '';
}

function saveFigmaToken(tok) {
  if (tok) localStorage.setItem('lingcode.try.figma.token', tok);
  else localStorage.removeItem('lingcode.try.figma.token');
}

function parseFigmaUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl.trim()); } catch { return null; }
  const m = url.pathname.match(/\/(?:file|design|proto)\/([A-Za-z0-9]+)/);
  if (!m) return null;
  const fileKey = m[1];
  const nodeParam = url.searchParams.get('node-id');
  // Figma URLs encode node IDs with '-' but the API expects ':'
  const nodeId = nodeParam ? nodeParam.replace(/-/g, ':') : null;
  return { fileKey, nodeId };
}

async function fetchFigmaNode(fileKey, nodeId, token) {
  const apiUrl = nodeId
    ? `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`
    : `https://api.figma.com/v1/files/${fileKey}`;
  const r = await fetch(apiUrl, { headers: { 'X-Figma-Token': token } });
  if (r.status === 403) throw Object.assign(new Error('invalid_token'), { code: 'invalid_token' });
  if (!r.ok) throw new Error('figma_http_' + r.status);
  const j = await r.json();
  if (nodeId) {
    const nodes = j.nodes || {};
    const key = Object.keys(nodes)[0];
    return (key && nodes[key]?.document) || null;
  }
  return j.document || null;
}

function figmaNodeToText(node, depth = 0) {
  if (!node || depth > 5) return '';
  const indent = '  '.repeat(depth);
  const bb = node.absoluteBoundingBox;
  const size = bb ? ` (${Math.round(bb.width)}×${Math.round(bb.height)}px)` : '';
  if (node.type === 'TEXT') {
    return `${indent}Text: "${(node.characters || '').replace(/\n/g, ' ')}"`;
  }
  const lines = [`${indent}${node.type} "${node.name}"${size}`];
  if (Array.isArray(node.children)) {
    for (const child of node.children.slice(0, 20)) {
      const sub = figmaNodeToText(child, depth + 1);
      if (sub) lines.push(sub);
    }
  }
  return lines.join('\n');
}

export function openFigmaDialog(anchorEl, promptEl) {
  let pop = document.querySelector('.figma-import-popover');
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'ckpt-name-popover figma-import-popover';

    const tokenLabel = document.createElement('label');
    tokenLabel.style.cssText = 'font-size:0.78rem;color:var(--text-muted);margin-bottom:-4px;';
    tokenLabel.textContent = 'Personal Access Token';

    const tokenInput = document.createElement('input');
    tokenInput.type = 'password';
    tokenInput.placeholder = 'figd_…';
    tokenInput.style.fontFamily = 'monospace';

    const urlLabel = document.createElement('label');
    urlLabel.style.cssText = 'font-size:0.78rem;color:var(--text-muted);margin-bottom:-4px;';
    urlLabel.textContent = 'Figma frame URL';

    const urlInput = document.createElement('input');
    urlInput.type = 'url';
    urlInput.placeholder = 'https://www.figma.com/design/…?node-id=…';

    const statusEl = document.createElement('p');
    statusEl.style.cssText = 'margin:0;font-size:0.75rem;color:var(--text-muted);min-height:1em;';

    const importBtn = document.createElement('button');
    importBtn.className = 'ckpt-save-btn';
    importBtn.textContent = 'Import layout';

    pop.append(tokenLabel, tokenInput, urlLabel, urlInput, statusEl, importBtn);
    document.body.appendChild(pop);

    importBtn.addEventListener('click', async () => {
      const tok = tokenInput.value.trim();
      const urlVal = urlInput.value.trim();
      if (!tok || !urlVal) { statusEl.textContent = 'Token and URL are required.'; return; }
      const parsed = parseFigmaUrl(urlVal);
      if (!parsed) { statusEl.textContent = 'Invalid Figma URL — paste a file, design, or proto link.'; return; }
      saveFigmaToken(tok);
      importBtn.disabled = true;
      statusEl.textContent = 'Fetching from Figma…';
      try {
        const node = await fetchFigmaNode(parsed.fileKey, parsed.nodeId, tok);
        if (!node) throw new Error('no_node');
        const desc = figmaNodeToText(node);
        const current = promptEl.value;
        promptEl.value = `Recreate this Figma design as a web app:\n\n${desc}${current ? '\n\n' + current : ''}`;
        promptEl.dispatchEvent(new Event('input'));
        pop.style.display = 'none';
      } catch (err) {
        if (err.code === 'invalid_token') statusEl.textContent = 'Invalid token — check your Figma PAT.';
        else if (err.message === 'no_node') statusEl.textContent = 'Node not found — try selecting a specific frame in Figma first.';
        else statusEl.textContent = `Error: ${err.message}`;
      } finally {
        importBtn.disabled = false;
      }
    });

    document.addEventListener('click', (e) => {
      if (!pop.contains(e.target) && !e.target.closest('.try-figma-btn')) {
        pop.style.display = 'none';
      }
    });
  }

  pop.querySelector('input[type=password]').value = getFigmaToken();
  pop.querySelector('input[type=url]').value = '';
  pop.querySelector('p').textContent = '';

  const r = anchorEl.getBoundingClientRect();
  pop.style.left = r.left + 'px';
  pop.style.top = 'auto';
  pop.style.bottom = (window.innerHeight - r.top + 8) + 'px';
  pop.style.display = 'flex';
  pop.querySelector('input[type=url]').focus();
}
