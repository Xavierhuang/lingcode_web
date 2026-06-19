// main-templates.js — Tier-1 templates gallery for /try.
//
// Renders the registry from templates-manifest.js as cards into a host
// element. Click → fetch the HTML → hand to a callback (typically the
// existing openPreview from preview.js) so the template lands in the
// same modal users already see for share links.

import { TEMPLATES, loadTemplateHtml } from './templates-manifest.js?v=20260602d';

// Locale-aware getters — falls back to English when no _zh field is present.
const _isZh = (document.documentElement.getAttribute('lang') || '').toLowerCase().startsWith('zh');
const _label = (t) => (_isZh && t.label_zh) ? t.label_zh : t.label;
const _blurb = (t) => (_isZh && t.blurb_zh) ? t.blurb_zh : t.blurb;
const _openTitle = (l) => _isZh ? `打开 “${l}” 模板` : `Open the “${l}” starter`;

export function renderTemplatesGrid(anchor, { onPick, onError } = {}) {
  if (!anchor) return null;
  anchor.textContent = '';
  for (const tmpl of TEMPLATES) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'try-example-card try-template-card';
    card.dataset.templateId = tmpl.id;

    const iconEl = document.createElement('span');
    iconEl.className = `icon try-template-icon bg-gradient-to-br ${tmpl.accent}`;
    iconEl.textContent = tmpl.icon;
    card.append(iconEl);

    const body = document.createElement('span');
    body.className = 'body';
    const labelEl = document.createElement('span');
    labelEl.className = 'label';
    labelEl.textContent = _label(tmpl);
    body.append(labelEl);
    const subEl = document.createElement('span');
    subEl.className = 'subtitle';
    subEl.textContent = _blurb(tmpl);
    body.append(subEl);
    card.append(body);

    card.title = _openTitle(_label(tmpl));
    card.addEventListener('click', async () => {
      card.disabled = true;
      try {
        const html = await loadTemplateHtml(tmpl.id);
        onPick?.({ id: tmpl.id, label: tmpl.label, html });
      } catch (err) {
        console.warn('[templates] failed to load', tmpl.id, err);
        onError?.(err);
      } finally {
        card.disabled = false;
      }
    });

    anchor.append(card);
  }
  return anchor;
}
