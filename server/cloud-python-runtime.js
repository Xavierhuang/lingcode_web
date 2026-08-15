'use strict';

// cloud-python-runtime.js — Preview. Execute arbitrary customer Python code in
// a firejail-sandboxed `python3` subprocess.
//
// Companion to cloud-functions-runtime.js (Deno-TS). Same public shape
// (runUserFunction, isAvailable, MAX_SOURCE_BYTES) so cloud-fn-invoke.js can
// branch on fnRow.runtime and everything else — secrets resolution, the
// per-invocation ctx.db/ctx.storage RPC token, the wall-clock timeout — stays
// identical.
//
// Sandbox model:
//   firejail --quiet --noprofile --private --net=none \
//     --netfilter=/etc/lingcode/fn-gateway.nft   (opens ONE hole: gateway host:443)
//     --caps.drop=all --seccomp --nonewprivs --nogroups --noroot \
//     --rlimit-as=<memMb>MB --rlimit-cpu=<timeout+2s> --rlimit-nproc=32
//     -- python3 -I -B -S -                       (isolated, no site, no .pyc)
//
// Python has no --deny-read / --deny-net equivalent inside the interpreter.
// The OS-level sandbox (fresh mount namespace, no filesystem beyond /usr and
// tmpfs $HOME, no network except the gateway punch-hole) IS the protection —
// see scripts/bootstrap-python-runtime.sh for the one-time droplet setup that
// installs firejail and writes the nftables include.
//
// STDIN carries a JSON envelope { source, input, ctx }; STDOUT carries a
// __LC_RESULT__ sentinel followed by the JSON result — same wire shape as the
// Deno runtime so operators / observability tooling see a single contract.

const { spawn, spawnSync } = require('child_process');

const RESULT_SENTINEL = '__LC_RESULT__';
const MAX_SOURCE_BYTES = 256 * 1024;      // parity with Deno path
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // parity with Deno path
const DEFAULT_MEM_MB = 128;

// Fixed Python wrapper. Reads the envelope from stdin, builds a ctx object with
// sync ctx.db / ctx.storage that call the same /_fn-rpc endpoint the Deno path
// uses (stdlib-only urllib.request — no PyPI deps). exec's the customer source
// in an isolated namespace and requires a top-level `def handler(input, ctx)`.
// Emits {ok, data|error} after the sentinel so the JS side parses identically.
const WRAPPER = `import sys, json, urllib.request, urllib.error

RESULT_SENTINEL = "__LC_RESULT__"

def _emit(obj):
    sys.stdout.write("\\n" + RESULT_SENTINEL + json.dumps(obj))
    sys.stdout.flush()

try:
    _raw = sys.stdin.read()
    _env = json.loads(_raw)
    _source = _env["source"]
    _input = _env.get("input")
    _ctx_raw = _env.get("ctx") or {}
    _rpc = _ctx_raw.pop("_rpc", None)
except Exception as _e:
    _emit({"ok": False, "error": "Malformed function envelope: " + str(_e)})
    raise SystemExit(0)

def _rpc_call(op, extra=None):
    if not _rpc or not _rpc.get("url"):
        raise RuntimeError("backend access is unavailable in this function")
    body = json.dumps({"op": op, **(extra or {})}).encode("utf-8")
    req = urllib.request.Request(
        _rpc["url"], data=body, method="POST",
        headers={
            "Authorization": "Bearer " + _rpc["token"],
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            payload = json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try: payload = json.loads(e.read() or b"{}")
        except Exception: payload = {}
    except Exception as e:
        raise RuntimeError("backend call '" + op + "' failed: " + str(e))
    if not payload.get("ok"):
        raise RuntimeError(payload.get("message") or payload.get("error") or ("backend call '" + op + "' failed"))
    return payload.get("data")

class _DB:
    def query(self, sql, params=None):
        return _rpc_call("query", {"sql": sql, "params": params or []})
    def query_read(self, sql, params=None):
        return _rpc_call("query", {"sql": sql, "params": params or [], "readOnly": True})

class _Storage:
    def upload_url(self, path, **opts): return _rpc_call("storage.uploadUrl", {"path": path, **opts})
    def url(self, path, **opts):        return _rpc_call("storage.url",       {"path": path, **opts})
    def remove(self, path, **opts):     return _rpc_call("storage.remove",    {"path": path, **opts})

class _Ctx: pass
ctx = _Ctx()
ctx.secrets    = _ctx_raw.get("secrets") or {}
ctx.backend_id = _ctx_raw.get("backendId")
ctx.gateway    = _ctx_raw.get("gateway")
ctx.request    = _ctx_raw.get("request")
ctx.db         = _DB()
ctx.storage    = _Storage()

try:
    _ns = {"__name__": "__lc_fn__"}
    exec(compile(_source, "<function>", "exec"), _ns)
    _handler = _ns.get("handler")
    if not callable(_handler):
        raise RuntimeError("Function must define a top-level 'def handler(input, ctx)'")
    _out = _handler(_input, ctx)
    _emit({"ok": True, "data": None if _out is None else _out})
except BaseException as _e:
    _emit({"ok": False, "error": str(_e)})
`;

