---
title: Backend-as-code
description: Define LingCode Cloud migrations and custom functions in a repository manifest with immutable hashes, safe previews, drift detection, and retryable deployment state.
slug: /deployments/backend-as-code.html
availability: available
updated: 2026-08-09
---
# Backend-as-code

Backend-as-code makes repository files the reviewable source of truth for LingCode Cloud schema and custom functions. It lets a developer or agent author the backend without manually reproducing every change in the console.

## Directory layout

```text
lingcode/
  backend.json
  migrations/
    20260809_create_messages.sql
    20260810_add_messages_room_index.sql
  functions/
    send-message.ts
    moderate-message.ts
```

`lingcode/backend.json` declares each artifact. Paths are relative to the `lingcode/` directory and cannot escape it.

```json
{
  "$schema": "https://lingcode.dev/schemas/backend-v1.json",
  "version": 1,
  "migrations": [
    { "id": "20260809_create_messages", "path": "migrations/20260809_create_messages.sql" }
  ],
  "functions": [
    {
      "slug": "moderate-message",
      "path": "functions/moderate-message.ts",
      "enabled": true,
      "secrets": ["MODERATION_API_KEY"],
      "testInput": { "body": "hello" }
    }
  ]
}
```

## Deployment payload

The deployment tool reads every declared file, computes its lowercase SHA-256, and sends three parts:

- normalized manifest;
- file contents keyed by declared path;
- SHA-256 hashes keyed by the same path.

Undeclared files and hashes are rejected. Missing files, invalid paths, duplicate IDs or slugs, unexpected manifest properties, hash mismatches, invalid secret names, and oversized functions fail before apply.

## Immutable migrations

The server records migration ID, path, SHA-256, deploying user, and deployment time. Reusing an applied ID with different SQL is an **immutable migration drift** error.

Do not edit an applied migration to make local history look clean. Add a new migration that deliberately moves the deployed schema forward.

## Function state

Function state records slug, path, source hash, enabled state, and declared secret names. An unchanged function is skipped. A changed function is tested when `testInput` exists, then saved.

Omission never deletes a deployed function. Use the explicit delete operation when removal is intended and verify no application caller or schedule still references the slug.

## Preview

Call `deploy_backend_manifest` with `mode: "preview"`. The response includes:

- environment classification;
- canonical digest;
- counts of migrations and function changes;
- per-artifact changed or unchanged state;
- warnings for destructive or risky patterns;
- whether confirmation is required.

Warnings are advisory and do not claim to prove arbitrary SQL safe. Blocking validation and migration drift remain errors.

## Apply

Development may auto-apply a clean preview. Production apply must supply the returned plan ID, digest, confirmation summary, and warnings exactly as approved.

Apply rechecks ownership, environment, expiry, plan consumption, digest, and payload before changing data-plane state. Completed artifacts are retry-safe: after a partial failure, request a fresh preview. Already applied unchanged artifacts appear as skipped and remaining artifacts can continue.

## Verify deployed source

Call `backend_source_status` after apply. It returns the server's recorded migration and function artifacts with hashes and metadata.

Compare that response with the local manifest and hashes in CI or release validation. A green deployment response is not a substitute for application smoke tests.

## Agent workflow

The recommended agent sequence is:

1. inspect current manifest and deployed status;
2. create new migration and function files;
3. update `lingcode/backend.json`;
4. run local validation and function test inputs;
5. calculate hashes from the final bytes;
6. preview;
7. present the exact production summary and warnings;
8. obtain approval;
9. apply the unchanged plan;
10. call `backend_source_status` and report the result.

An agent may prepare production changes, but preparation is not authorization to deploy them.
