'use strict';

// cloud-hosted-app-buildpack.test.js — node:test suite. Zero deps; run with
//   node --test cloud-hosted-app-buildpack.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_SOURCE_BYTES,
  MAX_SOURCE_FILES,
  MAX_FILE_BYTES,
  SUPPORTED_RUNTIME_VERSIONS,
  generateDockerfile,
  parseProcfileWebLine,
  resolveEntrypoint,
  validateSourceTree,
} = require('../cloud-hosted-app-buildpack.js');

// -------- constants ---------------------------------------------------------

test('constants: caps and supported runtimes match the spec', () => {
  assert.equal(MAX_SOURCE_BYTES, 100 * 1024 * 1024);
  assert.equal(MAX_SOURCE_FILES, 500);
  assert.equal(MAX_FILE_BYTES, 5 * 1024 * 1024);
  assert.deepEqual(SUPPORTED_RUNTIME_VERSIONS, ['3.12']);
});

// -------- generateDockerfile ------------------------------------------------

test('generateDockerfile: defaults produce the expected multiline block', () => {
  const df = generateDockerfile({});
  assert.match(df, /^FROM ghcr\.io\/lingcode\/py-app-runtime:3\.12$/m);
  assert.match(df, /^WORKDIR \/app$/m);
  assert.match(df, /^COPY requirements\.txt\* \.\/$/m);
  assert.match(df, /^RUN if \[ -f requirements\.txt \]; then pip install --no-cache-dir -r requirements\.txt; fi$/m);
  assert.match(df, /^COPY \. \.$/m);
  assert.match(df, /^ENV PORT=8080$/m);
  assert.match(df, /^ENV HEALTHCHECK_PATH=\/$/m);
  assert.match(df, /^HEALTHCHECK .*$/m);
  assert.match(df, /curl -fsS "http:\/\/127\.0\.0\.1:8080\$\{HEALTHCHECK_PATH\}"/);
  assert.match(df, /^EXPOSE 8080$/m);
  assert.match(df, /^USER nobody-app$/m);
  assert.match(df, /^CMD \["\/lc\/entrypoint\.sh"\]$/m);
});

test('generateDockerfile: custom port propagates to ENV, HEALTHCHECK, EXPOSE', () => {
  const df = generateDockerfile({ port: 9000 });
  assert.match(df, /^ENV PORT=9000$/m);
  assert.match(df, /127\.0\.0\.1:9000/);
  assert.match(df, /^EXPOSE 9000$/m);
});

test('generateDockerfile: custom healthcheckPath appears in ENV HEALTHCHECK_PATH', () => {
  const df = generateDockerfile({ healthcheckPath: '/healthz' });
  assert.match(df, /^ENV HEALTHCHECK_PATH=\/healthz$/m);
  // The probe still uses the env var so ops can override at runtime.
  assert.match(df, /\$\{HEALTHCHECK_PATH\}/);
});

test('generateDockerfile: explicit runtimeVersion 3.12 works', () => {
  const df = generateDockerfile({ runtimeVersion: '3.12' });
  assert.match(df, /py-app-runtime:3\.12/);
});

test('generateDockerfile: unknown runtimeVersion throws with a clear message', () => {
  assert.throws(
    () => generateDockerfile({ runtimeVersion: '3.11' }),
    /Unsupported runtimeVersion "3\.11"/
  );
  assert.throws(
    () => generateDockerfile({ runtimeVersion: '2.7' }),
    /Supported: 3\.12/
  );
});

// -------- parseProcfileWebLine ---------------------------------------------

test('parseProcfileWebLine: basic single line', () => {
  assert.equal(
    parseProcfileWebLine('web: gunicorn app:app'),
    'gunicorn app:app'
  );
});

test('parseProcfileWebLine: multiple spaces between web: and command', () => {
  assert.equal(
    parseProcfileWebLine('web:    uvicorn main:app --port $PORT'),
    'uvicorn main:app --port $PORT'
  );
  // Also tolerates spaces before the colon.
  assert.equal(
    parseProcfileWebLine('web  :   gunicorn app:app'),
    'gunicorn app:app'
  );
});