let _pythonPath;
let _firejailPath;
function pythonBin() {
  if (_pythonPath !== undefined) return _pythonPath;
  _pythonPath = process.env.LC_PYTHON_BIN || 'python3';
  return _pythonPath;
}
function firejailBin() {
  if (_firejailPath !== undefined) return _firejailPath;
  _firejailPath = process.env.LC_FIREJAIL_BIN || 'firejail';
  return _firejailPath;
}

// Path to the nftables include the bootstrap script writes. When absent OR
// when LC_FN_NET_IFACE is empty we fall back to --net=none: no interfaces in
// the namespace, therefore no network at all. The wrapper's RPC call then
// fails with a clear "backend access is unavailable" — nothing crashes, the
// function just cannot reach the backend. To ENABLE gateway access, ops runs
// scripts/bootstrap-python-runtime.sh which writes the file and sets the env
// vars for the API service.
function netfilterPath() {
  return process.env.LC_FN_NFTABLES || '/etc/lingcode/fn-gateway.nft';
}
function netIface() {
  return process.env.LC_FN_NET_IFACE || '';
}

let _available;
// Cheap availability probe (cached). Both firejail AND python3 must be present
// to report available — mirrors the Deno path's single-probe pattern so the
// route can 503 with `python_runtime_unavailable` before touching the sandbox.
function isAvailable() {
  if (_available !== undefined) return _available;
  try {
    const p = spawnSync(pythonBin(), ['--version'], { timeout: 4000 });
    const f = spawnSync(firejailBin(), ['--version'], { timeout: 4000 });
    _available = !p.error && p.status === 0 && !f.error && f.status === 0;
  } catch (_) { _available = false; }
  return _available;
}

