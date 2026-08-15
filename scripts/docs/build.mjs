#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from './frontmatter.mjs';
import { renderMarkdown } from './markdown.mjs';
import { flattenNavigation, renderPage } from './template.mjs';

function optionsFrom(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--source') options.sourceRoot = argv[++index];
    else if (argv[index] === '--output') options.outputRoot = argv[++index];
    else throw new Error(`unknown argument '${argv[index]}'`);
  }
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const websiteRoot = path.resolve(scriptDirectory, '../..');
  options.sourceRoot ||= path.join(websiteRoot, 'docs-src/cloud');
  options.outputRoot ||= path.join(websiteRoot, 'docs/cloud');
  return options;
}

export async function buildDocs({ sourceRoot, outputRoot }) {
  const navigationPath = path.join(sourceRoot, 'navigation.json');
  const navigation = JSON.parse(await readFile(navigationPath, 'utf8'));
  if (!navigation || !Array.isArray(navigation.sections)) throw new Error('navigation.json must contain sections[]');
  const pages = flattenNavigation(navigation);
  const sources = new Set();
  const outputs = new Set();
  for (const page of pages) {
    if (!page.source || !page.output || !page.title) throw new Error('every navigation page requires source, output, and title');
    if (sources.has(page.source)) throw new Error(`duplicate source '${page.source}'`);
    if (outputs.has(page.output)) throw new Error(`duplicate output '${page.output}'`);
    sources.add(page.source); outputs.add(page.output);
  }
  const built = [];
  for (const page of pages) {
    const sourcePath = path.resolve(sourceRoot, page.source);
    const relativeSource = path.relative(path.resolve(sourceRoot), sourcePath);
    if (relativeSource.startsWith('..') || path.isAbsolute(relativeSource)) throw new Error(`source escapes root: ${page.source}`);
    const outputPath = path.resolve(outputRoot, page.output);
    const relativeOutput = path.relative(path.resolve(outputRoot), outputPath);
    if (relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error(`output escapes root: ${page.output}`);
    const document = parseDocument(await readFile(sourcePath, 'utf8'), page.source);
    const rendered = renderMarkdown(document.markdown);
    const pageHtml = renderPage({
      metadata: document.metadata,
      html: rendered.html,
      headings: rendered.headings,
      navigation,
      currentOutput: page.output,
    });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, pageHtml);
    built.push({ ...page, metadata: document.metadata, outputPath });
  }
  return { pages: built };
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  const result = await buildDocs(options);
  process.stdout.write(`Built ${result.pages.length} Cloud documentation page(s).\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Cloud docs build failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
