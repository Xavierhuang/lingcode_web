---
title: LingCode Cloud
description: Build and ship applications with managed PostgreSQL, authentication, storage, realtime, functions, vector search, hosting, and agent-operated backend-as-code.
slug: /
availability: available
updated: 2026-08-09
---
# LingCode Cloud

LingCode Cloud is the managed backend for applications built in LingCode. It combines **managed PostgreSQL**, Authentication, Storage, Realtime, Functions, Vector search, secrets, telemetry, push notifications, and application hosting behind one project-scoped backend.

You can use the browser SDK directly, call the REST API, or let the LingCode agent create migrations and backend functions from files in your repository. The same security rules apply regardless of which surface performs the operation.

:::note One backend, two workflows
Use the SDK when application code needs data, identity, files, or functions. Use backend-as-code when you or an agent needs to change schema, policies, secrets declarations, or deployed function source.
:::

## Start in five minutes

### 1. Connect a backend

Open a project in LingCode and choose **Account → LingCode Cloud → Connect Backend to This Project**, or ask the agent:

```text
Connect a managed backend to this project and create a private todos table.
```

LingCode provisions a backend and stores project-safe connection metadata. The database password and administrative credentials are never written into the application repository.

### 2. Create schema with a migration

Tables, indexes, constraints, SQL functions, and row-level-security policies belong in migrations:

```sql
create table todos (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  title text not null,
  completed boolean not null default false,
  created_at timestamptz not null default now()
);

alter table todos enable row level security;

create policy "users read their todos"
on todos for select
using (user_id::text = current_setting('app.user_id', true));
```

See the current [Database guide](/docs/cloud/database.html) and [Security and RLS guide](/docs/cloud/security.html) before exposing a new table to client code.

### 3. Connect the JavaScript SDK

In LingCode previews, `window.lingcode` is injected automatically. In your own browser application, load the zero-dependency SDK and create a client:

```html
<script src="https://lingcode.dev/sdk/lingcode-v1.js"></script>
<script>
  const lingcode = LingCode.createClient(
    'https://lingcode.dev/api/cloud/be/<backend-id>',
    '<anon-key>'
  );
  await lingcode.ready;
</script>
```

:::warning The anon key is public
The anon key is designed to ship in a browser or mobile application. It identifies the backend; it does not bypass authorization. Protect data with row-level security. Vendor secrets, signing keys, and administrative credentials belong in the Secrets vault and must never enter client code.
:::

### 4. Read and write data

```js
const created = await lingcode
  .from('todos')
  .insert({ user_id: user.id, title: 'Read the Cloud docs' });

const { data, error } = await lingcode
  .from('todos')
  .eq('completed', false)
  .order('created_at', { ascending: false })
  .limit(50)
  .select();
```

Every SDK operation returns `{ data, error }`. Handle `error` before reading `data`, and paginate any collection that can grow without a small fixed bound.

### 5. Subscribe to current row events

The available Realtime API streams RLS-filtered row changes over Server-Sent Events:

```js
const unsubscribe = lingcode.from('todos').subscribe(({ type, row }) => {
  console.log(type, row);
});

// Later
unsubscribe();
```

This row-event API is available today. The named reactive-query API described below is a separate preview and is not required to use current Realtime.

## Available products

| Product | What it provides | Start here |
| --- | --- | --- |
| Database | PostgreSQL tables, SQL migrations, CRUD, RPC, indexes, RLS, full-text search | [Database](/docs/cloud/database.html) |
| Authentication | Email/password, passwordless sign-in, OAuth, sessions, TOTP MFA | [Authentication](/docs/cloud/auth.html) |
| Storage | Public and per-user private files, presigned large uploads | [Storage](/docs/cloud/storage.html) |
| Functions | Built-ins and sandboxed custom TypeScript functions | [Functions](/docs/cloud/functions.html) |
| Realtime | RLS-filtered INSERT, UPDATE, and DELETE events over SSE | [Realtime](/docs/cloud/realtime.html) |
| Vector search | pgvector, managed embeddings, full-text and hybrid ranking | [Vector search](/docs/cloud/vector-search.html) |
| Hosting | Static and Worker-compatible full-stack applications | [Hosting](/docs/cloud/hosting.html) |
| Secrets | Encrypted server-side vendor credentials | [Secrets](/docs/cloud/secrets.html) |
| Telemetry | First-party events, performance, releases, and crashes | [Telemetry](/docs/cloud/telemetry.html) |
| Push | Web Push, APNs, and FCM delivery | [Push notifications](/docs/cloud/push.html) |

## The mental model

Application clients do not connect directly to PostgreSQL. They call a **data gateway** using a backend URL, anon key, and optional signed-in user token. The gateway selects the backend's isolated PostgreSQL role and schema, sets the authenticated identity for RLS, bounds the request, and returns JSON.

Owners and project agents use the **control plane** for provisioning, migrations, function deployment, secrets, logs, and usage. Application traffic uses the **data plane**. Understanding this separation makes the security model much easier to reason about.

Read [Core concepts](/docs/cloud/concepts/) for the complete request and deployment model.

## Backend-as-code

The `lingcode/` directory can be the source of truth for backend changes:

```text
lingcode/
  backend.json
  migrations/
    20260809_create_todos.sql
  functions/
    send-reminder.ts
```

Development changes can be validated and applied quickly. Production changes use a digest-bound preview and explicit confirmation so an agent cannot silently deploy a different migration or function after approval.

## Preview APIs

LingCode is developing a typed named-function and reactive-query layer on top of PostgreSQL. It introduces read-only queries, atomic mutations, side-effecting actions, generated TypeScript APIs, and React subscriptions while preserving SQL and existing REST access.

- [Reactive queries — Preview](/docs/cloud/functions/queries.html)
- [Transactional mutations — Preview](/docs/cloud/functions/mutations.html)
- [Actions — Preview](/docs/cloud/functions/actions.html)

Preview pages describe the intended contract and are visibly marked. Do not use their examples as production APIs until their availability badge changes to **Available**.

## Where to go next

- Learn the boundaries in [Core concepts](/docs/cloud/concepts/).
- Build a schema with the [Database guide](/docs/cloud/database.html).
- Add identity with [Authentication](/docs/cloud/auth.html).
- Protect browser-accessible tables with [Security and RLS](/docs/cloud/security.html).
- Build a complete project with [Build a full app on LingCode Cloud](/tutorials/build-a-full-app-on-lingcode-cloud.html).
