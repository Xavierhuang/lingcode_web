// main-demo-mode.js — /try.html?demo=1 bootstrap.
//
// Loads cached benchmark scenarios from demo-data.json, force-selects the
// scenario's providers (so toggles light up), plugs the scripted runner
// into agent.js's runOnce hook, fills the prompt textarea, and clicks Run.
// Anonymous visitors get a live-looking provider race without auth or
// quota burn.
//
// Embed mode (`&embed=1`) adds a topic chyron at the top + a fade-in
// end-card overlay with cheapest/fastest winners — designed for video
// recordings.
//
// Public API:
//   mountDemoMode({ DEMO_MODE, DEMO_TASK, EMBED_MODE, SLOWMO,
//                   selected, toggles, _demoScenarioProviders,
//                   saveSelection, paneByProvider, promptEl, sendBtn,
//                   updateSendState })
//
// No-op when DEMO_MODE is falsy, but still pays the import cost — caller
// should only mount when ?demo=1 is in the URL.

import { loadScenarios, pickScenario, setActiveScenario, scriptedRunOnce, setSlowmo } from './demo.js?v=20260602d';
import { setDemoRunner, PROVIDERS } from './agent.js?v=20260602d';
import { t } from './i18n.js?v=20260602d';

export function mountDemoMode({
  DEMO_MODE,
  DEMO_TASK,
  EMBED_MODE,
  SLOWMO,
  selected,
  toggles,
  _demoScenarioProviders,
  saveSelection,
  paneByProvider,
  promptEl,
  sendBtn,
  updateSendState,
}) {
  if (!DEMO_MODE) return;

  (async () => {
    try {
      const data = await loadScenarios();
      const scenario = pickScenario(data, DEMO_TASK);
      if (!scenario) throw new Error('no demo scenarios available');
      setActiveScenario(scenario);
      setDemoRunner(scriptedRunOnce);
      setSlowmo(SLOWMO);

      // Force the selected set to exactly the scenario's providers, then
      // sync the toggle UI so the user sees the right rows highlighted.
      selected.clear();
      const ids = scenario.providersInScenario || Object.keys(scenario.responses || {});
      for (const id of ids) {
        selected.add(id);
        _demoScenarioProviders.add(id);
        const tog = toggles.get(id);
        if (tog) tog.classList.add('on');
      }
      for (const [id, tog] of toggles) {
        if (!ids.includes(id)) tog.classList.remove('on');
      }
      saveSelection(selected);

      if (EMBED_MODE) {
        // Embed mode: synthesized topic chyron at the top + end-card overlay
        // that fades in once the race finishes. No standard banner — the
        // chyron does that job.
        const chyron = document.createElement('div');
        chyron.className = 'try-embed-topic';
        const promptShort = scenario.prompt.length > 110
          ? scenario.prompt.slice(0, 107) + '…' : scenario.prompt;
        chyron.innerHTML = `<span class="label">PROMPT</span>${promptShort}`;
        document.body.append(chyron);

        const endcard = document.createElement('div');
        endcard.className = 'try-embed-endcard';
        endcard.innerHTML = `
          <h2>Same prompt. Every model.<br>Side by side.</h2>
          <div class="winners">
            <span class="badge cheap" data-cheap></span>
            <span class="badge fast"  data-fast></span>
          </div>
          <div class="url">lingcode.dev/try</div>`;
        document.body.append(endcard);
        // Show end-card 1.2s after all panes settle.
        const endcardTimer = setInterval(() => {
          const settled = [...paneByProvider.values()].every((p) => p.finalLatencyMs != null);
          if (settled && paneByProvider.size > 0) {
            clearInterval(endcardTimer);
            // Pull cheapest/fastest from awarded badges if present, fallback
            // to first/first.
            const cheap = document.querySelector('.winner-tag.cheap')?.textContent || 'Cheapest';
            const fast = document.querySelector('.winner-tag.fast')?.textContent  || 'Fastest';
            const cheapPane = [...paneByProvider.entries()].find(([, p]) => p.wrap.classList.contains('winner-cheap'));
            const fastPane  = [...paneByProvider.entries()].find(([, p]) => p.wrap.classList.contains('winner-fast'));
            const cheapName = cheapPane ? PROVIDERS.find(x => x.id === cheapPane[0])?.name : '';
            const fastName  = fastPane  ? PROVIDERS.find(x => x.id === fastPane[0])?.name  : '';
            endcard.querySelector('[data-cheap]').textContent = cheapName ? `${cheap} · ${cheapName}` : '';
            endcard.querySelector('[data-fast]').textContent  = fastName  ? `${fast} · ${fastName}`  : '';
            setTimeout(() => endcard.classList.add('show'), 1200);
          }
        }, 200);
      } else {
        // Standard demo banner above the prompt row.
        const banner = document.createElement('div');
        banner.className = 'try-demo-banner';
        banner.innerHTML = `
          <span class="dot"></span>
          <span>${t('demo.banner')}</span>
          <a href="${location.pathname}">${t('demo.try_yours')}</a>`;
        const promptRow = document.querySelector('.try-prompt-row');
        if (promptRow && promptRow.parentNode) {
          promptRow.parentNode.insertBefore(banner, promptRow);
        }
      }

      promptEl.value = scenario.prompt;
      promptEl.dispatchEvent(new Event('input', { bubbles: true }));
      updateSendState();
      // Slightly longer pre-run pause in embed mode so the chyron lands
      // on screen before the race kicks off — important for video timing.
      setTimeout(() => { if (!sendBtn.disabled) sendBtn.click(); }, EMBED_MODE ? 1800 : 900);
    } catch (err) {
      console.warn('[demo] failed to bootstrap:', err);
    }
  })();
}
