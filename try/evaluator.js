// evaluator.js — quality evaluation for AI-generated code in /try.
//
// Three layers of judgment, applied to each pane and the run as a whole:
//
//   A. parseCheck()    — does the code parse at all? (cheap, sync, client-side)
//   B. runtimeCheck()  — does the assembled HTML run without error events?
//   C. judgeRun()      — LLM-as-judge ranks the responses on a rubric
//
// A and B run per pane. C runs once, after every pane finishes.

import { extractFromScope } from './preview.js?v=20260602d';
import { PROVIDERS, runOnce } from './agent.js?v=20260602d';

// ---- A. Parse check ----------------------------------------------------

/// Tries to parse the dominant code in `text`. Recognizes HTML-first (full
/// document or fragment) and JS-first (no HTML, just code).
/// Returns { ok: true } | { ok: false, kind, message }.
export function parseCheck(text) {
  if (!text || !text.trim()) return { ok: false, kind: 'empty', message: 'empty response' };

  // Pull out HTML/JS fenced blocks the same way preview.js does so the
  // judgment matches what users see in Preview.
  const blocks = extractCodeBlocks(text);

  // HTML present → parse via DOMParser, look for a <parsererror>. Catches
  // unbalanced tags, malformed attribute syntax, etc.
  if (blocks.html.length) {
    try {
      const doc = new DOMParser().parseFromString(blocks.html.join('\n'), 'text/html');
      const err = doc.querySelector('parsererror');
      if (err) return { ok: false, kind: 'html_parse', message: trimError(err.textContent) };
      // Cross-check the embedded <script> blocks with the JS parser too —
      // DOMParser is lenient about syntax errors inside <script>.
      const scripts = [...doc.querySelectorAll('script:not([src])')]
        .map((s) => s.textContent || '').filter(Boolean);
      for (const code of scripts) {
        const r = jsParse(code);
        if (!r.ok) return { ok: false, kind: 'js_parse', message: r.message };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, kind: 'html_parse', message: trimError(e?.message || String(e)) };
    }
  }

  if (blocks.js.length) {
    return jsParse(blocks.js.join('\n\n'));
  }

  // Neither — nothing to evaluate. Treat as ok (e.g. an answer that's pure
  // prose, like "Explain a regex").
  return { ok: true, kind: 'no_code' };
}

function jsParse(code) {
  try {
    // `new Function` parses but doesn't execute — same syntax check as
    // eval() without running anything.
    new Function(code);
    return { ok: true };
  } catch (e) {
    return { ok: false, kind: 'js_parse', message: trimError(e?.message || String(e)) };
  }
}

