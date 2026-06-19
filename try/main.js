// main.js — UI wiring for /try. Stitches together provider key entry,
// folder picking, prompt input, and per-provider output panes.

// Cache-bust query strings on imports so a Safari user with a stale
// agent.js / demo.js cache picks up the new exports the moment main.js
// is bumped. Without this, only main.js gets re-fetched and imports of
// missing exports throw a silent ModuleError.
import { PROVIDERS, TOOLS, IMAGE_TOOLS, CLOUD_TOOLS, runAgent, estimateCostUSD, formatCost } from './agent.js?v=20260602d';
import { runSwarmPipeline, extractHtmlFromCodeBlock, SONA } from './swarm.js?v=20260602d';
import { hasWorkspace, currentFolderName, backendKind, execTool } from './fs.js?v=20260602d';
import { renderMarkdown } from './markdown.js?v=20260602d';
import { extractRunnable, openPreview, showEmptyPreview, readSharedHTML, refreshFromLatestTurn, maybeStreamUpdate, maybeStreamUpdateFiles, pickInitialFile as pickInitialFileFromPreview, ensureViewportMeta, withLinkInterceptor, inlineSiblingFiles, setPreviewBusyForErrors, resolveTryNavHref, previewNavLooksLikeSiteRoot, injectErrorReporter, publishPrototypeFrom, saveToGitHub, setChatHistorySnapshotProvider, setLiveThumbnailProvider } from './preview.js?v=20260607h';
import { renderTemplatesGrid as renderTemplatesGridForDashboard } from './main-templates.js?v=20260602d';
import { judgeRun } from './evaluator.js?v=20260602d';
import { loadRubric, renderRubricPanel, buildSingleScoreAddendum,
         buildWeightedSystemPrompt, applyWeights, runCodeJudge } from './rubric.js?v=20260602d';
import { t } from './i18n.js?v=20260602d';
import { buildCheckpointEntry, getSessionId, saveCheckpoint,
         openHistoryPanel, refreshHistoryPanel,
         loadCheckpoints, deleteCheckpoint }
  from './checkpoints.js?v=20260602d';
import {
  initSupabaseConfig,
  supabaseSystemAddendum,
  injectSupabaseGlobals,
  syncSupabaseBtn,
  openSupabaseDialog,
  getSupabaseConfig,
} from './main-supabase.js?v=20260602d';
import {
  knowledgeSystemAddendum,
  syncKnowledgeBtn,
  openKnowledgeDialog,
} from './main-knowledge.js?v=20260602d';
import {
  syncSecretsBtn,
  openSecretsDialog,
  setActivePrototypeId as setSecretsActivePrototypeId,
  getActivePrototypeId,
} from './main-secrets.js?v=20260602d';
import { track } from './main-analytics.js?v=20260602d';
import { openFigmaDialog } from './main-figma.js?v=20260602d';
import {
  syncSiteConfigBtn,
  openSiteConfigDialog,
  seoSystemAddendum,
  siteConfigSystemAddendum,
} from './main-site-config.js?v=20260602d';
import { syncDomainsBtn, openDomainsDialog } from './main-domains.js?v=20260602d';
import {
  injectInlineEditScript,
  applyInlineEdits,
  inlineEditsSystemAddendum,
  enableCollabInlineEdits,
  writeCollabInlineEdit,
} from './main-inline-edit.js?v=20260602d';
import { mountVisualEdits, toggleVisualEdits } from './main-visual-edits.js?v=20260602d';
import { enableCollabKnowledge } from './main-knowledge.js?v=20260602d';
import {
  initCollab,
  getYDoc,
  getAwareness,
  getMyRole,
  isEditor,
} from './collab.js?v=20260602d';
import { initPresence, mountPresenceOverlay, mountCursorOverlay, updateCursorSelector, repositionCursors } from './collab-presence.js?v=20260602d';
import { initComments, repositionComments } from './collab-comments.js?v=20260602d';
import { openHistoryPanel as openCollabHistoryPanel } from './collab-history.js?v=20260602d';
import { pushToGitHub } from './main-github-push.js?v=20260602d';
import { deployToNetlify, deployToVercel, deployToLingCodeCloud, saveProjectSnapshot } from './main-deploy.js?v=20260612a';
import { mountDemoMode } from './main-demo-mode.js?v=20260602d';
import {
  selected, keyInputs, toggles,
  getLingmodelReady,
  saveSelection,
  mountProviders,
} from './main-providers.js?v=20260602d';
import { getNavAuthSignedIn } from './main-auth.js?v=20260602d';
import {
  renderWorkspaceState, openAdvanced, mountWorkspace,
} from './main-workspace.js?v=20260602d';
import { mountCards } from './main-cards.js?v=20260602d';
// Side-effect-only: listens for `lingmodel:upgrade-required` window events
// (dispatched from agent.js on 402+upgrade_required) and shows a paywall modal.
import './main-upgrade-modal.js?v=20260602d';
import {
  looksLikeDeck, looksLikeShopify, looksLikeLiquidTheme,
  deckAddendum, shopifyLiquidAddendum, shopifyPolarisAddendum,
  docModeAddendum, attachmentsAddendum, buildFollowupAttachmentsAddendum,
  stackSystemAddendum, polishSystemAddendum,
} from './main-prompt-addendums.js?v=20260602d';
import {
  mountSend, swarmToggle, swarmStageBar, getSwarmBuildMode,
  updateSwarmStageBar, updatePaneSwarmStage,
  showHint, flagMissingKeys, providerHasCredentials,
  _demoScenarioProviders,
} from './main-send.js?v=20260602d';
import { mountEntitlement, bumpEntitlement } from './main-entitlement.js?v=20260602d';
import { runDirectionGate } from './main-direction.js?v=20260602d';
import { mountChecklist, setStep, advanceStep, resetChecklist, failChecklist, completeChecklist } from './main-build-checklist.js?v=20260607a';
import { postChatMessage as postVisibleChatMessage, clearChatHistory as clearVisibleChatHistory } from './main-chat.js?v=20260602d';
import { findUnfinishedSession, showResumeBanner } from './main-resume.js?v=20260602d';
let _firstFollowupDone = false; // set true after first manual follow-up fires
import { injectBackendGlobals, backendSystemAddendum, cloudProvisionAddendum, openCloudConsole, mountCloudConsole, syncCloudBtn, cloudToolsActive, execCloudTool, setEnsurePrototypeId, CLOUD_TOOL_NAMES } from './main-cloud.js?v=20260611b';
import {
  attachedImages, attachedDocs, attachedAssets,
  clearAttachedImages, clearAttachedDocs,
  addFollowupFiles, renderFollowupThumbs,
  mountAttachments,
} from './main-attachments.js?v=20260602d';
import {
  openCheckpointNameDialog, applyCheckpointRestore, mountCheckpointDialog,
} from './main-checkpoint-dialog.js?v=20260602d';
import { openProjectsPanel, mountProjectsPanel } from './main-projects-panel.js?v=20260602d';
import { confirmPublishWithLeakScan } from './main-leak-scan.js?v=20260602d';
import { runDbSidecar, mountDbSidecar } from './main-db-sidecar.js?v=20260602d';
import { attachMonacoToggle, refreshMonacoPane } from './main-monaco.js?v=20260602d';
import { randomWaitingLine, nextDistinctWaitingLine, ROTATION_MS as SPINNER_ROTATION_MS, FADE_MS as SPINNER_FADE_MS } from './spinner-verbs.js?v=20260602d';
import { mountRouter } from './main-router.js?v=20260612a';
import { mountChips } from './main-chips.js?v=20260602d';

// Build provider key rows + wire toggles. Done early so checkEntitlement,
// updateSendState, runOneProvider all see populated keyInputs/toggles.
// updateSendState is a function declaration so its name is hoisted; the
// reference here resolves to the implementation defined further down.
mountProviders({ updateSendState });

// History compression: drop oldest turns when serialized history exceeds this character count.
// ~200k chars ≈ 50k tokens — safe for 64k+ context models.
const CONTEXT_CHAR_BUDGET = 200_000;

// Inline preview scaling helpers (mobile mini-preview via CSS zoom).
// Injected into every inline pane srcdoc so the parent can auto-size the iframe.
const INLINE_RENDER_W = 960;
const INLINE_HEIGHT_SCRIPT = `<script>(function(){
  function r(){
    if(window.parent===window)return;
    var d=document.documentElement;
    var b=document.body;
    var bw=b?Math.max(b.scrollWidth,b.clientWidth,0):0;
    var bh=b?Math.max(b.scrollHeight,b.offsetHeight||0,b.clientHeight||0,0):0;
    var w=Math.max(d.scrollWidth,d.clientWidth,bw);
    var h=Math.max(d.scrollHeight,d.clientHeight,bh);
    var vw=window.innerWidth||0,vh=window.innerHeight||0;
    // Viewport-filling app (3D game, full-screen 100vh layout): a big <canvas>
    // or fixed full-bleed element covering most of the viewport, or a body
    // sized to the viewport that doesn't scroll. These report ~0 scrollHeight,
    // so without this flag the parent collapses the iframe to the 200px floor
    // (a blank strip). When set, the parent lets the iframe fill the pane.
    var fill=false;
    try{
      // ANY <canvas> → a game/visualization that wants the viewport. Three.js &
      // friends create the canvas via JS (usually position:absolute), so it
      // never grows documentElement — presence, not size, is the reliable tell.
      if(document.querySelector('canvas'))fill=true;
      if(!fill){
        var fe=document.querySelectorAll('[style*="100vh"],[style*="fixed"]');
        for(var i=0;i<fe.length;i++){var fr=fe[i].getBoundingClientRect();if(fr.width>=vw*0.6&&fr.height>=vh*0.6){fill=true;break;}}
      }
      if(!fill&&b&&vh){var bch=parseFloat(getComputedStyle(b).height)||0;if(bch>=vh*0.9&&h<=vh+8)fill=true;}
    }catch(e){}
    window.parent.postMessage({type:'__lc_ifrh',h:Math.max(200,Math.round(h)),w:Math.max(1,Math.round(w)),fill:fill},'*');
  }
  window.addEventListener('load',r);
  window.addEventListener('resize',r);
  if(typeof ResizeObserver!=='undefined'){
    new ResizeObserver(r).observe(document.documentElement);
    if(document.body)new ResizeObserver(r).observe(document.body);
  }
  // JS-built apps (Three.js, etc.) create their canvas after load — re-measure
  // a few times so the viewport-fill flag flips once the canvas appears.
  setTimeout(r,600);setTimeout(r,1800);setTimeout(r,4000);
}());<\/script>`;
function injectInlineHeightScript(html) {
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, INLINE_HEIGHT_SCRIPT + '</body>');
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, INLINE_HEIGHT_SCRIPT + '</html>');
  return html + INLINE_HEIGHT_SCRIPT;
}

// Demo mode: /try.html?demo=1 (optionally &task=<scenario-id>) replays a
// cached benchmark instead of hitting real APIs. Used for the homepage
// auto-demo iframe and for marketing-video screen capture. Anonymous
// visitors can see a live-looking race without LingModel auth or BYO keys.
const DEMO_PARAMS = new URLSearchParams(location.search);
const DEMO_MODE = DEMO_PARAMS.has('demo');
const DEMO_TASK = DEMO_PARAMS.get('task');
// Embed mode = strip the page chrome to just panes for 9:16 video capture.
// Slowmo multiplies the scripted-run timings so the video can stretch to a
// target length (e.g. ?slowmo=5 turns a ~10s race into ~50s).
const EMBED_MODE = DEMO_PARAMS.has('embed');
const SLOWMO = Math.max(1, parseFloat(DEMO_PARAMS.get('slowmo') || '1') || 1);
if (EMBED_MODE) document.body.classList.add('embed');

// Pane registry, hoisted because updateSendState() (declared early) reads
// it via anyPaneBusy() to disable Run while a follow-up is mid-flight.
const paneByProvider = new Map();

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'lingcode-nav') return;
    const pane = [...paneByProvider.values()].find(
      (p) => p.previewIframe && p.previewIframe.contentWindow === e.source
    );
    if (!pane) return;
    const hrefRaw = String(d.href || '');
    if (pane._files && pane._files.size > 0) {
      const target = resolveTryNavHref(hrefRaw, pane._files);
      if (target) {
        pane._activeFile = target;
        pane._previewLastSrc = '';
        updateInlinePreview(pane, /* force */ true);
      }
      return;
    }
    if (previewNavLooksLikeSiteRoot(hrefRaw)) {
      try { e.source.scrollTo({ top: 0, left: 0 }); } catch { /* ignore */ }
    }
  });

  // Inline preview error detection — mirrors the modal's showPreviewErrorBanner flow
  // but targets the per-pane inline iframe. Suppressed while the pane is streaming
  // (partial HTML throws expected errors during generation).
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.kind !== 'lingcode-error') return;
    const pane = [...paneByProvider.values()].find(
      (p) => p.previewIframe && p.previewIframe.contentWindow === e.source
    );
    if (!pane || pane.busy) return;
    showInlinePreviewError(pane, d);
  });

  // Inline edits posted from the click-to-edit overlay inside preview iframes.
  // Records the edit on the pane so it survives the next AI regeneration (via
  // applyInlineEdits) and gets sent in the next system prompt (via
  // inlineEditsSystemAddendum), telling the AI to preserve the user's text.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'lc-inline-edit') return;
    const pane = [...paneByProvider.values()].find(
      (p) => p.previewIframe && p.previewIframe.contentWindow === e.source,
    );
    if (!pane) return;
    if (!pane._inlineEdits) pane._inlineEdits = [];
    // De-dupe: if an edit on the same selector already exists, replace it
    // with the latest newText so we don't accumulate stale entries.
    const sel = d.fingerprint?.selector;
    pane._inlineEdits = pane._inlineEdits.filter((x) => x.fingerprint?.selector !== sel);
    pane._inlineEdits.push({
      fingerprint: d.fingerprint,
      oldText: String(d.oldText || ''),
      newText: String(d.newText || ''),
      ts: d.ts || Date.now(),
    });
    // Cap at 50 to keep prompt size bounded.
    if (pane._inlineEdits.length > 50) pane._inlineEdits = pane._inlineEdits.slice(-50);
    // Mirror to collab Y.Map so other collaborators see this edit in real time.
    writeCollabInlineEdit(d.fingerprint, String(d.newText || ''), String(d.oldText || ''), _collabCurrentUser?.id);
  });

  // Collab cursor + scroll forwarding from the iframe inline-edit script.
  // These do nothing when collab isn't active (initPresence/initComments
  // never ran) — the calls are cheap no-ops.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'lc-cursor-hover') {
      updateCursorSelector(d.selector || null);
    } else if (d.type === 'lc-iframe-scroll') {
      // Reposition comment dots + remote cursor overlays on the pane whose
      // iframe sent the event.
      const pane = [...paneByProvider.values()].find(
        (p) => p.previewIframe && p.previewIframe.contentWindow === e.source,
      );
      if (pane?.previewIframe) {
        repositionComments(pane.previewIframe);
        repositionCursors();
      }
    }
  });
}

function showPublishToast(url, id) {
  // Whole-toast contrast pass. Old toast had: URL in `--text-muted` (dim gray
  // on dark bg → unreadable), Copy URL as purple text on a 10%-alpha green
  // tint (looked like a label, not a button), Make-private as a bare bordered
  // line with `--text-muted` (also looked unclickable). New toast: bright URL,
  // a solid-fill Copy URL primary button, a clearer ghost button for the
  // visibility toggle, and a small × close so the user can dismiss it instead
  // of waiting 12s for the timer.
  const n = document.createElement('div');
  n.style.cssText =
    'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);' +
    'background:var(--bg-elevated,#1c1c1c);border:1px solid rgba(255,255,255,0.12);' +
    'border-radius:12px;padding:16px 18px 14px;font-size:0.85rem;' +
    'color:#fff;box-shadow:0 8px 28px rgba(0,0,0,.45);' +
    'z-index:9999;display:flex;flex-direction:column;gap:10px;' +
    'max-width:400px;min-width:280px;';
  // Header row: ✓ Published + small × close on the right.
  n.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
      '<div style="color:var(--signal);font-weight:600;font-size:0.9rem;">✓ Published</div>' +
      '<button class="toast-close" aria-label="Close" style="background:transparent;border:none;color:rgba(255,255,255,0.55);cursor:pointer;font-size:1.1rem;line-height:1;padding:0 2px;">×</button>' +
    '</div>' +
    // URL: white-ish for readability on dark bg, monospaced so it parses as a URL.
    `<div style="color:rgba(255,255,255,0.85);font-size:0.78rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;line-height:1.4;">${url}</div>` +
    // Copy URL: SOLID signal-color fill with white text — unambiguously a button.
    '<button class="toast-copy" style="margin-top:2px;display:block;width:100%;background:var(--signal);border:none;color:#fff;padding:9px 12px;border-radius:8px;cursor:pointer;font-size:0.85rem;font-weight:500;font-family:inherit;transition:filter 0.15s ease;">Copy URL</button>';
  if (id) {
    const vis = document.createElement('button');
    // Ghost button: brighter text + visible border + filled background hover.
    vis.style.cssText =
      'display:block;width:100%;background:rgba(255,255,255,0.04);' +
      'border:1px solid rgba(255,255,255,0.18);color:#fff;' +
      'padding:8px 12px;border-radius:8px;cursor:pointer;' +
      'font-size:0.8rem;font-family:inherit;text-align:left;' +
      'transition:background 0.15s ease, border-color 0.15s ease;';
    vis.addEventListener('mouseenter', () => { vis.style.background = 'rgba(255,255,255,0.08)'; });
    vis.addEventListener('mouseleave', () => { vis.style.background = 'rgba(255,255,255,0.04)'; });
    let isPublic = true;
    const render = () => { vis.textContent = isPublic ? '🌐 Public · Make private' : '🔒 Private · Make public'; };
    render();
    vis.addEventListener('click', async () => {
      isPublic = !isPublic;
      render();
      vis.disabled = true;
      try {
        await fetch(`/api/account/saved-prototypes/${id}/visibility`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_public: isPublic ? 1 : 0 }),
          credentials: 'include',
        });
      } catch { /* silent fail */ }
      vis.disabled = false;
    });
    n.appendChild(vis);
  }
  const btn = n.querySelector('.toast-copy');
  btn.addEventListener('mouseenter', () => { btn.style.filter = 'brightness(1.1)'; });
  btn.addEventListener('mouseleave', () => { btn.style.filter = ''; });
  btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(url).catch(() => {});
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = 'Copy URL'; }, 1500);
  });
  // Manual dismiss + auto-clear timer. Clear the timer on manual close so we
  // don't double-remove (harmless but tidy).
  const autoTimer = setTimeout(() => { try { n.remove(); } catch (_) {} }, 12000);
  const closeBtn = n.querySelector('.toast-close');
  closeBtn.addEventListener('click', () => {
    clearTimeout(autoTimer);
    try { n.remove(); } catch (_) {}
  });
  document.body.append(n);
}

function showInlinePreviewError(pane, errData) {
  // Disabled — the "Fix with AI" pink banner overlapping the prompt area was
  // confusing users. We still record the last error on the pane in case
  // something else wants to read it, but no UI is shown.
  if (!pane) return;
  pane._lastInlineError = errData || null;
}

function hideInlinePreviewError(pane) {
  if (!pane?.previewErrorBanner) return;
  pane.previewErrorBanner.hidden = true;
  pane._lastInlineError = null;
}

// ---- Hero lede — short tagline under the H1 (Lovable-style hero). ----
// Source string from i18n so en/zh diverge cleanly. No-op on legacy markup
// without #hero-lede.
{
  const ledeEl = document.getElementById('hero-lede');
  if (ledeEl) ledeEl.textContent = t('hero.lede');
  // Localize the static "More options" label in markup too (en falls back
  // to the markup default; zh switches to 更多选项).
  const advLabel = document.getElementById('advanced-label');
  if (advLabel) advLabel.textContent = t('advanced.label');
}

// Provider UI + workspace UI both extracted. mountProviders() runs at the
// top (after imports). mountWorkspace() runs further down — needs promptEl.

// ---- Example prompt chips ----
// Two rows: "build something" (produces previewable HTML) on top,
// then the lighter Q&A examples. Click → fill the prompt + focus.
const promptEl = document.getElementById('prompt');
const promptRow = document.querySelector('.try-prompt-row');

// Wire workspace UI now that promptEl exists (auto-action chips fill it).
mountWorkspace({ promptEl });

// Wire attach/figma/mic prompt-row buttons + the thumbnail strip.
mountAttachments({ promptEl, promptRow, openFigmaDialog, updateSendState });

// Wire checkpoint-name popover + restore handler. The 8 deps below all
// live in main.js's pane-management cluster (tier 0c) — once that splits
// they collapse into a single paneApi object passed here.
mountCheckpointDialog({
  paneByProvider, ensurePane, clearPanes, addCopyButtons,
  updateInlinePreview, syncTabbedTranscriptChrome,
  syncAllPaneFollowupRows, syncTrySessionChrome,
  renderInlineFileTabs, updateInlineFileCountBadge,
});

// Mount 8-step build checklist sidebar + progress bar.
mountChecklist();

// Wire projects-panel save/load/delete UI. Same tier-0c deps.
mountProjectsPanel({
  paneByProvider, ensurePane, clearPanes, addCopyButtons,
  updateInlinePreview, syncTabbedTranscriptChrome, syncTrySessionChrome,
});
// Pre-fill prompt from ?prompt= URL parameter (e.g. from marketing links)
const urlPrompt = DEMO_PARAMS.get('prompt');
if (urlPrompt && !DEMO_MODE) {
  promptEl.value = decodeURIComponent(urlPrompt);
  promptEl.dispatchEvent(new Event('input', { bubbles: true }));
}

// Attachments + prompt-row accessory buttons moved to main-attachments.js.
// Typewriter placeholder — cycles through inviting deliverable-focused
// examples while the textarea is empty + unfocused. Runs until the user
// either focuses or types; resumes when blurred + still empty. Token-
// based cancellation lets a single timer thread bow out cleanly when a
// new run starts.
(function startTypewriterPlaceholder() {
  const list = (typeof t === 'function' ? t('prompt.placeholders') : null);
  if (!Array.isArray(list) || list.length === 0) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // State is hoisted out of loop() so focus/blur/composer-mode restarts
  // resume from where the animation paused instead of jumping back to
  // phrase 0 char 1. Token-based cancellation guards against two loops
  // racing each other into the same placeholder slot.
  let token = 0;
  let phraseIdx = 0;
  let pos = 0;
  let phase = 'type'; // 'type' | 'hold' | 'erase' | 'gap'

  function isIdle() {
    return (
      !promptEl.value &&
      document.activeElement !== promptEl &&
      !document.body.classList.contains('try-single-main-composer')
    );
  }
  async function loop() {
    const my = ++token;
    while (token === my) {
      const target = list[phraseIdx % list.length];
      if (phase === 'type') {
        while (pos < target.length) {
          if (token !== my || !isIdle()) return;
          pos++;
          promptEl.placeholder = target.slice(0, pos);
          await sleep(40);
          if (token !== my) return;
        }
        phase = 'hold';
      } else if (phase === 'hold') {
        await sleep(1800);
        if (token !== my || !isIdle()) return;
        phase = 'erase';
      } else if (phase === 'erase') {
        while (pos > 0) {
          if (token !== my || !isIdle()) return;
          pos--;
          promptEl.placeholder = target.slice(0, pos);
          await sleep(22);
          if (token !== my) return;
        }
        phase = 'gap';
      } else {
        await sleep(220);
        if (token !== my || !isIdle()) return;
        phraseIdx++;
        pos = 0;
        phase = 'type';
      }
    }
  }
  function start() { token++; if (isIdle()) loop(); }
  function stop() { token++; }
  promptEl.addEventListener('focus', stop);
  promptEl.addEventListener('input', () => { if (promptEl.value) stop(); });
  promptEl.addEventListener('blur', () => { if (!promptEl.value) start(); });
  window.__lcRestartPromptPlaceholder = start;
  start();
})();

// Stack selector was a visible chip row (Plain HTML / + Tailwind / + React);
// removed once doc-mode + chip prompts covered the same territory. Kept as
// a const so stackSystemAddendum still has a value to switch on if a future
// build re-introduces the chips.
const currentStack = 'plain';

mountCards({ promptEl, promptRow });

// Prompt-addendum builders moved to main-prompt-addendums.js.

// ---- Send button state ----
const sendBtn = document.getElementById('send');

// Build swarm toggle / stage bar / providerHasCredentials & friends.
mountSend({ DEMO_MODE });

function anyPaneBusy() {
  for (const [, pane] of paneByProvider) if (pane.busy) return true;
  return false;
}

function refreshMainSendButtonLabel() {
  if (!sendBtn || sendBtn.classList.contains('send-btn-loading')) return;
  sendBtn.textContent =
    paneByProvider.size > 0 ? t('prompt.continue_run') : t('prompt.run');
}

/** Tabbed + at most one runnable provider: prefer one composer affordance (in-pane vs shell). */
function useSingleMainComposer() {
  if (!isWorkspaceTabbedUi()) return false;
  const runnable = [...selected].filter((id) => providerHasCredentials(id));
  return runnable.length <= 1;
}

/** Solo tabbed: once any pane has turns, follow-up textarea lives below the transcript (duplicate shell prompt hides). */
function syncSoloPaneComposerMode() {
  const solo = document.body.classList.contains('try-single-main-composer');
  const inPane =
    solo &&
    paneByProvider.size > 0 &&
    [...paneByProvider.values()].some((p) => p.turns?.length > 0);
  document.body.classList.toggle('try-solo-pane-composer', inPane);
}

function syncPaneFollowupRowVisibility(pane) {
  if (!pane?.followup) return;
  const hasTurns = !!(pane.turns && pane.turns.length > 0);
  if (!hasTurns) {
    pane.followup.style.display = 'none';
    return;
  }
  pane.followup.style.display = 'flex';
}

function syncAllPaneFollowupRows() {
  for (const [, p] of paneByProvider) syncPaneFollowupRowVisibility(p);
  syncSoloPaneComposerMode();
}

/** Bottom-only composer: tweak placeholder while session active; rotating examples paused via CSS class. */
function syncMainPromptComposerChrome() {
  const hadSolo = document.body.classList.contains('try-single-main-composer');
  const solo = paneByProvider.size > 0 && useSingleMainComposer();
  document.body.classList.toggle('try-single-main-composer', solo);
  if (solo && !promptEl.value && document.activeElement !== promptEl) {
    promptEl.placeholder = t('prompt.tweak_placeholder');
  }
  if (hadSolo && !solo && !promptEl.value && document.activeElement !== promptEl) {
    typeof window.__lcRestartPromptPlaceholder === 'function' && window.__lcRestartPromptPlaceholder();
  }
  syncSoloPaneComposerMode();
}

function triggerTruncationContinue(pane) {
  const msg =
    'Continue exactly where you stopped — pick up the next character of the previous output, do not repeat anything you already wrote, do not add any preamble like "continuing" or "here is the rest". Just emit the next tokens.';
  track('continue_truncation_clicked');
  if (useSingleMainComposer()) {
    promptEl.value = msg;
    promptEl.dispatchEvent(new Event('input', { bubbles: true }));
    refreshMainSendButtonLabel();
    sendBtn.click();
  } else if (pane?.followupInput && pane?.followupBtn) {
    pane.followupInput.value = msg;
    pane.followupInput.dispatchEvent(new Event('input', { bubbles: true }));
    pane.followupBtn.click();
  }
}

function updateSendState() {
  const anySelected = selected.size > 0;
  const runnable  = [...selected].filter((id) =>  providerHasCredentials(id));
  const skipping  = [...selected].filter((id) => !providerHasCredentials(id));
  const hasPrompt = promptEl.value.trim().length > 0;
  const paneBusy  = anyPaneBusy();
  // Run is enabled as long as AT LEAST ONE selected provider has credentials.
  // Keyless ones get skipped at click-time with a soft hint, instead of
  // disabling the whole button.
  sendBtn.disabled = !(anySelected && runnable.length > 0 && hasPrompt) || paneBusy;

  let why = '';
  if (!paneBusy) {
    if (!anySelected) why = t('hint.no_provider');
    else if (runnable.length === 0) {
      const names = skipping.map((id) => {
        const p = PROVIDERS.find((x) => x.id === id);
        if (p?.proxied) return t('hint.lingmodel_signin');
        return p?.name || id;
      });
      why = t('hint.no_runnable', names);
    }
    // No-prompt case: the empty input itself is the signal; suppress the
    // redundant "Type a prompt above…" hint.
  }
  // (Disclosure auto-open lives in checkEntitlement() — driven by the
  // resolved entitlement state, not by every keystroke through here.)

  // Soft "will skip" hint shows even when the Run button is enabled, so the
  // user knows their keyless providers will sit out.
  let softHint = '';
  if (skipping.length && runnable.length > 0 && hasPrompt) {
    const names = skipping.map((id) => {
      const p = PROVIDERS.find((x) => x.id === id);
      if (p?.proxied) return t('hint.lingmodel_signin');
      return p?.name || id;
    });
    softHint = t('hint.skipping_keys', names);
  }

  sendBtn.title = paneBusy ? t('hint.pane_busy') : (why || softHint);
  // While a pane is generating, the button already shows Running; skip the
  // yellow under-composer line (title still explains on hover).
  showHint(paneBusy ? '' : sendBtn.disabled ? why : softHint);
  flagMissingKeys(skipping);
  refreshMainSendButtonLabel();
  syncAllPaneFollowupRows();
  syncMainPromptComposerChrome();
}
promptEl.addEventListener('input', updateSendState);
promptEl.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!sendBtn.disabled) sendBtn.click();
  }
});
updateSendState();

// One-shot guard so the disclosure auto-opens at most once per page load.
// Without this, every post-run entitlement refresh would re-pop the
// disclosure even after the user explicitly closed it. Now nudges via a
// dismissible banner instead of force-expanding the providers section so the
// user isn't jarred out of their workflow mid-build.
let _autoOpenedAdvancedOnce = false;
function maybeAutoOpenAdvanced(reason) {
  if (_autoOpenedAdvancedOnce) return;
  // Anyone working? If at least one selected provider has usable creds,
  // there's no reason to draw attention to the config.
  for (const id of selected) {
    const p = PROVIDERS.find((x) => x.id === id);
    if (!p) continue;
    if (p.proxied && getLingmodelReady()) return;
    if (!p.proxied && (keyInputs.get(id)?.value || '').trim()) return;
  }
  _autoOpenedAdvancedOnce = true;
  showProvidersNudge(reason);
}

