// webcontainer-host.js — Phase 1 main module. Wraps StackBlitz's
// @webcontainer/api so /try-app.html can run a real Vite dev server
// inside the browser, file edits flow through hot-reload, and the AI's
// Tier-2 tools (read_file/write_file/list_files/run_command) execute
// against a real Node FS.
//
// IMPORTANT — this module ships ahead of the SDK install. Until you
// register at https://webcontainers.io and either:
//   (a) install `@webcontainer/api` and import it from a bundled entry
//       served with the right COOP/COEP headers, or
//   (b) load it from a CDN that allows your license (StackBlitz hosts
//       their own; commercial licensees get instructions),
// the loader is null and isAvailable() returns false. The UI surfaces
// this as "Tier 2 not configured" — no crashes, no broken imports.
//
// Wire-up (after license + npm install):
//   import { setLoader } from './webcontainer-host.js';
//   import { WebContainer } from '@webcontainer/api';   // or your CDN URL
//   setLoader(() => Promise.resolve(WebContainer));
//
// Required infrastructure on the page that loads this module:
//   - HTTP headers: Cross-Origin-Opener-Policy: same-origin
//                   Cross-Origin-Embedder-Policy: require-corp
//   - These break esm.sh imports — keep this isolation on /try-app.html
//     ONLY, not /try.html (Tier-1 stays as-is).

let _loader = null;             // () => Promise<typeof WebContainer>
let _container = null;          // WebContainer instance once booted
let _bootPromise = null;        // in-flight boot
let _serverUrl = null;          // from the 'server-ready' event
let _serverReadyPromise = null;
let _serverReadyResolve = null;
let _runningProcs = new Map();  // pid → process handle (background runs)
let _nextPid = 1;

/**
 * Register the WebContainer constructor loader. Idempotent — second
 * call replaces the loader (useful in HMR development).
 * @param {() => Promise<{ boot(): Promise<any> }>} fn
 */
export function setLoader(fn) {
  if (typeof fn !== 'function') throw new Error('setLoader: function required');
  _loader = fn;
}

export function isAvailable() {
  return _loader !== null;
}

export function isBooted() {
  return _container !== null;
}

export function getServerUrl() {
  return _serverUrl;
}

function assertAvailable() {
  if (!_loader) {
    throw new Error(
      'WebContainer not configured. Call setLoader(loadFn) after registering for @webcontainer/api ' +
      '(see webcontainer-host.js header).',
    );
  }
}

async function boot() {
  if (_container) return _container;
  if (_bootPromise) return _bootPromise;
  assertAvailable();
  _bootPromise = (async () => {
    const WebContainer = await _loader();
    if (!WebContainer || typeof WebContainer.boot !== 'function') {
      throw new Error('WebContainer loader returned an unexpected value (expected the WebContainer class).');
    }
    const c = await WebContainer.boot();
    // Expose server-ready as a promise/getter pair so callers can either
    // await serverReady() or read the URL synchronously after the event.
    _serverReadyPromise = new Promise((resolve) => { _serverReadyResolve = resolve; });
    c.on('server-ready', (_port, url) => {
      _serverUrl = url;
      _serverReadyResolve?.(url);
    });
    _container = c;
    return c;
  })();
  return _bootPromise;
}

// Convert a flat `{ path: contents }` map (the shape returned by
// scaffold-manifest.js's loadScaffold) into the nested FileSystemTree
// format @webcontainer/api expects:
//   { 'src': { directory: { 'App.tsx': { file: { contents: '...' } } } } }
function flatToTree(files) {
  const tree = {};
  for (const path of Object.keys(files)) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    const last = parts.pop();
    let cursor = tree;
    for (const seg of parts) {
      if (!cursor[seg]) cursor[seg] = { directory: {} };
      else if (!cursor[seg].directory) {
        // Conflict: a file path shadows a directory path. Surface clearly
        // rather than letting the SDK fail with a cryptic message.
        throw new Error(`Scaffold path conflict: "${seg}" is both a file and a directory`);
      }
      cursor = cursor[seg].directory;
    }
    cursor[last] = { file: { contents: files[path] } };
  }
  return tree;
}

/**
 * Mount a flat `{ path: contents }` files map (from scaffold-manifest's
 * loadScaffold). Boots the container if needed. Replaces any existing FS.
 * @param {Record<string,string>} files
 */
export async function mount(files) {
  const c = await boot();
  await c.mount(flatToTree(files));
}

/**
 * Write a single file (creates intermediate dirs).
 */
