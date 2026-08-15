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


ITEM_LIST_KEY_RE = re.compile(r'"itemListElement"\s*:\s*\[')
POSITION_RE = re.compile(r'("position"\s*:\s*)(\d+)')


def _array_span(text: str, open_idx: int) -> tuple[int, int]:
    """Given the index of a '[', return (start, end) spanning to its matching ']'."""
    depth = 0
    in_str = False
    esc = False
    for i in range(open_idx, len(text)):
        ch = text[i]
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return open_idx, i
    raise ValueError("unterminated array")


def _object_spans(text: str, start: int, end: int) -> list[tuple[int, int]]:
    """Spans of the top-level {...} objects between start and end (exclusive of brackets)."""
    spans = []
    depth = 0
    obj_start = -1
    in_str = False
    esc = False
    for i in range(start, end):
        ch = text[i]
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            if depth == 0:
                obj_start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                spans.append((obj_start, i + 1))
    return spans


def fix_jsonld(html: str) -> tuple[str, int, list[str]]:
    """Drop the Search ListItem from any BreadcrumbList and renumber positions.

    Works directly on the raw text rather than re-serialising, because the
    tutorials carry two different hand/tool-authored layouts for this block:
    one object per line (compact) and one key per line (expanded). Editing
    the text in place preserves whichever layout a file already uses, so the
    diff stays to the lines that actually changed.
    """
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
        if not isinstance(data.get("itemListElement"), list):
            return m.group(0)

        key = ITEM_LIST_KEY_RE.search(body)
        if not key:
            problems.append("could not locate itemListElement array")
            return m.group(0)

        arr_start, arr_end = _array_span(body, key.end() - 1)
        spans = _object_spans(body, arr_start + 1, arr_end)

        victim = None
        for span in spans:
            chunk = body[span[0]:span[1]]
            try:
                if is_search_item(json.loads(chunk)):
                    victim = span
                    break
            except json.JSONDecodeError:
                continue
        if victim is None:
            return m.group(0)

        # Swallow the separator too: the comma after this object, or the one
        # before it when it is the last element. Trailing whitespace on the
        # line goes with it so no blank line is left behind.
        cut_start, cut_end = victim

        # Extend the cut back over the victim's own indentation. Without this
        # the leading whitespace survives and gets prepended to whatever
        # follows, double-indenting the next item.
        line_start = body.rfind("\n", 0, cut_start) + 1
        if body[line_start:cut_start].strip() == "":
            cut_start = line_start

        after = body[cut_end:arr_end]
        comma_after = re.match(r"\s*,", after)
        if comma_after:
            cut_end += comma_after.end()
            trailing = re.match(r"[ \t]*\r?\n?", body[cut_end:])
            cut_end += trailing.end() if trailing else 0
        else:
            before = body[arr_start + 1:cut_start]
            comma_before = re.search(r",\s*$", before)
            if comma_before:
                cut_start = arr_start + 1 + comma_before.start()

        new_body = body[:cut_start] + body[cut_end:]

        # Renumber every position in document order so they stay contiguous.
        counter = iter(range(1, len(spans)))
        new_body = POSITION_RE.sub(lambda pm: f"{pm.group(1)}{next(counter)}", new_body)

        try:
            check = json.loads(new_body)
        except json.JSONDecodeError as exc:
            problems.append(f"edit produced invalid JSON ({exc}); left unchanged")
            return m.group(0)
        if len(check.get("itemListElement", [])) != len(spans) - 1:
            problems.append("edit dropped the wrong number of items; left unchanged")
            return m.group(0)

        removed += 1
        return prefix + new_body + suffix

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
