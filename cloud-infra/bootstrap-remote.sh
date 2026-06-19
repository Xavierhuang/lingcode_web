#!/usr/bin/env bash
# bootstrap-remote.sh — run ON the data-plane VM to stand up LingCode Cloud's
# Postgres, the PgBouncer pooler, and pgBackRest PITR in one shot. Installs
# Docker if missing, generates secrets, binds Postgres+PgBouncer to the private
# network only, brings up the hardened stack, initializes the backup repo, wires
# the backup/restore-test cron, and prints the lines to paste into the API box's
# /opt/lingcode-api/.env.
#
# Usage (on the VM, from this cloud-infra/ dir):
#   sudo bash bootstrap-remote.sh
#
# pgBackRest PITR is OFF-HOST to DigitalOcean Spaces. To enable it, put the
# Spaces credentials in .env BEFORE running (or re-run after adding them):
#   SPACES_KEY=...    SPACES_SECRET=...
# Without them the stack still runs; backups stay local-only (pg_dump) and the
# script prints how to finish PITR setup.
#
# Idempotent-ish: re-running reuses .env (stable secrets) and re-ups the stack.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
HERE="$(pwd)"

COMPOSE_FILES="-f docker-compose.yml -f docker-compose.prod.yml"

# 1) Docker
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi
COMPOSE="docker compose"; docker compose version >/dev/null 2>&1 || COMPOSE="docker-compose"

# 2) Private IP (DigitalOcean: eth1 / 10.x).
PRIV_IP="$(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 \
  | grep -E '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' | head -1 || true)"
if [ -z "${PRIV_IP:-}" ]; then
  echo "WARNING: no private IP detected; binding to 127.0.0.1 (API box won't reach it)."
  PRIV_IP="127.0.0.1"
fi

# 3) Secrets (.env), generated once and reused. PGBACKREST_CIPHER_PASS encrypts
#    the backup repo — losing it means losing the ability to restore.
if [ ! -f .env ]; then
  echo "Generating .env (passwords + secrets)…"
  cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
CLOUD_JWT_SECRET=$(openssl rand -hex 32)
PGBACKREST_CIPHER_PASS=$(openssl rand -hex 32)
REPLICATION_PASSWORD=$(openssl rand -hex 24)
MONITORING_PASSWORD=$(openssl rand -hex 24)
BIND_ADDR=$PRIV_IP
# pgBackRest off-host repo on DigitalOcean Spaces — fill these in to enable PITR:
SPACES_KEY=
SPACES_SECRET=
# Optional: Slack/Discord webhook for backup + disk alerts.
ALERT_WEBHOOK=
EOF
  chmod 600 .env
fi
# shellcheck disable=SC1091
set -a; . ./.env; set +a
sed -i "s/^BIND_ADDR=.*/BIND_ADDR=$PRIV_IP/" .env || true

# 4) Render pgbackrest.conf from the template if Spaces creds are present.
PITR_READY=""
if [ -n "${SPACES_KEY:-}" ] && [ -n "${SPACES_SECRET:-}" ]; then
  echo "Rendering pgbackrest/pgbackrest.conf (Spaces repo, encrypted)…"
  sed -e "s|REPLACE_WITH_SPACES_KEY|${SPACES_KEY}|" \
      -e "s|REPLACE_WITH_SPACES_SECRET|${SPACES_SECRET}|" \
      -e "s|REPLACE_WITH_OPENSSL_RAND_HEX_32|${PGBACKREST_CIPHER_PASS}|" \
      pgbackrest/pgbackrest.conf.example > pgbackrest/pgbackrest.conf
  chmod 600 pgbackrest/pgbackrest.conf
  PITR_READY=1
else
  # docker-compose.prod.yml bind-mounts pgbackrest.conf; create a harmless
  # placeholder so the mount target exists (archive_command will no-op-fail and
  # WAL accumulates only until creds are added — fine for a short window).
  [ -f pgbackrest/pgbackrest.conf ] || cp pgbackrest/pgbackrest.conf.example pgbackrest/pgbackrest.conf
  echo "NOTE: SPACES_KEY/SPACES_SECRET not set — PITR repo NOT configured yet."
fi

# 5) Bring up Postgres FIRST (so we can read its SCRAM verifier for PgBouncer).
echo "Starting Postgres…"
$COMPOSE $COMPOSE_FILES up -d postgres
for _ in $(seq 1 30); do
  docker exec lingcloud-postgres pg_isready -U cloud_admin -d lingcloud >/dev/null 2>&1 && break
  sleep 2
done

