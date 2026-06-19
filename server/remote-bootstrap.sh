#!/usr/bin/env bash
# Run ON THE DROPLET once, after deploy-api.sh (as root):
#   sudo bash /opt/lingcode-api/remote-bootstrap.sh
set -e
API_DIR="/opt/lingcode-api"
cd "$API_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js 20 (NodeSource)..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm missing after node install; apt-get install -y nodejs"
  exit 1
fi
node -v
npm -v

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created $API_DIR/.env — edit ADMIN_PASSWORD and SESSION_SECRET, then run again:"
  echo "  sudo bash $API_DIR/remote-bootstrap.sh"
  exit 0
fi

# better-sqlite3 may compile from source if no prebuild matches; needs a toolchain.
if ! dpkg -s build-essential >/dev/null 2>&1; then
  apt-get update
  apt-get install -y build-essential python3
fi

npm install --production

install -m644 "$API_DIR/lingcode-api.service" /etc/systemd/system/lingcode-api.service
systemctl daemon-reload
systemctl enable lingcode-api
systemctl restart lingcode-api
systemctl --no-pager status lingcode-api || true

install -m644 "$API_DIR/nginx-api-locations.conf" /etc/nginx/snippets/lingcode-api.conf
echo ""
echo "Add this line INSIDE the server { } block for lingcode.dev (e.g. /etc/nginx/sites-enabled/lingcode.dev):"
echo "  include /etc/nginx/snippets/lingcode-api.conf;"
echo "Then: sudo nginx -t && sudo systemctl reload nginx"
echo "Test: curl -sS -o /dev/null -w '%{http_code}' https://lingcode.dev/api/health"
