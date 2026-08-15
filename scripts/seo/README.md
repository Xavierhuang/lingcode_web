# scripts/seo

Tooling that keeps the site's SEO invariants true. Grew out of an audit that
found the sitemap listing 220 URLs for a 426-page site, 356 pages with no
`og:title`, 200 tutorials publishing a corrupted breadcrumb, 41 Chinese pages
shipping JSON-LD that did not parse, and analytics firing on 14% of pages.

Everything here is **idempotent**: running it twice is a no-op, and running it
after someone edits a page by hand only touches what is actually missing.

## The one rule

`pages.py` is the single source of truth for "what is a public page". Every
other script imports it. The sitemap drifted out of sync with `robots.txt` in
the first place because each consumer had its own idea of what counted, so:

- the `Disallow` set is **parsed from `robots.txt`**, never hardcoded;
- the 20 generated docs are **read from `docs-src/cloud/navigation.json`**.

Add an exclusion in `robots.txt` and the sitemap, the injectors and the checker
all follow automatically.

## Do not hand-edit the generated docs

`docs/cloud/**` listed in `navigation.json` is produced by
`scripts/docs/build.mjs`. `scripts/docs/check.mjs` byte-compares that output on
every deploy under `set -e`, so **editing one of those files blocks every
future deploy**. All the injectors skip them and say so. Their head is defined
in `scripts/docs/template.mjs`; change it there and re-run:

```sh
node scripts/docs/build.mjs && node scripts/docs/check.mjs
```

## Scripts

| Script | What it does |
|---|---|
| `pages.py` | Shared inventory. Run it directly for a summary of what it sees. |
| `check_seo.py` | Asserts every invariant. Run by `deploy.sh`; exits non-zero on error. |
| `gen_sitemap.py` | Writes `sitemap.xml` (index) + `sitemap-en.xml` + `sitemap-zh.xml`. |
| `inject_social_meta.py` | og:/twitter:/canonical/robots on every page. Sentinel `seo-meta:v2`. |
| `inject_analytics.py` | Loads `/analytics.js` on every page. |
| `fix_breadcrumbs.py` | Removes the stray "Search" node from tutorial breadcrumbs. |
| `fix_hreflang.py` | Drops dangling alternates, adds missing zh ones, enforces reciprocity. |
| `fix_jsonld_quotes.py` | Repairs Chinese JSON-LD broken by unescaped ASCII quotes. |
| `gen_hub_schema.py` | CollectionPage + ItemList on the tutorial hubs. Sentinel `hub-schema:v1`. |
| `link_orphan_tutorials.py` | Gives every tutorial an inbound link from a topical sibling. |

All accept `--dry` and an explicit file list:

```sh
python3 scripts/seo/inject_social_meta.py --dry            # preview everything
python3 scripts/seo/inject_social_meta.py tutorials/x.html # one file
```

## Normal workflow

`deploy.sh` runs `gen_sitemap.py` then `check_seo.py` automatically
(`SKIP_SEO=1` to bypass in an emergency). After adding or editing pages by
hand, the useful sequence is:

```sh
python3 scripts/seo/inject_analytics.py
python3 scripts/seo/inject_social_meta.py
python3 scripts/seo/fix_hreflang.py
python3 scripts/seo/gen_hub_schema.py          # only if the tutorial hub changed
python3 scripts/seo/link_orphan_tutorials.py   # only if tutorials were added
python3 scripts/seo/check_seo.py
```

`check_seo.py` distinguishes **errors** (block the deploy) from **warnings**
(title over 60 chars, description outside 120-160). Warnings are deliberately
not fatal — a 62-character title is worth knowing about, not worth refusing to
ship over. There are ~400 of them; they are a content backlog, not a defect.

## Gotchas worth knowing

- **Attribute order varies.** `try.html` writes `<meta content="…" name="…"/>`,
  everything else writes name first. Use `pages.meta_map()`, never a regex that
  assumes an order.
- **Angle brackets inside attributes.** `docs/cloud/api-reference.html`
  documents `/api/cloud/be/<id>/`. `pages.meta_map()` honours quotes when
  finding a tag's end; a plain `<meta[^>]*>` truncates mid-attribute.
- **Tag style is per-file.** `pricing.html` closes `<link>` with ` />`.
  The injector copies whatever a page already uses.
- **`lastmod` looks through the baseline import commit** (`2cb40c6`), which
  brought ~1100 files under version control on one day and would otherwise
  give every page the same date.
- **`deploy.sh` has no `--delete`.** Production is a permanent superset of the
  repo; deleting a page here does not remove it from the server. Retiring a URL
  means adding a 301 or 410 to `nginx-lingcode.conf` — and that file is *not*
  deployed by `deploy.sh`, it must be copied to the droplet by hand.
- **`sitemap*.xml` and `robots.txt` are edge-cached.** They are not `.html`, so
  they miss nginx's `no-cache` rule. `deploy.sh` purges them via the Cloudflare
  API; without credentials, purge them manually or Googlebot sees the old file.
