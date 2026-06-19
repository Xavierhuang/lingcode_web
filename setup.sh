#!/usr/bin/env bash
# Local setup and checks for the lingcode.dev static site.
# Production upload uses deploy.sh (same directory) — same host, user, and remote path.
#
# Run from repo root:  ./website/setup.sh
# Run from website/:   ./setup.sh
#
# Local preview:       ./website/setup.sh serve
# Custom port:          LINGCODE_PORT=9000 ./website/setup.sh serve
# Upload (wraps):      ./website/setup.sh deploy
#
# Requires: python3 (for "serve"). No npm install — site is plain HTML/CSS/JS.
#
# Deploy env (see also deploy.sh):
#   LINGCODE_DEPLOY_HOST   default 45.55.39.39
#   LINGCODE_SSH_USER      default root
# Remote path is fixed in deploy.sh: /var/www/html

set -e

# Keep in sync with website/deploy.sh
HOST="${LINGCODE_DEPLOY_HOST:-45.55.39.39}"
USER="${LINGCODE_SSH_USER:-root}"
REMOTE_PATH="/var/www/html"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPT="$SCRIPT_DIR/deploy.sh"

cd "$SCRIPT_DIR"

PORT="${LINGCODE_PORT:-8000}"

required_files=(
  "index.html"
  "signin.html"
  "style.css"
  "nav.js"
  "robots.txt"
  "sitemap.xml"
)

check_files() {
  local missing=0
  for f in "${required_files[@]}"; do
    if [ ! -f "$f" ]; then
      echo "Missing: $f"
      missing=1
    fi
  done
  if [ "$missing" -ne 0 ]; then
    echo "Some expected files are missing. Run this script from the website/ directory."
    exit 1
  fi
  echo "OK: core files present (${#required_files[@]} checked)."
}

check_python() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 not found. Install Python 3 to use the serve command."
    exit 1
  fi
  echo "OK: python3 ($(command -v python3))"
}

serve_site() {
  check_python
  echo "Serving $SCRIPT_DIR at http://127.0.0.1:$PORT (Ctrl+C to stop)"
  python3 -m http.server "$PORT"
}

run_deploy() {
  if [ ! -f "$DEPLOY_SCRIPT" ]; then
    echo "Cannot find deploy.sh at $DEPLOY_SCRIPT"
    exit 1
  fi
  check_files
  echo "Running deploy.sh (scp to $USER@$HOST:$REMOTE_PATH)..."
  bash "$DEPLOY_SCRIPT"
}

print_summary() {
  echo ""
  echo "LingCode website — static files in: $SCRIPT_DIR"
  echo "  Preview:       ./setup.sh serve"
  echo "  Deploy:        ./setup.sh deploy   (runs ./deploy.sh)"
  echo "  Deploy target: $USER@$HOST:$REMOTE_PATH (override host/user with LINGCODE_DEPLOY_HOST / LINGCODE_SSH_USER)"
  echo ""
}

case "${1:-}" in
  serve|--serve|-s)
    check_files
    serve_site
    ;;
  deploy|-d)
    run_deploy
    ;;
  help|-h|--help)
    echo "Usage: $0 [serve|deploy|help]"
    echo "  (no args)  Check files and python3; print hints (matches deploy.sh env for host/user)"
    echo "  serve      Start python3 -m http.server on LINGCODE_PORT (default $PORT)"
    echo "  deploy     Run deploy.sh in this directory (scp website/* to server)"
    ;;
  "")
    check_files
    check_python
    print_summary
    ;;
  *)
    echo "Unknown option: $1"
    echo "Run: $0 help"
    exit 1
    ;;
esac
