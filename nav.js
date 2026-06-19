(function () {
  // Mobile menu toggle (existing)
  var toggle = document.getElementById("nav-toggle");
  if (toggle) {
    document.querySelectorAll(".nav-links a").forEach(function (link) {
      link.addEventListener("click", function () {
        toggle.checked = false;
      });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") toggle.checked = false;
    });
  }

  // Pages can opt out of the search button by setting data-no-search="true" on <body>.
  if (document.body && document.body.dataset.noSearch === "true") return;

  // Inject Pagefind search trigger into the nav.
  // The search index is built by `npx pagefind --site website` at deploy time
  // and served from /pagefind/.
  var navLinks = document.querySelector(".nav-links");
  if (!navLinks) return;

  // Site-wide we now ship a compact <form class="nav-search"> in the nav
  // (see standardize_nav.py / add_nav_search.py). Skip injecting a second
  // search trigger on any page that already has one.
  if (navLinks.querySelector(".nav-search, .nav-search-btn")) return;

  // Resolve where to insert nav extras (search button, language picker).
  // Three nav patterns coexist on the site:
  //   1. <nav class="nav-links">…<a class="nav-cta">…</a>…</nav>     CTA inside nav-links (content pages)
  //   2. <nav>…<ul class="nav-links">…</ul><div class="nav-cta">…    CTA as sibling (marketing pages)
  //   3. Bare <ul class="nav-links">…</ul> with no CTA              (rare)
  // For each, we want the injected element placed visually next to the CTA.
  function injectIntoNav(node) {
    var ctaInside = navLinks.querySelector(".nav-cta");
    if (ctaInside) { navLinks.insertBefore(node, ctaInside); return; }
    var ctaSibling = navLinks.parentNode && navLinks.parentNode.querySelector(":scope > .nav-cta");
    if (ctaSibling) { ctaSibling.insertBefore(node, ctaSibling.firstChild); return; }
    if (navLinks.tagName === "UL") {
      // <select> / <button> can't be a direct child of <ul>; wrap in <li>.
      var li = document.createElement("li");
      li.appendChild(node);
      navLinks.appendChild(li);
      return;
    }
    navLinks.appendChild(node);
  }

  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "nav-search-btn";
  btn.setAttribute("aria-label", "Search documentation");
  btn.innerHTML =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="7" cy="7" r="5"></circle><path d="m14 14-3.5-3.5"></path>' +
    '</svg>' +
    '<span class="label">Search</span>' +
    '<kbd>⌘K</kbd>';
  injectIntoNav(btn);

  var overlay, pagefindLoaded = false;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "search-overlay";
    overlay.innerHTML = '<div class="search-modal" role="dialog" aria-label="Search"><div id="pagefind-search"></div></div>';
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function loadPagefindUI() {
    if (pagefindLoaded) return Promise.resolve();
    pagefindLoaded = true;
    var cssLink = document.createElement("link");
    cssLink.rel = "stylesheet";
    cssLink.href = "/pagefind/pagefind-ui.css";
    document.head.appendChild(cssLink);
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "/pagefind/pagefind-ui.js";
      s.onload = function () {
        if (!window.PagefindUI) {
          reject(new Error("PagefindUI not registered after script load"));
          return;
        }
        new window.PagefindUI({
          element: "#pagefind-search",
          showSubResults: true,
          showImages: false,
          excerptLength: 30,
          resetStyles: false,
          autofocus: true
        });
        resolve();
      };
      s.onerror = function (e) { reject(e); };
      document.head.appendChild(s);
    }).catch(function (err) {
      pagefindLoaded = false;
      var el = document.getElementById("pagefind-search");
      if (el) el.textContent = "Search index unavailable. Try again after the next deploy.";
      console.error("Pagefind load failed", err);
    });
  }

  function open() {
    var ov = ensureOverlay();
    ov.classList.add("open");
    loadPagefindUI().then(function () {
      var input = ov.querySelector(".pagefind-ui__search-input");
      if (input) input.focus();
    });
    document.body.style.overflow = "hidden";
  }
  function close() {
    if (!overlay) return;
    overlay.classList.remove("open");
    document.body.style.overflow = "";
  }

  btn.addEventListener("click", open);

  document.addEventListener("keydown", function (e) {
    var isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
    if (isCmdK) {
      e.preventDefault();
      open();
      return;
    }
    if (e.key === "Escape" && overlay && overlay.classList.contains("open")) {
      close();
    }
  });

  // -------------------------------------------------------------------------
  // Language picker — inject a <select> into the nav on every page so the
  // user can switch locales from anywhere. Previously only try.html had this.
  //
  // Path convention: localized pages live under /<locale>/<path>. So selecting
  // "zh" from /pricing.html sends the user to /zh/pricing.html. Picking "en"
  // strips any /<locale>/ prefix back to the canonical path.
  // -------------------------------------------------------------------------
  if (!navLinks.querySelector("#nav-lang")) {
    var LANGS = [
      { code: "en", label: "EN" },
      { code: "zh", label: "中文" },
      { code: "es", label: "ES" },
      { code: "pt", label: "PT" },
      { code: "ar", label: "عربي" }
    ];

    // Detect the current locale from the URL path.
    function currentLocale() {
      var m = location.pathname.match(/^\/(zh|es|pt|ar)(\/|$)/);
      return m ? m[1] : "en";
    }

    // Build the target URL for a locale switch.
    function pathForLocale(locale) {
      var path = location.pathname.replace(/^\/(zh|es|pt|ar)(?=\/|$)/, "");
      if (!path) path = "/";
      if (locale === "en") return path;
      return "/" + locale + (path === "/" ? "/" : path);
    }

    var sel = document.createElement("select");
    sel.id = "nav-lang";
    sel.className = "nav-lang";
    sel.setAttribute("aria-label", "Language");
    var cur = currentLocale();
    LANGS.forEach(function (l) {
      var opt = document.createElement("option");
      opt.value = l.code;
      opt.textContent = l.label;
      if (l.code === cur) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", function () {
      var target = pathForLocale(sel.value) + location.search + location.hash;
      // Stay on the same host; navigate immediately.
      location.assign(target);
    });
    // Same injection logic as the search button — places the picker next
    // to the CTA, whether the CTA lives inside .nav-links or as a sibling.
    injectIntoNav(sel);

    // Minimal styling so the picker doesn't render as a default OS dropdown.
    // Scoped via id so nothing else on the page is affected.
    if (!document.getElementById("nav-lang-style")) {
      var st = document.createElement("style");
      st.id = "nav-lang-style";
      st.textContent =
        '#nav-lang.nav-lang{' +
        'background:transparent;border:1px solid var(--border,rgba(168,85,247,0.18));' +
        'color:var(--text-muted,#5D5475);border-radius:999px;padding:3px 18px 3px 10px;' +
        'font-family:inherit;font-size:12px;cursor:pointer;' +
        '-webkit-appearance:none;appearance:none;' +
        "background-image:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'><path fill='none' stroke='%235D5475' stroke-width='1.5' d='M1 1l4 4 4-4'/></svg>\");" +
        'background-repeat:no-repeat;background-position:right 6px center;background-size:8px 5px;' +
        'transition:color .15s,border-color .15s;' +
        '}' +
        '#nav-lang.nav-lang:hover{color:var(--text,#1A1530);border-color:var(--border-strong,rgba(168,85,247,0.35));}' +
        '[dir="rtl"] #nav-lang.nav-lang{padding:3px 7px 3px 18px;background-position:left 6px center;}';
      document.head.appendChild(st);
    }
  }
})();
