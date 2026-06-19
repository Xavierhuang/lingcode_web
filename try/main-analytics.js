// main-analytics.js — best-effort GA event tracking for /try.
//
// gtag itself is loaded by /analytics.js in the page <head>. This module
// just wraps gtag.event() so callers don't repeat the try/catch + window
// guard, and wires conversion events whose natural handler insertion
// points don't exist elsewhere (top-nav signin/signup, Mac CTA download).
//
// All call sites import { track } from this file.

export function track(name, params) {
  try { if (window.gtag) window.gtag('event', name, params || {}); } catch {}
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const macCtaBtn = document.querySelector('#mac-cta .cta-button');
    if (macCtaBtn) macCtaBtn.addEventListener('click', () => track('mac_cta_clicked'));
    const navSignin = document.getElementById('nav-signin');
    if (navSignin) navSignin.addEventListener('click', () => track('signin_clicked', { from: 'try' }));
    const navSignup = document.getElementById('nav-signup');
    if (navSignup) navSignup.addEventListener('click', () => track('signup_clicked', { from: 'try' }));
  });
}
