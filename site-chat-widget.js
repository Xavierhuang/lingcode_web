/*! site-chat-widget.js — LingCode site assistant. A self-contained floating
 *  helper that answers questions about LingCode, grounded in the site content
 *  via the /api/site-chat RAG endpoint. No dependencies; injects its own DOM +
 *  styles once. Loaded site-wide (one <script> per page). */
(function () {
  'use strict';
  if (window.__lcChat) return; window.__lcChat = true;
  if (typeof document === 'undefined') return;

  var A = '#5b5bf6'; // indigo accent (matches the console refresh)
  var css = ''
    + '.lcw-btn{position:fixed;right:20px;bottom:20px;z-index:9300;width:54px;height:54px;border-radius:50%;border:0;cursor:pointer;'
    + 'background:' + A + ';color:#fff;box-shadow:0 6px 20px rgba(91,91,246,.4);font-size:24px;display:flex;align-items:center;justify-content:center;transition:transform .15s}'
    + '.lcw-btn:hover{transform:translateY(-2px)}'
    + '.lcw-panel{position:fixed;right:20px;bottom:86px;z-index:9300;width:380px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 120px);'
    + 'background:#fff;border:1px solid #ecedf1;border-radius:16px;box-shadow:0 16px 48px rgba(16,24,40,.18);display:none;flex-direction:column;overflow:hidden;'
    + 'font-family:Geist,system-ui,-apple-system,sans-serif;color:#15171c}'
    + '.lcw-panel.open{display:flex}'
    + '.lcw-hd{padding:14px 16px;border-bottom:1px solid #ecedf1;display:flex;align-items:center;gap:8px}'
    + '.lcw-hd b{font-size:.95rem;letter-spacing:-.01em}.lcw-hd .s{font-size:.72rem;color:#9aa0ab}'
    + '.lcw-x{margin-left:auto;background:0;border:0;cursor:pointer;color:#9aa0ab;font-size:18px;line-height:1}'
    + '.lcw-body{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px;background:#fafbfc}'
    + '.lcw-msg{font-size:.86rem;line-height:1.5;max-width:90%;padding:10px 12px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}'
    + '.lcw-msg.u{align-self:flex-end;background:' + A + ';color:#fff;border-bottom-right-radius:4px}'
    + '.lcw-msg.a{align-self:flex-start;background:#fff;border:1px solid #ecedf1;border-bottom-left-radius:4px}'
    + '.lcw-src{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px}'
    + '.lcw-src a{font-size:.72rem;color:' + A + ';text-decoration:none;border:1px solid #e2e3fb;background:#eef0fe;border-radius:99px;padding:2px 9px}'
    + '.lcw-dots{align-self:flex-start;color:#9aa0ab;font-size:.86rem;padding:6px 12px;animation:lcw-pulse 1.3s ease-in-out infinite}'
    + '.lcw-dots::after{content:"";animation:lcw-ell 1.4s steps(1,end) infinite}'
    + '@keyframes lcw-pulse{0%,100%{opacity:.45}50%{opacity:1}}'
    + '@keyframes lcw-ell{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}'
    + '.lcw-msg.a a{color:' + A + ';text-decoration:underline}'
    + '.lcw-msg.a code{background:#f1f2f6;border-radius:5px;padding:1px 5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em}'
    + '.lcw-msg.lcw-stream::after{content:"▋";color:#9aa0ab;margin-left:1px;animation:lcw-blink 1s step-end infinite}'
    + '@keyframes lcw-blink{50%{opacity:0}}'
    + '.lcw-ft{padding:10px 12px;border-top:1px solid #ecedf1;display:flex;gap:8px}'
    + '.lcw-in{flex:1;border:1px solid #e0e2e8;border-radius:10px;padding:9px 12px;font-family:inherit;font-size:.86rem;color:#15171c;outline:none}'
    + '.lcw-in:focus{border-color:' + A + '}'
    + '.lcw-send{border:0;background:' + A + ';color:#fff;border-radius:10px;padding:0 14px;cursor:pointer;font-size:.86rem;font-weight:500}'
    + '.lcw-send:disabled{opacity:.5;cursor:default}'
    + '.lcw-foot{font-size:.66rem;color:#9aa0ab;text-align:center;padding:0 0 8px;background:#fafbfc}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  var btn = el('button', 'lcw-btn'); btn.setAttribute('aria-label', 'Ask LingCode'); btn.innerHTML = '💬';
  var panel = el('div', 'lcw-panel');
  panel.appendChild(el('div', 'lcw-hd', '<b>Ask LingCode</b><span class="s">AI assistant</span><button class="lcw-x" aria-label="Close">✕</button>'));
  var body = el('div', 'lcw-body');
  body.appendChild(msg('a', 'Hi! Ask me anything about LingCode — features, pricing, the CLI, deploying, tutorials…'));
  panel.appendChild(body);
  var ft = el('div', 'lcw-ft');
  var input = el('input', 'lcw-in'); input.type = 'text'; input.placeholder = 'Ask a question…'; input.maxLength = 1000;
  var send = el('button', 'lcw-send', 'Send');
  ft.appendChild(input); ft.appendChild(send); panel.appendChild(ft);
  panel.appendChild(el('div', 'lcw-foot', 'Grounded in lingcode.dev — may be imperfect.'));
  document.body.appendChild(btn); document.body.appendChild(panel);

  function msg(kind, text, sources) {
    var m = el('div', 'lcw-msg ' + kind); m.textContent = text;
    appendSources(m, sources);
    return m;
  }
  function appendSources(m, sources) {
    if (!sources || !sources.length) return;
    var s = el('div', 'lcw-src');
    sources.forEach(function (src) { var a = el('a'); a.href = src.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = src.title || src.url; s.appendChild(a); });
    m.appendChild(s);
  }
  function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  // Minimal, XSS-safe markdown: escape first, then linkify [t](url) (https or
  // root-relative only), **bold**, and `code`.
  function md(raw) {
    var s = escHtml(raw);
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, function (_m, t, u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>'; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    return s;
  }
  function scrollDown() { body.scrollTop = body.scrollHeight; }
  function toggle(open) { panel.classList.toggle('open', open); if (open) setTimeout(function () { input.focus(); }, 50); }

  btn.onclick = function () { toggle(!panel.classList.contains('open')); };
  panel.querySelector('.lcw-x').onclick = function () { toggle(false); };

  var busy = false;
  function ask() {
    var q = (input.value || '').trim(); if (!q || busy) return;
    busy = true; send.disabled = true; input.value = '';
    body.appendChild(msg('u', q)); scrollDown();
    var dots = el('div', 'lcw-dots', 'Thinking'); body.appendChild(dots); scrollDown();
    var done = function () { busy = false; send.disabled = false; input.focus(); };
    fetch('/api/site-chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) })
      .then(function (res) {
        var ctype = res.headers.get('content-type') || '';
        if (res.ok && ctype.indexOf('text/event-stream') >= 0 && res.body) return streamAnswer(res, dots).then(done);
        // JSON path: errors + the "not sure" no-hits answer
        return res.json().catch(function () { return null; }).then(function (j) {
          dots.remove();
          if (res.ok && j && j.data) { var m = el('div', 'lcw-msg a'); m.innerHTML = md(j.data.answer); appendSources(m, j.data.sources); body.appendChild(m); }
          else if (res.status === 429) body.appendChild(msg('a', (j && j.message) || 'Too many questions — please wait a bit.'));
          else body.appendChild(msg('a', (j && j.message) || 'Sorry, something went wrong. Try the docs at /docs.html.'));
          scrollDown(); done();
        });
      })
      .catch(function () { dots.remove(); body.appendChild(msg('a', 'Network error — please try again.')); scrollDown(); done(); });
  }
  // Read the SSE stream, rendering markdown live (with a blinking caret), then
  // attach the cited sources on the `done` event.
  function streamAnswer(res, dots) {
    var m = el('div', 'lcw-msg a lcw-stream'), acc = '', srcs = [], started = false;
    var reader = res.body.getReader(), decd = new TextDecoder(), buf = '';
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return finish();
        buf += decd.decode(r.value, { stream: true });
        var i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          var evt = buf.slice(0, i); buf = buf.slice(i + 2);
          var dl = evt.split('\n').filter(function (l) { return l.indexOf('data:') === 0; })[0];
          if (!dl) continue;
          var d; try { d = JSON.parse(dl.slice(5).trim()); } catch (e) { continue; }
          if (d.text != null) { if (!started) { started = true; dots.remove(); body.appendChild(m); } acc += d.text; m.innerHTML = md(acc); scrollDown(); }
          else if (d.sources) srcs = d.sources;
        }
        return pump();
      });
    }
    function finish() {
      if (!started) { dots.remove(); body.appendChild(m); }
      m.classList.remove('lcw-stream');
      m.innerHTML = md(acc || 'Sorry, I couldn’t generate an answer.');
      appendSources(m, srcs); scrollDown();
    }
    return pump().catch(finish);
  }
  send.onclick = ask;
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ask(); } });
})();
