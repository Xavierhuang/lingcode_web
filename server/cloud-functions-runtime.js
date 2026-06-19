'use strict';

// cloud-functions-runtime.js — execute arbitrary customer function code in a
// sandboxed Deno subprocess.
//
// Each invocation spawns a fresh `deno run` with deny-by-default permissions:
//   --deny-read --deny-write --deny-env --deny-ffi --deny-run  (no FS/env/exec)
//   --allow-net=<gatewayHost>  (only the backend's own gateway; else --deny-net)
// The customer source and the call input/ctx are piped in via STDIN (no temp
// files — nothing touches the droplet disk); the result comes back on STDOUT
// after a sentinel so the function's own console output can't corrupt parsing.
// A SIGKILL timeout + a v8 old-space cap bound runaway code.
//
// Security note: the API process itself runs unsandboxed, so the *process
// boundary* is the protection. The boundaries (FS read blocked, net denied
// except the gateway) are verified by the cloud-functions test in CI/manual
// smoke — do not relax the flags without re-checking them.

const { spawn } = require('child_process');

const RESULT_SENTINEL = '__LC_RESULT__';
const MAX_SOURCE_BYTES = 256 * 1024;   // 256 KB of source per function
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // cap stdout+stderr we buffer
const DEFAULT_MEM_MB = 128;

// The fixed wrapper (Deno main module, passed as a data: URL). Reads the
// envelope from stdin, imports the customer source as a nested data: URL, calls
// its default export handler(input, ctx), and prints the result after the
// sentinel. TS is supported natively by Deno.
const WRAPPER = `
const raw = await new Response(Deno.stdin.readable).text();
const { source, input, ctx } = JSON.parse(raw);
const emit = (o) => Deno.stdout.write(new TextEncoder().encode("\\n${RESULT_SENTINEL}" + JSON.stringify(o)));
// Backend access: ctx.db / ctx.storage call the internal RPC endpoint over the
// one allowed network host (the gateway), authenticated by a per-invocation token.
const _rpc = ctx._rpc; delete ctx._rpc;
async function _rpcCall(op, extra) {
  if (!_rpc || !_rpc.url) throw new Error("backend access is unavailable in this function");
  const resp = await fetch(_rpc.url, { method: "POST", headers: { "Authorization": "Bearer " + _rpc.token, "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ op: op }, extra || {})) });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || !j.ok) throw new Error((j && (j.message || j.error)) || ("backend call '" + op + "' failed"));
  return j.data;
}
ctx.db = {
  // Arbitrary parameterized SQL as the tenant role (RLS enforced); returns { rows, rowCount, fields }.
  query: (sql, params) => _rpcCall("query", { sql: sql, params: params || [] }),
  queryRead: (sql, params) => _rpcCall("query", { sql: sql, params: params || [], readOnly: true }),
};
ctx.storage = {
  uploadUrl: (path, opts) => _rpcCall("storage.uploadUrl", Object.assign({ path: path }, opts || {})),
  url: (path, opts) => _rpcCall("storage.url", Object.assign({ path: path }, opts || {})),
  remove: (path, opts) => _rpcCall("storage.remove", Object.assign({ path: path }, opts || {})),
};
try {
  const b64 = btoa(unescape(encodeURIComponent(source)));
  const mod = await import("data:text/typescript;base64," + b64);
  if (typeof mod.default !== "function") throw new Error("Function must \`export default\` a handler(input, ctx)");
  const out = await mod.default(input, ctx);
  await emit({ ok: true, data: out === undefined ? null : out });
} catch (e) {
  await emit({ ok: false, error: String((e && e.message) || e) });
}
`;
const WRAPPER_URL = 'data:application/typescript;base64,' + Buffer.from(WRAPPER).toString('base64');

