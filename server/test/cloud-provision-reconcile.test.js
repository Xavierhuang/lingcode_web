// Regression: provisioning keyed ONLY on project_key — a hash of the client's
// absolute folder path — so renaming or moving a project minted a brand-new
// EMPTY backend while the user's data stayed in the old one. Silently, behind a
// "LingCode Cloud connected" success message.
//
// Real case that prompted this: one account ended up with three backends (67
// tables, 3, 3) all linked to the SAME canonical project. The server had the
// correct project id recorded on every one of them and still created duplicates,
// because the link happened AFTER provisioning.
//
// reconcileByProjectId closes that: when the caller knows the canonical project
// (from .lingcode/project.json, which is committed and travels with the repo),
// the project's existing backend is reused.
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { reconcileByProjectId } = require('../cloud-backend');

function seed() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
                           created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE project_members (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL,
                                  role TEXT NOT NULL DEFAULT 'viewer', created_at INTEGER NOT NULL);
    CREATE TABLE account_backends (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_key TEXT NOT NULL,
                                   project_id TEXT, schema_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'live',
                                   label TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO users VALUES ('u_owner','owner@x.com')").run();
  db.prepare("INSERT INTO users VALUES ('u_mate','mate@x.com')").run();
  db.prepare("INSERT INTO users VALUES ('u_stranger','stranger@x.com')").run();
  db.prepare("INSERT INTO projects VALUES ('p1','u_owner','demolingcoapp',1,1)").run();

  const be = (id, key, label, created, status = 'live', pid = 'p1', uid = 'u_owner') =>
    db.prepare(`INSERT INTO account_backends
      (id, user_id, project_key, project_id, schema_name, status, label, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, uid, key, pid, 'be_' + id, status, label, created, created);

  // The real shape: original with the data, then two empties from renames.
  be('b_original', 'proj_oldpath', 'demolingcoapp', '2026-07-24T23:00:52Z');
  be('b_dup1',     'proj_newpath', 'backend',       '2026-07-27T03:25:30Z');
  be('b_dup2',     'proj_newer',   'showtonic',     '2026-07-27T03:25:45Z');
  return db;
}

test('a renamed folder reuses the project\'s ORIGINAL backend, not a new one', () => {
  const db = seed();
  const got = reconcileByProjectId(db, 'u_owner', 'p1', 'proj_a_brand_new_path');
  assert.ok(got, 'should resolve a backend');
  assert.equal(got.id, 'b_original', 'oldest backend wins — it is the one holding the data');
  db.close();
});

test('an exact project_key match wins over the oldest', () => {
  const db = seed();
  const got = reconcileByProjectId(db, 'u_owner', 'p1', 'proj_newer');
  assert.equal(got.id, 'b_dup2', 'a plain reconnect of the same folder keeps its own backend');
  db.close();
});

test('no project_id -> falls through to normal path-keyed provisioning', () => {
  const db = seed();
  assert.equal(reconcileByProjectId(db, 'u_owner', '', 'proj_whatever'), null);
  assert.equal(reconcileByProjectId(db, 'u_owner', null, 'proj_whatever'), null);
  db.close();
});

test('SECURITY: a stranger cannot claim a project they do not belong to', () => {
  const db = seed();
  // project_id arrives in the request body and is committed to the user's repo,
  // so it must be treated as untrusted input.
  assert.equal(reconcileByProjectId(db, 'u_stranger', 'p1', 'proj_anything'), null,
               'guessing a project id must not hand back someone else\'s database');
  db.close();
});

test('a collaborator (project_members) CAN reconcile', () => {
  const db = seed();
  db.prepare("INSERT INTO project_members VALUES ('m1','p1','u_mate','editor',1)").run();
  const got = reconcileByProjectId(db, 'u_mate', 'p1', 'proj_mates_own_path');
  assert.equal(got && got.id, 'b_original', 'a teammate resolves the shared backend');
  db.close();
});

test('unknown project id resolves to nothing', () => {
  const db = seed();
  assert.equal(reconcileByProjectId(db, 'u_owner', 'p_does_not_exist', 'proj_x'), null);
  db.close();
});

test('non-live backends are skipped', () => {
  const db = seed();
  db.prepare("UPDATE account_backends SET status='provisioning' WHERE id='b_original'").run();
  const got = reconcileByProjectId(db, 'u_owner', 'p1', 'proj_a_brand_new_path');
  assert.equal(got.id, 'b_dup1', 'falls to the next live backend rather than returning a half-built one');
  db.close();
});

test('a project with no backends yet resolves to nothing (first connect still provisions)', () => {
  const db = seed();
  db.prepare("DELETE FROM account_backends").run();
  assert.equal(reconcileByProjectId(db, 'u_owner', 'p1', 'proj_first_time'), null);
  db.close();
});
