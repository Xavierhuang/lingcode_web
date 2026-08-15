---
title: Reactive queries
description: Preview the planned read-only, deterministic, typed, cacheable, and automatically subscribable named-query contract.
slug: /functions/queries.html
availability: preview
updated: 2026-08-09
---
# Reactive queries

A query is a named backend function that reads a consistent PostgreSQL snapshot and returns a JSON value. Queries are designed to be called once or subscribed to from React without manually wiring row events and refetch logic.

## Contract

A query will:

- execute in a read-only transaction;
- receive validated arguments and authenticated context;
- be deterministic with respect to its database snapshot;
- record the database dependencies it reads;
- return a backend revision with its result;
- become cacheable and subscribable;
- reject database writes and external network side effects.

## Definition

```ts
import { query, string } from '@lingcode/backend';

export const list = query({
  args: { roomId: string() },
  handler: async (ctx, args) => {
    const result = await ctx.db.query(
      `select id, author_id, body, created_at
       from messages
       where room_id = $1
       order by created_at asc
       limit 200`,
      [args.roomId]
    );
    return result.rows;
  },
});
```

The generated API name follows the source module and export, such as `api.messages.list`.

## React subscription

```tsx
const messages = useQuery(api.messages.list, { roomId });
```

The client sends the function name and arguments. The server executes the query, records dependencies, and associates the result with the connection. After a committed mutation invalidates one of those dependencies, the query reruns and the client receives the newer revision.

## Dependency tracking

The first release uses table-level dependency tracking. Reading `messages` subscribes the query to changes affecting that table, even if a particular changed row would not match `room_id`.

This is correct but may rerun more often than necessary. Later row, key, and index-range dependency tracking can reduce work without changing the query API.

When dependency extraction is uncertain, LingCode uses a backend-wide wildcard dependency. Missing an update would be a correctness bug; an extra rerun is an optimization cost.

## Determinism

Queries should not call external APIs, send email, charge a card, read mutable process state, or depend on uncontrolled randomness. Those operations cannot be safely cached or rerun.

Use a preview [Action](/docs/cloud/functions/actions.html) for external work and a [Mutation](/docs/cloud/functions/mutations.html) to store its durable result. A query can then reactively read that result.

## Consistent reads

The query runs in a repeatable-read, read-only transaction. Every SQL statement inside one execution observes a consistent database snapshot. Concurrent commits do not create a mixture of old and new rows inside the same result.

## Authentication and caching

Authentication is part of query identity. Results for different backend, function, arguments, or authenticated identity are never shared accidentally.

RLS runs for every database read. A cached result may only be reused within an equivalent authorization scope. Sign-in, sign-out, or token identity changes invalidate affected client subscriptions.

## Pagination

Reactive queries still need bounded results. Subscribe to one page or window rather than an entire growing table:

```ts
args: { roomId: string(), before: optional(timestamp()), limit: number() }
```

Use stable ordering and an indexed cursor. Offset pagination can shift when concurrent inserts arrive.

## Failure and reconnect

If a connection drops, the client reconnects and reruns active queries against the latest revision. It does not need every missed row event. If a result cannot be delivered because the client is too slow, the server discards the queued delta and requests a resynchronization.

Application errors remain visible to the calling component. Production developer errors are redacted from end users and retained in server logs.

## Current alternative

Until this page becomes Available, combine the current table query builder with [Realtime row subscriptions](/docs/cloud/realtime.html), and refetch after reconnect or an oversized change notification.
