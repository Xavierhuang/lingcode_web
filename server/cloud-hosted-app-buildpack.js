'use strict';

// cloud-hosted-app-buildpack.js — Pure translation layer for the LingCode Cloud
// "hosted-apps" runner. Takes an already-extracted view of a customer's source
// tarball and produces (a) a per-app Dockerfile, (b) a resolved entrypoint
// command, and (c) validation verdicts on the source tree.
//
// Two runtimes are supported: 'python' (uvicorn/gunicorn/etc.) and 'node'
// (Fastify/Express/Next-in-server-mode/Hono/etc.). Both share the /lc/entrypoint.sh
// + /lc/start-cmd contract, the nobody-app (uid 65534) posture, and the curl
// HEALTHCHECK; they differ only in the base image and the entrypoint-resolution
// priority. The dispatch happens in generateDockerfile / resolveEntrypoint /
// validateSourceTree via a required `runtime` flag.
//
// This module is deliberately dependency-free (no fs, no child_process, no net):
// the caller is responsible for tarball extraction, filesystem walking, and
// disk-vs-uncompressed size accounting. That inversion keeps the buildpack
// layer trivially unit-testable and easy to reason about in code review.
//
// Companion to cloud-python-runtime.js (per-invocation firejail sandbox for
// function tier). Hosted-apps is the "long-running web process" tier — one
// container per app, image built once per deploy.

// Uncompressed size cap for the entire source tarball. Also enforced pre-extract
// in the intake validator (routes.js) so we never write >100MiB of hostile data
// to disk before rejecting. Kept in this module so both sides read the same
// constant.
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;

// Absolute file-count cap. Prevents a "million tiny files" DoS on the extractor
// and keeps `pip install` / `npm ci`'s working set predictable.
const MAX_SOURCE_FILES = 500;

// Per-file uncompressed cap. Catches a single 500MiB weight file that would
// otherwise slip under the aggregate cap if the rest of the tree is small.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Python runtime images published under ghcr.io/lingcode/py-app-runtime:<version>.
// Add new versions here AFTER the corresponding base image is pushed — the
// generator throws on anything not in this list, which is the intended failure
// mode for typo'd runtimeVersion inputs from the UI.
const SUPPORTED_PYTHON_VERSIONS = ['3.12'];

// Node runtime images published under ghcr.io/lingcode/node-app-runtime:<version>.
// See docker/node-app-runtime/README.md for the build + push instructions —
// keep this list in lockstep with the pushed tags.
const SUPPORTED_NODE_VERSIONS = ['20', '22'];

// Back-compat alias. Callers written against the Python-only shape read this
// and expect it to enumerate Python versions; kept unchanged so a stale route
// handler doesn't silently accept Node inputs against the wrong list.
const SUPPORTED_RUNTIME_VERSIONS = SUPPORTED_PYTHON_VERSIONS;

const SUPPORTED_RUNTIMES = ['python', 'node'];

function _normalizeRuntime(r) {
  const v = (r == null ? 'python' : String(r)).toLowerCase();
  if (!SUPPORTED_RUNTIMES.includes(v)) {
    throw new Error(
      'Unsupported runtime "' + r + '". Supported: ' + SUPPORTED_RUNTIMES.join(', ')
    );
  }
  return v;
}

// generateDockerfile — returns the per-app Dockerfile as a string. Dispatches
// on `runtime` ('python' | 'node'); the per-runtime helpers below share the
// nobody-app / HEALTHCHECK / /lc/entrypoint.sh contract.
//
//   runtime          'python' (default, back-compat) or 'node'.
//   runtimeVersion   Must be one of SUPPORTED_{PYTHON,NODE}_VERSIONS for the
//                    chosen runtime. Throws otherwise.
//   healthcheckPath  Injected as the default value of HEALTHCHECK_PATH env var;
//                    the actual probed path is $HEALTHCHECK_PATH at runtime so
//                    ops can override without a rebuild.
//   port             The port the app is expected to bind. EXPOSEd + set as
//                    $PORT so the entrypoint contract keeps working.
function generateDockerfile(opts) {
  const o = opts || {};
  const runtime = _normalizeRuntime(o.runtime);
  if (runtime === 'node') return generateNodeDockerfile(o);
  return generatePythonDockerfile(o);
}

