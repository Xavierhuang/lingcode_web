'use strict';

// Tests for the apex↔www auto-pairing on custom-domain add (siblingDomain +
// attachWorkerDomain). In-memory DB; mirrors the minimal custom_domains shape the
// route writes.

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { siblingDomain, attachWorkerDomain } = require('../cloud-workers');

function makeDb(taken = []) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE custom_domains (domain TEXT, prototype_id TEXT, worker_id TEXT,
    user_id TEXT, status TEXT, created_at TEXT, domainee_id TEXT)`);
  for (const d of taken) db.prepare("INSERT INTO custom_domains (domain, worker_id, user_id, status, created_at) VALUES (?,?,?,?,?)").run(d, 'w0', 'u0', 'active', 'now');
  return db;
}

test('siblingDomain: www strips to apex, apex expands to www', () => {
  assert.equal(siblingDomain('www.thesprintstudio.co'), 'thesprintstudio.co');
  assert.equal(siblingDomain('thesprintstudio.co'), 'www.thesprintstudio.co');
  assert.equal(siblingDomain('www.example.co.uk'), 'example.co.uk'); // strip always correct
});

test('siblingDomain: no sibling for arbitrary subdomains or multi-label apexes', () => {
  assert.equal(siblingDomain('api.example.com'), null);   // don't invent www.api.…
  assert.equal(siblingDomain('example.co.uk'), null);     // 3 labels → not auto-expanded
  assert.equal(siblingDomain('www.co'), null);            // strip yields no dot
});

test('attachWorkerDomain: inserts, reports taken, rejects invalid/reserved', () => {
  const db = makeDb(['already.com']);
  assert.equal(attachWorkerDomain(db, 'w1', 'u1', 'fresh.com'), 'added');
  assert.equal(attachWorkerDomain(db, 'w1', 'u1', 'already.com'), 'taken');
  assert.equal(attachWorkerDomain(db, 'w1', 'u1', 'x.lingcode.dev'), 'invalid');
  assert.equal(attachWorkerDomain(db, 'w1', 'u1', 'not a domain'), 'invalid');
});

test('adding www attaches the apex too (the thesprintstudio case)', () => {
  const db = makeDb();
  // Simulate the route: attach primary, then the sibling.
  assert.equal(attachWorkerDomain(db, 'w1', 'u1', 'www.thesprintstudio.co'), 'added');
  const sib = siblingDomain('www.thesprintstudio.co');
  assert.equal(attachWorkerDomain(db, 'w1', 'u1', sib), 'added');
  const rows = db.prepare('SELECT domain FROM custom_domains WHERE worker_id = ? ORDER BY domain').all('w1').map((r) => r.domain);
  assert.deepEqual(rows, ['thesprintstudio.co', 'www.thesprintstudio.co']);
});

test('sibling add silently no-ops when already taken (idempotent re-add)', () => {
  const db = makeDb(['thesprintstudio.co']); // apex already attached elsewhere
  assert.equal(attachWorkerDomain(db, 'w1', 'u1', 'www.thesprintstudio.co'), 'added');
  assert.equal(attachWorkerDomain(db, 'w1', 'u1', siblingDomain('www.thesprintstudio.co')), 'taken');
});
