# Domain Connect — GoDaddy onboarding submission

Everything needed to get the `godaddy.com.lingcode.json` template reviewed and
enabled by GoDaddy. Until GoDaddy enables it, `discover()` returns
`supported: false` and the "Authorize with GoDaddy" button stays hidden.

## Two channels (do both)

1. **PR the template to the public repo** — open a PR adding
   [`godaddy.com.lingcode.json`](./godaddy.com.lingcode.json) to
   <https://github.com/Domain-Connect/Templates>. Filename must be lowercase
   `providerId.serviceId.json` and must pass the repo's JSON-Schema check.
2. **Email GoDaddy's Domain Connect team** — `domainconnect@godaddy.com` (draft below).
   This is the one that actually gets it *enabled* on GoDaddy's side.

## Pre-submit checklist

- [x] `logoUrl` resolves — set to `https://lingcode.dev/logo.png` (200, image/png;
      the earlier `favicon.png` 404'd). Swap for a square 256×256 PNG if you have one.
- [x] Public-key TXT is **live + verified end-to-end** at `1._dck.lingcode.dev`
      (published pubkey matches the staged private key; signature verifies).
- [x] `.env` staged on the API box: `LINGCODE_DC_PRIVATE_KEY` (base64),
      `LINGCODE_DC_PUBKEY_DOMAIN=_dck.lingcode.dev`, `LINGCODE_DC_KEY_ID=1`,
      `LINGCODE_DC_REDIRECT_URI=https://lingcode.dev/api/account/domainconnect/callback`.
      NOTE: `LINGCODE_DC_PROVIDERS` is intentionally **left unset** (keeps the flow
      inert) until GoDaddy enables the template — then add `=godaddy.com` + restart.
- [x] `syncRedirectDomain` (`lingcode.dev`) matches the redirect URI's host.

---

## Email draft → domainconnect@godaddy.com

> **Subject:** Domain Connect template onboarding request — LingCode (serviceId: lingcode)
>
> Hi GoDaddy Domain Connect team,
>
> We're **LingCode** (<https://lingcode.dev>), a platform where users deploy and host
> web apps. We'd like to onboard a Domain Connect template so our customers whose
> domains are at GoDaddy can connect a custom domain in one click ("Authorize with
> GoDaddy") instead of editing DNS by hand.
>
> **Template:** `godaddy.com.lingcode.json` (PR to Domain-Connect/Templates: <link>)
> It sets exactly two records to point the domain at our hosting edge:
> - `A    @   → 138.197.107.228`
> - `CNAME www → apps.lingcode.dev`
>
> **Security notes (for your review):**
> - The template touches **only** the apex `A` and `www` `CNAME` — it makes **no
>   changes to MX, TXT/SPF, or NS records**, so customer email and existing config
>   are preserved.
> - Both targets are infrastructure we own and operate (a dedicated edge IP and our
>   `apps.lingcode.dev` host). No wildcards.
> - We implement the **signed synchronous flow**: requests are RSA-SHA256 signed and
>   verifiable via our public key at `1._dck.lingcode.dev`
>   (`syncPubKeyDomain: _dck.lingcode.dev`). `warnPhishing` is set to `true`.
> - Redirects return only to `lingcode.dev` (`syncRedirectDomain`).
>
> Could you review and enable this template for GoDaddy's Domain Connect, and let us
> know if you need anything else (e.g., domain ownership verification, a partner
> agreement, or async/OAuth onboarding with a client_id/secret)? We can also support
> the asynchronous flow if you prefer.
>
> Thanks,
> <Your name> — LingCode
> <contact email> · <https://lingcode.dev>

---

## Likely review questions — pre-answered

| GoDaddy may ask | Our answer |
|---|---|
| Does it modify email (MX) or NS? | No — apex A + www CNAME only. |
| Wildcards / broad changes? | None. Two records, fixed targets. |
| Do you own the targets? | Yes — `138.197.107.228` (our edge) and `apps.lingcode.dev`. |
| Signed sync requests? | Yes — RSA-SHA256, public key at `1._dck.lingcode.dev`. |
| Conflict handling? | Standard — applying overwrites an existing apex A / www CNAME; GoDaddy shows the user the change to confirm. |
| Async/OAuth? | Can support it — issue us a `client_id`/`client_secret` and we'll add the OAuth apply path. |

## After approval

1. Confirm `.env` + TXT are live, restart `lingcode-api`.
2. Ping me to wire the **"Authorize with GoDaddy"** button into the custom-domain
   modal (calls `/api/account/domainconnect/discover`, opens the signed apply URL).
3. Smoke-test: connect a real GoDaddy domain end-to-end.
