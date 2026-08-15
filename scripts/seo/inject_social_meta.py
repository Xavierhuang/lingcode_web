#!/usr/bin/env python3
"""
inject_social_meta.py — give every public page a complete social/meta head.

356 of 456 pages had no og:title — including all 154 English tutorials and
141 of 151 Chinese ones. Every tutorial shared to X, LinkedIn or Slack
rendered as a bare URL with no headline, image or summary, which throws away
the social distribution that seeds early rankings. A smaller set was missing
rel=canonical entirely, leaving Google to pick a canonical on its own.

Injected, each guarded individually so an existing value is never overwritten:

    <meta name="robots" content="index, follow">
    <link rel="canonical" href="...">
    <meta property="og:type" content="website|article">
    <meta property="og:url" content="{canonical}">
    <meta property="og:title" content="{title minus brand suffix}">
    <meta property="og:description" content="{meta description}">
    <meta property="og:image" content="{site og-image}">
    <meta property="og:locale" content="en_US|zh_CN">
    <meta property="og:site_name" content="LingCode">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="{og:title}">
    <meta name="twitter:description" content="{og:description}">

Two details that matter:

  * Tag style is copied per file. pricing.html and zh/pricing.html close
    their <link> tags with " />"; the tutorials use ">". Emitting the wrong
    one would look like a mistake in every future diff of those files.

  * og:title strips only KNOWN brand suffixes ("— LingCode Tutorials",
    "| LingCode Cloud Docs", "— LingCode 教程", …). It does not strip the
    last segment blindly, because several titles carry real content after
    the separator ("… — every field, with examples | LingCode").

Description falls back from <meta name="description"> to the page's .tldr
paragraph and then .intro. Pages where none of the three exist are reported
rather than given filler — a fabricated summary is worse than none.

Generated docs (docs/cloud/** from navigation.json) are skipped and reported;
they are fixed in scripts/docs/template.mjs, because editing them directly
breaks scripts/docs/check.mjs and therefore every future deploy.

Idempotent via the sentinel `<!-- seo-meta:v2 -->` plus per-tag guards.

Usage:
  python3 scripts/seo/inject_social_meta.py          # all indexable pages
  python3 scripts/seo/inject_social_meta.py <files>  # only the listed files
  python3 scripts/seo/inject_social_meta.py --dry    # report; no writes
"""

import html as htmllib
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pages  # noqa: E402

WEBSITE_DIR = pages.WEBSITE_DIR
SENTINEL = "seo-meta:v2"
OG_IMAGE = f"{pages.SITE_ORIGIN}/og-image.png"

TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S | re.I)
CANON_RE = re.compile(r'<link[^>]+rel=["\']canonical["\'][^>]*>', re.I)
CLOSE_HEAD_RE = re.compile(r"([ \t]*)</head>", re.I)
SELF_CLOSING_RE = re.compile(r'<link[^>]+rel=["\'](?:canonical|alternate)["\'][^>]*?/>', re.I)
HTML_LANG_RE = re.compile(r'<html[^>]+lang=["\']([^"\']+)["\']', re.I)

# Prose fallbacks, in priority order. .tldr is the TL;DR paragraph that
# rewrite-top30-tutorials.py added and makes a better snippet than .intro.
PROSE_RES = (
    re.compile(r'<p[^>]+class=["\'][^"\']*\btldr\b[^"\']*["\'][^>]*>(.*?)</p>', re.S | re.I),
    re.compile(r'<p[^>]+class=["\'][^"\']*\bintro\b[^"\']*["\'][^>]*>(.*?)</p>', re.S | re.I),
)

# Longest first so "— LingCode Cloud | Docs" wins over "| Docs".
BRAND_SUFFIXES = sorted(
    (
        " — LingCode Tutorials", " — LingCode 教程", " — LingCode Insights",
        " — LingCode Cloud | Docs", " | LingCode Cloud Docs", " | LingCode Cloud 文档",
        " | Tutorials", " | 教程", " | 文档",
        " — LingCode", " | LingCode", " - LingCode",
    ),
    key=len, reverse=True,
)


def text_of(fragment: str) -> str:
    """Strip tags and collapse whitespace, for use inside an attribute."""
    return " ".join(htmllib.unescape(re.sub(r"<[^>]+>", " ", fragment)).split())


