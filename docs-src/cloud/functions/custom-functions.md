---
title: Custom functions
description: Author, deploy, invoke, secure, schedule, test, and troubleshoot LingCode Cloud custom functions. TypeScript on Deno is available; Python is Preview.
slug: /functions/custom-functions.html
availability: available
updated: 2026-08-12
---
# Custom functions

Custom functions are currently available. They run TypeScript in a fresh Deno subprocess with deny-by-default permissions and are addressed by a URL-safe slug. A Preview **Python runtime** is available per-backend on request — see [Python runtime (Preview)](#python-runtime-preview) below.

## Source shape

Every source file must `export default` one `handler(input, ctx)` function:

```ts
export default async function handler(input, ctx) {
  const title = String(input?.title || '').trim();
  if (!title) throw new Error('title is required');

  const result = await ctx.db.query(
    'insert into todos (title) values ($1) returning id, title, completed',
    [title]
  );
  return result.rows[0];
}
```

The handler may be synchronous or asynchronous. `undefined` is serialized as `null`; other return values must be JSON-serializable.

## Runtime context

| Property | Purpose |
| --- | --- |
| `ctx.backendId` | Current backend identifier |
| `ctx.gateway` | Current backend gateway URL |
| `ctx.secrets` | Declared Secrets-vault values keyed by name |
| `ctx.request` | Inbound method, headers, query, path, and body metadata when invoked over HTTP |
| `ctx.db.query(sql, params)` | Parameterized SQL with the tenant role and caller identity |
| `ctx.db.queryRead(sql, params)` | Parameterized SQL inside a read-only transaction |
| `ctx.storage.uploadUrl(path, options)` | Presigned upload information |
| `ctx.storage.url(path, options)` | Public or time-limited private URL information |
| `ctx.storage.remove(path, options)` | Remove an object |

Do not build SQL by interpolating caller strings. Use `$1`, `$2`, and parameter arrays.

## Authentication and RLS

When the client invokes a function with a signed-in session, the gateway carries that user identity into `ctx.db`. PostgreSQL RLS sees the identity through `current_setting('app.user_id', true)`.

The function must not trust `input.userId` as proof of identity. Use database policies and server-derived context. A function invoked anonymously has no user ID and receives only the access allowed to the backend's unauthenticated role.

## Secrets

Declare secret names when saving or deploying the function. Only declared names are resolved and exposed:

```json
{
  "slug": "charge-card",
  "path": "functions/charge-card.ts",
  "enabled": true,
  "secrets": ["PAYMENTS_API_KEY"]
}
```

```ts
const apiKey = ctx.secrets.PAYMENTS_API_KEY;
if (!apiKey) throw new Error('PAYMENTS_API_KEY is not configured');
```

Never return or log a secret. The source manifest contains names only; encrypted values remain in the Secrets vault.

## Sandbox permissions

Each invocation starts Deno with filesystem read/write, environment, FFI, and subprocess execution denied. Network access is limited to the backend gateway required for `ctx.db` and `ctx.storage`. The function cannot open arbitrary outbound connections.

For a supported vendor, use a built-in function. For a generic HTTPS API, use the `http-fetch` built-in with an owner-configured host allow-list and Secrets-vault substitutions.

The process has a 128 MB V8 heap budget. Source is limited to **256 KB** and buffered output is bounded. Tier-specific wall-clock limits terminate overrunning functions with `SIGKILL`; there is no graceful extension after the deadline.

## Invocation

From the JavaScript SDK:

```js
const { data, error } = await lingcode.functions.invoke('create-todo', {
  title: 'Ship the documentation',
});
if (error) {
  console.error(error.message);
  return;
}
console.log(data.id);
```

Over HTTP, POST to the backend function route with the anon key or user token expected by the SDK:

```text
POST /api/cloud/be/<backend-id>/functions/<slug>
Content-Type: application/json
Authorization: Bearer <anon-key-or-user-token>

{"input":{"title":"Ship the documentation"}}
```

## Deployment

Functions can be saved in the backend console or deployed from repository source. Backend-as-code is recommended because function content, declared secrets, hashes, and migrations can be reviewed together.

```text
lingcode/
  backend.json
  functions/
    create-todo.ts
```

Production deploys require a preview bound to the exact content digest. Editing the function after preview invalidates that approval.

## Testing

The owner test route can run saved or draft source with sample input. A manifest may include `testInput`; deployment runs that draft before saving it. Tests should cover:

- valid input and result shape;
- missing and malformed input;
- anonymous and authenticated authorization;
- RLS denial;
- missing secrets;
- downstream built-in failures;
- timeout behavior;
- retry behavior implemented by the caller.

## Transaction boundary

Each current `ctx.db.query()` call is a separate database transaction. The following handler can commit the first write even if the second fails:

```ts
await ctx.db.query('insert into orders (id) values ($1)', [orderId]);
await ctx.db.query('insert into order_items (order_id, sku) values ($1, $2)', [orderId, sku]);
```

For atomic work today, deploy one PostgreSQL function in a migration and call it once:

```sql
create function create_order(p_order_id uuid, p_sku text)
returns void
language plpgsql
security invoker
as $$
begin
  insert into orders (id) values (p_order_id);
  insert into order_items (order_id, sku) values (p_order_id, p_sku);
end;
$$;
```

Preview [Mutations](/docs/cloud/functions/mutations.html) are designed to make the whole TypeScript handler atomic, but that contract is not available yet.

## Scheduling

A saved custom function can have a managed schedule. Scheduled invocations use the same source, declared secrets, timeout, logging, and runtime path as HTTP invocation. They do not have an end-user session unless the scheduled input and function logic establish an application-specific identity.

Design scheduled functions to be idempotent because operations teams may intentionally rerun a failed schedule.

## Errors and availability

- `functions_runtime_unavailable` with HTTP 503 means Deno is unavailable on that API deployment.
- `python_runtime_unavailable` with HTTP 503 means firejail or `python3` is not installed on that API deployment.
- `python_runtime_not_enabled` with HTTP 403 means the backend has not been enrolled in the Python runtime Preview.
- `unknown_function` means the slug is not a saved enabled function or built-in.
- `function_error` means customer code threw or returned an execution failure.
- A timeout means the subprocess exceeded its tier wall-clock budget.
- Database errors retain PostgreSQL error meaning but public responses should not expose credentials or internal topology.

Inspect the backend Logs view for captured execution details. Keep customer-facing error messages stable and safe; log diagnostic detail server-side.

## Python runtime (Preview)

An opt-in Python runtime runs stdlib-only Python 3 in a firejail sandbox. The wire contract mirrors the TypeScript runtime — same slug URL, same `ctx.secrets` / `ctx.request` / `ctx.db` / `ctx.storage` surface, same wall-clock and source-size limits.

### Enrolment

Python is disabled on every backend by default. To enrol a backend, an operator sets `python_runtime_enabled = 1` on its `account_backends` row. Once enrolled, saving a function with `runtime: "python"` succeeds and both `deno-ts` and `python` slugs can coexist on the same backend.

### Handler shape

```python
def handler(input, ctx):
    title = (input or {}).get("title", "").strip()
    if not title:
        raise ValueError("title is required")
    result = ctx.db.query(
        "insert into todos (title) values ($1) returning id, title, completed",
        [title],
    )
    return result["rows"][0]
```

The module must define a top-level synchronous `def handler(input, ctx)`. Return values must be JSON-serializable. `None` is serialized as `null`. `async def` handlers are not accepted in Preview.

### Runtime context (Python)

The `ctx` object mirrors the TypeScript contract with Python-idiomatic snake_case attribute and method names:

| Property | Purpose |
| --- | --- |
| `ctx.backend_id` | Current backend identifier |
| `ctx.gateway` | Current backend gateway URL |
| `ctx.secrets` | Declared Secrets-vault values keyed by name (`dict[str, str]`) |
| `ctx.request` | Inbound method, headers, query, path, and body metadata (`dict`) when invoked over HTTP |
| `ctx.db.query(sql, params)` | Parameterized SQL with the tenant role and caller identity; returns `{"rows": [...], "rowCount": n, "fields": [...]}` |
| `ctx.db.query_read(sql, params)` | Parameterized SQL inside a read-only transaction |
| `ctx.storage.upload_url(path, **opts)` | Presigned upload information |
| `ctx.storage.url(path, **opts)` | Public or time-limited private URL information |
| `ctx.storage.remove(path, **opts)` | Remove an object |

All `ctx.db` and `ctx.storage` methods are synchronous — they block the handler while the request completes.

### Sandbox permissions (Python)

Each invocation runs `python3 -I -B -S` inside a fresh firejail namespace with all Linux capabilities dropped, a seccomp filter, a private tmpfs `$HOME`, and no supplementary groups. Filesystem is read-only outside `$HOME`. Network access is either restricted to the backend gateway (when the operator installs the nftables include, see below) or fully denied. When the network is denied, `ctx.db` and `ctx.storage` calls raise `RuntimeError: backend access is unavailable in this function`.

### Dependencies

**Stdlib-only.** No `pip`, no `requirements.txt`, no PyPI. Reach external services through `ctx.storage`, `ctx.db`, or `urllib.request` (subject to the sandbox network policy).

### Preview limitations

- No third-party Python packages.
- No PyPI or file-based imports beyond the Python 3 standard library.
- Cold start includes a fresh firejail namespace setup (typically 40–120 ms in addition to CPython startup).
- The nftables-based gateway allowlist must be installed by an operator (`scripts/bootstrap-python-runtime.sh`) before `ctx.db` / `ctx.storage` can reach the backend from Python.

### Enabling the runtime on a droplet

Operators install the runtime once per API host:

```
sudo GATEWAY_HOST=api.lingcode.dev NET_IFACE=eth0 \
  ./scripts/bootstrap-python-runtime.sh
```

The script installs `firejail` and `python3`, resolves the gateway host, and writes `/etc/lingcode/fn-gateway.nft`. Add `LC_FN_NET_IFACE` and `LC_FN_NFTABLES` to the API service env, then restart the API.
