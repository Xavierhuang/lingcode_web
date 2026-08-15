'use strict';

// Pins the detection + rewrite behavior of maybeUpgradeAssetsStub — the
// server-side "if the client shipped the trivial static-assets stub, rewrite
// it to force Cache-Control: no-store" step in cloud-workers.js.
//
// Why this matters:
//   1. If the regex loosens accidentally, we'd start rewriting real workers
//      (Next/OpenNext, SvelteKit, Nuxt, Astro, Vite Worker — everything the
//      Mac IDE ships via CloudDeployService.swift), silently mangling backend
//      apps into static asset servers. That is a data-destroying regression.
//   2. If the regex tightens accidentally, LingCodeBaby deploys stop getting
//      the no-store upgrade and deleted apps go back to serving stale bytes
//      from the Cloudflare edge for minutes after DELETE.
//
// Keep the "must match" and "must NOT match" fixtures in sync with what the
// clients actually emit: LingCodeBaby Windows in
//   lingcodebaby_windows-main/src-tauri/src/deploy.rs (build_bundle)
// and LingCodeBaby Mac in
//   LingCodeBaby/src/CloudDeploy.m (the four @-string lines).

const test = require('node:test');
const assert = require('node:assert');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const {
  maybeUpgradeAssetsStub,
  BABY_STUB_RE,
  NO_STORE_STUB,
} = require('../cloud-workers');

// ── Fixtures ──────────────────────────────────────────────────────────────

// EXACT byte-string both Baby clients emit today. Do NOT reformat.
const BABY_STUB =
  'export default {\n' +
  '  async fetch(request, env) {\n' +
  '    return env.ASSETS.fetch(request);\n' +
  '  }\n' +
  '};\n';

// Small whitespace variants that should still be recognized as the trivial
// static-assets stub. If you tighten the regex enough to break these, you
// probably broke the real-world stubs too.
const BABY_STUB_TABS = BABY_STUB.replace(/  /g, '\t');
const BABY_STUB_CRLF = BABY_STUB.replace(/\n/g, '\r\n');
const BABY_STUB_NO_TRAILING_NEWLINE = BABY_STUB.replace(/\n$/, '');
const BABY_STUB_SEMICOLON_STYLE =
  'export default {\n' +
  '  async fetch(request, env) {\n' +
  '    return env.ASSETS.fetch(request);\n' +
  '  },\n' +               // trailing comma inside the object literal
  '};';                    // no trailing newline, closing semicolon

// Real workers — MUST be rejected. Each represents a real framework shipped
// via the Mac IDE. Silently rewriting any of these breaks a real app.
const NEXT_OPENNEXT =
  'import { handler } from "./chunk-abc.mjs";\n' +
  'export default { async fetch(request, env, ctx) { return handler(request, env, ctx); } };';

const SVELTEKIT =
  'import { Server } from "./index.js";\n' +
  'const server = new Server(manifest);\n' +
  'export default {\n' +
  '  async fetch(request, env, ctx) {\n' +
  '    return server.respond(request, { platform: { env, ctx } });\n' +
  '  }\n' +
  '};\n';

const MOSTLY_ASSETS_BUT_WITH_ROUTE =
  'export default {\n' +
  '  async fetch(request, env) {\n' +
  '    const url = new URL(request.url);\n' +
  '    if (url.pathname === "/api/hi") return new Response("hi");\n' +
  '    return env.ASSETS.fetch(request);\n' +
  '  }\n' +
  '};\n';

const OBFUSCATED_ASSETS_CALL =
  'const A = "ASSETS";\n' +
  'export default { async fetch(r, env) { return env[A].fetch(r); } };\n';

// ── Regex-level checks (fast, no I/O) ─────────────────────────────────────

test('BABY_STUB_RE — matches the exact Baby stub both clients ship', () => {
  assert.ok(BABY_STUB_RE.test(BABY_STUB), 'baseline Baby stub must match');
});

test('BABY_STUB_RE — matches tab-indented variant', () => {
  assert.ok(BABY_STUB_RE.test(BABY_STUB_TABS));
});

