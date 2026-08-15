'use strict';

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { zipSync, strToU8 } = require('fflate');

const MM = 72 / 25.4;
const CARD = Object.freeze({
  trimWidth: 80 * MM,
  trimHeight: 115 * MM,
  bleed: 3 * MM,
});
const THEME = Object.freeze({
  background: '#5B3DF5',
  backgroundDark: '#4229CA',
  foreground: '#FFFFFF',
  ink: '#19152B',
  muted: '#686177',
  paper: '#FFFFFF',
  silver: '#E5E2EB',
  accent: '#C9FF5D',
});
const PAGE_FORMATS = Object.freeze({
  A4: { size: [210 * MM, 297 * MM], gapX: 10 * MM, gapY: 8 * MM },
  'US-Letter': { size: [612, 792], gapX: 10 * MM, gapY: 6 * MM },
});

function buildVoucherCards(batch, codes, options = {}) {
  if (!batch || !Array.isArray(codes) || !options.redeemUrl || !options.termsUrl) {
    throw new Error('invalid_voucher_artifact_input');
  }
  return [...codes]
    .sort((a, b) => a.serialNumber - b.serialNumber)
    .map((item, index) => ({
      serialNumber: item.serialNumber,
      code: item.code,
      batchId: batch.id,
      campaign: batch.name,
      benefitDays: batch.benefitDays,
      redeemBy: batch.redeemBy,
      qrValue: `${options.redeemUrl}#code=${encodeURIComponent(item.code)}`,
      redeemUrl: options.redeemUrl,
      termsUrl: options.termsUrl,
      renewalLine: '30 days free, then $20/month until canceled',
      redemptionSteps: [
        '1  Scan this QR to prefill your voucher',
        '2  Sign in to LingCode',
        '3  Add a payment card to start Pro',
      ],
      productSummaryLines: [
        'Build and ship real iOS, Mac, Android,',
        'and web apps with AI.',
      ],
      theme: { ...THEME },
      sheetIndex: Math.floor(index / 4),
      slotIndex: index % 4,
    }));
}

function cardGeometry(page) {
  const bleedWidth = CARD.trimWidth + 2 * CARD.bleed;
  const bleedHeight = CARD.trimHeight + 2 * CARD.bleed;
  const usedWidth = bleedWidth * 2 + page.gapX;
  const usedHeight = bleedHeight * 2 + page.gapY;
  return {
    bleedWidth,
    bleedHeight,
    originX: (page.size[0] - usedWidth) / 2,
    originY: (page.size[1] - usedHeight) / 2,
  };
}

function slotPosition(slotIndex, page, mirrored = false) {
  const geometry = cardGeometry(page);
  const column = slotIndex % 2;
  const row = Math.floor(slotIndex / 2);
  const x = geometry.originX + column * (geometry.bleedWidth + page.gapX);
  const y = geometry.originY + row * (geometry.bleedHeight + page.gapY);
  if (!mirrored) return { x, y, ...geometry };
  return { x: page.size[0] - x - geometry.bleedWidth, y, ...geometry };
}

function cropMarks(doc, position) {
  const trimX = position.x + CARD.bleed;
  const trimY = position.y + CARD.bleed;
  const right = trimX + CARD.trimWidth;
  const bottom = trimY + CARD.trimHeight;
  const gap = 1.2 * MM;
  const length = 4 * MM;
  doc.save().strokeColor('#2A2633').lineWidth(0.35);
  for (const [x1, y1, x2, y2] of [
    [trimX - gap - length, trimY, trimX - gap, trimY],
    [trimX, trimY - gap - length, trimX, trimY - gap],
    [right + gap, trimY, right + gap + length, trimY],
    [right, trimY - gap - length, right, trimY - gap],
    [trimX - gap - length, bottom, trimX - gap, bottom],
    [trimX, bottom + gap, trimX, bottom + gap + length],
    [right + gap, bottom, right + gap + length, bottom],
    [right, bottom + gap, right, bottom + gap + length],
  ]) doc.moveTo(x1, y1).lineTo(x2, y2).stroke();
  doc.restore();
}

function fitText(doc, text, options) {
  let size = options.maxSize;
  while (size > options.minSize) {
    doc.font(options.font || 'Helvetica-Bold').fontSize(size);
    if (doc.widthOfString(text) <= options.width) break;
    size -= 0.5;
  }
  return size;
}