// Persistent bottom-right banner that explains WHY LingModel can't be used
// right now and links to the providers section. Clicking the CTA opens the
// section and scrolls it into view; the × dismisses without acting.
function showProvidersNudge(reason) {
  let banner = document.getElementById('providers-nudge');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'providers-nudge';
    banner.className = 'providers-nudge';
    banner.setAttribute('role', 'status');
    document.body.appendChild(banner);
  }
  banner.innerHTML = '';
  const msg = document.createElement('span');
  msg.className = 'providers-nudge-msg';
  msg.textContent = reason || 'LingModel isn\'t available right now. Add a provider key to keep building.';
  const cta = document.createElement('button');
  cta.type = 'button';
  cta.className = 'providers-nudge-cta';
  cta.textContent = 'Add a key →';
  cta.addEventListener('click', () => {
    // In session mode the disclosure is hidden by CSS; flip the body class
    // so the user can actually see the section we're about to expand.
    document.body.classList.add('providers-revealed');
    openAdvanced(true);
    const target = document.getElementById('advanced-disclosure') || document.getElementById('providers-summary');
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    banner.remove();
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'providers-nudge-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => banner.remove());
  banner.append(msg, cta, close);
  banner.hidden = false;
}

mountEntitlement({ updateSendState, maybeAutoOpenAdvanced });

// Visual-edit side panel: routes the panel's AI chat into the active pane's
// runFollowup with element-scoped context, so the model knows what to change.
mountVisualEdits({
  onAiChat: (prompt, fingerprint, tag) => {
    const pane = activeProviderId ? paneByProvider.get(activeProviderId) : null;
    if (!pane || typeof pane.runFollowup !== 'function') return;
    const sel = fingerprint?.selector || '';
    const prefix = sel
      ? `For the selected <${tag || 'element'}> at "${sel}": `
      : `For the selected <${tag || 'element'}>: `;
    pane.runFollowup(prefix + prompt, { source: 'visual_edits' });
  },
});

// ---- Per-pane management ----
// (paneByProvider hoisted to top-of-file so updateSendState() can read it.)
const panesEl = document.getElementById('panes');
mountDbSidecar({ panesEl });
const workspaceEl = document.getElementById('workspace');
const canvasBodyEl    = document.getElementById('try-canvas-body');
const progressBarEl   = document.getElementById('try-progress-bar');
const workspaceBuilderHintEl = document.getElementById('workspace-builder-hint');
const workspaceTabsEl = document.getElementById('workspace-tabs');
const workspaceModeBtn = document.getElementById('workspace-mode-toggle');

const TRY_TABBED_NARROW_MQ =
  typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 900px)')
    : { matches: false, addEventListener: () => {}, addListener: () => {} };
const tabbedMobileDockEl = document.getElementById('try-tabbed-mobile-dock');
const tabbedMobileBackdropEl = document.getElementById('try-mobile-chat-backdrop');
const tabbedMobileChatToggleEl = document.getElementById('try-mobile-chat-toggle');
const tabbedMobileStreamPillEl = document.getElementById('try-mobile-stream-pill');

/** Narrow tabbed: full-preview + bottom dock (mirror Lovable small viewports). */
function updateTryTabbedMobileGeom() {
  const root = document.documentElement.style;
  root.removeProperty('--try-mobile-bottom-gap');
  root.removeProperty('--try-mobile-sheet-bottom');
  root.removeProperty('--try-tabbed-sheet-top');
  root.removeProperty('--try-mobile-cost-slot');
  root.removeProperty('--try-mobile-followup-slot');
  if (!document.body.classList.contains('try-tabbed-narrow-ui') || !workspaceEl) return;
  let topPx = workspaceEl.getBoundingClientRect().top;
  const tabbarEl = workspaceEl.querySelector('.try-workspace-tabbar');
  if (tabbarEl) topPx += tabbarEl.getBoundingClientRect().height + 2;
  document.documentElement.style.setProperty('--try-tabbed-sheet-top', `${Math.max(6, Math.round(topPx))}px`);

  const innerH = window.innerHeight || 720;
  const pr = promptRow;
  let composerTop = innerH - 96;
  if (pr) {
    const cs = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(pr) : null;
    const visiblyPlaced =
      cs &&
      cs.display !== 'none' &&
      cs.visibility !== 'hidden' &&
      (pr.offsetHeight || pr.getBoundingClientRect().height) > 12;
    if (visiblyPlaced) {
      const r = pr.getBoundingClientRect();
      if (r.height > 12) composerTop = r.top;
    }
  }
  const bottomGap = Math.max(24, Math.round(innerH - composerTop + 12));
  document.documentElement.style.setProperty('--try-mobile-bottom-gap', `${bottomGap}px`);

  requestAnimationFrame(() => {
    if (!document.body.classList.contains('try-tabbed-narrow-ui')) return;
    const dockH =
      tabbedMobileDockEl && !tabbedMobileDockEl.hidden
        ? Math.round(tabbedMobileDockEl.getBoundingClientRect().height || 92)
        : 92;
    document.documentElement.style.setProperty('--try-mobile-sheet-bottom', `${bottomGap + dockH + 12}px`);

    const meta = activeProviderId ? tabByProvider.get(activeProviderId) : null;
    const pane = meta?.pane;
    let followSlot = 0;
    let costSlot = 48;
    if (pane) {
      if (pane.followup && pane.followup.style.display !== 'none')
        followSlot = Math.max(48, Math.round(pane.followup.offsetHeight || 0));
      if (pane.cost) costSlot = Math.max(32, Math.round(pane.cost.offsetHeight || 0)) || 48;
    }
    document.documentElement.style.setProperty('--try-mobile-followup-slot', `${followSlot}px`);
    document.documentElement.style.setProperty('--try-mobile-cost-slot', `${costSlot}px`);
  });
}

function syncMobileTabbedStreamPill() {
  if (!tabbedMobileStreamPillEl) return;
  if (!document.body.classList.contains('try-tabbed-narrow-ui')) {
    tabbedMobileStreamPillEl.hidden = true;
    tabbedMobileStreamPillEl.textContent = '';
    return;
  }
  const meta = activeProviderId ? tabByProvider.get(activeProviderId) : null;
  const pane = meta?.pane;
  if (!pane?.wrap) {
    tabbedMobileStreamPillEl.hidden = true;
    return;
  }
  const busy = !!pane.busy;
  const line = (pane._genActivityLine || '').trim();
  const collapsed = pane.wrap.classList.contains('tabbed-hide-transcript');
  let text = '';
  if (busy && collapsed) text = line || t('pane.generating_reply');
  else if (busy && line) text = line;
  tabbedMobileStreamPillEl.textContent = text;
  tabbedMobileStreamPillEl.hidden = !text;
}

function syncTryTabbedNarrowUi() {
  const on =
    TRY_TABBED_NARROW_MQ.matches &&
    isWorkspaceTabbedUi() &&
    paneByProvider.size > 0 &&
    !EMBED_MODE;
  document.body.classList.toggle('try-tabbed-narrow-ui', on);
  if (!on) document.body.classList.remove('try-mobile-chat-open');
  const chatOpen = on && document.body.classList.contains('try-mobile-chat-open');
  if (tabbedMobileDockEl) tabbedMobileDockEl.hidden = !on;
  if (tabbedMobileBackdropEl) {
    tabbedMobileBackdropEl.hidden = !chatOpen;
    tabbedMobileBackdropEl.setAttribute('aria-hidden', chatOpen ? 'false' : 'true');
    tabbedMobileBackdropEl.setAttribute('aria-label', t('workspace.mobile_backdrop_aria'));
  }
  if (tabbedMobileChatToggleEl) {
    tabbedMobileChatToggleEl.hidden = !on;
    tabbedMobileChatToggleEl.textContent = chatOpen ? t('workspace.mobile_back_preview') : t('workspace.mobile_open_chat');
    tabbedMobileChatToggleEl.setAttribute('aria-expanded', chatOpen ? 'true' : 'false');
  }
  document.body.style.overflow = chatOpen ? 'hidden' : '';
  syncMobileTabbedStreamPill();
  requestAnimationFrame(updateTryTabbedMobileGeom);
}

if (TRY_TABBED_NARROW_MQ.addEventListener) {
  TRY_TABBED_NARROW_MQ.addEventListener('change', () => syncTryTabbedNarrowUi());
} else if (TRY_TABBED_NARROW_MQ.addListener) TRY_TABBED_NARROW_MQ.addListener(() => syncTryTabbedNarrowUi());
window.addEventListener('resize', () => updateTryTabbedMobileGeom());

if (!EMBED_MODE && tabbedMobileChatToggleEl) {
  tabbedMobileChatToggleEl.addEventListener('click', () => {
    document.body.classList.toggle('try-mobile-chat-open');
    syncTryTabbedNarrowUi();
  });
}
if (!EMBED_MODE && tabbedMobileBackdropEl) {
  tabbedMobileBackdropEl.addEventListener('click', () => {
    document.body.classList.remove('try-mobile-chat-open');
    syncTryTabbedNarrowUi();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!document.body.classList.contains('try-mobile-chat-open')) return;
  document.body.classList.remove('try-mobile-chat-open');
  syncTryTabbedNarrowUi();
});

/** Tabbed workspace only — compare grid keeps full transcripts visible. */
function isWorkspaceTabbedUi() {
  return !!(workspaceEl && !workspaceEl.hidden && workspaceEl.classList.contains('tabbed'));
}

// Rotating playful verb caption — mirrors the Mac app's MessageBubble waiting
// chrome. Lives next to the typing cursor in the chat body and runs while the
// pane is streaming. Toggled at the same sites that show/hide pane.cursor.
// Captions shown in the per-pane spinner during the automatic Final-polish
// pass (runFollowup source 'polish'). Polish runs AFTER the app has already
// rendered, so a generic random verb reads as "still building / stuck" — these
// name the pass and what it's doing so the user knows to wait for the refined
// result rather than thinking the build froze.
const POLISH_WAITING_LINES = [
  'Final polish pass…',
  'Refining responsiveness…',
  'Adding loading & empty states…',
  'Tightening spacing & alignment…',
  'Improving accessibility…',
];
function nextPolishLine(current) {
  const i = POLISH_WAITING_LINES.indexOf(current);
  return POLISH_WAITING_LINES[(i + 1) % POLISH_WAITING_LINES.length];
}

function startSpinnerVerbLoop(pane) {
  const caption = pane?.spinnerCaption;
  if (!caption) return;
  caption.style.display = '';
  // Final-polish turns get a labeled, ordered caption set instead of the
  // whimsical random verbs, so the post-build polish pass is legible.
  const polishing = pane?._activeRunSource === 'polish';
  const firstLine = polishing ? POLISH_WAITING_LINES[0] : randomWaitingLine();
  const nextLine = polishing ? nextPolishLine : nextDistinctWaitingLine;
  if (!pane._spinnerVerbTimer) {
    caption.style.transition = `opacity ${SPINNER_FADE_MS}ms ease-in-out`;
    caption.style.opacity = '1';
    pane._spinnerVerbCurrent = firstLine;
    caption.textContent = firstLine;
    pane._spinnerVerbTimer = setInterval(() => {
      if (!pane._spinnerVerbTimer || !caption.isConnected) return;
      caption.style.opacity = '0';
      setTimeout(() => {
        if (!pane._spinnerVerbTimer) return;
        const next = nextLine(pane._spinnerVerbCurrent || '');
        pane._spinnerVerbCurrent = next;
        caption.textContent = next;
        caption.style.opacity = '1';
      }, SPINNER_FADE_MS);
    }, SPINNER_ROTATION_MS);
  }
}

function stopSpinnerVerbLoop(pane) {
  if (pane?._spinnerVerbTimer) {
    clearInterval(pane._spinnerVerbTimer);
    pane._spinnerVerbTimer = null;
  }
  if (pane) pane._spinnerVerbCurrent = null;
  if (pane?.spinnerCaption) {
    pane.spinnerCaption.style.opacity = '';
    pane.spinnerCaption.style.display = 'none';
    pane.spinnerCaption.textContent = '';
  }
}

/** Tabbed mode: transcript / code rails stay available after streaming ends. */
function syncTabbedTranscriptChrome(pane) {
  if (!pane?.wrap || !pane.genRailMsg || !pane.genRailToggle) return;
  const tabbed = isWorkspaceTabbedUi();
  const busy = !!pane.busy;

  if (!tabbed) {
    pane.wrap.classList.remove('pane-tabbed-toolbar', 'tabbed-hide-transcript');
    pane.body?.removeAttribute('aria-hidden');
    pane.genRailMsg.hidden = false;
    pane.genRailMsg.textContent = '';
    pane.genRailToggle.hidden = true;
    if (pane.genRailCodeToggle) pane.genRailCodeToggle.hidden = true;
    return;
  }

  const hasAssistantMd = pane.turns?.some((tn) => (tn.accumulatedMd || '').trim()) ?? false;
  const toolbarOn = busy || hasAssistantMd;
  pane.wrap.classList.toggle('pane-tabbed-toolbar', toolbarOn);

  const transcriptCollapsed = toolbarOn && !pane._showTranscriptWhileRunning;
  pane.wrap.classList.toggle('tabbed-hide-transcript', transcriptCollapsed);

  if (pane.body) {
    if (transcriptCollapsed) pane.body.setAttribute('aria-hidden', 'true');
    else pane.body.removeAttribute('aria-hidden');
  }

  if (!toolbarOn) {
    pane.genRailMsg.hidden = false;
    pane.genRailMsg.textContent = '';
    pane.genRailToggle.hidden = true;
    if (pane.genRailCodeToggle) pane.genRailCodeToggle.hidden = true;
    return;
  }

  if (pane.genRailCodeToggle) {
    pane.genRailCodeToggle.hidden = transcriptCollapsed;
    if (!pane.genRailCodeToggle.hidden) {
      pane.genRailCodeToggle.textContent = pane._showStreamingCodeInTranscript
        ? t('pane.hide_streaming_code')
        : t('pane.show_streaming_code');
      pane.genRailCodeToggle.setAttribute('aria-pressed', pane._showStreamingCodeInTranscript ? 'true' : 'false');
    }
  }

  const activity = pane._genActivityLine || '';
  if (busy) {
    if (transcriptCollapsed) {
      pane.genRailMsg.hidden = false;
      pane.genRailMsg.textContent = activity || t('pane.generating_reply');
    } else if (activity) {
      pane.genRailMsg.hidden = false;
      pane.genRailMsg.textContent = activity;
    } else {
      pane.genRailMsg.hidden = true;
      pane.genRailMsg.textContent = '';
    }
  } else {
    pane.genRailMsg.hidden = true;
    pane.genRailMsg.textContent = '';
  }

  pane.genRailToggle.hidden = false;
  pane.genRailToggle.textContent = transcriptCollapsed
    ? t('pane.show_transcript')
    : t('pane.hide_transcript');

  syncMobileTabbedStreamPill();
}

// Tab metadata, keyed by provider id. Each entry: { btn, dot, costEl, pane }
const tabByProvider = new Map();
let activeProviderId = null;

function setActiveTab(providerId) {
  if (!tabByProvider.has(providerId)) return;
  activeProviderId = providerId;
  for (const [id, t] of tabByProvider) {
    const isActive = id === providerId;
    t.btn.classList.toggle('active', isActive);
    t.btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    t.pane.wrap.classList.toggle('active', isActive);
  }
  // Refresh inline preview when active tab switches — the iframe srcdoc was
  // last set when *that* pane streamed, so on tab switch we re-pull from the
  // pane body in case the user landed on a stale tab.
  const pane = tabByProvider.get(providerId)?.pane;
  if (pane) {
    updateInlinePreview(pane, /* force */ true);
    // Scroll the chat to bottom — non-active panes don't track scroll while
    // hidden, so a switch could land you mid-transcript.
    requestAnimationFrame(() => { pane.body.scrollTop = pane.body.scrollHeight; });
  }
  for (const [, tp] of tabByProvider) syncTabbedTranscriptChrome(tp.pane);
  document.body.classList.remove('try-mobile-chat-open');
  syncTryTabbedNarrowUi();
  syncTopbarProvider();
}

function syncWorkspaceBuilderChrome() {
  if (!workspaceBuilderHintEl) return;
  workspaceBuilderHintEl.hidden = true;
  workspaceBuilderHintEl.textContent = '';
}

function syncTrySessionChrome() {
  const has = paneByProvider.size > 0;
  document.body.classList.toggle('try-has-session', has);
  document.body.dataset.tryPhase = has ? 'build' : 'landing';
  syncWorkspaceBuilderChrome();
  syncMainPromptComposerChrome();
  syncTryTabbedNarrowUi();
}

function registerTab(provider, pane) {
  if (tabByProvider.has(provider.id)) return tabByProvider.get(provider.id);
  // First pane to register reveals the workspace.
  if (workspaceEl?.hidden) workspaceEl.hidden = false;
  if (canvasBodyEl?.hidden) canvasBodyEl.hidden = false;
  if (progressBarEl?.hidden) progressBarEl.hidden = false;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'try-tab';
  btn.setAttribute('role', 'tab');
  const dot = document.createElement('span');
  dot.className = 'tab-dot';
  if (provider.color) dot.style.background = provider.color;
  const label = document.createElement('span');
  label.className = 'tab-label';
  label.textContent = provider.name;
  const costEl = document.createElement('span');
  costEl.className = 'tab-cost';
  btn.append(dot, label, costEl);
  btn.addEventListener('click', () => {
    setActiveTab(provider.id);
    track('tab_clicked', { provider: provider.id });
  });
  workspaceTabsEl?.append(btn);
  const meta = { btn, dot, costEl, label, pane, provider };
  tabByProvider.set(provider.id, meta);
  // Make the first pane active automatically — without this, the workspace
  // shows tabs but no body until the user clicks one.
  if (!activeProviderId) setActiveTab(provider.id);
  syncTrySessionChrome();
  syncTopbarProvider();
  return meta;
}

function setTabStatus(providerId, status) {
  const t = tabByProvider.get(providerId);
  if (!t) return;
  t.btn.classList.remove('is-running', 'is-done', 'is-error');
  if (status) t.btn.classList.add('is-' + status);
  syncTopbarProvider();
}

function setTabCost(providerId, costStr) {
  const t = tabByProvider.get(providerId);
  if (!t) return;
  t.costEl.textContent = costStr || '';
  syncTopbarProvider();
}

// Mirror of the workspace tab strip into the topbar. One provider → static
// chip; 2+ providers → caret button + dropdown to switch the active tab.
// Reads from tabByProvider + activeProviderId so the state-of-truth stays
// where registerTab / setActiveTab already keep it.
const _topbarProviderEl = document.getElementById('topbar-provider');
let _topbarProviderMenuOpen = false;

function _renderTopbarProviderChip(meta, opts = {}) {
  const { caret = false, onClick = null } = opts;
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'topbar-provider-chip';
  if (onClick) chip.dataset.clickable = '1';
  const dot = document.createElement('span');
  dot.className = 'chip-dot';
  if (meta.provider?.color) dot.style.background = meta.provider.color;
  const label = document.createElement('span');
  label.textContent = meta.provider?.name || meta.label?.textContent || '';
  const cost = document.createElement('span');
  cost.className = 'topbar-provider-cost';
  cost.textContent = meta.costEl?.textContent || '';
  chip.append(dot, label, cost);
  if (caret) {
    const caretEl = document.createElement('span');
    caretEl.className = 'topbar-provider-caret';
    caretEl.textContent = '▾';
    chip.append(caretEl);
  }
  if (onClick) chip.addEventListener('click', onClick);
  return chip;
}

function syncTopbarProvider() {
  if (!_topbarProviderEl) return;
  _topbarProviderEl.innerHTML = '';
  const entries = [...tabByProvider.entries()];
  // Compare (side-by-side grid) only makes sense with 2+ models in the
  // workspace — hide the button otherwise.
  const _cmpBtn = document.getElementById('topbar-compare-btn');
  if (_cmpBtn) _cmpBtn.hidden = entries.length < 2;
  if (entries.length === 0) {
    _topbarProviderEl.hidden = true;
    _topbarProviderMenuOpen = false;
    return;
  }
  _topbarProviderEl.hidden = false;
  const activeId = activeProviderId || entries[0][0];
  const activeMeta = tabByProvider.get(activeId) || entries[0][1];

  if (entries.length === 1) {
    _topbarProviderEl.append(_renderTopbarProviderChip(activeMeta));
    return;
  }

  const chip = _renderTopbarProviderChip(activeMeta, {
    caret: true,
    onClick: (e) => {
      e.stopPropagation();
      _topbarProviderMenuOpen = !_topbarProviderMenuOpen;
      syncTopbarProvider();
    },
  });
  _topbarProviderEl.append(chip);

  if (_topbarProviderMenuOpen) {
    const menu = document.createElement('div');
    menu.className = 'topbar-provider-menu';
    menu.setAttribute('role', 'menu');
    for (const [id, meta] of entries) {
      const item = document.createElement('button');
      item.type = 'button';
      if (id === activeId) item.setAttribute('aria-current', 'true');
      const d = document.createElement('span');
      d.className = 'chip-dot';
      if (meta.provider?.color) d.style.background = meta.provider.color;
      const name = document.createElement('span');
      name.textContent = meta.provider?.name || meta.label?.textContent || '';
      const c = document.createElement('span');
      c.className = 'topbar-provider-cost';
      c.textContent = meta.costEl?.textContent || '';
      item.append(d, name, c);
      item.addEventListener('click', () => {
        setActiveTab(id);
        _topbarProviderMenuOpen = false;
        syncTopbarProvider();
        track('tab_clicked', { provider: id, source: 'topbar_menu' });
      });
      menu.append(item);
    }
    _topbarProviderEl.append(menu);
  }
}

document.addEventListener('click', (e) => {
  if (!_topbarProviderMenuOpen) return;
  if (_topbarProviderEl?.contains(e.target)) return;
  _topbarProviderMenuOpen = false;
  syncTopbarProvider();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _topbarProviderMenuOpen) {
    _topbarProviderMenuOpen = false;
    syncTopbarProvider();
  }
});

// Inline preview: extract assembled HTML from a pane's body and pump it into
// that pane's iframe. Throttled to ~250ms during streaming so we don't hammer
// the iframe every chunk. force=true bypasses the throttle for tab switches.
const _previewThrottle = new WeakMap(); // pane → last update timestamp

// ── Collaboration state ───────────────────────────────────────────────────────
let _collabCurrentUser = null; // { id, email } — set when collab room joins
let _collabActiveProtoId = null;

async function startCollab(prototypeId) {
  if (_collabActiveProtoId === prototypeId) return; // already connected to this room
  _collabActiveProtoId = prototypeId;

  // Fetch current user identity (needed for presence + comments)
  try {
    const meRes = await fetch('/api/account/me', { credentials: 'include' });
    if (meRes.ok) {
      const me = await meRes.json();
      if (me.ok) _collabCurrentUser = { id: me.id, email: me.email };
    }
  } catch (_) {}

  let role;
  try {
    role = await initCollab(prototypeId);
  } catch (err) {
    console.warn('[collab] Failed to connect:', err.message);
    _collabActiveProtoId = null;
    return;
  }

  const yDoc = getYDoc();
  if (!yDoc) return;

  // Sync knowledge files via Y.Map
  enableCollabKnowledge(yDoc);

  // Sync inline edits for each pane
  for (const pane of paneByProvider.values()) {
    enableCollabInlineEdits(yDoc, pane, updateInlinePreview);
  }

  // Presence
  if (_collabCurrentUser) {
    initPresence(getAwareness(), _collabCurrentUser);
    // Mount avatar strip + remote-cursor overlay on the first visible preview iframe
    const firstPaneWithFrame = [...paneByProvider.values()].find(p => p.previewIframe);
    if (firstPaneWithFrame) {
      mountPresenceOverlay(firstPaneWithFrame.previewIframe);
      mountCursorOverlay(firstPaneWithFrame.previewIframe);
    }
    // Live participant count on the collab button
    const aw = getAwareness();
    if (aw) {
      const refreshCount = () => {
        const btn = document.getElementById('collab-btn');
        if (!btn || !_collabActiveProtoId) return;
        const n = aw.getStates().size;
        btn.textContent = n > 1 ? `👥 Live · ${n}` : '👥 Collaborate';
        btn.title = n > 1 ? `Collaborating with ${n - 1} other${n > 2 ? 's' : ''} · ${role}` : `Collaborating · ${role}`;
      };
      aw.on('change', refreshCount);
      refreshCount();
    }
  }

  // Comments
  const firstIframe = [...paneByProvider.values()].find(p => p.previewIframe)?.previewIframe;
  if (_collabCurrentUser) {
    await initComments(prototypeId, _collabCurrentUser, role, firstIframe);
  }

  // Update the collab button to show active state
  const collabBtn = document.getElementById('collab-btn');
  if (collabBtn) {
    collabBtn.classList.add('active');
    collabBtn.title = `Collaborating · ${role}`;
  }

  // Tell every preview iframe that collab is now active so its inline-edit
  // script flips on right-click interception + cursor-hover broadcasting.
  for (const pane of paneByProvider.values()) {
    try {
      pane.previewIframe?.contentWindow?.postMessage({ type: 'lc-collab-state', active: true }, '*');
    } catch (_) {}
  }
}

function openCollabPanel(prototypeId) {
  document.querySelector('.lc-collab-panel')?.remove();

  const role = getMyRole();
  const canInvite = role === 'owner';

  const panel = document.createElement('div');
  panel.className = 'lc-collab-panel ckpt-name-popover';
  panel.style.cssText = 'width:320px;max-height:70vh;overflow-y:auto;z-index:9800;';

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:700;font-size:14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;';
  title.innerHTML = `<span>Collaborate</span>`;
  const closeX = document.createElement('button');
  closeX.textContent = '✕';
  closeX.style.cssText = 'background:none;border:none;cursor:pointer;font-size:14px;color:var(--text-muted);';
  closeX.onclick = () => panel.remove();
  title.appendChild(closeX);
  panel.appendChild(title);

  // Role badge
  const roleBadge = document.createElement('div');
  roleBadge.style.cssText = 'font-size:12px;color:var(--text-muted);margin-bottom:12px;';
  roleBadge.textContent = `Your role: ${role || '—'}`;
  panel.appendChild(roleBadge);

  if (canInvite) {
    // Invite by email
    const inviteSection = document.createElement('div');
    inviteSection.style.cssText = 'margin-bottom:14px;';

    const inviteLabel = document.createElement('div');
    inviteLabel.style.cssText = 'font-size:12px;font-weight:600;margin-bottom:6px;';
    inviteLabel.textContent = 'Invite collaborator';
    inviteSection.appendChild(inviteLabel);

    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.placeholder = 'email@example.com';
    emailInput.style.cssText = 'width:100%;border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:13px;box-sizing:border-box;margin-bottom:6px;';

    const roleSelect = document.createElement('select');
    roleSelect.style.cssText = 'width:100%;border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:13px;margin-bottom:6px;';
    roleSelect.innerHTML = '<option value="editor">Editor (can edit)</option><option value="viewer">Viewer (read-only)</option>';

    const inviteBtn = document.createElement('button');
    inviteBtn.textContent = 'Send invite';
    inviteBtn.style.cssText = 'background:var(--accent,#7c3aed);color:#fff;border:none;border-radius:6px;padding:6px 16px;font-size:13px;cursor:pointer;font-weight:600;width:100%;';
    inviteBtn.onclick = async () => {
      const email = emailInput.value.trim();
      if (!email) return;
      inviteBtn.textContent = 'Inviting…';
      inviteBtn.disabled = true;
      try {
        const r = await fetch(`/api/prototypes/${prototypeId}/collab/members`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, role: roleSelect.value }),
        });
        const d = await r.json();
        if (d.ok) {
          if (d.action === 'pending') {
            inviteBtn.textContent = d.email_sent ? '✓ Invite emailed (signup)' : '✓ Pending (email failed)';
          } else {
            inviteBtn.textContent = d.email_sent ? '✓ Invited + emailed' : '✓ Invited (no email)';
          }
          emailInput.value = '';
        } else if (d.error === 'rate_limited') {
          inviteBtn.textContent = 'Rate limited — try in an hour';
        } else {
          inviteBtn.textContent = 'Error';
        }
      } catch { inviteBtn.textContent = 'Error'; }
      setTimeout(() => { inviteBtn.textContent = 'Send invite'; inviteBtn.disabled = false; }, 2500);
    };

    inviteSection.appendChild(emailInput);
    inviteSection.appendChild(roleSelect);
    inviteSection.appendChild(inviteBtn);

    // Share link
    const linkBtn = document.createElement('button');
    linkBtn.textContent = '🔗 Copy invite link';
    linkBtn.style.cssText = 'background:none;border:1px solid var(--border);border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;width:100%;margin-top:6px;';
    linkBtn.onclick = async () => {
      try {
        const r = await fetch(`/api/prototypes/${prototypeId}/collab/share-link`);
        const d = await r.json();
        if (d.ok) { await navigator.clipboard.writeText(d.url); linkBtn.textContent = '✓ Copied!'; }
        else linkBtn.textContent = 'Error';
      } catch { linkBtn.textContent = 'Error'; }
      setTimeout(() => { linkBtn.textContent = '🔗 Copy invite link'; }, 2000);
    };
    inviteSection.appendChild(linkBtn);
    panel.appendChild(inviteSection);
  }

  // History link
  if (isEditor() || role === 'owner') {
    const histBtn = document.createElement('button');
    histBtn.textContent = '📋 View edit history';
    histBtn.style.cssText = 'background:none;border:1px solid var(--border);border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;width:100%;margin-top:4px;';
    histBtn.onclick = () => { panel.remove(); openCollabHistoryPanel(prototypeId); };
    panel.appendChild(histBtn);
  }

  // Member list with online/offline status. Cross-references the REST member
  // roster against the live awareness states (which userIds are connected
  // right now). Online members get a green dot; offline get a grey one.
  const memberSection = document.createElement('div');
  memberSection.style.cssText = 'margin-top:14px;padding-top:12px;border-top:1px solid var(--border);';

  const memberLabel = document.createElement('div');
  memberLabel.style.cssText = 'font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-muted);';
  memberLabel.textContent = 'Members';
  memberSection.appendChild(memberLabel);

  const memberListEl = document.createElement('div');
  memberListEl.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  memberSection.appendChild(memberListEl);
  panel.appendChild(memberSection);

  (async () => {
    try {
      const r = await fetch(`/api/prototypes/${prototypeId}/collab/members`);
      const d = await r.json();
      if (!d.ok || !Array.isArray(d.members)) return;

      // Snapshot the userIds of currently-connected awareness states
      const aw = getAwareness();
      const onlineIds = new Set();
      if (aw) {
        for (const state of aw.getStates().values()) {
          if (state && state.lc && state.lc.userId) onlineIds.add(state.lc.userId);
        }
      }

      memberListEl.innerHTML = '';
      for (const m of d.members) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;';

        const dot = document.createElement('span');
        const isOnline = onlineIds.has(m.id);
        dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${isOnline ? '#10b981' : '#9ca3af'};flex-shrink:0;`;
        dot.title = isOnline ? 'Online' : 'Offline';

        const name = document.createElement('span');
        name.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        name.textContent = m.email;

        const roleTag = document.createElement('span');
        roleTag.style.cssText = 'color:var(--text-muted);font-size:11px;';
        roleTag.textContent = m.role;

        row.appendChild(dot);
        row.appendChild(name);
        row.appendChild(roleTag);

        // Owner can remove non-owner members (small × button)
        if (canInvite && m.role !== 'owner') {
          const rmBtn = document.createElement('button');
          rmBtn.textContent = '×';
          rmBtn.title = 'Remove';
          rmBtn.style.cssText = 'background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:0 4px;line-height:1;';
          rmBtn.onclick = async () => {
            if (!confirm(`Remove ${m.email}?`)) return;
            await fetch(`/api/prototypes/${prototypeId}/collab/members/${m.id}`, { method: 'DELETE' });
            row.remove();
          };
          row.appendChild(rmBtn);
        }

        memberListEl.appendChild(row);
      }
    } catch (_) {
      memberListEl.textContent = 'Failed to load members.';
      memberListEl.style.color = 'var(--text-muted)';
      memberListEl.style.fontSize = '12px';
    }
  })();

  // Position below the collab button
  const anchor = document.getElementById('collab-btn');
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.top = `${r.bottom + 8}px`;
    panel.style.right = `${window.innerWidth - r.right}px`;
  }

  document.body.appendChild(panel);
  setTimeout(() => {
    document.addEventListener('click', function dismiss(e) {
      if (!panel.contains(e.target) && e.target !== anchor) { panel.remove(); document.removeEventListener('click', dismiss); }
    });
  }, 0);
}
// ─────────────────────────────────────────────────────────────────────────────
/** Off-DOM host for fence extraction when the sidebar hides code during tabbed streams. */
let _scratchExtractHost = null;

/** Same runnable detection as inline preview — needed when fenced code is stripped from sidebar DOM but lives on accumulatedMd. */
function extractLatestRunnableHtmlFromPane(pane) {
  if (!pane?.body) return null;
  let html = extractRunnable(pane.body);
  if (html) return html;
  // DOM scan found nothing — fall back to raw turn markdown, newest→oldest,
  // so a trailing polish/chat turn that didn't re-emit HTML doesn't hide the
  // app built in an earlier turn. Mirrors extractRunnable's backward scan.
  const turns = pane.turns;
  if (!turns?.length) return null;
  if (!_scratchExtractHost) _scratchExtractHost = document.createElement('div');
  for (let i = turns.length - 1; i >= 0; i--) {
    const md = turns[i]?.accumulatedMd;
    if (!md) continue;
    _scratchExtractHost.innerHTML = renderMarkdown(md);
    html = extractRunnable(_scratchExtractHost);
    _scratchExtractHost.innerHTML = '';
    if (html) return html;
  }
  return null;
}

function mdForTabbedSidebar(pane, accumulatedMd) {
  const raw = accumulatedMd ?? '';
  if (!raw) return '';
  if (!isWorkspaceTabbedUi() || pane._showStreamingCodeInTranscript) return raw;
  return markdownHideFencedBlocks(raw);
}

// Plain-text prose for a restored turn's assistant reply, used to mirror the
// conversation into the visible chat column (#try-chat-history renders escaped
// text bubbles, not markdown). Drops fenced code, the collapsed-code placeholder
// blockquotes, and tool-call log lines so the bubble reads like a message.
function restoredAiBubbleText(md) {
  let t = markdownHideFencedBlocks(md || '').replace(/```[\s\S]*?```/g, '');
  t = t.split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l) && !/^\s*Tool:/i.test(l) && !/^\s*Added\b/i.test(l))
    .join('\n');
  return t.replace(/[#*_`]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);
}

