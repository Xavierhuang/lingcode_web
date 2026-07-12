# Compute Tier — Deployment Runbook (Stage 0)

How to take the compute tier from "built + unit-tested" to "running on the VPC,
gates green." This is the **prerequisite for everything else** in the pipeline
migration (Stages 1–4): no container job can run until the runner is live and
`gates.sh` passes. Everything here is host/ops work — the application code
(`cloud-compute*.js`) is already wired in `index.js` and ships dormant.

Companion docs: [`COMPUTE_TIER.md`](COMPUTE_TIER.md) (architecture),
[`COMPUTE_SECURITY_REVIEW.md`](COMPUTE_SECURITY_REVIEW.md) (the F-* findings this
runbook closes out at the host layer).

---

## 0. Topology decision (read first)

**v1 runs the runner on the same box as the API process.** The job queue lives in
the control-plane **SQLite** DB (`compute_runs`), and the runner reads it directly
(`better-sqlite3`, in-process) — so in v1 the executor must be co-located with the
API process that owns that SQLite file. You do **not** stand up a separate worker
fleet yet; you turn the runner **on** where the API already runs, and make sure
that box has Docker + private-network reach to Postgres.

```
┌─────────────────── API box (e.g. /opt/lingcode-api) ───────────────────┐
│  node index.js                                                          │
│   ├─ HTTP API + gateway + cloud-compute routes                          │
│   ├─ control-plane SQLite  (compute_jobs / compute_runs / schedules)    │
│   └─ cloud-compute-runner   ← COMPUTE_RUNNER_ENABLED=1 activates it      │
│        └─ docker run  <job image>  (--env-file: LINGCODE_DB_URL + vault) │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ VPC private network (NYC3)
                    ┌──────────▼───────────┐
                    │ managed Postgres VM  │  10.108.0.2  (be_<id> schemas)
                    └──────────────────────┘
```

> **When to graduate to a separate worker fleet:** only once the ingestion load
> (the 44 jobs, overnight 04:00–11:00 UTC) competes with API CPU/RAM on the shared
> box. That requires moving the queue from SQLite → managed Postgres so multiple
> runner droplets can claim atomically (the claim logic is already
> process-safe; only the storage needs to move). Deliberate follow-on — not Stage 0.
> Until then: **run the API box big** (4+ vCPU / 8+ GB) so containers have headroom.

---

## 1. Prerequisites

On the API box (the one with the SQLite control-plane DB):

- [ ] **Docker installed and running** (`docker version` works as the API's user, or
      the API user is in the `docker` group). The runner shells out to `docker`.
- [ ] **Private-network reach to Postgres** — the box can open a direct (non-PgBouncer)
      connection to the managed PG VM on the VPC. Test:
      `psql "$CLOUD_PG_DIRECT_URL" -c 'select 1'`.
- [ ] **At least one provisioned backend** so `be_<id>` + `trole_<id>` exist (the
      cliffslist backend already qualifies).
