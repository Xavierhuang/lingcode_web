---
title: Backend functions
description: Choose between available built-in and custom functions and the upcoming query, mutation, and action programming model.
slug: /functions/
availability: available
updated: 2026-08-09
---
# Backend functions

Functions run trusted application logic near your LingCode Cloud backend. They keep secrets off the client, enforce server-side decisions, call managed capabilities, and provide an API boundary for work that should not be expressed as direct table CRUD.

LingCode currently provides built-in functions and sandboxed custom TypeScript functions. A more strongly typed **query, mutation, and action** model is in Preview and is documented separately so its planned semantics cannot be mistaken for the current production API.

## Choose the right surface

| Surface | Availability | Use it for |
| --- | --- | --- |
| Built-in function | Available | Email, SMS, text-to-speech, Stripe Checkout, allow-listed HTTP calls, and echo testing |
| Custom function | Available | Short TypeScript handlers using secrets, database access, storage, request metadata, and schedules |
| Query | Preview | Deterministic named reads with automatic reactive subscriptions |
| Mutation | Preview | Atomic named writes with revision invalidation and safe conflict retries |
| Action | Preview | Named side-effecting work and external API calls without automatic retry |
| Hosted application | Available | Worker-compatible routing, SSR, larger application surfaces, and custom HTTP behavior |

## Available custom functions

A current function exports one default `handler(input, ctx)` and is invoked by slug:

```ts
export default async function handler(input, ctx) {
  const result = await ctx.db.queryRead(
    'select id, title from todos where completed = $1 order by created_at desc limit 50',
    [false]
  );
  return { todos: result.rows };
}
```

```js
const { data, error } = await lingcode.functions.invoke('list-open-todos', {});
if (error) throw error;
```

Read [Custom functions](/docs/cloud/functions/custom-functions.html) for the complete runtime, context, deployment, security, and transaction model. The original [Functions guide](/docs/cloud/functions.html) remains available during this documentation migration and includes the built-in catalog.

## Preview programming model

The preview model makes function intent explicit:

- [Queries](/docs/cloud/functions/queries.html) read a consistent snapshot and become subscribable.
- [Mutations](/docs/cloud/functions/mutations.html) group database calls into one serializable transaction.
- [Actions](/docs/cloud/functions/actions.html) perform external side effects and are not automatically retried.
- [Validation](/docs/cloud/functions/validation.html) checks public arguments and return values at runtime.
- [Error handling](/docs/cloud/functions/errors.html) distinguishes expected application errors from developer and platform failures.

The preview model extends PostgreSQL; it does not remove SQL migrations, RLS, direct CRUD, or REST access.

## Functions and security

Treat every public function as an internet-facing API:

- validate all caller-controlled input;
- read the authenticated identity from context rather than trusting a submitted user ID;
- rely on RLS for database authorization and add application checks for business permissions;
- keep vendor credentials in the Secrets vault;
- bound reads and writes;
- avoid returning secret values, internal stack traces, or rows the caller does not need;
- design side effects to be idempotent when the caller may retry.

## Functions and transactions

Current `ctx.db.query()` calls each use a separate database transaction. If several writes must be atomic today, put them in one reviewed PostgreSQL function and invoke it in one call.

Preview mutations change this boundary: all of a mutation handler's database operations execute on one pinned connection in one serializable transaction. This behavior is not available until the Mutations page carries an Available badge.

## Functions and long-running work

Functions are short-lived request handlers. They are not persistent servers, queues, or unrestricted compute jobs. Choose a hosted Worker-compatible application or compute job for workloads that need a larger execution envelope.

Continue with [Custom functions](/docs/cloud/functions/custom-functions.html) or the [Hosting guide](/docs/cloud/hosting.html).
