'use strict';

// Verifies the idempotent legacy→multi-file schema bump used by
// migrateCollabTables. Builds a database with the legacy single-column-PK
// collab_ydoc_state shape, runs the bump, and confirms both the columns and
// the data survive — and that a composite-PK insert is now valid.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { bumpCollabSchemaToMultiFile } = require('../migrate.js');

function buildLegacyDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE collab_ydoc_state (
      prototype_id TEXT PRIMARY KEY,
      state_blob   BLOB NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE TABLE collab_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      prototype_id TEXT NOT NULL,
      user_id      TEXT,
      update_blob  BLOB NOT NULL,
      server_ts    INTEGER NOT NULL
    );
  `);
  return db;
}

test('legacy ydoc rows migrate to file_id="_main" with composite PK', () => {
  const db = buildLegacyDb();
  db.prepare('INSERT INTO collab_ydoc_state (prototype_id, state_blob, updated_at) VALUES (?, ?, ?)')
    .run('proto-1', Buffer.from([1, 2, 3]), 1700000000000);

  bumpCollabSchemaToMultiFile(db);

  const cols = db.prepare('PRAGMA table_info(collab_ydoc_state)').all().map(c => c.name);
  assert.ok(cols.includes('file_id'), 'expected file_id column on collab_ydoc_state');

  const row = db.prepare('SELECT prototype_id, file_id, updated_at FROM collab_ydoc_state').get();
  assert.equal(row.prototype_id, 'proto-1');
  assert.equal(row.file_id, '_main');
  assert.equal(row.updated_at, 1700000000000);
});

test('composite PK admits multiple files per prototype', () => {
  const db = buildLegacyDb();
  db.prepare('INSERT INTO collab_ydoc_state (prototype_id, state_blob, updated_at) VALUES (?, ?, ?)')
    .run('proto-2', Buffer.from([1]), 1);
  bumpCollabSchemaToMultiFile(db);

  db.prepare('INSERT INTO collab_ydoc_state (prototype_id, file_id, state_blob, updated_at) VALUES (?, ?, ?, ?)')
    .run('proto-2', 'src/foo.swift', Buffer.from([2]), 2);
  db.prepare('INSERT INTO collab_ydoc_state (prototype_id, file_id, state_blob, updated_at) VALUES (?, ?, ?, ?)')
    .run('proto-2', 'src/bar.swift', Buffer.from([3]), 3);

  const ids = db.prepare('SELECT file_id FROM collab_ydoc_state WHERE prototype_id = ? ORDER BY file_id')
    .all('proto-2').map(r => r.file_id);
  assert.deepEqual(ids, ['_main', 'src/bar.swift', 'src/foo.swift']);

  // Re-inserting (proto-2, _main) must fail the composite PK constraint
  assert.throws(() =>
    db.prepare('INSERT INTO collab_ydoc_state (prototype_id, file_id, state_blob, updated_at) VALUES (?, ?, ?, ?)')
      .run('proto-2', '_main', Buffer.from([9]), 9)
  );
});

test('history table gains file_id column with default _main', () => {
  const db = buildLegacyDb();
  db.prepare('INSERT INTO collab_history (prototype_id, user_id, update_blob, server_ts) VALUES (?, ?, ?, ?)')
    .run('proto-3', 'u1', Buffer.from([0]), 100);
  bumpCollabSchemaToMultiFile(db);

  const cols = db.prepare('PRAGMA table_info(collab_history)').all().map(c => c.name);
  assert.ok(cols.includes('file_id'));
  const row = db.prepare('SELECT file_id FROM collab_history WHERE prototype_id = ?').get('proto-3');
  assert.equal(row.file_id, '_main');
});

test('bump is idempotent — second call is a no-op', () => {
  const db = buildLegacyDb();
  db.prepare('INSERT INTO collab_ydoc_state (prototype_id, state_blob, updated_at) VALUES (?, ?, ?)')
    .run('proto-4', Buffer.from([1]), 1);

  bumpCollabSchemaToMultiFile(db);
  bumpCollabSchemaToMultiFile(db);  // would throw "duplicate column" if not idempotent

  const row = db.prepare('SELECT prototype_id, file_id FROM collab_ydoc_state').get();
  assert.equal(row.prototype_id, 'proto-4');
  assert.equal(row.file_id, '_main');
});

test('idx_ch_proto_file_ts index exists after bump', () => {
  const db = buildLegacyDb();
  bumpCollabSchemaToMultiFile(db);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_ch_proto_file_ts'").get();
  assert.ok(idx, 'expected idx_ch_proto_file_ts index to exist');
});
