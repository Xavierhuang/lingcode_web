// main-prompt-addendums.js — pure system-prompt addendum builders.
//
// Each function returns a string the run loop concatenates onto the base
// system prompt before sending to the model. No DOM, no module state —
// just heuristic pattern detectors + curated nudge strings.
//
// Detectors:
//   looksLikeDeck(prompt)         — pitch deck / slides intent
//   looksLikeShopify(prompt)      — Shopify storefront / admin intent
//   looksLikeLiquidTheme(prompt)  — Shopify Liquid theme specifically
//
// Builders:
//   deckAddendum()                — slide structure + export-to-PPTX hint
//   shopifyLiquidAddendum()       — two-block (preview.html + .liquid) output spec
//   shopifyPolarisAddendum()      — Shopify admin app design language
//   docModeAddendum()             — universal deliverable polish + multi-page rules
//   attachmentsAddendum(assets)   — initial-system-prompt path map for attached images
//   buildFollowupAttachmentsAddendum(assets) — follow-up turn injection (system frozen)
//   stackSystemAddendum(stack)    — 'tailwind' / 'react' nudge; '' for 'plain'

export function looksLikeDeck(prompt) {
  return /\b(pitch[-\s]?deck|slide[-\s]?deck|presentation|powerpoint|pptx?|keynote|slides?)\b/i.test(prompt)
      || /幻灯片|演示文稿|路演/.test(prompt);
}

export function deckAddendum() {
  return `\n\nIf the user is asking for a multi-slide deck, structure the output as one HTML file where each slide is a <section class="slide" style="width:1280px;height:720px;display:flex;flex-direction:column;justify-content:center;padding:80px;box-sizing:border-box"> — the playground exports each <section.slide> as one PowerPoint slide. Keep layout consistent across slides and never let any slide need to scroll. Use a single accent color, clear visual hierarchy with large headings, generous whitespace, and short bullets over dense paragraphs.`;
}

export function looksLikeShopify(prompt) {
  return /shopify|liquid|\.liquid|theme\s+section|dawn\s+theme|polaris|storefront|product\s+page|collection\s+grid|cart\s+drawer|shopify\s+app/i.test(prompt);
}

export function looksLikeLiquidTheme(prompt) {
  return /liquid|\.liquid|theme|section|snippet|template|dawn/i.test(prompt) && looksLikeShopify(prompt);
}

export function shopifyLiquidAddendum() {
  return `\n\nFor Shopify Liquid templates, output TWO named fenced code blocks:

1. \`\`\`html name=preview.html — A self-contained HTML file that:
   - Loads LiquidJS from https://cdn.jsdelivr.net/npm/liquidjs@10/dist/liquid.browser.min.js
   - Loads Tailwind from https://cdn.tailwindcss.com
   - Contains a <script type="text/liquid" id="tpl"> block with the Liquid template
   - Contains a <script type="application/json" id="mock-data"> block with realistic mock data
   - On DOMContentLoaded, initializes LiquidJS, parses the template with mock data, renders to <div id="output">
   - Use realistic mock data: products with titles, prices (in cents), images, variants; collections with handles; cart with line items

2. \`\`\`liquid name=product-section.liquid (or section-name.liquid) — The clean, production-ready Shopify Liquid code:
   - Include \`{% schema %}\` block for section settings
   - Use standard Shopify Liquid objects: product, collection, cart, shop, customer
   - Use standard Liquid filters: money, img_url, asset_url, pluralize, date
   - Never hardcode placeholder text — use data objects
   - Make it ready for direct upload to Shopify Theme Editor

Design: use Shopify's Polaris design language (clean, minimal, generous spacing, Shopify green #008060 as accent). Keep the preview visually polished and production-ready.`;
}

export function shopifyPolarisAddendum() {
  return `\n\nFor Shopify admin apps or dashboards, output ONE fenced \`\`\`html block containing a self-contained HTML file that:
   - If building a React-based admin app: use React from CDN (https://esm.sh/react@18 and https://esm.sh/react-dom@18/client) plus Polaris CSS from https://unpkg.com/@shopify/polaris@13/build/esm/styles.css
   - If building a styled-HTML dashboard: replicate Shopify Polaris design language using Tailwind or inline CSS — use Shopify green #008060 as primary color, muted grays for backgrounds, clean card-based layouts
   - Focus on: DataTable or ResourceList for displaying resources (orders, products, customers), summary cards at the top, filters sidebar, action buttons, status badges
   - Make the UI feel like a native Shopify admin experience — professional, minimal, efficient

Emit a complete working HTML file that runs in the browser without a backend.`;
}

