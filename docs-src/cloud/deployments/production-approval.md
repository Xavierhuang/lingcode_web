---
title: Production deployment approval
description: Review and approve exact LingCode Cloud production backend plans using expiring, digest-bound, single-use confirmation envelopes.
slug: /deployments/production-approval.html
availability: available
updated: 2026-08-09
---
# Production deployment approval

Production backend changes require approval of an exact preview. The approval design prevents a stale confirmation, changed file, different user, or different project from authorizing another deployment.

## Preview response

A production preview returns:

```json
{
  "mode": "preview",
  "environment": "production",
  "confirmationRequired": true,
  "planId": "<short-lived-plan-id>",
  "digest": "<64-character-sha256>",
  "expiresAt": "<timestamp>",
  "summary": {
    "migrations": 1,
    "functions": 2,
    "deletions": 0
  },
  "warnings": []
}
```

The plan expires after **10 minutes**. It is bound to the current user, project, backend, environment, canonical payload, summary, and warnings.

## What approval means

Approval authorizes only the previewed artifacts. Before confirming, review:

- production environment label;
- every new migration and its SQL;
- every function source and declared secret name;
- destructive and performance warnings;
- application compatibility and rollout order;
- backup and recovery readiness;
- the exact summary shown by the client.

Approval does not mean arbitrary future file changes are allowed.

## Apply envelope

Apply sends `mode: "apply"`, the exact `planId`, exact `digest`, and the confirmation summary and warnings returned by preview. The server reauthorizes access and recomputes the canonical payload.

Any file, manifest, metadata, or hash change requires a new preview. An expired, changed, cross-user, cross-project, or cross-backend plan fails without deploying.

## Single use

The plan is marked **consumed** atomically when apply begins. A consumed plan cannot be replayed.

Artifact state remains retry-safe. If apply stops after some artifacts finish, obtain a new preview. Completed hashes appear unchanged; unapplied artifacts remain in the change set.

## No watch deploy

Production has **no watch deploy**. Saving a file, changing `lingcode/`, restarting the IDE, or reconnecting an agent does not automatically mutate production.

Development auto-apply is an environment-specific convenience and never broadens production authorization.

## Approval UX

Clients should show a compact summary first, then expandable artifact details and warnings. The confirmation action must name the production backend and use deployment language such as **Deploy**, not an ambiguous **Continue**.

If the plan expires while the user reviews it, generate and display a fresh preview rather than silently substituting a new plan.

## Audit and verification

Record approving user, backend, digest, plan, timestamp, artifacts, and outcome in protected audit logs. After success, call `backend_source_status`, exercise critical reads and writes, and observe errors and latency.
