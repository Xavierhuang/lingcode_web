#!/usr/bin/env bash
# bootstrap-monitoring.sh — run on the MONITORING host (a small VM in the VPC,
# or the API box). Renders Prometheus/Alertmanager configs from .env and brings
# up Prometheus + Alertmanager + Grafana. Re-run after editing targets/secrets.
#
# Requires ../.env (cloud-infra/.env on this host) with:
#   DATA_PLANE_IP   private IP of the data-plane VM (exporters)
#   API_IP          private host the API /metrics is reachable at (nginx vhost)
#   ALERT_WEBHOOK   Slack/Discord incoming webhook (reused from the cron alerts)
#   METRICS_TOKEN   must equal METRICS_TOKEN in the API box .env
#   GRAFANA_ADMIN_PASSWORD, BIND_ADDR
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"   # -> cloud-infra/observability/
# shellcheck disable=SC1091
[ -f ../.env ] && { set -a; . ../.env; set +a; }
COMPOSE="docker compose"; docker compose version >/dev/null 2>&1 || COMPOSE="docker-compose"

: "${DATA_PLANE_IP:?set DATA_PLANE_IP in ../.env (data-plane VM private IP)}"
: "${API_IP:?set API_IP in ../.env (API box private host for /metrics)}"
: "${ALERT_WEBHOOK:?set ALERT_WEBHOOK in ../.env}"
: "${METRICS_TOKEN:?set METRICS_TOKEN in ../.env (must match the API box)}"

# Render Prometheus targets + Alertmanager webhook (| delimiter — URLs have /).
sed -e "s/__DATA_PLANE_IP__/${DATA_PLANE_IP}/g" -e "s/__API_IP__/${API_IP}/g" \
  prometheus.yml.example > prometheus.yml
sed -e "s|__ALERT_WEBHOOK__|${ALERT_WEBHOOK}|g" \
  alertmanager.yml.example > alertmanager.yml
# Bearer token for the API scrape (no trailing newline).
printf '%s' "${METRICS_TOKEN}" > metrics_token
chmod 600 prometheus.yml alertmanager.yml metrics_token

$COMPOSE -f docker-compose.monitoring.yml up -d

cat <<EOF

Monitoring stack up (private-bound). Reach the UIs via SSH tunnel only:
  ssh -L 3001:127.0.0.1:3001 -L 9090:127.0.0.1:9090 <this-host>
  Grafana     http://localhost:3001  (admin / GRAFANA_ADMIN_PASSWORD)
  Prometheus  http://localhost:9090/targets  (all jobs should be UP)
Then verify an alert fires to ALERT_WEBHOOK (e.g. stop the standby).
EOF
