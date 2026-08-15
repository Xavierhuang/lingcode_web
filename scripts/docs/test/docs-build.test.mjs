import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const buildScript = path.join(repoRoot, 'website/scripts/docs/build.mjs');
const checkScript = path.join(repoRoot, 'website/scripts/docs/check.mjs');
const docsCss = path.join(repoRoot, 'website/docs-cloud.css');
const docsJs = path.join(repoRoot, 'website/docs-cloud.js');
const setupScript = path.join(repoRoot, 'website/setup.sh');
const deployScript = path.join(repoRoot, 'website/deploy.sh');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lingcode-docs-'));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  await mkdir(path.join(source, 'functions'), { recursive: true });
  await writeFile(path.join(source, 'navigation.json'), JSON.stringify({
    sections: [{
      title: 'Start',
      pages: [
        { source: 'index.md', output: 'index.html', title: 'Overview' },
        { source: 'functions/queries.md', output: 'functions/queries.html', title: 'Queries' },
      ],
    }],
  }));
  await writeFile(path.join(source, 'index.md'), `---
title: Cloud overview
description: Build a backend.
slug: /
availability: available
updated: 2026-08-09
---
# Cloud overview

Use **PostgreSQL** safely. Read [Queries](./functions/queries.html).

## Start here

\`\`\`js
const unsafe = "<script>";
\`\`\`
`);
  await writeFile(path.join(source, 'functions/queries.md'), `---
title: Reactive queries
description: Subscribe to named backend reads.
slug: /functions/queries.html
availability: preview
updated: 2026-08-09
---
# Reactive queries

This API is not generally available yet.

## Read-only execution

Queries cannot write.
`);
  return { root, source, output };
}

test('builds escaped, navigable HTML and labels preview pages', async () => {
  const { source, output } = await fixture();
  const result = spawnSync(process.execPath, [buildScript, '--source', source, '--output', output], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const overview = await readFile(path.join(output, 'index.html'), 'utf8');
  const preview = await readFile(path.join(output, 'functions/queries.html'), 'utf8');
  assert.match(overview, /<title>Cloud overview \| LingCode Cloud Docs<\/title>/);
  assert.match(overview, /<link rel="canonical" href="https:\/\/lingcode\.dev\/docs\/cloud\/">/);
  assert.match(overview, /<nav class="cloud-docs-sidebar"[^>]*aria-label="Cloud documentation"[^>]*>/);
  assert.match(overview, /aria-current="page"/);
  assert.match(overview, /<nav class="cloud-docs-toc" aria-label="On this page">/);
  assert.match(overview, /id="start-here"/);
  assert.match(overview, /&lt;script&gt;/);
  assert.doesNotMatch(overview, /<script>";<\/code>/);
  assert.match(preview, /Preview/);
  assert.match(preview, /This documentation describes an API that is not generally available yet\./);
  assert.match(preview, /href="\/docs\/cloud\/"[^>]*>Previous/);
});

test('fails when required front matter is missing', async () => {
  const { source, output } = await fixture();
  await writeFile(path.join(source, 'index.md'), '# Missing metadata\n');
  const result = spawnSync(process.execPath, [buildScript, '--source', source, '--output', output], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing front matter/i);
});

test('fails on duplicate output paths', async () => {
  const { source, output } = await fixture();
  const navigation = JSON.parse(await readFile(path.join(source, 'navigation.json'), 'utf8'));
  navigation.sections[0].pages[1].output = 'index.html';
  await writeFile(path.join(source, 'navigation.json'), JSON.stringify(navigation));
  const result = spawnSync(process.execPath, [buildScript, '--source', source, '--output', output], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate output/i);
});

test('ships responsive and accessible documentation navigation assets', async () => {
  const css = await readFile(docsCss, 'utf8');
  const javascript = await readFile(docsJs, 'utf8');
  assert.match(css, /grid-template-columns:\s*minmax\(220px, 280px\) minmax\(0, 760px\) minmax\(180px, 240px\)/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /:focus-visible/);
  assert.match(javascript, /aria-expanded/);
  assert.match(javascript, /Escape/);
});

test('mobile documentation navigation remains correct if initialized twice', async () => {
  const javascript = await readFile(docsJs, 'utf8');
  const toggle = new EventTarget();
  const sidebar = new EventTarget();
  const classes = new Set();
  const attributes = new Map([['aria-expanded', 'false']]);
  toggle.getAttribute = (name) => attributes.get(name) ?? null;
  toggle.setAttribute = (name, value) => attributes.set(name, value);
  toggle.focus = () => {};
  sidebar.classList = {
    toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
  };
  const document = new EventTarget();
  document.querySelector = (selector) => selector === '.cloud-docs-mobile-toggle' ? toggle : null;
  document.getElementById = (id) => id === 'cloud-docs-sidebar' ? sidebar : null;
  const window = new EventTarget();
  window.matchMedia = () => ({ matches: true });
  const context = vm.createContext({ document, window });

  vm.runInContext(javascript, context);
  vm.runInContext(javascript, context);
  toggle.dispatchEvent(new Event('click'));

  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(classes.has('is-open'), true);
});

test('check fails when committed generated HTML is stale', async () => {
  const { source, output, root } = await fixture();
  const build = spawnSync(process.execPath, [buildScript, '--source', source, '--output', output], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  await writeFile(path.join(output, 'index.html'), '<p>stale output</p>');

  const result = spawnSync(process.execPath, [checkScript, '--source', source, '--output', output, '--site-root', root], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stale generated documentation/i);
});

test('check fails on a broken internal documentation link', async () => {
  const { source, output, root } = await fixture();
  const indexPath = path.join(source, 'index.md');
  const markdown = await readFile(indexPath, 'utf8');
  await writeFile(indexPath, markdown.replace('./functions/queries.html', './missing.html'));
  const build = spawnSync(process.execPath, [buildScript, '--source', source, '--output', output], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const result = spawnSync(process.execPath, [checkScript, '--source', source, '--output', output, '--site-root', root], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /broken internal link/i);
});

test('website setup and deploy workflows build and check Cloud docs', async () => {
  const setup = await readFile(setupScript, 'utf8');
  const deploy = await readFile(deployScript, 'utf8');
  assert.match(setup, /docs\|--docs/);
  assert.match(setup, /scripts\/docs\/build\.mjs/);
  assert.match(setup, /scripts\/docs\/check\.mjs/);
  assert.match(deploy, /SKIP_DOCS_BUILD/);
  assert.match(deploy, /scripts\/docs\/build\.mjs/);
  assert.match(deploy, /scripts\/docs\/check\.mjs/);
});
