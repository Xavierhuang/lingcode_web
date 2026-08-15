#!/usr/bin/env python3
"""
pages.py — the single source of truth for "which pages are public and indexable".

Every other script in scripts/seo/ imports this. That is the point: the
sitemap drifted out of sync with robots.txt (it listed 9 Disallow'd URLs
while omitting 236 real pages) precisely because each consumer had its own
idea of what counted as a page. Change the rules here and the sitemap, the
meta injectors, and the checker all move together.

Two rules matter more than the rest:

  * The Disallow set is PARSED FROM robots.txt, never hardcoded. That is
    what makes sitemap/robots disagreement structurally impossible.

  * GENERATED_DOCS is read live from docs-src/cloud/navigation.json. Those
    20 files are produced by scripts/docs/build.mjs, and scripts/docs/check.mjs
    byte-compares them on every deploy under `set -e`. A bulk script that
    rewrites one of them hard-blocks every future deploy, so injectors must
    skip them and fix scripts/docs/template.mjs instead.

Run directly for a summary of what it currently sees:
    python3 scripts/seo/pages.py
"""

import json
import re
import subprocess
from datetime import date
from functools import lru_cache
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
WEBSITE_DIR = SCRIPT_DIR.parent.parent
SITE_ORIGIN = "https://lingcode.dev"

# Directories that are never web content: dependencies, build inputs, tooling,
# the API server (rsync-excluded), and binary asset bundles.
EXCLUDED_DIRS = {
    ".git", "node_modules", "server", "marketing", "pagefind",
    "docs-src", "scripts", "cloud-infra", "sdk", "schemas", "thumbnails",
    "lingcodebaby", "baby-assets", "ios-assets", "ftp-assets",
}

# Real files that should stay out of the index even though they are reachable.
EXCLUDED_PATHS = {
    "404.html",          # served via error_page; indexing it creates a soft-404
    "try/index.html",    # a <title>Redirecting…</title> stub, not a page
}

# Whole subtrees to keep out: demo scaffolding that would cannibalise brand terms.
EXCLUDED_PREFIXES = (
    "try/scaffold/",
    "try/templates/",
    "examples/",
)

NOINDEX_RE = re.compile(
    r'<meta[^>]+name=["\']robots["\'][^>]*content=["\'][^"\']*noindex', re.I
)


@lru_cache(maxsize=1)
def disallowed() -> frozenset[str]:
    """Paths Disallow'd for `User-agent: *` in robots.txt, as site-root paths."""
    robots = WEBSITE_DIR / "robots.txt"
    if not robots.is_file():
        return frozenset()
    out, in_star = set(), False
    for raw in robots.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        key, _, value = line.partition(":")
        key, value = key.strip().lower(), value.strip()
        if key == "user-agent":
            in_star = value == "*"
        elif key == "disallow" and in_star and value:
            out.add(value)
    return frozenset(out)


def is_disallowed(url_path: str) -> bool:
    """True if a site-root path (e.g. '/admin.html') is blocked by robots.txt."""
    for rule in disallowed():
        if rule.endswith("/"):
            if url_path.startswith(rule):
                return True
        elif url_path == rule:
            return True
    return False


@lru_cache(maxsize=1)
def generated_docs() -> frozenset[str]:
    """The docs/cloud/** pages written by scripts/docs/build.mjs. Never hand-edit."""
    nav = WEBSITE_DIR / "docs-src" / "cloud" / "navigation.json"
    if not nav.is_file():
        return frozenset()
    data = json.loads(nav.read_text(encoding="utf-8"))
    out = set()
    for section in data.get("sections", []):
        for page in section.get("pages", []):
            if page.get("output"):
                out.add(f"docs/cloud/{page['output']}")
    return frozenset(out)


GENERATED_DOCS = generated_docs


def all_html() -> list[str]:
    """Every .html file under the web root, excluding non-content directories."""
    out = []
    for path in WEBSITE_DIR.rglob("*.html"):
        rel = path.relative_to(WEBSITE_DIR)
        if set(rel.parts[:-1]) & EXCLUDED_DIRS or rel.parts[0] in EXCLUDED_DIRS:
            continue
        out.append(rel.as_posix())
    return sorted(out)


