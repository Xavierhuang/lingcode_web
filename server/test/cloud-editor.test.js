'use strict';

// cloud-editor.js — the server-side agent behind the browser project editor and
// the iPhone Build screen. It reaches the model, project storage and deploys
// through this server's own routes on loopback, carrying the caller's
// credentials, so those routes bill and limit the user. These tests stand up the
// editor beside fakes of those routes on a real port and check what it sends
// them: that's the seam where a slip would mean free model calls, lost work or a
// site deployed for the wrong user.

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const tar = require('tar-stream');
const express = require('express');
const Database = require('better-sqlite3');
const { migrateUsersTable } = require('../migrate');
const { migrateAccountTokens, issueToken } = require('../account-tokens');
const { getUserFromRequest } = require('../auth-helpers');

const pepper = 'p'.repeat(48);
process.env.LINGCODE_TOKEN_PEPPER = pepper;

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(
    "CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE," +
    "tier TEXT NOT NULL DEFAULT 'free',created_at TEXT NOT NULL,source TEXT DEFAULT '')"
  );
  migrateUsersTable(db);
  const now = new Date().toISOString();
  for (const id of ['u_a', 'u_b']) {
    db.prepare('INSERT INTO users (id,email,tier,created_at,email_verified) VALUES (?,?,?,?,1)').run(id, `${id}@example.com`, 'free', now);
  }
  migrateAccountTokens(db, { pepper });
  db.exec(`
    CREATE TABLE project_members (id TEXT, project_id TEXT, user_id TEXT, role TEXT);
    CREATE TABLE cloud_apps (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, slug TEXT, project_id TEXT, updated_at INTEGER);
  `);
  return db;
}

function untar(buf) {
  return new Promise((resolve, reject) => {
    const files = {};
    const ex = tar.extract();
    ex.on('entry', (h, stream, next) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => { files[h.name] = Buffer.concat(chunks).toString('utf8'); next(); });
    });
    ex.on('finish', () => resolve(files));
    ex.on('error', reject);
    ex.end(zlib.gunzipSync(buf));
  });
}

// One Anthropic streamed reply: optional text, then optional tool calls.
function anthropicSSE({ text, tools = [] }) {
  const out = [];
  const ev = (o) => out.push(`data: ${JSON.stringify(o)}\n\n`);
  let i = 0;
  if (text) {
    ev({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text } });
    ev({ type: 'content_block_stop', index: i });
    i++;
  }
  for (const t of tools) {
    ev({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `tu_${i}`, name: t.name } });
    ev({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input) } });
    ev({ type: 'content_block_stop', index: i });
    i++;
  }
  ev({ type: 'message_delta', delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn' } });
  return out.join('');
}

async function harness() {
  const db = fixtureDb();
  const tokens = {
    a: issueToken(db, 'u_a', { pepper, scope: 'account' }).token,
    b: issueToken(db, 'u_b', { pepper, scope: 'account' }).token,
  };
  const fake = { inference: [], inferenceQueue: [], snapshots: {}, deploys: [], projectSeq: 0 };
  const app = express();
  app.use(express.json({ limit: '128kb' }));

  // ── Fakes of the routes the editor calls on loopback ──
  app.post('/api/inference/anthropic/v1/messages', (req, res) => {
    fake.inference.push({ auth: req.headers.authorization, body: req.body });
    const next = fake.inferenceQueue.shift() || { text: 'Done.' };
    if (next.status) return res.status(next.status).json(next.json);
    res.set('Content-Type', 'text/event-stream');
    res.end(next.raw || anthropicSSE(next));
  });
  app.post('/api/projects', (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const id = `proj_${++fake.projectSeq}`;
    db.prepare('INSERT INTO project_members VALUES (?,?,?,?)').run(`m_${id}`, id, u.id, 'owner');
    res.status(201).json({ ok: true, project: { id, name: req.body.name, role: 'owner' } });
  });
  app.post('/api/projects/:id/source', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
    const list = (fake.snapshots[req.params.id] ||= []);
    list.push(await untar(req.body));
    res.status(201).json({ ok: true, version: list.length });
  });
  app.get('/api/projects/:id/source/files', (req, res) => {
    const list = fake.snapshots[req.params.id];
    if (!list || !list.length) return res.status(404).json({ ok: false, error: 'no_snapshot' });
    res.json({ ok: true, version: list.length, files: list[list.length - 1] });
  });
  const deploy = (mode) => async (req, res) => {
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const files = await untar(Buffer.concat(chunks));
    let id = req.params.id;
    if (mode === 'update' && !db.prepare('SELECT 1 FROM cloud_apps WHERE id = ?').get(id)) return res.status(404).json({ ok: false, error: 'app_not_found' });
    if (mode === 'create') {
      id = `app_${fake.deploys.length + 1}`;
      db.prepare('INSERT INTO cloud_apps VALUES (?,?,?,?,?,?)').run(id, u.id, decodeURIComponent(req.headers['x-app-title'] || 'Untitled'), `site-${id}`, req.headers['x-lingcode-project-id'] || null, Date.now());
    }
    fake.deploys.push({ mode, id, user: u.id, files, projectHeader: req.headers['x-lingcode-project-id'] });
    res.status(mode === 'create' ? 201 : 200).json({ ok: true, id, url: `https://site-${id}.lingcode.app/`, slug: `site-${id}` });
  };
  app.post('/api/account/cloud-apps', deploy('create'));
  app.put('/api/account/cloud-apps/:id', deploy('update'));

  const { registerCloudEditorRoutes } = require('../cloud-editor');
  registerCloudEditorRoutes(app, db);

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.CLOUD_EDITOR_SELF_ORIGIN = origin;

  const call = (token, method, path, body) => fetch(origin + path, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: `Bearer ${token}` } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Run a prompt and collect its SSE events.
  const run = async (token, sessionId, prompt) => {
    const r = await call(token, 'POST', `/api/cloud-editor/sessions/${sessionId}/run`, { prompt });
    const text = await r.text();
    const events = [];
    for (const block of text.split('\n\n')) {
      const ev = /^event: (.+)$/m.exec(block);
      const data = /^data: (.+)$/m.exec(block);
      if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) });
    }
    return { status: r.status, events };
  };
  const close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  return { db, tokens, fake, call, run, close };
}