function generatePythonDockerfile(opts) {
  const o = opts || {};
  const runtimeVersion = o.runtimeVersion || '3.12';
  const healthcheckPath = o.healthcheckPath || '/';
  const port = o.port || 8080;
  if (!SUPPORTED_PYTHON_VERSIONS.includes(runtimeVersion)) {
    throw new Error(
      'Unsupported runtimeVersion "' + runtimeVersion +
      '". Supported: ' + SUPPORTED_PYTHON_VERSIONS.join(', ')
    );
  }
  // Layout notes:
  //   * COPY requirements.txt first, `pip install`, THEN COPY . — standard
  //     layer-cache trick so source-only edits skip the pip step on rebuild.
  //   * HEALTHCHECK uses curl against $HEALTHCHECK_PATH so ops can change the
  //     probe path via env at deploy time.
  //   * USER nobody-app: baked into the base image, non-root, no shell.
  //   * CMD is the entrypoint shim in the base image — it invokes whatever
  //     `resolveEntrypoint()` decided and wrote into /lc/start-cmd.
  return [
    'FROM ghcr.io/lingcode/py-app-runtime:' + runtimeVersion,
    'WORKDIR /app',
    'COPY requirements.txt* ./',
    'RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi',
    'COPY . .',
    'ENV PORT=' + port,
    'ENV HEALTHCHECK_PATH=' + healthcheckPath,
    'HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\',
    '  CMD curl -fsS "http://127.0.0.1:' + port + '${HEALTHCHECK_PATH}" || exit 1',
    'EXPOSE ' + port,
    'USER nobody-app',
    'CMD ["/lc/entrypoint.sh"]',
    '',
  ].join('\n');
}

function generateNodeDockerfile(opts) {
  const o = opts || {};
  const runtimeVersion = o.runtimeVersion || '20';
  const healthcheckPath = o.healthcheckPath || '/';
  const port = o.port || 8080;
  if (!SUPPORTED_NODE_VERSIONS.includes(runtimeVersion)) {
    throw new Error(
      'Unsupported runtimeVersion "' + runtimeVersion +
      '". Supported: ' + SUPPORTED_NODE_VERSIONS.join(', ')
    );
  }
  // Layout notes:
  //   * COPY package.json + optional package-lock.json first, then `npm ci
  //     --omit=dev`, THEN COPY . — same layer-cache trick as pip.
  //   * `npm ci` (not `npm install`) because the buildpack MUST be
  //     reproducible: a `package-lock.json` present in the user's tarball
  //     will pin transitive deps; if it's absent we fall back to `npm install
  //     --omit=dev`. Users who care about reproducibility should commit the
  //     lockfile.
  //   * `--omit=dev` skips devDependencies — build tools shouldn't ship into
  //     a production container.
  //   * `--ignore-scripts` is deliberately NOT set: many Fastify/Prisma users
  //     rely on postinstall (Prisma client generation, native rebuilds). We
  //     rely on `nobody-app` (uid 65534, read-only fs, no capabilities) to
  //     contain any malicious install-script.
  //   * ENV NODE_ENV=production is set in the base image, but repeating it
  //     here makes the per-app Dockerfile self-documenting.
  // USER `nobody` (uid 65534, gid 65534) — Alpine's built-in unprivileged
  // user. The Python image happens to use a bespoke `nobody-app` user for
  // historical reasons; on Node's Alpine base the built-in `nobody` already
  // occupies uid 65534 and `adduser -u 65534 nobody-app` fails, so the base
  // Dockerfile keeps `nobody`. The runner's `--user 65534:65534` at `docker
  // run` is the source of truth either way.
  return [
    'FROM ghcr.io/lingcode/node-app-runtime:' + runtimeVersion,
    'WORKDIR /app',
    // npm needs a writable cache directory, and the base image builds as
    // `nobody` with HOME=/ — so npm resolves its cache to /.npm and the install
    // dies before it fetches anything:
    //
    //     npm error code EACCES
    //     npm error syscall mkdir
    //     npm error path /.npm
    //
    // It fails identically for a one-dependency probe and a full Next app,
    // which is what made it look like a platform outage rather than a build
    // error. It also does not reproduce on node:22-slim or node:22-alpine,
    // because those run as root and /.npm is writable there — so every
    // reproduction attempt outside this base image succeeded.
    //
    // The Python path never hit this: `pip install --no-cache-dir` writes no
    // cache at all. This is the Node equivalent.
    'ENV NPM_CONFIG_CACHE=/tmp/.npm',
    'COPY package.json package-lock.json* ./',
    'RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi',
    'COPY . .',
    'ENV NODE_ENV=production',
    'ENV PORT=' + port,
    'ENV HEALTHCHECK_PATH=' + healthcheckPath,
    'HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\',
    '  CMD curl -fsS "http://127.0.0.1:' + port + '${HEALTHCHECK_PATH}" || exit 1',
    'EXPOSE ' + port,
    'USER nobody',
    'CMD ["/lc/entrypoint.sh"]',
    '',
  ].join('\n');
}

