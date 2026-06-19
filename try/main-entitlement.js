// main-entitlement.js — `/api/entitlement` polling + LingModel state badge.
//
// On mount, fires the entitlement check once. After each successful run,
// caller can invoke bumpEntitlement() to schedule a re-check (with a small
// delay so the server-side counter has settled).
//
// Public API:
//   mountEntitlement({ updateSendState, maybeAutoOpenAdvanced })
//     Stores the deferred deps (defined in main.js until tier 0c) and
//     kicks off the initial fetch.
//   bumpEntitlement()
//     setTimeout-wrapped re-check, used after a run completes.
//
// Side effects:
//   - sets nav auth state via setNavAuthState
//   - mutates LingModel primitives via setLingmodelReady / setUserPro /
//     setLingmodelEntitlementSettled
//   - rewrites lingmodelStateBadge.textContent + style.color
//   - may deselect proxied providers when LingModel becomes unavailable
//   - paints / clears the under-prompt anonymous-trial counter

import { t } from './i18n.js?v=20260602d';
import { PROVIDERS } from './agent.js?v=20260602d';
import {
  selected, toggles, lingmodelStateBadge,
  setLingmodelReady, setUserPro, setLingmodelEntitlementSettled,
  refreshProGates, syncProvidersSummary,
  formatTokens, formatResetIn,
  saveSelection,
} from './main-providers.js?v=20260602d';
import { setNavAuthState } from './main-auth.js?v=20260602d';
import { track } from './main-analytics.js?v=20260602d';

let _updateSendState = () => {};
let _maybeAutoOpenAdvanced = () => {};