# 6) Generate PgBouncer userlist.txt from cloud_admin's stored SCRAM verifier
#    (never writes the plaintext password into the pooler config).
echo "Generating pgbouncer/userlist.txt…"
docker exec lingcloud-postgres psql -U cloud_admin -d lingcloud -tAc \
  "SELECT '\"'||rolname||'\" \"'||rolpassword||'\"' FROM pg_authid WHERE rolname='cloud_admin'" \
  > pgbouncer/userlist.txt
chmod 600 pgbouncer/userlist.txt

# 7) Initialize the pgBackRest repo + enable archiving (recreates Postgres with
#    archive_mode=on and starts PgBouncer).
if [ -n "$PITR_READY" ]; then
  echo "Initializing pgBackRest stanza…"
  docker exec lingcloud-postgres pgbackrest --stanza=lingcloud stanza-create || true
fi
echo "Bringing up the full hardened stack (PgBouncer + archiving)…"
$COMPOSE $COMPOSE_FILES up -d
for _ in $(seq 1 30); do
  docker exec lingcloud-postgres pg_isready -U cloud_admin -d lingcloud >/dev/null 2>&1 && break
  sleep 2
done
if [ -n "$PITR_READY" ]; then
  docker exec lingcloud-postgres pgbackrest --stanza=lingcloud check \
    && docker exec lingcloud-postgres pgbackrest --stanza=lingcloud --type=full backup \
    || echo "WARNING: pgBackRest check/backup failed — inspect 'docker exec lingcloud-postgres pgbackrest --stanza=lingcloud check'."
fi

# 7b) Observability DB setup: pg_stat_statements (preloaded via the prod overlay's
#     20-observability.conf) + the least-privilege 'monitoring' role for
#     postgres_exporter. The exporters themselves come up with the prod overlay.
echo "Setting up observability (pg_stat_statements + monitoring role)…"
bash observability/obs-setup-db.sh || echo "WARNING: obs-setup-db failed — re-run after confirming the restart loaded shared_preload_libraries."

# 8) Install cron: pgBackRest base backups + weekly restore drill + disk alert,
#    and keep the logical pg_dump export as a portable fallback. Idempotent
#    (drops a managed crontab fragment).
echo "Installing backup/restore cron…"
CRON_TMP="$(mktemp)"
crontab -l 2>/dev/null | grep -vF '# lingcloud-cron' > "$CRON_TMP" || true
cat >> "$CRON_TMP" <<EOF
17 3 * * *   cd $HERE && set -a; . ./.env; set +a; ./pgbackrest-backup.sh        # lingcloud-cron base (full Sun/diff else) -> Spaces
30 4 * * *   cd $HERE && set -a; . ./.env; set +a; ./backup-cloud-pg.sh          # lingcloud-cron logical pg_dump export (fallback)
0 5 * * 0    cd $HERE && set -a; . ./.env; set +a; ./pgbackrest-restore-test.sh  # lingcloud-cron weekly restore drill
*/30 * * * * cd $HERE && set -a; . ./.env; set +a; ./disk-alert.sh               # lingcloud-cron disk alert
EOF
crontab "$CRON_TMP"; rm -f "$CRON_TMP"
chmod +x ./pgbackrest-backup.sh ./pgbackrest-restore-test.sh ./backup-cloud-pg.sh ./disk-alert.sh 2>/dev/null || true

cat <<EOF

================================================================
LingCode Cloud data plane is UP on $PRIV_IP
  Postgres   $PRIV_IP:5544   (direct — admin/backup only)
  PgBouncer  $PRIV_IP:6432   (the API connects HERE)

Add these to the API box  /opt/lingcode-api/.env  then restart it
(systemctl restart lingcode-api):

CLOUD_PG_ADMIN_URL=postgres://cloud_admin:${POSTGRES_PASSWORD}@${PRIV_IP}:6432/lingcloud
CLOUD_PG_DIRECT_URL=postgres://cloud_admin:${POSTGRES_PASSWORD}@${PRIV_IP}:5544/lingcloud
CLOUD_JWT_SECRET=${CLOUD_JWT_SECRET}
CLOUD_AI_TOOLS=1

# CLOUD_PG_DIRECT_URL bypasses PgBouncer (:5544 direct) for the realtime
# LISTEN connection — transaction pooling breaks LISTEN, so this is required for
# cross-process realtime. Everything else uses the pooled :6432 URL above.

PITR: $( [ -n "$PITR_READY" ] && echo "ENABLED — backups encrypted to Spaces; weekly restore drill scheduled." || echo "NOT yet configured — set SPACES_KEY/SPACES_SECRET in $HERE/.env and re-run this script." )

SECURITY: allow inbound 5544 AND 6432 ONLY from the API droplet's private IP
(DigitalOcean Firewall). Both are bound to $PRIV_IP, not 0.0.0.0.
================================================================
EOF
