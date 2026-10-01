#!/usr/bin/env python3
"""Write the one site footer into every public page: scripts/footer.html on the
English pages, scripts/footer.zh.html on the Chinese ones. Chinese pages still
on the old <header class="nav-bar"> also get the site nav (scripts/nav.zh.html)
the English site switched to in May.

The footer was hand-copied into each page and drifted: some pages lost the
Forum / Trust / DPA links, customer-policies.html and changelog.html had none.
Run this after editing scripts/footer.html (and after adding a page):

    python3 website/scripts/sync_footer.py          # write
    python3 website/scripts/sync_footer.py --check  # exit 1 if any page differs

Each page's footer ends up between <!-- footer:start --> and <!-- footer:end -->
markers, so later runs replace exactly that block. A page with no footer yet
gets one before its closing scripts.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

WEBSITE = Path(__file__).resolve().parents[1]


def _partial(name: str) -> str:
    text = (WEBSITE / "scripts" / name).read_text(encoding="utf-8")
    return "\n".join(l for l in text.splitlines() if not l.startswith("<!-- The ")).strip()


BLOCKS = {
    lang: f"<!-- footer:start -->\n{_partial(name)}\n<!-- footer:end -->"
    for lang, name in (("en", "footer.html"), ("zh", "footer.zh.html"))
}
ZH_NAV = _partial("nav.zh.html")

# Pages that keep their own footer on purpose.
EXCLUDE = {
    "baby.html", "ftp.html", "ios.html",  # separate products, their own brand footers
    "admin.html",                          # internal
}
# Public pages that had no footer at all and should get one.
ADD = {"changelog.html", "customer-policies.html", "blog.html"}

MARKED = re.compile(r"<!-- footer:start -->.*?<!-- footer:end -->", re.S)
FOOTER_EL = re.compile(r"<footer\b[^>]*>.*?</footer>", re.S)
OLD_ZH_HEADER = re.compile(r'<header class="nav-bar">.*?</header>', re.S)


def targets() -> list[tuple[Path, str]]:
    pages = [(p, "en") for p in sorted(WEBSITE.glob("*.html")) + sorted(WEBSITE.glob("blog/*.html"))
             + sorted(WEBSITE.glob("insights/*.html"))]
    pages += [(p, "zh") for p in sorted(WEBSITE.glob("zh/*.html")) + sorted(WEBSITE.glob("zh/blog/*.html"))]
    out = []
    for p, lang in pages:
        rel = p.relative_to(WEBSITE).as_posix()
        name = rel.removeprefix("zh/")
        if name in EXCLUDE:
            continue
        text = p.read_text(encoding="utf-8")
        if MARKED.search(text) or FOOTER_EL.search(text) or name in ADD:
            out.append((p, lang))
    return out


def synced(text: str, lang: str) -> str:
    block = BLOCKS[lang]
    if lang == "zh" and OLD_ZH_HEADER.search(text):
        text = OLD_ZH_HEADER.sub(lambda _: ZH_NAV, text, count=1)
    if MARKED.search(text):
        return MARKED.sub(lambda _: block, text, count=1)
    if FOOTER_EL.search(text):
        return FOOTER_EL.sub(lambda _: block, text, count=1)
    # No footer: place it after </main> if there is one, else before </body>.
    if "</main>" in text:
        return text.replace("</main>", "</main>\n\n  " + block, 1)
    return text.replace("</body>", block + "\n</body>", 1)


def main() -> int:
    check = "--check" in sys.argv
    changed = []
    for p, lang in targets():
        text = p.read_text(encoding="utf-8")
        new = synced(text, lang)
        if new != text:
            changed.append(p.relative_to(WEBSITE).as_posix())
            if not check:
                p.write_text(new, encoding="utf-8")
    if check:
        if changed:
            print("footer differs on:", ", ".join(changed))
            return 1
        print("footer in sync")
        return 0
    print(f"footer written to {len(changed)} page(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