/**
 * Reduce fenced blobs in the streamed sidebar to tiny hints so it reads like
 * chat — raw markdown stays on turnState.accumulatedMd for preview + exports.
 */
function markdownHideFencedBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const header = line.slice(3).trim();
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '```') j++;
      const body = lines.slice(i + 1, j).join('\n');
      const closed = j < lines.length;
      const ph = fencedSidebarPlaceholder(header, body, closed);
      if (typeof ph === 'string' && ph) out.push(...ph.split('\n'));
      i = closed ? j + 1 : lines.length;
    } else {
      out.push(line);
      i++;
    }
  }
  return out.join('\n');
}

function fenceLabelForSidebar(headerLine) {
  if (!headerLine || !String(headerLine).trim()) return 'code';
  const line = headerLine.trim();
  const mName = /\bname=([^\s]+)/i.exec(line);
  if (mName) return mName[1].replace(/^["']|["']$/g, '');
  const first = (line.split(/\s+/)[0] || '').replace(/^\.+/g, '');
  if (/^[\w#+-]+$/.test(first)) return first || 'code';
  return first || 'code';
}

function fencedSidebarPlaceholder(headerLine, body, closed) {
  const tok = headerLine.trim().split(/\s+/)[0]?.toLowerCase().replace(/^\.+/, '') || '';
  if (tok === 'tool') {
    const one = body.split('\n').map((ln) => ln.trim()).find(Boolean) || '';
    if (!one) return '';
    return `> ${t('pane.tool_sidebar_line')} \`${one.replace(/`/g, "'").slice(0, 240)}${one.length > 240 ? '…' : ''}\``;
  }
  if (tok === 'tool-result') {
    return `> ${t('pane.tool_output_sidebar')}`;
  }
  const label = fenceLabelForSidebar(headerLine);
  if (!closed) {
    return `> ${t('pane.code_streaming_sidebar', label)}`;
  }
  return `> ${t('pane.code_done_sidebar', label)}`;
}

function rerenderAllTabbedTurnsMarkdown(pane) {
  if (!pane?.turns?.length || !pane.body) return;
  for (const tn of pane.turns) {
    if (!tn.mdEl) continue;
    tn.mdEl.innerHTML = renderMarkdown(mdForTabbedSidebar(pane, tn.accumulatedMd));
    addCopyButtons(tn.mdEl);
  }
  pane.body.scrollTop = pane.body.scrollHeight;
}

// WebKit quirk: a sandboxed iframe with `allow-same-origin allow-scripts`
// (the inline preview's sandbox — needed so the inline editor + live thumbnail
// can read its document) intermittently parses an EMPTY document on the first
// srcdoc assignment, leaving the preview blank even though srcdoc holds valid
// HTML. The Expand modal uses a no-same-origin sandbox and never hits this.
// Detect the empty-document case and toggle srcdoc once to force a real load.
// Only fires when the doc actually came up empty, so a working preview never
// flashes. (Diagnosed live: contentDocument 39 chars → 70846 after a re-set.)
function setInlineSrcdoc(iframe, html) {
  iframe.srcdoc = html;
  setTimeout(() => {
    if (iframe.srcdoc !== html) return; // superseded by a newer render
    let empty = false;
    try {
      const d = iframe.contentDocument;
      empty = !d || !d.body || d.body.childElementCount === 0;
    } catch (_) { return; }
    if (!empty) return;
    iframe.srcdoc = '';
    requestAnimationFrame(() => { if (iframe.srcdoc === '') iframe.srcdoc = html; });
  }, 150);
}

function updateInlinePreview(pane, force = false) {
  if (!pane?.previewIframe) return;
  const now = performance.now();
  const last = _previewThrottle.get(pane) || 0;
  if (!force && now - last < 250) return;
  _previewThrottle.set(pane, now);
  // Try multi-file first (filename markers in fenced blocks), then fall back
  // to extractRunnable's assembled single-file HTML.
  const _turns = pane.turns || [];
  const latest = _turns[_turns.length - 1];
  // Newest→oldest: a trailing polish/chat turn may not re-emit the file set,
  // so fall back to the most recent turn that did. Mirrors the single-file
  // backward scan in extractRunnable — without it the multi-file preview goes
  // blank the moment Final polish lands a turn with no filename-marked blocks.
  let files = null;
  // On a fresh restore (?continue=), the files seeded from share_payload are the
  // AUTHORITATIVE content. The restored transcript is kept for model memory and
  // may carry only a partial/intermediate fenced block (an early build turn, or
  // a chat history trimmed at save) — scanning it would render that stale
  // fragment instead of the real saved app. `_seededAuthoritative` is a sticky
  // flag (set on restore, cleared in runFollowup when the user sends a new turn).
  // It must be a boolean, NOT a turn-count compare: extra updateInlinePreview
  // calls (setActiveTab on tab activation, resize) would otherwise let the
  // transcript scan win and overwrite pane._files with the partial — permanently.
  if (pane._seededAuthoritative && pane._files && pane._files.size > 0) {
    files = pane._files;
  } else {
    for (let i = _turns.length - 1; i >= 0; i--) {
      const md = _turns[i]?.accumulatedMd;
      if (!md) continue;
      const f = extractFiles(md);
      if (f && f.size > 0) { files = f; break; }
    }
    // Tool-write / trimmed-history fallback: the transcript scan found nothing
    // but files are seeded on the pane — render those rather than blanking.
    if ((!files || files.size === 0) && pane._files && pane._files.size > 0) {
      files = pane._files;
    }
  }

  if (files && files.size > 0) {
    // Multi-file mode: track active file, render the file-tab strip, and
    // inline cross-file references so internal links work in the iframe.
    pane._files = files;
    if (!pane._activeFile || !files.has(pane._activeFile)) {
      pane._activeFile = pickInitialFileFromPreview(files);
    }
    renderInlineFileTabs(pane);
    updateInlineFileCountBadge(pane);
    if (pane._monacoCodeMode) { refreshMonacoPane(pane); return; }
    const html = files.get(pane._activeFile) || null;
    if (!html) return;
    if (!force && html === pane._previewLastSrc) return;
    pane._previewLastSrc = html;
    pane.previewIframe._docW = 0;
    pane.previewIframe._contentH = 0;
    hideInlinePreviewError(pane);
    const _editHtml = applyInlineEdits(html, pane._inlineEdits);
    const _viewerCollab = _collabActiveProtoId && getMyRole() === 'viewer';
    const _editWrapped = _viewerCollab ? _editHtml : injectInlineEditScript(_editHtml);
    setInlineSrcdoc(pane.previewIframe, injectInlineHeightScript(ensureViewportMeta(withLinkInterceptor(inlineSiblingFiles(injectErrorReporter(injectBackendGlobals(injectSupabaseGlobals(_editWrapped))), files, pane._assets)))));
    pane.previewExpand.disabled = false;
    if (pane.publishBtn) pane.publishBtn.disabled = false;
    if (pane.mobileToggle) pane.mobileToggle.disabled = false;
    pane.previewCol.classList.add('has-preview');
    if (!pane._previewScrolled) { pane._previewScrolled = true; setTimeout(() => pane.previewCol.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120); }
    return;
  }

  // Single-file path: clear any leftover multi-file state.
  if (pane._files) {
    pane._files = null;
    pane._activeFile = null;
    if (pane.previewFileTabs) pane.previewFileTabs.style.display = 'none';
    updateInlineFileCountBadge(pane);
  }
  let html = extractRunnable(pane.body);
  if (!html && latest?.accumulatedMd) {
    if (!_scratchExtractHost) _scratchExtractHost = document.createElement('div');
    _scratchExtractHost.innerHTML = renderMarkdown(latest.accumulatedMd);
    html = extractRunnable(_scratchExtractHost);
    _scratchExtractHost.innerHTML = '';
  }
  if (!html) {
    pane.previewIframe.style.display = 'none';
    pane.previewIframe._docW = 0;
    pane.previewIframe._contentH = 0;
    pane.previewIframe.style.removeProperty('margin-left');
    pane.previewExpand.disabled = true;
    if (pane.publishBtn) pane.publishBtn.disabled = true;
    if (pane.mobileToggle) pane.mobileToggle.disabled = true;
    pane._previewLastSrc = '';
    pane._previewScrolled = false;
    pane.previewCol.style.removeProperty('height');
    pane.previewCol.classList.remove('has-preview');
    return;
  }
  // Streaming-state gate: while a fenced ```html block is still being
  // emitted, extractRunnable will return its partial contents (markdown
  // renderers happily render incomplete code blocks). Pushing that into
  // the iframe shows a blank white pane because the partial usually ends
  // mid-CSS / mid-tag with no body content yet — and worse, hides the
  // skeleton because we mark .has-preview. Wait for a closing tag.
  // force=true (the end-of-turn pump) bypasses the gate so completed runs
  // always render, even if the model never emitted </html>.
  const looksComplete = /<\/html>|<\/body>/i.test(html);
  if (!force && !looksComplete) {
    pane.previewIframe.style.display = 'none';
    pane.previewExpand.disabled = true;
    if (pane.publishBtn) pane.publishBtn.disabled = true;
    if (pane.mobileToggle) pane.mobileToggle.disabled = true;
    pane.previewCol.classList.remove('has-preview');
    return;
  }
  if (!force && html === pane._previewLastSrc) return;
  pane._previewLastSrc = html;
  pane.previewIframe._docW = 0;
  pane.previewIframe._contentH = 0;
  // Single-file path: still apply asset rewriting so user-attached images
  // referenced by path (e.g. <img src="assets/logo.png">) resolve in srcdoc.
  hideInlinePreviewError(pane);
  // Re-target inline edits onto the (possibly fresh-from-AI) html before all wrappers,
  // then inject the click-to-edit script as the outermost wrapper.
  const _editedHtml = applyInlineEdits(html, pane._inlineEdits);
  const _isViewerCollab = _collabActiveProtoId && getMyRole() === 'viewer';
  const _baseHtml = pane._assets && pane._assets.size > 0 ? inlineSiblingFiles(injectErrorReporter(injectBackendGlobals(injectSupabaseGlobals(_editedHtml))), null, pane._assets) : injectErrorReporter(injectBackendGlobals(injectSupabaseGlobals(_editedHtml)));
  setInlineSrcdoc(pane.previewIframe, injectInlineHeightScript(ensureViewportMeta(
    withLinkInterceptor(
      _isViewerCollab ? _baseHtml : injectInlineEditScript(_baseHtml)
    )
  )));
  pane.previewExpand.disabled = false;
  if (pane.publishBtn) pane.publishBtn.disabled = false;
  if (pane.mobileToggle) pane.mobileToggle.disabled = false;
  pane.previewCol.classList.add('has-preview');
  if (!pane._previewScrolled) { pane._previewScrolled = true; setTimeout(() => pane.previewCol.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120); }
}

// Render (or refresh) the file tab strip above the inline preview iframe.
// One pill per file; click swaps which file the iframe shows. Hidden when
// only one file (the iframe IS the preview, no need for a chooser).
function renderInlineFileTabs(pane) {
  if (!pane.previewFileTabs) return;
  if (!pane._files || pane._files.size <= 1) {
    pane.previewFileTabs.style.display = 'none';
    pane.previewFileTabs.innerHTML = '';
    return;
  }
  pane.previewFileTabs.style.display = '';
  // Diff-aware: rebuild only when filename set or active selection changes.
  const keys = [...pane._files.keys()];
  const fingerprint = keys.join('|') + '#' + (pane._activeFile || '');
  if (pane._fileTabsFingerprint === fingerprint) return;
  pane._fileTabsFingerprint = fingerprint;
  pane.previewFileTabs.innerHTML = '';
  for (const name of keys) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'pp-file-tab';
    tab.textContent = name;
    tab.title = name;
    if (name === pane._activeFile) tab.classList.add('active');
    tab.addEventListener('click', () => {
      if (pane._activeFile === name) return;
      pane._activeFile = name;
      pane._previewLastSrc = '';   // force reload
      updateInlinePreview(pane, /* force */ true);
      track('inline_file_switched', { file: name, total: keys.length });
    });
    pane.previewFileTabs.append(tab);
  }
}

// Update the file-count text in the preview bar (e.g. "Preview · 3 files").
function updateInlineFileCountBadge(pane) {
  if (!pane.previewCount) return;
  const n = pane._files ? pane._files.size : 0;
  if (n > 1) {
    pane.previewCount.textContent = ' · ' + t('workspace.preview_count', n);
    pane.previewCount.style.display = '';
  } else {
    pane.previewCount.textContent = '';
    pane.previewCount.style.display = 'none';
  }
}

// Compare toggle — flips workspace between tabbed (Lovable) and grid (the
// classic side-by-side compare).
if (workspaceModeBtn && workspaceEl) {
  // Initialize labels from i18n (markup default is English).
  workspaceModeBtn.textContent = t('workspace.compare');
  workspaceModeBtn.title = t('workspace.compare_title');
  workspaceModeBtn.addEventListener('click', () => {
    const wasTabbed = workspaceEl.classList.contains('tabbed');
    if (wasTabbed) {
      workspaceEl.classList.remove('tabbed');
      workspaceModeBtn.classList.add('active');
      workspaceModeBtn.textContent = t('workspace.tabbed');
      workspaceModeBtn.title = t('workspace.tabbed_title');
      track('workspace_mode_toggled', { mode: 'compare' });
    } else {
      workspaceEl.classList.add('tabbed');
      workspaceModeBtn.classList.remove('active');
      workspaceModeBtn.textContent = t('workspace.compare');
      workspaceModeBtn.title = t('workspace.compare_title');
      track('workspace_mode_toggled', { mode: 'tabbed' });
    }
    for (const p of paneByProvider.values()) {
      syncTabbedTranscriptChrome(p);
      rerenderAllTabbedTurnsMarkdown(p);
    }
    syncAllPaneFollowupRows();
    syncMainPromptComposerChrome();
    syncTryTabbedNarrowUi();
  });

  // Checkpoint buttons
  document.getElementById('checkpoint-btn')?.addEventListener('click', openCheckpointNameDialog);
  document.getElementById('checkpoint-history-btn')?.addEventListener('click', () =>
    openHistoryPanel({ sessionId: getSessionId(), onRestore: applyCheckpointRestore }));

  // Tools dropdown — single menu collapses 9 advanced/integration buttons.
  // The buttons themselves keep their individual handlers (wired in
  // main-supabase.js, main-knowledge.js, etc.); we only manage open/close
  // here. Clicking a menu item closes the dropdown after the button's
  // own handler runs (delegated via bubbling).
  const toolsBtn = document.getElementById('workspace-tools-btn');
  const toolsMenu = document.getElementById('workspace-tools-menu');
  if (toolsBtn && toolsMenu) {
    const closeToolsMenu = () => {
      toolsMenu.hidden = true;
      toolsBtn.setAttribute('aria-expanded', 'false');
    };
    const positionToolsMenu = () => {
      // Menu uses position: fixed; anchor it directly below the trigger
      // button and right-align so it doesn't run off the right edge for
      // toolbars near the viewport edge.
      const rect = toolsBtn.getBoundingClientRect();
      toolsMenu.style.top = (rect.bottom + 6) + 'px';
      // Prefer right-aligning if the menu would overflow the viewport.
      const menuWidth = Math.max(200, toolsMenu.offsetWidth || 0);
      const leftIfLeftAligned = rect.left;
      const wouldOverflow = leftIfLeftAligned + menuWidth > window.innerWidth - 8;
      toolsMenu.style.left = wouldOverflow
        ? Math.max(8, rect.right - menuWidth) + 'px'
        : leftIfLeftAligned + 'px';
    };
    const openToolsMenu = () => {
      toolsMenu.hidden = false;
      toolsBtn.setAttribute('aria-expanded', 'true');
      positionToolsMenu();
    };
    // Reposition on resize / scroll while the menu is open so it tracks
    // the trigger button even if the page reflows.
    window.addEventListener('resize', () => { if (!toolsMenu.hidden) positionToolsMenu(); });
    window.addEventListener('scroll', () => { if (!toolsMenu.hidden) positionToolsMenu(); }, true);
    toolsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (toolsMenu.hidden) openToolsMenu(); else closeToolsMenu();
    });
    // Close on outside click.
    document.addEventListener('click', (e) => {
      if (toolsMenu.hidden) return;
      if (toolsMenu.contains(e.target) || toolsBtn.contains(e.target)) return;
      closeToolsMenu();
    });
    // Close on Escape.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !toolsMenu.hidden) closeToolsMenu();
    });
    // Close after any menu item click (the item's own handler still runs
    // first because addEventListener with capture: false fires in order).
    toolsMenu.addEventListener('click', (e) => {
      if (e.target.closest('.try-workspace-mode')) {
        // Defer one tick so the inner handler (e.g. openSupabaseDialog)
        // completes before we hide the menu.
        setTimeout(closeToolsMenu, 0);
      }
    });
  }

  // Workspace close button — discards current panes/turns/files via a
  // full page reload to /try.html. Same semantics as the sidebar's
  // "+ New project" button; lives on the workspace toolbar so users can
  // close a continued-editing session without going to the sidebar.
  document.getElementById('workspace-close-btn')?.addEventListener('click', () => {
    if (window.confirm('Close this workspace? Current turns and previews will be cleared.')) {
      window.location.href = '/try.html';
    }
  });

  // GitHub push button
  document.getElementById('github-push-btn')?.addEventListener('click', () => pushToGitHub({ onPushed: renderWorkspaceState }).catch(console.error));

  // Supabase config button
  document.getElementById('supabase-btn')?.addEventListener('click', openSupabaseDialog);
  initSupabaseConfig();

  // Knowledge files button
  document.getElementById('knowledge-btn')?.addEventListener('click', openKnowledgeDialog);

  // Secrets vault button (per-prototype encrypted secrets — Phase 4)
  document.getElementById('secrets-btn')?.addEventListener('click', openSecretsDialog);

  // LingCode Cloud — managed backend console (database, SQL) for this prototype
  document.getElementById('cloud-btn')?.addEventListener('click', openCloudConsole);

  // Site identity / analytics / forms — auto-injected into every generated page
  document.getElementById('site-config-btn')?.addEventListener('click', openSiteConfigDialog);

  // Custom subdomains (Phase 5b finalize) — Cloudflare CNAME for published prototypes
  document.getElementById('domains-btn')?.addEventListener('click', openDomainsDialog);

  // Projects button
  document.getElementById('projects-btn')?.addEventListener('click', openProjectsPanel);

  // Collaborate button — opens invite/member panel; only active once a prototype is saved
  document.getElementById('collab-btn')?.addEventListener('click', () => {
    if (!_collabActiveProtoId) {
      alert('Publish your prototype first to start collaborating.');
      return;
    }
    openCollabPanel(_collabActiveProtoId);
  });
  syncSupabaseBtn();
  syncKnowledgeBtn();
  syncSecretsBtn();
  syncCloudBtn();
  syncSiteConfigBtn();
  syncDomainsBtn();
}

// ⌘S / Ctrl+S keyboard shortcut for saving a named checkpoint
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's' && !e.shiftKey && !e.altKey
      && paneByProvider.size > 0
      && document.activeElement?.tagName !== 'TEXTAREA'
      && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    openCheckpointNameDialog();
  }
});

// Alt+M keyboard shortcut for voice input
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'm' && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    document.querySelector('.try-mic-btn')?.click();
  }
});

