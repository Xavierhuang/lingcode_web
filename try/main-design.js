// main-design.js — "Design phase" for /try. After the scope + clarifications
// are locked in, a design director proposes several distinct visual directions,
// renders a representative mockup for each in a phone frame, and lets the user
// pick a favorite. Clicking a style opens a detail view with a Mobile/PC toggle
// and sub-tabs (Preview | Code | Variations). The chosen direction (style brief +
// reference mockup) is injected into the build prompt so the final app matches it.
//
// runDesignGate() resolves to a chosen direction object, or null when the build
// isn't visual (model returns no styles) or the user skips the phase.

import { runAgent } from './agent.js?v=20260602d';
import { extractHtmlFromCodeBlock } from './swarm.js?v=20260602d';
import { postChatMessage, postChatMessageDelayed } from './main-chat.js?v=20260602d';
import { advanceStep } from './main-build-checklist.js?v=20260602d';
import { injectInlineEditScript } from './main-inline-edit.js?v=20260602d';

const DEFAULT_COUNT = 6;
const MORE_COUNT = 3;

// [build-style] DEBUG: log the input composer's viewport position so we can see
// when/why it scrolls out of view after a style is picked. Temporary — strip
// along with the other [build-style] logs. Exposed on window so other modules
// (main.js) can call the same probe without an import/cache-buster bump.
function logComposerRect(label) {
  try {
    const ta = document.getElementById('prompt');
    const row = document.querySelector('.try-prompt-row');
    const el = ta || row;
    if (!el) { console.log('[build-style] composer@' + label + ': #prompt not found'); return; }
    const r = el.getBoundingClientRect();
    const ih = window.innerHeight;
    const inView = r.bottom > 0 && r.top < ih;
    const cs = getComputedStyle(row || el);
    console.log(
      '[build-style] composer@' + label + ':',
      'top=' + Math.round(r.top), 'bottom=' + Math.round(r.bottom), 'height=' + Math.round(r.height),
      '| innerH=' + ih, '| inViewport=' + inView,
      '| position=' + cs.position, 'display=' + cs.display, 'visibility=' + cs.visibility,
      '| body.class="' + document.body.className + '"',
    );
  } catch (e) { console.warn('[build-style] logComposerRect failed:', e); }
}
if (typeof window !== 'undefined') window.__logComposerRect = logComposerRect;

const STYLES_SYSTEM = `You are a design director in a browser code playground. Given a build request and its approved scope, first decide whether this is a VISUAL / UI build — anything with a user-facing interface (app, site, page, dashboard, deck). If it is NOT visual (a pure API, script, data pipeline, CLI, etc.), output exactly: {"visual": false, "styles": []}

If it IS visual, propose distinct design directions. Output ONLY valid JSON — no prose, no markdown fences:
{
  "visual": true,
  "styles": [
    {
      "name": "evocative 1-3 word name",
      "vibe": "one line describing the aesthetic",
      "palette": ["#hex", "#hex", "#hex", "#hex"],
      "typography": "font pairing / type feel",
      "layout": "the key layout idea"
    }
  ]
}

Make the directions genuinely different from each other (e.g. editorial, minimal, playful, dark/tactile, premium). Return ONLY the JSON object.`;

const MOCKUP_SYSTEM = `You are a UI designer. Produce a SINGLE representative screen for the described app, faithfully in the given visual style. Output ONE fenced \`\`\`html block: a complete, self-contained HTML document with inline CSS (and minimal inline JS only if truly needed). No external build step, no npm, no external assets beyond Google Fonts links. Design mobile-first (~390px) but make the CSS responsive so it also scales cleanly to a desktop width. Honor the style's palette, typography, and vibe exactly. A polished static mockup with realistic placeholder content is the goal — no real data or backend.`;

function parseStylesJson(text) {
  let obj = null;
  try {
    obj = JSON.parse(String(text || '').trim());
  } catch {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch {} }
  }
  if (!obj || obj.visual === false || !Array.isArray(obj.styles)) return [];
  return obj.styles
    .filter((s) => s && typeof s.name === 'string')
    .map((s) => ({
      name: s.name.trim() || 'Style',
      vibe: String(s.vibe || '').trim(),
      palette: Array.isArray(s.palette) ? s.palette.filter((c) => typeof c === 'string').slice(0, 6) : [],
      typography: String(s.typography || '').trim(),
      layout: String(s.layout || '').trim(),
    }));
}

async function generateStyles({ prompt, summary, provider, apiKey, count = DEFAULT_COUNT, avoid = [] }) {
  let userPrompt = `User's build request:\n${prompt}\n\nApproved scope (JSON):\n${JSON.stringify(summary)}\n\nPropose ${count} design directions.`;
  if (avoid.length) userPrompt += `\n\nAvoid repeating these already-shown directions: ${avoid.join(', ')}. Make these clearly different.`;
  let text = '';
  await runAgent({
    provider, apiKey, userPrompt,
    system: STYLES_SYSTEM, tools: [], abortSignal: null,
    onEvent: (e) => { if (e.kind === 'text') text += e.text; },
  });
  return parseStylesJson(text).slice(0, count);
}

// Generate (or tweak) a style's mockup. Pass baseHtml + instruction to apply a
// customization to the current mockup instead of starting fresh.
async function generateMockup({ prompt, summary, style, provider, apiKey, baseHtml = null, instruction = null }) {
  let userPrompt =
    `App to mock up:\n${prompt}\n\nApproved scope (JSON):\n${JSON.stringify(summary)}\n\n` +
    `Design direction "${style.name}":\n` +
    `- Vibe: ${style.vibe}\n- Palette: ${style.palette.join(', ')}\n` +
    `- Typography: ${style.typography}\n- Layout: ${style.layout}`;
  if (baseHtml && instruction) {
    userPrompt += `\n\nCurrent mockup HTML:\n\`\`\`html\n${baseHtml}\n\`\`\`\n\nApply this change and return the FULL updated mockup: ${instruction}`;
  } else if (instruction) {
    userPrompt += `\n\n${instruction}`;
  }
  let text = '';
  await runAgent({
    provider, apiKey, userPrompt,
    system: MOCKUP_SYSTEM, tools: [], abortSignal: null,
    onEvent: (e) => { if (e.kind === 'text') text += e.text; },
  });
  return extractHtmlFromCodeBlock(text).trim();
}

// Build the prompt preamble that pins the final build to the chosen direction.
export function buildDesignBlock(chosen) {
  if (!chosen) {
    console.log('[build-style] buildDesignBlock(): no chosen style → empty block');
    return '';
  }
  const lines = [
    '',
    '[Approved design direction — build the app in this exact visual style]',
    `Style: ${chosen.name}`,
  ];
  if (chosen.vibe) lines.push(`Vibe: ${chosen.vibe}`);
  if (chosen.palette?.length) lines.push(`Palette: ${chosen.palette.join(', ')}`);
  if (chosen.typography) lines.push(`Typography: ${chosen.typography}`);
  if (chosen.layout) lines.push(`Layout: ${chosen.layout}`);
  if (chosen.html) {
    lines.push('Match the look & feel of this approved mockup (extend its style to the full app):');
    lines.push('```html');
    lines.push(chosen.html);
    lines.push('```');
  }
  const block = lines.join('\n');
  console.log('[build-style] buildDesignBlock():', chosen.name, '| block', block.length, 'chars | embedded html', (chosen.html || '').length, 'chars');
  return block;
}