// Run a user Python function. Returns { ok, data } on success, { ok:false, error }
// on thrown error / timeout / crash. `logs` carries captured stderr (truncated).
//   opts: { backendId, gatewayUrl, slug, source, secrets, input, request, rpc, timeoutMs, memMb }
function runUserFunction(opts) {
  const { backendId, gatewayUrl, source } = opts;
  const timeoutMs = Math.max(500, Math.min(60000, opts.timeoutMs || 5000));
  const memMb = opts.memMb || DEFAULT_MEM_MB;

  return new Promise((resolve) => {
    if (!source || Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
      return resolve({ ok: false, error: `Function source must be 1..${MAX_SOURCE_BYTES} bytes` });
    }

    // firejail flags mirror the Deno --deny-* + --allow-net=<gateway> model:
    //   --private             fresh tmpfs $HOME, no host files leaked in
    //   --caps.drop=all       no Linux capabilities
    //   --seccomp             default syscall filter (blocks mount, ptrace, etc.)
    //   --nonewprivs          setuid binaries can't escalate
    //   --nogroups --noroot   drop supplementary groups, unmap uid 0
    //   --net=<iface>         create bridged namespace tied to <iface>...
    //   --netfilter=<path>    ...then load nftables rules that allow ONLY the
    //                         backend gateway host:443. Without both (missing
    //                         file OR unset LC_FN_NET_IFACE) we fall back to
    //                         --net=none: no interfaces at all, ctx.db raises
    //                         "backend access is unavailable" inside the
    //                         sandbox — nothing crashes, the function just
    //                         can't reach the backend. See bootstrap script.
    //   --rlimit-*            AS/CPU/nproc ceilings (SIGKILL is still the ceiling)
    const rlimAs = memMb * 1024 * 1024;
    const rlimCpu = Math.ceil(timeoutMs / 1000) + 2;
    const iface = netIface();
    const nftPath = netfilterPath();
    let nftEnabled = false;
    if (iface) {
      try { require('fs').accessSync(nftPath, require('fs').constants.R_OK); nftEnabled = true; }
      catch (_) { nftEnabled = false; }
    }
    const netArgs = nftEnabled
      ? [`--net=${iface}`, `--netfilter=${nftPath}`]
      : ['--net=none'];
    // Defense-in-depth blacklists. `--private` only fresh-tmpfs's $HOME; the
    // rest of / stays bind-mounted from the host. That means anything owned by
    // the service user (uid 999 lingcode) — including /opt/lingcode-api/.env
    // and data.db — is DAC-readable from inside the sandbox because the
    // sandboxed python runs as the same uid. Verified 2026-08-13 by a prod
    // probe (as sudo -u lingcode) that read 128 bytes of .env. Since
    // ctx.secrets is injected via the stdin JSON envelope, no file under
    // /opt/lingcode-api ever needs to be visible inside the sandbox — hide
    // the whole install dir. Also blacklist /root, /home, and /var/log for
    // defense-in-depth against future service-user access changes.
    const denyPaths = [
      '/opt/lingcode-api',
      '/root',
      '/home',
      '/var/log',
    ];
    const args = [
      '--quiet', '--noprofile',
      '--private',
      '--caps.drop=all', '--seccomp', '--nonewprivs', '--nogroups', '--noroot',
      ...denyPaths.map((p) => `--blacklist=${p}`),
      ...netArgs,
      `--rlimit-as=${rlimAs}`,
      `--rlimit-cpu=${rlimCpu}`,
      '--rlimit-nproc=32',
      '--', pythonBin(), '-I', '-B', '-S', '-c', WRAPPER,
    ];

    let child;
    try { child = spawn(firejailBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (_) { return resolve({ ok: false, error: 'python runtime unavailable' }); }

    let out = '', err = '', settled = false, overBytes = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch (_) {} resolve(result); };
    const timer = setTimeout(() => finish({ ok: false, error: `Function timed out after ${timeoutMs}ms`, logs: err.slice(0, 2000) }), timeoutMs);

    child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT_BYTES) out += d; else overBytes = true; });
    child.stderr.on('data', (d) => { if (err.length < MAX_OUTPUT_BYTES) err += d; else overBytes = true; });
    child.on('error', (e) => finish({ ok: false, error: /ENOENT/.test(String(e)) ? 'python runtime unavailable' : String(e.message || e) }));
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
      backendId,
      gateway: gatewayUrl || null,
      request: opts.request || null,
      _rpc: opts.rpc || null,
    };
    try {
      child.stdin.write(JSON.stringify({ source, input: opts.input === undefined ? null : opts.input, ctx }));
      child.stdin.end();
    } catch (_) { finish({ ok: false, error: 'Failed to send function input' }); }
  });
}

module.exports = { runUserFunction, isAvailable, MAX_SOURCE_BYTES };