test('BABY_STUB_RE — matches CRLF line endings (Windows checkouts)', () => {
  // maybeUpgradeAssetsStub normalizes CRLF -> LF before testing, but the
  // regex itself should also tolerate whitespace variance; sanity-check the
  // NORMALIZED form (that is what the function tests against).
  const normalized = BABY_STUB_CRLF.replace(/\r\n/g, '\n');
  assert.ok(BABY_STUB_RE.test(normalized));
});

test('BABY_STUB_RE — matches variant without trailing newline', () => {
  assert.ok(BABY_STUB_RE.test(BABY_STUB_NO_TRAILING_NEWLINE));
});

test('BABY_STUB_RE — matches trailing-comma/no-final-newline style', () => {
  assert.ok(BABY_STUB_RE.test(BABY_STUB_SEMICOLON_STYLE));
});

test('BABY_STUB_RE — rejects the NO_STORE_STUB (no infinite rewrite loop)', () => {
  assert.equal(BABY_STUB_RE.test(NO_STORE_STUB), false,
    'the rewritten stub must NOT re-match, or a redeploy would re-rewrite forever');
});

test('BABY_STUB_RE — rejects Next.js/OpenNext-shaped worker', () => {
  assert.equal(BABY_STUB_RE.test(NEXT_OPENNEXT), false);
});

test('BABY_STUB_RE — rejects SvelteKit-shaped worker', () => {
  assert.equal(BABY_STUB_RE.test(SVELTEKIT), false);
});

test('BABY_STUB_RE — rejects "mostly forwards but has one route" worker', () => {
  // This is the critical "false-positive prevention" case: a real app that
  // ships one custom endpoint AND falls back to ASSETS for everything else.
  // If the regex ever loosened to accept this, we would strip that endpoint.
  assert.equal(BABY_STUB_RE.test(MOSTLY_ASSETS_BUT_WITH_ROUTE), false);
});

test('BABY_STUB_RE — rejects obfuscated ASSETS lookup via bracket access', () => {
  assert.equal(BABY_STUB_RE.test(OBFUSCATED_ASSETS_CALL), false);
});

// ── Filesystem-level checks (real workdir, real read/write) ───────────────
//
// The function operates on a workdir with the same layout the tar upload
// extracts to: <workdir>/dist/server/{_worker.js, wrangler.json, public/…}.

async function makeWorkdir(worker, cfg) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'baby-stub-test.'));
  await fsp.mkdir(path.join(dir, 'dist', 'server'), { recursive: true });
  if (worker !== null) {
    await fsp.writeFile(path.join(dir, 'dist', 'server', '_worker.js'), worker, 'utf8');
  }
  if (cfg !== null) {
    await fsp.writeFile(
      path.join(dir, 'dist', 'server', 'wrangler.json'),
      typeof cfg === 'string' ? cfg : JSON.stringify(cfg, null, 2),
      'utf8'
    );
  }
  return dir;
}

