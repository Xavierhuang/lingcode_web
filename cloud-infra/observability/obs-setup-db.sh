#!/usr/bin/env bash
# obs-setup-db.sh — run on the DATA-PLANE VM AFTER the Postgres restart that
# loads 20-observability.conf (shared_preload_libraries=pg_stat_statements).
# Creates the pg_stat_statements extension and a least-privilege `monitoring`
# role (pg_monitor) for postgres_exporter. Idempotent. Mirrors ha-setup-primary.sh.
#
# Usage (from cloud-infra/):  sudo bash observability/obs-setup-db.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."   # -> cloud-infra/
# shellcheck disable=SC1091
set -a; . ./.env; set +a

CONTAINER="${CLOUD_PG_CONTAINER:-lingcloud-postgres}"
: "${MONITORING_PASSWORD:?MONITORING_PASSWORD missing from .env}"

psql() { docker exec -i "$CONTAINER" psql -U cloud_admin -d lingcloud "$@"; }

# Extension (requires the preload + restart to already be in effect).
psql -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"

# Least-privilege monitoring role: LOGIN + pg_monitor (built-in role granting
# read of pg_stat_replication, pg_stat_*, slot status). NO data access.
psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='monitoring') THEN
    ALTER ROLE monitoring WITH LOGIN PASSWORD '${MONITORING_PASSWORD}';
  ELSE
    CREATE ROLE monitoring WITH LOGIN PASSWORD '${MONITORING_PASSWORD}';
  END IF;
END \$\$;
GRANT pg_monitor TO monitoring;
SQL

echo "Observability DB setup done: pg_stat_statements + 'monitoring' role (pg_monitor)."
echo "Verify: docker exec ${CONTAINER} psql -U cloud_admin -d lingcloud -c 'SELECT count(*) FROM pg_stat_statements;'"
