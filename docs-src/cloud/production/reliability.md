---
title: Reliability
description: Design LingCode Cloud applications for timeouts, retries, idempotency, database pools, realtime reconnects, backups, restores, and graceful degradation.
slug: /production/reliability.html
availability: available
updated: 2026-08-09
---
# Reliability

Reliability is the ability to keep serving correct results—or fail safely—when dependencies slow down, clients disconnect, processes restart, and operators deploy changes.

## Timeouts

Every layer needs a bounded deadline:

- client request timeout;
- gateway request and body limit;
- PostgreSQL statement timeout;
- function wall-clock timeout;
- vendor HTTP timeout;
- compute-job timeout.

A longer outer timeout cannot rescue a shorter inner timeout. Set the client deadline slightly above the expected server maximum so the UI receives the server's structured failure instead of abandoning first.

## Retries

Retry only failures likely to be transient and only when the operation is safe to repeat.

Reads are generally safe to retry. Writes require a unique constraint, idempotency key, or application-specific deduplication. External side effects require the vendor's idempotency mechanism or reconciliation workflow.

Use bounded exponential backoff with jitter. Unlimited immediate retries turn a partial outage into a larger one.

## Database transactions

One current gateway write or SQL RPC call is one PostgreSQL transaction. Use one SQL function when several statements must be atomic today.

Keep transactions short. Do not hold a transaction open while waiting for user input or an external network response. Long transactions retain locks and old row versions, increase contention, and consume a pool connection.

## Connection pool

The API uses a small per-process `pg` pool in front of PgBouncer transaction pooling. Reliability depends on bounding both the number and duration of checked-out connections.

Monitor total, idle, and waiting clients. Sustained waiters mean requests are arriving faster than the pool or database can complete them. Investigate slow queries and transaction duration before increasing the pool, because a larger pool can overload PostgreSQL.

`LISTEN/NOTIFY` uses a direct stable PostgreSQL connection rather than transaction-pooled PgBouncer. The listener reconnects after error or end events.

## Realtime reconnect

The current Realtime stream can disconnect because of sleep, network transition, proxy timeout, deploy, or process restart. Clients should reconnect and refetch current state before applying new events.

Large rows may produce a body-less refetch signal because PostgreSQL NOTIFY payloads are bounded. Treat that as an instruction to query the source of truth.

Never assume receiving every row event is required for correctness. Store durable state in PostgreSQL and use Realtime to reduce latency.

## Graceful degradation

Decide what the application does when one capability is unavailable:

- show cached read-only content when writes fail;
- queue a user-visible retry instead of silently dropping intent;
- keep authentication errors distinct from network errors;
- allow core database work when an optional vendor is down;
- expose function-runtime unavailability without pretending a slug is missing;
- disable oversized uploads before transferring bytes.

## Backups

Production PostgreSQL uses physical or logical backup procedures appropriate to the deployment, with point-in-time recovery where configured. Object storage and application deployment artifacts have separate durability and retention characteristics.

A backup policy defines frequency, retention, encryption, access, off-host storage, and acceptable recovery point. The existence of a scheduled backup job is not proof of recoverability.

## Restore testing

Regularly restore to an isolated environment and verify:

- PostgreSQL starts and accepts reads;
- expected schemas, roles, extensions, and recent rows exist;
- authentication and RLS still behave correctly;
- object references resolve;
- application migrations recognize the restored state;
- measured restore time matches the recovery objective.

Never test restore by overwriting the only production database.

## Deployment failure

Backend manifest apply is artifact-aware and retry-safe, but an application can still be incompatible with a partially completed release. Deploy backward-compatible schema first, then application code, then cleanup schema.

If a high-risk change fails, stop automatic retries, preserve logs and hashes, assess committed state, obtain a fresh preview, and continue only after the remaining plan is understood.
