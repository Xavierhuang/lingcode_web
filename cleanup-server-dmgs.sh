#!/usr/bin/env bash
# Remove stale LingCode DMGs from lingcode.dev (and optionally the local website/ folder).
#
# Keeps (the glob is LingCode*.dmg, which spans the sibling apps too):
#   - LingCode-Installer.dmg / LingCode-Intel-Installer.dmg  (main app aliases)
#   - LingCodeFTP.dmg, LingCodeBaby.dmg                      (sibling generic aliases)
#   - The newest versioned DMG from each of appcast.xml / appcast-ftp.xml /
#     appcast-baby.xml (each app's live Sparkle enclosure)
#
# Usage:
#   ./website/cleanup-server-dmgs.sh              # remote server only
#   ./website/cleanup-server-dmgs.sh --local      # local website/ only
#   ./website/cleanup-server-dmgs.sh --local --remote   # both
#
# Env (same as deploy.sh):
#   LINGCODE_DEPLOY_HOST   default 45.55.39.39
#   LINGCODE_SSH_USER      default root
#   DRY_RUN=1              print actions without deleting

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBSITE_DIR="$SCRIPT_DIR"
APPCAST="$WEBSITE_DIR/appcast.xml"
REMOTE_PATH="${LINGCODE_REMOTE_PATH:-/var/www/html}"
HOST="${LINGCODE_DEPLOY_HOST:-45.55.39.39}"
USER="${LINGCODE_SSH_USER:-root}"

DO_LOCAL=0
DO_REMOTE=0
for arg in "$@"; do
  case "$arg" in
    --local) DO_LOCAL=1 ;;
    --remote) DO_REMOTE=1 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg (try --local and/or --remote)" >&2
      exit 1
      ;;
  esac
done
if [[ "$DO_LOCAL" -eq 0 && "$DO_REMOTE" -eq 0 ]]; then
  DO_REMOTE=1
fi

if [[ ! -f "$APPCAST" ]]; then
  echo "Missing $APPCAST" >&2
  exit 1
fi

KEEP_RAW="$(python3 - "$APPCAST" <<'PY'
import re, sys, os
# The glob below is LingCode*.dmg, which also matches the sibling apps
# LingCodeFTP*.dmg and LingCodeBaby*.dmg. Keep each generic download alias
# PLUS the latest versioned DMG from each appcast, so a cleanup for one app
# never deletes another live download / Sparkle enclosure.
website = os.path.dirname(os.path.abspath(sys.argv[1]))

def latest_enclosure(appcast_name):
    try:
        xml = open(os.path.join(website, appcast_name)).read()
    except FileNotFoundError:
        return None
    m = re.search(r'<enclosure[^>]+url="https://lingcode\.dev/([^"]+)"', xml)
    return m.group(1) if m else None

# Generic, fixed-name downloads — always keep.
keep = [
    "LingCode-Installer.dmg",       # main app "Download for Mac"
    "LingCode-Intel-Installer.dmg", # main app Intel download
    "LingCodeFTP.dmg",              # LingCodeFTP generic download
    "LingCodeBaby.dmg",             # LingCodeBaby generic download
]

# Latest versioned DMG from each appcast (the live Sparkle enclosure).
main_latest = latest_enclosure(os.path.basename(sys.argv[1]))
if not main_latest:
    sys.exit("Could not parse latest DMG URL from appcast.xml")
keep.append(main_latest)
for feed in ("appcast-ftp.xml", "appcast-baby.xml"):
    v = latest_enclosure(feed)
    if v:
        keep.append(v)

seen = set()
for name in keep:
    if name and name not in seen:
        seen.add(name)
        print(name)
PY
)"

KEEP_NAMES=()
while IFS= read -r line; do
  [[ -n "$line" ]] && KEEP_NAMES+=("$line")
done <<< "$KEEP_RAW"

echo "Keeping DMGs:"
for f in "${KEEP_NAMES[@]}"; do
  echo "  - $f"
done

cleanup_dir() {
  local label="$1"
  local dir="$2"
  echo ""
  echo "=== $label: $dir ==="
  shopt -s nullglob
  local dmgs=("$dir"/LingCode*.dmg)
  shopt -u nullglob
  if [[ ${#dmgs[@]} -eq 0 ]]; then
    echo "  (no LingCode*.dmg files)"
    return
  fi
  for dmg in "${dmgs[@]}"; do
    local base
    base="$(basename "$dmg")"
    local keep=0
    for k in "${KEEP_NAMES[@]}"; do
      if [[ "$base" == "$k" ]]; then
        keep=1
        break
      fi
    done
    if [[ "$keep" -eq 1 ]]; then
      echo "  keep  $base"
    else
      if [[ "${DRY_RUN:-0}" == "1" ]]; then
        echo "  dry-run delete  $base"
      else
        rm -f "$dmg"
        echo "  deleted  $base"
      fi
    fi
  done
}

if [[ "$DO_LOCAL" -eq 1 ]]; then
  cleanup_dir "Local" "$WEBSITE_DIR"
fi

if [[ "$DO_REMOTE" -eq 1 ]]; then
  echo ""
  echo "=== Remote: $USER@$HOST:$REMOTE_PATH ==="
  # shellcheck disable=SC2029
  ssh "$USER@$HOST" "REMOTE_PATH='$REMOTE_PATH' DRY_RUN='${DRY_RUN:-0}'" bash -s "${KEEP_NAMES[@]}" <<'REMOTE'
set -euo pipefail
KEEP=("$@")
cd "$REMOTE_PATH"
shopt -s nullglob
dmgs=(LingCode*.dmg)
shopt -u nullglob
if [[ ${#dmgs[@]} -eq 0 ]]; then
  echo "  (no LingCode*.dmg files)"
  exit 0
fi
for base in "${dmgs[@]}"; do
  ok=0
  for k in "${KEEP[@]}"; do
    if [[ "$base" == "$k" ]]; then ok=1; break; fi
  done
  if [[ "$ok" -eq 1 ]]; then
    echo "  keep  $base"
  elif [[ "$DRY_RUN" == "1" ]]; then
    echo "  dry-run delete  $base"
  else
    rm -f "$base"
    echo "  deleted  $base"
  fi
done
REMOTE
fi

echo ""
echo "Done. Re-run ./website/deploy.sh after fixing HTML links if you changed the repo."
