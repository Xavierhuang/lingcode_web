(function () {
  'use strict';
  function initialize() {
    var toggle = document.querySelector('.cloud-docs-mobile-toggle');
    var sidebar = document.getElementById('cloud-docs-sidebar');
    if (!toggle || !sidebar) return;
    if (toggle.__lingcodeDocsInitialized) return;
    toggle.__lingcodeDocsInitialized = true;

    function setOpen(open) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      sidebar.classList.toggle('is-open', open);
    }

    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });
    sidebar.addEventListener('click', function (event) {
      if (event.target.closest('a') && window.matchMedia('(max-width: 900px)').matches) setOpen(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setOpen(false);
        toggle.focus();
      }
    });
    window.addEventListener('resize', function () {
      if (!window.matchMedia('(max-width: 900px)').matches) setOpen(false);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
}());
