'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyVoucherPrefill } = require('../../redeem/voucher-prefill');

const VALID = 'LC-PRO-2222-2222-2222-2222';
const SAVED = 'LC-PRO-3333-3333-3333-3333';

function effects() {
  const state = { shown: [], saved: [], replaced: [] };
  return {
    state,
    setCode: (value) => state.shown.push(value),
    saveCode: (value) => state.saved.push(value),
    replaceUrl: (value) => state.replaced.push(value),
  };
}

test('valid voucher fragment prefills, persists, and clears before checkout', () => {
  const fx = effects();
  const result = applyVoucherPrefill({
    hash: `#code=${encodeURIComponent(VALID.toLowerCase())}`,
    pathname: '/redeem/',
    search: '?canceled=1',
    savedCode: SAVED,
    ...fx,
  });
  assert.deepEqual(result, { code: VALID, fromHash: true });
  assert.deepEqual(fx.state, {
    shown: [VALID],
    saved: [VALID],
    replaced: ['/redeem/?canceled=1'],
  });
});

test('malformed fragment is cleared and cannot replace a valid saved code', () => {
  const fx = effects();
  const result = applyVoucherPrefill({
    hash: '#code=not-a-voucher',
    pathname: '/redeem/',
    search: '',
    savedCode: SAVED,
    ...fx,
  });
  assert.deepEqual(result, { code: SAVED, fromHash: false });
  assert.deepEqual(fx.state, {
    shown: [SAVED],
    saved: [],
    replaced: ['/redeem/'],
  });
});
