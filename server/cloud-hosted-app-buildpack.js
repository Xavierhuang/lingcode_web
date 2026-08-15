'use strict';

// cloud-hosted-app-buildpack.js — Pure translation layer for the LingCode Cloud
// "hosted-apps" runner. Takes an already-extracted view of a customer's Python
// source tarball and produces (a) a per-app Dockerfile, (b) a resolved entrypoint
// command, and (c) validation verdicts on the source tree.
//
// This module is deliberately dependency-free (no fs, no child_process, no net):
// the caller is responsible for tarball extraction, filesystem walking, and
// disk-vs-uncompressed size accounting. That inversion keeps the buildpack
// layer trivially unit-testable and easy to reason about in code review.
//
// Companion to cloud-python-runtime.js (per-invocation firejail sandbox for
// function tier). Hosted-apps is the "long-running web process" tier — one
// container per app, image built once per deploy, runs uvicorn/gunicorn/etc.

// Uncompressed size cap for the entire source tarball. Also enforced pre-extract
// in the intake validator (routes.js) so we never write >100MiB of hostile data
// to disk before rejecting. Kept in this module so both sides read the same
// constant.
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;

// Absolute file-count cap. Prevents a "million tiny files" DoS on the extractor
// and keeps `pip install`'s working set predictable.
const MAX_SOURCE_FILES = 500;

// Per-file uncompressed cap. Catches a single 500MiB weight file that would
// otherwise slip under the aggregate cap if the rest of the tree is small.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Runtime images we publish under ghcr.io/lingcode/py-app-runtime:<version>.
// Add new versions here AFTER the corresponding base image is pushed — the
// generator throws on anything not in this list, which is the intended failure
// mode for typo'd runtimeVersion inputs from the UI.
const SUPPORTED_RUNTIME_VERSIONS = ['3.12'];

// generateDockerfile — returns the per-app Dockerfile as a string.
//   runtimeVersion   Must be one of SUPPORTED_RUNTIME_VERSIONS. Throws otherwise.
//   healthcheckPath  Injected as the default value of HEALTHCHECK_PATH env var;
//                    the actual probed path is $HEALTHCHECK_PATH at runtime so
//                    ops can override without a rebuild.
//   port             The port the app is expected to bind. EXPOSEd + set as
//                    $PORT so the entrypoint contract (uvicorn --port $PORT)
//                    keeps working.
function generateDockerfile(opts) {
  const o = opts || {};
  const runtimeVersion = o.runtimeVersion || '3.12';
  const healthcheckPath = o.healthcheckPath || '/';
  const port = o.port || 8080;
  if (!SUPPORTED_RUNTIME_VERSIONS.includes(runtimeVersion)) {
    throw new Error(
      'Unsupported runtimeVersion "' + runtimeVersion +
      '". Supported: ' + SUPPORTED_RUNTIME_VERSIONS.join(', ')
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

// parseProcfileWebLine — scans a Procfile string for the first `web:` line and
// returns the command portion (trimmed). Returns null if there is no web line.
// Comment lines (leading `#`, possibly after whitespace) and blank lines are
// skipped. `web=` is NOT accepted — Procfiles are colon-delimited per Heroku
// convention. The prefix match is case-sensitive and anchored to start-of-line
// (after optional leading whitespace) so a stray "web:" inside a comment or
// inside another command doesn't false-match.
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

// resolveEntrypoint — decides what /lc/entrypoint.sh should exec, in the spec's
// priority order: explicit Procfile web line > uvicorn on app:app (app.py) >
// uvicorn on main:app (main.py). Returns { command, source } on success or
// { error } if none of the three signals is present. The runner writes
// `command` into the image at build time.
function resolveEntrypoint(flags) {
  const f = flags || {};
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

// validateSourceTree — pure verdict on an already-extracted view of the source
// tarball. `files` is [{path, size}] where path is the tar entry name (relative,
// forward slashes) and size is the uncompressed byte length. The caller (route
// handler) has already checked the compressed size and refused traversal-y
// paths; this is the second-pass, semantic check. All rejection reasons
// accumulate so the UI can surface every problem in one round-trip instead of
// making the user fix them one at a time.
function validateSourceTree(input) {
  const errors = [];
  const inp = input || {};
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

  // Requires at least one of requirements.txt / pyproject.toml at the top level.
  // Without either there's nothing for `pip install` to consume and we'd ship
  // an image that boots but has no user deps — better to fail loud.
  if (!inp.hasRequirements && !inp.hasPyproject) {
    errors.push('missing requirements.txt or pyproject.toml at the top level');
  }

  // Requires at least one .py at the top level. This is a sanity check against
  // "user uploaded a Node.js project by mistake" style errors.
  if (!inp.hasPy) {
    errors.push('no .py files found at the top level');
  }

  return { ok: errors.length === 0, errors: errors };
}

module.exports = {
  MAX_SOURCE_BYTES,
  MAX_SOURCE_FILES,
  MAX_FILE_BYTES,
  SUPPORTED_RUNTIME_VERSIONS,
  generateDockerfile,
  parseProcfileWebLine,
  resolveEntrypoint,
  validateSourceTree,
};