def is_noindex(rel: str) -> bool:
    path = WEBSITE_DIR / rel
    try:
        head = path.read_text(encoding="utf-8", errors="replace")[:4000]
    except OSError:
        return False
    return bool(NOINDEX_RE.search(head))


def indexable() -> list[str]:
    """Repo-relative paths of pages that belong in the sitemap and carry full meta."""
    out = []
    for rel in all_html():
        if rel in EXCLUDED_PATHS or rel.startswith(EXCLUDED_PREFIXES):
            continue
        if is_disallowed(url_path(rel)):
            continue
        if is_noindex(rel):
            continue
        out.append(rel)
    return out


def url_path(rel: str) -> str:
    """Site-root path for a file, matching nginx (`index index.html`, try_files)."""
    if rel == "index.html":
        return "/"
    if rel.endswith("/index.html"):
        return "/" + rel[: -len("index.html")]
    return "/" + rel


def url_for(rel: str) -> str:
    return SITE_ORIGIN + url_path(rel)


def alternates(rel: str) -> dict[str, str]:
    """en/zh/x-default alternates for a page, but only where both files exist.

    A one-sided hreflang cluster is worse than none: Google discards the whole
    cluster when the return tag is missing.
    """
    en = rel[3:] if rel.startswith("zh/") else rel
    zh = "zh/" + en
    if not (WEBSITE_DIR / en).is_file() or not (WEBSITE_DIR / zh).is_file():
        return {}
    return {"en": url_for(en), "zh": url_for(zh), "x-default": url_for(en)}


# The one-time "Commit current live site state as baseline" import. It brought
# 475 modified + 622 untracked files under version control in a single commit,
# so git dates every one of them to that day even though the content had not
# changed. Treat it as bookkeeping, not authorship, and look behind it.
BASELINE_IMPORT = "2cb40c6"


def _git(args: list[str]) -> str:
    try:
        res = subprocess.run(
            ["git", *args], cwd=WEBSITE_DIR,
            capture_output=True, text=True, timeout=15,
        )
        return res.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def _mtime(rel: str) -> str:
    try:
        return date.fromtimestamp((WEBSITE_DIR / rel).stat().st_mtime).isoformat()
    except OSError:
        return date.today().isoformat()


@lru_cache(maxsize=None)
def lastmod(rel: str) -> str:
    """Last-modified date as YYYY-MM-DD.

    Normally the date of the last commit that touched the file. Two fallbacks
    matter:

      * If that commit is the baseline import, the file did not really change
        then, so look at the commit before it. Without this every page in the
        sitemap shares one lastmod, which Google learns to ignore.
      * If the file was untracked before the import (622 of them were), there
        is no earlier commit, so use the file mtime — which still reflects the
        bulk publish that actually produced it.
    """
    out = _git(["log", "-1", "--format=%H %cs", "--", rel])
    if not out:
        return _mtime(rel)
    sha, _, stamp = out.partition(" ")
    if not sha.startswith(BASELINE_IMPORT):
        return stamp or _mtime(rel)

    earlier = _git(["log", "-1", "--format=%cs", f"{BASELINE_IMPORT}~1", "--", rel])
    return earlier or _mtime(rel)


def main() -> None:
    idx = indexable()
    gen = generated_docs()
    zh = [p for p in idx if p.startswith("zh/")]
    paired = [p for p in idx if alternates(p)]
    print(f"website root:        {WEBSITE_DIR}")
    print(f"robots Disallow:     {len(disallowed())} rules -> {sorted(disallowed())}")
    print(f"generated docs:      {len(gen)} files (never hand-edit)")
    print(f"html files found:    {len(all_html())}")
    print(f"indexable:           {len(idx)}  (en {len(idx) - len(zh)}, zh {len(zh)})")
    print(f"with en/zh twin:     {len(paired)}")
    print(f"excluded as noindex: {sum(1 for p in all_html() if is_noindex(p))}")


if __name__ == "__main__":
    main()
