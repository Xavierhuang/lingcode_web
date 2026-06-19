/**
 * LingCode — Site interactions.
 * Vanilla JS, no dependencies. Respects prefers-reduced-motion.
 */
(function () {
  'use strict';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasHover = window.matchMedia('(hover: hover)').matches;

  // ── Scroll-triggered fade-in with staggered children ──
  // (Replaces the inline observer from index.html)
  const staggerSelectors = [
    '.changelog-card', '.feature-card', '.demo-card', '.quote-card',
    '.stat', '.security-layer', '.pricing-card', '.macos-kernel-list li'
  ];

  function initFadeObserver() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('fade-in');

        // Stagger direct children
        if (!reducedMotion) {
          const children = entry.target.querySelectorAll(staggerSelectors.join(','));
          children.forEach((child, i) => {
            child.style.transitionDelay = (i * 80) + 'ms';
            child.classList.add('stagger-visible');
          });
        }
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.08 });

    document.querySelectorAll('.fade-section').forEach(el => observer.observe(el));
  }

  // ── Animated stat counters ──
  function animateCounter(el, target, suffix, duration) {
    const start = performance.now();
    const update = (now) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = Math.round(eased * target * 10) / 10;
      el.textContent = (Number.isInteger(value) ? value : value.toFixed(1)) + suffix;
      if (progress < 1) requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
  }

  function initStatCounters() {
    const statsObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const nums = entry.target.querySelectorAll('.stat-num[data-count]');
        nums.forEach(el => {
          animateCounter(el, parseFloat(el.dataset.count), el.dataset.suffix || '', 1200);
        });
        statsObserver.unobserve(entry.target);
      });
    }, { threshold: 0.3 });

    const statsEl = document.querySelector('.stats');
    if (statsEl) statsObserver.observe(statsEl);
  }

  // ── Navigation scroll shrink + active section ──
  function initNavScroll() {
    const header = document.querySelector('.site-header');
    if (!header) return;

    let ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        header.classList.toggle('site-header--scrolled', window.scrollY > 50);
        ticking = false;
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });

    // Active section indicator
    const sections = document.querySelectorAll('section[id]');
    const navLinks = document.querySelectorAll('.nav-links a[href^="#"]');

    if (sections.length && navLinks.length) {
      const sectionObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            navLinks.forEach(link => {
              link.classList.toggle(
                'nav-active',
                link.getAttribute('href') === '#' + entry.target.id
              );
            });
          }
        });
      }, { threshold: 0.3, rootMargin: '-80px 0px -40% 0px' });

      sections.forEach(section => sectionObserver.observe(section));
    }
  }

  // ── Comparison table enhancement ──
  function initComparisonTable() {
    const table = document.querySelector('.compat-table');
    if (!table) return;

    // Replace text checkmarks/crosses with SVG icons
    const checkSVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px"><circle cx="12" cy="12" r="10" stroke-opacity="0.3"/><path d="M9 12l2 2 4-4"/></svg>';
    const crossSVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px"><circle cx="12" cy="12" r="10" stroke-opacity="0.3"/><path d="M15 9l-6 6M9 9l6 6"/></svg>';

    table.querySelectorAll('td.yes').forEach(td => {
      const text = td.textContent.replace(/^[✓✗]\s*/, '');
      td.innerHTML = checkSVG + '<span>' + text + '</span>';
    });
    table.querySelectorAll('td.no').forEach(td => {
      const text = td.textContent.replace(/^[✓✗]\s*/, '');
      td.innerHTML = crossSVG + '<span>' + text + '</span>';
    });
  }

  // ── Video play overlay + lightbox ──
  function initVideoEnhancements() {
    const demoCards = document.querySelectorAll('.demo-card');
    let lightbox = null;

    demoCards.forEach(card => {
      const video = card.querySelector('video');
      if (!video) return;

      // Add play overlay
      const overlay = document.createElement('div');
      overlay.className = 'video-play-overlay';
      overlay.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" fill="white" opacity="0.9"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
      overlay.setAttribute('aria-label', 'Play video');

      const videoWrapper = document.createElement('div');
      videoWrapper.className = 'video-wrapper';
      video.parentNode.insertBefore(videoWrapper, video);
      videoWrapper.appendChild(video);
      videoWrapper.appendChild(overlay);

      // Hide overlay when video plays
      video.addEventListener('play', () => overlay.classList.add('hidden'));
      video.addEventListener('pause', () => overlay.classList.remove('hidden'));
      video.addEventListener('ended', () => overlay.classList.remove('hidden'));

      // Lightbox for wide cards
      if (card.classList.contains('demo-card--wide')) {
        overlay.addEventListener('click', function (e) {
          e.stopPropagation();
          openLightbox(video);
        });
      } else {
        // Click-to-play for small cards. The overlay sits on top of the
        // <video controls> element with z-index: 2, so without this handler
        // it silently swallows clicks — the user's click never reaches the
        // native controls underneath, and hover-to-preview is the only way
        // playback ever starts. Once the user explicitly clicks play, the
        // hover handlers below back off so a stray cursor movement doesn't
        // pause and reset the video they wanted to watch.
        let userInitiated = false;
        overlay.addEventListener('click', function (e) {
          e.stopPropagation();
          userInitiated = true;
          video.play().catch(() => {});
        });

        // Hover-to-preview for small cards
        if (hasHover && !reducedMotion) {
          card.addEventListener('mouseenter', () => {
            if (userInitiated) return;
            video.muted = true;
            video.play().catch(() => {});
          });
          card.addEventListener('mouseleave', () => {
            if (userInitiated) return;
            video.pause();
            video.currentTime = 0;
          });
        }
      }
    });

    function openLightbox(sourceVideo) {
      if (!lightbox) {
        lightbox = document.createElement('div');
        lightbox.className = 'video-lightbox';
        lightbox.innerHTML =
          '<div class="video-lightbox-backdrop"></div>' +
          '<div class="video-lightbox-content">' +
            '<button class="video-lightbox-close" aria-label="Close">&times;</button>' +
            '<video class="video-lightbox-video" controls playsinline></video>' +
          '</div>';
        document.body.appendChild(lightbox);

        lightbox.querySelector('.video-lightbox-backdrop').addEventListener('click', closeLightbox);
        lightbox.querySelector('.video-lightbox-close').addEventListener('click', closeLightbox);
        document.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && lightbox.classList.contains('active')) closeLightbox();
        });
      }

      const lbVideo = lightbox.querySelector('.video-lightbox-video');
      const source = sourceVideo.querySelector('source');
      if (source) {
        lbVideo.src = source.src;
      }
      lightbox.classList.add('active');
      document.body.style.overflow = 'hidden';
      lbVideo.play().catch(() => {});
    }

    function closeLightbox() {
      if (!lightbox) return;
      const lbVideo = lightbox.querySelector('.video-lightbox-video');
      lbVideo.pause();
      lbVideo.src = '';
      lightbox.classList.remove('active');
      document.body.style.overflow = '';
    }
  }

  // ── Initialize everything on DOM ready ──
  function init() {
    initFadeObserver();
    initStatCounters();
    initNavScroll();
    initComparisonTable();
    initVideoEnhancements();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
