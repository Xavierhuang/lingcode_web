#!/usr/bin/env bash
# disk-alert.sh — warn when the cloud-Postgres host disk crosses a threshold.
# Disk-pressure corruption (2026-05-25) is the failure mode this guards against:
# catch it at 85% instead of discovering it at 100%.
#
# Always appends a sample to disk.log. On breach it also logs an ALERT line and,
# if ALERT_WEBHOOK is set (a Slack/Discord-style incoming webhook URL), POSTs a
# message. Exits non-zero on breach so cron surfaces it too.
#
# Env: DISK_ALERT_THRESHOLD (default 85), BACKUP_DIR, ALERT_WEBHOOK.
set -euo pipefail

THRESH="${DISK_ALERT_THRESHOLD:-85}"
DIR="${BACKUP_DIR:-/opt/lingcloud-backups}"
mkdir -p "$DIR"

USE="$(df --output=pcent / | tail -1 | tr -dc '0-9' || echo 0)"
TS="$(date -u +%FT%TZ)"
echo "$TS disk ${USE}%" >> "$DIR/disk.log"

if [ "${USE:-0}" -ge "$THRESH" ]; then
  MSG="LingCode Cloud (.228) disk at ${USE}% (>= ${THRESH}%) — free space or backups/writes will fail."
  echo "$TS ALERT $MSG" >> "$DIR/disk.log"
  if [ -n "${ALERT_WEBHOOK:-}" ]; then
    curl -fsS -m 10 -X POST -H 'content-type: application/json' \
      -d "{\"text\":\"$MSG\"}" "$ALERT_WEBHOOK" >/dev/null 2>&1 || true
  fi
  exit 1
fi
