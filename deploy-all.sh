#!/usr/bin/env bash
# Deploy static site (/var/www/html) and Node API (/opt/lingcode-api), then restart lingcode-api.
#
# Usage: from repo:   ./website/deploy-all.sh
#                    LINGCODE_SSH_USER=root ./website/deploy-all.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/deploy.sh"
"$SCRIPT_DIR/server/deploy-api.sh"

echo ""
echo "All done: https://lingcode.dev"
