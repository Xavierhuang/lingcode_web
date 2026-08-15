#!/usr/bin/env python3
"""
gen_hub_schema.py — put CollectionPage + ItemList schema on the tutorial hubs.

tutorials.html links to all 154 tutorials and is the page that distributes
crawl budget to the entire corpus, but it shipped no JSON-LD at all. An
ItemList that names every child makes the relationship explicit rather than
leaving Google to infer it from anchor soup, and a CollectionPage tells it
this is an index rather than an article.

The list is built from the page's own markup — each .tutorial-card's <h3> and
its "Start" link — so it cannot drift from what the page actually shows. If a
tutorial is added to the hub, re-running this picks it up.

Idempotent via the sentinel `<!-- hub-schema:v1 -->`: an existing block is
replaced wholesale rather than appended to.

Usage:
  python3 scripts/seo/gen_hub_schema.py         # tutorials.html + zh/tutorials.html
  python3 scripts/seo/gen_hub_schema.py --dry   # report; no writes
"""

import html as htmllib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pages  # noqa: E402

WEBSITE_DIR = pages.WEBSITE_DIR
SENTINEL = "hub-schema:v1"

CARD_RE = re.compile(
    r'(?s)<div class="tutorial-card".*?<h3>(?P<name>.*?)</h3>.*?'
    r'<a href="(?P<href>/(?:zh/)?tutorials/[^"]+\.html)"',
)
CLOSE_HEAD_RE = re.compile(r"([ \t]*)</head>", re.I)
# Consumes the sentinel AND every script block that follows it. A non-greedy
# `.*?</script>` would stop at the first one, leave the second behind, and make
# the script append a fresh copy on every run instead of replacing.
EXISTING_RE = re.compile(
    rf'(?s)[ \t]*<!-- {SENTINEL} -->[ \t]*\r?\n'
    r'(?:[ \t]*<script type="application/ld\+json">.*?</script>[ \t]*\r?\n)+'
)

HUBS = {
    "tutorials.html": ("Tutorials", "Home"),
    "zh/tutorials.html": ("教程", "首页"),
}


def text_of(fragment: str) -> str:
    return " ".join(htmllib.unescape(re.sub(r"<[^>]+>", " ", fragment)).split())


def build(rel: str, html_text: str) -> tuple[str, int] | None:
    hub_name, home_name = HUBS[rel]
    seen: set[str] = set()
    items = []
    for m in CARD_RE.finditer(html_text):
        href = m.group("href")
        if href in seen:
            continue
        seen.add(href)
        items.append({
            "@type": "ListItem",
            "position": len(items) + 1,
            "name": text_of(m.group("name")),
            "url": pages.SITE_ORIGIN + href,
        })
    if not items:
        return None

    collection = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": hub_name,
        "url": pages.url_for(rel),
        "inLanguage": "zh" if rel.startswith("zh/") else "en",
        "isPartOf": {"@type": "WebSite", "name": "LingCode", "url": f"{pages.SITE_ORIGIN}/"},
        "mainEntity": {
            "@type": "ItemList",
            "numberOfItems": len(items),
            "itemListElement": items,
        },
    }
    breadcrumb = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": home_name,
             "item": pages.url_for("zh/index.html" if rel.startswith("zh/") else "index.html")},
            {"@type": "ListItem", "position": 2, "name": hub_name, "item": pages.url_for(rel)},
        ],
    }
    blocks = "".join(
        '  <script type="application/ld+json">\n'
        + json.dumps(obj, indent=2, ensure_ascii=False)
        + "\n  </script>\n"
        for obj in (collection, breadcrumb)
    )
    return f"  <!-- {SENTINEL} -->\n{blocks}", len(items)


def main() -> int:
    dry = "--dry" in sys.argv
    for rel in HUBS:
        path = WEBSITE_DIR / rel
        if not path.is_file():
            print(f"  missing {rel}")
            continue
        html_text = path.read_text(encoding="utf-8")
        built = build(rel, html_text)
        if not built:
            print(f"  {rel}: no .tutorial-card entries found; skipped")
            continue
        block, count = built

        stripped = EXISTING_RE.sub("", html_text)
        m = CLOSE_HEAD_RE.search(stripped)
        if not m:
            print(f"  {rel}: no </head>; skipped")
            continue
        new_html = stripped[: m.start()] + block + stripped[m.start():]

        if new_html == html_text:
            print(f"  {rel}: already current ({count} items)")
            continue
        print(f"  {'would write' if dry else 'wrote'} {rel}: ItemList of {count} tutorial(s)")
        if not dry:
            path.write_text(new_html, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