// Always appended. Pushes the model toward polished HTML deliverables for
// document-shaped requests, with concrete render tools and concrete design
// discipline (8px grid, modular type scale, color rules) so output matches
// the polish of Stripe / Linear / Vercel rather than generic dark-theme AI.
export function docModeAddendum() {
  return `\n\nWhen the user asks for a deliverable artifact — document, page, deck, report, plan, proposal, resume, dashboard, one-pager, brochure — output ONE fenced \`\`\`html block containing a self-contained HTML file with inline <style> CSS. The playground previews it and exports to PDF or PowerPoint.

Render tools:
- Charts (bar, line, pie, doughnut, scatter, radar): load Chart.js from https://cdn.jsdelivr.net/npm/chart.js and render in a <canvas>. Set options.animation = false so the chart is captured cleanly by the screenshot exporter.
- Diagrams (flowchart, sequence, gantt, org chart, state): use Mermaid from https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js with mermaid.initialize({ startOnLoad: true }).
- Icons, illustrations, decorative shapes: inline SVG only (1.5–2px stroke, rounded line-caps). Do NOT reference external image URLs.

Design discipline — aim for the polish of Stripe, Linear, Vercel, or Apple HIG, not generic AI-generated dark theme:
- Typography: modular scale (12 / 14 / 16 / 20 / 28 / 40 / 64 px). One sans-serif family (system-ui or Inter). Body line-height 1.5–1.6. Sentence case for headings, not Title Case.
- Color: ONE accent color. Everything else is ~5 grays (bg / surface / border / text / text-muted). Avoid pure #000 or #fff — use #0a0a0a and #f9f9fa for true neutrals.
- Spacing: 8 px grid (8 / 16 / 24 / 32 / 48 / 64 / 80). Section padding 64–96 px on desktop. Generous breathing room is a feature, not waste.
- Borders: 1 px, low-opacity (rgba(0,0,0,0.06) on light surfaces, rgba(255,255,255,0.06) on dark).
- Shadows: soft and layered (e.g., 0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06)). Never harsh black shadows.
- Hierarchy: 3 text levels max (display / heading / body) plus a small caption. Make the size jumps between levels obvious — no near-duplicates.
- Buttons: 8 px radius (or fully rounded for primary CTAs), 12–16 px vertical padding, 600 weight.
- Tables / cards: subtle alternating-row tint, never heavy borders. Cards = padded surface + 1px border, no drop shadow unless elevated.
- Alignment: pick a left edge per section and stick to it. No mid-paragraph centered text.

Multi-page websites: if the user is asking for a real website with multiple linked pages (landing page + about + contact, multi-page docs site, etc), output one fenced \`\`\`html block per page with a filename marker:

\`\`\`html name=index.html
<!DOCTYPE html>...
\`\`\`

\`\`\`html name=about.html
<!DOCTYPE html>...
\`\`\`

Use <a href="about.html">…</a> to link between pages — the playground intercepts those clicks and swaps the iframe to the right file. **Inline ALL CSS in <style> in each page** (no external stylesheets across files — keeps the preview self-contained). Each page must be a complete <!DOCTYPE html> document.

npm packages: if the project needs npm packages, emit a \`\`\`json name=package.json\`\`\` block listing \`dependencies\`. The playground auto-builds an importmap from it (via esm.sh) so bare imports like \`import React from 'react'\` work in the browser without any build step. Example:

\`\`\`json name=package.json
{"dependencies":{"react":"18.2.0","react-dom":"18.2.0"}}
\`\`\`

Then in your HTML: \`<script type="module">import React from 'react';</script>\`. Only list packages actually needed at runtime — no bundler/build-tool packages.

Output discipline (when emitting a deliverable):
- Output the COMPLETE file every iteration. NEVER use placeholders like "// rest of the code unchanged", "// ... existing code", "<!-- previous content here -->", or "// (other functions stay the same)". A truncated file breaks the preview — there is no merge step.
- When iterating from a prior turn, emit the FULL updated file with the new changes integrated, not just the changed section. Do NOT restart from scratch unless the user explicitly asks.
- Lead with the code block. Skip preambles like "Sure! Here is…", "I'll create…", "Let me build…". A one-line caption AFTER the block is fine; before it is noise.
- Do not refer to the output as "the artifact", "the prototype", or "the HTML I generated" — just describe what was built ("This page has X", not "This artifact provides X").
- Keep explanatory prose minimal. The deliverable is the answer; commentary is secondary, and only when the user asks for it.

For pure Q&A, explanations, debugging help, or short code snippets, respond plainly — do NOT wrap in HTML. Match output shape to the request.`;
}

