'use strict';
// Gate 2 — the whole point of the compute tier. Do, against LINGCODE_DB_URL, what
// the CRUD gateway forbids: a single multi-statement transaction, a 5000-row write
// (gateway caps writes far lower), an unbounded read (gateway select=200/rpc=1000),
// and a session advisory lock (impossible through transaction-pooled PgBouncer).
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.LINGCODE_DB_URL });
  await c.connect();

  // One transaction, multiple statements.
  await c.query('BEGIN');
  await c.query('CREATE TABLE IF NOT EXISTS compute_probe (n int PRIMARY KEY)');
  await c.query('TRUNCATE compute_probe');
  await c.query('INSERT INTO compute_probe (n) SELECT generate_series(1, 5000)');
  const { rows } = await c.query('SELECT count(*)::int AS n FROM compute_probe');
  await c.query('COMMIT');
  console.log('inserted_count=' + rows[0].n);
  if (rows[0].n !== 5000) { console.error('FAIL: expected 5000, got ' + rows[0].n); process.exit(1); }

  // Unbounded read — pull all 5000 back in one result set (no 1000-row slice).
  const all = await c.query('SELECT n FROM compute_probe ORDER BY n');
  console.log('readback_count=' + all.rows.length);
  if (all.rows.length !== 5000) { console.error('FAIL: readback truncated to ' + all.rows.length); process.exit(1); }

  // Session-scoped advisory lock — proves the DIRECT (non-PgBouncer) path.
  const al = await c.query('SELECT pg_try_advisory_lock(424242) AS got');
  console.log('advisory_lock=' + al.rows[0].got);
  await c.query('SELECT pg_advisory_unlock(424242)');

  // Negative isolation check (optional): a foreign schema must be unreachable.
  // Set PROBE_FOREIGN_SCHEMA=be_<otherBackendId> to assert permission-denied.
  if (process.env.PROBE_FOREIGN_SCHEMA) {
    try {
      await c.query(`SELECT 1 FROM ${process.env.PROBE_FOREIGN_SCHEMA}.auth_users LIMIT 1`);
      console.error('FAIL: reached foreign schema ' + process.env.PROBE_FOREIGN_SCHEMA);
      process.exit(1);
    } catch (e) {
      console.log('cross_schema_blocked=' + (/permission denied|does not exist/i.test(e.message) ? 'yes' : 'unexpected:' + e.message));
    }
  }

  await c.end();
  console.log('GATE2_PASS');
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
