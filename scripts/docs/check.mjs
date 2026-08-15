#!/usr/bin/env node
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocs } from './build.mjs';

function optionsFrom(argv) {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const websiteRoot = path.resolve(scriptDirectory, '../..');
  const options = {
    sourceRoot: path.join(websiteRoot, 'docs-src/cloud'),
    outputRoot: path.join(websiteRoot, 'docs/cloud'),
    siteRoot: websiteRoot,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--source') options.sourceRoot = path.resolve(argv[++index]);
    else if (argv[index] === '--output') options.outputRoot = path.resolve(argv[++index]);
    else if (argv[index] === '--site-root') options.siteRoot = path.resolve(argv[++index]);
    else throw new Error(`unknown argument '${argv[index]}'`);
  }
  return options;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function linkTarget({ href, sourcePath, outputRoot, siteRoot }) {
  const withoutFragment = href.split('#', 1)[0].split('?', 1)[0];
  if (!withoutFragment) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(withoutFragment) || withoutFragment.startsWith('//')) return null;

  let target;
  if (withoutFragment.startsWith('/docs/cloud')) {
    target = path.join(siteRoot, decodeURIComponent(withoutFragment.slice(1)));
  } else if (withoutFragment.startsWith('./') || withoutFragment.startsWith('../')) {
    target = path.resolve(path.dirname(sourcePath), decodeURIComponent(withoutFragment));
  } else {
    return null;
  }
  if (withoutFragment.endsWith('/')) target = path.join(target, 'index.html');
  return target;
}

async function checkLinks({ pages, outputRoot, siteRoot }) {
  const broken = [];
  for (const page of pages) {
    const sourcePath = path.join(outputRoot, page.output);
    const html = await readFile(sourcePath, 'utf8');
    for (const match of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)) {
      const href = match[1];
      const target = linkTarget({ href, sourcePath, outputRoot, siteRoot });
      if (target && !(await exists(target))) broken.push(`${page.output}: ${href}`);
    }
  }
  if (broken.length) {
    throw new Error(`broken internal link(s):\n${broken.map((entry) => `  ${entry}`).join('\n')}`);
  }
}

export async function checkDocs(options) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'lingcode-docs-check-'));
  try {
    const generatedRoot = path.join(temporaryRoot, 'generated');
    const result = await buildDocs({ sourceRoot: options.sourceRoot, outputRoot: generatedRoot });
    const stale = [];
    for (const page of result.pages) {
      const generated = await readFile(path.join(generatedRoot, page.output), 'utf8');
      const committedPath = path.join(options.outputRoot, page.output);
      const committed = await readFile(committedPath, 'utf8').catch(() => null);
      if (generated !== committed) stale.push(page.output);
    }
    if (stale.length) {
      throw new Error(`stale generated documentation; run node website/scripts/docs/build.mjs:\n${stale.map((entry) => `  ${entry}`).join('\n')}`);
    }
    await checkLinks({ pages: result.pages, outputRoot: options.outputRoot, siteRoot: options.siteRoot });
    return result;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

checkDocs(optionsFrom(process.argv.slice(2))).then((result) => {
  process.stdout.write(`Checked ${result.pages.length} Cloud documentation page(s).\n`);
}).catch((error) => {
  process.stderr.write(`Cloud docs check failed: ${error.message}\n`);
  process.exitCode = 1;
});
