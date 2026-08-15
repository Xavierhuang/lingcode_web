---
title: JavaScript SDK
description: Use the LingCode Cloud JavaScript client for data, authentication, files, functions, realtime subscriptions, vectors, push, and telemetry.
slug: /reference/javascript-sdk.html
availability: available
updated: 2026-08-09
---

# JavaScript SDK

The JavaScript SDK is the main application client for LingCode Cloud. It exposes one typed client for database access, authentication, storage, custom functions, realtime subscriptions, vector search, push, telemetry, and remote configuration.

## Create a client

Import `createClient` and initialize it with the backend URL and public anonymous key shown in the LingCode backend panel.

```js
import { createClient } from "@lingcode/cloud";

const cloud = createClient("https://your-backend.example.com", "your-anon-key");
```

Do not ship service-role credentials in browser or mobile applications. The anonymous key identifies the backend; row-level security and the signed-in user's session determine what a client may access.

## Results and errors

Asynchronous SDK operations return a typed Result<T> value with either data or a structured error. Check the error before using the data.

```ts
const { data, error } = await cloud.from("messages").select();
if (error) {
  console.error(error.code, error.message);
  return;
}
```

Errors can include a stable machine-readable code, a human-readable message, optional details, and the related HTTP status. Applications should branch on the code rather than matching message text.

## Tables

Start a table operation with `from(table)`. Selection supports filters, ordering, limits, ranges, and single-row helpers.

```js
const { data, error } = await cloud
  .from("messages")
  .select("id, body, created_at")
  .eq("room_id", roomId)
  .order("created_at", { ascending: false })
  .limit(50);
```

Use `insert`, `upsert`, `update`, and `delete` for writes. Every operation is evaluated using the current user session and the backend's row-level security policies.

## Authentication

The `auth` namespace manages sign-up, sign-in, sign-out, session refresh, password recovery, and auth-state listeners. Persist sessions only through the SDK's supported storage adapter.

```js
const { data, error } = await cloud.auth.signInWithPassword({ email, password });
const unsubscribe = cloud.auth.onAuthStateChange((event, session) => {
  // Update application state.
});
```

## Storage

Use `storage.from(bucket)` to upload, download, list, move, copy, or remove objects. Bucket policies are enforced independently from table policies.

## Custom functions

Invoke a deployed custom function with `functions.invoke`. The body is JSON-encoded unless you pass a supported binary body.

```js
const { data, error } = await cloud.functions.invoke("send-welcome-email", {
  body: { userId },
});
```

Function compute is metered separately from the number of saved definitions. See [Limits and quotas](/docs/cloud/limits.html) for the current contract.

## Realtime

Create a channel, attach database-change or broadcast handlers, and subscribe. Remove channels when a screen or component no longer needs them. Treat reconnects as normal: handlers should tolerate duplicate delivery and refresh authoritative state after a connection gap.

## Vector, push, telemetry, and config

The `vector` namespace performs similarity search against configured embeddings. The `push` namespace registers devices and manages notification preferences. `telemetry` records application events, while `config` reads remotely managed application configuration.

Keep high-cardinality or secret values out of telemetry properties. Remote config is not a secrets store.

## TypeScript

The package includes TypeScript declarations for the client, builders, data values, sessions, and structured errors. Supply your generated database types to improve table and column inference in application code.

## Related guides

- [Custom functions](/docs/cloud/functions/custom-functions.html)
- [REST API](/docs/cloud/reference/rest-api.html)
- [Reliability](/docs/cloud/production/reliability.html)
- [Security](/docs/cloud/security.html)
