#!/usr/bin/env bash
# pgbackrest-backup.sh — physical base backup via pgBackRest, into the encrypted
# off-host Spaces repo. This is the REAL recovery system; combined with the WAL
# stream archived by archive_command it gives point-in-time recovery.
#
# Backup type defaults by day-of-week: full on Sunday, differential otherwise.
# Override with: pgbackrest-backup.sh full | diff | incr
#
# Runs the pgbackrest binary INSIDE the Postgres container (where its config and
# the data dir live). Env overrides: CLOUD_PG_CONTAINER, BACKUP_DIR, ALERT_WEBHOOK.
set -euo pipefail

CONTAINER="${CLOUD_PG_CONTAINER:-lingcloud-postgres}"
STANZA="${PGBACKREST_STANZA:-lingcloud}"
DIR="${BACKUP_DIR:-/opt/lingcloud-backups}"   # local logs only; data goes to Spaces
mkdir -p "$DIR"

# Pick type: explicit arg wins; else full on Sunday (dow=0), diff otherwise.
TYPE="${1:-}"
if [ -z "$TYPE" ]; then
  if [ "$(date -u +%w)" = "0" ]; then TYPE="full"; else TYPE="diff"; fi
fi

TS="$(date -u +%FT%TZ)"
notify() {  # POST to ALERT_WEBHOOK if set; never fail the script on notify error.
  [ -n "${ALERT_WEBHOOK:-}" ] || return 0
  curl -fsS -m 10 -X POST -H 'content-type: application/json' \
    -d "{\"text\":\"$1\"}" "$ALERT_WEBHOOK" >/dev/null 2>&1 || true
}

if docker exec "$CONTAINER" pgbackrest --stanza="$STANZA" --type="$TYPE" backup; then
  echo "$TS pgbackrest $TYPE backup ok" >> "$DIR/backup.log"
else
  MSG="LingCode Cloud: pgBackRest $TYPE backup FAILED on $(hostname)."
  echo "$TS ERROR $MSG" >> "$DIR/backup.log"
  notify "$MSG"
  exit 1
fi

# Surface repo health (archive reachable + last backups present) on every run.
docker exec "$CONTAINER" pgbackrest --stanza="$STANZA" check \
  >> "$DIR/backup.log" 2>&1 || { notify "LingCode Cloud: pgBackRest CHECK failed."; exit 1; }