async function rm(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

test('maybeUpgradeAssetsStub — rewrites Baby stub + patches wrangler.json', async (t) => {
  const dir = await makeWorkdir(BABY_STUB, {
    name: 'lingcode-app',
    main: '_worker.js',
    compatibility_date: '2025-03-01',
    assets: { directory: 'public', binding: 'ASSETS', not_found_handling: 'single-page-application' },
  });
  t.after(() => rm(dir));

  const result = await maybeUpgradeAssetsStub(dir);
  assert.equal(result.upgraded, true, `expected upgraded:true, got ${JSON.stringify(result)}`);

  // _worker.js was replaced byte-for-byte with NO_STORE_STUB.
  const newWorker = await fsp.readFile(path.join(dir, 'dist', 'server', '_worker.js'), 'utf8');
  assert.equal(newWorker, NO_STORE_STUB);
  assert.match(newWorker, /Cache-Control/);
  assert.match(newWorker, /no-store/);

  // wrangler.json gained assets.run_worker_first = true (required for the
  // header override to actually apply — CF Assets short-circuits otherwise).
  const newCfg = JSON.parse(await fsp.readFile(path.join(dir, 'dist', 'server', 'wrangler.json'), 'utf8'));
  assert.equal(newCfg.assets.run_worker_first, true);
  // Other assets fields survive.
  assert.equal(newCfg.assets.directory, 'public');
  assert.equal(newCfg.assets.binding, 'ASSETS');
  assert.equal(newCfg.assets.not_found_handling, 'single-page-application');
  // Top-level fields survive.
  assert.equal(newCfg.name, 'lingcode-app');
  assert.equal(newCfg.main, '_worker.js');
});

test('maybeUpgradeAssetsStub — leaves a real worker alone', async (t) => {
  const dir = await makeWorkdir(NEXT_OPENNEXT, {
    name: 'lingcode-app',
    main: '_worker.js',
    assets: { directory: 'public', binding: 'ASSETS' },
  });
  t.after(() => rm(dir));

  const result = await maybeUpgradeAssetsStub(dir);
  assert.equal(result.upgraded, false);

  // _worker.js is byte-identical.
  const worker = await fsp.readFile(path.join(dir, 'dist', 'server', '_worker.js'), 'utf8');
  assert.equal(worker, NEXT_OPENNEXT);

  // wrangler.json is NOT patched (no run_worker_first added).
  const cfg = JSON.parse(await fsp.readFile(path.join(dir, 'dist', 'server', 'wrangler.json'), 'utf8'));
  assert.equal(cfg.assets.run_worker_first, undefined);
});

test('maybeUpgradeAssetsStub — leaves the mostly-forwards-but-has-a-route worker alone', async (t) => {
  const dir = await makeWorkdir(MOSTLY_ASSETS_BUT_WITH_ROUTE, {
    assets: { directory: 'public', binding: 'ASSETS' },
  });
  t.after(() => rm(dir));

  const result = await maybeUpgradeAssetsStub(dir);
  assert.equal(result.upgraded, false, 'a real worker with one route MUST NOT be rewritten');

  const worker = await fsp.readFile(path.join(dir, 'dist', 'server', '_worker.js'), 'utf8');
  assert.equal(worker, MOSTLY_ASSETS_BUT_WITH_ROUTE, 'source must be byte-identical');
});

test('maybeUpgradeAssetsStub — missing _worker.js returns upgraded:false without throwing', async (t) => {
  const dir = await makeWorkdir(null, { assets: { directory: 'public', binding: 'ASSETS' } });
  t.after(() => rm(dir));

  const result = await maybeUpgradeAssetsStub(dir);
  assert.equal(result.upgraded, false);
  assert.match(result.reason, /no _worker\.js/);
});

test('maybeUpgradeAssetsStub — malformed wrangler.json is non-fatal; worker is still upgraded', async (t) => {
  const dir = await makeWorkdir(BABY_STUB, '{ not valid json');
  t.after(() => rm(dir));

  const result = await maybeUpgradeAssetsStub(dir);
  assert.equal(result.upgraded, true, 'worker rewrite must succeed even if wrangler.json is broken');

  const worker = await fsp.readFile(path.join(dir, 'dist', 'server', '_worker.js'), 'utf8');
  assert.equal(worker, NO_STORE_STUB);
});

test('maybeUpgradeAssetsStub — wrangler.json without assets{} is left alone (no key materialized)', async (t) => {
  // A wrangler.json with no assets binding is nonsensical for a Baby app, but
  // the code must not add an assets{} out of nowhere.
  const dir = await makeWorkdir(BABY_STUB, { name: 'lingcode-app', main: '_worker.js' });
  t.after(() => rm(dir));

  const result = await maybeUpgradeAssetsStub(dir);
  assert.equal(result.upgraded, true);

  const cfg = JSON.parse(await fsp.readFile(path.join(dir, 'dist', 'server', 'wrangler.json'), 'utf8'));
  assert.equal(cfg.assets, undefined, 'must NOT synthesize an assets binding');
});

test('maybeUpgradeAssetsStub — after upgrade, a second call is a no-op (idempotent)', async (t) => {
  const dir = await makeWorkdir(BABY_STUB, {
    assets: { directory: 'public', binding: 'ASSETS' },
  });
  t.after(() => rm(dir));

  const first = await maybeUpgradeAssetsStub(dir);
  assert.equal(first.upgraded, true);

  const second = await maybeUpgradeAssetsStub(dir);
  assert.equal(second.upgraded, false,
    'the rewritten stub must not re-match; otherwise re-runs churn forever');
});
