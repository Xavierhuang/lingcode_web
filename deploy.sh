#!/usr/bin/env bash
# Deploy lingcode.dev website to the droplet.
# Nginx serves from /var/www/html (see /etc/nginx/sites-enabled/lingcode.dev).
#
# Usage: from repo root:   ./website/deploy.sh
#        from website/:    ./deploy.sh
# Override user:          LINGCODE_SSH_USER=root ./website/deploy.sh

set -e

HOST="${LINGCODE_DEPLOY_HOST:-45.55.39.39}"
USER="${LINGCODE_SSH_USER:-root}"
REMOTE_PATH="/var/www/html"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEBSITE_DIR="$REPO_ROOT/website"

cd "$REPO_ROOT"

# Build the Pagefind static-search index over website/.
# Output lives at website/pagefind/ and is served alongside the rest of the site.
# Skipped if SKIP_PAGEFIND=1 (e.g. for a quick non-content change).
if [ "${SKIP_PAGEFIND:-0}" != "1" ] && command -v npx >/dev/null 2>&1; then
  echo "Building Pagefind search index..."
  npx -y pagefind --site "$WEBSITE_DIR" --output-path "$WEBSITE_DIR/pagefind" >/dev/null
  echo "Pagefind index built."
elif [ "${SKIP_PAGEFIND:-0}" = "1" ]; then
  echo "Skipping Pagefind index build (SKIP_PAGEFIND=1)."
else
  echo "WARNING: npx not found — skipping Pagefind index build. Install Node to enable site search."
fi

# --- Intel DMG staleness guard ---------------------------------------------
# ./scripts/ship.sh refreshes the arm64 generic LingCode-Installer.dmg to the
# latest build but NEVER touches LingCode-Intel-Installer.dmg (that's a separate
# ./scripts/build-intel-dmg.sh step, only auto-run by release-and-deploy.sh). A
# manual ship.sh + deploy.sh therefore silently publishes a fresh arm64 build
# while the 2 Intel download links on index.html keep serving the OLD build.
# Block the deploy when the Intel DMG is older than the arm64 one (or missing).
# Bypass for a site-only deploy with ALLOW_STALE_INTEL=1.
if [ "${ALLOW_STALE_INTEL:-0}" != "1" ]; then
  ARM_DMG="$WEBSITE_DIR/LingCode-Installer.dmg"
  INTEL_DMG="$WEBSITE_DIR/LingCode-Intel-Installer.dmg"
  if [ -f "$ARM_DMG" ]; then
    arm_mtime="$(stat -f %m "$ARM_DMG")"
    intel_mtime="$(stat -f %m "$INTEL_DMG" 2>/dev/null || echo 0)"
    if [ "$arm_mtime" -gt "$intel_mtime" ]; then
      echo "❌ Intel DMG is stale relative to the arm64 build about to publish." >&2
      if [ ! -f "$INTEL_DMG" ]; then
        echo "   (LingCode-Intel-Installer.dmg is missing entirely)" >&2
      fi
      echo "   The 2 Intel links on index.html would serve an OLD build." >&2
      echo "   Fix one of these, then re-run deploy:" >&2
      echo "     • rebuild Intel:  ./scripts/build-intel-dmg.sh ~/Desktop/LingCode.app" >&2
      echo "     • site-only push: ALLOW_STALE_INTEL=1 ./website/deploy.sh" >&2
      exit 1
    fi
  fi
fi

