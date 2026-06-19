#!/usr/bin/env bash
# ha-promote.sh — FAILOVER. Run on the STANDBY to promote it to primary, then
# repoint the API at it. Use when the primary is lost (or for a planned switch).
#
# Usage (from cloud-infra/ on the standby):
#   sudo bash ha/ha-promote.sh
#
# AFTER promotion you MUST do two things (printed again at the end):
#   1) Repoint the API: remap the DigitalOcean reserved IP to THIS VM (so the
#      API's CLOUD_PG_ADMIN_URL :6432 / CLOUD_PG_DIRECT_URL :5544 reach the new
#      primary's PgBouncer/Postgres with no app change). If you don't use a
#      reserved IP, change CLOUD_PG_* on the API box to this VM and restart it.
#   2) FENCE the old primary: make sure it can never come back as a second
#      primary writing to the same Spaces stanza (split-brain + backup
#      corruption). Power it off / firewall it until you rebuild it as a standby.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
CONTAINER="${CLOUD_PG_CONTAINER:-lingcloud-postgres}"

INREC="$(docker exec "$CONTAINER" psql -U cloud_admin -d lingcloud -tAc 'SELECT pg_is_in_recovery()' | tr -d '[:space:]')"
if [ "$INREC" != "t" ]; then
  echo "This node is NOT in recovery (pg_is_in_recovery=${INREC:-?}) — it is already a primary. Aborting."
  exit 1
fi

echo "Promoting standby to primary…"
docker exec "$CONTAINER" psql -U cloud_admin -d lingcloud -c "SELECT pg_promote(wait => true, wait_seconds => 60);"

# Confirm.
for _ in $(seq 1 30); do
  R="$(docker exec "$CONTAINER" psql -U cloud_admin -d lingcloud -tAc 'SELECT pg_is_in_recovery()' | tr -d '[:space:]')"
  [ "$R" = "f" ] && break; sleep 1
done
echo "Promote result: pg_is_in_recovery=$R (f = now primary)."

cat <<'EOF'

================== POST-PROMOTION CHECKLIST ==================
1) Repoint the API to this VM:
   - reserved-IP setup:  remap the DigitalOcean reserved IP to THIS VM
       doctl compute reserved-ip-action assign <RESERVED_IP> <THIS_DROPLET_ID>
     (no API change — CLOUD_PG_* already point at the reserved IP)
   - no reserved IP:     set CLOUD_PG_ADMIN_URL (:6432) + CLOUD_PG_DIRECT_URL
       (:5544) on the API box to THIS VM's private IP, then
       systemctl restart lingcode-api
2) FENCE the old primary (power off / firewall) so it can't write to the same
   pgBackRest stanza. Rebuild it later as a standby of this new primary.
3) This node now archives WAL to Spaces on the new timeline — verify:
       docker exec lingcloud-postgres pgbackrest --stanza=lingcloud check
=============================================================
EOF