test('a build session creates a project, writes the site, and saves it', async (t) => {
  const h = await harness();
  t.after(h.close);
  h.fake.inferenceQueue.push(
    { tools: [{ name: 'write_file', input: { path: 'index.html', content: '<h1>Bakery</h1>' } }] },
    { text: 'Made a bakery landing page.' },
  );
  const open = await (await h.call(h.tokens.a, 'POST', '/api/cloud-editor/sessions', { mode: 'build', name: 'Bakery' })).json();
  assert.equal(open.ok, true);
  assert.equal(open.projectId, 'proj_1');
  assert.deepEqual(open.files, {});
  assert.equal(open.site, null);

  const { events } = await h.run(h.tokens.a, open.sessionId, 'a landing page for my bakery');
  const update = events.find((e) => e.event === 'file_update');
  assert.deepEqual(update.data, { path: 'index.html', content: '<h1>Bakery</h1>' });
  const done = events.find((e) => e.event === 'done');
  assert.deepEqual(done.data.changed, ['index.html']);
  assert.equal(done.data.saved, 1, 'a changed run is saved as a snapshot');
  assert.deepEqual(h.fake.snapshots.proj_1[0], { 'index.html': '<h1>Bakery</h1>' });

  // Every model call is the user's, through the metered proxy.
  assert.equal(h.fake.inference.length, 2);
  for (const c of h.fake.inference) assert.equal(c.auth, `Bearer ${h.tokens.a}`);
  assert.match(h.fake.inference[0].body.system, /website builder/);
});