function extractCodeBlocks(text) {
  const html = [];
  const js = [];
  // First: closed fences — ```lang ... ```
  const re = /```([a-z0-9]*)\n([\s\S]*?)```/gi;
  let m;
  let lastEnd = 0;
  while ((m = re.exec(text)) !== null) {
    lastEnd = m.index + m[0].length;
    const lang = (m[1] || '').toLowerCase();
    const body = m[2];
    if (!body.trim()) continue;
    if (lang === 'html' || lang === 'xhtml')                  html.push(body);
    else if (['javascript', 'js', 'jsx', 'mjs'].includes(lang)) js.push(body);
    else if (!lang) {
      if (/<!doctype|<html\b/i.test(body)) html.push(body);
      else if (/\b(function|const|let|var)\b/.test(body))     js.push(body);
    }
  }
  // Tail: an OPEN fence after the last closed one means the model got
  // truncated mid-block (hit max_tokens). Capture it anyway so the parse
  // badge doesn't say "no code" for a clearly-code-heavy response.
  const tail = text.slice(lastEnd);
  const open = tail.match(/```([a-z0-9]*)\n([\s\S]*)$/i);
  if (open) {
    const lang = (open[1] || '').toLowerCase();
    const body = open[2];
    if (body.trim()) {
      if (lang === 'html' || lang === 'xhtml')                  html.push(body);
      else if (['javascript', 'js', 'jsx', 'mjs'].includes(lang)) js.push(body);
      else if (!lang && /<!doctype|<html\b/i.test(body))         html.push(body);
    }
  }
  return { html, js };
}

function trimError(s) {
  s = String(s || '').trim();
  if (s.length > 140) s = s.slice(0, 137) + '…';
  return s;
}

// ---- B. Runtime check --------------------------------------------------

/// Loads the assembled HTML in a hidden sandboxed iframe, listens for
/// uncaught error events for `timeoutMs`, and resolves with a verdict.
/// Skips if there's no HTML to run (returns { ok: true, kind: 'no_html' }).
export function runtimeCheck(text, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    // Synthesize the same DOM scope used by preview.js's extractFromScope —
    // build a tiny fake .turn from the text so we reuse one assembler.
    const wrap = document.createElement('div');
    const turn = document.createElement('div');
    turn.className = 'turn';
    wrap.append(turn);
    // Fake the markdown rendering: parse fences, build <pre><code class="language-X">.
    const re = /```([a-z0-9]*)\n([\s\S]*?)```/gi;
    let m;
    let added = 0;
    while ((m = re.exec(text)) !== null) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = `language-${(m[1] || 'plaintext').toLowerCase()}`;
      code.textContent = m[2];
      pre.append(code);
      turn.append(pre);
      added++;
    }
    if (!added) { resolve({ ok: true, kind: 'no_html' }); return; }

    const html = extractFromScope(turn);
    if (!html) { resolve({ ok: true, kind: 'no_html' }); return; }

    // Inject an error listener at the very top of <head> so it catches
    // synchronous errors fired before any user code runs. postMessages back
    // to the parent on error.
    const sentinel = '__lingcode_eval_' + Math.random().toString(36).slice(2);
    const listener = `<script>(function(){
      window.addEventListener('error', function(e){
        parent.postMessage({ kind: '${sentinel}', error: (e.message || 'error') + (e.lineno ? ' (line ' + e.lineno + ')' : '') }, '*');
      });
      window.addEventListener('unhandledrejection', function(e){
        parent.postMessage({ kind: '${sentinel}', error: 'rejection: ' + String(e.reason).slice(0, 120) }, '*');
      });
    }());</script>`;
    const injected = /<head\b[^>]*>/i.test(html)
      ? html.replace(/<head\b[^>]*>/i, (h) => `${h}\n${listener}`)
      : `${listener}\n${html}`;

    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:600px;height:400px;border:0;visibility:hidden';
    let firstError = null;
    function onMsg(ev) {
      const d = ev.data;
      if (!d || d.kind !== sentinel) return;
      if (!firstError) firstError = d.error || 'unknown error';
    }
    window.addEventListener('message', onMsg);

    const cleanup = () => {
      window.removeEventListener('message', onMsg);
      iframe.remove();
    };
    setTimeout(() => {
      cleanup();
      if (firstError) resolve({ ok: false, kind: 'runtime', message: trimError(firstError) });
      else            resolve({ ok: true });
    }, timeoutMs);

    iframe.srcdoc = injected;
    document.body.append(iframe);
  });
}

// ---- C. LLM-as-judge ---------------------------------------------------

/// Calls LingModel (proxied at /api/inference/anthropic/...) to rank the
/// responses. Returns null if the call fails or the user isn't signed in.
///
/// Returned shape:
///   { winner: <providerId>, winner_reason: string,
///     verdicts: [{ id: <providerId>, score: 0..10, note: string }, ...] }
export async function judgeRun({ prompt, responses, abortSignal, rubricExtra = '', systemOverride = null }) {
  if (!Array.isArray(responses) || responses.length < 2) return null;

  const lingmodel = PROVIDERS.find((p) => p.id === 'lingmodel');
  if (!lingmodel) return null;

  const baseSystem = `You are an expert code reviewer judging multiple AI responses to the same coding prompt.

For each response, rate it on:
- Correctness — does it actually solve the prompt?
- Completeness — does it cover every requirement the prompt asked for?
- Code quality — concise, readable, idiomatic. Prefer working code over verbose explanation.

Output STRICT JSON only. No prose before or after. Schema:
{
  "verdicts": [{ "id": "<providerId>", "score": <0..10>, "note": "<one sentence, <= 90 chars>" }, ...],
  "winner": "<providerId of best response>",
  "winner_reason": "<one sentence, <= 120 chars, explaining WHY this one wins>"
}`;
  // systemOverride is used for weighted mode (different schema). Otherwise
  // we append rubricExtra (preset description / custom user text) to the
  // base rubric so it stays single-score JSON.
  const system = systemOverride || (baseSystem + (rubricExtra || ''));

  const lines = [`Original prompt:\n${prompt}`, ''];
  for (const r of responses) {
    lines.push(`--- Response from "${r.id}" ---`);
    lines.push(r.text || '(empty)');
    lines.push('');
  }
  const userMsg = lines.join('\n');

  // Route through the same runOnce path the live race uses — same headers,
  // same SSE consumption, same proxy auth (session cookie). Avoids drifting
  // from a known-working path.
  const messages = [{ role: 'user', content: [{ type: 'text', text: userMsg }] }];
  let assistantText = '';
  try {
    for await (const piece of runOnce({
      provider: lingmodel,
      apiKey: '',
      messages,
      system,
      tools: [],
      abortSignal,
    })) {
      if (piece.kind === 'text') assistantText += piece.text;
    }
  } catch (e) {
    console.warn('[judge] runOnce failed:', e?.message || e);
    return null;
  }
  if (!assistantText.trim()) {
    console.warn('[judge] empty response from LingModel');
    return null;
  }

  // Strip code fences if the model wrapped its JSON in ```json … ```.
  const cleaned = assistantText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || !Array.isArray(parsed.verdicts)) {
      console.warn('[judge] parsed JSON missing verdicts:', parsed);
      return null;
    }
    return parsed;
  } catch (e) {
    console.warn('[judge] JSON parse failed; raw text:', cleaned.slice(0, 400));
    return null;
  }
}
