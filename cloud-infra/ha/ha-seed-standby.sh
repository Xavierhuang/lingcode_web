#!/usr/bin/env bash
# ha-seed-standby.sh — run on the STANDBY VM to seed it from the pgBackRest repo
# and start it streaming from the primary. The standby is a self-contained
# {Postgres + PgBouncer} unit identical to the primary; what makes it a standby
# is the restored data dir (standby.signal + primary_conninfo).
#
# Prereqs on the standby VM:
#   - this repo rsync'd here (same layout as the primary), Docker installed
#   - .env present with the SAME PGBACKREST_CIPHER_PASS + Spaces creds as the
#     primary (so it can read the encrypted repo) and the SAME REPLICATION_PASSWORD
#   - pgbackrest/pgbackrest.conf rendered (run bootstrap-remote.sh once, or copy
#     the primary's). The repo + cipher pass MUST match the primary's.
#
# Usage (from cloud-infra/):
#   PRIMARY_IP=10.x.x.x sudo bash ha/ha-seed-standby.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."   # -> cloud-infra/
# shellcheck disable=SC1091
set -a; . ./.env; set +a

COMPOSE="docker compose"; docker compose version >/dev/null 2>&1 || COMPOSE="docker-compose"
FILES="-f docker-compose.yml -f docker-compose.prod.yml"
SLOT="${REPLICATION_SLOT:-standby1}"
: "${PRIMARY_IP:?set PRIMARY_IP to the primary private IP}"
: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD missing from .env (copy from the primary)}"

PRIMARY_CONNINFO="host=${PRIMARY_IP} port=5544 user=replicator password=${REPLICATION_PASSWORD} application_name=${SLOT}"

# 1) Build the image and let the entrypoint create + chown the pgdata volume
#    (a throwaway cluster). pgBackRest restore overwrites it next.
$COMPOSE $FILES build postgres
$COMPOSE $FILES up -d postgres
for _ in $(seq 1 30); do
  docker exec lingcloud-postgres pg_isready -U cloud_admin -d lingcloud >/dev/null 2>&1 && break; sleep 2
done
$COMPOSE $FILES stop postgres

# 2) Restore the repo into the (now postgres-owned) data volume as a STANDBY.
#    pgBackRest writes standby.signal + the recovery options below into the data
#    dir, so Postgres comes up in recovery and streams from the primary. --delta
#    overwrites the throwaway cluster. archive_mode=on is harmless on a standby
#    (Postgres only archives while it is the primary).
$COMPOSE $FILES run --rm --no-deps --entrypoint pgbackrest postgres \
  --stanza=lingcloud --pg1-path=/var/lib/postgresql/data --type=standby --delta \
  --recovery-option="primary_conninfo=${PRIMARY_CONNINFO}" \
  --recovery-option="primary_slot_name=${SLOT}" \
  restore

# 3) Start the standby stack (Postgres streaming + its local PgBouncer).
$COMPOSE $FILES up -d
for _ in $(seq 1 30); do
  docker exec lingcloud-postgres pg_isready -U cloud_admin -d lingcloud >/dev/null 2>&1 && break; sleep 2
done

echo "Standby started. Verify on the PRIMARY:"
echo "  docker exec lingcloud-postgres psql -U cloud_admin -d lingcloud -xc 'SELECT * FROM pg_stat_replication;'"
echo "or run  bash ha/ha-status.sh  on either node."
