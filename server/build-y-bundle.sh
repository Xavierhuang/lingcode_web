#!/usr/bin/env bash
# Rebuild website/try/lib/y-bundle.js from the yjs + y-websocket versions
# pinned in this dir's package.json. Run after upgrading either package.
#
# Why a self-hosted bundle: esm.sh's ?external=yjs query *should* dedupe yjs
# across our direct import and y-websocket's transitive dep, but it didn't —
# Chrome's network log showed both yjs@<pinned> and yjs@<latest-^range> being
# loaded, breaking instanceof checks. Bundling locally with esbuild guarantees
# one yjs instance.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENTRY=".y-bundle-entry.mjs"
OUT="../try/lib/y-bundle.js"

cat > "$ENTRY" <<'EOF'
export * as Y from 'yjs';
export { WebsocketProvider } from 'y-websocket';
EOF

mkdir -p "$(dirname "$OUT")"

npx --yes esbuild@latest "$ENTRY" \
  --bundle --format=esm --target=es2022 --platform=browser \
  --define:process.env.NODE_ENV='"production"' \
  --define:global=globalThis \
  --outfile="$OUT"

rm -f "$ENTRY"

echo "Built $OUT ($(wc -c < "$OUT" | awk '{printf "%.1f KB\n", $1/1024}'))"
echo "Bump the cache-bust on collab.js's import of /try/lib/y-bundle.js"
