// main-cards.js — Lovable-style starter card grids + templates gallery.
//
// Renders three things into the prompt-row anchors:
//   1. `builds.list`   → #try-examples-grid (top row, build prompts)
//   2. `examples.list` → #try-examples-grid (bottom row, only if locale has it)
//   3. TEMPLATES       → #try-templates-grid (gallery of clickable starter prototypes)
//
// Click handlers fill the prompt textarea (for cards) or open the shared
// preview modal (for templates).
//
// Public API:
//   mountCards({ promptEl, promptRow })
//     promptEl  — the textarea to fill on card click
//     promptRow — gates rendering; if null (legacy markup) mount no-ops.

import { t } from './i18n.js?v=20260602d';
import { track } from './main-analytics.js?v=20260602d';
import { TEMPLATES } from './templates-manifest.js?v=20260602d';
import { renderTemplatesGrid } from './main-templates.js?v=20260602d';
import { openPreview } from './preview.js?v=20260602d';
import { showError } from './main-workspace.js?v=20260602d';

// Split chip text "📊 Pitch deck" into icon + label so the card layout
// can render them in two columns. Falls back gracefully if the chip
// string doesn't start with an emoji.
function splitChip(text) {
  const m = text && text.match(/^(\p{Extended_Pictographic}️?)\s*(.*)$/u);
  if (m) return { icon: m[1], label: m[2] || text };
  return { icon: '', label: text };
}

function renderCardGrid(items, anchorId, titleKey, promptEl) {
  const anchor = document.getElementById(anchorId);
  if (!anchor || !Array.isArray(items) || !items.length) return null;
  for (const ex of items) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'try-example-card';
    const { icon, label } = splitChip(ex.chip || '');
    if (icon) {
      const iconEl = document.createElement('span');
      iconEl.className = 'icon';
      iconEl.textContent = icon;
      card.append(iconEl);
    }
    const body = document.createElement('span');
    body.className = 'body';
    const labelEl = document.createElement('span');
    labelEl.className = 'label';
    labelEl.textContent = label;
    body.append(labelEl);
    if (ex.subtitle) {
      const subEl = document.createElement('span');
      subEl.className = 'subtitle';
      subEl.textContent = ex.subtitle;
      body.append(subEl);
    }
    card.append(body);
    card.title = ex.prompt.length > 120 ? ex.prompt.slice(0, 117) + '…' : ex.prompt;
    card.addEventListener('click', () => {
      promptEl.value = ex.prompt;
      promptEl.focus();
      promptEl.dispatchEvent(new Event('input', { bubbles: true }));
      promptEl.scrollTop = 0;
      track('chip_clicked', { chip: ex.chip, row: titleKey });
    });
    anchor.append(card);
  }
  return anchor;
}

export function mountCards({ promptEl, promptRow }) {
  if (!promptRow) return;

  const builds = (typeof t === 'function' ? t('builds.list') : null) || [];
  renderCardGrid(builds, 'try-examples-grid', 'builds.title', promptEl);
  // examples.list is intentionally empty in the current i18n — the cards
  // surface only the build templates. If a future locale adds entries to
  // examples.list, render them into the same grid below the build cards.
  const examples = (typeof t === 'function' ? t('examples.list') : null) || [];
  if (Array.isArray(examples) && examples.length) {
    renderCardGrid(examples, 'try-examples-grid', 'examples.title', promptEl);
  }

  // Templates gallery — real loadable starter prototypes. Reuses the same
  // shared-prototype modal users already see for share links, so click =
  // open in modal without touching pane/turn structure.
  if (Array.isArray(TEMPLATES) && TEMPLATES.length) {
    const section = document.getElementById('try-templates-section');
    const grid = document.getElementById('try-templates-grid');
    if (section && grid) {
      section.hidden = false;
      renderTemplatesGrid(grid, {
        onPick: ({ id, label, html }) => {
          openPreview({ html, providerName: label });
          track('template_opened', { template_id: id });
        },
        onError: () => showError(t ? t('errors.template_load') || 'Could not load template.' : 'Could not load template.'),
      });
    }
  }
}
