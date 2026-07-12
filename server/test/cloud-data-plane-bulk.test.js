// DB-free tests for planBulkWrite — the pure planner behind batch insert and
// upsert in cloud-data-plane.js. Covers single vs array rows, the union-of-keys
// + NULL-for-missing contract, ON CONFLICT DO UPDATE / DO NOTHING SQL, the
// per-call maxRows guard, bind-param chunking, and identifier injection safety.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { planBulkWrite, buildRpcCall } = require('../cloud-data-plane.js');

describe('planBulkWrite — insert (no onConflict)', () => {
  test('single row object → one statement, RETURNING *', () => {
    const sts = planBulkWrite({ table: 'todos', rows: { title: 'a', done: false } });
    assert.equal(sts.length, 1);
    assert.equal(sts[0].sql, 'INSERT INTO "todos" ("title", "done") VALUES ($1, $2) RETURNING *');
    assert.deepEqual(sts[0].values, ['a', false]);
  });

  test('array of rows → one multi-row VALUES statement', () => {
    const sts = planBulkWrite({ table: 'events', rows: [{ a: 1 }, { a: 2 }, { a: 3 }] });
    assert.equal(sts.length, 1);
    assert.equal(sts[0].sql, 'INSERT INTO "events" ("a") VALUES ($1), ($2), ($3) RETURNING *');
    assert.deepEqual(sts[0].values, [1, 2, 3]);
  });

  test('union of keys across rows; missing column binds NULL', () => {
    const sts = planBulkWrite({ table: 't', rows: [{ a: 1 }, { b: 2 }] });
    // columns = first-seen union [a, b]; row1 has no b, row2 has no a
    assert.equal(sts[0].sql, 'INSERT INTO "t" ("a", "b") VALUES ($1, $2), ($3, $4) RETURNING *');
    assert.deepEqual(sts[0].values, [1, null, null, 2]);
  });

  test('empty array throws', () => {
    assert.throws(() => planBulkWrite({ table: 't', rows: [] }), /no rows provided/);
  });

  test('row with no columns throws', () => {
    assert.throws(() => planBulkWrite({ table: 't', rows: {} }), /rows have no columns/);
  });

  test('non-object row throws', () => {
    assert.throws(() => planBulkWrite({ table: 't', rows: [1, 2] }), /row object required/);
  });
});

describe('planBulkWrite — upsert (onConflict)', () => {
  test('DO UPDATE sets every non-conflict column from EXCLUDED', () => {
    const sts = planBulkWrite({ table: 'events', rows: { source_hash: 'h', title: 'x', city: 'NYC' }, onConflict: 'source_hash' });
    assert.equal(
      sts[0].sql,
      'INSERT INTO "events" ("source_hash", "title", "city") VALUES ($1, $2, $3) ON CONFLICT ("source_hash") DO UPDATE SET "title" = EXCLUDED."title", "city" = EXCLUDED."city" RETURNING *');
    assert.deepEqual(sts[0].values, ['h', 'x', 'NYC']);
  });

  test('composite conflict target (array)', () => {
    const sts = planBulkWrite({ table: 't', rows: { a: 1, b: 2, v: 3 }, onConflict: ['a', 'b'] });
    assert.match(sts[0].sql, /ON CONFLICT \("a", "b"\) DO UPDATE SET "v" = EXCLUDED\."v"/);
  });

  test('merge:false → DO NOTHING', () => {
    const sts = planBulkWrite({ table: 't', rows: { id: 1, v: 2 }, onConflict: 'id', merge: false });
    assert.match(sts[0].sql, /ON CONFLICT \("id"\) DO NOTHING RETURNING \*/);
    assert.doesNotMatch(sts[0].sql, /DO UPDATE/);
  });

  test('no non-conflict columns falls back to DO NOTHING (avoids invalid SQL)', () => {
    const sts = planBulkWrite({ table: 't', rows: { id: 1 }, onConflict: 'id', merge: true });
    assert.match(sts[0].sql, /ON CONFLICT \("id"\) DO NOTHING/);
  });

  test('empty onConflict throws', () => {
    assert.throws(() => planBulkWrite({ table: 't', rows: { a: 1 }, onConflict: [] }), /onConflict column/);
  });
});

describe('planBulkWrite — maxRows guard', () => {
  test('over the per-call cap throws 400', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ a: i }));
    const err = (() => { try { planBulkWrite({ table: 't', rows, maxRows: 3 }); } catch (e) { return e; } })();
    assert.match(err.message, /too many rows in one write: 5 \(max 3\)/);
    assert.equal(err.status, 400);
  });

  test('at the cap is allowed', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ a: i }));
    assert.equal(planBulkWrite({ table: 't', rows, maxRows: 3 }).length, 1);
  });
});

describe('planBulkWrite — bind-param chunking', () => {
  test('splits into multiple statements when params exceed the 60k cap', () => {
    // 9000 rows x 8 cols = 72k bind params > 60k → must chunk. Stays under the
    // 10k hard row backstop, so maxRows isn't the limiter here.
    const cols = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const rows = Array.from({ length: 9000 }, (_, i) => Object.fromEntries(cols.map((c) => [c, i])));
    const sts = planBulkWrite({ table: 't', rows, maxRows: 10000 });
    assert.ok(sts.length > 1, 'expected more than one chunk');
    // every chunk stays at/under the 60k bind-param cap
    for (const st of sts) assert.ok(st.values.length <= 60000, `chunk had ${st.values.length} params`);
    // all rows accounted for (8 params each)
    const total = sts.reduce((n, st) => n + st.values.length, 0);
    assert.equal(total, 9000 * 8);
  });
});

describe('planBulkWrite — injection safety', () => {
  test('unsafe table identifier throws', () => {
    assert.throws(() => planBulkWrite({ table: 't; DROP TABLE x', rows: { a: 1 } }), /unsafe identifier/);
  });
  test('unsafe column identifier throws', () => {
    assert.throws(() => planBulkWrite({ table: 't', rows: { 'a; DROP': 1 } }), /unsafe identifier/);
  });
  test('unsafe onConflict identifier throws', () => {
    assert.throws(() => planBulkWrite({ table: 't', rows: { a: 1 }, onConflict: '"x"' }), /unsafe identifier/);
  });
});

describe('buildRpcCall', () => {
  test('positional args (array) → $1,$2 placeholders', () => {
    const r = buildRpcCall('"top_n"', [10, 'x']);
    assert.equal(r.sql, 'SELECT * FROM "top_n"($1, $2)');
    assert.deepEqual(r.params, [10, 'x']);
  });

  test('named args (object) → "k" => $n notation, values in key order', () => {
    const r = buildRpcCall('"search_events"', { q: 'jazz', in_city: 'NYC' });
    assert.equal(r.sql, 'SELECT * FROM "search_events"("q" => $1, "in_city" => $2)');
    assert.deepEqual(r.params, ['jazz', 'NYC']);
  });

  test('no args → empty call', () => {
    assert.equal(buildRpcCall('"now_ish"', []).sql, 'SELECT * FROM "now_ish"()');
    assert.equal(buildRpcCall('"now_ish"', null).sql, 'SELECT * FROM "now_ish"()');
  });

  test('unsafe named-arg key throws', () => {
    assert.throws(() => buildRpcCall('"f"', { 'x; DROP': 1 }), /unsafe identifier/);
  });
});
