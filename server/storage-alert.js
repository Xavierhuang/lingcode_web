'use strict';

// storage-alert.js — daily AGGREGATE object-storage usage/spend alert for
// LingCode Cloud. The per-tenant caps (cloud-limits maxStorageBytes +
// assertStorageRoom) protect each backend; THIS protects *us* from a total-cost
// surprise across all tenants (a runaway/abusive set of free apps, etc.).
//
// Sums bytes across ALL backends from the control-plane SQLite (backend_objects),
// estimates the monthly object-storage bill, prints a summary, and — when the
// total crosses CLOUD_STORAGE_ALERT_GB — POSTs to ALERT_WEBHOOK (same pattern as
// the droplet's disk-alert.sh). Runs on the API droplet, where data.db lives.
//
// Run manually:  node storage-alert.js [--db /opt/lingcode-api/data.db]
// Cron (API droplet), loading .env so the webhook/threshold apply:
//   0 6 * * * set -a; . /opt/lingcode-api/.env 2>/dev/null; set +a; \
//     node /opt/lingcode-api/storage-alert.js >> /var/log/lingcode-storage-alert.log 2>&1
//
// Env:
//   CLOUD_STORAGE_ALERT_GB  alert threshold in GB (default 100)
//   STORAGE_GB_PRICE        $/GB-month for the estimate (default 0.015 = R2; Spaces ≈ 0.02)
//   ALERT_WEBHOOK           optional; receives { text } JSON when over threshold
//   CLOUD_DB_PATH           data.db path (default: alongside this script)

const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : def;
}

const GB = 1024 * 1024 * 1024;

async function main() {
  const dbPath = arg('--db', process.env.CLOUD_DB_PATH || path.join(__dirname, 'data.db'));
  const thresholdGb = Number(process.env.CLOUD_STORAGE_ALERT_GB || 100);
  const pricePerGb = Number(process.env.STORAGE_GB_PRICE || 0.015);

  let Database;
  try { Database = require('better-sqlite3'); }
  catch (e) { console.error('storage-alert: better-sqlite3 unavailable:', e && e.message); return; }

  let db;
  try { db = new Database(dbPath, { readonly: true, fileMustExist: true }); }
  catch (e) { console.error('storage-alert: cannot open', dbPath, '-', e && e.message); return; }

  let total = 0, count = 0, top = [];
  try {
    const agg = db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes, COUNT(*) AS n FROM backend_objects').get();
    total = agg.bytes || 0; count = agg.n || 0;
    top = db.prepare('SELECT backend_id, COALESCE(SUM(bytes),0) AS bytes, COUNT(*) AS n FROM backend_objects GROUP BY backend_id ORDER BY bytes DESC LIMIT 10').all();
  } catch (e) { console.error('storage-alert: query failed (table may not exist yet):', e && e.message); return; }
  finally { try { db.close(); } catch (_) { /* ignore */ } }

  const totalGb = total / GB;
  const estCost = totalGb * pricePerGb;
  const topStr = top.map((t) => `${t.backend_id}=${(t.bytes / GB).toFixed(2)}GB`).join(', ') || '(none)';
  console.log(`${new Date().toISOString()} LingCode Cloud storage: ${totalGb.toFixed(2)} GB across ${count} objects (~$${estCost.toFixed(2)}/mo @ $${pricePerGb}/GB). Top: ${topStr}`);

  if (totalGb < thresholdGb) return;

  const text = `⚠️ LingCode Cloud object storage at ${totalGb.toFixed(1)} GB (threshold ${thresholdGb} GB, ~$${estCost.toFixed(2)}/mo). Top backends: ` +
    top.slice(0, 5).map((t) => `${t.backend_id}=${(t.bytes / GB).toFixed(1)}GB`).join(', ');
  const hook = process.env.ALERT_WEBHOOK;
  if (hook && typeof fetch === 'function') {
    try {
      await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      console.log('storage-alert: webhook sent');
    } catch (e) { console.error('storage-alert: webhook failed:', e && e.message); }
  } else {
    console.warn('storage-alert: OVER THRESHOLD but no ALERT_WEBHOOK set —', text);
  }
  process.exitCode = 2; // non-zero so cron logs flag the over-threshold run
}

main();
