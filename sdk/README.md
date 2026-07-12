# lingcode-js

Official client SDK for a [LingCode](https://lingcode.dev) managed backend — database, auth, realtime, storage, serverless functions, vector search, and push, in one zero-dependency client.

- **Package name:** `lingcode-js`
- **Connect with:** `createClient(LINGCODE_CLOUD_URL, LINGCODE_CLOUD_ANON_KEY)`
  - `LINGCODE_CLOUD_URL` = `https://lingcode.dev/api/cloud/be/<your-backend-id>`
  - `LINGCODE_CLOUD_ANON_KEY` = your backend's public anon key
- **Auth** goes through `lingcode.auth.*` (see [Auth](#auth)) — you never write the `auth_users` table directly.

> **The SDK is optional.** It's a thin, Supabase-shaped wrapper over a plain HTTPS gateway
> (`POST https://lingcode.dev/api/cloud/be/<id>/select|insert|upsert|update|delete|rpc`,
> and `…/auth/*` for sign-up/sign-in). Any language can use the backend with `fetch` and the
> anon key — see [Using the REST gateway directly](#using-the-rest-gateway-directly-no-sdk). The
> SDK just saves you the session/redirect/upload/realtime plumbing.

## Install

```bash
npm install lingcode-js
```

Or drop it in with a `<script>` tag (no build step):

```html
<script src="https://lingcode.dev/sdk/lingcode-v1.js"></script>
<script>
  const lingcode = LingCode.createClient(BACKEND_URL, ANON_KEY);
</script>
```

> In apps built with LingCode `/try`, a ready `window.lingcode` is **already injected** — you can skip `createClient` entirely.

## Quick start

```js
import { createClient } from "lingcode-js";

const lingcode = createClient(
  "https://lingcode.dev/api/cloud/be/<your-backend-id>",  // LINGCODE_CLOUD_URL
  "<your-anon-key>"                                        // LINGCODE_CLOUD_ANON_KEY
);
```

## Browser vs. server (SSR) — pick the right path

This SDK is a **browser/client** SDK: it persists the session in local storage and finalizes
magic-link/OAuth redirects in the page. That's perfect for SPAs and static sites.

For **server-side frameworks (Next.js SSR, API/route handlers, server actions, edge/Workers)** the
browser session model doesn't apply — there's no `localStorage` and no redirect to finalize. **Do not
rely on the SDK's auto-session on the server.** Instead, read the signed-in user's access token from
the request (cookie or `Authorization` header) and call the [REST gateway](#using-the-rest-gateway-directly-no-sdk)
with it (a thin per-request wrapper is the common pattern). Use the SDK on the client for sign-in and
interactive reads/writes; use REST-with-the-request-token on the server.

> Heavy background work (long-running jobs, ingestion pipelines) shouldn't use this SDK at all — those
> run on the **compute tier** with a direct `LINGCODE_DB_URL` Postgres connection (full SQL, no gateway caps).

## Database

Supabase-style query builder — filters first, terminal op last.

```js
// Select
const { data, error } = await lingcode
  .from("todos")
  .eq("done", false)
  .order("created_at", { ascending: false })
  .limit(50)
  .select();

// Insert one row — or many in ONE call (batch insert, single transaction)
await lingcode.from("todos").insert({ title: "Buy milk" });
await lingcode.from("events").insert([row1, row2, row3]); // up to the tier's maxRowsPerWrite

// Update / delete (a filter is REQUIRED)
await lingcode.from("todos").eq("id", 1).update({ done: true });
await lingcode.from("todos").eq("id", 1).delete();
```

Filters: `.eq .neq .gt .gte .lt .lte .like .ilike .in(col, [...]) .is(col, null | "not_null") .match({ ... })`.

## Upsert (insert-or-update by a unique key)

```js
// One row or an array. onConflict is the unique column(s) to match on.
await lingcode.from("events").upsert(rows, { onConflict: "source_hash" });
await lingcode.from("prefs").upsert(row, { onConflict: ["user_id", "key"] });

// merge:false leaves an existing row untouched (ON CONFLICT DO NOTHING)
await lingcode.from("events").upsert(rows, { onConflict: "source_hash", merge: false });
```

`upsert` is `INSERT … ON CONFLICT DO UPDATE` — the idempotent path for ingest/sync, so a re-run updates by key instead of erroring or duplicating. Same per-call row cap as batch insert.

## RPC — complex reads (JOINs, CTEs, full-text ranking)

The single-table builder can't do JOINs or aggregations. For those, define a SQL function in a migration and call it by name — the SQL stays server-side and runs as your tenant role with RLS enforced:

```sql
-- in a migration (apply once)
CREATE FUNCTION search_events(q text, in_city text)
RETURNS SETOF events LANGUAGE sql STABLE AS $$
  SELECT * FROM events
  WHERE city = in_city
    AND fts @@ websearch_to_tsquery(q)
  ORDER BY ts_rank(fts, websearch_to_tsquery(q)) DESC
  LIMIT 50;
$$;
```

```js
// named (object) or positional (array) args
const { data } = await lingcode.rpc("search_events", { q: "jazz", in_city: "NYC" });
const { data } = await lingcode.rpc("top_n", [10]);
```

> **Note:** named-argument calls require the function to be created with named parameters (as above). Returns at most 1000 rows.

## Realtime

```js
const off = lingcode.from("todos").subscribe(({ type, row }) => {
  // type: "INSERT" | "UPDATE" | "DELETE" — patch your UI
});
// later: off();
```

Server-side RLS means a signed-in user only ever receives their own rows.

## Auth

The SDK persists the session and auto-attaches it to later calls.

```js
await lingcode.auth.signUp({ email, password });
await lingcode.auth.signIn({ email, password });

// Passwordless (the SDK finalizes the link/redirect automatically)
await lingcode.auth.sendMagicLink({ email });
await lingcode.ready;            // wait for redirect-session consumption on load
lingcode.auth.getUser();         // { id, email } | null

// Social (only render buttons whose provider is available)
const providers = await lingcode.auth.getProviders();
if (providers.google?.available) lingcode.auth.signInWithOAuth("google");

// Email code
await lingcode.auth.sendOtp({ email });
await lingcode.auth.verifyOtp({ email, code });

await lingcode.auth.signOut();
```

### Email verification on password signup (optional)

By default, `signUp` returns a session immediately. If the backend owner turns on
**Require email verification** (Cloud console → Auth settings, or
`PUT /api/cloud/account/backends/<id>/auth-settings { require_email_verification: true }`),
password signup becomes Supabase/Firebase‑style: the user is created **unverified**, a
confirmation link is emailed (managed — no email provider key needed), and sign‑in is
blocked until they confirm.

```js
// 1) Sign up — pass a redirect_url that receives ?lc_verify=<token>.
//    Returns { pending_verification: true } instead of a session.
await lingcode.auth.signUp({ email, password, redirectTo: "https://app.example.com/verify" });

// 2) The email link opens redirect_url?lc_verify=<token>. Exchange it for a session:
await lingcode.auth.verifyEmail({ token });   // → { user, access_token, refresh_token }

// Resend if it expired (24h) — always succeeds, never reveals whether the email exists:
await lingcode.auth.resendVerification({ email, redirectTo: "https://app.example.com/verify" });
```

REST equivalents (for SSR/native): `POST …/auth/signup` (with `redirect_url`) →
`POST …/auth/verify-email` (`{ token }`) → session; `POST …/auth/verify-email/resend`.
Passwordless **magic‑link** and **OTP** already prove email ownership, so they don't need
this — it's specifically for classic email+password with a confirm step.

## Storage

```js
const { data } = await lingcode.storage.from("public").upload("avatars/me.png", file);
const url = lingcode.storage.from("public").getPublicUrl("avatars/me.png");
await lingcode.storage.from("public").remove("avatars/me.png");
```

`upload()` picks the right path automatically: small files (≤5 MB) go inline,
while larger files (video/audio recordings, etc.) stream **directly** to object
storage via a presigned URL — so multi-GB files work without tunnelling base64
through the gateway. The max size is per tier (`maxUploadBytes`); buckets are
`"public"` (CDN-served) or `"private"` (short-lived signed URLs).

## Functions

```js
const { data } = await lingcode.functions.invoke("send-email", { to, subject, html });
```

## Vector search

```js
const { data } = await lingcode.vector.search({
  table: "docs", column: "embedding", embedding: queryVec, limit: 5, metric: "cosine",
});
// Optional managed embeddings:
const { data: e } = await lingcode.vector.embed("some text"); // e.embedding
```

## Push notifications (Web Push)

```js
await lingcode.push.subscribe(); // registers the service worker + subscribes
```

The owner sends notifications from the LingCode Cloud console (or the backend API). For apps served on their own origin, host the service worker at your origin and pass `{ serviceWorker: "/lingcode-sw.js" }`.

## Using the REST gateway directly (no SDK)

The SDK is convenience, not a requirement — every operation is a plain HTTPS call to your backend at
`https://lingcode.dev/api/cloud/be/<backend-id>`. Send the anon key as a Bearer token; for
user-scoped (RLS) requests, send the signed-in user's access token instead. This is the path to use
from a **server** (Next.js route handlers, edge functions, any non-JS backend).

```js
const BASE = process.env.LINGCODE_CLOUD_URL;        // …/api/cloud/be/<id>
const ANON = process.env.LINGCODE_CLOUD_ANON_KEY;

// Sign a user in (server-side) — returns { access_token, refresh_token, user }
const session = await fetch(`${BASE}/auth/signin`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${ANON}` },
  body: JSON.stringify({ email, password }),
}).then((r) => r.json());

// User-scoped read: send the USER's token so RLS pins app.user_id to them
const todos = await fetch(`${BASE}/select`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
  body: JSON.stringify({ table: "todos", where: { done: false }, limit: 50 }),
}).then((r) => r.json());
```

**Data endpoints** (POST, JSON body): `/select` `/insert` `/upsert` `/update` `/delete` `/rpc` —
same shapes as the builder above (`table`, `where`, `row`, `on_conflict`, `fn`/`args`, …).
**Auth endpoints:** `/auth/signup` `/auth/signin` `/auth/signout` `/auth/token/refresh`
`/auth/magiclink/request|verify` `/auth/otp/request|verify` `/auth/oauth/<provider>/start`
`/auth/providers` `/auth/mfa/*`. The anon key authorizes the request; the user's access token
(from a sign-in response) is what enforces per-user RLS. You never write `auth_users` yourself — the
`/auth/*` endpoints manage it.

## License

MIT
