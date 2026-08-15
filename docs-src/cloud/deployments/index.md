---
title: Deployments
description: Understand LingCode Cloud development and production environments, backend-as-code, migrations, function deployment, previews, approvals, and application hosting.
slug: /deployments/
availability: available
updated: 2026-08-09
---
# Deployments

A LingCode Cloud deployment changes durable backend or application state. Treat it as a reviewed transition from one known version to another, not as an editor save sent directly to production.

## What can be deployed

| Artifact | Source of truth | Deployment behavior |
| --- | --- | --- |
| Database schema | Ordered SQL migrations | Apply once by immutable migration ID and hash |
| Custom function | TypeScript source and metadata | Validate, optionally test, then upsert by slug |
| Secrets | Encrypted control-plane values | Set separately; manifests declare names only |
| Hosted application | Built static or Worker-compatible bundle | Upload a version and atomically switch active release |
| Compute job | `lingcode.compute.json` and image | Paid-tier container deployment and scheduling |

## Development and production

**Development** prioritizes fast feedback. A clean backend manifest preview may apply automatically unless `autoApply` is false. Validation, path checks, hashes, migration drift detection, size checks, and permissions still run.

**Production** prioritizes operator intent. Preview returns an exact change summary, warnings, digest, and short-lived plan. Apply requires explicit approval of that same plan. A file change invalidates the approval.

## Recommended workflow

1. Make backend changes under `lingcode/`.
2. Run local syntax, type, migration, and function tests.
3. Request a backend deployment preview.
4. Review changed migrations, functions, warnings, and environment.
5. Apply automatically in development or explicitly approve production.
6. Query `backend_source_status` and smoke-test the deployed behavior.
7. Monitor logs, errors, database pressure, and application health.

## Database migrations

Migrations are forward-only source artifacts. Once a migration ID has been applied, changing its contents is drift and deployment fails. Add a new migration instead.

Transactional PostgreSQL DDL rolls back when the migration fails, but not every operational change is risk-free. Large table rewrites, long index builds, destructive column changes, and application/schema compatibility require planning beyond SQL transaction semantics.

## Function deployment

A function deploy validates source size, slug, declared secret names, enabled state, and optional sample input. Saving a new function version does not grant it more database or storage access than its backend security context already permits.

Existing omitted functions are not deleted automatically. Deletion is an explicit operation.

## Application deployment

LingCode can deploy static frontends and Worker-compatible full-stack applications to `*.run.lingcode.dev`, with custom domains. Framework detection and build adaptation happen before upload. Plain persistent Node servers are not deployed as-is because the application runtime is a V8 isolate rather than an always-on process.

## Rollback boundaries

Application releases can switch back to a retained prior bundle when the platform still has that version. Database rollback is application-specific: never assume the inverse of arbitrary SQL is safe or even possible.

For a destructive migration, use expand-and-contract:

1. add the new schema in a backward-compatible form;
2. deploy code that can read both versions and writes the new representation;
3. backfill and verify;
4. stop old writes;
5. remove old schema in a later migration.

Continue with [Backend-as-code](/docs/cloud/deployments/backend-as-code.html) and [Production approval](/docs/cloud/deployments/production-approval.html).
