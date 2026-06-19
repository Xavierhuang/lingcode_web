#!/usr/bin/env bash
# Keep only the N newest <item> entries in appcast.xml (default 1).
# Run before cleanup-server-dmgs.sh so old enclosure URLs are not left dangling.
#
# Usage: ./website/trim-appcast.sh [keep_count]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPCAST="$SCRIPT_DIR/appcast.xml"
KEEP="${1:-1}"

python3 - "$APPCAST" "$KEEP" <<'PY'
import re, sys
path, keep = sys.argv[1], int(sys.argv[2])
xml = open(path).read()
# Only real feed items (before the HTML comment template at the bottom).
feed, _, _ = xml.partition("<!--")
raw = re.findall(r"\n\s*<item>.*?</item>", feed, flags=re.DOTALL)
items = [
    it for it in raw
    if re.search(r"<sparkle:version>\s*\d+\s*</sparkle:version>", it)
]
if len(items) <= keep:
    print(f"appcast already has {len(items)} item(s); nothing to trim")
    sys.exit(0)
removed = items[keep:]
items = items[:keep]
# Drop removed items; preserve comment block at end if present.
body = '\n'.join(items)
xml2 = re.sub(r'(<language>en</language>).*?(<!--\s*\n\s*Each release)',
              lambda m: m.group(1) + '\n\n' + body + '\n\n    ' + m.group(2),
              xml, count=1, flags=re.DOTALL)
if xml2 == xml:
    print('error: could not rewrite appcast.xml', file=sys.stderr)
    sys.exit(1)
open(path, 'w').write(xml2)
print(f'trimmed appcast: kept {keep} item(s), removed {len(removed)}')
for it in removed:
    v = re.search(r'<sparkle:version>\s*(\d+)\s*</sparkle:version>', it)
    print(f'  removed build {v.group(1) if v else "?"}')
PY