async function checkEntitlement() {
  // Helper used in both branches — surfaces the anonymous-trial counter
  // (or hides it) under the prompt textarea so first-time visitors see
  // their free quota without expanding the collapsed Providers section.
  const setAnonHint = (remaining, limit) => {
    const el = document.getElementById('anon-trial-hint');
    if (!el) return;
    // Parent <p class="try-prompt-hint"> escalates visually as the trial runs
    // low — quiet/dim when there's plenty left, accent-tinted when ≤ 2,
    // red + signup link when exhausted. Conversion signal.
    const hintP = el.closest('.try-prompt-hint');
    const removeSignupLink = () => {
      hintP?.querySelector('.signup-link')?.remove();
    };
    hintP?.classList.remove('is-low', 'is-exhausted');
    if (limit > 0 && remaining >= 0) {
      el.hidden = false;
      el.style.color = '';
      el.textContent = remaining > 0
        ? t('anon.hint_remaining', remaining, limit)
        : t('anon.hint_exhausted');
      removeSignupLink();
      if (remaining === 0) {
        hintP?.classList.add('is-exhausted');
        if (hintP) {
          const link = document.createElement('a');
          link.className = 'signup-link';
          link.href = '/signup.html?next=/try.html';
          link.textContent = t('anon.signup_link');
          link.addEventListener('click', () => track('signup_clicked', { from: 'try', source: 'anon_exhausted_hint' }));
          // Place link AFTER the existing "⌘+Enter to run" span so the
          // primary call-to-action is unmistakable.
          hintP.append(' ', link);
        }
      } else if (remaining <= 2) {
        hintP?.classList.add('is-low');
      }
    } else {
      el.hidden = true;
      el.textContent = '';
      removeSignupLink();
    }
  };
  try {
    const r = await fetch('/api/entitlement', { credentials: 'include' });
    if (r.status === 401) {
      setNavAuthState(false);
      setUserPro(false);
      refreshProGates();
      lingmodelStateBadge.innerHTML = '';
      lingmodelStateBadge.style.display = '';
      const body = await r.json().catch(() => ({}));
      const anonRemaining = Number(body.anon_remaining || 0);
      const anonLimit = Number(body.anon_limit || 0);
      setAnonHint(anonRemaining, anonLimit);
      if (anonLimit > 0 && anonRemaining > 0) {
        // Trial: keep LingModel selectable, show the counter.
        setLingmodelReady(true);
        lingmodelStateBadge.style.color = 'var(--signal)';
        lingmodelStateBadge.textContent = t('lingmodel.anon_trial', anonRemaining, anonLimit);
      } else {
        // No trial left (or disabled) — wall the row, push sign-up.
        setLingmodelReady(false);
        lingmodelStateBadge.style.color = 'var(--text-muted)';
        lingmodelStateBadge.textContent = anonLimit > 0
          ? t('lingmodel.anon_exhausted')
          : t('lingmodel.cta_tail');
        // Deselect ALL proxied providers (both LingModel tiers) so
        // the Send button doesn't sit "enabled" pointing at a 401 path.
        let changed = false;
        for (const p of PROVIDERS) {
          if (p.proxied && selected.has(p.id)) {
            selected.delete(p.id);
            toggles.get(p.id)?.classList.remove('on');
            changed = true;
          }
        }
        if (changed) saveSelection(selected);
      }
      _updateSendState();
      setLingmodelEntitlementSettled(true);
      syncProvidersSummary();  // re-render outer summary with the resolved truth
      // Reason for the nudge banner — tells the user *why* LingModel won't run.
      // anonLimit > 0 + remaining > 0 already returned early above (LingModel
      // stays ready), so the only paths reaching here are exhausted or disabled.
      const nudgeReason = anonLimit > 0
        ? `Your LingModel free trial (${anonLimit} calls) is used up. Sign in or add a provider key to keep building.`
        : 'Sign in to use LingModel, or add your own provider key to keep building.';
      _maybeAutoOpenAdvanced(nudgeReason);
      return;
    }
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'unknown');
    // Reaching here = server returned 200 with a valid entitlement payload,
    // i.e. the session cookie is good.
    setNavAuthState(true);
    setAnonHint(-1, 0);  // signed in → no anon counter needed
    const used = j.hosted_prompts_used || 0;
    const limit = j.hosted_prompt_limit || 100;
    // Fall back to limit-used when the server doesn't ship a `remaining`
    // field. Prior code left `remaining` undefined which made the
    // `remaining > 0` check evaluate false even for clearly-signed-in users
    // — they'd see "43/100 used" in the badge but get the "(sign in)" hint
    // under the prompt anyway.
    const remaining = (typeof j.hosted_prompts_remaining === 'number')
      ? j.hosted_prompts_remaining
      : Math.max(0, limit - used);
    const isPro = j.tier === 'pro' || j.tier === 'max_pro';
    setUserPro(isPro);
    refreshProGates();
    if (j.unlimited_hosted) {
      lingmodelStateBadge.textContent = t('lingmodel.pro_unlimited');
      lingmodelStateBadge.style.color = 'var(--signal)';
      setLingmodelReady(true);
    } else if (isPro && j.lingmodel_pro_window_limit) {
      // 5h rolling window is the primary user-visible cap. Daily/monthly
      // prompt + token budgets are hidden backstops — only surface them
      // when they bite (exhausted) or get tight (<20% remaining).
      const used2 = j.lingmodel_pro_window_used || 0;
      const cap = j.lingmodel_pro_window_limit;
      const winRemaining = j.lingmodel_pro_window_remaining || 0;
      const dailyRemaining = j.lingmodel_pro_daily_remaining;
      const dailyTokRemaining = j.lingmodel_pro_daily_tokens_remaining;
      const dailyTokLimit = j.lingmodel_pro_daily_token_limit;
      const monthTokRemaining = j.lingmodel_pro_monthly_tokens_remaining;
      const monthTokLimit = j.lingmodel_pro_monthly_token_limit;
      const resetsAt = j.lingmodel_pro_window_resets_at;
      const resetIn = resetsAt ? formatResetIn(resetsAt - Date.now()) : '';
      const dailyExhausted = dailyRemaining != null && dailyRemaining === 0;
      const dailyTokExhausted = dailyTokRemaining != null && dailyTokRemaining === 0;
      const monthTokExhausted = monthTokRemaining != null && monthTokRemaining === 0;
      // Tight = under 20% of cap remaining → warn-tinted but still working.
      const tokTight = (dailyTokLimit && dailyTokRemaining != null && dailyTokRemaining < dailyTokLimit * 0.2)
                    || (monthTokLimit && monthTokRemaining != null && monthTokRemaining < monthTokLimit * 0.2);
      if (winRemaining === 0) {
        lingmodelStateBadge.textContent = t('lingmodel.pro_window_exhausted', resetIn);
        lingmodelStateBadge.style.color = '#f87171';
      } else if (monthTokExhausted) {
        lingmodelStateBadge.textContent = t('lingmodel.pro_month_tokens_exhausted');
        lingmodelStateBadge.style.color = '#f87171';
      } else if (dailyTokExhausted) {
        lingmodelStateBadge.textContent = t('lingmodel.pro_day_tokens_exhausted');
        lingmodelStateBadge.style.color = '#f87171';
      } else if (dailyExhausted) {
        lingmodelStateBadge.textContent = t('lingmodel.pro_daily_exhausted');
        lingmodelStateBadge.style.color = '#f87171';
      } else if (tokTight) {
        // Still working but warn the user — show the tighter of the two
        // token budgets so they know which one will bite first.
        const useDaily = dailyTokLimit && dailyTokRemaining / dailyTokLimit
                       <= (monthTokLimit ? monthTokRemaining / monthTokLimit : 1);
        const remaining2 = useDaily ? dailyTokRemaining : monthTokRemaining;
        const period = useDaily ? t('lingmodel.token_period_today') : t('lingmodel.token_period_month');
        lingmodelStateBadge.textContent = t('lingmodel.pro_tokens_low', formatTokens(remaining2), period);
        lingmodelStateBadge.style.color = '#fbbf24';
      } else {
        lingmodelStateBadge.textContent = t('lingmodel.pro_window', used2, cap, resetIn);
        lingmodelStateBadge.style.color = 'var(--signal)';
      }
      setLingmodelReady(winRemaining > 0 && !dailyExhausted && !dailyTokExhausted && !monthTokExhausted);
    } else if (isPro && j.lingmodel_pro_daily_limit) {
      const today = j.lingmodel_pro_prompts_today || 0;
      const dailyLimit = j.lingmodel_pro_daily_limit;
      lingmodelStateBadge.textContent = t('lingmodel.pro_today', today, dailyLimit);
      lingmodelStateBadge.style.color = j.lingmodel_pro_daily_remaining > 0 ? 'var(--signal)' : '#f87171';
      setLingmodelReady(j.lingmodel_pro_daily_remaining > 0);
    } else {
      lingmodelStateBadge.textContent = t('lingmodel.free_used', used, limit);
      lingmodelStateBadge.style.color = remaining > 0 ? 'var(--signal)' : '#f87171';
      setLingmodelReady(remaining > 0);
      if (remaining === 0) {
        lingmodelStateBadge.textContent = t('lingmodel.free_exhausted', limit);
      }
    }
    _updateSendState();
    setLingmodelEntitlementSettled(true);
    syncProvidersSummary();
  } catch (err) {
    setLingmodelReady(false);
    setUserPro(false);
    refreshProGates();
    lingmodelStateBadge.textContent = t('lingmodel.unavailable');
    _updateSendState();
    setLingmodelEntitlementSettled(true);
    syncProvidersSummary();
  }
}

export function mountEntitlement({ updateSendState, maybeAutoOpenAdvanced }) {
  if (typeof updateSendState === 'function') _updateSendState = updateSendState;
  if (typeof maybeAutoOpenAdvanced === 'function') _maybeAutoOpenAdvanced = maybeAutoOpenAdvanced;
  checkEntitlement();
}

// Refresh entitlement after each successful run so the counter ticks down live.
export function bumpEntitlement() { setTimeout(() => { checkEntitlement(); }, 500); }