test('the next prompt carries the conversation so far', async (t) => {
  const h = await harness();
  t.after(h.close);
  h.fake.inferenceQueue.push({ text: 'Made it.' }, { text: 'Made the header blue.' });
  const open = await (await h.call(h.tokens.a, 'POST', '/api/cloud-editor/sessions', { mode: 'build' })).json();
  await h.run(h.tokens.a, open.sessionId, 'a bakery page');
  await h.run(h.tokens.a, open.sessionId, 'make the header blue');
  const turns = h.fake.inference[1].body.messages;
  assert.deepEqual(turns.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(turns[0].content, 'a bakery page');
  assert.equal(turns[1].content, 'Made it.');
  assert.equal(turns[2].content, 'make the header blue');
});

test('a plan limit from the proxy reaches the client with its code', async (t) => {
  const h = await harness();
  t.after(h.close);
  h.fake.inferenceQueue.push({ status: 402, json: { error: 'lingmodel_limit', message: 'LingModel free quota is used up.' } });
  const open = await (await h.call(h.tokens.a, 'POST', '/api/cloud-editor/sessions', { mode: 'build' })).json();
  const { events } = await h.run(h.tokens.a, open.sessionId, 'a page');
  const err = events.find((e) => e.event === 'error');
  assert.equal(err.data.status, 402);
  assert.equal(err.data.code, 'lingmodel_limit');
  assert.match(err.data.message, /quota is used up/);
  assert.equal(events.some((e) => e.event === 'done'), false);
});

test('deploy publishes once, then updates the same site', async (t) => {
  const h = await harness();
  t.after(h.close);
  const open = await (await h.call(h.tokens.a, 'POST', '/api/cloud-editor/sessions', { mode: 'build' })).json();

  const empty = await h.call(h.tokens.a, 'POST', `/api/cloud-editor/sessions/${open.sessionId}/deploy`, {});
  assert.equal(empty.status, 400, 'nothing to publish without index.html');

  h.fake.inferenceQueue.push({ tools: [{ name: 'write_file', input: { path: 'index.html', content: 'v1' } }] }, { text: 'ok' });
  await h.run(h.tokens.a, open.sessionId, 'build it');
  const first = await (await h.call(h.tokens.a, 'POST', `/api/cloud-editor/sessions/${open.sessionId}/deploy`, { title: 'Bakery' })).json();
  assert.equal(first.ok, true);
  assert.equal(first.url, 'https://site-app_1.lingcode.app/');

  h.fake.inferenceQueue.push({ tools: [{ name: 'edit_file', input: { path: 'index.html', old_string: 'v1', new_string: 'v2' } }] }, { text: 'ok' });
  await h.run(h.tokens.a, open.sessionId, 'change it');
  const second = await (await h.call(h.tokens.a, 'POST', `/api/cloud-editor/sessions/${open.sessionId}/deploy`, {})).json();
  assert.equal(second.id, first.id);

  assert.deepEqual(h.fake.deploys.map((d) => [d.mode, d.id, d.user]), [['create', 'app_1', 'u_a'], ['update', 'app_1', 'u_a']]);
  assert.deepEqual(h.fake.deploys[1].files, { 'index.html': 'v2' });
  assert.equal(h.fake.deploys[0].projectHeader, open.projectId, 'the site is linked to its project');
});

test('reopening a project loads its saved files and its site', async (t) => {
  const h = await harness();
  t.after(h.close);
  h.fake.inferenceQueue.push({ tools: [{ name: 'write_file', input: { path: 'index.html', content: 'hello' } }] }, { text: 'ok' });
  const first = await (await h.call(h.tokens.a, 'POST', '/api/cloud-editor/sessions', { mode: 'build' })).json();
  await h.run(h.tokens.a, first.sessionId, 'build it');
  await h.call(h.tokens.a, 'POST', `/api/cloud-editor/sessions/${first.sessionId}/deploy`, {});

  const again = await (await h.call(h.tokens.a, 'POST', '/api/cloud-editor/sessions', { projectId: first.projectId, mode: 'build' })).json();
  assert.deepEqual(again.files, { 'index.html': 'hello' });
  assert.equal(again.site.id, 'app_1');

  const sites = await (await h.call(h.tokens.a, 'GET', '/api/cloud-editor/sites')).json();
  assert.deepEqual(sites.items.map((s) => [s.id, s.projectId]), [['app_1', first.projectId]]);
});

test('a session belongs to the user who opened it', async (t) => {
  const h = await harness();
  t.after(h.close);
  const open = await (await h.call(h.tokens.a, 'POST', '/api/cloud-editor/sessions', { mode: 'build' })).json();
  for (const [method, path] of [
    ['GET', `/api/cloud-editor/sessions/${open.sessionId}/files`],
    ['POST', `/api/cloud-editor/sessions/${open.sessionId}/deploy`],
    ['POST', `/api/cloud-editor/sessions/${open.sessionId}/close`],
  ]) {
    assert.equal((await h.call(h.tokens.b, method, path, method === 'POST' ? {} : undefined)).status, 404, `${path} as another user`);
    assert.equal((await h.call(null, method, path, method === 'POST' ? {} : undefined)).status, 401, `${path} signed out`);
  }
  // Still open for its owner.
  assert.equal((await h.call(h.tokens.a, 'GET', `/api/cloud-editor/sessions/${open.sessionId}/files`)).status, 200);
  // Another user's project can't be opened.
  assert.equal((await h.call(h.tokens.b, 'POST', '/api/cloud-editor/sessions', { projectId: open.projectId })).status, 404);
  // An edit session needs a project.
  assert.equal((await h.call(h.tokens.a, 'POST', '/api/cloud-editor/sessions', {})).status, 400);
});

test('undo puts back the files from before the last change, and saves them', async (t) => {
  const h = await harness();
  t.after(h.close);
  const open = await (await h.call(h.tokens.a, 'POST', '/api/cloud-editor/sessions', { mode: 'build' })).json();
  const undo = () => h.call(h.tokens.a, 'POST', `/api/cloud-editor/sessions/${open.sessionId}/undo`, {});
  assert.equal((await undo()).status, 400, 'nothing to undo yet');

  h.fake.inferenceQueue.push({ tools: [{ name: 'write_file', input: { path: 'index.html', content: 'v1' } }] }, { text: 'ok' });
  await h.run(h.tokens.a, open.sessionId, 'build it');
  h.fake.inferenceQueue.push({ tools: [{ name: 'write_file', input: { path: 'index.html', content: 'v2' } }] }, { text: 'ok' });
  const { events } = await h.run(h.tokens.a, open.sessionId, 'change it');
  assert.equal(events.find((e) => e.event === 'done').data.canUndo, true);

  const first = await (await undo()).json();
  assert.deepEqual(first.files, { 'index.html': 'v1' });
  assert.equal(first.canUndo, true);
  assert.deepEqual(h.fake.snapshots[open.projectId].at(-1), { 'index.html': 'v1' }, 'the undo is saved');
  const second = await (await undo()).json();
  assert.deepEqual(second.files, {});
  assert.equal(second.canUndo, false);

  // The next prompt is told about the undo.
  h.fake.inferenceQueue.push({ text: 'ok' });
  await h.run(h.tokens.a, open.sessionId, 'again');
  const turns = h.fake.inference.at(-1).body.messages;
  assert.ok(turns.some((m) => m.role === 'user' && /undid/.test(m.content)));
});

// A write_file call whose JSON arrives in pieces; `cut` ends the stream
// mid-call, as when the model runs out of output tokens.
function chunkedWriteSSE(path, content, { cut = false } = {}) {
  const json = JSON.stringify({ path, content });
  const pieces = [];
  for (let i = 0; i < json.length; i += 7) pieces.push(json.slice(i, i + 7));
  const out = [];
  const ev = (o) => out.push(`data: ${JSON.stringify(o)}\n\n`);
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_w', name: 'write_file' } });
  for (const p of (cut ? pieces.slice(0, Math.floor(pieces.length / 2)) : pieces)) {
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: p } });
  }
  if (cut) { ev({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }); return out.join(''); }
  ev({ type: 'content_block_stop', index: 0 });
  ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  return out.join('');
}

