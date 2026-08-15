const REQUIRED = ['title', 'description', 'slug', 'availability', 'updated'];
const AVAILABILITY = new Set(['available', 'preview']);

export function parseDocument(source, filePath = '<document>') {
  const normalized = String(source).replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error(`${filePath}: missing front matter`);
  }
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) throw new Error(`${filePath}: unterminated front matter`);
  const metadata = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([a-z][a-z0-9_-]*):\s*(.*)$/i);
    if (!match) throw new Error(`${filePath}: invalid front matter line: ${line}`);
    const [, key, raw] = match;
    if (Object.hasOwn(metadata, key)) throw new Error(`${filePath}: duplicate front matter key '${key}'`);
    metadata[key] = raw.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_m, double, single) => double ?? single);
  }
  for (const key of REQUIRED) {
    if (!metadata[key]) throw new Error(`${filePath}: missing required front matter '${key}'`);
  }
  if (!AVAILABILITY.has(metadata.availability)) {
    throw new Error(`${filePath}: availability must be available or preview`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(metadata.updated)) {
    throw new Error(`${filePath}: updated must use YYYY-MM-DD`);
  }
  if (!metadata.slug.startsWith('/')) throw new Error(`${filePath}: slug must start with /`);
  return { metadata, markdown: normalized.slice(end + 5).trim() + '\n' };
}
