# LingCode Cloud documentation

The public Cloud docs at `/docs/cloud/` are generated from the Markdown files in `website/docs-src/cloud/`. Edit the Markdown and navigation source; do not hand-edit generated pages in `website/docs/cloud/`.

## Commands

From the repository root:

```sh
node website/scripts/docs/build.mjs
node website/scripts/docs/check.mjs
node --test website/scripts/docs/test/docs-build.test.mjs website/scripts/docs/test/cloud-content.test.mjs
```

Or run `./website/setup.sh docs` to build and check in one command.

`build.mjs` renders deterministic static HTML. `check.mjs` rebuilds into a temporary directory, compares it with the committed output, and validates internal Cloud-doc links. The website deployment runs both commands before building its search index; `SKIP_DOCS_BUILD=1` is available only for an intentional emergency site-only deployment.

## Adding a page

1. Add a Markdown file beneath `website/docs-src/cloud/` with `title`, `description`, `slug`, `availability`, and `updated` front matter.
2. Add the source and output paths to `website/docs-src/cloud/navigation.json`.
3. Use `availability: available` only for shipped behavior. Use `availability: preview` for planned or unreleased APIs; generated pages display a prominent warning automatically.
4. Build, check, and add focused content-contract coverage when the page documents a safety or compatibility guarantee.

Public pages must explain product behavior without publishing credentials, operator endpoints, infrastructure secrets, private incident procedures, or internal access instructions.