test('a file being written streams in before it is finished', async (t) => {
  const h = await harness();
  t.after(h.close);
  const page = '<h1>Willow & Bean</h1>\n<p>Coffee "and" cake</p>';
  h.fake.inferenceQueue.push({ raw: chunkedWriteSSE('index.html', page) }, { text: 'Built it.' });
  const open = await (await h.call(h.tokens.a, 'POST', '/api/cloud-editor/sessions', { mode: 'build' })).json();
  const { events } = await h.run(h.tokens.a, open.sessionId, 'a cafe site');
  const names = events.map((e) => e.event);
  assert.ok(names.indexOf('tool_start') >= 0 && names.indexOf('tool_start') < names.indexOf('file_update'), 'the file is announced before it is written');
  assert.deepEqual(events.find((e) => e.event === 'tool_start').data, { name: 'write_file', path: 'index.html' });
  const progress = events.filter((e) => e.event === 'file_progress');
  assert.ok(progress.length >= 1, 'partial content is streamed');
  assert.ok(page.startsWith(progress[0].data.content), 'partial content is a prefix of the file');
  assert.deepEqual(events.find((e) => e.event === 'file_update').data, { path: 'index.html', content: page });
  // The model is asked for room to write and a bounded amount of thinking.
  const body = h.fake.inference[0].body;
  assert.ok(body.max_tokens >= 16000);
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 4000 });
});

test('a file cut off mid-write is not saved and the model is told to split it', async (t) => {
  const h = await harness();
  t.after(h.close);
  h.fake.inferenceQueue.push(
    { raw: chunkedWriteSSE('index.html', '<h1>' + 'x'.repeat(200) + '</h1>', { cut: true }) },
    { tools: [{ name: 'write_file', input: { path: 'index.html', content: '<h1>short</h1>' } }] },
    { text: 'Done in smaller pieces.' },
  );
  const open = await (await h.call(h.tokens.a, 'POST', '/api/cloud-editor/sessions', { mode: 'build' })).json();
  const { events } = await h.run(h.tokens.a, open.sessionId, 'a long page');
  assert.ok(events.some((e) => e.event === 'tool_cut_off'));
  const updates = events.filter((e) => e.event === 'file_update');
  assert.deepEqual(updates.map((e) => e.data.content), ['<h1>short</h1>'], 'only the complete write is saved');
  const toolResult = h.fake.inference[1].body.messages.at(-1).content[0];
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /cut off/);
});
