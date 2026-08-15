---
title: Transactional mutations
description: Preview atomic serializable writes, idempotency keys, revisions, invalidation, and bounded conflict retries for named backend mutations.
slug: /functions/mutations.html
availability: preview
updated: 2026-08-09
---
# Transactional mutations

A mutation is a named backend function whose database work commits atomically. All reads and writes in one handler use one pinned PostgreSQL connection and one `SERIALIZABLE` transaction.

## Definition

```ts
import { mutation, id, string } from '@lingcode/backend';

export const send = mutation({
  args: { roomId: id('rooms'), body: string() },
  handler: async (ctx, args) => {
    const result = await ctx.db.query(
      `insert into messages (room_id, author_id, body)
       values ($1, $2, $3)
       returning id, room_id, author_id, body, created_at`,
      [args.roomId, ctx.auth.userId, args.body]
    );
    return result.rows[0];
  },
});
```

## Atomicity

If the handler returns successfully, its database changes, backend revision, and reactive invalidation record commit together. If validation fails, customer code throws, the process times out, or PostgreSQL rejects a statement, all changes roll back.

No subscriber can observe mutation data without the matching revision and invalidation event.

## Serializable isolation

Serializable isolation makes concurrent transactions behave as if they ran one at a time. PostgreSQL may abort a transaction when it detects an unsafe serialization or deadlock.

LingCode will retry only database-safe failures with PostgreSQL codes `40001` and `40P01`, using a fresh transaction and bounded jitter, for at most three total attempts. Validation failures, customer exceptions, timeouts, permission failures, and actions are not retried automatically.

Because a mutation may execute again after a conflict, keep external side effects out of its handler.

## Idempotency

Callers can attach an idempotency key to a mutation request. The key is scoped to the backend and records the committed result in the same PostgreSQL transaction.

```ts
await send(
  { roomId, body },
  { idempotencyKey: crypto.randomUUID() }
);
```

Repeating a committed key returns the stored result without applying the write or emitting another invalidation. Use one stable key for one user intent; do not reuse a key for different arguments.

Idempotency protects against ambiguous network retries. It does not replace database uniqueness constraints or application authorization.

## Revisions and invalidation

Every committed mutation increments a monotonically increasing revision for its backend and inserts a transactional outbox row describing affected dependencies.

Stage 0 emits a wildcard dependency when exact touched tables are unknown. Later dependency capture narrows invalidation to tables, keys, and index ranges without changing mutation source code.

## Authentication and RLS

The mutation receives the server-derived signed-in identity in `ctx.auth`. Database operations run as the backend tenant role with RLS enabled.

Do not accept an arbitrary `userId` argument when the operation should apply to the caller. Use `ctx.auth.userId`, validate business permissions, and keep `WITH CHECK` policies on inserted or updated rows.

## Return after commit

The client receives the mutation result after commit. A successful response therefore means both the data and its invalidation metadata are durable.

If the connection disappears before the response arrives, the caller may not know whether commit occurred. Use an idempotency key to retry safely.

## What does not belong in a mutation

- sending email or SMS;
- charging a payment method;
- calling an LLM or third-party API;
- writing to an external object store without a transactional protocol;
- depending on process-local state.

Capture durable intent in a mutation, then schedule or invoke an [Action](/docs/cloud/functions/actions.html). Store the action outcome in another mutation so reactive queries can display it.

## Current alternative

Until mutations become Available, implement multi-statement atomic work as one PostgreSQL function deployed by migration and call it once through `rpc()`. Current custom-function `ctx.db.query()` calls are separate transactions.
