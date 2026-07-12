# LingCode Cloud — Compute Tier (Sub-project 1)

Long-running **container jobs** that run against a tenant backend's Postgres schema
with a privileged, schema-scoped connection. This is the heavy tier the 30s
function/cron paths (`cloud-functions.js`, `cloud-worker-cron.js`) deliberately
can't host — built for 800s batches, headless Chromium, OpenAI loops, and any
arbitrary long-running code (e.g. cliffslist's 44-cron ingestion pipeline).

## Pieces

| File | Role |
|---|---|
| `migrate.js` → `migrateComputeTables` | control-plane SQLite: `compute_jobs`, `compute_runs`, `compute_schedules`, `compute_db_creds` (+ `backend_usage.compute_run_seconds`) |
| `cloud-data-plane.js` → `ensureComputeLoginRole` / `dropComputeLoginRole` | mints the per-tenant **`clogin_<id>`** Postgres login → `LINGCODE_DB_URL` |
| `cloud-compute.js` | job CRUD + run-enqueue + image-intake HTTP routes, access gate, `getComputeDbUrl` |
| `cloud-compute-runner.js` | the executor daemon: claims queued runs, injects vault secrets + `LINGCODE_DB_URL`, `docker run` (hardened), streams logs, enforces timeout/cancel, meters run-seconds |
| `cloud-compute-scheduler.js` (SP2) | cron scheduler: `enqueueDue` (overlap skip/queue/allow) + `retrySweep` (exponential backoff); schedule CRUD routes |
| `cloud-limits.js` | per-tier `maxComputeJobs` / `maxComputeConcurrentRuns` / `maxComputeTimeoutSec` / `maxComputeMemoryMb` |

All wired in `index.js` (migrate + `registerCloudComputeRoutes` + `startComputeRunner` + `registerComputeScheduleRoutes` + `startComputeScheduler`).

> **v1 topology caveat.** The job queue lives in the control-plane **SQLite** DB, so
> the runner is **co-located with the API process** (same box) in v1 — set
> `COMPUTE_RUNNER_ENABLED=1` on the box that should also execute containers.
> True multi-droplet scale-out (separate worker boxes) requires graduating the
> queue from SQLite to the managed Postgres; that is a deliberate follow-on, not
> done here. For heavy workloads, run the API+runner box large, or do the Postgres-
> queue graduation first.

## The privileged DB path (the core unlock)

Each backend that uses compute gets a login role `clogin_<id>`:
- member of `trole_<id>` → inherits exactly the `be_<id>` schema grants, nothing else;
- `search_path = be_<id>, public`; `statement_timeout = COMPUTE_PG_STATEMENT_TIMEOUT_MS` (default 0 = none);
- **`BYPASSRLS`** — trusted *owner* server code (the Supabase service-role equivalent).
  The hard tenant boundary is the GRANT set (one schema) + a per-tenant DB password,
  **not** RLS. Per-user RLS is for untrusted client apps via the gateway. ⚠️ Flagged
  for the SP1/SP3 security review.

The minted `LINGCODE_DB_URL` points at **`CLOUD_PG_DIRECT_URL`** (straight to Postgres
in the VPC) — never PgBouncer — because session features the jobs need (advisory
locks, multi-statement transactions, `COPY`, unbounded result sets) don't survive
transaction pooling. The runner injects it via a `0600` `--env-file`, so it never
appears in `docker inspect` or the host process table.

## Environment

| Var | Where | Meaning |
|---|---|---|
| `COMPUTE_RUNNER_ENABLED=1` | **worker droplet only** | activates the executor. Unset on the API box → routes serve, runner stays dormant. |
| `CLOUD_PG_DIRECT_URL` | runner box | direct Postgres URL (host/port/db); creds get swapped to `clogin_<id>`. |
| `COMPUTE_PG_STATEMENT_TIMEOUT_MS` | runner box | per-session statement timeout (default `0` = none; the point of the tier). |
| `COMPUTE_MAX_CONCURRENT` | runner box | containers at once per runner process (default `4`). Scale out by running on more droplets — claims are atomic. |
| `COMPUTE_DOCKER_NETWORK` | runner box | docker network giving containers private reach to Postgres. |
| `COMPUTE_IMAGE_DIR` | both | where uploaded image tarballs land (default `/var/lib/lingcode/compute-images`). |
| `COMPUTE_MANAGED_IMAGES` | both | comma-list of base images a job may reference without uploading (default `lingcode/compute-node:20,22`). |
| `COMPUTE_POLL_MS`, `COMPUTE_LOG_TAIL_BYTES`, `COMPUTE_WORKER_ID` | runner box | poll cadence, captured log tail size, worker label. |

## Job environment (what a container receives)

Injected via a `0600 --env-file` (never `-e`):
- `LINGCODE_DB_URL` — the privileged connection (above).
- `LINGCODE_BACKEND_ID`, `LINGCODE_RUN_ID`, `LINGCODE_INPUT` (the run's JSON input).
- **All of the backend's vault secrets** (SP3) — `OPENAI_API_KEY`, `RESEND_API_KEY`,
  etc. via `readAllBackendSecrets`, so a job needs zero hardcoded keys. Precedence:
  vault secrets → job-declared `env` (can't shadow a secret) → reserved `LINGCODE_*`
  (always win).
- `LINGCODE_EGRESS_HOSTS` (SP3) — the job's declared allow-list (informational; the
  box enforces egress at the network layer).

## Browser jobs (SP3)

`compute-images/browser-base/Dockerfile` → `lingcode/compute-browser:20` (Playwright +
Chromium + `pg`). Chromium can't launch under the default hardening (`--cap-drop=ALL
--read-only`), so browser jobs run with a relaxed `COMPUTE_HARDEN_FLAGS` and Chromium
`--no-sandbox`. Per-job hardening profiles + live egress enforcement are the box-side
completion of SP3.

## Metering (SP4)

The runner records each run's `run_seconds` and rolls it into
`backend_usage.compute_run_seconds` per backend per UTC day (the same table every
other quota uses) — the basis for compute billing.

## REST surface (owner-authenticated, `/api/account/cloud-compute/:backendId`)

- `GET  /jobs` · `POST /jobs` (upsert by name; accepts `egress_hosts`) · `DELETE /jobs/:jobId`
- `PUT  /jobs/:jobId/image` — raw gzip of `docker save`; runner `docker load`s it
- `POST /jobs/:jobId/run` — enqueue (respects `maxComputeConcurrentRuns`)
- `GET  /runs` · `GET /runs/:runId` (incl. log tail) · `POST /runs/:runId/cancel`
- **Schedules (SP2):** `GET /schedules` · `POST /jobs/:jobId/schedules` (cron +
  `overlap_policy` + `max_retries` + `retry_backoff_sec`) · `PATCH /schedules/:id`
  (enable/disable) · `DELETE /schedules/:id`

> MCP tool + `lingcode compute` Swift CLI are thin wrappers over these endpoints
> and belong to **SP4 (authoring/deploy surfaces)** — not built here. REST is the
> tested, authoritative surface.

## Acceptance gates (run on the VPC worker droplet)

Prereqs: Docker installed, `COMPUTE_RUNNER_ENABLED=1`, `CLOUD_PG_DIRECT_URL` reachable,
a backend provisioned (so `be_<id>` + `trole_<id>` exist), a managed base image
(`lingcode/compute-node:20`) present.

**Gate 1 — hello-world.** Create a job using the managed base with an entrypoint that
prints and exits 0; `POST …/run`; poll `GET …/runs/:id` → expect `status: succeeded`,
`exit_code: 0`, and the printed line in `logs`.

**Gate 2 — 5000-row single transaction (proves the gateway caps are gone).** A job whose
entrypoint connects with `LINGCODE_DB_URL` and runs, in ONE transaction:
`CREATE TABLE IF NOT EXISTS probe(...)`, a 5000-row `INSERT … SELECT generate_series`,
then `SELECT count(*)` → expect `5000`. This is impossible through the CRUD gateway
(200-row select / 1000-row rpc / single-statement) — success here is the whole point
of the tier. Confirm cross-schema isolation too: the same job querying another
`be_<other>` table must error (no grant).

## What's verified vs. pending

- ✅ **Verified here** (Node, in-memory SQLite — `cloud-compute.test.js` +
  `cloud-compute-scheduler.test.js`, 15 tests): migration (4 tables + usage column);
  atomic FIFO claim + exhaustion (+ `not_before` gating); log-tail cap; `sanitizeJob`
  resource clamping, env filtering, managed-image gating, egress-list validation;
  run-seconds metering accumulation; scheduler due-detection, overlap skip/queue/allow,
  retry-with-backoff (idempotent). Password guards fire pre-DB. All files `node --check`
  clean; all compute modules require cleanly.
- ⏳ **Pending the VPC box** (no Docker/Postgres in this workspace): `gates.sh` end-to-end
  (Gates 1 & 2); the `security-review` host-level checks (F-1 public lockdown, F-8 network
  egress, live cross-schema deny — see `COMPUTE_SECURITY_REVIEW.md`); browser-job launch
  under a relaxed hardening profile; and the SQLite→Postgres queue graduation if/when
  multi-droplet scale-out is needed.