// Render an html mockup into `container` as a scaled, framed iframe.
// mode: 'mobile' (phone frame) | 'pc' (desktop frame).
function renderPreview(container, html, mode) {
  container.innerHTML = '';
  if (!html) {
    container.textContent = 'No preview for this style.';
    container.style.cssText = 'color:var(--text-muted);font-size:12px;padding:20px;';
    return;
  }
  const isPC = mode === 'pc';
  const vw = isPC ? 1280 : 390;
  const vh = isPC ? 820 : 780;
  const scale = isPC ? 0.5 : 0.8;
  const fw = Math.round(vw * scale);
  const fh = Math.round(vh * scale);

  const frame = document.createElement('div');
  frame.style.cssText = `width:${fw}px;height:${fh}px;overflow:hidden;position:relative;background:#fff;margin:0 auto;border:2px solid var(--border);border-radius:${isPC ? 10 : 26}px;`;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.style.cssText = `width:${vw}px;height:${vh}px;border:0;transform:scale(${scale});transform-origin:top left;background:#fff;`;
  // Inject the click-to-edit picker so clicking an element opens the
  // visual-edits panel. forcePanel:true because the "✏ Visual edits" toggle
  // isn't reachable during the design-style gate. postMessage works under the
  // existing allow-scripts sandbox — no allow-same-origin needed.
  iframe.srcdoc = injectInlineEditScript(html, { forcePanel: true });
  frame.append(iframe);
  container.style.cssText = '';
  container.append(frame);
}