test('parseProcfileWebLine: skips blank lines and # comments', () => {
  const src = [
    '',
    '# top of file comment',
    '',
    '  # indented comment',
    'web: python -m myapp',
    'worker: python worker.py',
  ].join('\n');
  assert.equal(parseProcfileWebLine(src), 'python -m myapp');
});

test('parseProcfileWebLine: multiple web entries picks the first', () => {
  const src = [
    'web: first-cmd --port $PORT',
    'web: second-cmd',
  ].join('\n');
  assert.equal(parseProcfileWebLine(src), 'first-cmd --port $PORT');
});

test('parseProcfileWebLine: no web line returns null', () => {
  assert.equal(parseProcfileWebLine('worker: python worker.py'), null);
  assert.equal(parseProcfileWebLine(''), null);
  assert.equal(parseProcfileWebLine('# only a comment\n'), null);
});

test('parseProcfileWebLine: web= is NOT accepted (colon-only)', () => {
  assert.equal(parseProcfileWebLine('web= gunicorn app:app'), null);
  assert.equal(parseProcfileWebLine('web gunicorn app:app'), null);
});

test('parseProcfileWebLine: empty command after web: returns null', () => {
  assert.equal(parseProcfileWebLine('web:   '), null);
  assert.equal(parseProcfileWebLine('web:'), null);
});

test('parseProcfileWebLine: handles CRLF line endings', () => {
  assert.equal(
    parseProcfileWebLine('worker: x\r\nweb: uvicorn app:app\r\n'),
    'uvicorn app:app'
  );
});

// -------- resolveEntrypoint -------------------------------------------------

test('resolveEntrypoint: procfile web line wins over app.py and main.py', () => {
  const r = resolveEntrypoint({
    hasProcfile: true,
    procfileWebLine: 'gunicorn myapp:app',
    hasAppPy: true,
    hasMainPy: true,
  });
  assert.deepEqual(r, { command: 'gunicorn myapp:app', source: 'procfile' });
});

test('resolveEntrypoint: app.py default when no procfile', () => {
  const r = resolveEntrypoint({
    hasProcfile: false,
    hasAppPy: true,
    hasMainPy: true, // main.py present but app.py wins
  });
  assert.deepEqual(r, {
    command: 'uvicorn app:app --host 0.0.0.0 --port $PORT',
    source: 'default-app',
  });
});

test('resolveEntrypoint: main.py default when no procfile and no app.py', () => {
  const r = resolveEntrypoint({
    hasProcfile: false,
    hasAppPy: false,
    hasMainPy: true,
  });
  assert.deepEqual(r, {
    command: 'uvicorn main:app --host 0.0.0.0 --port $PORT',
    source: 'default-main',
  });
});

test('resolveEntrypoint: none of the signals => error', () => {
  const r = resolveEntrypoint({});
  assert.equal(r.command, undefined);
  assert.match(r.error, /no Procfile.*no app\.py.*no main\.py/);
});

test('resolveEntrypoint: procfile present but empty web line falls through to defaults', () => {
  const r = resolveEntrypoint({
    hasProcfile: true,
    procfileWebLine: '   ',
    hasAppPy: true,
  });
  assert.equal(r.source, 'default-app');
});

test('resolveEntrypoint: procfile present but no web line at all falls through', () => {
  const r = resolveEntrypoint({
    hasProcfile: true,
    procfileWebLine: null,
    hasMainPy: true,
  });
  assert.equal(r.source, 'default-main');
});

// -------- validateSourceTree -----------------------------------------------