let _denoPath = undefined; // undefined = unprobed, string|null = result
// Resolve the Deno binary once. Honors DENO_BIN override; otherwise relies on
// `deno` being on PATH (installed on the droplet by the deploy bootstrap).
function denoBin() {
  if (_denoPath !== undefined) return _denoPath;
  _denoPath = process.env.DENO_BIN || 'deno';
  return _denoPath;
}

let _available = undefined;
// Cheap availability probe (cached). Lets routes degrade gracefully with a 503
// when the runtime isn't installed instead of failing every call opaquely.
function isAvailable() {
  if (_available !== undefined) return _available;
  try {
    const r = require('child_process').spawnSync(denoBin(), ['--version'], { timeout: 4000 });
    _available = !r.error && r.status === 0;
  } catch (_) { _available = false; }
  return _available;
}

function hostOf(urlStr) {
  try { return new URL(urlStr).host; } catch (_) { return ''; }
}

// Run a user function. Returns { ok, data } on success or { ok:false, error }
// on a thrown error / timeout / crash. `logs` carries captured stderr (truncated).
//   opts: { backendId, gatewayUrl, slug, source, secrets, input, timeoutMs, memMb }
function runUserFunction(opts) {
  const { backendId, gatewayUrl, source } = opts;
  const timeoutMs = Math.max(500, Math.min(60000, opts.timeoutMs || 5000));
  const memMb = opts.memMb || DEFAULT_MEM_MB;

  return new Promise((resolve) => {
    if (!source || Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
      return resolve({ ok: false, error: `Function source must be 1..${MAX_SOURCE_BYTES} bytes` });
    }
    const gatewayHost = hostOf(gatewayUrl);
    const netFlag = gatewayHost ? `--allow-net=${gatewayHost}` : '--deny-net';
    const args = [
      'run', '--no-prompt', '--quiet',
      '--deny-read', '--deny-write', '--deny-env', '--deny-ffi', '--deny-run',
      netFlag, `--v8-flags=--max-old-space-size=${memMb}`,
      WRAPPER_URL,
    ];

    let child;
    try { child = spawn(denoBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, error: 'functions runtime unavailable' }); }

    let out = '', err = '', settled = false, overBytes = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch (_) {} resolve(result); };

    const timer = setTimeout(() => finish({ ok: false, error: `Function timed out after ${timeoutMs}ms`, logs: err.slice(0, 2000) }), timeoutMs);

    child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT_BYTES) out += d; else overBytes = true; });
    child.stderr.on('data', (d) => { if (err.length < MAX_OUTPUT_BYTES) err += d; else overBytes = true; });
    child.on('error', (e) => finish({ ok: false, error: /ENOENT/.test(String(e)) ? 'functions runtime unavailable' : String(e.message || e) }));
    child.on('close', () => {
      const i = out.lastIndexOf(RESULT_SENTINEL);
      if (i < 0) {
        return finish({ ok: false, error: (overBytes ? 'Function output too large. ' : '') + (err.trim().split('\n').pop() || 'Function produced no result'), logs: err.slice(0, 2000) });
      }
      let parsed;
      try { parsed = JSON.parse(out.slice(i + RESULT_SENTINEL.length)); }
      catch (_) { return finish({ ok: false, error: 'Malformed function result' }); }
      finish(Object.assign({ logs: err.slice(0, 2000) }, parsed));
    });

    const ctx = {
      secrets: opts.secrets || {},
      backendId: backendId,
      gateway: gatewayUrl || null,
      // B: full inbound HTTP request (method/headers/query/rawBody/path) so a
      // function can act as a real HTTP handler / webhook receiver.
      request: opts.request || null,
      // A: backend access — the in-sandbox shim turns this into ctx.db / ctx.storage.
      _rpc: opts.rpc || null,
    };
    try {
      child.stdin.write(JSON.stringify({ source, input: opts.input === undefined ? null : opts.input, ctx }));
      child.stdin.end();
    } catch (e) { finish({ ok: false, error: 'Failed to send function input' }); }
  });
}

module.exports = { runUserFunction, isAvailable, MAX_SOURCE_BYTES };
