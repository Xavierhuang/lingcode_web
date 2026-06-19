# PR to Domain-Connect/Templates

Draft for the pull request adding `godaddy.com.lingcode.json` to
<https://github.com/Domain-Connect/Templates>. (Merging here makes the template
public/standard; GoDaddy still enables it separately — see SUBMISSION.md.)

## Steps to open it

1. Fork `Domain-Connect/Templates`.
2. Add the file **at the repo root**: `godaddy.com.lingcode.json` (already
   schema-validated locally — passes `template.schema`).
3. Validate + capture a test link:
   - Run it through the **Online Editor** (linked in the repo README) and the
     **[dc-template-linter](https://github.com/Domain-Connect/dc-template-linter)**;
     paste the resulting markdown link into the PR body where noted.
4. Open the PR using the title + body below (the repo auto-loads a PR template —
   fill its fields with this content).

## PR title

```
Add template godaddy.com.lingcode.json (LingCode app hosting)
```

## PR body

```markdown
### Service
**LingCode** — https://lingcode.dev — a platform for deploying and hosting web apps.

### What this template does
Points a customer's domain at LingCode's hosting edge so a GoDaddy user can connect
a custom domain in one click. It sets two records:

- `A     @   → 138.197.107.228`
- `CNAME www → apps.lingcode.dev`

### Template
- File: `godaddy.com.lingcode.json` (root, lowercase `providerId.serviceId.json`)
- providerId: `godaddy.com`  ·  serviceId: `lingcode`
- Signed synchronous flow: `syncPubKeyDomain: _dck.lingcode.dev`
- Redirects restricted to `lingcode.dev` (`syncRedirectDomain`)

### Safety
- Touches **only** apex `A` + `www` `CNAME` — **no MX/TXT/NS changes**, so email and
  other DNS config are preserved.
- No wildcards; both targets are infrastructure operated by LingCode.

### Validation
- Passes `template.schema`.
- dc-template-linter: clean.
- Online Editor test: <paste link>

### Checklist
- [x] Filename is lowercase `providerId.serviceId.json`
- [x] Passes JSON Schema (`template.schema`)
- [x] `syncPubKeyDomain` set (signed template; no `warnPhishing`)
- [x] No bare variables; no TXT records
```

## Notes / possible reviewer nits

- **Apex strategy:** we use a fixed `A @` to our edge IP. If you'd rather not hardcode
  an IP, the spec's `APEXCNAME` type (`pointsTo: apps.lingcode.dev`, provider-flattened)
  is an alternative — but `A` is universally supported, so we kept it. Easy to switch.
- **Version bumps:** if our edge IP ever changes, bump `version` and re-PR.
- This repo PR is *documentation/standardization*; the binding step is GoDaddy
  enabling the template (email in SUBMISSION.md).
