#!/usr/bin/env bash
# backup-cloud-pg.sh — daily backup of the LingCode Cloud Postgres.
#
# The cloud data plane stores every tenant backend as a schema `be_<id>` owned
# by a NOLOGIN role `trole_<id>`. A plain `pg_dump <db>` captures schemas +
# tables but NOT the roles — so we ALSO dump globals (roles) or a restore lands
# tables with no owner roles to grant to. We keep both:
#   globals-<stamp>.sql.gz   roles + grants (pg_dumpall --globals-only)
#   lingcloud-<stamp>.dump   full DB, compressed custom format (pg_restore-able)
#
# Env overrides: CLOUD_PG_CONTAINER, CLOUD_PG_DB, CLOUD_PG_USER, BACKUP_DIR,
#                BACKUP_KEEP_DAYS.
#
# Restore (disaster recovery) on a fresh container:
#   gunzip -c globals-<stamp>.sql.gz | docker exec -i <c> psql -U cloud_admin -d postgres
#   docker exec -i <c> pg_restore -U cloud_admin -d lingcloud --clean --if-exists < lingcloud-<stamp>.dump
set -euo pipefail

CONTAINER="${CLOUD_PG_CONTAINER:-lingcloud-postgres}"
DB="${CLOUD_PG_DB:-lingcloud}"
PGUSER="${CLOUD_PG_USER:-cloud_admin}"
DIR="${BACKUP_DIR:-/opt/lingcloud-backups}"
KEEP="${BACKUP_KEEP_DAYS:-7}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

mkdir -p "$DIR"

# Refuse to fill the disk: bail if the host is already very full (a half-written
# dump on a full disk is how the control-plane DB got corrupted on 2026-05-25).
USE="$(df --output=pcent "$DIR" | tail -1 | tr -dc '0-9' || echo 0)"
if [ "${USE:-0}" -ge 92 ]; then
  echo "$(date -u +%FT%TZ) SKIP backup: disk ${USE}% — too full to dump safely" >> "$DIR/backup.log"
  exit 1
fi

# Roles/globals first (small).
docker exec "$CONTAINER" pg_dumpall -U "$PGUSER" --globals-only \
  | gzip > "$DIR/globals-$STAMP.sql.gz.partial"
mv "$DIR/globals-$STAMP.sql.gz.partial" "$DIR/globals-$STAMP.sql.gz"

# Full database in compressed custom format. Write to .partial then rename so a
# crashed run never leaves a truncated file that looks like a valid backup.
docker exec "$CONTAINER" pg_dump -U "$PGUSER" -Fc "$DB" > "$DIR/lingcloud-$STAMP.dump.partial"
mv "$DIR/lingcloud-$STAMP.dump.partial" "$DIR/lingcloud-$STAMP.dump"

# Rotate: keep BACKUP_KEEP_DAYS of each.
find "$DIR" -name 'globals-*.sql.gz' -mtime +"$KEEP" -delete 2>/dev/null || true
find "$DIR" -name 'lingcloud-*.dump' -mtime +"$KEEP" -delete 2>/dev/null || true
find "$DIR" -name '*.partial' -mtime +1 -delete 2>/dev/null || true

SIZE="$(du -h "$DIR/lingcloud-$STAMP.dump" | cut -f1)"
echo "$(date -u +%FT%TZ) backup ok: lingcloud-$STAMP.dump ($SIZE), disk ${USE}%" >> "$DIR/backup.log"
