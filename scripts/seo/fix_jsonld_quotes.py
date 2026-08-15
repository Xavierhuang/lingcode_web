#!/usr/bin/env python3
"""
fix_jsonld_quotes.py — repair invalid JSON-LD on Chinese tutorial pages.

41 pages under zh/ ship structured data that does not parse. The cause is
that the Chinese copy uses plain ASCII U+0022 as its quotation marks, and
those quotes were interpolated into JSON string values without escaping:

    "description": ""应该可以"和"已验证可以"是两种不同的状态。…",
                    ^ terminates the string here

Everything after that point is a syntax error, so Google discards the
entire block — these pages get no structured-data benefit at all. No
English page is affected.

The repair replaces each *interior* quote with the correct Chinese
typographic pair (U+201C “ / U+201D ”), toggling open/close. That yields
valid JSON and is also the typographically correct mark for Chinese text,
so it is a real fix rather than a workaround. Structural JSON quotes —
the ones delimiting keys and values — are matched separately and never
touched.

Only blocks that currently FAIL to parse are considered, and a repaired
block is written only if it then parses. Anything still broken afterwards
is reported for manual review rather than written.

Idempotent: valid blocks are skipped, so re-running is a no-op.

Usage:
  python3 scripts/seo/fix_jsonld_quotes.py          # scan the whole site
  python3 scripts/seo/fix_jsonld_quotes.py <files>  # only the listed files
  python3 scripts/seo/fix_jsonld_quotes.py --dry    # report; no writes
"""

import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
WEBSITE_DIR = SCRIPT_DIR.parent.parent

SKIP_DIRS = ("node_modules", "server", "marketing", "pagefind", ".git")

LD_BLOCK_RE = re.compile(
    r'(?s)(<script type="application/ld\+json">\s*)(\{.*?\})(\s*</script>)'
)
# A single `"key": "value"` line, with the value captured separately from the
# structural quotes that delimit it. `.*` is greedy so the final quote of the
# line is the closing delimiter, which is what makes interior quotes fall
# inside group 2.
VALUE_LINE_RE = re.compile(r'^(\s*"[^"]+":\s*")(.*?)("(?:,)?)$')

OPEN_Q, CLOSE_Q = "“", "”"


def repair_value(value: str) -> str:
    """Replace interior ASCII quotes with paired Chinese typographic quotes."""
    out = []
    open_next = True
    for ch in value:
        if ch == '"':
            out.append(OPEN_Q if open_next else CLOSE_Q)
            open_next = not open_next
        else:
            out.append(ch)
    return "".join(out)


def repair_block(body: str) -> str:
    lines = []
    for line in body.split("\n"):
        m = VALUE_LINE_RE.match(line)
        if m and '"' in m.group(2):
            line = m.group(1) + repair_value(m.group(2)) + m.group(3)
        lines.append(line)
    return "\n".join(lines)


def process(html: str) -> tuple[str, int, int]:
    """Returns (new_html, repaired_count, still_broken_count)."""
    repaired = still_broken = 0

    def repl(m: re.Match) -> str:
        nonlocal repaired, still_broken
        prefix, body, suffix = m.group(1), m.group(2), m.group(3)
        try:
            json.loads(body)
            return m.group(0)  # already valid — leave completely alone
        except json.JSONDecodeError:
            pass

        fixed = repair_block(body)
        try:
            json.loads(fixed)
        except json.JSONDecodeError:
            still_broken += 1
            return m.group(0)

        repaired += 1
        return prefix + fixed + suffix

    return LD_BLOCK_RE.sub(repl, html), repaired, still_broken


def targets(argv: list[str]) -> list[Path]:
    files = [WEBSITE_DIR / a for a in argv if not a.startswith("--")]
    if files:
        return files
    out = []
    for p in sorted(WEBSITE_DIR.rglob("*.html")):
        rel = p.relative_to(WEBSITE_DIR)
        if rel.parts and rel.parts[0] in SKIP_DIRS:
            continue
        out.append(p)
    return out


def main() -> int:
    dry = "--dry" in sys.argv
    files = targets(sys.argv[1:])

    changed = repaired_total = broken_total = 0
    unfixed: list[Path] = []

    for path in files:
        if not path.is_file():
            continue
        original = path.read_text(encoding="utf-8")
        if "application/ld+json" not in original:
            continue

        html, repaired, still_broken = process(original)
        if still_broken:
            unfixed.append(path)
            broken_total += still_broken
        if html == original:
            continue

        changed += 1
        repaired_total += repaired
        print(f"  {'would repair' if dry else 'repaired'} {path.relative_to(WEBSITE_DIR)} ({repaired} block(s))")
        if not dry:
            path.write_text(html, encoding="utf-8")

    print(
        f"\n{'Would repair' if dry else 'Repaired'} {repaired_total} JSON-LD block(s) "
        f"across {changed} file(s)."
    )
    if unfixed:
        print(f"\n{broken_total} block(s) in {len(unfixed)} file(s) still do not parse:")
        for p in unfixed:
            print(f"  {p.relative_to(WEBSITE_DIR)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
