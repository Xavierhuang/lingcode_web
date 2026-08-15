---
title: Core concepts
description: Understand LingCode Cloud projects, backends, PostgreSQL isolation, the data gateway, authentication context, control and data planes, and backend-as-code deployments.
slug: /concepts/
availability: available
updated: 2026-08-09
---
# Core concepts

LingCode Cloud is PostgreSQL with a managed security, API, storage, compute, and deployment layer. You do not need to operate a database server, but the underlying relational model remains visible: tables, types, constraints, indexes, transactions, SQL functions, and row-level security behave like PostgreSQL.

## Project and backend

A **project** is the collaborative LingCode resource associated with a source repository. A **backend** is the provisioned Cloud environment containing that application's database schema, users, files, functions, configuration, telemetry, and usage state.

The committed `.lingcode/project.json` identity allows a project to reconnect to its existing backend after the local folder is renamed or moved. Access still requires project ownership or membership; knowing a project identifier is not authorization.

## Tenant schema and role

Each backend receives two PostgreSQL isolation primitives:

- a tenant schema named `be_<backend-id>`;
- a tenant role named `trole_<backend-id>`.

Application queries run with the tenant role and a `search_path` pinned to that tenant schema plus approved extensions. The role has no grants on another backend's schema. This is the hard cross-tenant boundary; row-level security is an additional per-user boundary inside the backend.

The schema can use normal PostgreSQL capabilities such as foreign keys, unique constraints, transactions, JSONB, full-text search, and pgvector. LingCode manages provisioning and grants after migrations.

## Data gateway

Client applications call the **data gateway**, not the PostgreSQL wire protocol. A request contains:

1. the backend URL;
2. the public anon key;
3. an optional signed-in user access token;
4. a bounded data, auth, storage, or function operation.

The gateway verifies the token, selects the backend, assumes its tenant role, pins the schema, places the user identifier in the PostgreSQL session, runs the operation, meters it, and returns a JSON envelope.

This arrangement prevents a browser from receiving a database password and gives the service a place to enforce request-size, row-count, execution-time, and plan limits.

## The anon key and user token

The **anon key** selects a backend and grants only the permissions available to unauthenticated application traffic. It is public by design.

After sign-in, the SDK adds a short-lived **user access token**. The gateway verifies it and exposes the user ID to PostgreSQL as `current_setting('app.user_id', true)`. RLS policies use that value to decide which rows the user can read or change.

```sql
create policy "read own profile"
on profiles for select
using (id::text = current_setting('app.user_id', true));
```

Hiding the anon key does not replace RLS. Conversely, a correct RLS policy remains effective even when a user inspects the key and calls the API outside your UI.

## Row-level security

**Row-level security** is PostgreSQL's per-row authorization system. Enable it on every table reached from a client application, then add policies for the operations the application needs.

```sql
alter table notes enable row level security;

create policy "owners manage notes"
on notes for all
using (owner_id::text = current_setting('app.user_id', true))
with check (owner_id::text = current_setting('app.user_id', true));
```

`USING` controls which existing rows an operation can see. `WITH CHECK` controls which new row state may be created. Test SELECT, INSERT, UPDATE, and DELETE separately because one successful policy does not imply the others are correct.

## Control plane and data plane

LingCode Cloud separates administrative work from application traffic.

| Plane | Responsibilities | Typical callers |
| --- | --- | --- |
| Control plane | Provisioning, ownership, migrations, functions, secrets, domains, logs, usage, deployment approvals | LingCode IDE, backend console, MCP tools |
| Data plane | Authenticated database operations, RLS, function invocation, realtime events, file access | Web, mobile, and server applications |

Control-plane ownership does not mean an application's end user receives administrative access. Data-plane requests always enter through the backend's application security context.

## Current database API

The current SDK provides bounded table CRUD, filters, ordering, pagination, upsert, SQL RPC, vector search, storage, auth, functions, and row-event subscriptions. Relational joins and complex aggregation should live in a reviewed SQL function deployed by migration, then be called through `rpc()`.

```js
const { data, error } = await lingcode.rpc('recent_orders', {
  customer_id: user.id,
  page_size: 25,
});
```

Keeping complex SQL server-side reduces accidental over-fetching, allows indexes to work, and keeps authorization logic close to the data.

## Functions and sandboxing

Current custom functions run TypeScript in a fresh Deno subprocess. Filesystem, environment, subprocess, FFI, and unrestricted network access are denied. Declared secrets are supplied through `ctx.secrets`; backend database and storage operations use short-lived per-invocation credentials.

Functions are appropriate for short server-side logic, vendor API calls, webhooks that fit the supported request model, and scheduled operations. Long-running processes and persistent servers belong in hosted Worker-compatible applications or infrastructure you operate.

## Realtime today

The available Realtime API publishes committed INSERT, UPDATE, and DELETE events. PostgreSQL `LISTEN/NOTIFY` carries changes across API processes, and the service checks RLS visibility before sending row bodies to application subscribers.

Subscribers must still handle reconnects and refetch when instructed. Realtime is a notification channel, not a substitute for the database as the source of truth.

## Backend-as-code

**Backend-as-code** stores a manifest, immutable migrations, and function source under `lingcode/`. The agent can create and update these files, calculate their hashes, preview the deployment, run tests, and ask for production approval.

The server verifies paths, declared artifacts, SHA-256 hashes, migration drift, function size, secret names, project access, and environment before applying anything. Production approval is tied to the exact canonical digest and expires; changing a file requires a new preview.

## Development and production

Development favors short feedback loops, but validation still runs before changes are applied. Production requires explicit confirmation of the previewed artifact set. File watching never grants permission to change production automatically.

Database migrations are forward changes. A failed deploy can safely retry unchanged completed artifacts, but arbitrary SQL rollback cannot be invented automatically. Destructive migrations require an application-specific recovery plan and a verified backup.

## Consistency boundaries

- A single gateway CRUD or SQL RPC operation runs in one PostgreSQL transaction.
- A bulk write is atomic within that call.
- Current custom-function `ctx.db.query()` calls are separate database operations unless the function invokes one server-side SQL function that performs the transaction.
- Row-event Realtime reports committed changes but does not make several client requests one transaction.
- The reactive query and atomic mutation contract is currently Preview and is documented separately.

If several writes must succeed or fail together today, place them in one reviewed PostgreSQL function and call it once with `rpc()`.

## Security responsibility

LingCode manages infrastructure boundaries, encrypted secret storage, sandbox policy, authentication primitives, backups, and bounded APIs. Application developers remain responsible for schema design, RLS policies, safe function logic, allowed redirect origins, vendor permissions, and data-retention decisions.

Before production:

- enable and test RLS;
- index foreign keys and common filters;
- paginate growing reads;
- move private keys into Secrets;
- run backend advisors;
- preview production backend changes;
- verify backup and restore procedures appropriate to the application.

Continue with the [Database guide](/docs/cloud/database.html), [Security and RLS](/docs/cloud/security.html), or [Best practices](/docs/cloud/best-practices.html).
