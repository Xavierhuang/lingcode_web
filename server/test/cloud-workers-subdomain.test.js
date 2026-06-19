'use strict';

// Tests for validateSubdomain — the vanity-subdomain guard for hosted Workers.

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { validateSubdomain } = require('../cloud-workers');

function makeDb(taken = []) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE cloud_workers (id TEXT PRIMARY KEY, project_id TEXT)');
  for (const id of taken) db.prepare('INSERT INTO cloud_workers (id) VALUES (?)').run(id);
  return db;
}

test('accepts a valid, available vanity subdomain', () => {
  assert.equal(validateSubdomain(makeDb(), 'instademo-ai-api'), null);
  assert.equal(validateSubdomain(makeDb(), 'my-cool-app1'), null);
});

test('rejects malformed labels', () => {
  const db = makeDb();
  for (const bad of ['ab', '-lead', 'trail-', 'Has_Caps', 'sp ace', 'a'.repeat(41), 'under_score']) {
    const r = validateSubdomain(db, bad);
    assert.ok(r && r.error === 'invalid_subdomain', `expected invalid_subdomain for "${bad}", got ${JSON.stringify(r)}`);
  }
});

test('rejects the reserved app- prefix', () => {
  const r = validateSubdomain(makeDb(), 'app-foo');
  assert.equal(r.error, 'reserved_subdomain');
  assert.equal(r.code, 400);
});

test('rejects reserved platform names', () => {
  const db = makeDb();
  for (const name of ['api', 'www', 'admin', 'dispatch', 'stripe']) {
    const r = validateSubdomain(db, name);
    assert.ok(r && r.error === 'reserved_subdomain', `expected reserved for "${name}"`);
  }
});

test('rejects an already-taken subdomain', () => {
  const db = makeDb(['instademo-ai-api']);
  const r = validateSubdomain(db, 'instademo-ai-api');
  assert.equal(r.error, 'subdomain_taken');
  assert.equal(r.code, 409);
});