function drawFront(doc, card, position) {
  const x = position.x;
  const y = position.y;
  const w = position.bleedWidth;
  const h = position.bleedHeight;
  const tx = x + CARD.bleed;
  const ty = y + CARD.bleed;
  const tw = CARD.trimWidth;
  const pad = 9 * MM;
  doc.save();
  doc.roundedRect(x, y, w, h, 5 * MM).fill(THEME.background);
  doc.circle(x + w * 0.86, y + h * 0.12, 31 * MM).fillOpacity(0.12).fill(THEME.accent);
  doc.circle(x + w * 0.05, y + h * 0.86, 24 * MM).fillOpacity(0.10).fill(THEME.paper);
  doc.fillOpacity(1);

  doc.fillColor(THEME.foreground).font('Helvetica-Bold').fontSize(13)
    .text('LINGCODE', tx + pad, ty + 9 * MM, { characterSpacing: 1.8 });
  doc.font('Helvetica').fontSize(7.5).fillOpacity(0.78)
    .text('PRO PROMOTIONAL VOUCHER', tx + pad, ty + 17 * MM, { characterSpacing: 1.2 });
  doc.fillOpacity(1).font('Helvetica-Bold').fontSize(58)
    .text('30', tx + pad, ty + 29 * MM, { lineBreak: false });
  doc.fontSize(16).text('DAYS', tx + pad + 38 * MM, ty + 43 * MM, { characterSpacing: 1.1 });
  doc.font('Helvetica').fontSize(8.5).fillOpacity(0.88)
    .text('OF LINGCODE PRO', tx + pad, ty + 54 * MM, { characterSpacing: 1.5 });
  doc.font('Helvetica-Bold').fontSize(6.7).fillOpacity(0.92)
    .text(card.productSummaryLines.join('\n'), tx + pad, ty + 60 * MM, {
      width: tw - 2 * pad,
      align: 'center',
      lineGap: 0.8,
    });

  const panelX = tx + 7 * MM;
  const panelY = ty + 69 * MM;
  const panelW = tw - 14 * MM;
  const panelH = 24 * MM;
  doc.fillOpacity(1).roundedRect(panelX, panelY, panelW, panelH, 3 * MM).fill(THEME.paper);
  doc.fillColor(THEME.muted).font('Helvetica-Bold').fontSize(6.5)
    .text('APPLY SCRATCH-OFF LABEL OVER THIS BOX', panelX, panelY + 4 * MM, {
      width: panelW,
      align: 'center',
      characterSpacing: 0.5,
    });
  const codeSize = fitText(doc, card.code, { maxSize: 10.5, minSize: 7, width: panelW - 6 * MM, font: 'Courier-Bold' });
  doc.fillColor(THEME.ink).font('Courier-Bold').fontSize(codeSize)
    .text(card.code, panelX + 3 * MM, panelY + 12 * MM, { width: panelW - 6 * MM, align: 'center' });
  doc.fillColor(THEME.foreground).font('Helvetica').fontSize(6.4).fillOpacity(0.86)
    .text(card.renewalLine, tx + pad, ty + 98 * MM, { width: tw - 2 * pad, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(6).fillOpacity(0.7)
    .text(`#${String(card.serialNumber).padStart(3, '0')}  •  REDEEM BY ${new Date(card.redeemBy).toISOString().slice(0, 10)}`, tx + pad, ty + 105 * MM, {
      width: tw - 2 * pad,
      align: 'center',
      characterSpacing: 0.35,
    });
  doc.restore();
  cropMarks(doc, position);
}

function drawBack(doc, card, position, qrBuffer) {
  const x = position.x;
  const y = position.y;
  const w = position.bleedWidth;
  const h = position.bleedHeight;
  const tx = x + CARD.bleed;
  const ty = y + CARD.bleed;
  const tw = CARD.trimWidth;
  const pad = 9 * MM;
  doc.save();
  doc.roundedRect(x, y, w, h, 5 * MM).fill(THEME.backgroundDark);
  doc.circle(x + w * 0.1, y + h * 0.08, 23 * MM).fillOpacity(0.10).fill(THEME.accent);
  doc.fillOpacity(1).fillColor(THEME.foreground).font('Helvetica-Bold').fontSize(17)
    .text('Redeem your Pro trial', tx + pad, ty + 10 * MM, { width: tw - 2 * pad });
  doc.font('Helvetica').fontSize(8).fillOpacity(0.82)
    .text(card.redemptionSteps.join('\n'), tx + pad, ty + 23 * MM, {
      width: tw - 2 * pad,
      lineGap: 3,
    });

  const qrSize = 37 * MM;
  const qrX = tx + (tw - qrSize) / 2;
  const qrY = ty + 48 * MM;
  doc.fillOpacity(1).roundedRect(qrX - 3 * MM, qrY - 3 * MM, qrSize + 6 * MM, qrSize + 6 * MM, 3 * MM).fill(THEME.paper);
  doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
  doc.fillColor(THEME.foreground).font('Helvetica-Bold').fontSize(7.2)
    .text('LINGCODE.DEV/REDEEM', tx + pad, ty + 91 * MM, { width: tw - 2 * pad, align: 'center', characterSpacing: 0.8 });
  doc.font('Helvetica').fontSize(6.5).fillOpacity(0.82)
    .text('Card required. Cancel before the trial ends to avoid a charge. One voucher per eligible account and payment card.', tx + pad, ty + 98 * MM, {
      width: tw - 2 * pad,
      align: 'center',
      lineGap: 1,
    });
  doc.fontSize(5.6).fillOpacity(0.65)
    .text('Full terms: lingcode.dev/voucher-terms/', tx + pad, ty + 108 * MM, { width: tw - 2 * pad, align: 'center' });
  doc.restore();
  cropMarks(doc, position);
}

function renderDuplexPdf(cards, formatName, qrBuffers) {
  const page = PAGE_FORMATS[formatName];
  if (!page) throw new Error('unsupported_page_format');
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ autoFirstPage: false, compress: false, margin: 0, info: {
      Title: `LingCode Pro Vouchers - ${formatName} Duplex`,
      Subject: 'Signal Purple promotional voucher print pack',
      Creator: 'LingCode',
    } });
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const sheetCount = Math.ceil(cards.length / 4);
    for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex += 1) {
      const sheetCards = cards.slice(sheetIndex * 4, sheetIndex * 4 + 4);
      doc.addPage({ size: page.size, margin: 0 });
      for (const card of sheetCards) drawFront(doc, card, slotPosition(card.slotIndex, page, false));
      doc.addPage({ size: page.size, margin: 0 });
      for (const card of sheetCards) {
        const qrBuffer = qrBuffers.get(card.serialNumber);
        if (!qrBuffer) throw new Error('missing_voucher_qr');
        drawBack(doc, card, slotPosition(card.slotIndex, page, true), qrBuffer);
      }
    }
    doc.end();
  });
}

