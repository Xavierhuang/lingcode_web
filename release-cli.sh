#!/usr/bin/env bash
# Point the lingcode.dev installers at an already-built CLI version.
#
#   ./release-cli.sh v0.9.0-rc14
#
# The heavy lifting (compiling the 12 targets, uploading the zips + cliv2-latest.json
# to GitHub Releases AND rsyncing them to /var/www/html) is done by the
# `lingcode-cli-release` GitHub Action. This script only flips the *pointers* so
# fresh installs and `lingcode upgrade` pick up that build:
#
#   1. Verifies the version's zips already exist on the server (fails loudly if not).
#   2. Bumps the 3 installer files (install-cli.sh, install-cli.ps1, cliv2-latest.json).
#   3. Deploys just those 3 files (no full-site rsync — won't clobber anything else).
#   4. Prunes superseded lingcode-*.zip on the droplet (the disk is small).
#   5. Verifies the live chain returns the new version + a 200 on the binary.
#
# All 3 installer files are served Cloudflare-DYNAMIC (uncached), so no purge is
# needed. Run from the website/ dir on a machine whose SSH key reaches the droplet.
#
# Env overrides (same as deploy.sh):
#   LINGCODE_DEPLOY_HOST   default 45.55.39.39
#   LINGCODE_SSH_USER      default root
#   LINGCODE_DEPLOY_KEY_FILE   optional: ssh -i <key> (e.g. ~/.ssh/lingcode-ci-deploy)
#   LINGCODE_GH_REPO      default Xavierhuang/lingcode_windows_cli
#   KEEP_OLD_ZIPS=1       skip step 4 (don't prune previous versions)

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 vX.Y.Z-rcN   (e.g. $0 v0.9.0-rc14)" >&2
  exit 1
fi
case "$VERSION" in v*) ;; *) VERSION="v$VERSION" ;; esac

HOST="${LINGCODE_DEPLOY_HOST:-45.55.39.39}"
USER="${LINGCODE_SSH_USER:-root}"
REMOTE="/var/www/html"
REPO="${LINGCODE_GH_REPO:-Xavierhuang/lingcode_windows_cli}"
SITE="https://lingcode.dev"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
if [ -n "${LINGCODE_DEPLOY_KEY_FILE:-}" ]; then
  SSH_OPTS="$SSH_OPTS -i $LINGCODE_DEPLOY_KEY_FILE -o IdentitiesOnly=yes"
fi
SSH="ssh $SSH_OPTS $USER@$HOST"

echo "▶ Pointing lingcode.dev installers at $VERSION"

# --- 1. The zips for this version must already be on the server. --------------
echo "  [1/5] checking $VERSION zips exist on $HOST:$REMOTE ..."
if ! $SSH "test -f '$REMOTE/lingcode-linux-x64-$VERSION.zip'"; then
  echo "✗ lingcode-linux-x64-$VERSION.zip not found on the server." >&2
  echo "  Build + deploy first: run the 'lingcode-cli-release' workflow for $VERSION" >&2
  echo "  (Actions tab, or: gh workflow run lingcode-cli-release.yml -f version=$VERSION)" >&2
  exit 1
fi

# --- 2. Bump the 3 installer files locally. -----------------------------------
echo "  [2/5] bumping local install-cli.sh / install-cli.ps1 / cliv2-latest.json ..."
# Replace the version token that follows each known anchor (handles any prior rcN).
sed -i.bak -E "s|(LINGCODE_TS_VERSION:-)v[0-9][^\"}]*|\1$VERSION|" install-cli.sh
sed -i.bak -E "s|(else \{ \")v[0-9][^\"]*|\1$VERSION|"            install-cli.ps1
# cliv2-latest.json: take the authoritative manifest the build produced (correct
# version + released_at) straight from the GitHub Release, so this stays the single
# source of truth and we never hand-edit the timestamp.
curl -fsSL "https://github.com/$REPO/releases/download/$VERSION/cliv2-latest.json" -o cliv2-latest.json
rm -f install-cli.sh.bak install-cli.ps1.bak

echo "      install-cli.sh : $(grep -m1 -o 'v[0-9][^"}]*' install-cli.sh)"
echo "      install-cli.ps1: $(grep -m1 -oE 'v[0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?' install-cli.ps1)"
echo "      cliv2-latest   : $(grep -m1 -o 'v[0-9][^"]*' cliv2-latest.json)"

# --- 3. Deploy ONLY those 3 files (no full-site rsync). -----------------------
echo "  [3/5] deploying the 3 installer files ..."
# shellcheck disable=SC2086
scp $SSH_OPTS install-cli.sh install-cli.ps1 cliv2-latest.json "$USER@$HOST:$REMOTE/"

# --- 4. Prune superseded lingcode-*.zip on the droplet. -----------------------
if [ "${KEEP_OLD_ZIPS:-0}" != "1" ]; then
  echo "  [4/5] pruning lingcode-*.zip != $VERSION on the server ..."
  $SSH "cd '$REMOTE' && for f in lingcode-*.zip; do
          case \"\$f\" in
            *-$VERSION.zip) ;;                       # keep current version
            'lingcode-*.zip') ;;                     # no matches (nullglob off)
            *) rm -f \"\$f\" && echo \"      pruned \$f\" ;;
          esac
        done; true"
else
  echo "  [4/5] skipped prune (KEEP_OLD_ZIPS=1)"
fi

# --- 5. Verify the live chain. ------------------------------------------------
echo "  [5/5] verifying live ..."
LIVE_SH="$(curl -s --max-time 20 "$SITE/install-cli.sh" | grep -m1 -o 'v[0-9][^"}]*' || true)"
ZIP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$SITE/lingcode-linux-x64-$VERSION.zip" || true)"
echo "      install-cli.sh (live): ${LIVE_SH:-?}"
echo "      linux-x64 zip (live) : HTTP $ZIP_CODE"

if [ "$LIVE_SH" = "$VERSION" ] && [ "$ZIP_CODE" = "200" ]; then
  echo "✅ Done — lingcode.dev now serves $VERSION end-to-end."
else
  echo "⚠️  Verification mismatch — expected install-cli.sh=$VERSION and zip HTTP 200." >&2
  echo "    Re-check the server, and remember to commit the bumped files in this repo." >&2
  exit 1
fi

echo
echo "Next: commit the 3 bumped files so a future ./deploy.sh doesn't regress them:"
echo "  git add install-cli.sh install-cli.ps1 cliv2-latest.json && git commit -m 'cli: $VERSION'"
