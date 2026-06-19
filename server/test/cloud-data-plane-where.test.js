// DB-free tests for the injection-safe filter builder in cloud-data-plane.js.
// Covers the PostgREST-style operator grammar (eq/in/is + not/cs/cd/fts/or) and
// the placeholder-numbering contract (nextIdx) that UPDATE relies on. Bad
// identifiers and unknown operators must throw rather than reach SQL.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildWhere, buildOrder, buildFtsColumnSql } = require('../cloud-data-plane.js');

describe('buildWhere — existing grammar (regression)', () => {
  test('null filters → empty', () => {
    assert.deepEqual(buildWhere(null), { sql: '', values: [], nextIdx: 0 });
  });

  test('shorthand eq', () => {
    const r = buildWhere({ name: 'ada' });
    assert.equal(r.sql, 'WHERE "name" = $1');
    assert.deepEqual(r.values, ['ada']);
    assert.equal(r.nextIdx, 1);
  });

  test('IS NULL via null value and via is', () => {
    assert.equal(buildWhere({ deleted_at: null }).sql, 'WHERE "deleted_at" IS NULL');
    assert.equal(buildWhere({ deleted_at: { is: 'not_null' } }).sql, 'WHERE "deleted_at" IS NOT NULL');
  });

  test('range condition keeps both placeholders', () => {
    const r = buildWhere({ age: { gte: 5, lt: 10 } });
    assert.equal(r.sql, 'WHERE "age" >= $1 AND "age" < $2');
    assert.deepEqual(r.values, [5, 10]);
    assert.equal(r.nextIdx, 2);
  });

  test('in → = ANY', () => {
    const r = buildWhere({ id: { in: [1, 2, 3] } });
    assert.equal(r.sql, 'WHERE "id" = ANY($1)');
    assert.deepEqual(r.values, [[1, 2, 3]]);
  });
});

describe('buildWhere — new PostgREST operators', () => {
  test('not wraps the inner condition', () => {
    const r = buildWhere({ status: { not: { eq: 'done' } } });
    assert.equal(r.sql, 'WHERE NOT ("status" = $1)');
    assert.deepEqual(r.values, ['done']);
  });

  test('not + in', () => {
    const r = buildWhere({ id: { not: { in: [1, 2] } } });
    assert.equal(r.sql, 'WHERE NOT ("id" = ANY($1))');
    assert.deepEqual(r.values, [[1, 2]]);
  });

  test('cs/cd with an array binds the array as-is', () => {
    const cs = buildWhere({ tags: { cs: ['a', 'b'] } });
    assert.equal(cs.sql, 'WHERE "tags" @> $1');
    assert.deepEqual(cs.values, [['a', 'b']]);
    const cd = buildWhere({ tags: { cd: ['a'] } });
    assert.equal(cd.sql, 'WHERE "tags" <@ $1');
  });

  test('cs with an object casts to jsonb', () => {
    const r = buildWhere({ meta: { cs: { role: 'admin' } } });
    assert.equal(r.sql, 'WHERE "meta" @> $1::jsonb');
    assert.deepEqual(r.values, ['{"role":"admin"}']);
  });

  test('fts builds a websearch tsquery match', () => {
    const r = buildWhere({ body: { fts: 'hello world' } });
    assert.equal(r.sql, 'WHERE to_tsvector("body"::text) @@ websearch_to_tsquery($1)');
    assert.deepEqual(r.values, ['hello world']);
  });

  test('or groups branches and shares placeholder numbering', () => {
    const r = buildWhere({ or: [{ a: 1 }, { b: 2 }] });
    assert.equal(r.sql, 'WHERE ("a" = $1 OR "b" = $2)');
    assert.deepEqual(r.values, [1, 2]);
    assert.equal(r.nextIdx, 2);
  });

  test('or with a multi-condition branch parenthesises the AND', () => {
    const r = buildWhere({ or: [{ a: { gte: 1, lt: 5 } }, { b: 2 }] });
    assert.equal(r.sql, 'WHERE (("a" >= $1 AND "a" < $2) OR "b" = $3)');
  });

  test('top-level column + or compose with AND', () => {
    const r = buildWhere({ team_id: 7, or: [{ a: 1 }, { b: 2 }] });
    assert.equal(r.sql, 'WHERE "team_id" = $1 AND ("a" = $2 OR "b" = $3)');
    assert.deepEqual(r.values, [7, 1, 2]);
  });
});

describe('buildWhere — placeholder offset (UPDATE reserves SET slots)', () => {
  test('startIdx shifts every placeholder', () => {
    const r = buildWhere({ id: 9, name: { ilike: '%x%' } }, 2);
    assert.equal(r.sql, 'WHERE "id" = $3 AND "name" ILIKE $4');
    assert.deepEqual(r.values, [9, '%x%']);
    assert.equal(r.nextIdx, 4);
  });
});

describe('buildWhere — injection safety', () => {
  test('unsafe column identifier throws', () => {
    assert.throws(() => buildWhere({ 'id; DROP TABLE x': 1 }), /unsafe identifier/);
    assert.throws(() => buildWhere({ '"a"': 1 }), /unsafe identifier/);
  });

  test('unknown operator throws', () => {
    assert.throws(() => buildWhere({ id: { sneaky: 1 } }), /unsupported operator/);
  });

  test('non-object where throws', () => {
    assert.throws(() => buildWhere([1, 2]), /where must be an object/);
  });

  test('empty or throws', () => {
    assert.throws(() => buildWhere({ or: [] }), /non-empty array/);
  });

  test('not requires a condition object', () => {
    assert.throws(() => buildWhere({ id: { not: 5 } }), /condition object/);
  });
});

describe('buildFtsColumnSql', () => {
  test('builds a generated tsvector column + GIN index', () => {
    const sql = buildFtsColumnSql({ table: 'docs', column: 'fts', sourceColumns: ['title', 'body'] });
    assert.match(sql, /ALTER TABLE "docs" ADD COLUMN IF NOT EXISTS "fts" tsvector/);
    assert.match(sql, /GENERATED ALWAYS AS \(to_tsvector\('english', coalesce\("title"::text, ''\) \|\| ' ' \|\| coalesce\("body"::text, ''\)\)\) STORED/);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS "docs_fts_idx" ON "docs" USING gin\("fts"\)/);
  });
  test('rejects empty sourceColumns', () => {
    assert.throws(() => buildFtsColumnSql({ table: 'docs', sourceColumns: [] }), /sourceColumns/);
  });
  test('rejects unknown language', () => {
    assert.throws(() => buildFtsColumnSql({ table: 'docs', sourceColumns: ['a'], language: 'klingon' }), /unsupported language/);
  });
  test('rejects unsafe identifiers', () => {
    assert.throws(() => buildFtsColumnSql({ table: 'docs; DROP', sourceColumns: ['a'] }), /unsafe identifier/);
  });
});

describe('buildOrder', () => {
  test('string column ascends', () => {
    assert.equal(buildOrder('created_at'), 'ORDER BY "created_at" ASC');
  });
  test('descending + array', () => {
    assert.equal(
      buildOrder([{ column: 'a', ascending: false }, 'b']),
      'ORDER BY "a" DESC, "b" ASC');
  });
  test('unsafe order column throws', () => {
    assert.throws(() => buildOrder('a; DROP'), /unsafe identifier/);
  });
});
