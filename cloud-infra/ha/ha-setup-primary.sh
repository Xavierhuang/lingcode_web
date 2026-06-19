#!/usr/bin/env bash
# ha-setup-primary.sh — run ONCE on the PRIMARY data-plane VM to make it ready
# for a streaming standby. Creates the replication role + a physical replication
# slot and authorizes the standby's private IP in pg_hba. Idempotent.
#
# Usage (from cloud-infra/):
#   STANDBY_IP=10.x.x.x sudo bash ha/ha-setup-primary.sh
#
# Prereqs already in place from the PITR work: wal_level=replica,
# max_wal_senders=3, and max_slot_wal_keep_size (so an unconsumed slot can't
# fill the disk) — applied via docker-compose.prod.yml -c flags (values
# documented in postgres-conf.d/10-archive.conf).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."   # -> cloud-infra/
# shellcheck disable=SC1091
set -a; . ./.env; set +a

CONTAINER="${CLOUD_PG_CONTAINER:-lingcloud-postgres}"
SLOT="${REPLICATION_SLOT:-standby1}"
: "${STANDBY_IP:?set STANDBY_IP to the standby private IP, e.g. STANDBY_IP=10.108.0.3}"
: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD missing from .env}"

psql() { docker exec -i "$CONTAINER" psql -U cloud_admin -d lingcloud "$@"; }

# 1) Replication role (create or update password). REPLICATION + LOGIN only.
psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='replicator') THEN
    ALTER ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPLICATION_PASSWORD}';
  ELSE
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPLICATION_PASSWORD}';
  END IF;
END \$\$;
SQL

# 2) Physical replication slot (so the primary retains WAL until the standby
#    consumes it). Bounded by max_slot_wal_keep_size.
psql -tAc \
  "SELECT pg_create_physical_replication_slot('${SLOT}') \
   WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name='${SLOT}')" \
  >/dev/null || true

# 3) Authorize the standby for replication (idempotent append) + reload.
HBA="host replication replicator ${STANDBY_IP}/32 scram-sha-256"
docker exec "$CONTAINER" bash -lc \
  "grep -qF 'replicator ${STANDBY_IP}/32' \"\$PGDATA/pg_hba.conf\" || echo '${HBA}' >> \"\$PGDATA/pg_hba.conf\""
psql -c "SELECT pg_reload_conf();" >/dev/null

echo "Primary ready: role 'replicator', slot '${SLOT}', replication allowed from ${STANDBY_IP}."
echo "Next: on the standby VM run  PRIMARY_IP=<this VM private IP> sudo bash ha/ha-seed-standby.sh"
