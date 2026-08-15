#!/usr/bin/env python3
"""
gen_sitemap.py — generate sitemap.xml from the live page inventory.

The hand-maintained sitemap this replaces had drifted badly: 220 URLs for a
site with ~426 indexable pages. It listed 9 URLs that robots.txt Disallows
(Google flags that conflict), carried a dead URL with no source file, and
contained exactly ONE /zh/ entry despite 185 Chinese pages — so the entire
Chinese site was undiscoverable through the sitemap. Its lastmod values had
collapsed to effectively one date, which Google learns to ignore.

Everything here derives from pages.py, so the sitemap cannot disagree with
robots.txt again: the Disallow set is parsed from robots.txt itself.

Output is a sitemap index plus one child per locale:

    sitemap.xml       -> index referencing the two below
    sitemap-en.xml    -> English pages
    sitemap-zh.xml    -> Chinese pages

Splitting by locale is not about size (426 URLs is far below the 50,000
limit) — it is so Search Console reports discovery and indexation for the
Chinese tree separately. Those 185 pages were invisible before, and a single
blended number would hide whether they ever get indexed.

Every page that has a counterpart in the other language emits the full
en + zh + x-default alternate triple, on BOTH sides. One-sided clusters are
discarded by Google, which is why pages.alternates() only pairs files that
both exist.

Usage:
  python3 scripts/seo/gen_sitemap.py          # write the three files
  python3 scripts/seo/gen_sitemap.py --dry    # print a summary, write nothing
"""

import subprocess
import sys
from pathlib import Path
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pages  # noqa: E402

WEBSITE_DIR = pages.WEBSITE_DIR
ORIGIN = pages.SITE_ORIGIN

INDEX_FILE = "sitemap.xml"
EN_FILE = "sitemap-en.xml"
ZH_FILE = "sitemap-zh.xml"

# Top-of-funnel marketing pages. Priority is a weak signal to Google, but it
# costs nothing to state the site's own hierarchy honestly.
TIER_ONE = {"index.html"}
TIER_TWO = {
    "pricing.html", "features.html", "cloud.html", "docs.html",
    "tutorials.html", "getting-started.html", "try.html",
}
# Pages that essentially never change.
RARELY = {"privacy.html", "terms.html", "voucher-terms/index.html"}


def priority(rel: str) -> str:
    base = rel[3:] if rel.startswith("zh/") else rel
    if base in TIER_ONE:
        value = 1.0
    elif base in TIER_TWO:
        value = 0.9
    elif "/" not in base:
        value = 0.8
    elif base.startswith(("tutorials/", "docs/")):
        value = 0.7
    else:
        value = 0.6
    if rel.startswith("zh/"):
        value *= 0.9
    return f"{value:.1f}"


def changefreq(rel: str) -> str:
    base = rel[3:] if rel.startswith("zh/") else rel
    if base in RARELY:
        return "yearly"
    if "/" not in base:
        return "weekly"
    return "monthly"


def docs_source_lastmod(rel: str) -> str | None:
    """For generated docs, date the SOURCE markdown, not the built HTML.

    build.mjs rewrites all 20 outputs on every run, so their mtimes churn on
    every deploy and would make lastmod meaningless.
    """
    if rel not in pages.generated_docs():
        return None
    output = rel[len("docs/cloud/"):]
    src = Path("docs-src/cloud") / (output[: -len(".html")] + ".md")
    if not (WEBSITE_DIR / src).is_file():
        return None
    try:
        res = subprocess.run(
            ["git", "log", "-1", "--format=%cs", "--", src.as_posix()],
            cwd=WEBSITE_DIR, capture_output=True, text=True, timeout=15,
        )
        if res.stdout.strip():
            return res.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def url_entry(rel: str) -> str:
    loc = pages.url_for(rel)
    mod = docs_source_lastmod(rel) or pages.lastmod(rel)
    lines = [
        "  <url>",
        f"    <loc>{escape(loc)}</loc>",
        f"    <lastmod>{mod}</lastmod>",
        f"    <changefreq>{changefreq(rel)}</changefreq>",
        f"    <priority>{priority(rel)}</priority>",
    ]
    for lang, href in pages.alternates(rel).items():
        lines.append(
            f'    <xhtml:link rel="alternate" hreflang="{lang}" href="{escape(href)}"/>'
        )
    lines.append("  </url>")
    return "\n".join(lines)


def urlset(rels: list[str]) -> str:
    body = "\n".join(url_entry(r) for r in sorted(rels, key=pages.url_for))
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n'
        '        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
        f"{body}\n"
        "</urlset>\n"
    )


def sitemap_index(children: list[tuple[str, str]]) -> str:
    body = "\n".join(
        "  <sitemap>\n"
        f"    <loc>{ORIGIN}/{name}</loc>\n"
        f"    <lastmod>{mod}</lastmod>\n"
        "  </sitemap>"
        for name, mod in children
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{body}\n"
        "</sitemapindex>\n"
    )


def main() -> int:
    dry = "--dry" in sys.argv
    idx = pages.indexable()
    en = [r for r in idx if not r.startswith("zh/")]
    zh = [r for r in idx if r.startswith("zh/")]

    en_xml, zh_xml = urlset(en), urlset(zh)
    newest = lambda rels: max((pages.lastmod(r) for r in rels), default="1970-01-01")
    index_xml = sitemap_index([(EN_FILE, newest(en)), (ZH_FILE, newest(zh))])

    paired = sum(1 for r in idx if pages.alternates(r))
    print(f"indexable pages : {len(idx)}  (en {len(en)}, zh {len(zh)})")
    print(f"alternate links : {paired * 3} across {paired} page(s)")
    print(f"distinct lastmod: {len({pages.lastmod(r) for r in idx})}")

    if dry:
        print("\n--dry: nothing written")
        return 0

    for name, content in ((EN_FILE, en_xml), (ZH_FILE, zh_xml), (INDEX_FILE, index_xml)):
        (WEBSITE_DIR / name).write_text(content, encoding="utf-8")
        print(f"wrote {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
