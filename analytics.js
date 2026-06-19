// analytics.js — Google Analytics 4 (G-LF7H10J0V2). Loaded by every public
// HTML page on lingcode.dev. Disclosed in /privacy.html. Update the ID here
// only — pages reference this file by URL, not by ID.
(function () {
  var GA_ID = 'G-LF7H10J0V2';
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', GA_ID);
})();