function ensurePane(provider) {
  let pane = paneByProvider.get(provider.id);
  if (pane) return pane;
  const wrap = document.createElement('div');
  wrap.className = 'try-pane pane-fade-in';
  wrap.style.animationDelay = `${paneByProvider.size * 60}ms`;

  const head = document.createElement('div');
  head.className = 'try-pane-head';

  const headLeft = document.createElement('div');
  headLeft.className = 'head-left';
  const dot = document.createElement('div');
  dot.className = 'brand-dot';
  if (provider.color) {
    dot.style.background = provider.color;
    dot.style.color = provider.color;
  }
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = provider.name;
  headLeft.append(dot, name);

  const headRight = document.createElement('div');
  headRight.style.display = 'flex';
  headRight.style.alignItems = 'center';
  headRight.style.gap = '6px';
  const meta = document.createElement('div');
  meta.className = 'meta';
  // Branding-opaque rule: never surface the upstream model id for hosted
  // LingModel rows (would expose "deepseek-v4-flash" / "deepseek-v4-pro").
  // The row name ("LingModel Standard"/"Advanced") conveys the tier.
  meta.textContent = provider.proxied ? '' : provider.model;
  headRight.append(meta);

  // Preview — scans the pane for HTML/CSS/JS (or latest markdown fallback when
  // fences are hidden from the sidebar) and opens a sandbox iframe.
  // Disabled until at least one runnable code block exists in the latest turn.
  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'pane-preview-btn';
  previewBtn.textContent = t('pane.preview');
  previewBtn.disabled = true;
  previewBtn.title = t('pane.preview_disabled');
  function extractLatestRunnableHtml() {
    return extractLatestRunnableHtmlFromPane(pane);
  }
  function openFullscreenPreview() {
    // Multi-file output? Route through the files-aware preview path.
    const latest = pane.turns[pane.turns.length - 1];
    // Restored projects: the seeded share_payload files are authoritative (the
    // transcript may hold only a partial/empty fragment). Mirror the inline
    // updateInlinePreview seed-first logic so Expand shows the real saved app.
    const files = (pane._seededAuthoritative && pane._files && pane._files.size > 0)
      ? pane._files
      : (latest ? extractFiles(latest.accumulatedMd) : null);
    const sourcePrompt = latest?.userText || '';
    // Auto-fix-on-preview-error handler — shared between single-file and
    // multi-file modal paths. The model's last output threw a top-level JS
    // error in the iframe; banner offers one-click follow-up to fix it.
    const onAutoFix = (errCtx) => {
      const fileHint = errCtx.activeFile
        ? `In file \`${errCtx.activeFile}\`, the preview crashed.\n\n`
        : `The preview crashed.\n\n`;
      const stack = errCtx.stack ? `\nStack:\n\`\`\`\n${errCtx.stack}\n\`\`\`\n` : '';
      const fixPrompt =
        `${fileHint}Error: ${errCtx.message}${stack}\n` +
        `Fix the issue and output the FULL updated prototype. ` +
        `Do not change unrelated layout or behavior — minimal targeted fix only.`;
      runFollowup(fixPrompt, { source: 'auto_fix' }).then(() => refreshFromLatestTurn(pane.body));
    };
    if (files && files.size > 1) {
      track('preview_opened', { provider: provider.id, multi_file: 1, file_count: files.size });
      openPreview({
        files,
        assets: pane._assets,
        paneBodyEl: pane.body,
        providerName: provider.name,
        sourcePrompt,
        providerId: provider.id,
        onAutoFix,
      });
      return;
    }
    // Single-file: prefer the seeded file (the restored app) over the transcript scan.
    const singleHtml = (files && files.size === 1)
      ? [...files.values()][0]
      : extractLatestRunnableHtml();
    if (!singleHtml) { showEmptyPreview(); return; }
    track('preview_opened', { provider: provider.id, multi_file: 0 });
    openPreview({
      html: singleHtml,
      paneBodyEl: pane.body,
      assets: pane._assets,
      providerName: provider.name,
      sourcePrompt,
      providerId: provider.id,
      onEditSubmit: ({ selection, userRequest }) => {
        // Hand off to the same code path Continue uses, but with a prompt
        // that scopes the model to the picked element. After the new turn
        // completes, refresh the modal so the user sees the result.
        const editPrompt =
          `In the prototype, refine ONLY this element:\n\n` +
          `\`\`\`html\n${selection}\n\`\`\`\n\n` +
          `User wants: ${userRequest}\n\n` +
          `Output the FULL updated prototype as one fenced \`\`\`html block, ` +
          `preserving everything else exactly as-is.`;
        runFollowup(editPrompt, { source: 'element_edit' }).then(() => refreshFromLatestTurn(pane.body));
      },
      onCodeEdit: (html) => {
        pane.editedHtml = html;  // null when clean, edited HTML when dirty
        if (pane.editedBadge) pane.editedBadge.style.display = html ? 'block' : 'none';
      },
      onAutoFix,
    });
  }
  previewBtn.addEventListener('click', openFullscreenPreview);
  headRight.append(previewBtn);

  // Deploy button — one-click Netlify Deploy for static HTML apps.
  const deployBtn = document.createElement('button');
  deployBtn.type = 'button';
  deployBtn.className = 'pane-deploy-btn';
  deployBtn.title = 'Deploy';
  deployBtn.setAttribute('aria-label', 'Deploy');
  deployBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7v10c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-10-5z"/><polyline points="10 12 14 16 10 20"/><polyline points="14 12 10 16 14 20"/></svg>`;
  deployBtn.disabled = true;
  deployBtn.style.display = 'none';
  deployBtn.addEventListener('click', async () => {
    deployBtn.disabled = true;
    const originalInner = deployBtn.innerHTML;
    const statusStages = ['Uploading…', 'Building…', 'Almost ready…'];
    let stageIdx = 0;
    deployBtn.textContent = statusStages[0];
    const ticker = setInterval(() => {
      stageIdx = Math.min(stageIdx + 1, statusStages.length - 1);
      if (!deployBtn.disabled) { clearInterval(ticker); return; }
      deployBtn.textContent = statusStages[stageIdx];
    }, 5000);
    try {
      let url, provider;
      const projName = (pane.turns?.[0]?.userText || 'prototype').slice(0, 32);
      // Collect the app's files: multi-file Map, or a single index.html.
      let cloudFiles;
      if (pane._files && pane._files.size > 0) {
        cloudFiles = pane._files;
      } else {
        const html = extractLatestRunnableHtml();
        if (!html) { clearInterval(ticker); deployBtn.innerHTML = originalInner; deployBtn.disabled = false; showEmptyPreview(); return; }
        cloudFiles = { 'index.html': html };
      }
      // Edit mode with no linked STATIC app (SSR project, or unlinked): don't
      // create a stray new static app. Persist the source snapshot and tell the
      // user that browser-redeploy of server-rendered apps needs the build tier.
      if (window.__lingcodeEditProjectId && !pane._cloudAppId) {
        try { await saveProjectSnapshot(window.__lingcodeEditProjectId, cloudFiles); } catch (_) { /* best-effort */ }
        clearInterval(ticker);
        deployBtn.innerHTML = originalInner;
        deployBtn.disabled = false;
        const note = document.createElement('div');
        note.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;background:var(--bg-card);border:1px solid var(--border-strong);border-radius:8px;padding:14px 16px;box-shadow:0 4px 12px rgba(0,0,0,0.15);font-family:Geist,sans-serif;font-size:0.88rem;max-width:320px;color:var(--text)';
        note.textContent = 'Saved your edits to the project. Redeploying server-rendered apps from the browser is coming soon — for now, redeploy from the Mac app.';
        document.body.append(note);
        setTimeout(() => note.remove(), 7000);
        return;
      }
      // Primary: deploy to LingCode Cloud (native static hosting at /apps/<id>).
      // Fall back to Vercel/Netlify only when the user isn't signed into LingCode.
      try {
        const r = await deployToLingCodeCloud(cloudFiles, projName, pane._cloudAppId);
        url = r.url; provider = 'LingCode Cloud'; pane._cloudAppId = r.id;
        // In project-edit mode, also persist the edited source as a new snapshot
        // version so collaborators + reopen get the change. Best-effort.
        if (window.__lingcodeEditProjectId) {
          try { await saveProjectSnapshot(window.__lingcodeEditProjectId, cloudFiles); } catch (_) { /* deploy already succeeded */ }
        }
      } catch (e) {
        if (e.code !== 'not_signed_in') throw e;
        if (pane._files && pane._files.size > 0) {
          const vToken = await getOrPromptVercelToken();
          url = await deployToVercel(pane._files, projName, vToken);
          provider = 'Vercel';
        } else {
          const html = cloudFiles['index.html'];
          try {
            const vToken = await getOrPromptVercelToken();
            url = await deployToVercel({ 'index.html': html }, projName, vToken);
            provider = 'Vercel';
          } catch (e2) {
            if (e2.code === 'vercel_token_required') { clearVercelToken(); throw e2; }
            if (e2.message === 'cancelled') { clearInterval(ticker); deployBtn.innerHTML = originalInner; deployBtn.disabled = false; return; }
            url = await deployToNetlify(html);
            provider = 'Netlify';
          }
        }
      }
      clearInterval(ticker);
      deployBtn.innerHTML = '✓';
      deployBtn.title = `Deployed: ${url}`;
      // Show/update persistent Live badge
      pane._deployedUrl = url;
      if (pane.liveBadge) { pane.liveBadge.href = url; pane.liveBadge.style.display = ''; }
      const notification = document.createElement('div');
      notification.style.cssText = `
        position: fixed; bottom: 24px; right: 24px; z-index: 9999;
        background: var(--bg-card); border: 1px solid var(--border-strong);
        border-radius: 8px; padding: 14px 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        font-family: 'Geist', sans-serif; font-size: 0.9rem;
      `;
      const safeUrl = url.replace(/</g, '&lt;');
      notification.innerHTML = `
        <div style="margin-bottom: 8px; font-weight: 600;">Deployed to ${provider}!</div>
        <a href="${safeUrl}" target="_blank" rel="noopener" style="color: var(--signal); text-decoration: none; word-break: break-all;">${safeUrl}</a>
        <button style="margin-top: 8px; display: block; width: 100%; background: rgba(0,0,0,0.04); border: 1px solid var(--border); padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 0.8rem; color: var(--text);">Copy URL</button>
      `;
      const copyBtn = notification.querySelector('button');
      copyBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(url);
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 1500);
      });
      document.body.append(notification);
      setTimeout(() => notification.remove(), 8000);
    } catch (err) {
      clearInterval(ticker);
      deployBtn.innerHTML = '✗';
      deployBtn.title = `Deploy failed: ${err.message}`;
      console.error('Deploy error:', err);
      setTimeout(() => {
        deployBtn.innerHTML = originalInner;
        deployBtn.title = 'Deploy';
        deployBtn.disabled = false;
      }, 2000);
    }
  });
  headRight.append(deployBtn);

  // Persistent "Live →" badge — created once, updated on each successful deploy
  const liveBadge = document.createElement('a');
  liveBadge.className = 'pane-live-badge';
  liveBadge.target = '_blank';
  liveBadge.rel = 'noopener';
  liveBadge.style.display = 'none';
  liveBadge.innerHTML = '🚀 Live →';
  headRight.append(liveBadge);

  // Reset thread — clears history + all turns from this pane.
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'pane-copy-btn';
  resetBtn.title = t('pane.reset_thread');
  resetBtn.setAttribute('aria-label', t('pane.reset_thread'));
  resetBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`;
  resetBtn.addEventListener('click', () => {
    pane.history = [];
    pane.turns = [];
    pane._totalIn = 0;
    pane._totalOut = 0;
    pane.body.innerHTML = '';
    pane.body.append(pane.cursor, pane.spinnerCaption);
    pane.cursor.style.display = 'none';
    stopSpinnerVerbLoop(pane);
    previewBtn.disabled = true;
    previewBtn.title = t('pane.preview_disabled');
    deployBtn.disabled = true;
    deployBtn.style.display = 'none';
    pane.cost.textContent = '';
    pane.editedHtml = null;
    if (pane.editedBadge) pane.editedBadge.style.display = 'none';
    syncTabbedTranscriptChrome(pane);
  });
  headRight.append(resetBtn);

  // Copy-all — concatenates every turn's markdown.
  const copyAll = document.createElement('button');
  copyAll.type = 'button';
  copyAll.className = 'pane-copy-btn';
  copyAll.title = 'Copy full response';
  copyAll.setAttribute('aria-label', 'Copy full response');
  copyAll.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  copyAll.addEventListener('click', async () => {
    const text = pane.turns.map((turn) => turn.accumulatedMd || '').join('\n\n').trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copyAll.classList.add('copied');
      copyAll.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      setTimeout(() => {
        copyAll.classList.remove('copied');
        copyAll.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
      }, 1400);
    } catch {
      copyAll.title = 'Copy failed';
    }
  });
  headRight.append(copyAll);

  head.append(headLeft, headRight);

  const body = document.createElement('div');
  body.className = 'try-pane-body md-body';

  const chatMain = document.createElement('div');
  chatMain.className = 'try-pane-chat-main';

  const genRail = document.createElement('div');
  genRail.className = 'try-pane-gen-rail';
  genRail.setAttribute('role', 'status');
  const genRailMsg = document.createElement('span');
  genRailMsg.className = 'try-gen-rail-msg';
  genRailMsg.setAttribute('aria-live', 'polite');
  const genRailToggle = document.createElement('button');
  genRailToggle.type = 'button';
  genRailToggle.className = 'try-gen-rail-toggle';
  genRailToggle.hidden = true;
  const genRailCodeToggle = document.createElement('button');
  genRailCodeToggle.type = 'button';
  genRailCodeToggle.className = 'try-gen-rail-code-toggle';
  genRailCodeToggle.hidden = true;
  genRailCodeToggle.setAttribute('aria-pressed', 'false');
  const genRailActions = document.createElement('div');
  genRailActions.className = 'try-gen-rail-actions';
  genRailActions.append(genRailCodeToggle, genRailToggle);
  genRail.append(genRailMsg, genRailActions);

  const cursor = document.createElement('span');
  cursor.className = 'typing-cursor';
  cursor.style.display = 'none';
  // Playful waiting verb caption — sits right next to the typing cursor and
  // cycles through SPINNER_VERBS while the pane is streaming. Display is
  // driven by start/stopSpinnerVerbLoop, called at the same sites that toggle
  // pane.cursor.style.display.
  const spinnerCaption = document.createElement('span');
  spinnerCaption.className = 'try-spinner-caption';
  spinnerCaption.style.cssText =
    'display:none; margin-left:8px; font-size:0.85rem; color:var(--text-muted); font-style:italic; vertical-align:middle;';
  body.append(cursor, spinnerCaption);
  chatMain.append(genRail, body);

  genRailToggle.addEventListener('click', () => {
    const p = paneByProvider.get(provider.id);
    if (!p || !isWorkspaceTabbedUi()) return;
    p._showTranscriptWhileRunning = !p._showTranscriptWhileRunning;
    syncTabbedTranscriptChrome(p);
    rerenderAllTabbedTurnsMarkdown(p);
    track('transcript_toggle', { expanded: !!p._showTranscriptWhileRunning });
  });

  genRailCodeToggle.addEventListener('click', () => {
    const p = paneByProvider.get(provider.id);
    if (!p || !isWorkspaceTabbedUi()) return;
    p._showStreamingCodeInTranscript = !p._showStreamingCodeInTranscript;
    syncTabbedTranscriptChrome(p);
    rerenderAllTabbedTurnsMarkdown(p);
    track('stream_code_toggle', { show_code: !!p._showStreamingCodeInTranscript });
  });

  const cost = document.createElement('div');
  cost.className = 'try-pane-cost';

  // Per-pane follow-up row — sits between the body and the cost line.
  // Hidden until the first turn finishes; shown after each successful run.
  const followup = document.createElement('div');
  followup.className = 'try-pane-followup';
  followup.style.display = 'none';
  // Badge: manual code edits from the preview modal — lives outside the follow-up
  // row so it stays visible when tabbed single-composer mode hides that row.
  const editedBadge = document.createElement('div');
  editedBadge.className = 'try-pane-edited';
  editedBadge.style.cssText =
    'display:none; width:100%; font-size:0.78rem; color:var(--signal); padding:0 2px 6px; flex-shrink:0;';
  editedBadge.textContent = t('pane.edits_kept');
  chatMain.append(editedBadge);

  // Thumb strip for follow-up image attachments — sits above the textarea so
  // attached images are visible while composing the next turn. Renders empty
  // until renderFollowupThumbs is called (which only shows it when non-empty).
  const followupThumbsEl = document.createElement('div');
  followupThumbsEl.className = 'try-attach-thumbs';
  followupThumbsEl.style.cssText = 'flex-basis:100%; display:none; margin-bottom:6px;';
  const followupInput = document.createElement('textarea');
  followupInput.placeholder = t('pane.followup_placeholder');
  followupInput.rows = 1;
  followupInput.spellcheck = false;
  // Hidden file input + visible 📎 attach button for the follow-up row.
  // Mirrors the prompt-row pattern so users can pick / paste / drop images
  // into Continue without leaving the pane.
  const followupFileInputEl = document.createElement('input');
  followupFileInputEl.type = 'file';
  followupFileInputEl.accept = 'image/*';
  followupFileInputEl.multiple = true;
  followupFileInputEl.style.display = 'none';
  followupFileInputEl.addEventListener('change', async () => {
    await addFollowupFiles(pane, followupFileInputEl.files);
    followupFileInputEl.value = '';  // allow picking the same file again
  });
  const followupAttachBtn = document.createElement('button');
  followupAttachBtn.type = 'button';
  followupAttachBtn.className = 'try-attach-btn';
  followupAttachBtn.title = t('attach.title');
  followupAttachBtn.setAttribute('aria-label', t('attach.title'));
  followupAttachBtn.innerHTML = '📎';
  followupAttachBtn.addEventListener('click', () => followupFileInputEl.click());
  const followupBtn = document.createElement('button');
  followupBtn.type = 'button';
  followupBtn.textContent = t('pane.continue');
  followupBtn.disabled = true;
  // Wrap textarea + 📎 so the paperclip sits absolutely inside the input box
  // (mirrors the main hero prompt's layout). Without this wrapper they're
  // flex siblings and the paperclip ends up next to the textarea, not in it.
  const followupInputWrap = document.createElement('div');
  followupInputWrap.className = 'try-followup-input-wrap';
  followupInputWrap.append(followupInput, followupAttachBtn);
  followup.append(followupThumbsEl, followupInputWrap, followupBtn, followupFileInputEl);

  function syncFollowupBtn() {
    followupBtn.disabled = !followupInput.value.trim() || pane.busy;
  }
  followupInput.addEventListener('input', syncFollowupBtn);
  followupInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!followupBtn.disabled) followupBtn.click();
    }
  });
  // Paste images directly into the follow-up textarea.
  followupInput.addEventListener('paste', (e) => {
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
      addFollowupFiles(pane, files);
    }
  });
  // Drag-and-drop onto the follow-up row.
  ['dragenter', 'dragover'].forEach((ev) => {
    followup.addEventListener(ev, (e) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      followup.classList.add('try-attach-drag');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    followup.addEventListener(ev, () => followup.classList.remove('try-attach-drag'));
  });
  followup.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    const supported = [...e.dataTransfer.files].filter((f) => f.type && f.type.startsWith('image/'));
    if (!supported.length) return;
    e.preventDefault();
    addFollowupFiles(pane, supported);
  });
  // Shared helper for follow-up runs — used by the Continue button, the
  // element-edit overlay (cmd-click → refine selection), and the auto-fix
  // banner (preview crash → Fix with AI). The optional `source` tag splits
  // these in analytics so we can see which trigger drives follow-ups.
  async function runFollowup(promptText, { source } = {}) {
    if (!promptText || pane.busy) return;
    // Editing a deployed Cloud project (?edit=<id>): route the prompt to the
    // SERVER-side editor agent (cloud-editor.js) instead of the browser agent.
    if (window.__lingcodeEditProjectId) {
      if (pane._editTurnBusy) return;
      await runProjectEditTurn(pane, promptText);
      return;
    }
    // A new user turn supersedes the restored snapshot — hand the preview back to
    // the live transcript scan so the model's edits render instead of the seed.
    pane._seededAuthoritative = false;
    // Advance interact → polish on first manual follow-up
    if (!_firstFollowupDone && (!source || source === 'manual')) {
      _firstFollowupDone = true;
      advanceStep('interact');
    }
    // Snapshot follow-up images and clear the strip BEFORE dispatch — so the
    // strip clears immediately and any attaches that happen during the run
    // belong to the next turn.
    const followupImages = pane._followupImages.slice();
    const followupAssets = new Map(pane._followupAssets);
    pane._followupImages.length = 0;
    pane._followupAssets.clear();
    renderFollowupThumbs(pane);

    track('followup_started', {
      provider: provider.id,
      image_count: followupImages.length,
      had_edits: pane.editedHtml ? 1 : 0,
      source: source || 'manual',
    });

    // Suppress preview-error banner reports during the new turn — partial
    // streamed HTML throws expected errors. Cleared after the turn completes.
    setPreviewBusyForErrors(true);

    const apiKey = (keyInputs.get(provider.id)?.value || '').trim();
    // System prompt was frozen at the initial run; announce any new assets
    // via a user-message prefix so the model knows the new paths exist.
    const newAssetsAddendum = followupAssets.size
      ? buildFollowupAttachmentsAddendum(followupAssets) + '\n\n'
      : '';
    // If the user manually edited the HTML in the Code view, inject it so
    // the model continues from the edited version, not its own last output.
    const editedPrefix = pane.editedHtml
      ? `[Note: I edited the HTML in the playground. Current version below — please continue from this, not your previous output:]\n\n\`\`\`html\n${pane.editedHtml}\n\`\`\`\n\n`
      : '';
    const finalPrompt = newAssetsAddendum + editedPrefix + promptText;
    // Merge new assets BEFORE dispatch so streaming previews can resolve the
    // paths the model writes during this turn — matches the initial-run path.
    if (followupAssets.size) {
      pane._assets = pane._assets
        ? new Map([...pane._assets, ...followupAssets])
        : new Map(followupAssets);
    }
    // Tag the run so the spinner can show polish-specific captions (read in
    // startSpinnerVerbLoop). Cleared in finally so later turns get normal verbs.
    pane._activeRunSource = source || null;
    try {
      await runOneProvider({
        provider, apiKey,
        prompt: finalPrompt,
        images: followupImages,
        // The automatic polish turn appends a refine-don't-restructure brief to
        // the frozen system prompt for this one call only.
        system: source === 'polish' ? (pane.system || '') + polishSystemAddendum() : pane.system,
        tools: pane.tools || [],
        pane,
      });
    } finally {
      // Re-arm error reporting once streaming is done; whether or not the
      // turn succeeded, fresh errors after this point are real, not partial-HTML noise.
      setPreviewBusyForErrors(false);
      pane._activeRunSource = null;
    }
    // The new assistant turn supersedes any prior manual edit.
    pane.editedHtml = null;
    if (pane.editedBadge) pane.editedBadge.style.display = 'none';
    if (provider.proxied) bumpEntitlement();
    syncFollowupBtn();
  }
  followupBtn.addEventListener('click', async () => {
    const followupPrompt = followupInput.value.trim();
    if (!followupPrompt) return;
    followupInput.value = '';
    syncFollowupBtn();
    await runFollowup(followupPrompt);
  });

  // Inline preview column — sits beside the chat in tabbed (Lovable) mode.
  // Hidden in compare-grid mode via CSS. Always present so we don't have
  // to re-attach iframes when the user toggles modes.
  const previewCol = document.createElement('div');
  previewCol.className = 'try-pane-preview';
  const previewBar = document.createElement('div');
  previewBar.className = 'try-pane-preview-bar';
  const previewStatus = document.createElement('span');
  previewStatus.className = 'pp-status';
  previewStatus.textContent = t('workspace.preview_label');
  // File-count badge — shown only for multi-file outputs (e.g. " · 3 files").
  const previewCount = document.createElement('span');
  previewCount.className = 'pp-count';
  previewCount.style.display = 'none';
  previewStatus.append(previewCount);
  const previewActions = document.createElement('span');
  previewActions.className = 'pp-actions';
  const previewExpand = document.createElement('button');
  previewExpand.type = 'button';
  previewExpand.textContent = t('workspace.preview_expand');
  previewExpand.title = t('workspace.preview_expand_title');
  previewExpand.disabled = true;
  previewExpand.addEventListener('click', () => openFullscreenPreview());

  const publishBtn = document.createElement('button');
  publishBtn.type = 'button';
  publishBtn.className = 'pp-publish-btn';
  publishBtn.textContent = '↗ Publish';
  publishBtn.title = 'Publish to a shareable public URL';
  publishBtn.disabled = true;

  async function handlePublish() {
    if (publishBtn.dataset.busy) return;
    publishBtn.dataset.busy = '1';
    const orig = publishBtn.textContent;
    publishBtn.textContent = '…';
    try {
      const latest = pane.turns?.[pane.turns.length - 1];
      // Package the published pane's chat state. The server will gzip+
      // cap-enforce this; we just hand over the plain JSON. Map turns to
      // the serializable shape (drop mdEl DOM nodes which can't round-trip).
      const chatHistory = {
        v: 1,
        providerId: provider.id,
        turns: (pane.turns || []).map((t) => ({
          userText: t.userText || '',
          accumulatedMd: t.accumulatedMd || '',
        })),
        history: pane.history || [],
        system: pane.system || '',
        tools: pane.tools || [],
      };

      // Pre-publish credential scan. If the prototype code or chat history
      // contains anything matching a vendor key prefix, surface a
      // Cancel-by-default modal before the POST goes out. Zero-match path
      // fires onProceed synchronously and is invisible to the user.
      // Save content: prefer pane._files (the authoritative seeded/streamed
      // source). On a reopened single-file project the transcript holds only a
      // collapsed placeholder, so extractLatestRunnableHtml() yields a stub and
      // trips the empty-save guard. Apply live inline (visual) edits so text/style
      // tweaks made in the Visual-edits panel persist into the saved HTML.
      const _saveIsMulti = !!(pane._files && pane._files.size > 1);
      const _saveHtml = _saveIsMulti
        ? null
        : ((pane._files && pane._files.size === 1)
            ? applyInlineEdits([...pane._files.values()][0], pane._inlineEdits)
            : extractLatestRunnableHtml());
      const _saveFiles = _saveIsMulti ? pane._files : null;
      const codeText = _saveIsMulti
        ? [...pane._files.values()].join('\n')
        : (_saveHtml || '');
      await new Promise((resolve, reject) => {
        confirmPublishWithLeakScan({
          scanTargets: [
            { label: 'Prototype code', text: codeText },
            { label: 'Chat history',   text: JSON.stringify(chatHistory) },
          ],
          onProceed: async () => {
            try {
              const result = await publishPrototypeFrom({
                html: _saveHtml,
                files: _saveFiles,
                prompt: latest?.userText || '',
                providerId: provider.id,
                chatHistory,
                thumbnail: await captureLiveThumbnail(pane.previewIframe),
                activePrototypeId: getActivePrototypeId(),
              });
              publishBtn.textContent = '✓ Published';
              showPublishToast(result.url, result.id);
              advanceStep('polish');
              window.dispatchEvent(new CustomEvent('lingcode:prototype-saved', { detail: { id: result.id } }));
              if (result.id) {
                setSecretsActivePrototypeId(result.id);
                persistAppName(result.id);
                startCollab(result.id).catch(() => {});
              }
              setTimeout(() => { publishBtn.textContent = orig; delete publishBtn.dataset.busy; }, 3000);
              resolve();
            } catch (err) {
              // Propagate to the outer try/catch so existing error handling
              // (rate_limited / cap_reached / too_large / unauthorized) runs.
              reject(err);
            }
          },
          onCancel: () => {
            publishBtn.textContent = orig;
            delete publishBtn.dataset.busy;
            resolve();
          },
        });
      });
    } catch (err) {
      publishBtn.textContent = orig;
      delete publishBtn.dataset.busy;
      if (err.code === 'unauthorized') {
        // Snapshot current pane state to IndexedDB and stash a one-shot
        // resume flag so /try.html re-hydrates and auto-retries publish
        // after the user returns from sign-in. Skip the flag if the
        // snapshot save fails — better to lose state than to point the
        // resume flow at a missing checkpoint.
        try {
          const entry = buildCheckpointEntry(
            'pending_publish', '', paneByProvider, backendKind(), currentFolderName()
          );
          entry.prototypeId = getActivePrototypeId() || null; // so resume can re-bind the saved prototype
          await saveCheckpoint(entry);
          sessionStorage.setItem('lingcode.try.resumePublish', JSON.stringify({
            checkpointId: entry.id,
            providerId: provider.id,
            prompt: latest?.userText || '',
          }));
        } catch (e) {
          console.warn('[publish] resume-snapshot failed', e);
        }
        sessionStorage.setItem('lingcode.next', '/try.html');
        window.location.href = '/signin.html?next=/try.html';
        return;
      }
      if (err.code === 'rate_limited') { alert('Rate limit reached — try again in an hour.'); return; }
      if (err.code === 'cap_reached') { alert('50-prototype cap reached. Delete a saved prototype from your account to publish more.'); return; }
      if (err.code === 'too_large') { alert('Prototype is too large to publish.'); return; }
      if (err.code === 'content_too_small') { alert(err.message); return; }
      alert('Publish failed: ' + (err.message || 'unknown'));
    }
  }
  publishBtn.addEventListener('click', handlePublish);

  const mobileToggle = document.createElement('button');
  mobileToggle.type = 'button';
  mobileToggle.className = 'pp-mobile-toggle';
  mobileToggle.title = 'Toggle mobile preview (375px)';
  mobileToggle.textContent = '📱';
  mobileToggle.disabled = true;
  mobileToggle.addEventListener('click', () => {
    pane._mobilePreview = !pane._mobilePreview;
    mobileToggle.classList.toggle('active', pane._mobilePreview);
    previewCol.classList.toggle('mobile-mode', pane._mobilePreview);
    // Reset the last-seen srcdoc fingerprint so updateInlinePreview re-renders
    // at the new viewport width on the next call.
    pane._previewLastSrc = '';
    updateInlinePreview(pane, true);
  });

  previewActions.append(publishBtn, mobileToggle, previewExpand);
  previewBar.append(previewStatus, previewActions);
  // File tab strip — shown only for multi-file outputs. Click swaps the
  // iframe to the selected file. renderInlineFileTabs populates it.
  const previewFileTabs = document.createElement('div');
  previewFileTabs.className = 'pp-file-tabs';
  previewFileTabs.style.display = 'none';
  const previewIframe = document.createElement('iframe');
  previewIframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-same-origin');
  previewIframe.setAttribute('referrerpolicy', 'no-referrer');
  previewIframe.setAttribute('loading', 'lazy');
  previewIframe.style.display = 'none';
  const previewEmpty = document.createElement('div');
  previewEmpty.className = 'pp-empty';
  previewEmpty.textContent = t('workspace.preview_empty');
  // Streaming skeleton — shown while pane.busy AND no extractable HTML yet,
  // hidden the moment the iframe takes over. Pure CSS state machine driven
  // by .streaming + .has-preview classes on previewCol.
  const previewSkeleton = document.createElement('div');
  previewSkeleton.className = 'pp-skeleton';
  previewSkeleton.innerHTML = `
    <div class="sk-bar w-60"></div>
    <div class="sk-bar w-80"></div>
    <div class="sk-bar h-block"></div>
    <div class="sk-bar w-40"></div>
    <div class="sk-bar h-tall"></div>
    <div class="sk-bar w-80"></div>
    <div class="sk-caption" aria-live="polite">
      <span class="sk-caption-dot" aria-hidden="true"></span>
      <span class="sk-caption-text">${t('workspace.preview_loading')}</span>
    </div>
  `;
  // Swarm build progress animation — shown while pane.previewCol has .swarm-building class
  const previewSwarm = document.createElement('div');
  previewSwarm.className = 'pp-swarm';
  // 3-stage orb row (Architect/Coder/Reviewer) was redundant with the
  // global swarm stage bar at the top of /try, especially under N-pane
  // races where every pane duplicated it. Just the title + running
  // message now; updatePaneSwarmStage()'s orb-class update silently
  // no-ops on the missing [data-stage] elements.
  previewSwarm.innerHTML = `
    <div class="pp-swarm-inner">
      <div class="pp-swarm-title">Building your app</div>
      <div class="pp-swarm-msg">Initializing pipeline...</div>
    </div>
  `;
  // Inline error banner — shown when the preview iframe throws an unhandled error.
  const previewErrorBanner = document.createElement('div');
  previewErrorBanner.className = 'pp-error-banner';
  previewErrorBanner.hidden = true;
  const previewErrorMsg = document.createElement('span');
  previewErrorMsg.className = 'pp-error-msg';
  const previewErrorActions = document.createElement('div');
  previewErrorActions.className = 'pp-error-actions';
  const previewErrorFix = document.createElement('button');
  previewErrorFix.type = 'button';
  previewErrorFix.className = 'pp-error-fix';
  previewErrorFix.textContent = 'Fix with AI';
  const previewErrorDismiss = document.createElement('button');
  previewErrorDismiss.type = 'button';
  previewErrorDismiss.className = 'pp-error-dismiss';
  previewErrorDismiss.setAttribute('aria-label', 'Dismiss error');
  previewErrorDismiss.textContent = '✕';
  previewErrorActions.append(previewErrorFix, previewErrorDismiss);
  previewErrorBanner.append(previewErrorMsg, previewErrorActions);

  previewErrorFix.addEventListener('click', () => {
    const errCtx = pane._lastInlineError;
    if (!errCtx) return;
    hideInlinePreviewError(pane);
    const stack = errCtx.stack ? `\nStack:\n\`\`\`\n${errCtx.stack}\n\`\`\`\n` : '';
    const fixPrompt =
      `The preview crashed.\n\nError: ${errCtx.message}${stack}\n` +
      `Fix the issue and output the FULL updated prototype. Do not change unrelated layout or behavior — minimal targeted fix only.`;
    runFollowup(fixPrompt, { source: 'auto_fix' });
  });
  previewErrorDismiss.addEventListener('click', () => hideInlinePreviewError(pane));

  previewCol.append(previewBar, previewFileTabs, previewEmpty, previewSkeleton, previewSwarm, previewErrorBanner);

  const MOBILE_PREVIEW_W = 375;

  // ─── Inline preview as a top-level overlay ────────────────────────────
  // Both WebKit and Blink refuse to paint an <iframe> nested inside the
  // workspace's rounded, overflow-clipped containers (.try-pane / .try-shell):
  // the document parses and is fully readable, but it never composites — the
  // pane stays blank until a window resize forces a re-composite. (Diagnosed
  // exhaustively: the identical iframe paints instantly the moment it's a child
  // of <body>.) So the preview iframe is mounted at the top level (position:
  // fixed) and kept aligned over the column's rectangle — the same reason the
  // Expand modal always renders.
  document.body.appendChild(previewIframe);
  Object.assign(previewIframe.style, {
    position: 'fixed', display: 'none', border: '0', margin: '0',
    background: '#fff', zIndex: '4',
  });

  let _ovKey = '';
  const syncPreviewOverlay = () => {
    if (!previewCol.isConnected) { previewIframe.remove(); return false; }
    const r = previewCol.getBoundingClientRect();
    const shown =
      previewCol.offsetParent !== null &&
      previewCol.classList.contains('has-preview') &&
      r.width > 2 && r.height > 2 &&
      r.bottom > 0 && r.top < window.innerHeight &&
      r.right > 0 && r.left < window.innerWidth;
    const mobile = !!pane?._mobilePreview;
    const w = shown ? (mobile ? Math.min(MOBILE_PREVIEW_W, r.width) : r.width) : 0;
    const left = mobile ? r.left + Math.round((r.width - w) / 2) : r.left;
    // Fill the available vertical space (column top → viewport bottom) rather
    // than the column's own (often short) natural height, so the preview is a
    // real, tall viewport — what the removed scaling code used to force. At
    // least as tall as the column; never past the viewport bottom.
    const availH = shown ? Math.max(Math.round(r.height), Math.round(window.innerHeight - r.top - 12)) : 0;
    const key = shown ? Math.round(r.top) + '|' + Math.round(left) + '|' + Math.round(w) + '|' + availH : 'hidden';
    if (key === _ovKey) return true;
    _ovKey = key;
    const st = previewIframe.style;
    if (!shown) { st.display = 'none'; return true; }
    st.top = Math.round(r.top) + 'px';
    st.left = Math.round(left) + 'px';
    st.width = Math.round(w) + 'px';
    st.height = availH + 'px';
    st.display = 'block';
    return true;
  };
  // A rAF loop is the only thing robust against every layout shift (chat
  // growth, the progress bar, mode switches, scroll). One getBoundingClientRect
  // + a guarded style write per frame; self-terminates (removing the orphaned
  // iframe) when the pane is detached.
  const rafSyncOverlay = () => { if (syncPreviewOverlay()) requestAnimationFrame(rafSyncOverlay); };
  requestAnimationFrame(rafSyncOverlay);
  new ResizeObserver(syncPreviewOverlay).observe(previewCol);
  window.addEventListener('scroll', syncPreviewOverlay, true);
  window.addEventListener('resize', syncPreviewOverlay);
  window.addEventListener('message', (e) => {
    if (e.source !== previewIframe.contentWindow || e.data?.type !== '__lc_ifrh') return;
    previewIframe._fill = !!e.data.fill;
  });

  wrap.append(head, chatMain, followup, cost, previewCol);
  panesEl.append(wrap);
  pane = {
    wrap, head, headRight, chatMain, body, cost, cursor, spinnerCaption,
    genRail, genRailMsg, genRailToggle, genRailCodeToggle,
    previewBtn, deployBtn, liveBadge, followup, followupInput, followupBtn, syncFollowupBtn, editedBadge,
    previewCol, previewIframe, previewEmpty, previewExpand, publishBtn, mobileToggle,
    previewFileTabs, previewCount, previewSwarm,
    _mobilePreview: false,
    previewErrorBanner, previewErrorMsg,
    _lastInlineError: null,
    runFollowup,
    _previewLastSrc: '',
    _previewScrolled: false,
    _files: null,
    _activeFile: null,
    _fileTabsFingerprint: '',
    turns: [],            // [{ userText, mdEl, accumulatedMd }]
    history: [],          // provider-shape messages persisted across turns
    editedHtml: null,     // user-edited HTML from the Code view; merged into the next follow-up
    system: '',
    tools: [],
    busy: false,
    latencyStart: 0,
    finalCostUsd: null,
    finalLatencyMs: null,
    // Follow-up image attachments — staged here between paste/drop/picker and
    // the next runFollowup call. Cleared at dispatch; assets merge into _assets.
    _followupImages: [],
    _followupAssets: new Map(),
    _followupThumbsEl: followupThumbsEl,
  };
  paneByProvider.set(provider.id, pane);
  attachMonacoToggle(pane, updateInlinePreview);
  // Register a tab in the workspace strip and make this pane active if it's
  // the first to land. Workspace becomes visible on first pane creation.
  registerTab(provider, pane);
  return pane;
}

// Cached evaluator / rubric payloads (cleared whenever panes wipe).
let _lastRunPrompt = '';
let _lastRunResponses = [];
/** User-visible prompts across continuation turns (judge grounding). */
let _conversationPromptLog = '';
const TRY_FOCUS_SNOOZE_KEY = 'try-build-focus-snooze';
const VERCEL_TOKEN_KEY = 'lingcode.try.vercel.token';
function getVercelToken() { return localStorage.getItem(VERCEL_TOKEN_KEY) || null; }
function saveVercelToken(t) { localStorage.setItem(VERCEL_TOKEN_KEY, t); }
function clearVercelToken() { localStorage.removeItem(VERCEL_TOKEN_KEY); }
function promptForVercelToken() {
  return new Promise((resolve, reject) => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;';
    ov.innerHTML = `<div style="background:var(--bg-card);border:1px solid var(--border-strong);border-radius:12px;padding:24px;width:400px;max-width:90vw;font-family:'Geist',sans-serif;">
      <div style="font-weight:600;margin-bottom:6px;">Vercel API Token</div>
      <div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:14px;">Get yours at <a href="https://vercel.com/account/tokens" target="_blank" rel="noopener" style="color:var(--signal);">vercel.com/account/tokens</a>. Saved locally — never stored on LingCode servers.</div>
      <input type="password" placeholder="Paste token here…" style="width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid var(--border-strong);border-radius:6px;font-size:0.88rem;background:var(--bg);color:var(--text);margin-bottom:12px;font-family:'Geist Mono',monospace;" />
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button data-a="cancel" style="padding:7px 14px;border:1px solid var(--border);border-radius:6px;background:transparent;cursor:pointer;font-size:0.82rem;color:var(--text-muted);">Cancel</button>
        <button data-a="save" style="padding:7px 16px;border:none;border-radius:6px;background:var(--signal);color:#fff;cursor:pointer;font-size:0.82rem;font-weight:500;">Save &amp; Deploy</button>
      </div>
    </div>`;
    const inp = ov.querySelector('input');
    ov.querySelector('[data-a="save"]').addEventListener('click', () => { const v = inp.value.trim(); if (!v) return; ov.remove(); saveVercelToken(v); resolve(v); });
    ov.querySelector('[data-a="cancel"]').addEventListener('click', () => { ov.remove(); reject(new Error('cancelled')); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ov.querySelector('[data-a="save"]').click(); });
    document.body.appendChild(ov);
    inp.focus();
  });
}
async function getOrPromptVercelToken() {
  return getVercelToken() || await promptForVercelToken();
}

function clearWinnerDecorations() {
  for (const [, p] of paneByProvider) {
    if (!p?.wrap || !p.headRight) continue;
    p.wrap.classList.remove('winner-cheap', 'winner-fast');
    p.headRight.querySelectorAll('.winner-tag').forEach((el) => el.remove());
  }
}

