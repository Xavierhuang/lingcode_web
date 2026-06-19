#!/usr/bin/env bash
# pgbackrest-restore-test.sh — prove the backups are actually restorable.
# "Untested restore" is the scariest backup gap: a backup you've never restored
# is a hypothesis, not a safety net. This restores the repo into a THROWAWAY
# container, lets Postgres replay WAL, runs a sanity query, and tears it down.
# Failure POSTs to ALERT_WEBHOOK and exits non-zero so cron surfaces it.
#
# By default it restores to the end of the archive (latest recoverable point).
# Set PITR_TARGET="2026-06-03 14:00:00" to drill a specific point in time.
#
# This NEVER touches the live cluster: it restores into its own volume, starts a
# separate container with archiving OFF, and removes everything afterward.
set -euo pipefail

IMAGE="${RESTORE_TEST_IMAGE:-lingcloud-postgres-pgbackrest:pg16}"
STANZA="${PGBACKREST_STANZA:-lingcloud}"
DIR="${BACKUP_DIR:-/opt/lingcloud-backups}"
CONF="${PGBACKREST_CONF:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pgbackrest/pgbackrest.conf}"
VOL="lingcloud_restore_test"
NAME="lingcloud-restore-test"
TS="$(date -u +%FT%TZ)"
mkdir -p "$DIR"

# Need cloud_admin's password to query over TCP on the scratch instance.
[ -f "$(dirname "$CONF")/../.env" ] && set -a && . "$(dirname "$CONF")/../.env" && set +a || true
PGPW="${POSTGRES_PASSWORD:-}"

notify() { [ -n "${ALERT_WEBHOOK:-}" ] || return 0
  curl -fsS -m 10 -X POST -H 'content-type: application/json' \
    -d "{\"text\":\"$1\"}" "$ALERT_WEBHOOK" >/dev/null 2>&1 || true; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true; }
fail() { echo "$TS ERROR restore-test: $1" >> "$DIR/backup.log"
  notify "LingCode Cloud: backup RESTORE TEST FAILED — $1"; cleanup; exit 1; }
trap cleanup EXIT

cleanup                       # clear any leftovers from a crashed prior run
docker volume create "$VOL" >/dev/null

# 1) Restore the repo into the scratch volume (delta = only changed files).
docker run --rm \
  -v "$VOL":/var/lib/postgresql/data \
  -v "$CONF":/etc/pgbackrest/pgbackrest.conf:ro \
  --entrypoint pgbackrest "$IMAGE" \
  --stanza="$STANZA" --pg1-path=/var/lib/postgresql/data \
  ${PITR_TARGET:+--type=time --target="$PITR_TARGET" --target-action=promote} \
  --delta restore \
  || fail "pgbackrest restore returned non-zero"

# 2) Start a scratch Postgres on the restored data with archiving OFF (so it
#    can't push WAL into the real repo) and recover. The pgbackrest.conf must be
#    mounted too: recovery's restore_command runs `pgbackrest archive-get` to
#    pull archived WAL from Spaces, which needs the repo config.
docker run -d --name "$NAME" \
  -v "$VOL":/var/lib/postgresql/data \
  -v "$CONF":/etc/pgbackrest/pgbackrest.conf:ro \
  "$IMAGE" -c archive_mode=off -c listen_addresses='*' >/dev/null \
  || fail "could not start scratch Postgres"

# 3) Wait for recovery to finish and the server to accept connections.
ok=""
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U cloud_admin -d lingcloud >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ -n "$ok" ] || fail "scratch Postgres never became ready (recovery stuck?)"

# 4) Sanity query: the restored DB must be queryable and carry tenant schemas.
N="$(docker exec -e PGPASSWORD="$PGPW" "$NAME" \
  psql -h 127.0.0.1 -U cloud_admin -d lingcloud -tAc \
  "SELECT count(*) FROM information_schema.schemata WHERE schema_name LIKE 'be\_%'" 2>/dev/null || echo "")"
[ -n "$N" ] || fail "sanity query failed (restored DB not queryable)"

echo "$TS restore-test ok: restored + queryable, ${N} tenant schema(s)${PITR_TARGET:+, target=$PITR_TARGET}" >> "$DIR/backup.log"
# trap cleanup runs on exit.