def attr(value: str) -> str:
    """Escape for a double-quoted HTML attribute."""
    return (
        value.replace("&", "&amp;").replace('"', "&quot;")
        .replace("<", "&lt;").replace(">", "&gt;")
    )


def strip_brand(title: str) -> str:
    for suffix in BRAND_SUFFIXES:
        if title.endswith(suffix):
            return title[: -len(suffix)].strip(" |—-")
    return title


def describe(html_text: str) -> str | None:
    existing = pages.meta_map(html_text).get("description", "")
    if existing.strip():
        return text_of(existing)
    for rx in PROSE_RES:
        m = rx.search(html_text)
        if m and text_of(m.group(1)):
            return text_of(m.group(1))
    return None


def build_tags(rel: str, html_text: str, self_closing: bool) -> tuple[list[str], list[str]]:
    """Returns (tags_to_insert, problems)."""
    problems: list[str] = []
    close = " /" if self_closing else ""

    title_m = TITLE_RE.search(html_text)
    if not title_m or not title_m.group(1).strip():
        return [], [f"{rel}: no <title>; skipped"]
    og_title = strip_brand(text_of(title_m.group(1)))

    description = describe(html_text)
    if description is None:
        problems.append(f"{rel}: no description, .tldr or .intro to derive from")

    lang = HTML_LANG_RE.search(html_text)
    locale = "zh_CN" if (lang and lang.group(1).lower().startswith("zh")) else "en_US"
    canonical = pages.url_for(rel)
    is_article = rel.startswith(("tutorials/", "zh/tutorials/", "insights/"))

    wanted: list[tuple[str, str, str]] = [
        ("name", "robots", "index, follow"),
        ("property", "og:type", "article" if is_article else "website"),
        ("property", "og:url", canonical),
        ("property", "og:title", og_title),
        ("property", "og:image", OG_IMAGE),
        ("property", "og:locale", locale),
        ("property", "og:site_name", "LingCode"),
        ("name", "twitter:card", "summary_large_image"),
        ("name", "twitter:title", og_title),
    ]
    if description:
        wanted += [
            ("property", "og:description", description),
            ("name", "twitter:description", description),
        ]

    existing = pages.meta_map(html_text)
    tags: list[str] = []
    if not CANON_RE.search(html_text):
        tags.append(f'<link rel="canonical" href="{attr(canonical)}"{close}>')
    for kind, key, value in wanted:
        # Guard per tag: never overwrite a value someone chose deliberately.
        if key in existing:
            continue
        tags.append(f'<meta {kind}="{key}" content="{attr(value)}">')
    return tags, problems


def main() -> int:
    dry = "--dry" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    targets = args or pages.indexable()
    generated = pages.generated_docs()

    changed = 0
    all_problems: list[str] = []
    skipped_generated = 0

    for rel in targets:
        if rel in generated:
            skipped_generated += 1
            continue
        path = WEBSITE_DIR / rel
        if not path.is_file():
            continue
        html_text = path.read_text(encoding="utf-8")

        self_closing = bool(SELF_CLOSING_RE.search(html_text))
        tags, problems = build_tags(rel, html_text, self_closing)
        all_problems += problems
        if not tags:
            continue

        m = CLOSE_HEAD_RE.search(html_text)
        if not m:
            all_problems.append(f"{rel}: no </head>; skipped")
            continue
        indent = m.group(1) or "  "

        block = f"{indent}<!-- {SENTINEL} -->\n" if SENTINEL not in html_text else ""
        block += "".join(f"{indent}{t}\n" for t in tags)
        new_html = html_text[: m.start()] + block + html_text[m.start():]

        changed += 1
        print(f"  {'would update' if dry else 'updated'} {rel} (+{len(tags)} tag(s))")
        if not dry:
            path.write_text(new_html, encoding="utf-8")

    print(f"\n{'Would change' if dry else 'Changed'} {changed} page(s) of {len(targets)}.")
    if skipped_generated:
        print(f"skipped {skipped_generated} generated doc(s) — fix scripts/docs/template.mjs")
    if all_problems:
        print(f"\n{len(all_problems)} page(s) need attention:")
        for p in all_problems:
            print(f"  {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
