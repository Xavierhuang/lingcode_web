#!/usr/bin/env python3
"""
link_orphan_tutorials.py — give every tutorial at least one inbound sibling link.

The tutorial corpus is NOT the pure hub-and-spoke it looks like: 151 of the
154 English tutorials already carry a hand-written "What's next" block with
2-9 outbound links. The real gap is on the receiving side — 27 tutorials had
zero inbound links from any other tutorial, so the only path to them was
tutorials.html. Pages reachable only from a 154-link hub sit at the bottom of
the internal-link graph and get crawled least often.

Rather than bolt on a second "related" widget beside the curated one, this
appends the missing page into an existing .tutorial-next-grid on a sibling
from the same section, using the same markup and the same title and blurb the
hub already shows for it. The result is indistinguishable from the hand-written
cards, which is the point.

Donor choice is deterministic — the same-section sibling with the fewest
outbound links, ties broken by slug — so re-runs pick the same page and
produce no diff.

Idempotent: a tutorial that already has an inbound link is skipped entirely.

Usage:
  python3 scripts/seo/link_orphan_tutorials.py         # EN + ZH
  python3 scripts/seo/link_orphan_tutorials.py --dry   # report; no writes
"""

import html as htmllib
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pages  # noqa: E402

WEBSITE_DIR = pages.WEBSITE_DIR

LOCALES = (
    ("tutorials.html", "tutorials"),
    ("zh/tutorials.html", "zh/tutorials"),
)

SECTION_RE = re.compile(r'<h2 class="tutorial-section-title"[^>]*>(.*?)</h2>', re.S)
CARD_RE = re.compile(
    r'(?s)<div class="tutorial-card".*?<h3>(?P<title>.*?)</h3>\s*'
    r'<p>(?P<blurb>.*?)</p>.*?<a href="(?P<href>/(?:zh/)?tutorials/(?P<slug>[^"/]+)\.html)"'
)
GRID_RE = re.compile(r'(?s)(<div class="tutorial-next-grid">)(.*?)(</div>)')
LINK_RE = re.compile(r'href="/(?:zh/)?tutorials/([a-z0-9-]+)\.html"')


def text_of(fragment: str) -> str:
    return " ".join(htmllib.unescape(re.sub(r"<[^>]+>", " ", fragment)).split())


def attr(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def parse_hub(hub_rel: str) -> dict[str, dict]:
    """slug -> {section, title, blurb}, taken from the hub's own cards."""
    html_text = (WEBSITE_DIR / hub_rel).read_text(encoding="utf-8")
    # Walk headings and cards together so each card inherits the heading above it.
    marks = []
    for m in SECTION_RE.finditer(html_text):
        marks.append((m.start(), "section", text_of(m.group(1))))
    for m in CARD_RE.finditer(html_text):
        marks.append((m.start(), "card", m))
    marks.sort(key=lambda x: x[0])

    out: dict[str, dict] = {}
    section = "Tutorials"
    for _, kind, payload in marks:
        if kind == "section":
            section = payload
            continue
        slug = payload.group("slug")
        if slug in out:
            continue
        out[slug] = {
            "section": section,
            "title": text_of(payload.group("title")),
            "blurb": text_of(payload.group("blurb")),
        }
    return out


def outbound(rel: str) -> set[str]:
    s = (WEBSITE_DIR / rel).read_text(encoding="utf-8")
    own = Path(rel).stem
    return {x for x in LINK_RE.findall(s) if x != own}


def run_locale(hub_rel: str, dir_rel: str, dry: bool) -> int:
    hub = parse_hub(hub_rel)
    slugs = [s for s in hub if (WEBSITE_DIR / dir_rel / f"{s}.html").is_file()]

    links = {s: outbound(f"{dir_rel}/{s}.html") for s in slugs}
    inbound = {s: 0 for s in slugs}
    for targets in links.values():
        for t in targets:
            if t in inbound:
                inbound[t] += 1

    orphans = sorted(s for s in slugs if inbound[s] == 0)
    print(f"{dir_rel}: {len(slugs)} tutorial(s), {len(orphans)} with no inbound link")
    if not orphans:
        return 0

    # Only pages that already have a "What's next" grid can host a card.
    has_grid = {
        s: bool(GRID_RE.search((WEBSITE_DIR / dir_rel / f"{s}.html").read_text(encoding="utf-8")))
        for s in slugs
    }

    changed = 0
    for orphan in orphans:
        section = hub[orphan]["section"]
        eligible = [
            s for s in slugs
            if s != orphan and orphan not in links[s] and has_grid[s]
        ]
        candidates = [s for s in eligible if hub[s]["section"] == section]
        if not candidates:
            # A one-page section (or one whose members all link out already)
            # would otherwise leave the page orphaned. Falling back to the whole
            # corpus still picks the closest topical match, which beats nothing.
            candidates = eligible
        if not candidates:
            print(f"  SKIP {orphan}: no eligible donor anywhere")
            continue

        # Prefer a topically adjacent sibling over merely an under-linked one.
        # Slugs are descriptive ("buy-a-server-from-linode"), so shared tokens
        # are a decent proximity signal — it pairs the Linode guide with the
        # other server guides rather than with a domain-registrar one. Ties
        # break toward the least-linked page, then by slug, so runs are stable.
        want = set(orphan.split("-"))
        donor = max(candidates, key=lambda s: (len(want & set(s.split("-"))), -len(links[s]), s))

        path = WEBSITE_DIR / f"{dir_rel}/{donor}.html"
        s = path.read_text(encoding="utf-8")
        m = GRID_RE.search(s)
        if not m:
            print(f"  SKIP {orphan}: donor {donor} has no .tutorial-next-grid")
            continue

        prefix = "/zh" if dir_rel.startswith("zh/") else ""
        card = (
            f'\n          <a href="{prefix}/tutorials/{orphan}.html" class="tutorial-next-card">\n'
            f'            <h3>{attr(hub[orphan]["title"])}</h3>\n'
            f'            <p>{attr(hub[orphan]["blurb"])}</p>\n'
            f"          </a>\n        "
        )
        new_s = s[: m.end(2)] + card + s[m.end(2):]
        changed += 1
        links[donor].add(orphan)
        print(f"  {'would link' if dry else 'linked'} {orphan}  <- {donor}")
        if not dry:
            path.write_text(new_s, encoding="utf-8")
    return changed


def main() -> int:
    dry = "--dry" in sys.argv
    total = 0
    for hub_rel, dir_rel in LOCALES:
        if not (WEBSITE_DIR / hub_rel).is_file():
            continue
        total += run_locale(hub_rel, dir_rel, dry)
        print()
    print(f"{'Would add' if dry else 'Added'} {total} inbound link(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