export async function writeFile(path, contents) {
  const c = await boot();
  // WebContainer.fs expects a leading slash for absolute paths.
  const abs = path.startsWith('/') ? path : '/' + path;
  // mkdir -p on the parent.
  const parent = abs.replace(/\/[^/]*$/, '');
  if (parent && parent !== abs) {
    await c.fs.mkdir(parent, { recursive: true }).catch(() => { /* exists is fine */ });
  }
  await c.fs.writeFile(abs, contents);
}

export async function readFile(path) {
  const c = await boot();
  const abs = path.startsWith('/') ? path : '/' + path;
  return c.fs.readFile(abs, 'utf-8');
}

export async function listFiles(path = '') {
  const c = await boot();
  const abs = path.startsWith('/') ? path : '/' + (path || '');
  const entries = await c.fs.readdir(abs || '/', { withFileTypes: true });
  return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
}

/**
 * Run a shell command. Two modes:
 *   - Default (start: false): runs to completion, returns
 *     { exitCode, stdout, stderr }. Use for one-shot npm install,
 *     npm run build, npx supabase migrations etc.
 *   - Background (start: true): spawns and returns { pid } immediately.
 *     Caller can later kill via stopCommand(pid). Use for `npm run dev`
 *     where the dev server stays up indefinitely.
 *
 * `cwd` is relative to the container root (default /).
 */
export async function runCommand(command, args = [], { cwd = '', start = false, onChunk } = {}) {
  const c = await boot();
  const proc = await c.spawn(command, args, cwd ? { cwd } : undefined);
  if (start) {
    const pid = _nextPid++;
    _runningProcs.set(pid, proc);
    // Drain stdout in the background so the buffer doesn't stall the
    // process, but don't await — caller wants to return immediately.
    proc.output.pipeTo(new WritableStream({
      write(chunk) { onChunk?.({ pid, chunk }); },
    })).catch(() => { /* process killed */ });
    proc.exit.then(() => _runningProcs.delete(pid));
    return { pid };
  }
  let stdout = '';
  await proc.output.pipeTo(new WritableStream({
    write(chunk) { stdout += chunk; onChunk?.({ chunk }); },
  }));
  const exitCode = await proc.exit;
  return { exitCode, stdout, stderr: '' /* WebContainer merges; v1 doesn't split */ };
}

/**
 * Kill a backgrounded process started with runCommand({ start: true }).
 */
export async function stopCommand(pid) {
  const proc = _runningProcs.get(pid);
  if (!proc) return false;
  proc.kill();
  _runningProcs.delete(pid);
  return true;
}

/**
 * Convenience: install deps + start the dev server, return the preview URL
 * once `server-ready` fires. Times out after 90s on first run (npm
 * install can be slow), 30s on subsequent runs.
 */
export async function installAndServe({ devCommand = ['npm', ['run', 'dev']], installTimeoutMs = 180_000, serveTimeoutMs = 90_000, onStatus } = {}) {
  await boot();
  onStatus?.('Installing dependencies…');
  const install = await Promise.race([
    runCommand('npm', ['install'], {
      onChunk: ({ chunk }) => onStatus?.(chunk.split('\n').pop().trim() || 'Installing…'),
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('npm install timeout')), installTimeoutMs)),
  ]);
  if (install.exitCode !== 0) {
    throw new Error(`npm install failed (exit ${install.exitCode}): ${install.stdout.slice(-500)}`);
  }
  onStatus?.('Starting dev server…');
  await runCommand(devCommand[0], devCommand[1] || [], { start: true });
  // Wait for server-ready event registered during boot().
  return Promise.race([
    _serverReadyPromise || Promise.reject(new Error('serverReadyPromise unset; boot() likely failed')),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Dev server start timeout')), serveTimeoutMs)),
  ]);
}

/**
 * Tear down the container. After shutdown, isBooted() returns false and
 * the next mount() call boots a fresh instance. Useful for "discard and
 * start over" UX.
 */
export async function shutdown() {
  for (const [, proc] of _runningProcs) { try { proc.kill(); } catch { /* ignore */ } }
  _runningProcs.clear();
  if (_container && typeof _container.teardown === 'function') {
    try { await _container.teardown(); } catch { /* ignore */ }
  }
  _container = null;
  _bootPromise = null;
  _serverUrl = null;
  _serverReadyPromise = null;
  _serverReadyResolve = null;
}

// ---- Test seams (intentionally underscored — do not import in prod) ----
export function _flatToTree(files) { return flatToTree(files); }
export function _resetForTests() {
  _loader = null;
  _container = null;
  _bootPromise = null;
  _serverUrl = null;
  _serverReadyPromise = null;
  _serverReadyResolve = null;
  _runningProcs.clear();
  _nextPid = 1;
}
