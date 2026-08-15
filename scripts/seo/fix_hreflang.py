#!/usr/bin/env python3
"""
fix_hreflang.py — make the en/zh hreflang clusters correct and reciprocal.

Google treats a hreflang cluster as all-or-nothing: if page A names B as its
Chinese alternate and B does not name A back — or if the alternate 404s —
the *entire* cluster is discarded, not just the broken edge. Two classes of
defect were present:

  1. DANGLING. Two English tutorials declared a zh alternate pointing at a
     file that does not exist, poisoning their own cluster.

  2. MISSING. 18 pages had a Chinese twin sitting on disk but never declared
     it, so those translations were invisible as alternates — pricing.html
     and 16 Cloud docs pages among them.

Both directions are repaired from pages.alternates(), which only pairs files
that BOTH exist, so this script cannot itself create a dangling link.

Generated docs (docs/cloud/** listed in navigation.json) are skipped: editing
them breaks `scripts/docs/check.mjs` and therefore every future deploy. Fix
those in scripts/docs/template.mjs instead. The script reports any it had to
skip so they are not silently forgotten.

Per-file tag style is preserved — pricing.html closes its <link> tags with
` />` while the tutorials use `>`, so the emitted tag copies whatever the
neighbouring alternate on that page already uses.

Idempotent: a correct page is left byte-identical.

Usage:
  python3 scripts/seo/fix_hreflang.py          # whole site
  python3 scripts/seo/fix_hreflang.py <files>  # only the listed files
  python3 scripts/seo/fix_hreflang.py --dry    # report; no writes
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pages  # noqa: E402

WEBSITE_DIR = pages.WEBSITE_DIR

ALT_RE = re.compile(
    r'^(?P<indent>[ \t]*)<link\s+rel="alternate"\s+hreflang="(?P<lang>[^"]+)"\s+'
    r'href="(?P<href>[^"]+)"\s*(?P<close>/?)>[ \t]*\r?\n',
    re.MULTILINE,
)


def fix_page(rel: str) -> tuple[str, str, list[str]]:
    """Returns (original_html, new_html, notes). Writes nothing; caller decides."""
    path = WEBSITE_DIR / rel
    html = path.read_text(encoding="utf-8")
    notes: list[str] = []

    found = list(ALT_RE.finditer(html))
    if not found:
        return html, html, notes

    want = pages.alternates(rel)
    new_html = html

    # 1. Drop any alternate whose target does not exist on disk.
    for m in reversed(found):
        lang, href = m.group("lang"), m.group("href")
        if lang == "x-default":
            continue
        target = href.replace(pages.SITE_ORIGIN + "/", "")
        if target == "":
            target = "index.html"
        elif target.endswith("/"):
            target += "index.html"
        if not (WEBSITE_DIR / target).is_file():
            new_html = new_html[: m.start()] + new_html[m.end():]
            notes.append(f"removed dangling hreflang={lang} -> {href}")

    # 2. Add the zh alternate when a twin exists but was never declared.
    if want:
        present = {m.group("lang") for m in ALT_RE.finditer(new_html)}
        anchor = None
        for m in ALT_RE.finditer(new_html):
            if m.group("lang") == "en":
                anchor = m
                break
        for lang in ("en", "zh", "x-default"):
            if lang in present or anchor is None:
                continue
            tag = (
                f'{anchor.group("indent")}<link rel="alternate" hreflang="{lang}" '
                f'href="{want[lang]}"{" /" if anchor.group("close") else ""}>\n'
            )
            new_html = new_html[: anchor.end()] + tag + new_html[anchor.end():]
            notes.append(f"added hreflang={lang} -> {want[lang]}")

    return html, new_html, notes


def main() -> int:
    dry = "--dry" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    targets = args or pages.indexable()
    generated = pages.generated_docs()

    changed = 0
    skipped_generated: list[str] = []

    for rel in targets:
        if rel in generated:
            path = WEBSITE_DIR / rel
            if path.is_file() and pages.alternates(rel):
                html = path.read_text(encoding="utf-8")
                if 'hreflang="zh"' not in html:
                    skipped_generated.append(rel)
            continue
        if not (WEBSITE_DIR / rel).is_file():
            continue

        original, new_html, notes = fix_page(rel)
        if new_html == original:
            continue
        changed += 1
        print(f"  {'would fix' if dry else 'fixed'} {rel}")
        for n in notes:
            print(f"      {n}")
        if not dry:
            (WEBSITE_DIR / rel).write_text(new_html, encoding="utf-8")

    print(f"\n{'Would change' if dry else 'Changed'} {changed} file(s) of {len(targets)}.")
    if skipped_generated:
        print(
            f"\n{len(skipped_generated)} GENERATED doc(s) still need a zh alternate. "
            "Fix scripts/docs/template.mjs and rerun scripts/docs/build.mjs:"
        )
        for rel in skipped_generated:
            print(f"  {rel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
