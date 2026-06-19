'use strict';

// cloud-worker-logs.js — per-app log tail for the COMPUTE tier (cloud-workers.js).
//
// A deployed tenant Worker's console output isn't visible to its owner by default
// (CF keeps it; we don't). To surface it we run an out-of-repo CF "Tail Worker"
// attached to the dispatch namespace; it batches each script's log events and
// POSTs them to /api/account/cloud-workers/:id/logs/ingest here, authenticated by a
// shared secret (LINGCODE_TAIL_INGEST_KEY). We store a capped ring buffer per
// worker in `worker_logs` (mirrors backend_logs) and expose a read route for the
// console Logs panel. The control plane also writes its own events here (e.g. an
// auto-suspend notice) via appendLog().

const INGEST_KEY = process.env.LINGCODE_TAIL_INGEST_KEY || '';
const RING_MAX = 500;            // keep ~500 newest rows per worker
const MSG_MAX = 4 * 1024;        // clamp a single line
const BATCH_MAX = 200;           // events per ingest call

// Append one log line and prune the worker's buffer back to RING_MAX. Best-effort:
// never throws (callers are hot paths / background ticks).
function appendLog(db, workerId, level, message) {
  try {
    db.prepare('INSERT INTO worker_logs (worker_id, ts, level, message) VALUES (?,?,?,?)')
      .run(workerId, Date.now(), String(level || 'info').slice(0, 16), String(message == null ? '' : message).slice(0, MSG_MAX));
    // Prune: delete all but the newest RING_MAX ids for this worker.
    db.prepare(`DELETE FROM worker_logs WHERE worker_id = ? AND id NOT IN (
      SELECT id FROM worker_logs WHERE worker_id = ? ORDER BY id DESC LIMIT ?
    )`).run(workerId, workerId, RING_MAX);
  } catch (_) { /* logging must never break the caller */ }
}

function registerWorkerLogRoutes(app, db) {
  const { workerAccess } = require('./cloud-workers');
  const express = require('express');

  // Tail-worker ingest. NOT user-auth'd — gated by the shared ingest secret. The
  // worker id in the path must exist. Accepts { events: [{ level, message, ts }] }.
  app.post('/api/account/cloud-workers/:id/logs/ingest', express.json({ limit: '256kb' }), (req, res) => {
    if (!INGEST_KEY || req.get('X-LingCode-Tail-Key') !== INGEST_KEY) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const id = String(req.params.id || '');
    if (!db.prepare('SELECT 1 FROM cloud_workers WHERE id = ?').get(id)) {
      return res.status(404).json({ ok: false, error: 'app_not_found' });
    }
    const events = Array.isArray(req.body && req.body.events) ? req.body.events.slice(0, BATCH_MAX) : [];
    for (const ev of events) appendLog(db, id, ev && ev.level, ev && ev.message);
    res.json({ ok: true, ingested: events.length });
  });

  // Owner/member read route for the Logs panel.
  app.get('/api/account/cloud-workers/:id/logs', (req, res) => {
    const ctx = workerAccess(db, req, res, 'viewer'); if (!ctx) return;
    const limit = Math.min(RING_MAX, Math.max(1, parseInt(String(req.query.limit || '200'), 10) || 200));
    const rows = db.prepare('SELECT id, ts, level, message FROM worker_logs WHERE worker_id = ? ORDER BY id DESC LIMIT ?').all(ctx.row.id, limit);
    res.json({ ok: true, data: rows });
  });
}

module.exports = { registerWorkerLogRoutes, appendLog };