function downloadHtml(name, html) {
  const blob = new Blob([html || ''], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(name || 'style').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.html`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Gate ----
export function runDesignGate({ prompt, summary, provider, apiKey }) {
  return new Promise((resolve) => {
    const styles = [];          // [{ name, vibe, palette, typography, layout, html, fav, _frame, _spinner }]
    let settled = false;
    const finish = (result) => {
      if (settled) {
        console.log('[build-style] finish() ignored — already settled');
        return;
      }
      settled = true;
      console.log('[build-style] finish():', result ? `building screen for "${result.name}"` : 'null result → cleanup (cancelled)');
      // Chat is append-only: we intentionally do NOT remove the styles-picker card
      // or the "Pick a style to continue…" hint. They stay as a permanent transcript
      // of what the user picked from. The picker card in #lc-design-chat-card stays
      // visible; renderGallery's own re-render guard at the top of that function
      // still prevents duplication if the gallery re-renders while the gate is open.
      if (result) {
        // Keep panel visible as a palette-tinted "Building…" screen so the
        // workspace never shows a blank void. A MutationObserver fades it out
        // the moment the first real pane content appears.
        showBuildingScreen(result);
      } else {
        cleanup();
      }
      logComposerRect('after-showBuildingScreen');
      console.log('[build-style] finish() resolving runDesignGate promise');
      resolve(result);
    };

    const panel = document.createElement('div');
    panel.id = 'lc-design-panel';
    // Initial inline style — will be overwritten by renderGallery/renderDetail.
    panel.style.cssText = 'font-family:system-ui,-apple-system,sans-serif;color:var(--text);';

    // Panel is created now but NOT mounted yet — we wait until styles are ready
    // so there's no blank black rectangle during the generateStyles() call.
    let _panelMounted = false;
    function mountPanel() {
      if (_panelMounted) return;
      _panelMounted = true;
      document.body.classList.add('try-design-gate');
      const workspaceBody = document.querySelector('.try-workspace-body');
      if (workspaceBody) {
        workspaceBody.appendChild(panel);
      } else {
        const _ov = document.createElement('div');
        _ov.className = 'lc-gate-overlay';
        _ov.appendChild(panel);
        document.body.appendChild(_ov);
      }
    }
    const cleanup = () => {
      document.body.classList.remove('try-design-gate');
      panel.remove();
      // Chat is append-only: leave the styles-picker card and "Pick a style…" hint
      // in the chat transcript even when the gate aborts. The right-panel UI is
      // torn down (panel.remove() above) but the chat history is preserved.
    };

    // Transform the panel into a palette-tinted "Building…" holding screen.
    // Stays visible until the first real workspace pane content appears, then
    // fades out and removes itself. Prevents the blank-void gap after picking a style.
    function showBuildingScreen(style) {
      console.log('[build-style] showBuildingScreen():', style.name, '| palette:', style.palette);
      const [c0 = '#1a1a2e', c1 = '#7c3aed', c2 = '#a78bfa'] = style.palette;
      panel.innerHTML = '';
      panel.style.cssText = [
        'display:flex', 'flex-direction:column', 'align-items:center',
        'justify-content:center', 'position:relative', 'overflow:hidden',
        'font-family:system-ui,-apple-system,sans-serif', 'color:var(--text)',
        'transition:opacity 0.5s ease',
      ].join(';');

      // Animated aurora background — two palette-tinted blobs slowly drifting
      // over the base color (deep-space feel). Transform/opacity only → GPU.
      const bg = document.createElement('div');
      bg.style.cssText = `position:absolute;inset:0;pointer-events:none;overflow:hidden;background:${c0};`;
      const blob1 = document.createElement('div');
      blob1.style.cssText = `position:absolute;width:85%;height:85%;left:50%;top:50%;border-radius:50%;background:radial-gradient(circle, ${c1}, transparent 70%);opacity:0.28;animation:lc-bs-aurora1 9s ease-in-out infinite;`;
      const blob2 = document.createElement('div');
      blob2.style.cssText = `position:absolute;width:72%;height:72%;left:50%;top:50%;border-radius:50%;background:radial-gradient(circle, ${c2}, transparent 70%);opacity:0.20;animation:lc-bs-aurora2 11s ease-in-out infinite;`;
      bg.append(blob1, blob2);
      panel.append(bg);

      // Twinkling starfield (white + palette pinpoints, staggered).
      const stars = document.createElement('div');
      stars.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
      const STAR_POS = [[12,18],[28,62],[44,28],[63,72],[78,20],[88,54],[20,84],[55,12],[70,44],[35,52],[8,46],[92,76]];
      STAR_POS.forEach((p, i) => {
        const s = document.createElement('span');
        const sz = 1.5 + (i % 3);
        s.style.cssText = `position:absolute;left:${p[0]}%;top:${p[1]}%;width:${sz}px;height:${sz}px;border-radius:50%;background:${i % 2 ? c2 : '#ffffff'};animation:lc-bs-twinkle ${(2.4 + (i % 4) * 0.6).toFixed(1)}s ease-in-out ${(i * 0.3).toFixed(1)}s infinite;`;
        stars.append(s);
      });
      panel.append(stars);

      // Animated loading bar at the very top (matches palette)
      const barWrap = document.createElement('div');
      barWrap.style.cssText = 'position:absolute;top:0;left:0;right:0;height:2px;background:rgba(128,128,128,0.12);z-index:2;';
      const bar = document.createElement('div');
      bar.style.cssText = `position:absolute;top:0;bottom:0;background:${c1};animation:lc-ph-bar 1.8s ease-in-out infinite;opacity:0.9;`;
      barWrap.append(bar);
      panel.append(barWrap);

      // Center content
      const card = document.createElement('div');
      card.style.cssText = 'text-align:center;padding:40px 32px;z-index:2;max-width:320px;position:relative;';

      // Style-palette dots — staggered glow-pulse wave
      const dotsRow = document.createElement('div');
      dotsRow.style.cssText = 'display:flex;gap:10px;justify-content:center;margin-bottom:22px;';
      style.palette.slice(0, 4).forEach((c, i) => {
        const dot = document.createElement('span');
        dot.style.cssText = `width:14px;height:14px;border-radius:50%;background:${c};display:inline-block;box-shadow:0 0 12px ${c};animation:lc-bs-dot 1.4s ease-in-out ${(i * 0.18).toFixed(2)}s infinite;`;
        dotsRow.append(dot);
      });

      const heading = document.createElement('div');
      heading.style.cssText = 'font-size:15px;font-weight:700;margin-bottom:6px;animation:lc-bs-breathe 2.6s ease-in-out infinite;';
      heading.textContent = 'Building your app';

      const sub = document.createElement('div');
      sub.style.cssText = 'font-size:13px;color:var(--text-muted);margin-bottom:6px;';
      const subStrong = document.createElement('strong');
      subStrong.style.cssText = `color:${c1};`;
      subStrong.textContent = style.name;
      sub.append(document.createTextNode('in '), subStrong, document.createTextNode(' style'));

      // Shimmering hint — reinforces "streaming" (same gradient-text technique
      // as the chat status shimmer).
      const hint = document.createElement('div');
      hint.style.cssText = `font-size:11.5px;font-weight:500;margin-top:16px;background:linear-gradient(90deg, var(--text-muted) 0%, ${c2} 45%, var(--text-muted) 90%);background-size:200% auto;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;animation:lc-bs-shimmer 2.8s linear infinite;`;
      hint.textContent = 'Preview will appear as code streams in';

      card.append(dotsRow, heading, sub, hint);
      panel.append(card);

      // The building screen stays up for the WHOLE build and dismisses only when
      // the build's first run completes (main.js dispatches lingcode:build-preview-ready
      // after Promise.allSettled + the final preview render). It must NOT dismiss
      // on the first streaming iframe — that's a PARTIAL render (incomplete game
      // JS → blank), which used to make the screen vanish ~2s in.
      const workspace = document.getElementById('workspace') || document.body;
      let removed = false;
      let watchdog = null;
      const onReady = () => removePanel();
      const removePanel = () => {
        if (removed) return;
        removed = true;
        if (watchdog) clearInterval(watchdog);
        obs.disconnect();
        window.removeEventListener('lingcode:build-preview-ready', onReady);
        panel.style.opacity = '0';
        setTimeout(() => {
          document.body.classList.remove('try-design-gate');
          panel.remove();
        }, 500);
      };

      // Primary dismissal: the build told us it finished and rendered.
      window.addEventListener('lingcode:build-preview-ready', onReady);

      // Track DOM activity in #workspace only to distinguish "still building"
      // from "stalled/dead" for the fallback below — NOT to dismiss.
      const startedAt = Date.now();
      let lastActivity = startedAt;
      const obs = new MutationObserver(() => { lastActivity = Date.now(); });
      obs.observe(workspace, { childList: true, subtree: true });

      // Fallback only: if the build never signals ready AND the workspace goes
      // silent for a long stretch (no streaming → likely died), dismiss so the
      // screen doesn't spin forever. A reassurance hint kicks in earlier.
      let reassured = false;
      const STALL_MS = 90_000;
      watchdog = setInterval(() => {
        if (removed) { clearInterval(watchdog); return; }
        const quietFor = Date.now() - lastActivity;
        if (!reassured && quietFor < STALL_MS && Date.now() - startedAt > 25_000) {
          reassured = true;
          hint.textContent = 'Still building — larger apps take a little longer…';
        }
        if (quietFor > STALL_MS) {
          console.warn('[build-style] build stalled ~' + Math.round(quietFor / 1000) + 's, no ready signal — removing building screen');
          removePanel();
        }
      }, 5_000);
    }

    // Small toolbar icon button.
    function iconBtn(label, title, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.textContent = label;
      b.style.cssText = 'border:1px solid var(--border);background:none;color:var(--text);border-radius:8px;min-width:30px;height:30px;padding:0 8px;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;';
      b.addEventListener('click', onClick);
      return b;
    }

    // Shared tab button builder — returns [tabsRow element, switchTab fn, tabBtns map].
    function buildTabBar(defs, activeId) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:stretch;';
      const btns = {};
      const switchTab = (id, skipBtnUpdate = false) => {
        if (!skipBtnUpdate) {
          for (const [tid, tb] of Object.entries(btns)) {
            const isA = tid === id;
            tb.style.color = isA ? 'var(--accent,#7c3aed)' : 'var(--text-muted)';
            tb.style.borderBottom = `2px solid ${isA ? 'var(--accent,#7c3aed)' : 'transparent'}`;
          }
        }
      };
      for (const td of defs) {
        const tb = document.createElement('button');
        tb.type = 'button'; tb.textContent = td.label;
        const isActive = td.id === activeId;
        tb.style.cssText = [
          'padding:0 14px', 'border:none', 'background:none', 'cursor:pointer',
          'font-size:12.5px', 'font-weight:500', 'font-family:inherit',
          `color:${isActive ? 'var(--accent,#7c3aed)' : 'var(--text-muted)'}`,
          `border-bottom:2px solid ${isActive ? 'var(--accent,#7c3aed)' : 'transparent'}`,
          'margin-bottom:-1px', 'transition:color .12s,border-color .12s', 'white-space:nowrap',
        ].join(';');
        btns[td.id] = tb;
        tb.addEventListener('click', () => { switchTab(td.id); if (td.onSelect) td.onSelect(); });
        row.append(tb);
      }
      return { row, switchTab, btns };
    }

    // ---------- Style placeholder ----------
    // Shown immediately in each phone frame while the AI generates the real mockup.
    // Uses the style's palette so each card looks distinct right away.
    (function ensureDesignPlaceholderStyle() {
      if (document.getElementById('lc-design-ph-style')) return;
      const st = document.createElement('style');
      st.id = 'lc-design-ph-style';
      st.textContent =
        '@keyframes lc-ph-sweep{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}' +
        '@keyframes lc-ph-bar{0%{left:0;right:70%}50%{left:30%;right:0}100%{left:0;right:70%}}' +
        // Building-screen ambience — all transform/opacity so it composites on
        // the GPU, and it only runs while the (transient) building screen shows.
        // Centered on the pane (the blobs sit at left/top:50%; the -50% base
        // centers each on that anchor, then a small ±8% drift breathes around
        // the middle instead of hugging a corner).
        '@keyframes lc-bs-aurora1{0%{transform:translate(-58%,-55%) scale(1)}50%{transform:translate(-42%,-44%) scale(1.18)}100%{transform:translate(-58%,-55%) scale(1)}}' +
        '@keyframes lc-bs-aurora2{0%{transform:translate(-44%,-42%) scale(1.12)}50%{transform:translate(-57%,-58%) scale(1)}100%{transform:translate(-44%,-42%) scale(1.12)}}' +
        '@keyframes lc-bs-twinkle{0%,100%{opacity:0.12;transform:scale(0.7)}50%{opacity:0.95;transform:scale(1.2)}}' +
        '@keyframes lc-bs-dot{0%,100%{transform:translateY(0) scale(1);opacity:0.5}50%{transform:translateY(-5px) scale(1.3);opacity:1}}' +
        '@keyframes lc-bs-breathe{0%,100%{opacity:0.8}50%{opacity:1}}' +
        '@keyframes lc-bs-shimmer{0%{background-position:200% center}100%{background-position:-200% center}}';
      document.head.appendChild(st);
    })();

    function buildStylePlaceholder(style) {
      const [c0 = '#1a1a2e', c1 = '#7c3aed', c2 = '#a78bfa', c3 = '#c4b5fd'] = style.palette;
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;inset:0;overflow:hidden;font-family:system-ui,sans-serif;';
      el.innerHTML = `
        <div style="position:absolute;inset:0;background:${c0};"></div>
        <div style="position:absolute;top:0;left:0;right:0;height:2px;background:rgba(255,255,255,0.08);z-index:8;">
          <div style="position:absolute;top:0;bottom:0;background:${c1};border-radius:1px;animation:lc-ph-bar 1.6s ease-in-out infinite;opacity:0.85;"></div>
        </div>
        <div style="position:absolute;top:2px;left:0;right:0;height:18px;background:rgba(0,0,0,0.25);"></div>
        <div style="position:absolute;top:20px;left:0;right:0;height:44px;background:rgba(0,0,0,0.18);display:flex;align-items:center;padding:0 12px;gap:8px;">
          <div style="width:22px;height:22px;border-radius:50%;background:${c1};opacity:0.9;"></div>
          <div style="flex:1;height:8px;border-radius:4px;background:rgba(255,255,255,0.18);"></div>
          <div style="width:22px;height:22px;border-radius:6px;background:rgba(255,255,255,0.12);"></div>
        </div>
        <div style="position:absolute;top:76px;left:12px;right:12px;height:100px;border-radius:14px;background:${c1};opacity:0.75;"></div>
        <div style="position:absolute;top:188px;left:12px;width:80px;height:65px;border-radius:10px;background:${c2};opacity:0.55;"></div>
        <div style="position:absolute;top:188px;left:100px;right:12px;height:65px;border-radius:10px;background:${c3};opacity:0.45;"></div>
        <div style="position:absolute;top:266px;left:12px;right:40px;height:7px;border-radius:4px;background:rgba(255,255,255,0.28);"></div>
        <div style="position:absolute;top:278px;left:12px;right:55px;height:5px;border-radius:3px;background:rgba(255,255,255,0.18);"></div>
        <div style="position:absolute;top:288px;left:12px;right:48px;height:5px;border-radius:3px;background:rgba(255,255,255,0.14);"></div>
        <div style="position:absolute;top:308px;left:12px;right:12px;height:32px;border-radius:8px;background:${c1};opacity:0.85;"></div>
        <div style="position:absolute;bottom:0;left:0;right:0;height:44px;background:rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:space-around;padding:0 16px;">
          <div style="width:18px;height:18px;border-radius:4px;background:${c1};opacity:0.9;"></div>
          <div style="width:18px;height:18px;border-radius:50%;background:rgba(255,255,255,0.2);"></div>
          <div style="width:18px;height:18px;border-radius:4px;background:rgba(255,255,255,0.2);"></div>
          <div style="width:18px;height:18px;border-radius:4px;background:rgba(255,255,255,0.2);"></div>
        </div>
        <div style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:6;">
          <div style="position:absolute;top:0;bottom:0;width:45%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.07),transparent);animation:lc-ph-sweep 2s ease-in-out infinite;"></div>
        </div>
        <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.55);backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,0.14);border-radius:20px;padding:5px 12px;font-size:11px;color:rgba(255,255,255,0.75);white-space:nowrap;pointer-events:none;z-index:9;animation:lc-ph-sweep 2.4s ease-in-out infinite alternate;">Generating…</div>
      `;
      return el;
    }

    // ---------- Gallery view ----------
    // _galleryTab: 'all' | 'favorites' | 'compare'
    let _galleryTab = 'all';
    let _compareSelected = new Set(); // style indices selected for side-by-side compare
    let _currentDetailIndex = -1; // which style is open in detail view (-1 = gallery)

    function renderGallery(tab = _galleryTab) {
      _galleryTab = tab;
      _currentDetailIndex = -1;
      panel.innerHTML = '';
      document.getElementById('lc-design-chat-card')?.remove();
      panel.style.cssText = 'display:flex;flex-direction:column;font-family:system-ui,-apple-system,sans-serif;color:var(--text);';

      // ── CHAT SIDE: style picker card ──────────────────────────────────────
      const chatCard = document.createElement('div');
      chatCard.id = 'lc-design-chat-card';
      chatCard.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:8px;animation:lc-panel-in 0.3s ease;';
      const cardInner = document.createElement('div');
      cardInner.style.cssText = [
        'border:1px solid var(--border)', 'border-radius:12px',
        'background:var(--bg-card,var(--surface,#f3f4f6))', 'padding:12px 14px',
        'color:var(--text)', 'font-family:system-ui,-apple-system,sans-serif',
      ].join(';');
      const cardHead = document.createElement('div');
      cardHead.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';
      const cardHeadLeft = document.createElement('div');
      cardHeadLeft.style.cssText = 'font-size:13px;font-weight:700;color:var(--accent,#7c3aed);display:flex;align-items:center;gap:6px;';
      cardHeadLeft.innerHTML = `<span>✓</span> Generated ${styles.length} design styles`;
      const skipBtn = document.createElement('button');
      skipBtn.type = 'button'; skipBtn.textContent = '✕';
      skipBtn.style.cssText = 'border:none;background:none;color:var(--text-muted);font-size:13px;cursor:pointer;padding:0;';
      skipBtn.addEventListener('click', () => finish(null));
      cardHead.append(cardHeadLeft, skipBtn);
      const pickLabel = document.createElement('div');
      pickLabel.textContent = 'Pick your favorite style';
      pickLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px;';
      const list = document.createElement('div');
      list.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button'; moreBtn.textContent = 'Need another direction?';
      moreBtn.style.cssText = 'margin-top:10px;padding:0;border:none;background:none;color:var(--text-muted);font-family:inherit;font-size:12px;cursor:pointer;text-align:left;';
      moreBtn.addEventListener('click', async () => {
        moreBtn.disabled = true; moreBtn.innerHTML = '<span class="lc-spin"></span> Generating…';
        try {
          const more = await generateStyles({ prompt, summary, provider, apiKey, count: MORE_COUNT, avoid: styles.map((s) => s.name) });
          const start = styles.length;
          for (const m of more) styles.push(m);
          if (!settled) { renderGallery(); renderMockups(styles.slice(start)); }
        } catch {}
        moreBtn.disabled = false; moreBtn.textContent = 'Need another direction?';
      });
      cardInner.append(cardHead, pickLabel, list, moreBtn);
      chatCard.append(cardInner);
      const chatHistory = document.getElementById('try-chat-history');
      if (chatHistory) {
        chatHistory.appendChild(chatCard);
        requestAnimationFrame(() => chatCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
      }

      // ── PREVIEW PANEL: tab bar + content ──────────────────────────────────
      // --- Panel header: gallery tabs + right controls ---
      const panelHeader = document.createElement('div');
      panelHeader.style.cssText = [
        'display:flex', 'align-items:stretch', 'justify-content:space-between',
        'border-bottom:1px solid var(--border)', 'padding:0 16px',
        'background:var(--bg-card,var(--surface,#f9fafb))',
        'flex-shrink:0', 'min-height:42px',
      ].join(';');

      const favCount = styles.filter(s => s.fav).length;
      const { row: tabsRow } = buildTabBar([
        { id: 'all',       label: `All styles (${styles.length})`, onSelect: () => renderGallery('all') },
        { id: 'favorites', label: `♡ Favorites${favCount ? ` (${favCount})` : ''}`, onSelect: () => renderGallery('favorites') },
        { id: 'compare',   label: '⊞ Compare', onSelect: () => renderGallery('compare') },
      ], tab);

      const rightControls = document.createElement('div');
      rightControls.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 0;';
      const dlAllBtn = iconBtn('⬇ Download all', 'Download all generated HTML files', () => {
        styles.filter(s => s.html).forEach(s => downloadHtml(s.name, s.html));
      });
      rightControls.append(dlAllBtn);
      panelHeader.append(tabsRow, rightControls);
      panel.append(panelHeader);

      // --- Panel content ---
      const content = document.createElement('div');
      content.style.cssText = 'flex:1;overflow:auto;';
      panel.append(content);

      if (tab === 'all' || tab === 'favorites') {
        const filtered = tab === 'favorites' ? styles.filter(s => s.fav) : styles;
        if (tab === 'favorites' && filtered.length === 0) {
          content.style.cssText += 'display:flex;align-items:center;justify-content:center;';
          content.innerHTML = `<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:40px;">
            No favorites yet.<br>Open a style and click ♡ to save it here.
          </div>`;
        } else {
          const thumbs = document.createElement('div');
          thumbs.style.cssText = 'display:flex;gap:16px;padding:20px 24px;min-height:100%;overflow-x:auto;align-items:flex-start;box-sizing:border-box;';
          content.append(thumbs);
          filtered.forEach((style) => {
            const index = styles.indexOf(style);
            // Chat-side row
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:background .12s;';
            row.addEventListener('mouseenter', () => { row.style.background = 'rgba(99,102,241,0.06)'; });
            row.addEventListener('mouseleave', () => { row.style.background = ''; });
            const left = document.createElement('div');
            left.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;';
            const dots = document.createElement('div');
            dots.style.cssText = 'display:flex;gap:3px;flex:none;';
            for (const c of style.palette.slice(0, 2)) {
              const dot = document.createElement('span');
              dot.style.cssText = `width:10px;height:10px;border-radius:50%;background:${c};border:1px solid rgba(0,0,0,0.2);`;
              dots.append(dot);
            }
            const nm = document.createElement('span');
            nm.textContent = (style.fav ? '★ ' : '') + style.name;
            nm.style.cssText = 'font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text);';
            left.append(dots, nm);
            const view = document.createElement('span');
            view.textContent = 'View →';
            view.style.cssText = 'font-size:12px;color:var(--text-muted);flex:none;';
            row.append(left, view);
            row.addEventListener('click', () => renderDetail(index));
            list.append(row);

            // Phone frame thumb
            const frame = document.createElement('div');
            frame.style.cssText = 'flex:none;width:200px;height:400px;border:2px solid var(--border);border-radius:20px;overflow:hidden;position:relative;background:#111;cursor:pointer;';
            const frameLabel = document.createElement('div');
            frameLabel.textContent = style.name;
            frameLabel.style.cssText = 'position:absolute;left:0;right:0;bottom:0;padding:4px 8px;font-size:11px;background:rgba(0,0,0,0.55);color:#fff;z-index:2;';
            frame.append(frameLabel);
            if (style.html) {
              const iframe = document.createElement('iframe');
              iframe.setAttribute('sandbox', 'allow-scripts');
              iframe.style.cssText = 'width:400px;height:800px;border:0;transform:scale(0.5);transform-origin:top left;background:#fff;';
              iframe.srcdoc = style.html;
              frame.insertBefore(iframe, frameLabel);
            } else if (style._failed) {
              const failEl = document.createElement('div');
              failEl.textContent = 'No preview — pick by style';
              failEl.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-muted);';
              frame.append(failEl);
              style._spinner = failEl;
            } else {
              style._spinner = buildStylePlaceholder(style);
              frame.append(style._spinner);
            }
            frame.addEventListener('click', () => renderDetail(index));
            thumbs.append(frame);
            style._frame = frame;
          });
        }
      } else if (tab === 'compare') {
        renderCompare(content);
      }
    }

    // ---------- Compare tab ----------
    function renderCompare(container) {
      container.style.cssText += 'padding:16px 24px;';
      const instr = document.createElement('div');
      instr.style.cssText = 'font-size:13px;color:var(--text-muted);margin-bottom:12px;';
      instr.textContent = `Select two styles to compare side by side (${_compareSelected.size}/2 selected)`;
      container.append(instr);

      const pillRow = document.createElement('div');
      pillRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px;';
      styles.forEach((style, index) => {
        const pill = document.createElement('button');
        pill.type = 'button';
        const isSel = _compareSelected.has(index);
        pill.style.cssText = [
          'display:flex', 'align-items:center', 'gap:6px', 'padding:6px 12px',
          'border-radius:20px', 'cursor:pointer', 'font-size:13px', 'font-family:inherit',
          `border:2px solid ${isSel ? 'var(--accent,#7c3aed)' : 'var(--border)'}`,
          `background:${isSel ? 'rgba(124,58,237,0.1)' : 'none'}`,
          `color:${isSel ? 'var(--accent,#7c3aed)' : 'var(--text)'}`,
        ].join(';');
        const dot = document.createElement('span');
        dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${style.palette[0] || '#888'};flex:none;`;
        pill.append(dot, style.name);
        pill.addEventListener('click', () => {
          if (_compareSelected.has(index)) { _compareSelected.delete(index); }
          else {
            if (_compareSelected.size >= 2) { const [first] = _compareSelected; _compareSelected.delete(first); }
            _compareSelected.add(index);
          }
          renderGallery('compare');
        });
        pillRow.append(pill);
      });
      container.append(pillRow);

      if (_compareSelected.size === 2) {
        const [idxA, idxB] = [..._compareSelected];
        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:16px;';
        [styles[idxA], styles[idxB]].forEach((style) => {
          const col = document.createElement('div');
          col.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
          const nameEl = document.createElement('div');
          nameEl.style.cssText = 'font-size:13px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px;';
          nameEl.innerHTML = `<span style="width:10px;height:10px;border-radius:50%;background:${style.palette[0] || '#888'};display:inline-block;"></span>${style.name}`;
          const frame = document.createElement('div');
          frame.style.cssText = 'border:2px solid var(--border);border-radius:16px;overflow:hidden;position:relative;background:#111;aspect-ratio:9/16;min-height:240px;';
          if (style.html) {
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', 'allow-scripts');
            iframe.style.cssText = 'width:200%;height:200%;border:0;transform:scale(0.5);transform-origin:top left;';
            iframe.srcdoc = style.html;
            frame.append(iframe);
          } else { frame.append(buildStylePlaceholder(style)); }
          const chooseBtn = document.createElement('button');
          chooseBtn.type = 'button';
          chooseBtn.textContent = `✓ Choose ${style.name}`;
          chooseBtn.style.cssText = 'padding:8px;border:1px solid var(--accent,#7c3aed);border-radius:8px;background:none;color:var(--accent,#7c3aed);font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;';
          chooseBtn.addEventListener('click', () => {
            postChatMessage(`Going with "${style.name}". Generating app screens…`, 'ai');
            advanceStep('designs');
            finish(style);
          });
          col.append(nameEl, frame, chooseBtn);
          grid.append(col);
        });
        container.append(grid);
      } else {
        const hint = document.createElement('div');
        hint.style.cssText = 'color:var(--text-muted);font-size:13px;text-align:center;padding:32px;border:1px dashed var(--border);border-radius:12px;';
        hint.textContent = `Select ${2 - _compareSelected.size} more style${2 - _compareSelected.size === 1 ? '' : 's'} above to compare`;
        container.append(hint);
      }
    }

    // ---------- Detail view ----------
    // detailTab: 'preview' | 'code' | 'variations'
    function renderDetail(index, detailTab = 'preview') {
      _currentDetailIndex = index;
      const style = styles[index];
      let mode = 'mobile';
      panel.innerHTML = '';
      panel.style.cssText = 'display:flex;flex-direction:column;font-family:system-ui,-apple-system,sans-serif;color:var(--text);';

      // --- Top header: back + title + viewport + actions ---
      const headerRow = document.createElement('div');
      headerRow.style.cssText = [
        'display:flex', 'align-items:center', 'gap:8px',
        'padding:10px 16px', 'border-bottom:1px solid var(--border)', 'flex-shrink:0',
      ].join(';');
      const back = document.createElement('button');
      back.type = 'button'; back.textContent = '← All styles';
      back.style.cssText = 'border:none;background:none;color:var(--text-muted);font-size:13px;cursor:pointer;padding:0;white-space:nowrap;';
      back.addEventListener('click', () => renderGallery());
      const titleEl = document.createElement('div');
      titleEl.style.cssText = 'font-weight:700;font-size:14px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      titleEl.textContent = style.name;
      const mobileBtn = iconBtn('□ Mobile', 'Mobile view', () => { mode = 'mobile'; setVp(); refreshDetailPreview(); });
      const pcBtn    = iconBtn('▭ PC',     'Desktop view', () => { mode = 'pc';     setVp(); refreshDetailPreview(); });
      function setVp() {
        mobileBtn.style.background = mode === 'mobile' ? 'var(--accent,#7c3aed)' : 'none';
        mobileBtn.style.color      = mode === 'mobile' ? '#fff' : 'var(--text)';
        pcBtn.style.background     = mode === 'pc'     ? 'var(--accent,#7c3aed)' : 'none';
        pcBtn.style.color          = mode === 'pc'     ? '#fff' : 'var(--text)';
      }
      setVp();
      const favBtn = iconBtn(style.fav ? '♥' : '♡', 'Favorite / unfavorite', () => {
        style.fav = !style.fav; favBtn.textContent = style.fav ? '♥' : '♡';
      });
      const dlBtn = iconBtn('⬇', 'Download HTML', () => downloadHtml(style.name, style.html));
      headerRow.append(back, titleEl, mobileBtn, pcBtn, favBtn, dlBtn);
      panel.append(headerRow);

      // --- Description bar ---
      const descBar = document.createElement('div');
      descBar.style.cssText = 'padding:5px 16px;border-bottom:1px solid var(--border);font-size:11.5px;color:var(--text-muted);flex-shrink:0;line-height:1.4;';
      descBar.textContent = [style.vibe, style.typography, style.layout].filter(Boolean).join(' · ') || ' ';
      panel.append(descBar);

      // --- Quick-tweak toolbar (always visible; mirrors Variations tab but one-click) ---
      const toolbarRow = document.createElement('div');
      toolbarRow.style.cssText = [
        'display:flex', 'align-items:center', 'gap:4px',
        'padding:7px 16px', 'border-bottom:1px solid var(--border)',
        'background:var(--bg-card,var(--surface,#f9fafb))', 'flex-shrink:0', 'flex-wrap:wrap',
      ].join(';');

      // These are deferred until `tweak` is defined below — wire via closure.
      const _tweakBtns = [
        { label: '⟳', title: 'Generate similar styles',     fn: () => tweak('Produce a fresh alternative take on this same style direction — keep the vibe and palette, vary the layout and details.', false) },
        { label: 'B',  title: 'Bolder text',                 fn: () => tweak('Make the typography bolder and higher-contrast.') },
        { label: '☀', title: 'Warmer palette',               fn: () => tweak('Shift the palette warmer — more warm tones throughout.') },
        { label: '🌙', title: 'Dark mode',                   fn: () => tweak('Redesign with a dark background color scheme, keeping the same layout structure.') },
        { label: '–',  title: 'Simplify layout',             fn: () => tweak('Simplify the design: less clutter, more whitespace, fewer elements.') },
        { label: '✎',  title: 'Describe a custom direction', fn: () => {
          const note = window.prompt('Describe the change you want for this design:');
          if (note && note.trim()) tweak(note.trim());
        }},
      ];
      for (const tb of _tweakBtns) {
        const b = iconBtn(tb.label, tb.title, () => tb.fn());
        toolbarRow.append(b);
      }
      // Separator + choose button inline
      const sep = document.createElement('div');
      sep.style.cssText = 'flex:1;';
      const chooseMini = document.createElement('button');
      chooseMini.type = 'button'; chooseMini.textContent = '✓ Build with this';
      chooseMini.style.cssText = 'padding:5px 12px;border:none;border-radius:7px;background:var(--accent,#7c3aed);color:#fff;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;';
      chooseMini.addEventListener('click', () => {
        console.group('[build-style] style chosen (toolbar "Build with this")');
        console.log('[build-style] style:', style.name, '| has html mockup:', !!style.html);
        if (!style.html) {
          console.warn('[build-style] no style.html yet — click ignored (early return)');
          console.groupEnd();
          return;
        }
        logComposerRect('before-pick (toolbar)');
        postChatMessage(`Going with "${style.name}". Generating app screens…`, 'ai');
        console.log('[build-style] chat message posted');
        advanceStep('designs');
        console.log('[build-style] checklist advanced → designs done; calling finish()');
        console.groupEnd();
        finish(style);
      });
      function syncBuildBtns() {
        const ready = !!style.html;
        chooseMini.disabled = !ready;
        chooseMini.style.opacity = ready ? '1' : '0.45';
        chooseMini.style.cursor = ready ? 'pointer' : 'not-allowed';
        chooseMini.title = ready ? '' : 'Waiting for preview to generate…';
      }
      syncBuildBtns();
      // Expose a callback so renderMockups can enable buttons once the mockup arrives.
      style._onMockupReady = () => { syncBuildBtns(); if (_detailTab === 'preview') updateDetail(); };
      toolbarRow.append(sep, chooseMini);
      panel.append(toolbarRow);

      // --- Sub-tab bar: Preview | Code | Variations ---
      const subTabContainer = document.createElement('div');
      subTabContainer.style.cssText = [
        'display:flex', 'align-items:stretch', 'border-bottom:1px solid var(--border)',
        'padding:0 16px', 'background:var(--bg-card,var(--surface,#f9fafb))', 'flex-shrink:0',
      ].join(';');
      let _detailTab = detailTab;
      const { row: subTabRow, switchTab: switchDetailTabBtn } = buildTabBar([
        { id: 'preview',    label: 'Preview',    onSelect: () => { _detailTab = 'preview';    updateDetail(); } },
        { id: 'code',       label: 'Code',       onSelect: () => { _detailTab = 'code';       updateDetail(); } },
        { id: 'variations', label: 'Variations', onSelect: () => { _detailTab = 'variations'; updateDetail(); } },
      ], _detailTab);
      subTabContainer.append(subTabRow);
      panel.append(subTabContainer);

      // --- Status bar (shown during tweak generation) ---
      const statusBar = document.createElement('div');
      statusBar.style.cssText = 'padding:5px 16px;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-muted);display:none;flex-shrink:0;';
      panel.append(statusBar);

      // --- Main content area ---
      const detailContent = document.createElement('div');
      detailContent.style.cssText = 'flex:1;overflow:auto;display:flex;flex-direction:column;min-height:0;';
      panel.append(detailContent);

      async function tweak(instruction, useBase = true) {
        statusBar.style.display = 'block'; statusBar.textContent = 'Updating design…';
        _detailTab = 'preview'; switchDetailTabBtn('preview'); updateDetail();
        try {
          const html = await generateMockup({ prompt, summary, style, provider, apiKey, baseHtml: useBase ? style.html : null, instruction });
          if (html) { style.html = html; style._failed = false; }
        } catch { statusBar.textContent = "Couldn't update — try again."; }
        if (statusBar.textContent === 'Updating design…') statusBar.style.display = 'none';
        updateDetail();
      }

      function refreshDetailPreview() { if (_detailTab === 'preview') updateDetail(); }

      function updateDetail() {
        detailContent.innerHTML = '';
        if (_detailTab === 'preview') {
          const previewWrap = document.createElement('div');
          previewWrap.style.cssText = 'flex:1;overflow:auto;padding:16px;';
          renderPreview(previewWrap, style.html, mode);
          detailContent.append(previewWrap);
          // Choose CTA footer
          const footer = document.createElement('div');
          footer.style.cssText = 'padding:12px 16px;border-top:1px solid var(--border);flex-shrink:0;';
          const chooseBtn = document.createElement('button');
          chooseBtn.type = 'button';
          chooseBtn.textContent = '✓ Build with this style';
          const _chooseBtnReady = !!style.html;
          chooseBtn.disabled = !_chooseBtnReady;
          chooseBtn.title = _chooseBtnReady ? '' : 'Waiting for preview to generate…';
          chooseBtn.style.cssText = `width:100%;padding:10px 18px;border:none;border-radius:8px;background:var(--accent,#7c3aed);color:#fff;font-family:inherit;font-size:13px;font-weight:600;cursor:${_chooseBtnReady ? 'pointer' : 'not-allowed'};opacity:${_chooseBtnReady ? '1' : '0.45'};`;
          chooseBtn.addEventListener('click', () => {
            console.group('[build-style] style chosen (footer "Build with this style")');
            console.log('[build-style] style:', style.name, '| has html mockup:', !!style.html);
            if (!style.html) {
              console.warn('[build-style] no style.html yet — click ignored (early return)');
              console.groupEnd();
              return;
            }
            logComposerRect('before-pick (footer)');
            postChatMessage(`Going with "${style.name}". Generating app screens…`, 'ai');
            console.log('[build-style] chat message posted');
            advanceStep('designs');
            console.log('[build-style] checklist advanced → designs done; calling finish()');
            console.groupEnd();
            finish(style);
          });
          footer.append(chooseBtn);
          detailContent.append(footer);

        } else if (_detailTab === 'code') {
          const codeWrap = document.createElement('div');
          codeWrap.style.cssText = 'flex:1;overflow:auto;padding:16px;';
          if (style.html) {
            const toolbar = document.createElement('div');
            toolbar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';
            const codeLabel = document.createElement('div');
            codeLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-muted);';
            codeLabel.textContent = 'Generated HTML · ' + Math.round(style.html.length / 1024 * 10) / 10 + ' KB';
            const copyBtn = iconBtn('Copy', 'Copy HTML to clipboard', async () => {
              await navigator.clipboard.writeText(style.html).catch(() => {});
              copyBtn.textContent = '✓ Copied!';
              setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800);
            });
            const openBtn = iconBtn('Open ↗', 'Open in new tab', () => {
              const win = window.open('', '_blank');
              if (win) { win.document.write(style.html); win.document.close(); }
            });
            toolbar.append(codeLabel);
            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;gap:6px;';
            btnRow.append(copyBtn, openBtn);
            toolbar.append(btnRow);
            const pre = document.createElement('pre');
            pre.style.cssText = [
              'background:var(--bg-card,#f9fafb)', 'border:1px solid var(--border)',
              'border-radius:8px', 'padding:12px', 'font-size:11px',
              'font-family:Menlo,Monaco,Consolas,monospace', 'overflow:auto',
              'white-space:pre-wrap', 'word-break:break-all',
              'color:var(--text)', 'line-height:1.55', 'margin:0',
            ].join(';');
            pre.textContent = style.html;
            codeWrap.append(toolbar, pre);
          } else {
            codeWrap.innerHTML = `<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:40px;">Code will be available once the mockup finishes generating.</div>`;
          }
          detailContent.append(codeWrap);

        } else if (_detailTab === 'variations') {
          const varWrap = document.createElement('div');
          varWrap.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:8px;overflow-y:auto;';
          const varTitle = document.createElement('div');
          varTitle.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;';
          varTitle.textContent = 'Quick variations';
          varWrap.append(varTitle);

          const tweakDefs = [
            { icon: '⟳', label: 'Fresh take',     desc: 'Same style, completely different layout', fn: () => tweak('Produce a fresh alternative take on this same style direction — keep the vibe and palette, vary the layout and details.', false) },
            { icon: 'B', label: 'Bolder text',    desc: 'Higher-contrast typography throughout',    fn: () => tweak('Make the typography bolder and higher-contrast.') },
            { icon: '☀', label: 'Warmer palette', desc: 'Shift all colors toward warm tones',       fn: () => tweak('Shift the palette warmer — more warm tones throughout.') },
            { icon: '🌙', label: 'Dark mode',      desc: 'Invert to dark background scheme',         fn: () => tweak('Redesign with a dark background color scheme, keeping the same layout structure.') },
            { icon: '–', label: 'Simplify',       desc: 'Less clutter, more breathing room',        fn: () => tweak('Simplify the design: less clutter, more whitespace, fewer elements.') },
            { icon: '↑', label: 'More modern',    desc: 'Sharper, trendier, more contemporary',     fn: () => tweak('Make the design feel more modern and contemporary — sharper corners, cleaner lines.') },
          ];
          for (const tw of tweakDefs) {
            const card = document.createElement('button');
            card.type = 'button';
            card.style.cssText = [
              'display:flex', 'align-items:center', 'gap:12px',
              'padding:10px 14px', 'border:1px solid var(--border)', 'border-radius:8px',
              'background:none', 'text-align:left', 'cursor:pointer', 'color:var(--text)',
              'font-family:inherit', 'transition:background .12s',
            ].join(';');
            card.addEventListener('mouseenter', () => { card.style.background = 'rgba(99,102,241,0.06)'; });
            card.addEventListener('mouseleave', () => { card.style.background = ''; });
            const iconEl = document.createElement('div');
            iconEl.style.cssText = 'width:28px;height:28px;border-radius:6px;background:var(--bg-card,#f3f4f6);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:13px;flex:none;';
            iconEl.textContent = tw.icon;
            const textEl = document.createElement('div');
            textEl.style.cssText = 'flex:1;min-width:0;';
            textEl.innerHTML = `<div style="font-size:13px;font-weight:600;">${tw.label}</div><div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${tw.desc}</div>`;
            const arrow = document.createElement('span');
            arrow.style.cssText = 'font-size:12px;color:var(--text-muted);flex:none;';
            arrow.textContent = '→';
            card.append(iconEl, textEl, arrow);
            card.addEventListener('click', tw.fn);
            varWrap.append(card);
          }

          // Custom instruction input
          const customBox = document.createElement('div');
          customBox.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-top:4px;';
          const customLabel = document.createElement('div');
          customLabel.style.cssText = 'font-size:12px;font-weight:600;margin-bottom:6px;color:var(--text);';
          customLabel.textContent = '✎ Custom instruction';
          const customInput = document.createElement('textarea');
          customInput.placeholder = 'Describe the change you want…';
          customInput.rows = 2;
          customInput.style.cssText = [
            'width:100%', 'box-sizing:border-box', 'border:1px solid var(--border)',
            'border-radius:6px', 'padding:6px 8px', 'font-size:12px', 'font-family:inherit',
            'resize:none', 'background:var(--bg,#fff)', 'color:var(--text)', 'margin-bottom:6px',
          ].join(';');
          const applyBtn = document.createElement('button');
          applyBtn.type = 'button'; applyBtn.textContent = 'Apply →';
          applyBtn.style.cssText = 'padding:5px 14px;border:none;border-radius:6px;background:var(--accent,#7c3aed);color:#fff;font-size:12px;font-family:inherit;cursor:pointer;';
          applyBtn.addEventListener('click', () => { const note = customInput.value.trim(); if (note) tweak(note); });
          customBox.append(customLabel, customInput, applyBtn);
          varWrap.append(customBox);
          detailContent.append(varWrap);
        }
      }

      updateDetail();
    }

    // Generate mockups for the given style objects, refreshing whatever view is up.
    async function renderMockups(targets) {
      await Promise.all(targets.map(async (style) => {
        try { style.html = await generateMockup({ prompt, summary, style, provider, apiKey }); }
        catch { style.html = ''; style._failed = true; }
        // Refresh the gallery thumbnail if it's still mounted.
        if (style._spinner && style._spinner.parentElement && style.html) {
          const iframe = document.createElement('iframe');
          iframe.setAttribute('sandbox', 'allow-scripts');
          iframe.style.cssText = 'width:400px;height:800px;border:0;transform:scale(0.5);transform-origin:top left;background:#fff;';
          iframe.srcdoc = style.html;
          style._frame.insertBefore(iframe, style._frame.firstChild);
          style._spinner.remove();
        } else if (style._spinner && style._failed) {
          style._spinner.textContent = 'No preview — pick by style';
        }
        // If this style is currently open in detail view, enable the build buttons.
        if (style.html && styles.indexOf(style) === _currentDetailIndex) {
          style._onMockupReady?.();
        }
      }));
    }

    // Kick off: styles first, then mockups.
    (async () => {
      // Show "Briefing…" in the chat column while the model call runs.
      const briefingChatMsg = postChatMessage('Briefing the design agent…', 'status');

      let initial = [];
      let genError = null;
      try { initial = await generateStyles({ prompt, summary, provider, apiKey }); }
      catch (e) { genError = e; console.error('[build-style] generateStyles threw:', e); }
      briefingChatMsg?.remove();
      if (settled) return;
      if (genError) {
        // Generation FAILED (API / quota / network error) — don't let the design
        // picker silently vanish. Surface why, then continue the build without a
        // chosen style. Quota errors already pop the upgrade modal via agent.js.
        postChatMessage(
          (genError.quota || genError.needsSignin)
            ? (genError.message || 'Hit your LingModel limit while generating design styles.')
            : "Couldn't generate design styles — continuing the build without a chosen style.",
          'error',
        );
        finish(null);
        return;
      }
      if (!initial.length) {
        // Model returned no styles without erroring — treat as a non-visual build
        // (CLI / API / etc.). Note it so the missing picker isn't a mystery.
        postChatMessage('No design styles generated for this build — continuing directly.', 'status');
        finish(null);
        return;
      }
      for (const s of initial) styles.push(s);
      // Mount panel NOW — styles are ready so the preview column won't be blank.
      mountPanel();
      // Chat instruction: tell user to pick a style from the preview panel.
      // Stays in chat as part of the permanent transcript.
      postChatMessageDelayed(
        'Pick a style to continue — tap one of the design directions on the right.',
        'ai', 300,
      );
      renderGallery();
      renderMockups(styles.slice());
    })();
  });
}