- [ ] **A superuser/owner PG URL for role minting.** `ensureComputeLoginRole` creates
      `clogin_<id>` (a `BYPASSRLS` login that inherits `trole_<id>`'s one-schema grants).
      Whatever PG principal `CLOUD_PG_DIRECT_URL` authenticates as must be allowed to
      `CREATE ROLE` / `GRANT`. Confirm it is **not** itself superuser-exposed to jobs —
      jobs only ever receive the minted `clogin_<id>` URL, never this admin URL.

---

## 2. Environment (set on the API box)

Add to the API process's environment (systemd drop-in below). Only
`COMPUTE_RUNNER_ENABLED` + `CLOUD_PG_DIRECT_URL` are strictly required; the rest have
working defaults (see [`COMPUTE_TIER.md`](COMPUTE_TIER.md) § Environment).

| Var | Value (example) | Notes |
|---|---|---|
| `COMPUTE_RUNNER_ENABLED` | `1` | **Activates the runner.** Without it, routes serve but no job runs. |
| `CLOUD_PG_DIRECT_URL` | `postgres://owner:***@10.108.0.2:5432/lingcode` | **Direct** PG (not PgBouncer 6543). Creds get swapped to `clogin_<id>` per job. |
| `COMPUTE_PG_STATEMENT_TIMEOUT_MS` | `0` | `0` = no per-statement cap (the whole point — 800s batches). Set a ceiling later if desired. |
| `COMPUTE_DOCKER_NETWORK` | `host` *or* a VPC bridge | The network that lets a container reach `10.108.0.2`. `host` is simplest on the API box; a dedicated bridge is tighter (see §6). |
| `COMPUTE_MAX_CONCURRENT` | `4` | Containers at once on this box. Keep low until you've sized RAM (each browser job can want ~1 GB). |
| `COMPUTE_IMAGE_DIR` | `/var/lib/lingcode/compute-images` | Where uploaded image tarballs land. Must be writable by the API user; size it for your image set. |
| `COMPUTE_MANAGED_IMAGES` | `lingcode/compute-node:20` | Base images a job may reference without uploading. |
| `COMPUTE_HARDEN` / `COMPUTE_HARDEN_FLAGS` | (defaults) | Leave default for Node jobs. Browser jobs override per §6. |

Create the image dir:

```bash
sudo mkdir -p /var/lib/lingcode/compute-images
sudo chown lingcode:lingcode /var/lib/lingcode/compute-images   # the API user
```

---

## 3. Build the managed base image

Jobs build `FROM lingcode/compute-node:20` (Node 20 + `pg` + CA certs). Build it once
on the API box (or in CI and `docker save`/`load` it over):

```bash
cd /opt/lingcode-api/website/server/compute-images   # adjust to your checkout path
docker build -t lingcode/compute-node:20 node-base
docker images | grep compute-node                    # confirm present
```

(The SP3 browser base — Playwright + Chromium — is `browser-base/Dockerfile` →
`lingcode/compute-browser:20`; build it only when you start scraping jobs, §6.)

---

## 4. Turn the runner on

The runner ships in `index.js` (`startComputeRunner`) and no-ops unless
`COMPUTE_RUNNER_ENABLED=1`. So "turning it on" = adding the env and restarting the
API service. With systemd, use a drop-in (don't edit the unit in place):

```bash
sudo systemctl edit lingcode-api        # adjust to the actual unit name
```

```ini
[Service]
Environment=COMPUTE_RUNNER_ENABLED=1
Environment=CLOUD_PG_DIRECT_URL=postgres://owner:***@10.108.0.2:5432/lingcode
Environment=COMPUTE_PG_STATEMENT_TIMEOUT_MS=0
Environment=COMPUTE_DOCKER_NETWORK=host
Environment=COMPUTE_IMAGE_DIR=/var/lib/lingcode/compute-images
Environment=COMPUTE_MAX_CONCURRENT=4
```

```bash
sudo systemctl restart lingcode-api
journalctl -u lingcode-api -n 30 --no-pager | grep cloud-compute-runner
# expect:  [cloud-compute-runner] active worker <host>:<pid> (max 4, poll 2000ms)
# NOT:     [cloud-compute-runner] dormant (COMPUTE_RUNNER_ENABLED != 1)
```

The migration (`migrateComputeTables`) runs on boot, so `compute_jobs`,
`compute_runs`, `compute_schedules`, `compute_db_creds`, and
`backend_usage.compute_run_seconds` are created automatically the first time the
updated `index.js` starts.

---

## 5. Run the acceptance gates

`compute-images/gates.sh` builds the base + two gate images, declares the jobs via
the REST API, uploads each image, fires a run, and polls for terminal status.

You need:
- `API_BASE` — the admin API base (use `http://127.0.0.1:<port>` from on the box).
- `TOKEN` — a backend-**owner** `api_access_token` (the compute routes are owner-gated).
- `BACKEND_ID` — the target backend id (use the cliffslist backend, or a throwaway).

```bash
cd /opt/lingcode-api/website/server/compute-images
API_BASE=http://127.0.0.1:3000 \
TOKEN=<owner api_access_token> \
BACKEND_ID=<be_id> \
./gates.sh
```

**Gate 1 (hello-world):** job runs, `status: succeeded`, `exit_code: 0`, prints
`GATE1_PASS`. Proves: queue → claim → `docker run` → log capture → terminal status.

**Gate 2 (5000-row single txn):** connects via `LINGCODE_DB_URL`, `CREATE TABLE` +
5000-row `INSERT … SELECT generate_series` + `SELECT count(*)` = 5000, in **one
transaction**, prints `GATE2_PASS`. Proves the privileged path: this is **impossible
through the CRUD gateway** (200-row select / 1000-row rpc / single-statement) — green
here is the entire reason the tier exists.

Expected tail: `== all gates passed ==`. If it fails, see §7.

---

## 6. Security / isolation host checks (close out before non-owner workloads)

Stage 0 only needs to run **your own** (cliffslist) jobs, so these can trail the gates
slightly — but they MUST be done before any third-party tenant runs compute. From
[`COMPUTE_SECURITY_REVIEW.md`](COMPUTE_SECURITY_REVIEW.md):

- **F-1 — admin API not public.** The compute routes live under the owner-authed admin
  API. Confirm that surface isn't reachable from the public internet (bind to the VPC /
  localhost + reverse proxy with auth), so a job image can't be uploaded by a stranger.
- **F-8 — egress.** A job declares `egress_hosts`; the runner passes it as
  `LINGCODE_EGRESS_HOSTS` (informational) but the **box** must enforce it. With
  `COMPUTE_DOCKER_NETWORK=host` there is **no egress isolation** — fine for trusted
  first-party cliffslist jobs, NOT for untrusted tenants. For multi-tenant: use a
  dedicated docker bridge + a default-deny egress firewall allowing only declared hosts
  (Ticketmaster/Eventbrite/Meetup/Luma/OpenAI/Resend for cliffslist).
- **Live cross-schema deny.** Confirm a job using `LINGCODE_DB_URL` for backend A
  **cannot** read `be_<B>` (no grant → permission denied). Gate 2's note covers this;
  run it explicitly with two backends before opening the tier up.
- **F-7 (container hardening)** is already applied by default in the runner
  (`--cap-drop=ALL --read-only --pids-limit --no-new-privileges --tmpfs`). Browser jobs
  relax it via `COMPUTE_HARDEN_FLAGS` + Chromium `--no-sandbox`; scope that per-job, not
  globally.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `dormant (COMPUTE_RUNNER_ENABLED != 1)` in logs | env not picked up | confirm the drop-in + `systemctl restart`; `systemctl show lingcode-api -p Environment`. |
| Gate run stuck `queued` forever | runner not active, or another box owns the SQLite DB | check the "active worker" log line; ensure the runner runs where the SQLite file lives. |
| Run `failed`, log `image tarball missing` | upload step didn't land / wrong `COMPUTE_IMAGE_DIR` | verify the dir is writable + matches env on the running process. |
| Gate 2 fails on connect | `CLOUD_PG_DIRECT_URL` unreachable from inside the container | with `network=host` test `psql` from the box; with a bridge, confirm the container can route to `10.108.0.2`. |
| Gate 2 fails on `CREATE ROLE`/grant | the admin PG principal can't mint `clogin_<id>` | grant it `CREATEROLE` (NOT superuser); re-run. |
| Container can't reach provider APIs (later jobs) | egress firewall too tight / wrong network | check `LINGCODE_EGRESS_HOSTS` + the box firewall allow-list. |
| Containers pile up after a crash | orphaned `--rm` should self-clean | `docker ps -a | grep lcrun-`; the runner sweeps orphaned `0600` env-files on boot. |

---

## Done when

- [ ] `[cloud-compute-runner] active worker …` in the API logs.
- [ ] `gates.sh` prints `== all gates passed ==` (Gate 1 + Gate 2 green).
- [ ] Cross-schema deny verified (backend A job can't read backend B).
- [ ] (Before any non-cliffslist tenant) F-1 + F-8 host checks closed.

Once this is green, **Stage 1** (bring the full events/`event_search`/trigger schema
to the cliffslist backend) and **Stage 2** (port the first ingestion job, pointed at
`LINGCODE_DB_URL`) are unblocked.
