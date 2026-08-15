#!/usr/bin/env python3
"""
check_seo.py — assert the SEO invariants. Run by deploy.sh; exits non-zero on error.

This is the piece that keeps the fixes from rotting. Every defect found in the
audit that produced scripts/seo/ is encoded here as an assertion, so the same
defect cannot come back silently:

  * the sitemap listed 9 URLs that robots.txt Disallows        -> checks 2, 3
  * it omitted 236 real pages, including 184 of 185 zh pages   -> check 5
  * it listed a URL with no source file                        -> check 1
  * two tutorials had hreflang pointing at a 404               -> check 6
  * 200 tutorials shipped a "Search" node in their breadcrumb  -> check 10
  * 41 zh pages shipped JSON-LD that did not parse             -> check 9
  * 356 pages had no og:title; 0 tutorials had analytics       -> checks 7, 8

ERRORS block the deploy. WARNINGS are printed and do not. Length limits are
warnings on purpose: a 62-character title is worth knowing about but is not
worth refusing to ship over.

Usage:
  python3 scripts/seo/check_seo.py            # everything
  python3 scripts/seo/check_seo.py --quiet    # errors and warnings only, no summary
"""

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pages  # noqa: E402

WEBSITE_DIR = pages.WEBSITE_DIR
SM_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"

TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S | re.I)
DESC_RE = re.compile(r'<meta[^>]+name=["\']description["\'][^>]+content=["\'](.*?)["\']', re.S | re.I)
CANON_RE = re.compile(r'<link[^>]+rel=["\']canonical["\'][^>]*>', re.I)
ALT_RE = re.compile(r'<link[^>]+rel=["\']alternate["\'][^>]*>', re.I)
HREF_RE = re.compile(r'href=["\']([^"\']+)["\']')
LANG_RE = re.compile(r'hreflang=["\']([^"\']+)["\']')
META_PROP_RE = re.compile(
    r'<meta[^>]+(?:property|name)=["\']([^"\']+)["\'][^>]+content=["\'](.*?)["\']', re.S | re.I
)
LD_RE = re.compile(r'(?s)<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.I)
ANALYTICS_RE = re.compile(r'src=["\']/analytics\.js', re.I)

REQUIRED_META = ("og:title", "og:description", "og:image", "twitter:card")

errors: list[str] = []
warnings: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


def url_to_rel(url: str) -> str:
    rel = url.replace(pages.SITE_ORIGIN + "/", "")
    if rel == "":
        return "index.html"
    if rel.endswith("/"):
        return rel + "index.html"
    return rel


def sitemap_urls() -> list[str]:
    out = []
    for name in ("sitemap-en.xml", "sitemap-zh.xml"):
        path = WEBSITE_DIR / name
        if not path.is_file():
            err(f"{name} is missing; run scripts/seo/gen_sitemap.py")
            continue
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError as exc:
            err(f"{name} is not well-formed XML: {exc}")
            continue
        out += [e.text or "" for e in root.iter(f"{SM_NS}loc")]
    return out


def main() -> int:
    quiet = "--quiet" in sys.argv
    indexable = pages.indexable()
    idx_urls = {pages.url_for(r) for r in indexable}

    # ---- sitemap-level checks -------------------------------------------
    urls = sitemap_urls()
    counts = Counter(urls)

    for url, n in counts.items():
        if n > 1:
            err(f"sitemap: {url} listed {n} times")                       # 4

    for url in counts:
        rel = url_to_rel(url)
        if not (WEBSITE_DIR / rel).is_file():
            err(f"sitemap: {url} has no source file")                     # 1
            continue
        if pages.is_disallowed(pages.url_path(rel)):
            err(f"sitemap: {url} is Disallow'd in robots.txt")            # 2
        if pages.is_noindex(rel):
            err(f"sitemap: {url} is marked noindex")                      # 3

    for url in idx_urls - set(counts):
        err(f"sitemap: indexable page absent from sitemap: {url}")        # 5

    # ---- per-page checks -------------------------------------------------
    canonicals: dict[str, list[str]] = defaultdict(list)

    for rel in indexable:
        html = (WEBSITE_DIR / rel).read_text(encoding="utf-8", errors="replace")
        where = rel

        title_m = TITLE_RE.search(html)
        if not title_m or not title_m.group(1).strip():
            err(f"{where}: no <title>")
        elif len(title_m.group(1).strip()) > 60:
            warn(f"{where}: title is {len(title_m.group(1).strip())} chars (>60)")

        desc_m = DESC_RE.search(html)
        if not desc_m or not desc_m.group(1).strip():
            err(f"{where}: no meta description")
        else:
            n = len(desc_m.group(1).strip())
            if not 120 <= n <= 160:
                warn(f"{where}: meta description is {n} chars (want 120-160)")

        # canonical must exist, be unique across the site, and be self-referential
        canon_m = CANON_RE.search(html)
        if not canon_m:
            err(f"{where}: no rel=canonical")
        else:
            href = HREF_RE.search(canon_m.group(0))
            if not href:
                err(f"{where}: canonical has no href")
            else:
                canonicals[href.group(1)].append(rel)
                if href.group(1) != pages.url_for(rel):
                    err(f"{where}: canonical is {href.group(1)}, expected {pages.url_for(rel)}")  # 11

        metas = {k.lower(): v for k, v in META_PROP_RE.findall(html)}
        for key in REQUIRED_META:
            if key not in metas or not metas[key].strip():
                err(f"{where}: missing {key}")                             # 7

        if not ANALYTICS_RE.search(html):
            err(f"{where}: does not load /analytics.js")                   # 8

        # hreflang targets must resolve, and the cluster must be reciprocal
        declared = {}
        for tag in ALT_RE.findall(html):
            h, l = HREF_RE.search(tag), LANG_RE.search(tag)
            if h and l:
                declared[l.group(1)] = h.group(1)
        for lang, href in declared.items():
            target = url_to_rel(href)
            if not (WEBSITE_DIR / target).is_file():
                err(f"{where}: hreflang={lang} points at missing {href}")   # 6
        want = pages.alternates(rel)
        if want and "zh" not in declared:
            err(f"{where}: has a zh twin on disk but declares no zh alternate")

        # structured data must parse, and breadcrumbs must be clean
        for block in LD_RE.findall(html):
            try:
                data = json.loads(block)
            except json.JSONDecodeError as exc:
                err(f"{where}: JSON-LD does not parse: {exc}")             # 9
                continue
            nodes = data if isinstance(data, list) else [data]
            for node in nodes:
                if not isinstance(node, dict) or node.get("@type") != "BreadcrumbList":
                    continue
                items = node.get("itemListElement", [])
                for it in items:
                    name = (it.get("name") or "").strip()
                    url = (it.get("item") or "").rstrip("/")
                    if name in ("Search", "搜索") and url.endswith("search.html"):
                        err(f"{where}: breadcrumb contains a stray Search node")   # 10
                positions = [it.get("position") for it in items]
                if positions != list(range(1, len(items) + 1)):
                    err(f"{where}: breadcrumb positions are not contiguous: {positions}")

    for href, owners in canonicals.items():
        if len(owners) > 1:
            err(f"canonical {href} is claimed by {len(owners)} pages: {owners[:4]}")  # 12

    # ---- report ----------------------------------------------------------
    if not quiet:
        print(f"checked {len(indexable)} indexable page(s), {len(urls)} sitemap URL(s)")
    for w in warnings[:40]:
        print(f"  warning: {w}")
    if len(warnings) > 40:
        print(f"  ... and {len(warnings) - 40} more warning(s)")
    for e in errors[:60]:
        print(f"  ERROR: {e}", file=sys.stderr)
    if len(errors) > 60:
        print(f"  ... and {len(errors) - 60} more error(s)", file=sys.stderr)

    if errors:
        print(f"\nSEO check FAILED: {len(errors)} error(s), {len(warnings)} warning(s)", file=sys.stderr)
        return 1
    if not quiet:
        print(f"SEO check passed ({len(warnings)} warning(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
