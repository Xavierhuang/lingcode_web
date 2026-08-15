---
title: Production checklist
description: Prepare a LingCode Cloud application for production security, reliability, performance, observability, backups, deployment, and incident response.
slug: /production/
availability: available
updated: 2026-08-09
---
# Production checklist

A backend is production-ready when it protects data, behaves predictably under expected load and failure, can be observed, and has a tested recovery path. A successful demo is not evidence for those properties.

## Security

Review [Security at LingCode Cloud](/docs/cloud/security/) for the platform controls and shared-responsibility boundary. The control plane enforces fail-closed production secrets, password throttling, hashed token lookup for new credentials, and project-scoped token issuance. The staged token migration preserves existing clients with no forced reconnect.

- Enable row-level security on every client-accessible table.
- Test anonymous, signed-in owner, signed-in non-owner, and administrative paths.
- Use `WITH CHECK` policies for inserted and updated row state.
- Keep vendor credentials in Secrets; never ship them through client code or function results.
- Restrict OAuth redirect origins and external fetch hosts.
- Require MFA for sensitive operator accounts.
- Review function inputs, outputs, logs, and raw HTTP handling for secret leakage.
- Run backend security advisors and resolve high-severity findings.

## Data model and performance

- Add primary keys and required constraints.
- Index foreign keys and columns used in filters, ordering, RLS, and cursor pagination.
- Use `EXPLAIN` on critical SQL functions with representative data volume.
- Paginate every collection that can grow.
- Bound batch writes and avoid client-side row-at-a-time loops.
- Move relational joins and aggregation into reviewed SQL functions.
- Add vector and full-text indexes before search tables grow large.

## Reliability

- Set application timeouts shorter than user-facing deadlines.
- Make retried writes idempotent with uniqueness or stable request keys.
- Handle expired sessions and network reconnects.
- Treat row Realtime as a notification and refetch after uncertain gaps.
- Keep long-running work out of short serverless functions.
- Verify database, object storage, and deployment backup behavior.
- Perform a restore test rather than assuming a backup file is usable.

## Observability

- Emit useful function logs without tokens or secret values.
- Preserve request IDs in unexpected-error UI and support reports.
- Monitor request rate, errors, latency, PostgreSQL pool pressure, slow queries, storage, and quota pressure.
- Create alerts for sustained failures and capacity risk, not every isolated error.
- Correlate a release or backend deployment with changes in errors and latency.

## Deployment

- Keep schema and function source under backend-as-code.
- Preview production changes and review every warning.
- Use expand-and-contract for incompatible schema transitions.
- Back up before destructive or high-risk data work.
- Deploy backend compatibility before application code depends on it.
- Smoke-test authentication, critical reads and writes, functions, storage, and domains.
- Verify `backend_source_status` against expected hashes.

## Privacy and retention

- Collect only data the product needs.
- Document retention for application rows, auth records, files, logs, and telemetry.
- Provide deletion behavior that covers related database and storage records.
- Avoid putting sensitive request bodies into analytics or unbounded logs.
- Understand any regulatory or residency obligations for your application.

## Capacity and limits

Review [Limits and quotas](/docs/cloud/limits.html) for the effective plan. Design pagination, uploads, functions, email, workers, schedules, and compute jobs for those ceilings. A quota response should become a clear operator or user action, not a generic crash.

## Release gate

Before broad release, write down:

1. the rollback decision and owner;
2. the health signals watched after deploy;
3. the recovery time and data-loss expectations;
4. the latest verified backup and restore result;
5. the support path for a user-facing incident.

Continue with [Reliability](/docs/cloud/production/reliability.html) and [Observability](/docs/cloud/production/observability.html).