async function createVoucherQrBuffers(cards) {
  const buffers = await Promise.all(cards.map((card) => QRCode.toBuffer(card.qrValue, {
    type: 'png',
    width: 512,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#19152B', light: '#FFFFFF' },
  })));
  return new Map(cards.map((card, index) => [card.serialNumber, buffers[index]]));
}

function csvEscape(value) {
  const text = String(value == null ? '' : value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function voucherCsv(batch, cards) {
  const lines = ['sequence,code,redeem_by,campaign,batch_id'];
  const redeemBy = new Date(batch.redeemBy).toISOString().slice(0, 10);
  for (const card of cards) {
    lines.push([
      card.serialNumber,
      card.code,
      redeemBy,
      batch.name,
      batch.id,
    ].map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function printReadme(batch, cards) {
  return `LingCode Pro Voucher Print Pack
=================================

Campaign: ${batch.name}
Batch ID: ${batch.id}
Quantity: ${cards.length}
Benefit: ${batch.benefitDays} days of LingCode Pro
Redeem by: ${new Date(batch.redeemBy).toISOString().slice(0, 10)}

PRINTING
1. Choose the A4 or US Letter PDF for your paper stock.
2. Print at Actual size / 100%. Do not use Fit, Shrink, or Scale to page.
3. Use duplex printing, flip on the long edge. Pages are ordered front, mirrored back.
4. Print one proof sheet first. Confirm front/back alignment, crop marks, and all four QR codes.
5. Cut on the crop marks only after the proof is approved.

SCRATCH-OFF FINISHING
- Each unique code is printed in the white front panel.
- Apply an opaque scratch-off label over the full marked code box.
- Test one finished card to confirm the coating hides the code and scratches cleanly.

SECURE HANDLING
- Treat the PDFs and voucher-codes.csv as secrets: each code grants a billing promotion.
- Store this ZIP in an encrypted, access-controlled location. Do not email or publicly upload it.
- Distribute each physical voucher once. LingCode cannot recover raw codes from the server.
- Each visible QR contains that voucher's redemption credential and prefills the code field.
- Protect unissued cards from photography or scanning; anyone with the QR can redeem the voucher.
`;
}

async function createVoucherZip({ batch, codes, redeemUrl, termsUrl }) {
  const cards = buildVoucherCards(batch, codes, { redeemUrl, termsUrl });
  const qrBuffers = await createVoucherQrBuffers(cards);
  const [a4, letter] = await Promise.all([
    renderDuplexPdf(cards, 'A4', qrBuffers),
    renderDuplexPdf(cards, 'US-Letter', qrBuffers),
  ]);
  const safeBatchId = String(batch.id).replace(/[^a-zA-Z0-9._-]/g, '-');
  const root = `lingcode-pro-vouchers-${safeBatchId}/`;
  return Buffer.from(zipSync({
    [`${root}LingCode-Pro-Vouchers-A4-Duplex.pdf`]: a4,
    [`${root}LingCode-Pro-Vouchers-US-Letter-Duplex.pdf`]: letter,
    [`${root}voucher-codes.csv`]: strToU8(voucherCsv(batch, cards)),
    [`${root}PRINT-README.txt`]: strToU8(printReadme(batch, cards)),
  }, { level: 6 }));
}

module.exports = {
  buildVoucherCards,
  createVoucherQrBuffers,
  createVoucherZip,
  renderDuplexPdf,
  slotPosition,
  PAGE_FORMATS,
};
