// DB-free tests for the PostgREST-style resource-embedding compiler in
// cloud-data-plane.js (Supabase nested selects). Covers the parser, FK-driven
// direction resolution (to-one object vs to-many array), nesting, !inner →
// EXISTS, embedded-column filters, and the placeholder-numbering contract.
// No database — pure string compilation, same as the where-builder tests.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  selectHasEmbeds, parseEmbeddedSelect, resolveRelationship, compileEmbedSelect,
} = require('../cloud-data-plane.js');

const fk = (source_table, source_columns, target_table, target_columns, constraint_name) =>
  ({ constraint_name, source_table, source_columns, target_table, target_columns });

// A slice of showtonic's real FK graph.
const FKS = [
  fk('shows', ['venue_id'], 'venues', ['id'], 'shows_venue_id_fkey'),
  fk('show_artists', ['show_id'], 'shows', ['id'], 'sa_show_fkey'),
  fk('show_artists', ['artist_id'], 'artists', ['id'], 'sa_artist_fkey'),
  fk('show_logs', ['show_id'], 'shows', ['id'], 'sl_show_fkey'),
  fk('share_cards', ['log_id'], 'show_logs', ['id'], 'sc_log_fkey'),
];

const paramCount = (sql) => Math.max(0, ...(sql.match(/\$(\d+)/g) || []).map((x) => Number(x.slice(1))));
const balanced = (sql) => sql.split('(').length === sql.split(')').length;

describe('selectHasEmbeds — fast-path guard', () => {
  test('plain lists and star are not embeds', () => {
    assert.equal(selectHasEmbeds('*'), false);
    assert.equal(selectHasEmbeds('id,name,created_at'), false);
    assert.equal(selectHasEmbeds(null), false);
  });
  test('a paren marks an embed', () => {
    assert.equal(selectHasEmbeds('id,venue:venues(name)'), true);
  });
});

describe('parseEmbeddedSelect', () => {
  test('columns, alias, embed with alias', () => {
    const ast = parseEmbeddedSelect('id, venue:venues(name,city)');
    assert.deepEqual(ast[0], { type: 'col', name: 'id', alias: 'id' });
    assert.equal(ast[1].type, 'embed');
    assert.equal(ast[1].rel, 'venues');
    assert.equal(ast[1].alias, 'venue');
    assert.equal(ast[1].inner, false);
    assert.equal(ast[1].children.length, 2);
  });
  test('!inner and !hint modifiers', () => {
    const [a] = parseEmbeddedSelect('show:shows!inner(id)');
    assert.equal(a.inner, true);
    const [b] = parseEmbeddedSelect('a:b!some_fkey(id)');
    assert.equal(b.hint, 'some_fkey');
  });
  test('whitespace / newlines are ignored', () => {
    const ast = parseEmbeddedSelect('\n  id ,\n  venue:venues(\n name \n) \n');
    assert.equal(ast.length, 2);
  });
  test('malformed (unclosed paren) throws', () => {
    assert.throws(() => parseEmbeddedSelect('id,venue:venues(name'));
  });
  test('trailing garbage throws', () => {
    assert.throws(() => parseEmbeddedSelect('id venue'));
  });
});

describe('resolveRelationship — direction from FK', () => {
  test('belongs-to (base has FK) → to-one', () => {
    const r = resolveRelationship(FKS, 'shows', { rel: 'venues' });
    assert.equal(r.kind, 'one');
    assert.deepEqual(r.localCols, ['venue_id']);
    assert.deepEqual(r.remoteCols, ['id']);
  });
  test('has-many (child has FK) → to-many', () => {
    const r = resolveRelationship(FKS, 'shows', { rel: 'show_artists' });
    assert.equal(r.kind, 'many');
    assert.deepEqual(r.localCols, ['id']);
    assert.deepEqual(r.remoteCols, ['show_id']);
  });
  test('missing relationship throws', () => {
    assert.throws(() => resolveRelationship(FKS, 'shows', { rel: 'nope' }));
  });
  test('ambiguous relationship (both directions) throws without hint', () => {
    const amb = [fk('a', ['b_id'], 'b', ['id'], 'c1'), fk('b', ['a_id'], 'a', ['id'], 'c2')];
    assert.throws(() => resolveRelationship(amb, 'a', { rel: 'b' }));
  });
  test('hint disambiguates', () => {
    const amb = [fk('a', ['b_id'], 'b', ['id'], 'c1'), fk('b', ['a_id'], 'a', ['id'], 'c2')];
    const r = resolveRelationship(amb, 'a', { rel: 'b', hint: 'c1' });
    assert.equal(r.kind, 'one');
  });
});

