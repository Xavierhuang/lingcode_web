#!/usr/bin/env python3
"""
inject-tutorial-geo.py — Generative Engine Optimization injector for LingCode tutorials.

For each website/tutorials/*.html the script injects, idempotently:
  - <meta name="article:modified_time"> / article:published_time / author
  - <meta property="og:image"> + og:type=article + canonical (only if missing)
  - JSON-LD HowTo schema (when H2s look step-shaped) or TechArticle fallback
  - JSON-LD BreadcrumbList from the existing .tutorial-breadcrumb DOM
  - A visible "Updated: YYYY-MM-DD" badge inside the existing .badge-row

The script uses BeautifulSoup only for *parsing* (extracting H1/intro/headings/breadcrumb).
The mutation itself is a surgical string insert before </head> and inside .badge-row, so the
diff is small and the rest of the file is byte-identical.

Idempotent via the sentinel `<!-- geo-meta:v1 -->`. Delete it to force re-injection.

Usage:
  python3 scripts/inject-tutorial-geo.py             # process all tutorials/*.html
  python3 scripts/inject-tutorial-geo.py <files>...  # process listed files only
  python3 scripts/inject-tutorial-geo.py --dry       # report planned changes; no writes
"""

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from bs4 import BeautifulSoup

SCRIPT_DIR = Path(__file__).resolve().parent
WEBSITE_DIR = SCRIPT_DIR.parent
TUTORIALS_DIR = WEBSITE_DIR / "tutorials"
SENTINEL = "geo-meta:v1"
SITE_ORIGIN = "https://lingcode.dev"
DEFAULT_PUBLISHED = "2026-01-01"
OG_IMAGE = f"{SITE_ORIGIN}/og-image.png"

STEP_VERBS = {
    "add", "install", "configure", "create", "run", "deploy", "build", "set",
    "open", "connect", "write", "use", "enable", "disable", "import", "export",
    "register", "ship", "publish", "verify", "test", "check", "edit", "update",
    "remove", "delete", "fetch", "send", "load", "save", "switch", "pick", "start",
    "stop", "launch", "sign", "upload", "download", "generate", "make", "prepare",
    "choose", "find", "fix", "review", "wire", "point", "redirect", "drop",
}
NON_STEP_PATTERNS = (
    "what you", "why this", "why we", "troubleshoot", "resources", "next step",
    "see also", "summary", "tldr", "tl;dr", "tradeoff", "trade-off", "limits",
    "background", "context", "faq",
)


def is_step_heading(text: str) -> bool:
    t = text.strip().lower()
    if not t:
        return False
    for pat in NON_STEP_PATTERNS:
        if pat in t:
            return False
    if re.match(r"^\d+[\.\)]\s", t):
        return True
    first = t.split()[0]
    return first in STEP_VERBS


def file_mtime_date(p: Path) -> str:
    ts = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)
    return ts.strftime("%Y-%m-%d")


def extract_breadcrumb_items(soup: BeautifulSoup, page_url: str) -> list:
    bc = soup.find("div", class_="tutorial-breadcrumb")
    items = [{"name": "Home", "url": f"{SITE_ORIGIN}/"}]
    if bc:
        for el in bc.find_all(["a", "span"]):
            if el.name == "a":
                href = el.get("href", "")
                if href.startswith("/"):
                    href = SITE_ORIGIN + href
                name = el.get_text(strip=True)
                if name and name.lower() != "home" and href and not href.endswith("#"):
                    items.append({"name": name, "url": href})
            elif el.name == "span":
                t = el.get_text(strip=True)
                if t and t != "/":
                    items.append({"name": t, "url": None})
    seen, out = set(), []
    for it in items:
        if it["name"] in seen:
            continue
        seen.add(it["name"])
        out.append(it)
    # Ensure the trailing item resolves to the page itself
    if out and out[-1]["url"] is None:
        out[-1]["url"] = page_url
    return out


def build_breadcrumb_jsonld(items: list) -> dict:
    return {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": it["name"], "item": it["url"]}
            for i, it in enumerate(items)
        ],
    }


def build_main_jsonld(
    *, title: str, description: str, page_url: str,
    date_published: str, date_modified: str, step_headings: list,
) -> dict:
    common = {
        "@context": "https://schema.org",
        "name": title,
        "description": description,
        "url": page_url,
        "image": OG_IMAGE,
        "datePublished": date_published,
        "dateModified": date_modified,
        "author": {"@type": "Organization", "name": "LingCode", "url": f"{SITE_ORIGIN}/"},
        "publisher": {
            "@type": "Organization",
            "name": "HainanMandi Tech",
            "url": f"{SITE_ORIGIN}/",
            "logo": {"@type": "ImageObject", "url": OG_IMAGE},
        },
        "mainEntityOfPage": {"@type": "WebPage", "@id": page_url},
        "inLanguage": "en-US",
    }
    if len(step_headings) >= 3:
        common["@type"] = "HowTo"
        common["totalTime"] = "PT15M"
        common["step"] = [
            {"@type": "HowToStep", "position": i + 1, "name": s, "url": f"{page_url}#step-{i + 1}"}
            for i, s in enumerate(step_headings)
        ]
    else:
        common["@type"] = "TechArticle"
        common["headline"] = title
    return common


def has_attr_meta(raw: str, attr: str, value: str) -> bool:
    """Quick string check: is there a <meta ATTR="VALUE" ...> present?"""
    return re.search(rf'<meta\b[^>]*\b{attr}=["\']{re.escape(value)}["\']', raw, flags=re.IGNORECASE) is not None


def has_link_canonical(raw: str) -> bool:
    return re.search(r'<link\b[^>]*\brel=["\']canonical["\']', raw, flags=re.IGNORECASE) is not None