const workspaceFocusBtn = document.getElementById('workspace-focus-toggle');
const workspaceFocusCloseBtn = document.getElementById('workspace-focus-close');

function syncTryBuildFocusToggle() {
  if (workspaceFocusBtn) {
    const on = document.body.classList.contains('try-build-focus');
    workspaceFocusBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    workspaceFocusBtn.textContent = t('workspace.focus_enter');
    workspaceFocusBtn.title = t('workspace.focus_enter_title');
  }
  if (workspaceFocusCloseBtn && !EMBED_MODE) {
    workspaceFocusCloseBtn.setAttribute('aria-label', t('workspace.focus_close_aria'));
    workspaceFocusCloseBtn.title = t('workspace.focus_exit_title');
  }
}

function setTryBuildFocus(on, { fromUser = false } = {}) {
  if (EMBED_MODE) return;
  if (fromUser && on) sessionStorage.removeItem(TRY_FOCUS_SNOOZE_KEY);
  document.body.classList.toggle('try-build-focus', !!on);
  syncTryBuildFocusToggle();
  requestAnimationFrame(() => updateTryTabbedMobileGeom());
}

function maybeAutoTryBuildFocus(anyOutput) {
  if (EMBED_MODE || !anyOutput) return;
  if (sessionStorage.getItem(TRY_FOCUS_SNOOZE_KEY) === '1') return;
  if (document.body.classList.contains('try-build-focus')) return;
  setTryBuildFocus(true);
}

if (!EMBED_MODE && workspaceFocusBtn) {
  workspaceFocusBtn.addEventListener('click', () => {
    if (document.body.classList.contains('try-build-focus')) return;
    sessionStorage.removeItem(TRY_FOCUS_SNOOZE_KEY);
    setTryBuildFocus(true, { fromUser: true });
  });
}
if (!EMBED_MODE && workspaceFocusCloseBtn) {
  workspaceFocusCloseBtn.addEventListener('click', () => {
    sessionStorage.setItem(TRY_FOCUS_SNOOZE_KEY, '1');
    setTryBuildFocus(false, { fromUser: true });
  });
}
if (!EMBED_MODE && (workspaceFocusBtn || workspaceFocusCloseBtn)) syncTryBuildFocusToggle();
syncTryTabbedNarrowUi();

// Inject Swarm Build toggle into the prompt row
if (sendBtn && sendBtn.parentNode) {
  sendBtn.parentNode.insertBefore(swarmToggle, sendBtn);
}

// Inject stage bar above the panes
if (panesEl && panesEl.parentNode) {
  panesEl.parentNode.insertBefore(swarmStageBar, panesEl);
}

function clearPanes() {
  for (const p of paneByProvider.values()) stopSpinnerVerbLoop(p);
  panesEl.innerHTML = '';
  paneByProvider.clear();
  // Tabbed workspace state lives in parallel — wipe it too, otherwise
  // stale tabs point at panes that no longer exist.
  if (workspaceTabsEl) workspaceTabsEl.innerHTML = '';
  tabByProvider.clear();
  activeProviderId = null;
  syncTopbarProvider();
  if (workspaceEl) workspaceEl.hidden = true;
  if (canvasBodyEl) canvasBodyEl.hidden = true;
  if (progressBarEl) progressBarEl.hidden = true;
  // Note: checklist reset was here, but it wiped the direction gate's
  // analyze/plan/platforms/data/designs progress when clearPanes() ran
  // post-gate (line 3322). Callers that need a reset (swarm path,
  // user-cancelled gate) call resetChecklist() explicitly.
  _firstFollowupDone = false;
  // Drop cached run state — a fresh main-Run shouldn't re-judge stale
  // responses if the user hits Re-judge before the new race finishes.
  _lastRunPrompt = '';
  _lastRunResponses = [];
  _conversationPromptLog = '';
  document.getElementById('try-rubric')?.remove();
  document.getElementById('try-verdict')?.remove();
  syncTrySessionChrome();
}

// Checkpoint dialog moved to main-checkpoint-dialog.js. mount call below.
// Projects panel moved to main-projects-panel.js. mount call at top.
// ---- History Compression ----
function trimHistory(history) {
  if (!Array.isArray(history) || history.length < 4) {
    return { trimmed: history, droppedCount: 0 };
  }
  const msgLens = history.map(m => JSON.stringify(m).length + 1);
  const totalLen = msgLens.reduce((a, b) => a + b, 0) + 2;
  if (totalLen <= CONTEXT_CHAR_BUDGET) {
    return { trimmed: history, droppedCount: 0 };
  }
  let prefixLen = 0;
  for (let i = 0; i < history.length - 2; i++) {
    prefixLen += msgLens[i];
    if (history[i + 1]?.role === 'user' && (totalLen - prefixLen) <= CONTEXT_CHAR_BUDGET) {
      return { trimmed: history.slice(i + 1), droppedCount: i + 1 };
    }
  }
  return { trimmed: history.slice(-2), droppedCount: history.length - 2 };
}

function showContextTrimNotice(pane, history, droppedCount) {
  pane.body.querySelector('.context-trim-notice')?.remove();
  if (!droppedCount) return;
  const droppedUserCount = history.slice(0, droppedCount).filter(m => m.role === 'user').length;
  const notice = document.createElement('div');
  notice.className = 'context-trim-notice';
  notice.innerHTML = `✂&nbsp; ${droppedUserCount} older turn${droppedUserCount !== 1 ? 's' : ''} not sent to AI (context window limit)`;
  const turnEls = [...pane.body.querySelectorAll(':scope > .turn')];
  const anchor = turnEls[droppedUserCount] || pane.body.firstChild;
  if (anchor) pane.body.insertBefore(notice, anchor);
  else pane.body.appendChild(notice);
}

// ---- Run! ----
const emptyEl = document.getElementById('empty');

// ---- Swarm Build Handler ----
// `prompt` is the model-facing build prompt (may carry an [Approved scope]
// preamble from the Direction gate); `rawPrompt` is the user's original text,
// used for the transcript so the scope block doesn't leak into the UI.
async function runSwarmBuild(prompt, rawPrompt = prompt) {
  track('swarm_build_started', {
    prompt_chars: rawPrompt.length,
    provider_count: selected.size,
  });

  sendBtn.disabled = true;
  sendBtn.textContent = t('prompt.running');
  sendBtn.classList.add('send-btn-loading');
  document.body.classList.add('running');
  swarmStageBar.style.display = 'flex';

  if (emptyEl) emptyEl.style.display = 'none';

  // Clear panes for fresh run. Swarm bypasses the direction gate, so the
  // checklist has no progress to preserve here — reset it explicitly.
  // (clearPanes() itself no longer resets — see comment in clearPanes.)
  clearPanes();
  resetChecklist();
  _conversationPromptLog = rawPrompt;

  try {
    // Check if local server is available (for Phase 1)
    const serverAvailable = await checkLocalSwarmServer();

    if (serverAvailable) {
      // Use server-side swarm
      await runSwarmViaServer(prompt, rawPrompt);
    } else {
      // Fallback to browser-side swarm
      await runSwarmViaBrowser(prompt, rawPrompt);
    }

    signalRunComplete();
    awardWinners();
    updateSendState();
    maybeAutoTryBuildFocus([...paneByProvider.values()].some((p) => p.body?.querySelector('.turn')));
    runJudge(rawPrompt);
  } catch (error) {
    console.error('Swarm build error:', error);
    // Show error to user
    const errorMsg = document.createElement('div');
    errorMsg.style.cssText = `
      padding: 12px; margin-top: 12px;
      background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3);
      border-radius: 6px; color: var(--text); font-size: 0.9rem;
    `;
    errorMsg.textContent = `Error: ${error.message}`;
    panesEl.parentNode.insertBefore(errorMsg, panesEl);
  } finally {
    sendBtn.classList.remove('send-btn-loading');
    sendBtn.disabled = false;
    document.body.classList.remove('running');
    swarmStageBar.style.display = 'none';
    refreshMainSendButtonLabel();
  }
}

async function checkLocalSwarmServer() {
  // Check production server (https://lingcode.dev/server)
  // Can't check localhost:7878 directly from HTTPS due to browser security
  try {
    const res = await fetch('https://lingcode.dev/server/v1/ping', {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function runSwarmViaServer(prompt, rawPrompt = prompt) {
  // Pick best available provider (first selected with valid API key)
  let selectedProvider = null;
  for (const id of selected) {
    const p = PROVIDERS.find((pr) => pr.id === id);
    const key = (keyInputs.get(id)?.value || '').trim();
    if (p && (p.proxied || key)) {
      selectedProvider = p;
      break;
    }
  }

  // Fallback: default to deepseek or first available
  if (!selectedProvider) {
    selectedProvider = PROVIDERS.find((p) => p.id === 'deepseek') || PROVIDERS[0];
  }

  const providerId = selectedProvider?.id || 'deepseek';

  // Call server's /v1/swarm/build endpoint via HTTPS
  const serverUrl = 'https://lingcode.dev/server/v1/swarm/build';
  const buildId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(7);

  const res = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${localStorage.getItem('lingcode-server-token') || ''}`,
    },
    body: JSON.stringify({
      prompt,
      provider: providerId,
      buildId,
    }),
  });

  if (!res.ok) {
    throw new Error(`Server error: ${res.status}`);
  }

  // Process SSE stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Create a single pane for server results
  const pane = ensurePane(selectedProvider);

  // Activate swarm build progress animation in the preview pane
  pane.previewCol.classList.add('swarm-building');
  pane.previewSwarm?.querySelectorAll('.pp-stage').forEach(el => {
    el.className = 'pp-stage pp-stage-pending';
  });
  if (pane.previewSwarm) {
    pane.previewSwarm.querySelector('.pp-swarm-msg').textContent = 'Initializing pipeline...';
  }

  const turn = document.createElement('div');
  turn.className = 'turn';
  const userLine = document.createElement('div');
  userLine.className = 'turn-user';
  userLine.textContent = `› ${rawPrompt}`;
  const mdEl = document.createElement('div');
  mdEl.className = 'md';
  turn.append(userLine, mdEl);
  pane.body.insertBefore(turn, pane.cursor);
  const turnState = { userText: rawPrompt, mdEl, accumulatedMd: '' };
  pane.turns.push(turnState);
  syncAllPaneFollowupRows();

  try {
    let currentEvent = null;
    let currentData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim() === '') {
          // Empty line = end of event
          if (currentEvent && currentData) {
            console.log(`[Swarm SSE] ${currentEvent}:`, currentData); // DEBUG
            if (currentEvent === 'stage_change') {
              console.log(`[Swarm Stage] ${currentData.stage} → ${currentData.status}`); // DEBUG
              updateSwarmStageBar(currentData.stage, currentData.status);
              updatePaneSwarmStage(pane, currentData.stage, currentData.status);

              // Display architect spec when available
              if (currentData.stage === 'architect' && currentData.status === 'done' && currentData.spec) {
                const specMarkdown = `\`\`\`json\n${JSON.stringify(currentData.spec, null, 2)}\n\`\`\``;
                mdEl.innerHTML = renderMarkdown(specMarkdown);
                pane.body.scrollTop = pane.body.scrollHeight;
              }
            } else if (currentEvent === 'code_generated' && currentData.code) {
              turnState.accumulatedMd = currentData.code;
              mdEl.innerHTML = renderMarkdown(`\`\`\`html\n${currentData.code}\n\`\`\``);

              // Detect server-side build failure (swarm-coordinator returns
              // <h1>Build Failed</h1> + error when provider call throws).
              if (/<h1>Build Failed<\/h1>/i.test(currentData.code)) {
                const errMatch = currentData.code.match(/<p>([^<]*)<\/p>/);
                const errMsg = errMatch ? errMatch[1] : 'Unknown error';
                alert(`⚠️ Build Failed\n\n${errMsg}\n\nTry a different provider, or sign in for higher limits.`);
              }

              // Code is ready — drop the overlay immediately so the iframe
              // can render. The reviewer is still streaming in the background
              // but doesn't need to block the preview.
              pane.previewCol.classList.remove('swarm-building');

              // Extract HTML using the same fence-tolerant logic as extractStreamingHtml
              try {
                let htmlCode = currentData.code || '';
                const fenceIdx = htmlCode.toLowerCase().lastIndexOf('```html');
                if (fenceIdx >= 0) {
                  let body = htmlCode.slice(fenceIdx + 7).replace(/^[^\n]*\n?/, '');
                  const closeIdx = body.indexOf('```');
                  if (closeIdx >= 0) body = body.slice(0, closeIdx);
                  htmlCode = body;
                } else {
                  // No html fence — check for bare <!doctype
                  const doctypeIdx = htmlCode.toLowerCase().indexOf('<!doctype html');
                  if (doctypeIdx >= 0) htmlCode = htmlCode.slice(doctypeIdx);
                }
                openPreview({ html: htmlCode.trim(), providerName: selectedProvider.name });
              } catch (e) {
                console.warn('Preview rendering failed:', e);
              }

              pane.body.scrollTop = pane.body.scrollHeight;
            }
          }
          currentEvent = null;
          currentData = null;
        } else if (line.startsWith('event:')) {
          currentEvent = line.replace('event:', '').trim();
        } else if (line.startsWith('data:')) {
          try {
            currentData = JSON.parse(line.replace('data:', '').trim());
          } catch (e) {
            console.error('Failed to parse SSE data:', line, e);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
    // Clean up swarm build animation state
    pane.previewCol.classList.remove('swarm-building');
  }

  // Mark pane complete
  if (pane.latencyStart) {
    pane.finalLatencyMs = performance.now() - pane.latencyStart;
  }
}

async function runSwarmViaBrowser(prompt, rawPrompt = prompt) {
  // Fallback: browser-side swarm (existing implementation)
  const selectedProviders = [...selected]
    .map((id) => ({
      provider: PROVIDERS.find((p) => p.id === id),
      apiKey: (keyInputs.get(id)?.value || '').trim(),
    }))
    .filter((p) => p.provider && (p.provider.proxied || p.apiKey));

  if (selectedProviders.length === 0) {
    throw new Error('No providers with credentials available');
  }

  // Run browser swarm pipeline
  // Architect-stage live panel: streams the spec as it's written so the user
  // sees progress instead of staring at empty panes for ~30s during Architect.
  // Removed when Coder starts (its panes take over the visible space).
  let _architectPanel = null;
  function ensureArchitectPanel() {
    if (_architectPanel) return _architectPanel;
    _architectPanel = document.createElement('div');
    _architectPanel.id = 'lc-architect-panel';
    _architectPanel.style.cssText = [
      'margin:10px 0', 'padding:12px 14px',
      'border:1px solid var(--border)', 'border-radius:10px',
      'background:rgba(124,58,237,0.04)', 'font-family:var(--font-mono,monospace)',
      'font-size:11px', 'line-height:1.5', 'color:var(--text-muted)',
      'max-height:160px', 'overflow:auto', 'white-space:pre-wrap',
    ].join(';');
    const head = document.createElement('div');
    head.style.cssText = 'font-weight:600;color:var(--accent,#7c3aed);margin-bottom:6px;font-family:system-ui,sans-serif;font-size:12px;';
    head.textContent = '◆ Architect is designing the spec…';
    const body = document.createElement('div');
    body.id = 'lc-architect-body';
    _architectPanel.append(head, body);
    panesEl.parentNode.insertBefore(_architectPanel, panesEl);
    return _architectPanel;
  }
  function removeArchitectPanel() {
    if (_architectPanel?.parentElement) _architectPanel.parentElement.removeChild(_architectPanel);
    _architectPanel = null;
  }

  await runSwarmPipeline({
    userPrompt: prompt,
    selectedProviders,
    onStageChange: (stage) => {
      updateSwarmStageBar(stage.stage, stage.status);
      if (stage.stage === 'coder' || stage.stage === 'complete') removeArchitectPanel();
    },
    onArchitectStream: (specSoFar) => {
      const panel = ensureArchitectPanel();
      const body = panel.querySelector('#lc-architect-body');
      // Tail: only show last 1200 chars so the panel doesn't grow unbounded
      body.textContent = specSoFar.length > 1200
        ? '…' + specSoFar.slice(-1200)
        : specSoFar;
      body.scrollTop = body.scrollHeight;
    },
    onCoderEvent: (providerId, event) => {
      // Route to pane
      const pane = paneByProvider.get(providerId);
      if (!pane) {
        const provider = PROVIDERS.find((p) => p.id === providerId);
        if (provider) {
          const newPane = ensurePane(provider);
          const turn = document.createElement('div');
          turn.className = 'turn';
          const userLine = document.createElement('div');
          userLine.className = 'turn-user';
          userLine.textContent = `› ${rawPrompt}`;
          const mdEl = document.createElement('div');
          mdEl.className = 'md';
          turn.append(userLine, mdEl);
          newPane.body.insertBefore(turn, newPane.cursor);
          const turnState = { userText: rawPrompt, mdEl, accumulatedMd: event.text || '' };
          newPane.turns.push(turnState);
          mdEl.innerHTML = renderMarkdown(event.text || '');
        }
      } else if (event.kind === 'text' && pane.turns.length > 0) {
        const turn = pane.turns[pane.turns.length - 1];
        turn.accumulatedMd += event.text || '';
        turn.mdEl.innerHTML = renderMarkdown(turn.accumulatedMd);
        pane.body.scrollTop = pane.body.scrollHeight;
      }
    },
  });

  // Mark panes complete
  for (const pane of paneByProvider.values()) {
    if (pane.latencyStart && !pane.finalLatencyMs) {
      pane.finalLatencyMs = performance.now() - pane.latencyStart;
    }
  }
}

const SUGGEST_RULES = [
  { pattern: /chart|graph|recharts|chart\.js|echarts|d3\.|sparkline/i,        chips: ['Add more data points', 'Add filters', 'Make it interactive'] },
  { pattern: /<form|input.*type|submit|login|signup|register/i,               chips: ['Add form validation', 'Add success state', 'Make it multi-step'] },
  { pattern: /class="slide|pitch.?deck|presentation/i,                        chips: ['Add slide animations', 'Add speaker notes', 'Export as PDF'] },
  { pattern: /landing|hero.*section|pricing|cta|call.to.action/i,             chips: ['Add dark mode', 'Make it mobile responsive', 'Add scroll animations'] },
  { pattern: /table|<tr|<td|data.?grid|sortable/i,                            chips: ['Add search / filter', 'Add pagination', 'Add CSV export'] },
  { pattern: /map|leaflet|mapbox|geojson|latitude|longitude/i,                chips: ['Add search by location', 'Add clustering', 'Add a legend'] },
  { pattern: /kanban|board|task|todo|drag/i,                                   chips: ['Add due dates', 'Add labels', 'Add drag-and-drop'] },
  { pattern: /stripe|checkout|payment|price.*plan|tier/i,                     chips: ['Add annual billing toggle', 'Add FAQ section', 'Add testimonials'] },
  { pattern: /supabase|firebase|database|auth|session/i,                      chips: ['Add error handling', 'Add loading states', 'Add logout'] },
  { pattern: /react|vue|angular|svelte|component/i,                           chips: ['Add unit tests', 'Add TypeScript types', 'Add Storybook story'] },
];
const DEFAULT_SUGGEST_CHIPS = ['Add dark mode', 'Make it mobile responsive', 'Add more detail'];

function injectSuggestionChips(pane, md) {
  // Remove any previous chips for this pane
  pane.followup.querySelector('.pane-suggest-chips')?.remove();

  const matched = SUGGEST_RULES.find((r) => r.pattern.test(md));
  const chips = matched ? matched.chips : DEFAULT_SUGGEST_CHIPS;

  const row = document.createElement('div');
  row.className = 'pane-suggest-chips';

  for (const chip of chips) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'suggest-chip';
    btn.textContent = chip;
    btn.addEventListener('click', () => {
      if (pane.followupInput) {
        pane.followupInput.value = chip;
        pane.followupInput.dispatchEvent(new Event('input', { bubbles: true }));
        pane.followupInput.focus();
      }
      row.remove();
    });
    row.appendChild(btn);
  }

  // Insert at top of the follow-up container (before thumbs / input)
  pane.followup.insertBefore(row, pane.followup.firstChild);
}

function imageGenSystemAddendum() {
  return `\n\nYou have a generate_image tool. Call it whenever the design needs any visual — hero images, illustrations, icons, backgrounds, product photos, avatars. Pass a rich descriptive prompt (style, subject, lighting, palette). The tool returns JSON with a "url" field; embed it as <img src="[url]" alt="[description]" ...> in the HTML. Always size images appropriately with width/height attributes or CSS. Never use placeholder.com or picsum — use generate_image instead.`;
}

async function execToolWithImages(tc) {
  const { name, args } = tc;
  if (name === 'generate_image') {
    const { prompt, width = 1024, height = 1024 } = args || {};
    if (!prompt) return JSON.stringify({ error: 'prompt is required' });
    const encoded = encodeURIComponent(prompt);
    const seed = Math.floor(Math.random() * 9999999);
    const url = `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&nologo=true&seed=${seed}`;
    return JSON.stringify({ url, prompt, width, height });
  }
  if (CLOUD_TOOL_NAMES.has(name)) return execCloudTool(tc);
  // Guard against hallucinated tools. Some upstreams (notably Kimi/Moonshot)
  // emit calls to tools we never advertised — e.g. the native IDE's
  // `run_terminal_command`, which doesn't exist in the web playground. Without
  // this, execTool() throws "Unknown tool", the model retries the same bogus
  // call, and the build burns all its turns producing nothing (empty preview).
  // Return an instructive error so the model abandons the tool and writes the
  // result inline instead. KNOWN names = fs.js dispatch + image + cloud/supabase.
  if (name !== 'read_file' && name !== 'write_file' && name !== 'list_files') {
    return JSON.stringify({
      error: `Unknown tool "${name}" — not available in this environment. ` +
        `Available tools: read_file, write_file, list_files, generate_image. ` +
        `Do not call this tool again; produce the result directly in your response.`,
    });
  }
  return execTool(tc);
}

// First credentialed provider among the selected set — the same provider/key
// the build will use, reused for the Direction-summary gate's one-shot call.
// Returns null when nothing is credentialed (caller then skips the gate).
function pickGateProvider() {
  for (const id of selected) {
    if (!providerHasCredentials(id)) continue;
    const provider = PROVIDERS.find((p) => p.id === id);
    if (!provider) continue;
    return { provider, apiKey: (keyInputs.get(id)?.value || '').trim() };
  }
  return null;
}

sendBtn.addEventListener('click', async () => {
  const prompt = promptEl.value.trim();
  if (!prompt) return;
  // Project-edit mode (?edit=<id>): the visible composer routes here via
  // mountChatInput (which already posted the user bubble). Send the prompt to the
  // SERVER-side editor agent instead of the browser agent, and stop.
  if (window.__lingcodeEditProjectId) {
    promptEl.value = '';
    promptEl.dispatchEvent(new Event('input', { bubbles: true }));
    const editPane = [...paneByProvider.values()][0];
    if (editPane && !editPane._editTurnBusy) await runProjectEditTurn(editPane, prompt, { userPosted: true });
    return;
  }
  const imagesForRun = attachedImages.slice();
  const assetsForRun = new Map(attachedAssets);
  const docsForRun = attachedDocs.slice();
  const continuing = paneByProvider.size > 0;

  // Clear composer once the payload is copied — transcript holds the prompt.
  promptEl.value = '';
  promptEl.dispatchEvent(new Event('input', { bubbles: true }));

  // Direction-summary gate: on the first prompt of a fresh session, confirm
  // scope before building. Skipped in demo mode and when no provider is
  // credentialed. `buildPrompt` carries the approved-scope preamble downstream;
  // the raw `prompt` is preserved for the transcript.
  let buildPrompt = prompt;
  if (!continuing && !DEMO_MODE) {
    const gateTarget = pickGateProvider();
    if (gateTarget) {
      // Add try-scope-focus BEFORE revealing the canvas so the full-screen CSS
      // (body.try-scope-focus main.try-shell { position:fixed }) fires in the
      // same paint as the canvas becoming visible. Without this, the shell
      // stays in document flow (footer/MORE OPTIONS visible) until the class
      // is set, producing a flicker.
      document.body.classList.add('try-scope-focus');
      // Reveal canvas + workspace so the chat column is visible for the
      // direction-gate message flow. The "Your app appears here" placeholder
      // is hidden via CSS (body.try-scope-focus .try-preview-empty) so the
      // preview area stays blank; it appears when code generation starts.
      if (canvasBodyEl?.hidden) canvasBodyEl.hidden = false;
      if (workspaceEl?.hidden)  workspaceEl.hidden  = false;
      if (progressBarEl?.hidden) progressBarEl.hidden = false;
      // Checklist: start at "Analyze idea"
      setStep('analyze', 'active');
      let result;
      try {
        result = await runDirectionGate({ prompt, provider: gateTarget.provider, apiKey: gateTarget.apiKey });
      } catch (e) {
        // Quota / sign-in abort from the gate: the paywall modal and a chat
        // message were already surfaced upstream (agent.js + main-direction.js).
        // Reset the UI and stop cleanly rather than building with empty scope
        // or leaving an unhandled rejection. (The send spinner isn't armed yet
        // at this point, so there's nothing to un-stick.)
        resetChecklist();
        _firstFollowupDone = false;
        promptEl.value = prompt;
        promptEl.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      } finally {
        document.body.classList.remove('try-scope-focus');
      }
      if (!result || !result.approved) {
        // User cancelled — reset checklist back to pending
        resetChecklist();
        _firstFollowupDone = false;
        promptEl.value = prompt;                         // restore composer
        promptEl.dispatchEvent(new Event('input', { bubbles: true }));
        return;                                          // clean abort
      }
      buildPrompt = result.scopeBlock + '\n\n' + prompt;
      console.group('[build-style] final build prompt assembled');
      console.log('[build-style] scopeBlock:', (result.scopeBlock || '').length, 'chars | original prompt:', prompt.length, 'chars');
      console.log('[build-style] design present:', !!result.design, result.design ? `("${result.design.name}", html ${(result.design.html || '').length} chars)` : '');
      console.log('[build-style] final buildPrompt:', buildPrompt.length, 'chars');
      console.groupEnd();
      // Direction gate complete. advanceStep('designs') normally fires when
      // the user picks a style (main-design.js). If the gate dismissed
      // without a pick (e.g. runDesignGate threw and was swallowed), designs
      // would still be 'active' — use advanceStep here as a safety floor so
      // designs transitions to 'done' and scaffold becomes 'active' without
      // leaving two purple dots.
      advanceStep('designs');
      window.__logComposerRect?.('main.js after gate complete (post advanceStep designs)');
    }
    // gateTarget == null → no credentialed provider; skip the gate, build raw.
  }

  window.__logComposerRect?.('main.js before build dispatch');

  // Branch on swarm mode
  if (getSwarmBuildMode() && !continuing) {
    await runSwarmBuild(buildPrompt, prompt);
    return;
  }

  track('run_started', {
    prompt_chars: prompt.length,
    provider_count: selected.size,
    has_workspace: hasWorkspace() ? 1 : 0,
    image_count: imagesForRun.length,
    pdf_count: docsForRun.length,
    continuation: continuing ? 1 : 0,
  });
  sendBtn.disabled = true;
  sendBtn.textContent = t('prompt.running');
  sendBtn.classList.add('send-btn-loading');
  document.body.classList.add('running');
  if (emptyEl) emptyEl.style.display = 'none';
  for (const p of paneByProvider.values()) p._autoOpenedPreview = false;

  if (!continuing) {
    clearPanes();
    _conversationPromptLog = prompt;
  } else {
    _conversationPromptLog = _conversationPromptLog
      ? `${_conversationPromptLog}\n\n---\n\n${prompt}`
      : prompt;
  }

  clearWinnerDecorations();

  const fsAvailable = hasWorkspace();
  const baseSystem = fsAvailable
    ? `You are a build-and-write assistant in a browser playground — code, documents, slides, plans, anything the user asks for. The user has granted access to a workspace folder named "${currentFolderName()}"; use the read_file/write_file/list_files tools when (and only when) the task actually needs them. Reply in the language of the user's prompt unless they ask otherwise. Be concise on explanations; be complete on deliverables.`
    : `You are a build-and-write assistant in a browser playground — code, documents, slides, plans, anything the user asks for. The user has not granted filesystem access, so you cannot read or write files; answer using only your knowledge. Reply in the language of the user's prompt unless they ask otherwise. Be concise on explanations; be complete on deliverables.`;

  const runnable = [...selected].filter(providerHasCredentials);
  const runs = runnable.map((id) => {
    const provider = PROVIDERS.find((p) => p.id === id);
    if (!provider) return null;
    const apiKey = (keyInputs.get(id)?.value || '').trim();
    const pane = ensurePane(provider);

    pane._assets = pane._assets
      ? new Map([...pane._assets, ...assetsForRun])
      : new Map(assetsForRun);

    let userPrompt = buildPrompt;

    if (continuing) {
      const newAssetsAddendum = assetsForRun.size ? buildFollowupAttachmentsAddendum(assetsForRun) + '\n\n' : '';
      const editedPrefix = pane.editedHtml
        ? `[Note: I edited the HTML in the playground. Current version below — please continue from this, not your previous output:]\n\n\`\`\`html\n${pane.editedHtml}\n\`\`\`\n\n`
        : '';
      userPrompt = `${newAssetsAddendum}${editedPrefix}${prompt}`;
    }

    const needsBootstrap = !pane.turns || pane.turns.length === 0;
    if (!continuing || needsBootstrap) {
      const systemParts = `${baseSystem}${docModeAddendum()}${looksLikeDeck(prompt) ? deckAddendum() : ''}${looksLikeLiquidTheme(prompt) ? shopifyLiquidAddendum() : (looksLikeShopify(prompt) ? shopifyPolarisAddendum() : '')}${stackSystemAddendum(currentStack)}${supabaseSystemAddendum()}${backendSystemAddendum()}${(!cloudToolsActive() && getNavAuthSignedIn() === true) ? cloudProvisionAddendum() : ''}${knowledgeSystemAddendum()}${seoSystemAddendum()}${siteConfigSystemAddendum()}${inlineEditsSystemAddendum(pane._inlineEdits || [])}${imageGenSystemAddendum()}`;
      const attachmentsPart = attachmentsAddendum(pane._assets);
      pane.system = systemParts + attachmentsPart;
      pane.tools = fsAvailable ? [...TOOLS, ...IMAGE_TOOLS] : [...IMAGE_TOOLS];
    }

    console.log('[build-style] kicking off runOneProvider:', provider?.name || provider?.id, '| prompt has design marker:', (userPrompt || '').includes('[Approved design direction'));
    return runOneProvider({
      provider,
      apiKey,
      prompt: userPrompt,
      images: imagesForRun,
      docs: docsForRun,
      system: pane.system,
      tools: pane.tools || [],
      pane,
    });
  }).filter(Boolean);

  clearAttachedImages();
  clearAttachedDocs();

  console.log('[build-style] awaiting', runs.length, 'provider run(s)…');
  window.__logComposerRect?.('main.js after build dispatch (runs started)');
  // Probe again on the next frame — class/layout changes that move the composer
  // often land after styles/reflow settle, not synchronously on dispatch.
  requestAnimationFrame(() => window.__logComposerRect?.('main.js next-frame after dispatch'));
  await Promise.allSettled(runs);
  console.log('[build-style] all provider run(s) settled');
  window.__logComposerRect?.('main.js after all runs settled');
  // Checklist: scaffold complete → "Build interactions" becomes active.
  // (continuing runs advance interact → polish instead)
  if (!continuing) {
    // The build's first run finished — tell the building screen to dismiss now
    // (it stays up for the whole build, not just the first partial render).
    window.dispatchEvent(new CustomEvent('lingcode:build-preview-ready'));
    // Did anything actually build? If every pane errored or returned no runnable
    // HTML, don't march the checklist to "✓ Complete" — that lies about a failed
    // build (and leaves a forever-counting ETA). Surface a failed state instead.
    const builtSomething = runnable.some((id) => {
      const p = paneByProvider.get(id);
      return p && extractLatestRunnableHtmlFromPane(p);
    });
    if (!builtSomething) {
      failChecklist("Build didn't finish — revise your prompt above and try again.");
    } else {
      advanceStep('scaffold');
      // ── Real "Final polish" — one automatic refine pass per pane that produced
      // usable output, making the checklist's last two steps actual model work
      // (Build interactions → Final polish) instead of publish-time decoration.
      // Guards: runs once per build (pane._polished), skips truncated/empty output,
      // and is skipped entirely on continuing/follow-up runs (else branch).
      advanceStep('interact');
      const polishTargets = runnable
        .map((id) => paneByProvider.get(id))
        .filter((p) => p && !p._polished && p._stopReason !== 'max_tokens' && extractLatestRunnableHtmlFromPane(p));
      for (const p of polishTargets) p._polished = true;
      if (polishTargets.length) {
        await Promise.allSettled(polishTargets.map((p) =>
          p.runFollowup('Do a final polish pass on the app you just built — refine only, do not restructure.', { source: 'polish' })));
      }
      advanceStep('polish');
    }
  } else {
    advanceStep('interact');
  }

  for (const id of runnable) {
    const pane = paneByProvider.get(id);
    if (!pane) continue;
    pane.editedHtml = null;
    if (pane.editedBadge) pane.editedBadge.style.display = 'none';
  }

  sendBtn.classList.remove('send-btn-loading');
  sendBtn.disabled = false;
  document.body.classList.remove('running');
  refreshMainSendButtonLabel();

  const macCta = document.getElementById('mac-cta');
  const anyOutput = [...paneByProvider.values()].some(
    (p) => p.body && p.body.querySelector('.turn'),
  );
  track('run_completed', {
    output: anyOutput ? 1 : 0,
    truncated: [...paneByProvider.values()].some((p) => p._stopReason === 'max_tokens') ? 1 : 0,
    multi_file: [...paneByProvider.values()].some((p) => {
      const lt = p.turns && p.turns[p.turns.length - 1];
      const f = lt && extractFiles(lt.accumulatedMd);
      return f && f.size > 1;
    }) ? 1 : 0,
    continuation: continuing ? 1 : 0,
  });
  if (macCta && macCta.hidden) {
    if (anyOutput) {
      macCta.hidden = false;
      macCta.classList.add('first-reveal');
      track('mac_cta_shown');
      setTimeout(() => {
        try {
          macCta.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch {}
      }, 250);
      setTimeout(() => macCta.classList.remove('first-reveal'), 4200);
    }
  }
  signalRunComplete();
  if ([...selected].some((id) => PROVIDERS.find((p) => p.id === id)?.proxied)) bumpEntitlement();
  maybeAutoTryBuildFocus(anyOutput);
  awardWinners();
  updateSendState();
  if (document.body.classList.contains('try-tabbed-narrow-ui')) updateTryTabbedMobileGeom();
  if (!DEMO_MODE) {
    runJudge(_conversationPromptLog || prompt);
  }
});

/// Renders the Rubric panel + verdict card after panes settle. Triggers
/// the appropriate judge (LLM single-score, LLM weighted, or local code)
/// based on the user's saved rubric. Re-judge fires when the rubric
/// changes — no need to re-stream the panes.
async function runJudge(originalPrompt) {
  const completed = [...paneByProvider.entries()]
    .filter(([, p]) => p.finalLatencyMs != null && p.turns.length)
    .map(([id, p]) => ({
      id,
      provider: PROVIDERS.find((x) => x.id === id),
      providerName: PROVIDERS.find((x) => x.id === id)?.name || id,
      text: p.turns.map((tn) => tn.accumulatedMd).join('\n\n'),
    }));
  if (completed.length < 2) return;
  _lastRunPrompt = originalPrompt;
  _lastRunResponses = completed;

  ensureRubricPanel();
  const card = ensureVerdictCard();
  await dispatchJudge(card, completed, originalPrompt);
}

/// Renders the Rubric panel above the verdict card. Re-renders only when
/// the panel doesn't exist yet — its internal state is in localStorage.
function ensureRubricPanel() {
  let panel = document.getElementById('try-rubric');
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = 'try-rubric';
  // Sit above the verdict card so the user can read the rubric, then see
  // its effect below. Insert before the panes' next sibling so it ends up
  // adjacent to where the verdict card lives.
  panesEl.parentNode.insertBefore(panel, panesEl.nextSibling);
  renderRubricPanel(panel, t, () => {
    if (!_lastRunResponses.length) return;
    const card = ensureVerdictCard();
    dispatchJudge(card, _lastRunResponses, _lastRunPrompt);
  });
  return panel;
}

/// Picks the judge implementation based on the active rubric mode.
async function dispatchJudge(card, completed, prompt) {
  const rubric = loadRubric(t);
  setVerdictPlaceholder(card, t('eval.judging'));

  let result = null;
  if (rubric.mode === 'code') {
    // Local JS — instant, no LLM call.
    const out = runCodeJudge(rubric.code, prompt, completed.map((c) => ({
      id: c.id, providerName: c.providerName, text: c.text,
    })));
    if (out?.error) {
      card.classList.add('failed');
      setVerdictPlaceholder(card, out.error);
      return;
    }
    result = out;
  } else if (rubric.mode === 'weighted') {
    const sysPrompt = buildWeightedSystemPrompt(rubric.criteria);
    const raw = await judgeRun({
      prompt,
      responses: completed.map((c) => ({ id: c.id, text: c.text })),
      systemOverride: sysPrompt,
    });
    if (raw) result = applyWeights(raw, rubric.criteria);
  } else {
    // Quick mode (preset + custom text) — single-score judge.
    const addendum = buildSingleScoreAddendum(rubric);
    result = await judgeRun({
      prompt,
      responses: completed.map((c) => ({ id: c.id, text: c.text })),
      rubricExtra: addendum,
    });
  }

  if (!result) {
    card.classList.add('failed');
    setVerdictPlaceholder(card, t('eval.judge_failed'));
    return;
  }
  renderVerdict(card, result, completed);

  // Trigger DB schema sidecar concurrently — don't await it.
  // Use the winner's code for schema generation.
  const winner = completed.find((c) => c.id === result.winner);
  if (winner) {
    const code = extractRunnable(winner.text) || winner.text;
    runDbSidecar(prompt || '', code).catch((e) => console.error('DB sidecar error:', e));
  }
}

function ensureVerdictCard() {
  let card = document.getElementById('try-verdict');
  if (card) {
    card.classList.remove('failed');
    card.innerHTML = '';
    return card;
  }
  card = document.createElement('div');
  card.id = 'try-verdict';
  card.className = 'try-verdict-card';
  panesEl.parentNode.insertBefore(card, panesEl.nextSibling);
  return card;
}

function setVerdictPlaceholder(card, msg) {
  card.innerHTML = `
    <div class="verdict-head">
      <span class="verdict-icon">⚖️</span>
      <span class="verdict-title">${t('eval.verdict_title')}</span>
      <span class="verdict-status">${escapeHtml(msg)}</span>
    </div>`;
}

function renderVerdict(card, result, completed) {
  const winnerProvider = PROVIDERS.find((p) => p.id === result.winner);
  const winnerName = winnerProvider?.name || result.winner;
  const verdictsById = new Map((result.verdicts || []).map((v) => [v.id, v]));
  // Sort verdict rows in pane display order so the card mirrors the grid.
  const rows = completed.map(({ id, provider }) => {
    const v = verdictsById.get(id);
    return `
      <div class="verdict-row">
        <span class="name">${escapeHtml(provider?.name || id)}</span>
        ${v ? `<span class="score">${t('eval.score_label', v.score ?? '–')}</span>` : ''}
        <span class="note">${escapeHtml(v?.note || '')}</span>
      </div>`;
  }).join('');
  card.innerHTML = `
    <div class="verdict-head">
      <span class="verdict-icon">⚖️</span>
      <span class="verdict-title">${t('eval.verdict_title')}</span>
    </div>
    <div class="verdict-winner">
      <span class="winner-label">${t('eval.winner_label')}</span>
      <span class="winner-name">${escapeHtml(winnerName)}</span>
      <span class="winner-reason">${escapeHtml(result.winner_reason || '')}</span>
    </div>
    <div class="verdict-rationale">${rows}</div>`;

  // Update SONA-Lite: learn which provider won for this prompt
  const winnerVerdict = verdictsById.get(result.winner);
  if (winnerVerdict && _lastRunPrompt) {
    const rubricScore = winnerVerdict.score ?? 5.0;
    SONA.update(_lastRunPrompt, result.winner, rubricScore);
  }
}

// DB schema sidecar moved to main-db-sidecar.js.
// After all runs finish, look at completed panes and award:
//   • cheap badge → lowest finalCostUsd (excluding free LingModel and zero-cost)
//   • fast badge  → lowest finalLatencyMs
function awardWinners() {
  const completed = [...paneByProvider.entries()]
    .map(([id, pane]) => ({ id, pane }))
    .filter((x) => x.pane.finalLatencyMs != null);
  if (completed.length < 2) return;
  // Cheapest among priced runs only — LingModel is $0 by design, would always win.
  const priced = completed.filter((x) => x.pane.finalCostUsd != null && x.pane.finalCostUsd > 0);
  if (priced.length >= 2) {
    const cheapest = priced.reduce((a, b) => (a.pane.finalCostUsd <= b.pane.finalCostUsd ? a : b));
    decoratePane(cheapest.pane, 'cheap', t('pane.cheapest'));
  }
  const fastest = completed.reduce((a, b) => (a.pane.finalLatencyMs <= b.pane.finalLatencyMs ? a : b));
  decoratePane(fastest.pane, 'fast', t('pane.fastest'));
}

function decoratePane(pane, kind, label) {
  pane.wrap.classList.add(`winner-${kind}`);
  const tag = document.createElement('span');
  tag.className = `winner-tag ${kind}`;
  tag.textContent = label;
  pane.headRight.insertBefore(tag, pane.headRight.firstChild);
}

async function runOneProvider({ provider, apiKey, prompt, images = [], docs = [], system, tools = [], pane }) {
  // When the active prototype has a live LingCode Cloud backend, let the model
  // drive it directly (create tables, run migrations, inspect schema). Computed
  // fresh each run so provisioning mid-session takes effect without a reload,
  // and applied here so every call site (initial, follow-up, retry) benefits.
  // Cloud and Supabase tool sets are mutually exclusive — apply_migration /
  // query_database names overlap — and a prototype uses one backend.
  // Offer the cloud toolset when a backend is live, OR when the user could
  // provision one (signed-in + this prototype is saved) — so the agent can call
  // provision_backend itself, then apply_migration, with no manual console step.
  // The non-provision tools 409 until provisioned; the model is told to call
  // provision_backend first, so ordering works within a single run.
  const _cloudCanProvision = !cloudToolsActive() && getNavAuthSignedIn() === true;
  if ((cloudToolsActive() || _cloudCanProvision) && !tools.some((t) => CLOUD_TOOL_NAMES.has(t.name))) {
    tools = [...tools, ...CLOUD_TOOLS];
  }

  // Auto-checkpoint: snapshot all panes before this run mutates state.
  if (paneByProvider.size > 0) {
    (async () => {
      try {
        const entry = buildCheckpointEntry('auto', '', paneByProvider, backendKind(), currentFolderName());
        entry.prototypeId = getActivePrototypeId() || null; // so resume can re-bind the saved prototype
        await saveCheckpoint(entry);
        refreshHistoryPanel();
      } catch (e) { console.warn('[ckpt] auto-save failed', e); }
    })();
  }

  pane.busy = true;
  pane.followup?.querySelector('.pane-suggest-chips')?.remove();
  pane._showTranscriptWhileRunning = true;
  pane._showStreamingCodeInTranscript = false;
  pane._genActivityLine = '';
  syncTabbedTranscriptChrome(pane);
  pane.followupBtn.disabled = true;
  pane.previewBtn.disabled = true;
  pane.previewBtn.title = t('pane.preview_disabled');
  setTabStatus(provider.id, 'running');
  // Streaming-state class on the inline preview column → CSS swaps the
  // empty caption for a pulsing skeleton until extractable HTML lands.
  if (pane.previewCol) pane.previewCol.classList.add('streaming');
  // Disable main Run while ANY pane is mid-flight so a stray click doesn't
  // call clearPanes() and orphan the streaming DOM.
  updateSendState();

  // Each call appends a new `.turn` block (user message header + an .md
  // element to stream the assistant response into). Older turns stay
  // visible above so the pane reads as a chat transcript.
  const turn = document.createElement('div');
  turn.className = 'turn';
  const userLine = document.createElement('div');
  userLine.className = 'turn-user';
  userLine.textContent = `› ${prompt}`;
  // Attached images render as small inline thumbnails on the user line so
  // each pane's chat reads naturally. For providers without vision support
  // we still show them — the chat reflects what the user attached, even if
  // the model didn't see them.
  if (images && images.length) {
    const thumbs = document.createElement('div');
    thumbs.className = 'turn-user-thumbs';
    if (!provider.vision && images.length) {
      const tag = document.createElement('span');
      tag.className = 'turn-user-novision';
      tag.textContent = t('attach.novision_tag', provider.name);
      thumbs.append(tag);
    }
    for (const im of images) {
      const i = document.createElement('img');
      i.src = im.dataUrl;
      i.alt = im.name || 'image';
      i.title = im.name || 'image';
      i.className = 'turn-user-thumb';
      thumbs.append(i);
    }
    userLine.append(thumbs);
  }
  // Attached PDFs render as small filename chips so the chat history shows
  // what was attached. Native Anthropic gets raw PDF (document content
  // block); other providers get extracted text — handled in agent.js.
  if (docs && docs.length) {
    const docChips = document.createElement('div');
    docChips.className = 'turn-user-thumbs';
    for (const d of docs) {
      const chip = document.createElement('span');
      chip.className = 'turn-user-thumb';
      chip.style.fontSize = '0.72rem';
      chip.style.padding = '2px 8px';
      chip.style.lineHeight = '1.5';
      chip.title = `${d.name} · ${(d.text.length / 1024).toFixed(1)} KB extracted`;
      chip.textContent = `📄 ${d.name}`;
      docChips.append(chip);
    }
    userLine.append(docChips);
  }
  const mdEl = document.createElement('div');
  mdEl.className = 'md';
  turn.append(userLine, mdEl);
  pane.body.insertBefore(turn, pane.cursor);
  pane.cursor.style.display = '';
  startSpinnerVerbLoop(pane);
  pane.body.scrollTop = pane.body.scrollHeight;

  const turnState = { userText: prompt, mdEl, accumulatedMd: '' };
  pane.turns.push(turnState);
  syncAllPaneFollowupRows();

  pane.cost.innerHTML = '<span class="spin"></span><span style="color:var(--text-muted);">' + t('pane.contacting', provider.name) + '</span>';
  pane.latencyStart = performance.now();

  // Cumulative tokens across the WHOLE pane conversation, since cost is shown
  // in the footer (one line) and ought to reflect the running total.
  let totalIn = pane._totalIn || 0;
  let totalOut = pane._totalOut || 0;
  let firstByteAt = 0;
  let renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      turnState.mdEl.innerHTML = renderMarkdown(mdForTabbedSidebar(pane, turnState.accumulatedMd));
      addCopyButtons(turnState.mdEl);
      pane.body.scrollTop = pane.body.scrollHeight;
    });
  }

  const { trimmed: historyToSend, droppedCount: historyDropped } = trimHistory(pane.history);
  showContextTrimNotice(pane, pane.history, historyDropped);

  try {
    await runAgent({
      provider, apiKey, userPrompt: prompt, userImages: images, userDocs: docs,
      priorMessages: historyToSend,
      system, tools,
      executor: tools.length ? execToolWithImages : null,
      onEvent: (e) => {
        if (e.kind === 'text') {
          if (!firstByteAt) {
            firstByteAt = performance.now();
            updateCostLine(pane, provider, totalIn, totalOut, firstByteAt, true);
          }
          turnState.accumulatedMd += e.text;
          scheduleRender();
          // Push the streaming HTML into the inline workspace iframe for
          // this pane (throttled inside updateInlinePreview).
          updateInlinePreview(pane);
          // Live preview: if the modal is already open for this pane, push
          // the partial HTML extracted from the streaming buffer into the
          // iframe. Throttled to ~350ms to avoid srcdoc thrash. Multi-file
          // takes priority — if the parser sees ```html name=foo blocks
          // we route through the files-aware streamer; otherwise fall back
          // to the single-file path.
          const nowTs = performance.now();
          if (nowTs - (pane._lastLivePreview || 0) > 350) {
            pane._lastLivePreview = nowTs;
            const files = extractFiles(turnState.accumulatedMd);
            if (files && files.size > 1) {
              // Auto-open the preview the first time multi-file output
              // appears — only safe when exactly one provider is running
              // (otherwise "whose modal wins?" is ambiguous). Gated per-turn
              // so we don't reopen on every text event.
              if (selected.size === 1 && !pane._autoOpenedPreview) {
                pane._autoOpenedPreview = true;
                openPreview({
                  files, assets: pane._assets, paneBodyEl: pane.body, providerName: provider.name,
                  sourcePrompt: prompt, providerId: provider.id,
                });
                track('preview_opened', { provider: provider.id, multi_file: 1, file_count: files.size, auto: 1 });
              }
              maybeStreamUpdateFiles(pane.body, files);
            } else {
              const partial = extractStreamingHtml(turnState.accumulatedMd);
              if (partial && partial.length > 80) maybeStreamUpdate(pane.body, partial);
            }
          }
        } else if (e.kind === 'tool_call') {
          turnState.accumulatedMd += `\n\n\`\`\`tool\n${e.name}(${shortArgs(e.args)})\n\`\`\`\n\n`;
          pane._genActivityLine = t('pane.running_tool', e.name);
          syncTabbedTranscriptChrome(pane);
          scheduleRender();
        } else if (e.kind === 'tool_result') {
          pane._genActivityLine = '';
          syncTabbedTranscriptChrome(pane);
          // Truncate so a 200KB read_file doesn't drown the pane.
          const max = 240;
          const out = e.result.length > max ? e.result.slice(0, max) + '…' : e.result;
          turnState.accumulatedMd += `\`\`\`tool-result\n${out}\n\`\`\`\n\n`;
          scheduleRender();
        } else if (e.kind === 'usage') {
          totalIn += e.inputTokens;
          totalOut += e.outputTokens;
          updateCostLine(pane, provider, totalIn, totalOut, firstByteAt);
        } else if (e.kind === 'history') {
          // Persist for the next follow-up turn.
          pane.history = e.messages;
        } else if (e.kind === 'final') {
          pane._stopReason = e.stopReason || null;
          updateCostLine(pane, provider, totalIn, totalOut, firstByteAt);
        }
      },
    });
    rerenderAllTabbedTurnsMarkdown(pane);
  } catch (err) {
    const errBox = document.createElement('div');
    errBox.className = 'err';
    errBox.textContent = err?.message || String(err);
    turn.append(errBox);
    pane.cost.textContent = t('pane.error');
    setTabStatus(provider.id, 'error');
    // The user message + error stay visible in the DOM so the user sees
    // what failed, but drop the turnState from the array so Copy-all and
    // Preview don't pick up a half-rendered ghost turn.
    const idx = pane.turns.indexOf(turnState);
    if (idx >= 0) pane.turns.splice(idx, 1);
  } finally {
    pane.cursor.style.display = 'none';
    stopSpinnerVerbLoop(pane);
    pane._totalIn = totalIn;
    pane._totalOut = totalOut;
    pane.finalCostUsd = estimateCostUSD(provider, totalIn, totalOut);
    pane.finalLatencyMs = Math.round(performance.now() - pane.latencyStart);
    pane.busy = false;
    syncTabbedTranscriptChrome(pane);
    if (pane.previewCol) pane.previewCol.classList.remove('streaming');
    // Status: keep error if we set it in catch; otherwise mark done.
    if (!tabByProvider.get(provider.id)?.btn.classList.contains('is-error')) {
      setTabStatus(provider.id, 'done');
    }
    // Final inline-preview pump after streaming settles, so the iframe
    // reflects the complete output even if the throttled mid-stream call
    // dropped the last chunk.
    updateInlinePreview(pane, /* force */ true);

    // Show the follow-up row + enable preview if the latest turn has any
    // HTML/CSS/JS code blocks.
    syncAllPaneFollowupRows();
    pane.syncFollowupBtn();
    if (extractLatestRunnableHtmlFromPane(pane)) {
      pane.previewBtn.disabled = false;
      pane.previewBtn.title = '';
      // Also enable the deploy button for static HTML apps
      pane.deployBtn.disabled = false;
      pane.deployBtn.style.display = '';
    } else if (turnState.accumulatedMd && !tabByProvider.get(provider.id)?.btn.classList.contains('is-error')) {
      // Turn finished cleanly but emitted no runnable HTML (prose/plan only) —
      // explain the dead Expand button instead of leaving a silent gray control.
      pane.previewBtn.title = 'No runnable app in the last reply — ask for the complete app (e.g. "give me the full HTML file").';
    }
    // Re-enable main Run if no other pane is still streaming.
    updateSendState();

    // AI follow-up suggestion chips — heuristic chips based on output content.
    if (turnState.accumulatedMd && pane.followup && pane.followup.style.display !== 'none') {
      injectSuggestionChips(pane, turnState.accumulatedMd);
    }

    // Per-pane quality evaluation — parse check is sync, runtime check
    // spins up a hidden iframe and resolves async. Both render small
    // inline badges next to the cost line. Skipped on errored runs.
    if (turnState.accumulatedMd && pane.finalLatencyMs != null) {
      attachQualityBadges(pane);
    }
  }
}

