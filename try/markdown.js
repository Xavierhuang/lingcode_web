// markdown.js — tiny streaming markdown renderer for /try output panes.
//
// Uses marked (parser) + DOMPurify (XSS sanitizer) from esm.sh — no build step.
// On each text delta we re-parse the accumulated markdown into HTML; for
// typical model output (a few KB) this is well under a millisecond and lets
// us show formatted output as it streams.

import { marked } from 'https://esm.sh/marked@14.1.3';
import { markedHighlight } from 'https://esm.sh/marked-highlight@2.2.1';
import hljs from 'https://esm.sh/highlight.js@11.10.0';
import DOMPurify from 'https://esm.sh/dompurify@3.2.4';

// Wire highlight.js into marked. Each fenced ```<lang> block gets parsed and
// emitted with hljs span classes (.hljs-keyword, .hljs-string, etc.) — the
// CSS in try.html maps those to colors that match the site palette.
marked.use(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      // 'tool' / 'tool-result' are our internal markers for the agent's
      // tool calls and their returned values — leave plain so the
      // dedicated CSS rules style them without hljs interference.
      if (lang === 'tool' || lang === 'tool-result') return code;
      const language = lang && hljs.getLanguage(lang) ? lang : null;
      try {
        if (language) return hljs.highlight(code, { language, ignoreIllegals: true }).value;
        return hljs.highlightAuto(code).value;
      } catch {
        return code;
      }
    },
  })
);

marked.setOptions({
  gfm: true,        // GitHub-flavored: tables, strikethrough, fenced code
  breaks: true,     // single \n becomes <br> — matches what users typed
  pedantic: false,
});

// DOMPurify config: allow common markdown output, strip scripts / iframes /
// event handlers. The model output is rendered to other users only on the
// same machine, but the page is public and a model response containing a
// <script> would still be a footgun if we ever change architecture, so just
// sanitize at the boundary.
const DOMPURIFY_OPTS = {
  ALLOWED_TAGS: [
    'h1','h2','h3','h4','h5','h6',
    'p','br','hr',
    'strong','em','u','s','del','ins','sub','sup','small',
    'ul','ol','li',
    'blockquote',
    'code','pre',
    'a',
    'table','thead','tbody','tr','th','td',
    'span','div',
    'button',     // copy-btn injected post-render
  ],
  ALLOWED_ATTR: ['href','title','class','target','rel','type','aria-label'],
  ALLOW_DATA_ATTR: false,
};

/**
 * Render an accumulated markdown string into a sanitized HTML string.
 * Safe to call on partial / mid-stream input — marked handles unclosed code
 * fences gracefully (they just become open <pre><code>).
 */
export function renderMarkdown(text) {
  if (!text) return '';
  const html = marked.parse(text, { async: false });
  const safe = DOMPurify.sanitize(html, DOMPURIFY_OPTS);
  return safe;
}
