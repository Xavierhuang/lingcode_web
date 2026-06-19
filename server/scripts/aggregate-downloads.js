#!/usr/bin/env node
'use strict';

/**
 * Daily aggregator for LingCode DMG downloads.
 *
 * Reads every available nginx access log (current, rotated, gzipped),
 * grep'd for `GET /LingCode-v*.dmg`, then upserts per-(day, filename)
 * counts into the `download_stats` table. Idempotent — running twice on
 * the same logs produces the same result. Once a row is in the DB, it
 * survives the source log being rotated away by logrotate, so this gives
 * us lifetime accumulation despite nginx only retaining ~14 days of logs.
 *
 * Usage (manual):
 *   node /opt/lingcode-api/scripts/aggregate-downloads.js
 *
 * Usage (cron, runs daily as root since /var/log/nginx is `www-data:adm`):
 *   crontab -e
 *   30 0 * * * /usr/bin/node /opt/lingcode-api/scripts/aggregate-downloads.js \
 *     >> /var/log/lingcode-aggregate-downloads.log 2>&1
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');

const NGINX_LOG_DIR = process.env.NGINX_LOG_DIR || '/var/log/nginx';
const DB_PATH = process.env.LINGCODE_DB || path.join(__dirname, '..', 'data.db');

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

// Standard nginx combined log format:
//   $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent ...
//   104.23.190.117 - - [08/May/2026:02:42:59 +0000] "GET /LingCode-v2.7.0-Installer.dmg HTTP/1.1" 200 ...
const LINE_RE = /^(\S+) \S+ \S+ \[(\d{2})\/(\w{3})\/(\d{4}):\d{2}:\d{2}:\d{2}[^\]]*\] "GET (\S+) HTTP[^"]*" (\d{3})/;
const DMG_RE = /\/(LingCode-v[^?#/\s]+\.dmg)/;

function readLog(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const buf = fs.readFileSync(filePath);
  if (filePath.endsWith('.gz')) {
    try { return zlib.gunzipSync(buf).toString('utf8'); }
    catch (e) { console.error(`gunzip failed for ${filePath}: ${e.message}`); return ''; }
  }
  return buf.toString('utf8');
}

function parseLine(line) {
  const m = line.match(LINE_RE);
  if (!m) return null;
  const fileMatch = m[5].match(DMG_RE);
  if (!fileMatch) return null;
  return {
    ip: m[1],
    day: `${m[4]}-${MONTHS[m[3]] || '00'}-${m[2]}`,
    filename: fileMatch[1],
    status: parseInt(m[6], 10),
  };
}

function aggregate() {
  const stats = Object.create(null);
  let logFiles;
  try {
    logFiles = fs.readdirSync(NGINX_LOG_DIR).filter((n) => n.startsWith('access.log'));
  } catch (e) {
    console.error(`cannot read ${NGINX_LOG_DIR}: ${e.message}`);
    process.exit(1);
  }

  let lineCount = 0;
  for (const name of logFiles) {
    const text = readLog(path.join(NGINX_LOG_DIR, name));
    for (const line of text.split('\n')) {
      if (!line || line.indexOf('Installer.dmg') === -1) continue;
      lineCount++;
      const r = parseLine(line);
      if (!r) continue;
      const key = `${r.day}|${r.filename}`;
      let s = stats[key];
      if (!s) {
        s = stats[key] = {
          day: r.day, filename: r.filename,
          count_200: 0, count_206: 0, ips: new Set(),
        };
      }
      if (r.status === 200) { s.count_200++; s.ips.add(r.ip); }
      else if (r.status === 206) { s.count_206++; s.ips.add(r.ip); }
    }
  }
  return { rows: Object.values(stats), scannedLines: lineCount, fileCount: logFiles.length };
}

function main() {
  const { rows, scannedLines, fileCount } = aggregate();
  if (rows.length === 0) {
    console.log(`scanned ${fileCount} log files / ${scannedLines} candidate lines — no DMG downloads found`);
    return;
  }
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  const stmt = db.prepare(`
    INSERT INTO download_stats (day, filename, count_200, count_206, unique_ips)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(day, filename) DO UPDATE SET
      count_200 = excluded.count_200,
      count_206 = excluded.count_206,
      unique_ips = excluded.unique_ips
  `);
  const tx = db.transaction((rs) => {
    for (const r of rs) stmt.run(r.day, r.filename, r.count_200, r.count_206, r.ips.size);
  });
  tx(rows);
  db.close();
  console.log(`aggregated ${rows.length} (day, filename) rows from ${fileCount} log files into ${DB_PATH}`);
}

main();