/// Renders parse/runtime quality badges into pane.cost. The badges are
/// independent — parse is synchronous, runtime takes ~1.5s while a hidden
/// iframe loads and listens for error events.
function attachQualityBadges(pane) {
  // Surface "hit max_tokens" before the parse verdict — otherwise a clean
  // half-CSS gets a misleading "✓ parses" or "no code" badge with no signal
  // that the model was cut off mid-output by the LingModel free-tier cap.
  if (pane._stopReason === 'max_tokens') {
    const truncBadge = document.createElement('span');
    truncBadge.className = 'pane-quality-badge warn';
    truncBadge.innerHTML = `<span>${t('eval.truncated')}</span>`;
    truncBadge.title = 'The model hit the output token cap mid-response. On LingModel free tier this is 24K tokens; Pro is 64K. BYOK requests follow your provider key\'s cap.';
    pane.cost.append(truncBadge);
    // One-click continuation — drives the existing follow-up flow with a
    // prompt that tells the model to resume from exactly where it stopped.
    // History (which includes the truncated assistant message) gives the
    // model the context it needs to pick up.
    const contBtn = document.createElement('button');
    contBtn.type = 'button';
    contBtn.className = 'pane-continue-btn';
    contBtn.textContent = '↳ ' + t('hint.continue_run');
    contBtn.title = 'Ask the model to keep writing from where the cap cut it off.';
    contBtn.addEventListener('click', () => triggerTruncationContinue(pane));
    pane.cost.append(contBtn);
  }

}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function updateCostLine(pane, provider, totalIn, totalOut, firstByteAt, streaming = false) {
  const usd = estimateCostUSD(provider, totalIn, totalOut);
  const ttft = firstByteAt ? Math.round(firstByteAt - pane.latencyStart) : null;
  const totalMs = Math.round(performance.now() - pane.latencyStart);
  const parts = [
    `↑ ${totalIn.toLocaleString()}`,
    `↓ ${totalOut.toLocaleString()}`,
    formatCost(usd),
    ttft != null ? `${ttft}ms ttft` : null,
    `${totalMs}ms total`,
  ].filter(Boolean);
  if (streaming) {
    pane.cost.innerHTML = '<span class="spin"></span>' + parts.join(' · ');
  } else {
    pane.cost.textContent = parts.join(' · ');
  }
  // Mirror the running cost into the workspace tab badge so users see the
  // price without switching to that pane.
  setTabCost(provider.id, formatCost(usd));
}

function shortArgs(args) {
  const s = JSON.stringify(args);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

// Run-complete signal — title ping for users on another tab, soft chime
// for users on this one. Both best-effort. Played once per click of the
// main Run button (not per-pane follow-up).
const ORIGINAL_TITLE = typeof document !== 'undefined' ? document.title : '';
function signalRunComplete() {
  // Tab title ping if the user is on another tab. Reverts on focus.
  if (document.hidden) {
    document.title = '✓ ' + ORIGINAL_TITLE;
    const restore = () => {
      document.title = ORIGINAL_TITLE;
      document.removeEventListener('visibilitychange', restore);
    };
    document.addEventListener('visibilitychange', restore);
  }

  // Soft two-note chime via Web Audio. Quiet (gain 0.05) and ~250ms.
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);            // A5
    osc.frequency.linearRampToValueAtTime(1175, ctx.currentTime + 0.12);  // ~D6
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 0.02);
    gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
    setTimeout(() => ctx.close().catch(() => {}), 400);
  } catch { /* audio context blocked; silent is fine */ }
}

// Extract the in-progress HTML body from a streaming markdown buffer.
// Finds the latest ```html opener and returns everything after it, up to a
// closing fence if present, otherwise to the end. Empty string if no
// ```html block has appeared yet.
function extractStreamingHtml(md) {
  if (!md) return '';
  const idx = md.toLowerCase().lastIndexOf('```html');
  if (idx < 0) return '';
  let body = md.slice(idx + 7).replace(/^[^\n]*\n?/, '');  // drop the rest of the opener line
  const closeIdx = body.indexOf('```');
  if (closeIdx >= 0) body = body.slice(0, closeIdx);
  return body;
}