def build_injection_block(raw: str, *, title: str, description: str, page_url: str,
                           date_modified: str, date_published: str, step_headings: list,
                           breadcrumb_items: list) -> str:
    main_ld = build_main_jsonld(
        title=title, description=description, page_url=page_url,
        date_published=date_published, date_modified=date_modified,
        step_headings=step_headings,
    )
    bc_ld = build_breadcrumb_jsonld(breadcrumb_items)

    parts = [f"  <!-- {SENTINEL} -->"]
    if not has_attr_meta(raw, "name", "article:modified_time"):
        parts.append(f'  <meta name="article:modified_time" content="{date_modified}T00:00:00Z">')
    if not has_attr_meta(raw, "name", "article:published_time"):
        parts.append(f'  <meta name="article:published_time" content="{date_published}T00:00:00Z">')
    if not has_attr_meta(raw, "name", "author"):
        parts.append('  <meta name="author" content="LingCode">')
    if not has_attr_meta(raw, "property", "og:image"):
        parts.append(f'  <meta property="og:image" content="{OG_IMAGE}">')
    if not has_attr_meta(raw, "property", "og:type"):
        parts.append('  <meta property="og:type" content="article">')
    if not has_link_canonical(raw):
        parts.append(f'  <link rel="canonical" href="{page_url}">')

    main_json = json.dumps(main_ld, ensure_ascii=False, indent=2)
    bc_json = json.dumps(bc_ld, ensure_ascii=False, indent=2)
    parts.append('  <script type="application/ld+json">')
    parts.append(main_json)
    parts.append("  </script>")
    parts.append('  <script type="application/ld+json">')
    parts.append(bc_json)
    parts.append("  </script>")

    return "\n".join(parts) + "\n"


def insert_before_close_head(raw: str, block: str) -> str:
    # Match the first </head> case-insensitively
    m = re.search(r"</head\s*>", raw, flags=re.IGNORECASE)
    if not m:
        return raw
    insert_at = m.start()
    return raw[:insert_at].rstrip() + "\n" + block + raw[insert_at:]


def insert_badge_in_row(raw: str, badge_html: str) -> tuple:
    """Insert a badge inside the first .badge-row div if no Updated badge is present."""
    m = re.search(r'<div\s+class="badge-row">(.*?)</div>', raw, flags=re.DOTALL | re.IGNORECASE)
    if not m:
        return raw, False
    inner = m.group(1)
    if re.search(r"updated\s+\d{4}-\d{2}-\d{2}", inner, flags=re.IGNORECASE):
        return raw, False
    new_inner = inner.rstrip() + "\n        " + badge_html + "\n      "
    new_block = f'<div class="badge-row">{new_inner}</div>'
    return raw[: m.start()] + new_block + raw[m.end():], True


def process(path: Path, dry: bool) -> tuple:
    raw = path.read_text(encoding="utf-8")
    if SENTINEL in raw:
        return ("skip", "already injected")

    soup = BeautifulSoup(raw, "html.parser")

    h1 = soup.find("h1")
    title_text = h1.get_text(strip=True) if h1 else path.stem.replace("-", " ").title()

    intro = soup.find("p", class_="intro")
    intro_text = intro.get_text(" ", strip=True) if intro else ""
    description = re.sub(r"\s+", " ", intro_text)[:280].rstrip()
    if not description:
        md = soup.find("meta", attrs={"name": "description"})
        if md and md.get("content"):
            description = md["content"][:280]
    if not description:
        description = title_text

    canonical = soup.find("link", rel="canonical")
    if canonical and canonical.get("href"):
        page_url = canonical["href"]
    else:
        page_url = f"{SITE_ORIGIN}/tutorials/{path.name}"

    content_root = soup.find("article") or soup.find("div", class_="tutorial-content") or soup.body
    step_candidates = []
    if content_root:
        for h2 in content_root.find_all("h2"):
            t = h2.get_text(strip=True)
            if t and is_step_heading(t):
                step_candidates.append(t)
    step_headings = step_candidates[:12]

    date_modified = file_mtime_date(path)
    date_published = DEFAULT_PUBLISHED
    breadcrumb_items = extract_breadcrumb_items(soup, page_url)

    block = build_injection_block(
        raw,
        title=title_text,
        description=description,
        page_url=page_url,
        date_modified=date_modified,
        date_published=date_published,
        step_headings=step_headings,
        breadcrumb_items=breadcrumb_items,
    )
    new_raw = insert_before_close_head(raw, block)
    badge_html = f'<span class="badge badge-date">Updated {date_modified}</span>'
    new_raw, badge_added = insert_badge_in_row(new_raw, badge_html)

    schema_kind = "HowTo" if len(step_headings) >= 3 else "TechArticle"
    if dry:
        return ("dry", f"{schema_kind} (steps={len(step_headings)}, badge_added={badge_added})")

    path.write_text(new_raw, encoding="utf-8")
    return ("ok", f"{schema_kind} (steps={len(step_headings)}, badge={'y' if badge_added else 'n'})")


def main():
    args = sys.argv[1:]
    dry = "--dry" in args
    args = [a for a in args if a != "--dry"]
    if args:
        paths = [Path(a) for a in args]
    else:
        paths = sorted(TUTORIALS_DIR.glob("*.html"))

    counts = {"ok": 0, "skip": 0, "dry": 0, "err": 0}
    for p in paths:
        try:
            status, msg = process(p, dry)
        except Exception as e:
            status, msg = "err", repr(e)
        counts[status] = counts.get(status, 0) + 1
        prefix = {"ok": "[+]", "skip": "[-]", "dry": "[?]", "err": "[!]"}[status]
        print(f"{prefix} {p.name}: {msg}")
    print(f"\nSummary: {counts}")


if __name__ == "__main__":
    main()
