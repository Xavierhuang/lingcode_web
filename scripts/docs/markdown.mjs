export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return slug || 'section';
}

function renderInline(value) {
  const tokens = [];
  let text = String(value).replace(/`([^`]+)`/g, (_match, code) => {
    const token = `\u0000CODE${tokens.length}\u0000`;
    tokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });
  text = escapeHtml(text);
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
    const safeHref = escapeHtml(href);
    const external = /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${safeHref}"${external}>${label}</a>`;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return text.replace(/\u0000CODE(\d+)\u0000/g, (_match, index) => tokens[Number(index)]);
}

function isTableDivider(line) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

export function renderMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  const headings = [];
  const ids = new Set();
  let paragraph = [];
  let list = null;
  let fence = null;
  let admonition = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!list) return;
    html.push(`</${list}>`);
    list = null;
  };
  const closeAdmonition = () => {
    if (!admonition) return;
    flushParagraph();
    closeList();
    html.push('</div>');
    admonition = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (/^```\s*$/.test(line)) {
        html.push(`<pre><code${fence.language ? ` class="language-${escapeHtml(fence.language)}"` : ''}>${escapeHtml(fence.lines.join('\n'))}</code></pre>`);
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    const fenceStart = line.match(/^```([a-zA-Z0-9_-]*)\s*$/);
    if (fenceStart) {
      flushParagraph(); closeList();
      fence = { language: fenceStart[1], lines: [] };
      continue;
    }
    const directive = line.match(/^:::(note|warning|tip|preview)\s*(.*)$/);
    if (directive) {
      flushParagraph(); closeList(); closeAdmonition();
      admonition = directive[1];
      const title = directive[2] || directive[1][0].toUpperCase() + directive[1].slice(1);
      html.push(`<div class="cloud-docs-callout cloud-docs-callout-${admonition}"><strong>${escapeHtml(title)}</strong>`);
      continue;
    }
    if (line.trim() === ':::' && admonition) {
      closeAdmonition();
      continue;
    }
    if (!line.trim()) {
      flushParagraph(); closeList();
      continue;
    }
    if (/^\s*</.test(line)) throw new Error('raw HTML is not allowed in documentation Markdown');
    const heading = line.match(/^(#{1,6})\s+(.+?)(?:\s+\{#([a-z0-9][a-z0-9-]*)\})?\s*$/i);
    if (heading) {
      flushParagraph(); closeList();
      const level = heading[1].length;
      const label = heading[2];
      const id = heading[3] || slugify(label);
      if (ids.has(id)) throw new Error(`duplicate heading id '${id}'`);
      ids.add(id);
      headings.push({ level, id, text: label.replace(/[*`]/g, '') });
      html.push(`<h${level} id="${escapeHtml(id)}">${renderInline(label)}</h${level}>`);
      continue;
    }
    if (index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1])) {
      flushParagraph(); closeList();
      const header = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      index -= 1;
      html.push('<div class="cloud-docs-table-wrap"><table><thead><tr>' + header.map((cell) => `<th>${renderInline(cell)}</th>`).join('') + '</tr></thead><tbody>');
      for (const row of rows) html.push('<tr>' + header.map((_cell, cellIndex) => `<td>${renderInline(row[cellIndex] || '')}</td>`).join('') + '</tr>');
      html.push('</tbody></table></div>');
      continue;
    }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const kind = unordered ? 'ul' : 'ol';
      if (list !== kind) { closeList(); list = kind; html.push(`<${kind}>`); }
      html.push(`<li>${renderInline((unordered || ordered)[1])}</li>`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph(); closeList();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }
    paragraph.push(line.trim());
  }
  if (fence) throw new Error('unterminated code fence');
  flushParagraph(); closeList(); closeAdmonition();
  return { html: html.join('\n'), headings };
}