// Multi-file extractor: scans for ```html name=foo.html ... ``` blocks and
// returns a Map<filename, content>. Returns null if no named blocks are
// found (caller falls back to single-file extractStreamingHtml). Tolerates
// streams in flight — an unclosed final block is still captured.
function extractFiles(md) {
  if (!md) return null;
  const files = new Map();
  // Match ```<lang> name=<file> [optional whitespace] \n <body> ``` (or end-of-string)
  const re = /```([A-Za-z0-9_-]+)\s+name=(\S+)[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const name = m[2].replace(/^["']|["']$/g, '');  // strip quotes if any
    files.set(name, m[3]);
  }
  return files.size > 0 ? files : null;
}

// Inject a copy button into every <pre> in the rendered markdown that
// doesn't have one already. Re-rendering blows away DOM each chunk, so we
// re-inject every render. Cheap — pre count per response is small.
function addCopyButtons(root) {
  const pres = root.querySelectorAll('pre');
  for (const pre of pres) {
    if (pre.querySelector('.copy-btn')) continue;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.textContent = t('copy.idle');
    btn.setAttribute('aria-label', 'Copy code to clipboard');
    pre.append(btn);
  }
}

// Single delegated click handler — survives re-renders since it's bound on
// the document.
document.addEventListener('click', async (e) => {
  const btn = e.target?.closest?.('.copy-btn');
  if (!btn) return;
  const pre = btn.closest('pre');
  if (!pre) return;
  // Grab the code text WITHOUT the button itself.
  const code = pre.querySelector('code') ?? pre;
  const text = (code.innerText || '').replace(/\s*Copy\s*$/, '');
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = t('copy.done');
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = t('copy.idle');
      btn.classList.remove('copied');
    }, 1500);
  } catch (_) {
    btn.textContent = t('copy.failed');
    setTimeout(() => { btn.textContent = t('copy.idle'); }, 1500);
  }
});

// ---- Demo mode bootstrap ----------------------------------------------
// /try.html?demo=1 (optionally &task=<id>) — see main-demo-mode.js for
// the actual flow.
mountDemoMode({
  DEMO_MODE, DEMO_TASK, EMBED_MODE, SLOWMO,
  selected, toggles, _demoScenarioProviders, saveSelection,
  paneByProvider, promptEl, sendBtn, updateSendState,
});

// ---- Dashboard / app view hash router ---------------------------------
// parseTryHash / setTryView / routeFromHash / renderDashboard live in
// main-router.js now; mounted below (after mountAppTopbar) via mountRouter().
// The router's setTryView calls an injected onView(mode) hook so chip polling
// still starts/stops on every view change — see the mount site near the chips.

// Dashboard inline prompt → seed the legacy #prompt textarea + click #send.
// Same send-flow as the in-app empty state; we just present the input where
// first-time visitors actually see it. Flip to app-view first so the
// streaming pane has a visible parent when it mounts.
function _submitDashPrompt() {
  const dashInput = document.getElementById('dash-prompt');
  const txt = (dashInput?.value || '').trim();
  if (!txt) {
    dashInput?.focus();
    return;
  }

  const proxiedProviderSelected = [...selected].some(
    (id) => PROVIDERS.find((p) => p.id === id)?.proxied,
  );

  // --- Sign-in gate (managed provider only) --------------------------------
  // If using LingModel, the user must be signed in — anonymous free-trial runs
  // are intentionally not allowed through the Launch button (getNavAuthSignedIn()
  // is true only for a real session, not anon trial).
  //
  // getNavAuthSignedIn() returns null until the /api/entitlement fetch settles.
  // If it hasn't settled yet, wait up to 2 s for it; then redirect if still
  // null or false. A confirmed signed-in user re-enters _submitDashPrompt().
  if (proxiedProviderSelected) {
    const authState = getNavAuthSignedIn(); // true | false | null
    if (authState === true) {
      // Confirmed signed in → fall through to launch below.
    } else if (authState === false) {
      // Confirmed NOT signed in (including anon trial users).
      window.location.href = '/signin.html?next=/try.html';
      return;
    } else {
      // null — entitlement check still in-flight; wait briefly then decide.
      const launchBtn = document.getElementById('dash-launch-btn');
      if (launchBtn) launchBtn.disabled = true;
      const deadline = Date.now() + 2000;
      const waitForAuth = () => {
        const state = getNavAuthSignedIn();
        if (state !== null) {
          if (launchBtn) launchBtn.disabled = false;
          if (state === true) {
            _submitDashPrompt(); // re-enter: confirmed signed in
          } else {
            window.location.href = '/signin.html?next=/try.html';
          }
          return;
        }
        if (Date.now() < deadline) { setTimeout(waitForAuth, 100); return; }
        // Timed out — redirect to be safe.
        window.location.href = '/signin.html?next=/try.html';
      };
      waitForAuth();
      return;
    }
  }
  // -------------------------------------------------------------------------

  // Safety net: ensure a provider is selected (fresh visitors already default
  // to {'lingmodel'} via main-providers, but a cleared selection would leave
  // #send disabled and make Launch a silent no-op).
  if (selected.size === 0) {
    const def = PROVIDERS.find((p) => p.proxied) || PROVIDERS[0];
    if (def) {
      selected.add(def.id);
      saveSelection(selected);
      ensurePane(def);
    }
  }
  const legacyPrompt = document.getElementById('prompt');
  const legacySend = document.getElementById('send');
  if (!legacyPrompt || !legacySend) return;
  legacyPrompt.value = txt;
  // Synthesize an input event so the existing updateSendState() recomputes
  // sendBtn.disabled now that the textarea has content.
  legacyPrompt.dispatchEvent(new Event('input', { bubbles: true }));
  // #send can be momentarily disabled right after load because the entitlement
  // check is still in flight, so a one-shot setTimeout(0) click races it and
  // silently no-ops (the "Launch does nothing" bug). Poll briefly until #send
  // is enabled; for BYO-key providers the entitlement check never runs so
  // #send enables as soon as a key is present.
  const hint = document.querySelector('.dash-prompt-hint');
  const launchBtn = document.getElementById('dash-launch-btn');
  if (hint) { hint.textContent = 'Starting…'; hint.style.color = ''; }
  if (launchBtn) launchBtn.disabled = true;

  const deadline = Date.now() + 3000; // 3 s is plenty for BYOK key validation
  const start = () => {
    if (!legacySend.disabled) {
      if (launchBtn) launchBtn.disabled = false;
      if (hint) hint.textContent = '';
      // Route to the build view WITHOUT firing a hashchange.
      try { history.replaceState(null, '', '#app=draft'); } catch (e) {}
      setTryView('app');
      setTimeout(() => legacySend.click(), 0);
      return;
    }
    if (Date.now() < deadline) { setTimeout(start, 150); return; }
    // Timed out and #send never became runnable — show the reason.
    if (launchBtn) launchBtn.disabled = false;
    if (hint) {
      hint.textContent = legacySend.title || "Couldn't start — add a provider key to build.";
      hint.style.color = 'var(--danger, #ef4444)';
    }
  };
  start();
}

document.getElementById('dash-prompt-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  _submitDashPrompt();
});
document.getElementById('dash-prompt')?.addEventListener('keydown', (e) => {
  // ⌘+Enter (or Ctrl+Enter on non-Mac) launches without needing the button.
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    _submitDashPrompt();
  }
});

// ---- App-view top bar: back / More menu / Deploy stub -----------------
// Items in the More menu delegate to the existing #...-btn elements still
// living inside the (hidden) legacy #workspace-tools-menu so their
// already-bound click handlers in main-supabase.js / main-knowledge.js /
// etc. continue to fire untouched.
const TOPBAR_MORE_ITEMS = [
  { labelEn: '📱 Open on phone', labelZh: '📱 在手机上打开', targetId: 'topbar-phone-btn' },
  { labelEn: '☁ Cloud backend', labelZh: '☁ 云后端',   targetId: 'cloud-btn' },
  { labelEn: 'Knowledge',      labelZh: '知识库',     targetId: 'knowledge-btn' },
  { labelEn: 'Secrets',        labelZh: '密钥',       targetId: 'secrets-btn' },
  { labelEn: 'Custom domain',  labelZh: '自定义域名', targetId: 'domains-btn' },
  { labelEn: 'Site config',    labelZh: '站点配置',   targetId: 'site-config-btn' },
  { labelEn: 'Figma import',   labelZh: '导入 Figma', targetId: 'figma-btn' },
  { labelEn: 'Push to GitHub', labelZh: '推送到 GitHub', targetId: 'github-push-btn' },
  { labelEn: 'MCP servers',    labelZh: 'MCP 服务器', targetId: 'mcp-btn' },
  { labelEn: 'Projects',       labelZh: '项目',       targetId: 'projects-btn' },
  { labelEn: 'Checkpoints',    labelZh: '检查点',     targetId: 'checkpoint-btn' },
  { labelEn: 'History',        labelZh: '历史',       targetId: 'checkpoint-history-btn' },
  { labelEn: 'Collaborate',    labelZh: '协作',       targetId: 'collab-btn' },
];

function _isZhPage() {
  return (document.documentElement.getAttribute('lang') || '').toLowerCase().startsWith('zh');
}

function buildTopbarMoreMenu() {
  const menu = document.getElementById('topbar-more-menu');
  if (!menu || menu.dataset.built === '1') return;
  const zh = _isZhPage();
  for (const item of TOPBAR_MORE_ITEMS) {
    const target = document.getElementById(item.targetId);
    if (!target) continue; // gracefully skip if the legacy button isn't present
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = zh ? item.labelZh : item.labelEn;
    btn.addEventListener('click', () => {
      menu.hidden = true;
      const moreBtn = document.getElementById('topbar-more-btn');
      if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
      target.click();
    });
    menu.appendChild(btn);
  }
  menu.dataset.built = '1';
}

function mountAppTopbar() {
  buildTopbarMoreMenu();
  wireAppNameEditing();
  // Let the modal Save / Short-link paths persist chat history + a live
  // screenshot thumbnail, matching the Deploy path.
  setChatHistorySnapshotProvider(_activeChatHistorySnapshot);
  setLiveThumbnailProvider(() => captureLiveThumbnail(_activePaneIframe()));

  document.getElementById('topbar-back')?.addEventListener('click', () => {
    // Back to dashboard. Clear the hash AND route explicitly: on a ?continue=
    // reopen the URL has no hash (the app view was shown via setTryView, and any
    // #app=draft was set with replaceState), so just assigning location.hash=''
    // fires no hashchange and the dashboard would never appear. routeFromHash()
    // forces it. (routeFromHash is the module-level binding from mountRouter,
    // initialized before any click can fire.)
    try { history.replaceState(null, '', location.pathname); } catch (_) {}
    try { routeFromHash(); } catch (_) {}
  });

  const moreBtn = document.getElementById('topbar-more-btn');
  const moreMenu = document.getElementById('topbar-more-menu');
  if (moreBtn && moreMenu) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !moreMenu.hidden;
      if (isOpen) {
        moreMenu.hidden = true;
        moreBtn.setAttribute('aria-expanded', 'false');
      } else {
        // Portal the menu to <body> as a fixed overlay positioned under the
        // button. The sandboxed about:srcdoc preview iframe gets its own GPU
        // compositing layer that paints over normal content regardless of
        // z-index (even with translateZ promotion); rendering at body level
        // with a modal-tier z-index is the only reliable way over it.
        if (moreMenu.parentElement !== document.body) document.body.appendChild(moreMenu);
        const r = moreBtn.getBoundingClientRect();
        moreMenu.style.position = 'fixed';
        moreMenu.style.top = (r.bottom + 6) + 'px';
        moreMenu.style.right = (window.innerWidth - r.right) + 'px';
        moreMenu.style.left = 'auto';
        moreMenu.style.zIndex = '9000';
        moreMenu.hidden = false;
        moreBtn.setAttribute('aria-expanded', 'true');
      }
    });
    document.addEventListener('click', (e) => {
      if (moreMenu.hidden) return;
      if (moreMenu.contains(e.target) || e.target === moreBtn) return;
      moreMenu.hidden = true;
      moreBtn.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !moreMenu.hidden) {
        moreMenu.hidden = true;
        moreBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Deploy CTA: delegate to the active pane's existing publishBtn so the
  // full handlePublish flow (leak-scan → publishPrototypeFrom → resume-on-
  // signin) runs untouched. The per-pane button is what the legacy preview
  // head exposes; we just surface it as a primary top-bar action.
  document.getElementById('topbar-deploy-btn')?.addEventListener('click', () => {
    const meta = activeProviderId ? tabByProvider.get(activeProviderId) : null;
    const pane = meta?.pane;
    if (!pane) {
      showInlineToast(_isZhPage() ? '先生成一些内容,再点击发布。' : 'Generate something first, then click Deploy.');
      return;
    }
    if (!pane.publishBtn) {
      showInlineToast(_isZhPage() ? '此面板没有可用的发布操作。' : 'No publish action available for this pane.');
      return;
    }
    if (pane.publishBtn.disabled) {
      showInlineToast(_isZhPage() ? '等待生成完成后再发布。' : 'Wait for generation to finish, then try again.');
      return;
    }
    pane.publishBtn.click();
  });

  // Chat toggle (sidebar icon): collapses the chat column so the preview
  // takes the full pane width. Delegates to the legacy #workspace-focus-toggle
  // (which owns the body.try-build-focus class); MutationObserver keeps our
  // aria-pressed in sync if the body class flips from elsewhere.
  const chatToggleBtn = document.getElementById('topbar-chat-toggle');
  if (chatToggleBtn) {
    const refreshChatToggle = () => {
      const on = document.body.classList.contains('try-build-focus');
      chatToggleBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      chatToggleBtn.title = on ? 'Show chat panel' : 'Hide chat for a preview-only view';
    };
    refreshChatToggle();
    chatToggleBtn.addEventListener('click', () => {
      const inFocus = document.body.classList.contains('try-build-focus');
      // Legacy #workspace-focus-toggle's click handler returns early when
      // already in focus (it only enters); exit goes through the close button
      // (which also sets the snooze key so auto-focus doesn't re-fire).
      const legacy = inFocus
        ? document.getElementById('workspace-focus-close')
        : document.getElementById('workspace-focus-toggle');
      if (legacy) legacy.click();
      setTimeout(refreshChatToggle, 0);
    });
    if (typeof MutationObserver === 'function') {
      new MutationObserver(refreshChatToggle).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
  }

  // Viewport (📱) and Expand (↗) preview controls: delegate to the active
  // pane's mobileToggle / previewExpand so the existing click handlers
  // (mobile srcdoc re-render, fullscreen openPreview) keep firing untouched.
  // Disabled state mirrors the pane's button so we don't fire on an empty pane.
  const viewportBtn = document.getElementById('topbar-viewport-btn');
  const expandBtn = document.getElementById('topbar-expand-btn');
  const editBtn = document.getElementById('topbar-edit-btn');
  const _activePane = () => (activeProviderId ? tabByProvider.get(activeProviderId)?.pane : null);
  function refreshPreviewControls() {
    const pane = _activePane();
    if (viewportBtn) {
      const disabled = !pane?.mobileToggle || pane.mobileToggle.disabled;
      viewportBtn.disabled = disabled;
      viewportBtn.setAttribute('aria-pressed', pane?._mobilePreview ? 'true' : 'false');
    }
    if (expandBtn) {
      expandBtn.disabled = !pane?.previewExpand || pane.previewExpand.disabled;
    }
    if (editBtn) {
      // Editable only once a real preview has rendered (same readiness signal
      // as Expand). The toggle's on/off state lives in toggleVisualEdits().
      editBtn.disabled = !pane?.previewExpand || pane.previewExpand.disabled;
    }
  }
  if (viewportBtn) {
    viewportBtn.addEventListener('click', () => {
      const pane = _activePane();
      if (!pane?.mobileToggle || pane.mobileToggle.disabled) {
        showInlineToast('Generate something first, then toggle the preview viewport.');
        return;
      }
      pane.mobileToggle.click();
      setTimeout(refreshPreviewControls, 0);
    });
  }
  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      const pane = _activePane();
      if (!pane?.previewExpand || pane.previewExpand.disabled) {
        showInlineToast('Generate something first, then expand the preview.');
        return;
      }
      pane.previewExpand.click();
    });
  }
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      const pane = _activePane();
      if (!pane?.previewExpand || pane.previewExpand.disabled) {
        showInlineToast('Generate something first, then edit elements.');
        return;
      }
      // toggleVisualEdits() is the single source of truth for visual-edits mode;
      // flipping it on makes the pane preview's inline-edit click listener open
      // the visual-edits panel (already injected via injectInlineEditScript).
      const on = toggleVisualEdits();
      editBtn.setAttribute('aria-pressed', String(on));
      const zh = _isZhPage();
      editBtn.textContent = on ? (zh ? '✏ 退出编辑' : '✏ Exit') : (zh ? '✏ 编辑' : '✏ Edit');
    });
  }
  refreshPreviewControls();
  // Re-evaluate whenever the active tab changes or a pane's preview becomes
  // runnable. Cheap MutationObserver on #try-panes catches the disabled-flip
  // on pane.previewExpand / pane.mobileToggle without per-pane hooks.
  if (typeof MutationObserver === 'function' && panesEl) {
    new MutationObserver(refreshPreviewControls).observe(panesEl, {
      attributes: true, subtree: true, attributeFilter: ['disabled', 'class'],
    });
  }

  // Compare toggle: clicks the legacy #workspace-mode-toggle (which already
  // owns the .tabbed/N-pane swap logic) and mirrors aria-pressed state.
  const compareBtn = document.getElementById('topbar-compare-btn');
  if (compareBtn) {
    const refresh = () => {
      const isCompare = !!workspaceEl && !workspaceEl.classList.contains('tabbed');
      compareBtn.setAttribute('aria-pressed', isCompare ? 'true' : 'false');
    };
    refresh();
    compareBtn.addEventListener('click', () => {
      const legacy = document.getElementById('workspace-mode-toggle');
      if (legacy) legacy.click();
      // Defer reading state until the legacy handler has had a chance to flip
      // the .tabbed class on #workspace.
      setTimeout(refresh, 0);
    });
    // Reflect external changes (e.g. legacy keyboard shortcut, programmatic
    // toggle) so the topbar button stays accurate.
    if (typeof MutationObserver === 'function' && workspaceEl) {
      new MutationObserver(refresh).observe(workspaceEl, { attributes: true, attributeFilter: ['class'] });
    }
  }

  // Open-on-phone: auto-publishes via the existing /p/<id> flow and shows a
  // QR-code modal. Hidden delegate button (#topbar-phone-btn) is targeted by
  // the More menu so the entry stays available at all viewport widths.
  const phoneBtn = document.getElementById('topbar-phone-btn');
  if (phoneBtn) {
    phoneBtn.addEventListener('click', async () => {
      const pane = _activePane();
      if (!pane?.previewExpand || pane.previewExpand.disabled) {
        showInlineToast('Generate something first, then open on phone.');
        return;
      }
      await openOnPhoneFlow(pane);
    });
  }
}

function openPhoneModal() {
  const modal = document.getElementById('phone-modal');
  if (!modal) return null;
  modal.hidden = false;
  const status = document.getElementById('phone-modal-status');
  const qr = document.getElementById('phone-modal-qr');
  const urlInput = document.getElementById('phone-modal-url');
  const copyBtn = document.getElementById('phone-modal-copy');
  if (qr) { qr.classList.remove('ready'); qr.removeAttribute('src'); }
  if (status) status.textContent = 'Publishing…';
  if (urlInput) urlInput.value = '';
  if (copyBtn) { copyBtn.disabled = true; copyBtn.classList.remove('copied'); copyBtn.textContent = 'Copy'; }

  if (!modal.dataset.wired) {
    modal.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('[data-phone-close]')) closePhoneModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) closePhoneModal();
    });
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const u = urlInput?.value || '';
        if (!u) return;
        try { await navigator.clipboard.writeText(u); }
        catch { window.prompt('Copy URL', u); }
        copyBtn.classList.add('copied');
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => { copyBtn.classList.remove('copied'); copyBtn.textContent = 'Copy'; }, 2000);
      });
    }
    modal.dataset.wired = '1';
  }
  return modal;
}
function closePhoneModal() {
  const modal = document.getElementById('phone-modal');
  if (modal) modal.hidden = true;
}
function setPhoneModalUrl(url) {
  const qr = document.getElementById('phone-modal-qr');
  const urlInput = document.getElementById('phone-modal-url');
  const copyBtn = document.getElementById('phone-modal-copy');
  const status = document.getElementById('phone-modal-status');
  if (urlInput) urlInput.value = url;
  if (copyBtn) copyBtn.disabled = false;
  if (status) status.textContent = 'Loading QR code…';
  if (qr) {
    qr.onload = () => qr.classList.add('ready');
    qr.onerror = () => { if (status) status.textContent = 'QR unavailable — copy the URL above'; };
    // External QR generator — the /p/<id> URL is already public, so leaking
    // it to api.qrserver.com is acceptable. Graceful degradation: if the
    // request fails, the user still has the URL to copy.
    qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=480x480&margin=10&data=${encodeURIComponent(url)}`;
  }
}
function setPhoneModalError(msg) {
  const status = document.getElementById('phone-modal-status');
  if (status) status.textContent = msg;
}

async function openOnPhoneFlow(pane) {
  openPhoneModal();
  if (!pane) { setPhoneModalError('No active prototype.'); return; }
  const latest = pane.turns?.[pane.turns.length - 1];
  const chatHistory = {
    v: 1,
    providerId: activeProviderId,
    turns: (pane.turns || []).map((tn) => ({
      userText: tn.userText || '',
      accumulatedMd: tn.accumulatedMd || '',
    })),
    history: pane.history || [],
    system: pane.system || '',
    tools: pane.tools || [],
  };
  const isMulti = pane._files && pane._files.size > 1;
  const html = isMulti ? null : extractLatestRunnableHtmlFromPane(pane);
  const files = isMulti ? pane._files : null;
  const codeText = isMulti ? [...pane._files.values()].join('\n') : (html || '');

  await new Promise((resolve) => {
    confirmPublishWithLeakScan({
      scanTargets: [
        { label: 'Prototype code', text: codeText },
        { label: 'Chat history',   text: JSON.stringify(chatHistory) },
      ],
      onProceed: async () => {
        try {
          const result = await publishPrototypeFrom({
            html, files,
            prompt: latest?.userText || '',
            providerId: activeProviderId,
            chatHistory,
            activePrototypeId: getActivePrototypeId(),
          });
          setPhoneModalUrl(result.url);
        } catch (err) {
          if (err.code === 'unauthorized') {
            setPhoneModalError('Sign in first — the share URL needs an account to host the prototype.');
          } else if (err.code === 'rate_limited') {
            setPhoneModalError('Rate limited — try again in an hour.');
          } else if (err.code === 'cap_reached') {
            setPhoneModalError('50-prototype cap reached — delete a saved prototype to share another.');
          } else if (err.code === 'too_large') {
            setPhoneModalError('Prototype is too large to share — under 200 KB compressed.');
          } else {
            setPhoneModalError('Share failed — ' + (err.message || 'unknown'));
          }
        } finally { resolve(); }
      },
      onCancel: () => { closePhoneModal(); resolve(); },
    });
  });
}

// Title of the currently-loaded saved project, so route changes / reopen show
// the real name instead of "Untitled app" (or the raw id). Set on continue-load
// and on rename; cleared for fresh drafts.
let _loadedAppTitle = null;
function setAppName(name) {
  const el = document.getElementById('topbar-app-name');
  if (!el) return;
  el.textContent = name || 'Untitled app';
}

// Persist the (possibly user-edited) project name to the saved prototype via
// the existing rename endpoint. Best-effort: no id / unchanged / unsaved → no-op.
async function persistAppName(id) {
  const name = (document.getElementById('topbar-app-name')?.textContent || '').trim();
  if (!id || !name || name === 'Untitled app') return;
  try {
    await fetch(`/api/prototypes/${id}`, {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: name }),
    });
  } catch (_) { /* rename is best-effort; ignore network/permission errors */ }
}

// Click-to-edit the top-bar project name. Commits on Enter/blur, cancels on
// Escape. Persists immediately if the prototype is already saved; for a draft
// the name is picked up + persisted right after the next publish.
function wireAppNameEditing() {
  const el = document.getElementById('topbar-app-name');
  if (!el || el.dataset.editable === '1') return;
  el.dataset.editable = '1';
  el.title = 'Click to rename';
  el.style.cursor = 'text';
  let prev = '';
  el.addEventListener('click', () => {
    if (el.getAttribute('contenteditable')) return;
    prev = el.textContent || '';
    el.setAttribute('contenteditable', 'plaintext-only');
    el.focus();
    const range = document.createRange(); range.selectNodeContents(el);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); el.textContent = prev; el.blur(); }
  });
  el.addEventListener('blur', () => {
    el.removeAttribute('contenteditable');
    const name = (el.textContent || '').trim();
    el.textContent = name || 'Untitled app';
    _loadedAppTitle = (name && name !== 'Untitled app') ? name : null;
    if (name && name !== prev.trim()) persistAppName(getActivePrototypeId());
  });
}

// ---- Live-preview thumbnail capture (html2canvas) ---------------------
// The inline pane iframe is sandboxed with allow-same-origin, so we can read
// its rendered DOM and screenshot it — capturing JS-driven content the old
// foreignObject trick missed.
//
// Key invariant: html2canvas runs INSIDE the iframe's window context (loaded
// as a <script> into the iframe's document), not the parent's. This matters
// because html2canvas renders text via canvas.measureText() against the host
// document's font set — if it runs in the parent /try.html window, the
// iframe's custom fonts (Playfair Display, Inter, etc. that the prototype
// loaded) are MISSING from the parent's font set, so measureText falls back
// to default-serif metrics. The visible signature is exactly what produced
// the broken pre-fix thumbnails: italic glyphs at wrong x-positions and
// missing word-spacing ("handcrafted dioramaworld", "Shardsdodge", "andreach
// theflag"). Running html2canvas in the iframe makes its measureText see the
// SAME fonts the user sees on screen → faithful text rendering.
async function _loadHtml2canvasInIframe(iframe) {
  try {
    const win = iframe && iframe.contentWindow;
    const doc = iframe && iframe.contentDocument;
    if (!win || !doc) return null;
    if (win.html2canvas) return win.html2canvas;
    // Reuse an in-flight load promise — caching avoids re-injecting the script
    // if the user clicks Publish, cancels, and re-clicks before the first
    // injection resolves.
    if (iframe._h2cLoad) return iframe._h2cLoad;
    iframe._h2cLoad = new Promise((resolve) => {
      const existing = doc.querySelector('script[data-lc-h2c="1"]');
      if (existing) {
        existing.addEventListener('load', () => resolve(win.html2canvas || null));
        existing.addEventListener('error', () => resolve(null));
        return;
      }
      const s = doc.createElement('script');
      // Absolute URL — srcdoc iframes have effective URL `about:srcdoc`, where
      // relative-URL resolution is browser-dependent. The parent is same-origin
      // with the iframe (allow-same-origin sandbox), so this fetch succeeds.
      s.src = window.location.origin + '/try/vendor/html2canvas.min.js';
      s.dataset.lcH2c = '1';
      s.onload = () => resolve(win.html2canvas || null);
      s.onerror = () => resolve(null);
      (doc.head || doc.documentElement).appendChild(s);
    });
    return iframe._h2cLoad;
  } catch { return null; }
}

// Wait for the iframe to paint at least one fresh frame before screenshotting.
// WebGL games and CSS-animated pages frequently aren't drawn into their <canvas>
// until rAF fires; without this we capture a cleared/empty render buffer and the
// composite-canvas step has nothing to overlay → half-white thumbnails.
// Two rAFs + a 100ms settle covers most WebGL double-buffering and lets first-
// paint CSS transitions land. Hard cap at 800ms so we never block Publish for
// long but still give slower-bootstrapping games a chance to draw their first
// frame (the 250ms cap we tried first was too tight for several real games).
function _waitForIframePaint(iframe) {
  return new Promise((resolve) => {
    const win = iframe && iframe.contentWindow;
    const raf = (win && win.requestAnimationFrame)
      ? win.requestAnimationFrame.bind(win)
      : window.requestAnimationFrame.bind(window);
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    try { raf(() => raf(() => setTimeout(finish, 100))); } catch (_) { finish(); }
    setTimeout(finish, 800);
  });
}

// Wait up to 1.5s for the iframe's @font-face fonts to finish loading. Without
// this, html2canvas can race in BEFORE Google Fonts / @font-face files arrive,
// and (even running in the iframe's context) measureText falls back to the
// generic-family default. Caps the wait so a flaky font CDN can't block Publish.
function _waitForIframeFonts(doc) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    setTimeout(finish, 1500);
    try {
      const f = doc && doc.fonts;
      if (f && typeof f.ready?.then === 'function') {
        f.ready.then(finish, finish);
      } else finish();
    } catch { finish(); }
  });
}

// Find the vertical band of a 2D canvas that contains actual content (any
// pixel meaningfully darker than #fff in any channel). Returns { top, bottom }
// in source-pixel coordinates, or null if the canvas is fully blank / unreadable.
// Sampled every 4th row × every 8th pixel for speed — for a 1280×800 source
// that's ~25k ImageData reads, well under a frame budget.
function _contentBounds(canvas) {
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return null;
    const img = ctx.getImageData(0, 0, W, H).data;
    const stride = W * 4;
    let top = -1, bottom = -1;
    for (let y = 0; y < H; y += 4) {
      const rowStart = y * stride;
      let hit = false;
      for (let x = 0; x < W; x += 8) {
        const i = rowStart + x * 4;
        if (img[i] < 245 || img[i + 1] < 245 || img[i + 2] < 245) { hit = true; break; }
      }
      if (hit) {
        if (top === -1) top = y;
        bottom = y;
      }
    }
    if (top === -1) return null;
    return { top, bottom };
  } catch (_) { return null; }
}

async function captureLiveThumbnail(iframe) {
  try {
    const doc = iframe && iframe.contentDocument;
    const win = iframe && iframe.contentWindow;
    const root = doc && (doc.body || doc.documentElement);
    if (!root || !win) return null;
    // Load html2canvas INTO the iframe — see header comment for why this
    // matters for font fidelity.
    const h2c = await _loadHtml2canvasInIframe(iframe);
    if (!h2c) return null;
    // Give the iframe a chance to paint a real first frame AND finish loading
    // any @font-face files. Both are needed: paint catches WebGL/CSS-animated
    // first frames; fonts.ready catches Google-Fonts <link> swap-ins that
    // shift glyph metrics after first paint.
    await _waitForIframePaint(iframe);
    await _waitForIframeFonts(doc);
    // Capture at the iframe's actual rendered size; html2canvas walks the live
    // DOM, so the layout it sees is the layout the user sees. Scale up to ≥1280
    // wide for sharpness — a 600px-wide pane scales 2.13× into the source canvas,
    // which downsizes cleanly to the 480×300 output. Capped at 2× so a wide
    // monitor doesn't allocate a massive canvas.
    const vw = Math.max(320, doc.documentElement.clientWidth || 1280);
    const vhVisible = doc.documentElement.clientHeight || iframe.clientHeight || 0;
    const vh = Math.max(240, Math.min(vhVisible || doc.documentElement.scrollHeight || 800, 2000));
    const SCALE = Math.min(2, Math.max(1, 1280 / vw));
    const canvas = await h2c(root, {
      backgroundColor: '#fff', useCORS: true, logging: false,
      width: vw, height: vh, windowWidth: vw, windowHeight: vh, scale: SCALE,
    });
    // html2canvas renders DOM only — <canvas>/WebGL play areas (games) read back
    // blank. The pane iframe is allow-same-origin, so composite each live canvas's
    // real pixels over the html2canvas result at its scaled on-screen position.
    // Scroll is 0 since the capture is anchored to the page top. drawImage of a
    // canvas never throws/taints; a double-buffered WebGL canvas just copies a
    // cleared buffer (blank) — that residual case is caught by the bounds scan.
    try {
      const cctx = canvas.getContext('2d');
      if (cctx) {
        for (const c of doc.querySelectorAll('canvas')) {
          try {
            if (!c.width || !c.height) continue;
            const r = c.getBoundingClientRect();
            cctx.drawImage(c, r.left * SCALE, r.top * SCALE, r.width * SCALE, r.height * SCALE);
          } catch (_) { /* skip uncopyable canvas */ }
        }
      }
    } catch (_) { /* compositing best-effort */ }
    const W = 480, H = 300;
    const dr = W / H;
    // Content-aware vertical crop. Top-anchoring the cover-fit over the FULL
    // iframe height was the root cause of "half-white thumbs": if a page's
    // hero only fills the top ~25% of an 800px iframe viewport, the top-down
    // 16:10 slice was 75% page-whitespace. We scan the source canvas for the
    // vertical band that actually contains content (rows with any non-#fff
    // pixels), pad it ~4%, and clamp to a sane minimum so we don't over-zoom
    // a sliver. Game canvases that html2canvas couldn't render (no composite)
    // show up as blank rows and get cropped out — exactly what we want.
    //
    // NB: we intentionally do NOT re-expand srcH to fill 16:10 of canvas.width
    // anymore. That re-expansion silently UNDID the bounds work — any
    // top-anchored hero would re-include the whitespace below it, baking the
    // famous "half-white band at bottom" back into the thumbnail. We now let
    // the band stay tight and accept some horizontal centering crop instead.
    let srcY = 0;
    let srcH = canvas.height;
    try {
      const bounds = _contentBounds(canvas);
      if (bounds) {
        const pad = Math.round(canvas.height * 0.04);
        let top = Math.max(0, bounds.top - pad);
        let bottom = Math.min(canvas.height, bounds.bottom + pad);
        let h = bottom - top;
        // Don't crop tighter than 25% of canvas height — keeps a tiny-button
        // hero from being upscaled into pixel mush.
        const minH = Math.round(canvas.height * 0.25);
        if (h < minH) {
          const cy = (bounds.top + bounds.bottom) / 2;
          top = Math.max(0, Math.min(canvas.height - minH, cy - minH / 2));
          h = Math.min(minH, canvas.height - top);
        }
        srcY = top;
        srcH = h;
      }
    } catch (_) { /* keep full canvas on scan failure */ }
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    // Cover-fit the content band into the 480×300 output. Decision tree:
    //
    //   * If the detected band is tall enough that a full-canvas-width capture
    //     would be mostly content (band height ≥ half the height needed for
    //     a width-preserving capture), KEEP THE WIDTH: take canvas.width and
    //     center the height window vertically on the band centroid. Loses some
    //     pixels above/below the band but preserves all horizontal content —
    //     essential for hero text that runs edge-to-edge.
    //   * Otherwise the band is a sliver (e.g. a single header line on a
    //     mostly-empty page). Width-preserving would bake in 90% whitespace,
    //     so fall back to the band-only cover-fit: zoom in on the band, crop
    //     horizontally centered or vertically centered depending on aspect.
    //
    // Why this matters: the previous "always cover-fit the band" path was
    // chopping ~15% off each side of hero text ("Jump, and explore" → "np,
    // and explore") because hero bands are wider than 16:10 and the cover-fit
    // took the band's full HEIGHT and cropped width. Width-preserve flips that
    // — take full WIDTH, crop height — which is the right choice once we know
    // the band is tall enough to justify it.
    const widthPreserveH = Math.min(canvas.height, Math.round(canvas.width / dr));
    const widthPreserveThreshold = Math.round(widthPreserveH * 0.5);
    let sw, sh, sx, sy;
    if (srcH >= widthPreserveThreshold) {
      // Tall-enough band: preserve full width, vertical crop window centered on band.
      sw = canvas.width;
      sh = widthPreserveH;
      sx = 0;
      const cy = srcY + srcH / 2;
      sy = Math.max(0, Math.min(canvas.height - sh, Math.round(cy - sh / 2)));
    } else {
      // Sliver band: cover-fit zoom on the band itself.
      const sr = canvas.width / srcH;
      if (sr > dr) {
        sh = srcH;
        sw = Math.round(sh * dr);
        sx = Math.max(0, Math.round((canvas.width - sw) / 2));
        sy = srcY;
      } else {
        sw = canvas.width;
        sh = Math.round(sw / dr);
        sx = 0;
        sy = srcY + Math.max(0, Math.round((srcH - sh) / 2));
      }
    }
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, W, H);
    // No whiteish-pixel reject anymore. We used to bail at 0.70 / 0.90 thresholds,
    // but that meant a legitimately whitespace-heavy page (e.g. a game's title
    // screen on a light background) returned null, the server cleared the row,
    // and the dashboard rendered a gradient placeholder instead of the user's
    // actual project. Users prefer "the thumbnail looks like my page" over "the
    // thumbnail is a clean abstract placeholder." If html2canvas produced any
    // data URL at all, ship it.
    let url = '';
    try { url = out.toDataURL('image/webp', 0.75); } catch (_) {}
    if (!url || !url.startsWith('data:image/webp')) { try { url = out.toDataURL('image/jpeg', 0.82); } catch (_) {} }
    return url || null;
  } catch (_) { return null; }
}

// Active pane's live preview iframe (allow-same-origin) for screenshotting.
function _activePaneIframe() {
  const meta = activeProviderId ? tabByProvider.get(activeProviderId) : null;
  return meta?.pane?.previewIframe || null;
}

