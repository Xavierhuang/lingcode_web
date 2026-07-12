// Live-Postgres integration tests for the LingCode Cloud data plane — the layer
// the DB-free planBulkWrite/buildRpcCall unit tests can't reach: real ON CONFLICT
// behaviour, RLS tenant isolation, and rpc() calling tenant SQL functions.
//
// Connects to a Postgres reachable at CLOUD_TEST_PG_URL (default a local server on
// 127.0.0.1:5432, trust auth), creates a throwaway database, points the data plane
// at it, and drops it after. If no superuser Postgres is reachable (e.g. CI without
// one), every test self-skips rather than failing. (initdb-ing a private cluster
// was avoided: macOS SysV-shm limits make Postgres bootstrap flaky here.)

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

const dataPlane = require('../cloud-data-plane.js');

const A = '11111111-1111-1111-1111-111111111111'; // tenant user A
const B = '22222222-2222-2222-2222-222222222222'; // tenant user B
const BE1 = 'abcdef0123456789';                    // backend id (hex, 8-40 chars)
const BE2 = 'fedcba9876543210';
const TEST_DB = 'lingcode_cloud_inttest';

let pgReady = false;
let adminBaseUrl = null; // points at the maintenance `postgres` db

// Run one statement against `url` with ON_ERROR_STOP; returns stdout, throws on error.
function psql(url, sql) {
  return execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-tAc', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

before(() => {
  try {
    // Need a SUPERUSER (CREATE DATABASE/ROLE + SET ROLE for the RLS tests). Try
    // the given URL, else the conventional `postgres` superuser, else the current
    // user — and pick the first that reports rolsuper.
    const user = os.userInfo().username;
    const candidates = [
      process.env.CLOUD_TEST_PG_URL,
      'postgresql://postgres@127.0.0.1:5432/postgres',
      `postgresql://${user}@127.0.0.1:5432/postgres`,
    ].filter(Boolean);
    adminBaseUrl = null;
    for (const url of candidates) {
      try { if (psql(url, 'SELECT rolsuper FROM pg_roles WHERE rolname = current_user;').trim() === 't') { adminBaseUrl = url; break; } } catch (_) { /* try next */ }
    }
    if (!adminBaseUrl) throw new Error('no reachable superuser Postgres');
    // Fresh throwaway DB.
    psql(adminBaseUrl, `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);`);
    psql(adminBaseUrl, `CREATE DATABASE ${TEST_DB};`);
    const testUrl = adminBaseUrl.replace(/\/postgres(\?|$)/, `/${TEST_DB}$1`);
    process.env.CLOUD_PG_ADMIN_URL = testUrl;
    psql(testUrl, 'CREATE SCHEMA IF NOT EXISTS extensions; GRANT USAGE ON SCHEMA extensions TO PUBLIC;');
    try { psql(testUrl, 'CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;'); } catch (_) { /* pgvector optional */ }
    pgReady = true;
  } catch (err) {
    pgReady = false;
    try { console.warn(`[integration] skipping — no superuser Postgres reachable: ${(err && err.message) || err}`); } catch (_) {}
  }
});

after(async () => {
  if (!pgReady) return;
  // Drop the tenant roles (cluster-global) before the DB, then the DB itself.
  try { await dataPlane.dropBackend(BE1); } catch (_) {}
  try { await dataPlane.dropBackend(BE2); } catch (_) {}
  try { await dataPlane.endPool(); } catch (_) {}
  try { psql(adminBaseUrl, `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);`); } catch (_) {}
});

// Skip helper: every test bails cleanly when no local Postgres came up.
function gate(t) { if (!pgReady) { t.skip('no local Postgres'); return false; } return true; }

describe('cloud data plane — live Postgres', () => {
  test('provision + migration sets up schema, table, function, RLS', async (t) => {
    if (!gate(t)) return;
    await dataPlane.provisionBackend(BE1);
    await dataPlane.applyMigration(BE1, `
      CREATE TABLE items (
        id serial PRIMARY KEY,
        sku text UNIQUE NOT NULL,
        name text,
        qty int NOT NULL DEFAULT 0,
        owner uuid
      );
      CREATE TABLE tags (item_sku text, label text);
      CREATE FUNCTION items_with_tags(min_qty int)
        RETURNS TABLE(sku text, name text, label text) LANGUAGE sql STABLE AS $fn$
          SELECT i.sku, i.name, t.label FROM items i JOIN tags t ON t.item_sku = i.sku
          WHERE i.qty >= min_qty ORDER BY i.sku, t.label;
        $fn$;
      CREATE FUNCTION item_by_sku(want text)
        RETURNS SETOF items LANGUAGE sql STABLE AS $fn$ SELECT * FROM items WHERE sku = want; $fn$;
      ALTER TABLE items ENABLE ROW LEVEL SECURITY;
      CREATE POLICY items_owner ON items USING (owner = current_setting('app.user_id', true)::uuid);
    `);
    const tables = await dataPlane.listTables(BE1);
    const names = tables.map((t2) => t2.name || t2.table || t2);
    assert.ok(JSON.stringify(names).includes('items'), 'items table should exist');
  });

  test('batch insert writes many rows in one call', async (t) => {
    if (!gate(t)) return;
    const out = await dataPlane.proxyInsert(BE1, 'items', [
      { sku: 'a', name: 'Apple', qty: 5, owner: A },
      { sku: 'b', name: 'Banana', qty: 0, owner: A },
      { sku: 'c', name: 'Cherry', qty: 9, owner: A },
    ], { admin: true });
    assert.equal(out.rows.length, 3);
    assert.equal(await dataPlane.countRows(BE1, 'items'), 3);
  });

  test('upsert merge:true UPDATEs the conflicting row', async (t) => {
    if (!gate(t)) return;
    const out = await dataPlane.proxyUpsert(BE1, 'items',
      { sku: 'a', name: 'Apricot', qty: 50, owner: A },
      { onConflict: 'sku', admin: true });
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].name, 'Apricot');
    assert.equal(out.rows[0].qty, 50);
    assert.equal(await dataPlane.countRows(BE1, 'items'), 3, 'no new row on conflict');
  });

  test('upsert merge:false leaves the existing row untouched (DO NOTHING)', async (t) => {
    if (!gate(t)) return;
    const out = await dataPlane.proxyUpsert(BE1, 'items',
      { sku: 'a', name: 'SHOULD-NOT-WIN', qty: 0, owner: A },
      { onConflict: 'sku', merge: false, admin: true });
    assert.equal(out.rows.length, 0, 'DO NOTHING returns no rows');
    const cur = await dataPlane.proxySelect(BE1, 'items', { where: { sku: 'a' }, admin: true });
    assert.equal(cur.rows[0].name, 'Apricot', 'row unchanged from prior upsert');
  });

  test('upsert inserts a brand-new row', async (t) => {
    if (!gate(t)) return;
    await dataPlane.proxyUpsert(BE1, 'items', { sku: 'd', name: 'Date', qty: 3, owner: A }, { onConflict: 'sku', admin: true });
    assert.equal(await dataPlane.countRows(BE1, 'items'), 4);
  });

  test('rpc calls a tenant function — positional args + RLS enforced', async (t) => {
    if (!gate(t)) return;
    await dataPlane.proxyInsert(BE1, 'tags', [
      { item_sku: 'a', label: 'fruit' }, { item_sku: 'c', label: 'red' },
    ], { admin: true });
    // owner A sees the joined rows (qty >= 1 → a, c); positional arg [1]
    const seen = await dataPlane.rpcCall(BE1, 'items_with_tags', [1], { userId: A });
    assert.deepEqual(seen.rows.map((r) => r.sku).sort(), ['a', 'c']);
    // owner B sees nothing — RLS filters items inside the function
    const none = await dataPlane.rpcCall(BE1, 'items_with_tags', [1], { userId: B });
    assert.equal(none.rows.length, 0);
  });

  test('rpc with named args (object)', async (t) => {
    if (!gate(t)) return;
    const r = await dataPlane.rpcCall(BE1, 'item_by_sku', { want: 'a' }, { userId: A });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].sku, 'a');
  });

  test('RLS scopes proxySelect to the signed-in user', async (t) => {
    if (!gate(t)) return;
    const asA = await dataPlane.proxySelect(BE1, 'items', { userId: A, limit: 200 });
    assert.equal(asA.rows.length, 4, 'A owns all four rows');
    const asB = await dataPlane.proxySelect(BE1, 'items', { userId: B, limit: 200 });
    assert.equal(asB.rows.length, 0, 'B owns none → RLS returns nothing');
  });

  test('maxRows guard rejects an oversize batch (400)', async (t) => {
    if (!gate(t)) return;
    const rows = [{ sku: 'x1', owner: A }, { sku: 'x2', owner: A }, { sku: 'x3', owner: A }];
    await assert.rejects(
      () => dataPlane.proxyInsert(BE1, 'items', rows, { admin: true, maxRows: 2 }),
      (e) => /too many rows/.test(e.message) && e.status === 400);
  });

  test('tenant isolation — one backend cannot touch another schema', async (t) => {
    if (!gate(t)) return;
    await dataPlane.provisionBackend(BE2);
    await dataPlane.applyMigration(BE2, 'CREATE TABLE secrets (id serial primary key, v text);');
    await dataPlane.proxyInsert(BE2, 'secrets', { v: 'top' }, { admin: true });
    // BE1 has no `secrets` table — the proxy resolves tables per-schema → 404.
    await assert.rejects(
      () => dataPlane.proxySelect(BE1, 'secrets', { userId: A }),
      (e) => e.status === 404);
  });
});