// parseProcfileWebLine — scans a Procfile string for the first `web:` line and
// returns the command portion (trimmed). Returns null if there is no web line.
// Comment lines (leading `#`, possibly after whitespace) and blank lines are
// skipped. `web=` is NOT accepted — Procfiles are colon-delimited per Heroku
// convention. The prefix match is case-sensitive and anchored to start-of-line
// (after optional leading whitespace) so a stray "web:" inside a comment or
// inside another command doesn't false-match.
//
// Shared by Python and Node runtimes — Procfile semantics are runtime-agnostic.
function parseProcfileWebLine(content) {
  if (typeof content !== 'string' || content.length === 0) return null;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.charAt(0) === '#') continue;
    // Match: optional leading ws, literal "web", optional ws, ":", rest.
    const m = /^\s*web\s*:\s*(.*)$/.exec(raw);
    if (!m) continue;
    const cmd = m[1].trim();
    return cmd.length === 0 ? null : cmd;
  }
  return null;
}

// parseNodePackageJson — safe JSON parse of a package.json body. Returns
// { scripts, main } (both possibly null). Any parse error → null so callers
// can fall through to file-name defaults; a broken package.json is a legit
// user error surfaced by `npm ci` at build time, not something to abort
// entrypoint resolution over.
function parseNodePackageJson(content) {
  if (typeof content !== 'string' || content.length === 0) return null;
  let parsed;
  try { parsed = JSON.parse(content); } catch (_) { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const scripts = (parsed.scripts && typeof parsed.scripts === 'object') ? parsed.scripts : null;
  const main = typeof parsed.main === 'string' ? parsed.main : null;
  return { scripts: scripts, main: main };
}

// resolveEntrypoint — decides what /lc/entrypoint.sh should exec. Dispatches
// on runtime; per-runtime priority is documented in the spec.
//
// Returns { command, source } on success or { error } if none of the runtime's
// entrypoint signals is present. The runner writes `command` into the image
// at build time.
function resolveEntrypoint(flags) {
  const f = flags || {};
  const runtime = _normalizeRuntime(f.runtime);
  if (runtime === 'node') return _resolveNodeEntrypoint(f);
  return _resolvePythonEntrypoint(f);
}

// Python priority (unchanged from the pre-Node buildpack):
//   1. explicit Procfile `web:` line
//   2. app.py present  → uvicorn app:app
//   3. main.py present → uvicorn main:app
function _resolvePythonEntrypoint(f) {
  if (f.hasProcfile && typeof f.procfileWebLine === 'string' && f.procfileWebLine.trim().length > 0) {
    return { command: f.procfileWebLine.trim(), source: 'procfile' };
  }
  if (f.hasAppPy) {
    return { command: 'uvicorn app:app --host 0.0.0.0 --port $PORT', source: 'default-app' };
  }
  if (f.hasMainPy) {
    return { command: 'uvicorn main:app --host 0.0.0.0 --port $PORT', source: 'default-main' };
  }
  return { error: 'no Procfile, no app.py, no main.py — cannot start' };
}

// Node priority:
//   1. explicit Procfile `web:` line  (highest — override for any layout)
//   2. package.json "scripts.start"    (Heroku/Node convention)
//   3. package.json "main" (if present and refers to a file, `node <main>`)
//   4. server.js at top level          → node server.js
//   5. index.js at top level           → node index.js
//
// A Fastify app that starts with `fastify.listen({ port: Number(process.env.PORT), host: '0.0.0.0' })`
// slots into any of these — the base image already sets PORT=8080. The
// bind-to-0.0.0.0 requirement is the user's responsibility (documented);
// otherwise the healthcheck curl to 127.0.0.1:$PORT will 5xx and the runner
// will restart-loop the container.
function _resolveNodeEntrypoint(f) {
  if (f.hasProcfile && typeof f.procfileWebLine === 'string' && f.procfileWebLine.trim().length > 0) {
    return { command: f.procfileWebLine.trim(), source: 'procfile' };
  }
  const pkg = (f.packageJson && typeof f.packageJson === 'object') ? f.packageJson : null;
  if (pkg && pkg.scripts && typeof pkg.scripts.start === 'string' && pkg.scripts.start.trim().length > 0) {
    // `npm start` is the canonical wrapper — it re-exports lifecycle env,
    // respects .npmrc, and runs the user's exact string. Prefer it over
    // hand-shelling "node xyz" so users can put --experimental-* flags,
    // ts-node, tsx, etc. into their start script without buildpack changes.
    return { command: 'npm start --silent', source: 'package-start' };
  }
  if (pkg && typeof pkg.main === 'string' && pkg.main.trim().length > 0) {
    // Sanitize just enough to keep the emitted shell string safe. A user
    // "main" like `"server.js; rm -rf /"` would already fail on `node <that>`
    // because node treats the whole arg as a filename, but we still guard
    // against `$`, backtick, and quote injection into the sh -c that the
    // entrypoint shim uses.
    const main = pkg.main.trim();
    if (/[`$"'\\;&|<>\s]/.test(main)) {
      // Unsafe main — fall through to the file-name defaults below.
    } else {
      return { command: 'node ' + main, source: 'package-main' };
    }
  }
  if (f.hasServerJs) {
    return { command: 'node server.js', source: 'default-server' };
  }
  if (f.hasIndexJs) {
    return { command: 'node index.js', source: 'default-index' };
  }
  return {
    error:
      'no Procfile web line, no package.json "start" script, no "main", ' +
      'no server.js, no index.js — cannot start',
  };
}

// validateSourceTree — pure verdict on an already-extracted view of the source
// tarball. `files` is [{path, size}] where path is the tar entry name (relative,
// forward slashes) and size is the uncompressed byte length. The caller (route
// handler) has already checked the compressed size and refused traversal-y
// paths; this is the second-pass, semantic check. All rejection reasons
// accumulate so the UI can surface every problem in one round-trip instead of
// making the user fix them one at a time.
//
// Runtime-specific presence checks:
//   python: at least one of requirements.txt / pyproject.toml at top level,
//           and at least one .py at top level.
//   node:   package.json at top level, and at least one .js/.mjs/.cjs/.ts
//           at top level.
function validateSourceTree(input) {
  const inp = input || {};
  const runtime = _normalizeRuntime(inp.runtime);
  const errors = [];
  const files = Array.isArray(inp.files) ? inp.files : [];

  // Aggregate size — sum of uncompressed sizes, not on-disk sizes.
  let total = 0;
  for (let i = 0; i < files.length; i++) {
    const s = Number(files[i] && files[i].size) || 0;
    total += s;
  }
  if (total > MAX_SOURCE_BYTES) {
    errors.push(
      'source tree is ' + total + ' bytes uncompressed; max is ' + MAX_SOURCE_BYTES
    );
  }

  // File count.
  if (files.length > MAX_SOURCE_FILES) {
    errors.push(
      'source tree has ' + files.length + ' files; max is ' + MAX_SOURCE_FILES
    );
  }

  // Any single oversize file — report ALL of them by path so the user isn't
  // caught in a whack-a-mole loop.
  const oversize = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const s = Number(f && f.size) || 0;
    if (s > MAX_FILE_BYTES) oversize.push(f && f.path ? f.path : '(unknown)');
  }
  if (oversize.length > 0) {
    errors.push(
      'file(s) exceed per-file cap of ' + MAX_FILE_BYTES + ' bytes: ' +
      oversize.join(', ')
    );
  }

  if (runtime === 'python') {
    // Requires at least one of requirements.txt / pyproject.toml at the top
    // level. Without either there's nothing for `pip install` to consume and
    // we'd ship an image that boots but has no user deps — better to fail loud.
    if (!inp.hasRequirements && !inp.hasPyproject) {
      errors.push('missing requirements.txt or pyproject.toml at the top level');
    }
    // At least one .py at the top level — sanity check against "user uploaded
    // a Node.js project by mistake" style errors.
    if (!inp.hasPy) {
      errors.push('no .py files found at the top level');
    }
  } else if (runtime === 'node') {
    // package.json is mandatory — every Node app has one, and the buildpack
    // needs it to know what to install (and, for many apps, what to run).
    if (!inp.hasPackageJson) {
      errors.push('missing package.json at the top level');
    }
    // At least one .js/.mjs/.cjs/.ts at the top level — sanity check against
    // "user uploaded a Python project by mistake" style errors.
    if (!inp.hasJs) {
      errors.push('no .js/.mjs/.cjs/.ts files found at the top level');
    }
  }

  return { ok: errors.length === 0, errors: errors };
}

module.exports = {
  MAX_SOURCE_BYTES,
  MAX_SOURCE_FILES,
  MAX_FILE_BYTES,
  SUPPORTED_RUNTIMES,
  SUPPORTED_PYTHON_VERSIONS,
  SUPPORTED_NODE_VERSIONS,
  SUPPORTED_RUNTIME_VERSIONS, // deprecated alias for SUPPORTED_PYTHON_VERSIONS
  generateDockerfile,
  generatePythonDockerfile,
  generateNodeDockerfile,
  parseProcfileWebLine,
  parseNodePackageJson,
  resolveEntrypoint,
  validateSourceTree,
};
