# Compute Tier — Security Review (SP1 gate)

Scope: the privileged-DB + arbitrary-code execution boundary introduced by the
compute tier (`cloud-compute.js`, `cloud-compute-runner.js`, the `clogin_<id>`
role in `cloud-data-plane.js`). This is the review the SP1 acceptance criteria
require before any non-owner workload runs.

## Trust model (what we're defending)

A compute job runs the **backend owner's own code** against the **owner's own
schema**. So the threat is NOT "owner reads owner's data" (that's the point). The
threats that matter:

1. **Cross-tenant** — can backend A's job reach backend B's schema (`be_<B>`),
   another tenant's files, or another tenant's DB connection budget?
2. **Cluster** — can arbitrary job code escalate on the Postgres cluster
   (superuser, create roles, replication) or the host (container escape)?
3. **Credential** — can `LINGCODE_DB_URL` or vault secrets leak to other tenants
   or persist on disk?

Isolation rests on **two hard boundaries**, deliberately NOT on RLS:
- **Postgres GRANTs** — `clogin_<id>` is a member of `trole_<id>`, which has grants
  ONLY on `be_<id>`. No grant on any other `be_<x>` schema exists, so cross-tenant
  data is unreachable regardless of `BYPASSRLS`.
- **A per-tenant DB password** + the network path to Postgres.

`BYPASSRLS` is the Supabase-`service_role` equivalent: it lets the owner's trusted
server code skip per-user RLS **within its own schema**. Because the role can only
reach `be_<id>`, the bypass can't widen blast radius beyond the owner's own data.

## Findings & dispositions

| # | Finding | Severity | Disposition |
|---|---------|----------|-------------|
| **F-1** | `public` is in the role `search_path` (needed for extension types like pgvector `vector`). If any tenant can `CREATE` in `public`, the shared schema becomes a cross-tenant write/read surface. | Med | **Ops action (documented, not auto-applied):** `REVOKE CREATE ON SCHEMA public FROM PUBLIC` cluster-wide so `public` holds extensions only. Left to ops because it's a global change; flagged in code comments + here. |
| **F-2** | `ALTER ROLE … PASSWORD` can't bind params → the password is interpolated. | Med | **Fixed.** `ensureComputeLoginRole` now asserts the password is `^[A-Za-z0-9_-]+$` (base64url) before interpolation — nothing to escape. Callers already generate base64url. |
| **F-3** | `LINGCODE_DB_URL` + secrets are written to a tmp env-file; a runner crash between write and `unlink` leaves it on disk. | Low | **Fixed.** File is `0600` and deleted in a `finally`; `startComputeRunner` also sweeps stale `lcrun-*.env` on boot. |
| **F-4** | `clogin_<id>` privilege creep — could it gain SUPERUSER/CREATEROLE/etc.? | High if wrong | **Verified safe.** `CREATE ROLE … LOGIN BYPASSRLS IN ROLE trole_<id>` — no SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSDDL. `INHERIT` (default) only inherits `trole_<id>`'s one-schema grants. |
| **F-5** | One backend's jobs could open unbounded connections and starve the cluster. | Med | **Fixed.** `ALTER ROLE … CONNECTION LIMIT` (env `COMPUTE_PG_CONNECTION_LIMIT`, default 10) caps concurrent connections per tenant role. |
| **F-6** | `statement_timeout` defaults to 0 (no cap) — a runaway query holds locks. | Low | **Accepted + bounded.** No timeout is the *point* of the tier (long batches). Blast radius is the tenant's own schema (locks are in `be_<id>`); the container wall-clock timeout (`docker kill`) drops the connection, so Postgres terminates the backend. Operators can set `COMPUTE_PG_STATEMENT_TIMEOUT_MS` per deployment. |
| **F-7** | Arbitrary code ran in a container with default Docker caps (escape surface). | High | **Fixed (defaults on).** Runner adds `--pids-limit=512 --cap-drop=ALL --security-opt=no-new-privileges --read-only --tmpfs=/tmp`. Overridable via `COMPUTE_HARDEN_FLAGS` for images needing more (the SP3 Chromium image will add back the seccomp/caps it needs — explicitly, per-image). |
| **F-8** | The compute docker network could let job code reach other internal services (control-plane API, sibling droplets, the metadata endpoint). | High | **Partially addressed; completed in SP3.** Today: gate on `COMPUTE_DOCKER_NETWORK` reaching ONLY Postgres. SP3's egress allow-list is the full fix. **Must be verified on the box** before non-owner workloads: the compute network must not route to 169.254.169.254 (cloud metadata) or the control-plane host. |
| **F-9** | Credential injection via `-e` would expose `LINGCODE_DB_URL` in `docker inspect`/host process table. | Med | **Fixed by design.** Secrets go via `--env-file` (0600), never `-e`. |
| **F-10** | Image intake accepts a tarball — a malicious image could embed host-mount escapes. | Med | **Mitigated.** No `-v`/bind-mounts are ever added by the runner; F-7 hardening + `--read-only` constrain the image. Tarball size capped (`COMPUTE_MAX_IMAGE_BYTES`). Image provenance (signing/scan) is an SP4 hardening item. |

## Residual risk requiring the box (verify before non-owner workloads)

1. **F-8 network egress** — confirm the compute docker network reaches Postgres
   ONLY: no cloud metadata endpoint (169.254.169.254), no control-plane API, no
   sibling tenants. (`docker run … curl http://169.254.169.254/` must fail.)
2. **Cross-schema isolation, live** — Gate 2's negative case: a job for backend A
   querying `be_<B>.<table>` must error with permission denied (proves grants, not
   RLS, are the boundary).
3. **F-1** — apply `REVOKE CREATE ON SCHEMA public FROM PUBLIC` and re-verify
   pgvector/extension types still resolve for both gateway and compute paths.

## Verdict

The two **hard isolation boundaries** (per-tenant GRANTs + per-tenant password)
hold under review; `BYPASSRLS` does not widen them. The fixable findings (F-2, F-3,
F-5, F-7, F-9) are implemented. The remaining gates (F-8 network, live cross-schema,
F-1 public lockdown) are **host-level** and are the explicit go/no-go checks for
opening compute to workloads beyond the backend owner's own code.
