'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LingCodeVoucherPrefill = api;
}(typeof globalThis === 'object' ? globalThis : this, () => {
  const CODE_PATTERN = /^LC-PRO-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

  function normalizedCode(value) {
    const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return CODE_PATTERN.test(normalized) ? normalized : null;
  }

  function applyVoucherPrefill(options) {
    const hash = typeof options.hash === 'string' ? options.hash : '';
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const fromHash = normalizedCode(params.get('code'));
    const saved = normalizedCode(options.savedCode);
    const selected = fromHash || saved;
    if (selected) options.setCode(selected);
    if (fromHash) options.saveCode(fromHash);
    if (hash.length > 1) options.replaceUrl(`${options.pathname}${options.search || ''}`);
    return { code: selected, fromHash: Boolean(fromHash) };
  }

  return { applyVoucherPrefill };
}));