// Chat-history snapshot of the active pane, shaped like the Deploy payload.
function _activeChatHistorySnapshot() {
  const meta = activeProviderId ? tabByProvider.get(activeProviderId) : null;
  const pane = meta?.pane;
  if (!pane) return null;
  return {
    v: 1,
    providerId: activeProviderId || '',
    turns: (pane.turns || []).map((t) => ({ userText: t.userText || '', accumulatedMd: t.accumulatedMd || '' })),
    history: pane.history || [],
    system: pane.system || '',
    tools: pane.tools || [],
  };
}

function showInlineToast(msg) {
  let t = document.getElementById('inline-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'inline-toast';
    t.className = 'inline-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._tid);
  t._tid = setTimeout(() => { t.hidden = true; }, 2800);
}

mountAppTopbar();

// ---- Top-bar chips + dashboard/app hash router ------------------------
// Both extracted to sibling modules (main-chips.js / main-router.js).
// Mounted here, after mountAppTopbar() builds the chip DOM. The chips expose
// onView(mode), which the router runs at the end of every setTryView so chip
// polling starts/stops on view changes — preserving the old in-place
// setTryView wrapper behavior without monkey-patching a read-only import.
const _chips = mountChips({ getSupabaseConfig, openSupabaseDialog, saveToGitHub, getAwareness });
const { setTryView, routeFromHash } = mountRouter({
  getLoadedAppTitle: () => _loadedAppTitle,
  setAppName,
  openPreview,
  track,
  renderTemplatesGrid: renderTemplatesGridForDashboard,
  onView: _chips.onView,
  mountCloud: (appId) => mountCloudConsole(document.getElementById('cloud-view'), appId),
});

window.addEventListener('hashchange', routeFromHash);
routeFromHash();

// Cold-start backend provisioning needs a prototype id to attach to. Mint one by
// auto-saving the active pane (POST → new stable id) so the agent can call
// provision_backend on a never-published build; later publishes update this id.
setEnsurePrototypeId(async () => {
  const existing = getActivePrototypeId();
  if (existing) return existing;
  const pane = activeProviderId ? paneByProvider.get(activeProviderId) : null;
  if (!pane) throw new Error('no active app to save yet');
  const html = pane._files && pane._files.size > 1 ? null : extractLatestRunnableHtmlFromPane(pane);
  const files = pane._files && pane._files.size > 1 ? pane._files : null;
  if (!html && !files) throw new Error('nothing to save yet — generate the app first');
  const latest = pane.turns?.[pane.turns.length - 1];
  const result = await publishPrototypeFrom({
    html, files,
    prompt: latest?.userText || '',
    providerId: activeProviderId,
    activePrototypeId: null, // create the first stable id
  });
  setSecretsActivePrototypeId(result.id);
  syncCloudBtn();
  return result.id;
});

// Auth scaffolding — fired by main-supabase.js when the user clicks
// "+ Scaffold Auth". Sends a follow-up prompt to the active pane.
window.addEventListener('lingcode:scaffold-auth', () => {
  const pane = activeProviderId ? paneByProvider.get(activeProviderId) : [...paneByProvider.values()][0];
  if (!pane?.runFollowup) return;
  pane.runFollowup(
    'Add Supabase Auth to this prototype. The Supabase URL and anon key are already injected as window.SUPABASE_URL and window.SUPABASE_ANON_KEY.\n\n' +
    'Load the Supabase JS client from CDN: https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2\n\n' +
    'Add:\n' +
    '1. An email + password sign-up / sign-in form (styled to match the existing UI)\n' +
    '2. A logout button visible when the user is signed in\n' +
    '3. Session persistence — check for an existing session on load; show the main UI immediately if already signed in\n' +
    '4. Protected content — unauthenticated visitors see only the auth form; the main UI shows only after sign-in\n\n' +
    'Output the complete updated prototype with auth fully integrated.',
    { source: 'scaffold_auth' }
  );
});

// ---- Shared-prototype auto-open ---------------------------------------
// If the URL hash carries a base64-encoded prototype (set by the modal's
// "Share link" button), surface it in the preview modal on load. No
// account / no backend involvement — pure URL-fragment exchange.
// readSharedHTML is async since v2 uses gzip via DecompressionStream.
(() => {
  readSharedHTML().then((sharedHTML) => {
    if (!sharedHTML) return;
    // Defer one tick so the modal styles are ready.
    setTimeout(() => {
      openPreview({ html: sharedHTML, providerName: t('preview.shared_banner') });
      // Strip the hash so a refresh doesn't keep re-opening.
      history.replaceState(null, '', location.pathname + location.search);
    }, 50);
  }).catch(() => { /* malformed payload — ignore */ });
})();

// ---- Resume publish after sign-in -------------------------------------
// When handlePublish bounces an unauthed user to /signin.html, it stashes
// a checkpoint id + the publish args under `lingcode.try.resumePublish`.
// On the next /try.html load (the post-signin return trip), restore the
// panes from that checkpoint and auto-fire publishPrototypeFrom so the
// user lands back with their work intact AND the publish actually goes
// through. Flag is one-shot — removed on read so a later visit to /try
// doesn't accidentally re-publish.
(async () => {
  const raw = sessionStorage.getItem('lingcode.try.resumePublish');
  if (!raw) return;
  sessionStorage.removeItem('lingcode.try.resumePublish');
  let flag;
  try { flag = JSON.parse(raw); } catch { return; }
  if (!flag || !flag.checkpointId) return;

  let ckpt = null;
  try {
    const all = await loadCheckpoints(getSessionId());
    ckpt = all.find((c) => c.id === flag.checkpointId && c.kind === 'pending_publish');
  } catch (e) { console.warn('[publish-resume] checkpoint lookup failed', e); }
  if (!ckpt) return;

  try {
    await applyCheckpointRestore(ckpt, { silent: true });
  } catch (e) {
    console.warn('[publish-resume] restore failed', e);
    return;
  }
  // One-shot snapshot — drop it now that panes are rehydrated.
  deleteCheckpoint(ckpt.id).catch(() => {});

  // Confirm sign-in actually completed before retrying publish. If not,
  // leave the restored panes in place so the user can click Publish again.
  let signedIn = false;
  try {
    const r = await fetch('/api/account/me', { credentials: 'include', cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      signedIn = !!(j && j.ok);
    }
  } catch (_) {}
  if (!signedIn) return;

  const pane = paneByProvider.get(flag.providerId);
  if (!pane) return;
  const chatHistory = {
    v: 1,
    providerId: flag.providerId,
    turns: (pane.turns || []).map((t) => ({
      userText: t.userText || '',
      accumulatedMd: t.accumulatedMd || '',
    })),
    history: pane.history || [],
    system: pane.system || '',
    tools: pane.tools || [],
  };
  // Pre-publish credential scan (same gate as handlePublish — the auto-
  // retry must not bypass user confirmation just because it's automatic).
  const codeText = pane._files && pane._files.size > 1
    ? [...pane._files.values()].join('\n')
    : (extractLatestRunnableHtmlFromPane(pane) || '');
  await new Promise((resolve) => {
    confirmPublishWithLeakScan({
      scanTargets: [
        { label: 'Prototype code', text: codeText },
        { label: 'Chat history',   text: JSON.stringify(chatHistory) },
      ],
      onProceed: async () => {
        try {
          const result = await publishPrototypeFrom({
            html: pane._files && pane._files.size > 1 ? null : extractLatestRunnableHtmlFromPane(pane),
            files: pane._files && pane._files.size > 1 ? pane._files : null,
            prompt: flag.prompt || '',
            providerId: flag.providerId,
            chatHistory,
            activePrototypeId: getActivePrototypeId(),
          });
          showPublishToast(result.url, result.id);
          advanceStep('polish');
          window.dispatchEvent(new CustomEvent('lingcode:prototype-saved', { detail: { id: result.id } }));
          if (result.id) {
            setSecretsActivePrototypeId(result.id);
            persistAppName(result.id);
            startCollab(result.id).catch(() => {});
          }
        } catch (err) {
          if (err.code !== 'unauthorized') console.warn('[publish-resume] publish failed', err);
          // Anything else (rate_limited, cap_reached, too_large) — panes
          // are already restored, so the user can react and click
          // Publish again.
        }
        resolve();
      },
      onCancel: () => {
        // Silent abort — user is already back at /try with their session
        // restored from the publish-resume hydration; they can publish
        // manually if they decide to clean up the chat first.
        resolve();
      },
    });
  });
})();

// ---- Continue-editing-from-saved-prototype ----------------------------
// When the sidebar's ✏️ button navigates to /try.html?continue=<id>, this
// IIFE fetches the prototype, decompresses its share_payload, and seeds a
// fresh pane so the user can keep iterating. Chat history starts empty
// (we don't store it server-side); the saved code becomes turn 0.
(async () => {
  const params = new URLSearchParams(location.search);
  const continueId = params.get('continue');
  if (!continueId) return;
  // Strip the param so a reload doesn't re-fire the hydration.
  params.delete('continue');
  const stripped = params.toString();
  history.replaceState(null, '', location.pathname + (stripped ? '?' + stripped : '') + location.hash);

  // Visible "Loading saved prototype…" banner — gives the user a beat
  // between click and the synthesized turn appearing in a pane. Wrapped
  // hydration body in try/finally so every return path dismisses it.
  const banner = document.createElement('div');
  banner.className = 'try-continue-banner';
  banner.textContent = 'Loading saved prototype…';
  document.body.appendChild(banner);

  try {

  let item;
  try {
    const r = await fetch('/api/account/saved-prototypes/' + encodeURIComponent(continueId), {
      credentials: 'same-origin',
    });
    if (r.status === 401) {
      // Not signed in — bounce to /signin.html and come back with the
      // continue param intact so the round-trip resumes loading.
      location.href = '/signin.html?next=' + encodeURIComponent('/try.html?continue=' + continueId);
      return;
    }
    if (!r.ok) throw new Error('http_' + r.status);
    const j = await r.json();
    if (!j || !j.ok || !j.item) throw new Error('bad_response');
    item = j.item;
    // Show the saved project's real name in the top bar on reopen.
    _loadedAppTitle = (item.title && item.title !== 'Untitled app') ? item.title : null;
    setAppName(_loadedAppTitle || 'Untitled app');
  } catch (e) {
    console.warn('[continue] fetch failed', e);
    return;
  }

  // Decode share_payload. v1 = raw base64; v2 = gzip+base64 (single HTML);
  // v3 = gzip+base64 of JSON { files, initial }.
  const ver = Number(item.share_version || 2);
  const b64 = item.share_payload;
  if (!b64) return;
  function b64ToBytes(s) {
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  async function gunzipToString(u8) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(u8); writer.close();
    const chunks = [];
    const reader = ds.readable.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    return new TextDecoder().decode(merged);
  }

  let singleHtml = null;
  let filesMap = null;
  try {
    if (ver === 1) {
      singleHtml = decodeURIComponent(escape(atob(b64)));
    } else if (ver === 2) {
      singleHtml = await gunzipToString(b64ToBytes(b64));
    } else if (ver === 3) {
      const json = await gunzipToString(b64ToBytes(b64));
      const obj = JSON.parse(json);
      if (obj && obj.files && typeof obj.files === 'object') {
        filesMap = new Map(Object.entries(obj.files));
      }
    } else {
      console.warn('[continue] unknown share_version', ver);
      return;
    }
  } catch (e) {
    console.warn('[continue] decode failed', e);
    return;
  }
  if (!singleHtml && (!filesMap || filesMap.size === 0)) return;

  // Pick the pane's provider. Saved row carries provider_id from the
  // original publish; fall back to first PROVIDER if unknown.
  const provider =
    PROVIDERS.find((p) => p.id === item.provider_id) ||
    PROVIDERS[0];
  if (!provider) return;
  selected.add(provider.id);
  saveSelection(selected);
  const pane = ensurePane(provider);

  // Prefer the saved chat history when present — it gives the model real
  // memory of prior turns. Fall back to a synthetic turn-0 if the row was
  // published before chat_history was a thing, or if decode fails.
  let restoredFromChatHistory = false;
  let chatTruncated = false;
  if (item.chat_history) {
    try {
      const chatJson = await gunzipToString(b64ToBytes(item.chat_history));
      const chat = JSON.parse(chatJson);
      if (chat && chat.v === 1 && Array.isArray(chat.turns) && Array.isArray(chat.history)) {
        chatTruncated = !!chat.truncated;
        // Rebuild each saved turn into the pane.
        for (const turnSnap of chat.turns) {
          const turn = document.createElement('div');
          turn.className = 'turn';
          const userLine = document.createElement('div');
          userLine.className = 'turn-user';
          userLine.textContent = `› ${turnSnap.userText || ''}`;
          const mdEl = document.createElement('div');
          mdEl.className = 'md';
          // Collapse fenced code to a placeholder UNCONDITIONALLY on restore —
          // a turn that emitted the full app would otherwise render as a
          // multi-thousand-pixel code dump that buries the conversation. We can't
          // gate on isWorkspaceTabbedUi() here: the workspace isn't flagged
          // 'tabbed' yet this early in restore. Raw accumulatedMd is still kept on
          // the turn for preview extraction below.
          mdEl.innerHTML = renderMarkdown(markdownHideFencedBlocks(turnSnap.accumulatedMd || ''));
          addCopyButtons(mdEl);
          turn.append(userLine, mdEl);
          pane.body.insertBefore(turn, pane.cursor);
          pane.turns.push({
            userText: turnSnap.userText || '',
            mdEl,
            accumulatedMd: turnSnap.accumulatedMd || '',
          });
        }
        // The pane.history is what the next API call sends to the model
        // — this is the "real memory" the spec is built around.
        pane.history = chat.history;
        pane.system = chat.system || '';
        pane.tools = Array.isArray(chat.tools) ? chat.tools : [];
        if (chatTruncated) {
          const banner = document.createElement('div');
          banner.className = 'try-continue-truncated-banner';
          banner.textContent =
            'Earlier turns were trimmed when this prototype was saved — the model has the most recent turns only.';
          pane.body.insertBefore(banner, pane.body.firstChild);
        }
        restoredFromChatHistory = true;
      }
    } catch (e) {
      console.warn('[continue] chat_history decode failed, falling back', e);
    }
  }

  if (!restoredFromChatHistory) {
    // Fallback: synthetic turn-0 with the code in a fenced block. Same
    // behavior we shipped before chat_history existed.
    const userText = item.source_prompt || `(continuing from saved prototype: ${item.title || 'Untitled'})`;
    let accumulatedMd;
    if (filesMap) {
      const parts = [`**Continuing from saved prototype:** ${item.title || 'Untitled'}\n`];
      for (const [name, content] of filesMap) {
        parts.push('```html name=' + name + '\n' + content + '\n```');
      }
      accumulatedMd = parts.join('\n\n');
    } else {
      accumulatedMd = `**Continuing from saved prototype:** ${item.title || 'Untitled'}\n\n\`\`\`html\n${singleHtml}\n\`\`\``;
    }
    const turnEl = document.createElement('div');
    turnEl.className = 'turn';
    const userLine = document.createElement('div');
    userLine.className = 'turn-user';
    userLine.textContent = `› ${userText}`;
    const mdEl = document.createElement('div');
    mdEl.className = 'md';
    // Collapse the fenced code unconditionally so the synthetic turn doesn't
    // render the whole app as a giant code dump. Raw accumulatedMd is still
    // stored on the turn for preview extraction.
    mdEl.innerHTML = renderMarkdown(markdownHideFencedBlocks(accumulatedMd));
    addCopyButtons(mdEl);
    turnEl.append(userLine, mdEl);
    pane.body.insertBefore(turnEl, pane.cursor);
    pane.turns.push({ userText, mdEl, accumulatedMd });
  }

  // Seed the canonical files on the pane so updateInlinePreview renders them
  // directly. share_payload is the source of truth; the restored transcript may
  // carry no fenced code (tool-written build / trimmed chat history), and
  // re-scanning it would otherwise blank the preview. Single-HTML (v1/v2) saves
  // get wrapped into a one-entry map so they take the same render path.
  const seedFiles = filesMap || (singleHtml ? new Map([['index.html', singleHtml]]) : null);
  if (seedFiles && seedFiles.size > 0) {
    pane._files = seedFiles;
    pane._activeFile = pickInitialFileFromPreview(seedFiles);
    // Sticky: the saved share_payload is the real app. Keep it authoritative over
    // the restored transcript until the user sends a new turn (cleared in
    // runFollowup), so no stray re-render can swap in a stale transcript partial.
    pane._seededAuthoritative = true;
    renderInlineFileTabs(pane);
    updateInlineFileCountBadge(pane);
  }

  // The canvas/build layout shows #try-chat-history (owned by main-chat.js), NOT
  // the legacy .try-pane-body the turns were rebuilt into above — so on reopen the
  // visible chat column was empty. Mirror the restored conversation into that
  // visible column as plain user/ai bubbles so the user actually sees their chat.
  try {
    clearVisibleChatHistory();
    for (const tn of (pane.turns || [])) {
      const u = (tn.userText || '').trim();
      if (u) postVisibleChatMessage(u, 'user');
      const ai = restoredAiBubbleText(tn.accumulatedMd || '');
      if (ai) postVisibleChatMessage(ai, 'ai');
    }
  } catch (_) {}

  // NOTE: we intentionally do NOT set pane._showTranscriptWhileRunning here. The
  // conversation is shown in the visible #try-chat-history column (populated just
  // above); un-collapsing the pane's OWN legacy transcript would only surface an
  // empty duplicate column (.try-pane-chat-main) beside it. Instead, mark the pane
  // preview-only so its (now-redundant) chat column collapses to 0 and the preview
  // fills the full pane width — no empty gap between #try-chat-history and the app.
  try {
    if (pane.wrap) {
      pane.wrap.classList.add('reopen-preview-only');
      // Set the grid inline too — the .reopen-preview-only CSS rule loses a
      // specificity battle with the base `.try-workspace.tabbed .try-pane.active`
      // grid rule, but an inline style beats both. col1→0 collapses the redundant
      // chat column; col2→1fr lets the preview fill the full pane width.
      pane.wrap.style.gridTemplateColumns = '0 minmax(0, 1fr)';
    }
  } catch (_) {}
  updateInlinePreview(pane, true);
  syncTabbedTranscriptChrome(pane);
  syncAllPaneFollowupRows();
  syncTrySessionChrome();
  // Reopened projects are already built — mark the build checklist complete so
  // it shows ✓ instead of resetting to "0% · ~12 min remaining".
  completeChecklist();

  // Mark this reopened prototype as the active one so re-publishing updates it
  // in place (stable id) and secrets/cloud-backend bound to it light up. (This
  // was previously never set on continue-editing.)
  setSecretsActivePrototypeId(continueId);
  syncCloudBtn();

  // Backfill broken thumbnails. Many rows were saved with the old capture
  // (SVG-foreignObject fallback or pre-font-fix html2canvas) and look garbled
  // in the dashboard grid. Fire a fresh captureLiveThumbnail once the iframe
  // has had time to load+settle, then PATCH the new thumbnail back. Async/
  // best-effort: failure is silent, doesn't affect the resume flow, and the
  // dashboard keeps showing whatever's already in the DB until next reopen.
  //
  // 3.5s delay covers: srcdoc parse → first paint → @font-face fetches →
  // first WebGL frame for canvas-heavy prototypes. Anything longer-lived
  // (long-running splash screens) just keeps its existing thumb for now.
  setTimeout(async () => {
    try {
      const newThumb = await captureLiveThumbnail(pane.previewIframe);
      if (!newThumb) return;
      await fetch('/api/account/saved-prototypes/' + encodeURIComponent(continueId) + '/thumbnail', {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thumbnail: newThumb }),
      }).catch(() => {});
    } catch (_) { /* best-effort */ }
  }, 3500);

  } finally {
    try { banner.remove(); } catch (_) {}
  }
})();

// Run one editor turn against the SERVER-side agent (cloud-editor.js) for a
// project opened via ?edit=. Streams text into a chat bubble and applies
// file_update events to the pane's files + live preview. Used in place of the
// browser agent when window.__lingcodeEditProjectId is set.
async function runProjectEditTurn(pane, promptText, { userPosted = false } = {}) {
  const projectId = window.__lingcodeEditProjectId;
  if (!projectId) return;
  pane._editTurnBusy = true;
  pane._seededAuthoritative = false;
  if (!userPosted) postVisibleChatMessage(promptText, 'user');
  const aiWrap = postVisibleChatMessage('…', 'ai');
  const bubble = aiWrap ? aiWrap.querySelector('.chat-bubble') : null;
  let aiText = '';
  const setAi = (t) => { if (bubble) bubble.textContent = t || '…'; };

  const filesObj = () => {
    const o = {};
    if (pane._files) for (const [k, v] of pane._files) o[k] = v;
    return o;
  };
  const applyFiles = () => {
    if (!pane._activeFile || !(pane._files && pane._files.has(pane._activeFile))) {
      pane._activeFile = pickInitialFileFromPreview(pane._files || new Map());
    }
    renderInlineFileTabs(pane);
    updateInlineFileCountBadge(pane);
    updateInlinePreview(pane, true);
  };

  try {
    if (!pane._editSessionId) {
      const sr = await fetch('/api/cloud-editor/sessions', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, files: filesObj() }),
      });
      if (!sr.ok) { setAi('Could not start the editor session.'); return; }
      const sj = await sr.json();
      pane._editSessionId = sj.sessionId;
    }
    const rr = await fetch('/api/cloud-editor/sessions/' + encodeURIComponent(pane._editSessionId) + '/run', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText, files: filesObj() }),
    });
    if (!rr.ok || !rr.body) { setAi('The editor agent failed to start.'); return; }

    const reader = rr.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let dirty = false;
    let changedAny = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let event = 'message', data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let p; try { p = JSON.parse(data); } catch (_) { continue; }
        if (event === 'text') { aiText += p.text || ''; setAi(aiText); }
        else if (event === 'file_update') {
          if (!pane._files) pane._files = new Map();
          pane._files.set(p.path, p.content);
          dirty = true; changedAny = true;
        } else if (event === 'error') { aiText += (aiText ? '\n' : '') + '⚠ ' + (p.message || 'error'); setAi(aiText); }
      }
      if (dirty) { applyFiles(); dirty = false; }
    }
    setAi(aiText || 'Done.');
    applyFiles();
    // Autosave: persist the edited source as a new snapshot so work isn't lost if
    // the user never clicks Deploy (sessions are in-memory + GC'd). Best-effort.
    if (changedAny) {
      try { await saveProjectSnapshot(projectId, filesObj()); } catch (_) { /* silent */ }
    }
  } catch (e) {
    setAi('Editor error: ' + (e && e.message ? e.message : 'failed'));
  } finally {
    pane._editTurnBusy = false;
  }
}

// Open a DEPLOYED Cloud project in the editor: /try.html?edit=<projectId>.
// Unlike ?continue= (a saved prototype's share_payload), this pulls the project's
// latest source SNAPSHOT as a plain { path: content } map from the projects API
// and seeds a pane from it. Fresh chat (no stored transcript). The projectId is
// stashed for a later redeploy (Phase 0.4). Mirrors the ?continue= seed path.
(async () => {
  const params = new URLSearchParams(location.search);
  const editId = params.get('edit');
  if (!editId) return;
  params.delete('edit');
  const stripped = params.toString();
  history.replaceState(null, '', location.pathname + (stripped ? '?' + stripped : '') + location.hash);

  const banner = document.createElement('div');
  banner.className = 'try-continue-banner';
  banner.textContent = 'Loading project…';
  document.body.appendChild(banner);

  try {
    let filesMap = null;
    try {
      const r = await fetch('/api/projects/' + encodeURIComponent(editId) + '/source/files', {
        credentials: 'same-origin',
      });
      if (r.status === 401) {
        location.href = '/signin.html?next=' + encodeURIComponent('/try.html?edit=' + editId);
        return;
      }
      if (!r.ok) throw new Error('http_' + r.status);
      const j = await r.json();
      if (!j || !j.ok || !j.files || !Object.keys(j.files).length) {
        console.warn('[edit] no source snapshot for project', editId);
        return;
      }
      filesMap = new Map(Object.entries(j.files));
    } catch (e) {
      console.warn('[edit] fetch failed', e);
      return;
    }

    // Best-effort: show the project's real name + capture its STATIC app id so a
    // later Deploy redeploys THAT app (PUT) instead of creating a new one.
    let staticAppId = null;
    try {
      const pr = await fetch('/api/projects/' + encodeURIComponent(editId), { credentials: 'same-origin' });
      if (pr.ok) {
        const pj = await pr.json();
        const nm = pj && pj.project && pj.project.name;
        if (nm) { _loadedAppTitle = nm; setAppName(nm); }
        if (pj && pj.project && pj.project.app && pj.project.app.id) staticAppId = pj.project.app.id;
      }
    } catch (_) { /* best-effort */ }

    // Stash for Phase 0.4 redeploy. Deliberately NOT setActivePrototypeId — a
    // project id is a different namespace from a saved-prototype id and would
    // misroute publish/secrets.
    try { window.__lingcodeEditProjectId = editId; } catch (_) {}

    const provider = PROVIDERS[0];
    if (!provider) return;
    selected.add(provider.id);
    saveSelection(selected);
    const pane = ensurePane(provider);
    // Redeploy target: the project's existing static app (so Deploy updates it).
    if (staticAppId) pane._cloudAppId = staticAppId;
    pane._files = filesMap;
    pane._activeFile = pickInitialFileFromPreview(filesMap);
    pane._seededAuthoritative = true;
    renderInlineFileTabs(pane);
    updateInlineFileCountBadge(pane);

    // Fresh open: no chat to show → collapse the pane's chat column so the
    // preview fills the pane (same treatment as a reopened ?continue= project).
    try {
      if (pane.wrap) {
        pane.wrap.classList.add('reopen-preview-only');
        pane.wrap.style.gridTemplateColumns = '0 minmax(0, 1fr)';
      }
    } catch (_) {}
    updateInlinePreview(pane, true);
    // We have files → enable Deploy (normally gated on a completed runnable turn).
    if (pane.deployBtn && pane._files && pane._files.size > 0) {
      pane.deployBtn.disabled = false;
      pane.deployBtn.style.display = '';
    }
    syncTabbedTranscriptChrome(pane);
    syncAllPaneFollowupRows();
    syncTrySessionChrome();
    completeChecklist();
    syncCloudBtn();
  } finally {
    try { banner.remove(); } catch (_) {}
  }
})();

// Public remix: /try.html?remix=<id> — loads any published prototype via the
// public /api/p/:id endpoint (UUID is the secret; no auth required).
// Uses the same decode + pane-seed logic as ?continue= above.
(async () => {
  const params = new URLSearchParams(location.search);
  const remixId = params.get('remix');
  if (!remixId) return;
  params.delete('remix');
  const stripped = params.toString();
  history.replaceState(null, '', location.pathname + (stripped ? '?' + stripped : '') + location.hash);

  const banner = document.createElement('div');
  banner.className = 'try-continue-banner';
  banner.textContent = 'Loading prototype to remix…';
  document.body.appendChild(banner);

  try {
  let item;
  try {
    const r = await fetch('/api/p/' + encodeURIComponent(remixId));
    if (!r.ok) throw new Error('http_' + r.status);
    item = await r.json();
    if (!item || !item.share_payload) throw new Error('bad_response');
  } catch (e) {
    console.warn('[remix] fetch failed', e);
    return;
  }

  const ver = Number(item.share_version || 2);
  const b64 = item.share_payload;
  function b64ToBytes(s) {
    const bin = atob(s); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  async function gunzipToString(u8) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(u8); writer.close();
    const chunks = []; const reader = ds.readable.getReader();
    while (true) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); }
    let total = 0; for (const c of chunks) total += c.length;
    const merged = new Uint8Array(total); let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    return new TextDecoder().decode(merged);
  }

  let singleHtml = null, filesMap = null;
  try {
    if (ver === 1) { singleHtml = decodeURIComponent(escape(atob(b64))); }
    else if (ver === 2) { singleHtml = await gunzipToString(b64ToBytes(b64)); }
    else if (ver === 3) {
      const obj = JSON.parse(await gunzipToString(b64ToBytes(b64)));
      if (obj?.files) filesMap = new Map(Object.entries(obj.files));
    }
  } catch (e) { console.warn('[remix] decode failed', e); return; }
  if (!singleHtml && (!filesMap || filesMap.size === 0)) return;

  const provider = PROVIDERS.find((p) => p.id === item.provider_id) || PROVIDERS[0];
  if (!provider) return;
  selected.add(provider.id); saveSelection(selected);
  const pane = ensurePane(provider);

  // Synthetic turn-0 — remix starts fresh (no chat history carried over)
  const userText = `(remixed from: ${item.title || 'Untitled'})`;
  let accumulatedMd;
  if (filesMap) {
    const parts = [`**Remixed from:** ${item.title || 'Untitled'}\n`];
    for (const [name, content] of filesMap) parts.push('```html name=' + name + '\n' + content + '\n```');
    accumulatedMd = parts.join('\n\n');
  } else {
    accumulatedMd = `**Remixed from:** ${item.title || 'Untitled'}\n\n\`\`\`html\n${singleHtml}\n\`\`\``;
  }
  const turnEl = document.createElement('div'); turnEl.className = 'turn';
  const userLine = document.createElement('div'); userLine.className = 'turn-user'; userLine.textContent = `› ${userText}`;
  const mdEl = document.createElement('div'); mdEl.className = 'md'; mdEl.innerHTML = renderMarkdown(accumulatedMd); addCopyButtons(mdEl);
  turnEl.append(userLine, mdEl);
  pane.body.insertBefore(turnEl, pane.cursor);
  pane.turns.push({ userText, mdEl, accumulatedMd });

  if (filesMap) {
    pane._files = filesMap; pane._activeFile = pickInitialFileFromPreview(filesMap);
    renderInlineFileTabs(pane); updateInlineFileCountBadge(pane);
  }
  updateInlinePreview(pane, true); syncTabbedTranscriptChrome(pane);
  syncAllPaneFollowupRows(); syncTrySessionChrome();

  } finally { try { banner.remove(); } catch (_) {} }
})();

// ---- Resume unfinished project on landing ----------------------------------
// When the user returns to /try.html without an active session, check IndexedDB
// for a recent checkpoint from any prior session. If one exists, show a banner
// above the prompt so the user can resume or start fresh.
// Skipped when a session is already active (panes exist), in demo mode, or when
// the resumePublish / continue-editing flows already ran above.
(async () => {
  // Only show on a blank landing (no active panes, no continue/publish flags).
  if (paneByProvider.size > 0) return;
  if (DEMO_MODE) return;
  if (sessionStorage.getItem('lingcode.try.resumePublish')) return;
  if (new URLSearchParams(location.search).has('continue')) return;

  let ckpt = null;
  try { ckpt = await findUnfinishedSession(); } catch { return; }
  if (!ckpt) return;

  // Find the prompt textarea's closest wrapper to inject the banner above it.
  const promptContainer =
    document.getElementById('prompt')?.closest('.try-prompt-inner') ??
    document.getElementById('prompt')?.parentElement;
  if (!promptContainer) return;

  const choice = await showResumeBanner(ckpt, promptContainer.parentElement ?? promptContainer);
  if (choice !== 'resume') return;

  try {
    await applyCheckpointRestore(ckpt, { silent: true });
    // Re-bind the resumed build to its saved prototype (stamped at checkpoint
    // time) so Cloud backend, Domains, and "Back" work — not just the content.
    if (ckpt.prototypeId) {
      setSecretsActivePrototypeId(ckpt.prototypeId);
      try { syncCloudBtn(); } catch (_) {}
      try { syncDomainsBtn(); } catch (_) {}
    }
  } catch (e) {
    console.warn('[resume] restore failed', e);
  }
})();
