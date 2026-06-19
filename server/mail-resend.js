'use strict';

/**
 * Transactional email via Resend (https://resend.com). Set RESEND_API_KEY and RESEND_FROM in .env.
 * For testing, Resend allows from: onboarding@resend.dev. For production, verify your domain in Resend.
 */

/** @param {{ to: string; subject: string; html: string }} opts */
async function sendResendEmail(opts) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !String(key).trim()) {
    return { ok: false, error: 'RESEND_API_KEY is not set' };
  }
  const to = typeof opts.to === 'string' ? opts.to.trim() : '';
  if (!to) {
    return { ok: false, error: 'Recipient email (to) is missing or empty' };
  }
  const from = String(process.env.RESEND_FROM || 'onboarding@resend.dev').trim();
  const { Resend } = require('resend');
  const resend = new Resend(key);
  const { data, error } = await resend.emails.send({
    from,
    to,
    subject: opts.subject,
    html: opts.html
  });
  if (error) {
    return { ok: false, error: error.message || String(error) };
  }
  return { ok: true, id: data && data.id };
}

module.exports = { sendResendEmail };
