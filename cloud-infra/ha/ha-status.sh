#!/usr/bin/env bash
# ha-status.sh — show replication health. Detects whether this node is the
# primary or a standby and prints the relevant view + lag. Run on either node.
#
# Usage (from cloud-infra/):  bash ha/ha-status.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
CONTAINER="${CLOUD_PG_CONTAINER:-lingcloud-postgres}"
psql() { docker exec -i "$CONTAINER" psql -U cloud_admin -d lingcloud "$@"; }

INREC="$(psql -tAc 'SELECT pg_is_in_recovery()' | tr -d '[:space:]')"

if [ "$INREC" = "f" ]; then
  echo "ROLE: PRIMARY"
  echo "-- connected standbys (sent/replay lag) --"
  psql -xc "SELECT application_name, client_addr, state, sync_state,
              pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn)   AS send_lag_bytes,
              pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes
            FROM pg_stat_replication;"
  echo "-- replication slots --"
  psql -xc "SELECT slot_name, active, wal_status,
              pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
            FROM pg_replication_slots;"
else
  echo "ROLE: STANDBY (in recovery)"
  psql -xc "SELECT status, sender_host, sender_port, slot_name,
              pg_last_wal_receive_lsn() AS received,
              pg_last_wal_replay_lsn()  AS replayed,
              now() - pg_last_xact_replay_timestamp() AS replay_delay
            FROM pg_stat_wal_receiver;"
fi
