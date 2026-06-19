'use strict';

/**
 * Quick Resend check. From this directory:
 *   npm run test-resend
 * Requires RESEND_TEST_TO and RESEND_API_KEY in .env (and valid RESEND_FROM for your Resend plan).
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { sendResendEmail } = require('./mail-resend');

(async () => {
  const to = process.env.RESEND_TEST_TO;
  if (!to || !String(to).trim()) {
    console.error('Set RESEND_TEST_TO in .env to an inbox address (on trial, usually your Resend account email).');
    process.exit(1);
  }
  const r = await sendResendEmail({
    to: String(to).trim(),
    subject: 'LingCode Resend test',
    html: '<p>If you received this, Resend is configured.</p>'
  });
  console.log(r);
  process.exit(r.ok ? 0 : 1);
})();