describe('compileEmbedSelect — SQL generation', () => {
  test('to-one embed → jsonb_build_object subquery with LIMIT 1', () => {
    const ast = parseEmbeddedSelect('id,venue:venues(name,city)');
    const { sql, values } = compileEmbedSelect('shows', ast, FKS, { where: { id: 'S' }, limit: 1 });
    assert.match(sql, /jsonb_build_object\('name'/);
    assert.match(sql, /FROM "venues" _e0 WHERE _e0\."id" = t\."venue_id" LIMIT 1/);
    assert.match(sql, /AS "venue"/);
    assert.match(sql, /FROM "shows" t WHERE "id" = \$1/);
    assert.deepEqual(values, ['S']);
    assert.ok(balanced(sql));
    assert.equal(paramCount(sql), values.length);
  });

  test('to-many embed → COALESCE(jsonb_agg(...), \'[]\')', () => {
    const ast = parseEmbeddedSelect('id,show_artists(billing_order,artist:artists(name))');
    const { sql } = compileEmbedSelect('shows', ast, FKS, {});
    assert.match(sql, /COALESCE\(jsonb_agg\(/);
    assert.match(sql, /'\[\]'::jsonb\) FROM "show_artists" _e0 WHERE _e0\."show_id" = t\."id"/);
    // nested to-one inside the array
    assert.match(sql, /FROM "artists" _e1 WHERE _e1\."id" = _e0\."artist_id" LIMIT 1/);
    assert.ok(balanced(sql));
  });

  test('!inner adds an EXISTS to the base WHERE', () => {
    const ast = parseEmbeddedSelect('id,show:shows!inner(id)');
    const { sql } = compileEmbedSelect('show_logs', ast, FKS, { where: { user_id: 'U' } });
    assert.match(sql, /AND EXISTS \(SELECT 1 FROM "shows" _e0 WHERE _e0\."id" = t\."show_id"\)/);
  });

  test('embedded-column filter applies in subquery + EXISTS, reusing the param', () => {
    const ast = parseEmbeddedSelect('storage_path,log:show_logs!inner(rating)');
    const { sql, values } = compileEmbedSelect('share_cards', ast, FKS, {
      where: { user_id: 'U', variant: 'five_star', 'log.rating': 5 },
    });
    // filter appears in the json subquery AND the EXISTS clause
    assert.equal((sql.match(/_e0\."rating" = \$1/g) || []).length, 2);
    assert.match(sql, /"user_id" = \$2 AND "variant" = \$3/);
    assert.deepEqual(values, [5, 'U', 'five_star']);
    assert.equal(paramCount(sql), values.length);
  });

  test('order + IN filter + param numbering stays consistent', () => {
    const ast = parseEmbeddedSelect('id,show:shows(id,title)');
    const { sql, values } = compileEmbedSelect('show_logs', ast, FKS, {
      where: { id: { in: ['a', 'b'] } }, order: { column: 'created_at', ascending: false },
    });
    assert.match(sql, /"id" = ANY\(\$1\)/);
    assert.match(sql, /ORDER BY "created_at" DESC/);
    assert.deepEqual(values, [['a', 'b']]);
    assert.equal(paramCount(sql), values.length);
  });

  test('explicit columns are projected (not SELECT *), star keeps t.*', () => {
    const proj = compileEmbedSelect('shows', parseEmbeddedSelect('id,venue:venues(name)'), FKS, {});
    assert.match(proj.sql, /^SELECT t\."id" AS "id",/);
    const star = compileEmbedSelect('shows', parseEmbeddedSelect('*,venue:venues(name)'), FKS, {});
    assert.match(star.sql, /^SELECT t\.\*,/);
  });

  test('unsafe identifier in a column is rejected', () => {
    const ast = [{ type: 'col', name: 'id;DROP', alias: 'x' }];
    assert.throws(() => compileEmbedSelect('shows', ast, FKS, {}));
  });
});
