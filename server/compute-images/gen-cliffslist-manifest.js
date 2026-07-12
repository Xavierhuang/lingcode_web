'use strict';
// SP5 tool: turn cliffslist's vercel.json `crons` into a lingcode.compute.json for
// the compute tier. One JOB per distinct route (the container image), one SCHEDULE
// per cron entry (carrying the route's query params as `input`, since the same route
// runs at different cadences with different params — e.g. classify?batch=30 vs =10).
//
//   node gen-cliffslist-manifest.js <path-to-vercel.json> > examples/cliffslist.compute.json
//
// REPLACE_BACKEND_ID in the output with the real backend id, and tune per-job
// memory/timeout (and the browser image for the scraper) before applying.
const fs = require('fs');

const src = process.argv[2] || '/Users/weijiahuang/Desktop/LingCode-main-2/cliffslist/vercel.json';
const crons = (JSON.parse(fs.readFileSync(src, 'utf8')).crons) || [];

// Derive a stable, valid job name from a cron path (sans query).
function jobName(pathname) {
  let p = pathname.replace(/^\/+/, '').replace(/^api\//, '');
  p = p.replace(/^cron\//, '');            // the /api/cron/ namespace
  return p.replace(/\//g, '-').replace(/[^a-z0-9-]/gi, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}
// Heavy/browser heuristics so the artifact is realistic (tune by hand after).
const BROWSER = /custom-url|venue-images|scrape/;
const HEAVY = /cms|classify|tm-feed|fold|reconcile|backfill/;

const jobs = new Map();   // name -> job
const schedules = [];
for (const c of crons) {
  const u = new URL('http://x' + c.path);
  const name = jobName(u.pathname);
  if (!name) continue;
  if (!jobs.has(name)) {
    const browser = BROWSER.test(name);
    jobs.set(name, {
      name,
      image: `lingcode-compute/REPLACE_BACKEND_ID:${name}`,
      timeout_sec: 900,
      memory_mb: browser ? 2048 : (HEAVY.test(name) ? 1024 : 512),
      ...(browser ? { '//': 'build FROM lingcode/compute-browser:20; needs relaxed COMPUTE_HARDEN_FLAGS' } : {}),
    });
  }
  const input = {};
  for (const [k, v] of u.searchParams) input[k] = v;
  schedules.push({ job: name, schedule: c.schedule, overlap_policy: 'skip', ...(Object.keys(input).length ? { input } : {}) });
}

const manifest = {
  '//': `Generated from ${src} by gen-cliffslist-manifest.js. ${jobs.size} jobs, ${schedules.length} schedules. REPLACE_BACKEND_ID + tune memory/timeout/browser before applying. Lightweight HTTP-only crons (warm-*, *-alert, heartbeat) could instead stay on the cheaper worker-cron tier.`,
  jobs: [...jobs.values()],
  schedules,
};
process.stderr.write(`jobs=${jobs.size} schedules=${schedules.length}\n`);
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
