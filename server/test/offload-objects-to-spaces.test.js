'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { offloadObjects, parseArgs } = require('../scripts/offload-objects-to-spaces');

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE backend_objects (
      id TEXT PRIMARY KEY, backend_id TEXT NOT NULL, bucket TEXT NOT NULL DEFAULT 'public',
      path TEXT NOT NULL, content_type TEXT, bytes INTEGER NOT NULL DEFAULT 0,
      data_b64 TEXT NOT NULL, created_at TEXT NOT NULL, spaces_key TEXT, etag TEXT, owner_user_id TEXT,
      UNIQUE(backend_id, bucket, path)
    );
  `);
  const ins = db.prepare(`INSERT INTO backend_objects (id, backend_id, bucket, path, content_type, bytes, data_b64, created_at, spaces_key)
    VALUES (?, ?, ?, ?, 'text/plain', ?, ?, ?, ?)`);
  const b64 = (s) => Buffer.from(s).toString('base64');
  ins.run('o1', 'be1', 'public', 'a.txt', 5, b64('hello'), '2026-10-01', null);
  ins.run('o2', 'be1', 'private', 'u_7/b.txt', 3, b64('abc'), '2026-10-02', null);
  ins.run('o3', 'be2', 'public', 'c.txt', 2, '', '2026-10-03', 'be_be2/public/c.txt'); // already in Spaces
  return db;
}

function fakeStorage({ failPath = null, truncatePath = null } = {}) {
  const objects = new Map();
  return {
    objects,
    async putObject(backendId, bucket, path, body) {
      if (path === failPath) throw new Error('network down');
      const key = `be_${backendId}/${bucket}/${path}`;
      objects.set(key, path === truncatePath ? body.subarray(1) : body);
      return { key, etag: `etag-${path}` };
    },
    async headObject(backendId, bucket, path) {
      const key = `be_${backendId}/${bucket}/${path}`;
      const b = objects.get(key);
      return b ? { bytes: b.length, etag: null, key } : null;
    },
  };
}

test('moves inline rows to Spaces and empties data_b64', async () => {
  const db = fixtureDb();
  const storage = fakeStorage();
  const r = await offloadObjects({ db, storage });
  assert.equal(r.candidates, 2);
  assert.equal(r.moved, 2);
  assert.equal(r.bytes, 8);
  assert.equal(storage.objects.get('be_be1/public/a.txt').toString(), 'hello');
  assert.equal(storage.objects.get('be_be1/private/u_7/b.txt').toString(), 'abc');
  const o1 = db.prepare('SELECT data_b64, spaces_key, etag FROM backend_objects WHERE id=?').get('o1');
  assert.deepEqual(o1, { data_b64: '', spaces_key: 'be_be1/public/a.txt', etag: 'etag-a.txt' });
});

test('is idempotent: a second run finds nothing', async () => {
  const db = fixtureDb();
  await offloadObjects({ db, storage: fakeStorage() });
  const r = await offloadObjects({ db, storage: fakeStorage() });
  assert.equal(r.candidates, 0);
});

test('keeps the row inline when upload or verification fails', async () => {
  const db = fixtureDb();
  const r = await offloadObjects({ db, storage: fakeStorage({ failPath: 'a.txt', truncatePath: 'u_7/b.txt' }) });
  assert.equal(r.failed, 2);
  assert.equal(r.moved, 0);
  const rows = db.prepare(`SELECT id FROM backend_objects WHERE spaces_key IS NULL AND data_b64 != ''`).all();
  assert.deepEqual(rows.map((x) => x.id).sort(), ['o1', 'o2']);
  assert.match(r.errors.find((e) => e.id === 'o2').error, /verify failed/);
});

test('does not clobber a row the app re-uploaded mid-copy', async () => {
  const db = fixtureDb();
  const storage = fakeStorage();
  const put = storage.putObject.bind(storage);
  storage.putObject = async (backendId, bucket, path, body, ct) => {
    const out = await put(backendId, bucket, path, body, ct);
    if (path === 'a.txt') {
      db.prepare(`UPDATE backend_objects SET data_b64=?, bytes=7 WHERE id='o1'`).run(Buffer.from('changed').toString('base64'));
    }
    return out;
  };
  const r = await offloadObjects({ db, storage });
  assert.equal(r.moved, 1);
  assert.equal(r.skipped, 1);
  const o1 = db.prepare('SELECT data_b64, spaces_key FROM backend_objects WHERE id=?').get('o1');
  assert.equal(Buffer.from(o1.data_b64, 'base64').toString(), 'changed');
  assert.equal(o1.spaces_key, null);
});

test('--backend and --limit narrow the candidates', async () => {
  const db = fixtureDb();
  const r = await offloadObjects({ db, storage: fakeStorage(), backend: 'be1', limit: 1 });
  assert.equal(r.candidates, 1);
  assert.equal(r.moved, 1);
  assert.deepEqual(parseArgs(['--backend', 'be1', '--limit', '5', '--dry-run']),
    { db: null, backend: 'be1', limit: 5, dryRun: true, yes: false, vacuum: false });
});