# --- DMG disk guard -------------------------------------------------------
# Each ./scripts/ship.sh drops a ~150 MB versioned DMG (LingCode-v*-build*-
# Installer.dmg). Without pruning they pile up on the 8.7 GB droplet until rsync
# dies with "No space left on device" — which has corrupted prod data.db before.
# Keep only the newest $KEEP_DMGS versioned DMGs, BOTH locally (so rsync doesn't
# re-upload superseded ones) and on the droplet. The generic LingCode-Installer.dmg
# and LingCode-Intel-Installer.dmg never match the build pattern, so they're
# always preserved. Override with KEEP_DMGS=N; disable with KEEP_DMGS=99.
KEEP_DMGS="${KEEP_DMGS:-2}"
prune_old_dmgs() {  # run with cwd in the dir holding the DMGs
  ls -1 LingCode-v*-build*-Installer.dmg 2>/dev/null \
    | sed -E 's/^.*-build([0-9]+)-.*$/\1 &/' | sort -rn | tail -n +"$((KEEP_DMGS + 1))" \
    | while read -r _ f; do echo "  prune $f"; rm -f "$f"; done
}
echo "Pruning old build DMGs (keeping newest $KEEP_DMGS) — local + droplet..."
( cd "$WEBSITE_DIR" && prune_old_dmgs )
ssh "$USER@$HOST" "KEEP_DMGS=$KEEP_DMGS; cd '$REMOTE_PATH' && $(declare -f prune_old_dmgs); prune_old_dmgs" 2>/dev/null || \
  echo "  (warning: couldn't prune droplet DMGs over ssh — local prune still applied)"

echo "Deploying $WEBSITE_DIR to $USER@$HOST:$REMOTE_PATH"
echo "(excluding website/server/ — run the Node admin API separately, not from nginx root)"
if command -v rsync >/dev/null 2>&1; then
  rsync -avz --exclude='.git' --exclude='server/' --exclude='marketing/' --exclude='.DS_Store' -e ssh "$WEBSITE_DIR/" "$USER@$HOST:$REMOTE_PATH/"
else
  echo "rsync not found; falling back to scp (may upload website/server — remove it on the server if present)"
  scp -r website/* "$USER@$HOST:$REMOTE_PATH/"
fi

# --- Cloudflare edge-cache purge --------------------------------------------
# Fixed-name files (generic + Intel DMG, appcast.xml) are overwritten in place
# each deploy, so Cloudflare's edge cache strands the OLD copy for up to its TTL
# (~4h) — new website downloads get the PREVIOUS build until it expires (Sparkle
# auto-update is unaffected; it fetches the uniquely-named versioned DMG). Purge
# just those fixed-name URLs so the download button + appcast go fresh at once.
# Versioned build DMGs have unique names and never need purging.
# Requires CLOUDFLARE_API_TOKEN (Zone → Cache Purge perm) + CLOUDFLARE_ZONE_ID;
# no-ops with a manual reminder if unset.
SITE_URL="${LINGCODE_SITE_URL:-https://lingcode.dev}"
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "${CLOUDFLARE_ZONE_ID:-}" ]]; then
  echo "Purging Cloudflare cache for fixed-name files..."
  cf_resp="$(curl -s -X POST \
    "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"files\":[\"${SITE_URL}/LingCode-Installer.dmg\",\"${SITE_URL}/LingCode-Intel-Installer.dmg\",\"${SITE_URL}/appcast.xml\"]}")"
  if echo "$cf_resp" | grep -q '"success":true'; then
    echo "  ✓ Purged: LingCode-Installer.dmg, LingCode-Intel-Installer.dmg, appcast.xml"
  else
    echo "  ⚠️  Cloudflare purge failed — purge manually or new downloads serve the OLD build until the edge TTL expires."
    echo "     response: $cf_resp"
  fi
else
  echo "ℹ️  Cloudflare auto-purge skipped (set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID to automate)."
  echo "   Until then, purge these in the CF dashboard after each deploy or new downloads serve the OLD build for ~4h:"
  echo "     $SITE_URL/LingCode-Installer.dmg"
  echo "     $SITE_URL/LingCode-Intel-Installer.dmg"
fi

echo "Done. https://lingcode.dev"
echo "Deploy API too: ./website/server/deploy-api.sh — or ./website/deploy-all.sh (site + API)."
