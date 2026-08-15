---
title: Limits and quotas
description: Understand LingCode Cloud request, row, function, storage, auth, email, hosting, schedule, and compute limits and how quota errors should be handled.
slug: /limits.html
availability: available
updated: 2026-08-09
---
# Limits and quotas

Limits protect shared infrastructure, bound accidental work, and define plan capacity. Effective values can change by plan and operator configuration, so the backend's capability response and console are authoritative for a particular backend.

## Design principles

- Saved custom function definitions are unlimited; execution is bounded by time, memory, source, output, and usage.
- Large data sets are accessed with pagination, indexes, SQL RPC, or compute—not one unbounded gateway response.
- Large files use presigned direct-to-storage uploads rather than passing bytes through API memory.
- Long-running work uses container compute where available rather than extending request functions indefinitely.
- Quotas apply per relevant backend, application, user, or day as documented by the endpoint.

## Database requests

| Limit | Purpose | Application response |
| --- | --- | --- |
| Rows returned per read | Prevent one request from draining a shared database | Use cursor or range pagination |
| Rows per batch write | Bound bind parameters and transaction work | Split into deterministic chunks |
| Statement timeout | Release locks and connections from wedged SQL | Optimize or move heavy work to compute |
| SQL RPC result cap | Bound JSON response memory | Return pages or aggregates |
| Table count | Bound per-backend schema footprint | Archive, consolidate, or upgrade |

The data plane has hard safety ceilings in addition to plan values. A higher client-supplied limit cannot bypass them.

## Functions

- Unlimited saved function definitions.
- Maximum source: **256 KB** per custom function.
- Memory: **128 MB** V8 heap for the current Deno runtime.
- Tier-specific wall-clock timeout; current defaults range from seconds to tens of seconds.
- Bounded stdout and stderr capture.
- Declared secret-name count and format limits.

Do not split one cohesive function only to work around a saved-definition count; there is no enforced count cap. Split by responsibility, security boundary, and testability.

## Storage

Storage distinguishes:

- total bytes per backend;
- object count;
- small inline upload size;
- direct presigned upload size;
- single-object and provider ceilings.

The SDK automatically chooses the small inline or direct path. A backend warns near storage capacity before hard rejection where notification configuration permits.

## Authentication and email

Plans bound total managed users and daily managed-email sends. Authentication endpoints also apply security rate limits independently of paid capacity.

Do not expose whether a particular account exists through password-reset, verification, or magic-link responses.

## Hosting and schedules

Plans can bound deployed Worker applications, schedules per application, scheduled custom functions, and daily Worker requests. An over-quota hosted application may be suspended until capacity resets or the plan changes.

## Container compute

Paid compute limits include job definitions, concurrent runs, timeout, memory, and schedules. Free backends may have no container-compute allocation.

Queue, skip, or allow overlap deliberately for schedules. Concurrent-run limits are not a substitute for application locking when two jobs mutate the same logical resource.

## Error responses

A plan quota returns **HTTP 402** with stable code `quota_exceeded`. A single request that is too large commonly returns HTTP 413. Rate limiting commonly returns HTTP 429. Timeouts and unavailable services use their documented 5xx or function error.

```json
{
  "ok": false,
  "error": "quota_exceeded",
  "message": "Storage quota reached. Upgrade or free up space."
}
```

Handle stable codes, not English messages. Show the user or operator the constrained resource and a concrete next action.

## Designing for limits

- paginate before production data grows;
- index every pagination cursor and frequent filter;
- batch writes within the effective row ceiling;
- compress and resize media before upload where appropriate;
- use direct uploads for large files;
- cache safe reads at the application layer;
- make schedules idempotent and concurrency-aware;
- monitor 80% and 95% capacity thresholds;
- load-test with the effective production tier rather than local unlimited assumptions.
