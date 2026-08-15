'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { unzipSync, strFromU8 } = require('fflate');
const {
  buildVoucherCards,
  createVoucherZip,
} = require('../voucher-artifacts');

function codeFor(index) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let cursor = index;
  let value = '';
  for (let i = 0; i < 16; i += 1) {
    value = alphabet[cursor % 32] + value;
    cursor = Math.floor(cursor / 32);
  }
  return `LC-PRO-${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}`;
}

function fixture(count) {
  return {
    batch: {
      id: 'batch-print-2026',
      name: 'LingCode Pro Promotion 2026',
      quantity: count,
      benefitDays: 30,
      redeemBy: Date.UTC(2027, 7, 9),
    },
    codes: Array.from({ length: count }, (_, index) => ({
      serialNumber: index + 1,
      code: codeFor(index + 1),
    })),
  };
}

test('card model is stable, Signal Purple, and contains no customer data', () => {
  const { batch, codes } = fixture(500);
  const cards = buildVoucherCards(batch, codes, {
    redeemUrl: 'https://lingcode.dev/redeem/',
    termsUrl: 'https://lingcode.dev/voucher-terms/',
  });
  assert.equal(cards.length, 500);
  assert.deepEqual(cards.map((card) => card.serialNumber), Array.from({ length: 500 }, (_, i) => i + 1));
  assert.equal(new Set(cards.map((card) => card.code)).size, 500);
  assert.equal(cards[0].theme.background, '#5B3DF5');
  assert.equal(cards[0].qrValue, `https://lingcode.dev/redeem/#code=${encodeURIComponent(codes[0].code)}`);
  assert.equal(new Set(cards.map((card) => card.qrValue)).size, 500);
  assert.equal(cards.some((card) => card.qrValue.includes('?code=')), false);
  assert.deepEqual(cards[0].redemptionSteps, [
    '1  Scan this QR to prefill your voucher',
    '2  Sign in to LingCode',
    '3  Add a payment card to start Pro',
  ]);
  assert.equal(cards[0].renewalLine, '30 days free, then $20/month until canceled');
  assert.deepEqual(cards[0].productSummaryLines, [
    'Build and ship real iOS, Mac, Android,',
    'and web apps with AI.',
  ]);
  assert.equal(cards[0].sheetIndex, 0);
  assert.equal(cards[3].slotIndex, 3);
  assert.equal(cards[4].sheetIndex, 1);
  const serialized = JSON.stringify(cards);
  assert.equal(serialized.includes('@example.com'), false);
  assert.equal(serialized.includes('customer'), false);
});

test('print ZIP contains exactly two duplex PDFs, CSV, and instructions', async () => {
  const { batch, codes } = fixture(500);
  const zip = await createVoucherZip({
    batch,
    codes,
    redeemUrl: 'https://lingcode.dev/redeem/',
    termsUrl: 'https://lingcode.dev/voucher-terms/',
  });
  assert.ok(Buffer.isBuffer(zip));
  const files = unzipSync(zip);
  const root = 'lingcode-pro-vouchers-batch-print-2026/';
  assert.deepEqual(Object.keys(files).sort(), [
    `${root}LingCode-Pro-Vouchers-A4-Duplex.pdf`,
    `${root}LingCode-Pro-Vouchers-US-Letter-Duplex.pdf`,
    `${root}PRINT-README.txt`,
    `${root}voucher-codes.csv`,
  ].sort());

  const csv = strFromU8(files[`${root}voucher-codes.csv`]);
  const csvLines = csv.trim().split('\n');
  assert.equal(csvLines.length, 501);
  assert.equal(csvLines[0], 'sequence,code,redeem_by,campaign,batch_id');
  for (const item of codes) assert.equal(csv.includes(item.code), true);

  const readme = strFromU8(files[`${root}PRINT-README.txt`]);
  for (const phrase of ['Actual size', 'duplex', 'long edge', 'proof sheet', 'scratch-off', 'secure']) {
    assert.match(readme, new RegExp(phrase, 'i'));
  }
  for (const phrase of ['visible QR', 'scan', 'photograph']) {
    assert.match(readme, new RegExp(phrase, 'i'));
  }
  assert.doesNotMatch(readme, /QR is generic/i);
  assert.equal(codes.some((item) => readme.includes(item.code)), false);

  for (const filename of [
    `${root}LingCode-Pro-Vouchers-A4-Duplex.pdf`,
    `${root}LingCode-Pro-Vouchers-US-Letter-Duplex.pdf`,
  ]) {
    const pdf = Buffer.from(files[filename]);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 250);
  }
});

test('partial final sheet still produces a paired front and mirrored back page', async () => {
  const { batch, codes } = fixture(5);
  const zip = await createVoucherZip({
    batch,
    codes,
    redeemUrl: 'https://lingcode.dev/redeem/',
    termsUrl: 'https://lingcode.dev/voucher-terms/',
  });
  const files = unzipSync(zip);
  const pdf = Buffer.from(files['lingcode-pro-vouchers-batch-print-2026/LingCode-Pro-Vouchers-A4-Duplex.pdf']);
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 4);
});