// When the user attaches images, expose them to the model as referenceable
// asset paths. Independent of vision: even a text-only model can write
// <img src="assets/logo.png"> if told the path. Vision-capable models *also*
// receive the pixels as content blocks (handled in agent.js) — this addendum
// just teaches every model that paths are how you reference them in code.
export function attachmentsAddendum(assets) {
  if (!assets || assets.size === 0) return '';
  const lines = [...assets.entries()].map(([p, a]) =>
    `- ${p} (${a.mimeType || 'image'}, ${Math.round((a.sizeBytes || 0) / 1024)} KB)`
  ).join('\n');
  return `\n\nThe user has attached image files. They are available at these RELATIVE PATHS in the rendered preview:\n${lines}\n\n` +
    `Reference them DIRECTLY by path in your HTML/CSS — e.g. <img src="assets/logo.png" alt="logo"> or background-image:url('assets/hero.jpg'). ` +
    `Do NOT base64-encode them yourself; the playground swaps the path for the file's bytes when it renders. ` +
    `These attached images are also visible to you as visual reference for layout/colors/style — use them as both visual reference AND code assets.`;
}

// Per-turn follow-up announce. The pane's system prompt was frozen at the
// initial run, so when the user attaches new images mid-conversation we
// prepend this to the user message instead of rebuilding the system prompt.
export function buildFollowupAttachmentsAddendum(assets) {
  if (!assets || assets.size === 0) return '';
  const lines = [...assets.entries()].map(([p, a]) =>
    `- ${p} (${a.mimeType || 'image'}, ${Math.round((a.sizeBytes || 0) / 1024)} KB)`
  ).join('\n');
  return `[I've attached additional images for this turn. They are available at these RELATIVE PATHS in the rendered preview:\n${lines}\n` +
    `Reference them by path in HTML (e.g. <img src="${[...assets.keys()][0]}">) — the playground swaps the path for the file's bytes at render time.]`;
}

/// Returns the system-prompt addendum that nudges the model to emit code
/// in the chosen stack. Empty string for 'plain' (no nudge).
export function stackSystemAddendum(stack) {
  if (stack === 'tailwind') {
    return `\n\nWhen producing UI, output ONE single fenced \`\`\`html block containing a self-contained index.html. Include \`<script src="https://cdn.tailwindcss.com"></script>\` in the <head> and use Tailwind utility classes for all styling. Avoid custom <style> blocks unless absolutely necessary. Add a 'dark' class on <html> when a dark theme is requested.`;
  }
  if (stack === 'react') {
    return `\n\nWhen producing UI, output ONE single fenced \`\`\`html block containing a self-contained index.html that runs React in the browser via esm.sh. Use this preamble inside the body:\n\n<div id="root"></div>\n<script type="module">\n  import React, { useState, useEffect } from 'https://esm.sh/react@18';\n  import { createRoot } from 'https://esm.sh/react-dom@18/client';\n  // …components…\n  createRoot(document.getElementById('root')).render(<App/>);\n</script>\n\nWrite component code in JSX inside that <script type="module"> tag — modern browsers run it via esm.sh's automatic JSX transform when you add \`?dev\` to the import (e.g. https://esm.sh/react@18?dev). Style with Tailwind via CDN if possible, otherwise inline <style>.`;
  }
  return '';
}

// Appended to the system prompt for the automatic "Final polish" turn only
// (runFollowup source 'polish'). Deliberately a REFINE-don't-restructure brief:
// the app already works after Scaffold, so this pass must not regress it.
export function polishSystemAddendum() {
  return `\n\nThis is a FINAL POLISH pass on the app you just produced. Refine it — do NOT redesign or rewrite it. Output the COMPLETE updated file in ONE fenced code block (same stack/format as before).
Improve, in priority order:
- Responsiveness: graceful layout from ~360px mobile up to desktop (no overflow, no clipped content).
- States: add empty, loading, and error states wherever data or async actions exist; disable buttons while pending.
- Accessibility: semantic elements, labels/alt text, visible :focus styles, keyboard operability, sufficient color contrast.
- Interaction feel: subtle :hover/:active/transition affordances on interactive elements.
- Visual consistency: align spacing, radii, and the existing color palette; fix obvious overflow/alignment glitches.
Hard constraints: do NOT change the app's core logic, data flow, feature set, copy, or DOM structure beyond what these refinements require; do NOT rename things; do NOT remove working features; keep all existing element ids/classes the app relies on. If the app is already solid, make only minimal improvements rather than inventing changes.`;
}
