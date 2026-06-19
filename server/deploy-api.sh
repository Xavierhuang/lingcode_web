#!/usr/bin/env bash
# From your Mac: upload API to the droplet, npm install --production (if npm exists),
# then restart lingcode-api when the systemd unit is present.
#
# Usage: cd website/server && ./deploy-api.sh
#        LINGCODE_SSH_USER=root ./deploy-api.sh
#
# Fresh droplet: after first upload, SSH in and run:
#   sudo bash /opt/lingcode-api/remote-bootstrap.sh

set -e

HOST="${LINGCODE_DEPLOY_HOST:-45.55.39.39}"
USER="${LINGCODE_SSH_USER:-root}"
REMOTE_DIR="/opt/lingcode-api"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Uploading $SCRIPT_DIR -> $USER@$HOST:$REMOTE_DIR"
echo "(skips .env and data.db so server secrets and DB stay on the droplet)"
rsync -avz \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='data.db' \
  --exclude='data.db-wal' \
  --exclude='data.db-shm' \
  --exclude='data.db.bak.*' \
  --exclude='test' \
  --exclude='*.test.js' \
  --exclude='.DS_Store' \
  -e ssh "$SCRIPT_DIR/" "$USER@$HOST:$REMOTE_DIR/"

# Snapshot data.db before any restart so a bad migration / shipped bug can
# be rolled back. Stored alongside the live DB in $REMOTE_DIR. We keep the
# 5 most recent backups; older ones are pruned. Use `sqlite3 .backup` (atomic,
# checkpoint-consistent) — NOT a raw `cp`, which copies a live WAL-mode DB and
# can capture torn pages. (2026-05-25: data.db was found corrupted; disk on the
# droplet is tight, so a half-written cp here is a real risk.)
echo "Backing up data.db (keeps last 5 backups)..."
ssh "$USER@$HOST" "
  set -e
  if [ -f $REMOTE_DIR/data.db ]; then
    ts=\$(date +%s)
    sqlite3 $REMOTE_DIR/data.db \".backup '$REMOTE_DIR/data.db.bak.\$ts'\"
    ls -1t $REMOTE_DIR/data.db.bak.* 2>/dev/null | tail -n +6 | xargs -r rm --
    echo \"  -> $REMOTE_DIR/data.db.bak.\$ts\"
  else
    echo \"  (no data.db yet — first deploy)\"
  fi
" || echo "(backup step failed; continuing)"

# rsync from a Mac preserves the local UID (501) so the API directory ends up
# owned by 501:staff after upload. The systemd service runs as lingcode:lingcode,
# which then can't write the SQLite journal file in that directory. Chown back.
echo "Restoring lingcode:lingcode ownership..."
ssh "$USER@$HOST" "chown -R lingcode:lingcode $REMOTE_DIR" || true

if ssh "$USER@$HOST" "command -v npm >/dev/null 2>&1"; then
  echo "Running npm install --production on server..."
  ssh "$USER@$HOST" "cd $REMOTE_DIR && npm install --production"
else
  echo "Node/npm not installed on server yet (normal on a fresh droplet). Skipping npm."
fi

# Serverless functions need the Deno runtime (sandboxed execution). Without it,
# user functions return 503 and built-in templates still work — so this is a
# warning, not a failure. Install once with:
#   curl -fsSL https://deno.land/install.sh | sh   (then symlink to /usr/local/bin/deno)
if ssh "$USER@$HOST" "command -v deno >/dev/null 2>&1"; then
  echo "Deno present: $(ssh "$USER@$HOST" "deno --version | head -1")"
else
  echo "WARN: deno not installed on server — serverless USER functions are disabled (built-in templates still work)."
  echo "      Install: ssh $USER@$HOST 'curl -fsSL https://deno.land/install.sh | sh && ln -sf ~/.deno/bin/deno /usr/local/bin/deno'"
fi

echo ""
if ssh "$USER@$HOST" systemctl cat lingcode-api.service >/dev/null 2>&1; then
  # Rebuild the site-assistant index over the freshly-deployed site content, so
  # the "Ask LingCode" widget can cite new/changed pages. The droplet is 512MB —
  # building the ~22MB index WHILE the API runs OOM-kills it, so stop → build →
  # start (one cycle, brief downtime). Best-effort: a build hiccup keeps the
  # previous index and never blocks the deploy. (Reads the embeddings key from
  # app_config in data.db.) Set SKIP_SITE_INDEX=1 to skip.
  if [ "${SKIP_SITE_INDEX:-0}" != "1" ]; then
    echo "Stopping lingcode-api + rebuilding site assistant index (frees RAM)..."
    ssh "$USER@$HOST" "
      systemctl stop lingcode-api || true
      if [ -f $REMOTE_DIR/build-site-index.js ]; then
        node $REMOTE_DIR/build-site-index.js --site /var/www/html --out $REMOTE_DIR/site-index.json --db $REMOTE_DIR/data.db 2>&1 | tail -1 || echo '(index build failed — keeping previous index)'
        chown lingcode:lingcode $REMOTE_DIR/site-index.json 2>/dev/null || true
      fi
      systemctl start lingcode-api
      systemctl is-active lingcode-api
    "
  else
    echo "Restarting lingcode-api (SKIP_SITE_INDEX=1 — index not rebuilt)..."
    ssh "$USER@$HOST" "systemctl restart lingcode-api && systemctl is-active lingcode-api"
  fi
else
  echo "Note: lingcode-api.service not found. On the server, run once (bootstrap):"
  echo "  ssh $USER@$HOST"
  echo "  sudo bash $REMOTE_DIR/remote-bootstrap.sh"
  echo "If .env was missing, edit $REMOTE_DIR/.env then: sudo systemctl restart lingcode-api"
fi

echo ""
echo "Done. On server: curl -sf http://127.0.0.1:3000/api/health"
echo "Full stack: from website/server run ../deploy-all.sh (site + API)"