test('validateSourceTree: happy path', () => {
  const r = validateSourceTree({
    files: [
      { path: 'app.py', size: 1000 },
      { path: 'requirements.txt', size: 40 },
    ],
    hasRequirements: true,
    hasPyproject: false,
    hasPy: true,
  });
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('validateSourceTree: happy path with pyproject instead of requirements', () => {
  const r = validateSourceTree({
    files: [{ path: 'main.py', size: 800 }, { path: 'pyproject.toml', size: 200 }],
    hasRequirements: false,
    hasPyproject: true,
    hasPy: true,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('validateSourceTree: rejects when total uncompressed size exceeds cap', () => {
  const big = MAX_SOURCE_BYTES + 1;
  const r = validateSourceTree({
    files: [{ path: 'weights.bin', size: big }],
    hasRequirements: true,
    hasPy: true,
  });
  assert.equal(r.ok, false);
  // Two errors expected here: total > cap AND per-file > cap. Verify the
  // total-size error is present.
  assert.ok(r.errors.some((e) => /uncompressed/.test(e)));
});

test('validateSourceTree: rejects when file count exceeds cap', () => {
  const files = [];
  for (let i = 0; i < MAX_SOURCE_FILES + 1; i++) files.push({ path: 'f' + i + '.py', size: 10 });
  const r = validateSourceTree({
    files: files,
    hasRequirements: true,
    hasPy: true,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /files; max is 500/.test(e)));
});

test('validateSourceTree: rejects when any single file exceeds per-file cap', () => {
  const r = validateSourceTree({
    files: [
      { path: 'app.py', size: 100 },
      { path: 'big.bin', size: MAX_FILE_BYTES + 1 },
    ],
    hasRequirements: true,
    hasPy: true,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /big\.bin/.test(e)));
  assert.ok(r.errors.some((e) => /per-file cap/.test(e)));
});

test('validateSourceTree: rejects when no requirements.txt and no pyproject.toml', () => {
  const r = validateSourceTree({
    files: [{ path: 'app.py', size: 100 }],
    hasRequirements: false,
    hasPyproject: false,
    hasPy: true,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /requirements\.txt or pyproject\.toml/.test(e)));
});

test('validateSourceTree: rejects when no .py files at top level', () => {
  const r = validateSourceTree({
    files: [{ path: 'requirements.txt', size: 40 }],
    hasRequirements: true,
    hasPyproject: false,
    hasPy: false,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /no \.py files/.test(e)));
});

test('validateSourceTree: multiple rejections accumulate in one call', () => {
  // Craft a tree that violates: total size, per-file size, no deps manifest,
  // AND no .py — but stay under MAX_SOURCE_FILES so that one specific error
  // does NOT fire. Verify we get exactly the four we expect.
  const r = validateSourceTree({
    files: [
      { path: 'blob1.bin', size: MAX_FILE_BYTES + 1 },
      { path: 'blob2.bin', size: MAX_SOURCE_BYTES }, // pushes total over cap
    ],
    hasRequirements: false,
    hasPyproject: false,
    hasPy: false,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /uncompressed/.test(e)), 'total-size error');
  assert.ok(r.errors.some((e) => /per-file cap/.test(e)), 'per-file error');
  assert.ok(r.errors.some((e) => /requirements\.txt or pyproject\.toml/.test(e)), 'deps error');
  assert.ok(r.errors.some((e) => /no \.py files/.test(e)), 'no-py error');
  // File-count error should NOT fire since we only have 2 files.
  assert.ok(!r.errors.some((e) => /files; max is 500/.test(e)), 'count error absent');
});

test('validateSourceTree: empty input rejects with deps + no-py errors', () => {
  const r = validateSourceTree({ files: [] });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
});

test('validateSourceTree: reports every oversized file, not just the first', () => {
  const r = validateSourceTree({
    files: [
      { path: 'a.bin', size: MAX_FILE_BYTES + 1 },
      { path: 'b.bin', size: MAX_FILE_BYTES + 2 },
      { path: 'c.bin', size: 10 },
    ],
    hasRequirements: true,
    hasPy: true,
  });
  const oversizeErr = r.errors.find((e) => /per-file cap/.test(e));
  assert.ok(oversizeErr);
  assert.match(oversizeErr, /a\.bin/);
  assert.match(oversizeErr, /b\.bin/);
  assert.ok(!/c\.bin/.test(oversizeErr));
});
