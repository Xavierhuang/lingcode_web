#!/usr/bin/env python3
"""
fix_breadcrumbs.py — remove the stray "Search" node from tutorial breadcrumbs.

A previous bulk pass (`add_nav_search.py`, since deleted — nav.js:25-27 still
references it) inserted a search link into the page nav. On tutorial pages it
landed *inside* the `.tutorial-breadcrumb` div instead of alongside it:

    <div class="tutorial-breadcrumb">
          <a href="/tutorials.html">Tutorials</a>
            <a href="/search.html">Search</a>      <-- artifact, no separator
          <span>/</span>
          <a href="/tutorials.html?level=intermediate">Native Mac IDE</a>

`inject-tutorial-geo.py` then built each page's BreadcrumbList JSON-LD by
scraping that div, so it faithfully copied the artifact into the structured
data as position 3. The result: 200 tutorials publish a breadcrumb reading
`Home > Tutorials > Search > <Category> > <Page>` to Google's breadcrumb
rich results.

This script fixes both halves:
  - drops the `<a href=".../search.html">` node from the breadcrumb div
  - drops the matching ListItem from the BreadcrumbList and renumbers
    the remaining positions to be contiguous from 1

Mutation is surgical. The DOM fix deletes whole lines; the JSON-LD fix
re-serialises with the same `json.dumps(indent=2, ensure_ascii=False)`
settings the original injector used, and *asserts* the untouched parts
round-trip byte-identically before writing. Anything that fails that
assertion is skipped and reported rather than rewritten.

Idempotent: re-running finds nothing to do and writes nothing.

Usage:
  python3 scripts/seo/fix_breadcrumbs.py          # all tutorials, EN + ZH
  python3 scripts/seo/fix_breadcrumbs.py <files>  # only the listed files
  python3 scripts/seo/fix_breadcrumbs.py --dry    # report; no writes
"""

import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
WEBSITE_DIR = SCRIPT_DIR.parent.parent

# The breadcrumb label used for the artifact, per locale.
SEARCH_LABELS = {"Search", "搜索"}

BREADCRUMB_DIV_RE = re.compile(r'(?s)<div class="tutorial-breadcrumb">.*?</div>')
# The artifact occupies its own line; take the whole line including its newline
# so the surrounding indentation is left untouched.
SEARCH_ANCHOR_LINE_RE = re.compile(
    r'^[ \t]*<a href="(?:/zh)?/search\.html"[^>]*>(?:Search|搜索)</a>[ \t]*\r?\n',
    re.MULTILINE,
)
LD_BLOCK_RE = re.compile(
    r'(?s)(<script type="application/ld\+json">\s*)(\{.*?\})(\s*</script>)'
)


def is_search_item(item: dict) -> bool:
    """A ListItem is the artifact if it is both labelled Search and points at search.html."""
    name = (item.get("name") or "").strip()
    url = (item.get("item") or "")
    return name in SEARCH_LABELS and "search.html" in url


def fix_dom(html: str) -> tuple[str, int]:
    """Delete the stray search anchor from inside the breadcrumb div only."""
    removed = 0

    def repl(m: re.Match) -> str:
        nonlocal removed
        div = m.group(0)
        new_div, n = SEARCH_ANCHOR_LINE_RE.subn("", div)
        removed += n
        return new_div

    return BREADCRUMB_DIV_RE.sub(repl, html), removed


def fix_jsonld(html: str) -> tuple[str, int, list[str]]:
    """Drop the Search ListItem from any BreadcrumbList and renumber positions."""
    removed = 0
    problems: list[str] = []

    def repl(m: re.Match) -> str:
        nonlocal removed
        prefix, body, suffix = m.group(1), m.group(2), m.group(3)
        try:
            data = json.loads(body)
        except json.JSONDecodeError as exc:
            problems.append(f"unparseable JSON-LD ({exc})")
            return m.group(0)

        if not isinstance(data, dict) or data.get("@type") != "BreadcrumbList":
            return m.group(0)

        items = data.get("itemListElement")
        if not isinstance(items, list):
            return m.group(0)

        # Guard: only rewrite when we can reproduce the original byte-for-byte.
        # If the source used different dump settings, leave it alone rather
        # than reformat the whole block and bury the real fix in noise.
        if json.dumps(data, indent=2, ensure_ascii=False) != body.strip():
            problems.append("JSON-LD does not round-trip; left unchanged")
            return m.group(0)

        kept = [it for it in items if not (isinstance(it, dict) and is_search_item(it))]
        if len(kept) == len(items):
            return m.group(0)

        for i, it in enumerate(kept, start=1):
            it["position"] = i
        data["itemListElement"] = kept
        removed += len(items) - len(kept)
        return prefix + json.dumps(data, indent=2, ensure_ascii=False) + suffix

    return LD_BLOCK_RE.sub(repl, html), removed, problems


def targets(argv: list[str]) -> list[Path]:
    files = [WEBSITE_DIR / a for a in argv if not a.startswith("--")]
    if files:
        return files
    return sorted(
        list((WEBSITE_DIR / "tutorials").glob("*.html"))
        + list((WEBSITE_DIR / "zh" / "tutorials").glob("*.html"))
    )


def main() -> int:
    dry = "--dry" in sys.argv
    files = targets(sys.argv[1:])
    if not files:
        print("no tutorial files found", file=sys.stderr)
        return 1

    changed = dom_total = ld_total = 0
    all_problems: list[tuple[Path, str]] = []

    for path in files:
        if not path.is_file():
            print(f"  MISSING {path}", file=sys.stderr)
            continue
        original = path.read_text(encoding="utf-8")

        html, dom_n = fix_dom(original)
        html, ld_n, problems = fix_jsonld(html)
        for p in problems:
            all_problems.append((path, p))

        if html == original:
            continue

        changed += 1
        dom_total += dom_n
        ld_total += ld_n
        rel = path.relative_to(WEBSITE_DIR)
        print(f"  {'would fix' if dry else 'fixed'} {rel}  (dom={dom_n} jsonld={ld_n})")
        if not dry:
            path.write_text(html, encoding="utf-8")

    print(
        f"\n{'Would change' if dry else 'Changed'} {changed} file(s) of {len(files)} "
        f"— removed {dom_total} DOM node(s), {ld_total} ListItem(s)."
    )
    if all_problems:
        print(f"\n{len(all_problems)} file(s) needed manual review:")
        for path, msg in all_problems:
            print(f"  {path.relative_to(WEBSITE_DIR)}: {msg}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
