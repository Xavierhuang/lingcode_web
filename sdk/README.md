# lingcode-js

Official client SDK for a [LingCode](https://lingcode.dev) managed backend — database, auth, realtime, storage, serverless functions, vector search, and push, in one zero-dependency client.

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
  "https://lingcode.dev/api/cloud/be/<your-backend-id>",
  "<your-anon-key>"
);
```

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

// Insert
await lingcode.from("todos").insert({ title: "Buy milk" });

// Update / delete (a filter is REQUIRED)
await lingcode.from("todos").eq("id", 1).update({ done: true });
await lingcode.from("todos").eq("id", 1).delete();
```

Filters: `.eq .neq .gt .gte .lt .lte .like .ilike .in(col, [...]) .is(col, null | "not_null") .match({ ... })`.

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

## License

MIT
