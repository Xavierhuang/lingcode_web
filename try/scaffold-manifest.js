// scaffold-manifest.js — entry point for Tier-2 starter scaffolds.
//
// A scaffold is a static directory under /try/scaffold/<id>/ that the
// Phase-1 WebContainer host mounts as the initial FS for a Tier-2 prototype.
// loadScaffold() fetches every file in the manifest in parallel and returns
// a `{ [path]: contents }` map ready for WebContainer mount().
//
// Adding a new scaffold:
//   1. Drop files under /try/scaffold/<id>/
//   2. Append an entry to SCAFFOLDS with the id, label, and file list
//   3. Run scripts/regen-scaffold-manifest.js (planned) — until that lands,
//      keep the file list in sync by hand.

export const SCAFFOLDS = [
  {
    id: 'tier2-react',
    label: 'Vite + React + TS + Tailwind + shadcn',
    description:
      'Production-grade starter with shadcn/ui, Tailwind CSS variables, dark mode, and a Supabase client wired to VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY env vars.',
    entry: 'src/App.tsx',
    devCommand: ['npm', ['run', 'dev']],
    buildCommand: ['npm', ['run', 'build']],
    files: [
      '.gitignore',
      'components.json',
      'index.html',
      'package.json',
      'postcss.config.js',
      'src/App.tsx',
      'src/components/ui/button.tsx',
      'src/index.css',
      'src/lib/supabase.ts',
      'src/lib/utils.ts',
      'src/main.tsx',
      'src/vite-env.d.ts',
      'tailwind.config.ts',
      'tsconfig.json',
      'tsconfig.node.json',
      'vite.config.ts',
    ],
  },
];

export function getScaffold(id) {
  return SCAFFOLDS.find((s) => s.id === id) || null;
}

// Fetches every file in the named scaffold in parallel and returns a
// `{ [path]: string }` map. Throws if the scaffold id is unknown or if
// any file fetch fails — partial scaffolds are not useful and would
// produce confusing build errors at npm install time.
export async function loadScaffold(id, { baseUrl = '/try/scaffold' } = {}) {
  const scaffold = getScaffold(id);
  if (!scaffold) throw new Error(`Unknown scaffold id: ${id}`);
  const entries = await Promise.all(
    scaffold.files.map(async (path) => {
      const res = await fetch(`${baseUrl}/${scaffold.id}/${path}`);
      if (!res.ok) throw new Error(`Scaffold fetch failed: ${path} (${res.status})`);
      return [path, await res.text()];
    }),
  );
  return Object.fromEntries(entries);
}
