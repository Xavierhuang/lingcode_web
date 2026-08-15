#!/usr/bin/env python3
"""
inject_analytics.py — load /analytics.js on every public page.

GA4 (G-LF7H10J0V2) was firing on 64 of 456 pages. The gap was not random:
0 of 154 English tutorials, 0 of 151 Chinese tutorials, 0 of 36 Cloud docs
pages, and — most expensively — none of pricing.html, tutorials.html or
cloud.html. The entire long-tail content library was analytically invisible,
so there was no evidence for which tutorials earn traffic and no way to
prioritise the content work by anything but guesswork.

This runs before the og:/twitter: injection deliberately, so the traffic
effect of that change can be read against a page set that is already fully
instrumented.

Generated docs (docs/cloud/** from navigation.json) are skipped and reported;
they get the tag from scripts/docs/template.mjs instead, because editing them
directly breaks scripts/docs/check.mjs and therefore every future deploy.

Idempotent: a page that already loads /analytics.js is left byte-identical,
whatever ?v= it uses.

Usage:
  python3 scripts/seo/inject_analytics.py          # all indexable pages
  python3 scripts/seo/inject_analytics.py <files>  # only the listed files
  python3 scripts/seo/inject_analytics.py --dry    # report; no writes
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pages  # noqa: E402

WEBSITE_DIR = pages.WEBSITE_DIR

# Matches the tag with any cache-bust value, so re-running never double-inserts.
HAS_ANALYTICS_RE = re.compile(r'<script[^>]+src=["\']/analytics\.js', re.I)
CLOSE_HEAD_RE = re.compile(r"([ \t]*)</head>", re.I)

TAG = '<script src="/analytics.js?v=20260428a" async></script>'


def inject(html: str) -> str | None:
    """Insert the analytics tag before </head>. None if nothing to do."""
    if HAS_ANALYTICS_RE.search(html):
        return None
    m = CLOSE_HEAD_RE.search(html)
    if not m:
        return None
    indent = m.group(1) or "  "
    return html[: m.start()] + f"{indent}{TAG}\n" + html[m.start():]


def main() -> int:
    dry = "--dry" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    targets = args or pages.indexable()
    generated = pages.generated_docs()

    changed = 0
    skipped_generated: list[str] = []
    no_head: list[str] = []

    for rel in targets:
        if rel in generated:
            skipped_generated.append(rel)
            continue
        path = WEBSITE_DIR / rel
        if not path.is_file():
            continue
        html = path.read_text(encoding="utf-8")
        new_html = inject(html)
        if new_html is None:
            if not HAS_ANALYTICS_RE.search(html):
                no_head.append(rel)
            continue
        changed += 1
        if not dry:
            path.write_text(new_html, encoding="utf-8")

    print(f"{'Would add' if dry else 'Added'} analytics to {changed} page(s) of {len(targets)}.")
    if skipped_generated:
        print(
            f"skipped {len(skipped_generated)} generated doc(s) — add the tag in "
            "scripts/docs/template.mjs and rerun scripts/docs/build.mjs"
        )
    if no_head:
        print(f"WARNING: {len(no_head)} page(s) have no </head> to inject into:")
        for rel in no_head[:10]:
            print(f"  {rel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
