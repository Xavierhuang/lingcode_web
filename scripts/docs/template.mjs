import { escapeHtml } from './markdown.mjs';

function outputUrl(output) {
  if (output === 'index.html') return '/docs/cloud/';
  if (output.endsWith('/index.html')) return `/docs/cloud/${output.slice(0, -10)}`;
  return `/docs/cloud/${output}`;
}

function flattenNavigation(navigation) {
  return navigation.sections.flatMap((section) => section.pages.map((page) => ({ ...page, section: section.title })));
}

function renderSidebar(navigation, currentOutput) {
  return navigation.sections.map((section) => `
        <section class="cloud-docs-nav-section">
          <h2>${escapeHtml(section.title)}</h2>
          <ul>${section.pages.map((page) => {
            const current = page.output === currentOutput ? ' aria-current="page"' : '';
            return `<li><a href="${outputUrl(page.output)}"${current}>${escapeHtml(page.title)}</a></li>`;
          }).join('')}</ul>
        </section>`).join('');
}

function renderToc(headings) {
  const visible = headings.filter((heading) => heading.level === 2 || heading.level === 3);
  if (!visible.length) return '<p class="cloud-docs-toc-empty">No sections</p>';
  return `<ol>${visible.map((heading) => `<li class="toc-level-${heading.level}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`).join('')}</ol>`;
}

export function renderPage({ metadata, html, headings, navigation, currentOutput, hasZh = false }) {
  const pages = flattenNavigation(navigation);
  const position = pages.findIndex((page) => page.output === currentOutput);
  const previous = position > 0 ? pages[position - 1] : null;
  const next = position >= 0 && position < pages.length - 1 ? pages[position + 1] : null;
  const canonicalPath = metadata.slug === '/' ? '/docs/cloud/' : `/docs/cloud${metadata.slug}`;
  const preview = metadata.availability === 'preview';
  const h1 = headings.find((heading) => heading.level === 1);
  if (!h1) throw new Error(`${currentOutput}: page must contain one H1`);
  if (headings.filter((heading) => heading.level === 1).length !== 1) throw new Error(`${currentOutput}: page must contain exactly one H1`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(metadata.title)} | LingCode Cloud Docs</title>
  <meta name="description" content="${escapeHtml(metadata.description)}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://lingcode.dev${canonicalPath}">
  <link rel="alternate" hreflang="en" href="https://lingcode.dev${canonicalPath}">
${hasZh ? `  <link rel="alternate" hreflang="zh" href="https://lingcode.dev/zh/docs/cloud/${currentOutput}">\n` : ''}  <link rel="alternate" hreflang="x-default" href="https://lingcode.dev${canonicalPath}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="https://lingcode.dev${canonicalPath}">
  <meta property="og:title" content="${escapeHtml(metadata.title)}">
  <meta property="og:description" content="${escapeHtml(metadata.description)}">
  <meta property="og:image" content="https://lingcode.dev/og-image.png">
  <meta property="og:locale" content="en_US">
  <meta property="og:site_name" content="LingCode">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(metadata.title)}">
  <meta name="twitter:description" content="${escapeHtml(metadata.description)}">
  <script type="application/ld+json">
${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: metadata.title,
    description: metadata.description,
    url: `https://lingcode.dev${canonicalPath}`,
    image: 'https://lingcode.dev/og-image.png',
    dateModified: metadata.updated,
    inLanguage: 'en',
    isPartOf: { '@type': 'WebSite', name: 'LingCode', url: 'https://lingcode.dev/' },
    publisher: { '@type': 'Organization', name: 'LingCode', url: 'https://lingcode.dev/' },
  }, null, 2)}
  </script>
  <script type="application/ld+json">
${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Docs', item: 'https://lingcode.dev/docs.html' },
      { '@type': 'ListItem', position: 2, name: 'Cloud', item: 'https://lingcode.dev/docs/cloud/' },
      { '@type': 'ListItem', position: 3, name: metadata.title, item: `https://lingcode.dev${canonicalPath}` },
    ],
  }, null, 2)}
  </script>
  <script src="/analytics.js?v=20260428a" async></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&display=swap">
  <link rel="stylesheet" href="/style.css?v=20260731a">
  <link rel="stylesheet" href="/tutorials-newdesign.css?v=20260731a">
  <link rel="stylesheet" href="/docs-cloud.css?v=20260809a">
</head>
<body>
  <a class="cloud-docs-skip" href="#cloud-docs-content">Skip to documentation</a>
  <nav class="site-nav">
    <a href="/" class="logo"><span class="logo-mark">L</span><span class="logo-name">LingCode</span></a>
    <ul class="nav-links"><li><a href="/cloud.html">Cloud</a></li><li><a href="/docs.html">Docs</a></li><li><a href="/tutorials.html">Tutorials</a></li></ul>
    <div class="nav-cta"><a class="btn btn-ghost" href="/signin.html">Sign in</a><a class="btn btn-primary" href="/LingCode-Installer.dmg" download>Download →</a></div>
  </nav>
  <button class="cloud-docs-mobile-toggle" type="button" aria-expanded="false" aria-controls="cloud-docs-sidebar">Browse Cloud docs</button>
  <div class="cloud-docs-shell">
    <nav class="cloud-docs-sidebar" aria-label="Cloud documentation" id="cloud-docs-sidebar">${renderSidebar(navigation, currentOutput)}
    </nav>
    <main id="cloud-docs-content" class="cloud-docs-article" data-pagefind-body>
      <div class="cloud-docs-breadcrumb"><a href="/docs.html">Docs</a><span>/</span><a href="/docs/cloud/">Cloud</a><span>/</span><span>${escapeHtml(metadata.title)}</span></div>
      <div class="cloud-docs-meta"><span class="cloud-docs-status ${preview ? 'is-preview' : 'is-available'}">${preview ? 'Preview' : 'Available'}</span><span>Updated ${escapeHtml(metadata.updated)}</span></div>
${preview ? '      <div class="cloud-docs-preview-warning" role="note"><strong>Preview:</strong> This documentation describes an API that is not generally available yet. Its contract may change before release.</div>\n' : ''}      ${html}
      <footer class="cloud-docs-page-footer">
        <div>${previous ? `<a class="cloud-docs-prev" href="${outputUrl(previous.output)}">Previous: ${escapeHtml(previous.title)}</a>` : ''}</div>
        <div>${next ? `<a class="cloud-docs-next" href="${outputUrl(next.output)}">Next: ${escapeHtml(next.title)}</a>` : ''}</div>
      </footer>
    </main>
    <nav class="cloud-docs-toc" aria-label="On this page"><h2>On this page</h2>${renderToc(headings)}</nav>
  </div>
  <script src="/nav.js?v=20260809a"></script>
  <script src="/docs-cloud.js?v=20260809c"></script>
</body>
</html>\n`;
}

export { flattenNavigation, outputUrl };
