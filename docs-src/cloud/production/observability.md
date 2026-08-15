---
title: Observability
description: Use LingCode Cloud logs, metrics, request identifiers, traces, dashboards, alerts, and deployment correlation without leaking sensitive data or creating high-cardinality metrics.
slug: /production/observability.html
availability: available
updated: 2026-08-09
---
# Observability

Observability should answer: what failed, for whom, at which release, in which component, how often, and whether the system is recovering—without exposing private application data.

## Logs

Backend logs capture timestamp, source, severity, and bounded message text. Function execution logs should include a request ID, function slug, outcome, duration, and safe diagnostic context.

Good log fields:

- request ID and trace ID;
- backend and deployment environment;
- source component and operation;
- function kind and slug;
- duration, attempt count, and row count;
- HTTP status and stable error code;
- release or backend digest.

Never log access tokens, refresh tokens, anon keys, secret values, password material, complete payment payloads, or unrestricted private request bodies.

## Request ID

Every unexpected public error should carry a **request ID**. Show it in support-friendly UI and keep it through gateway, function, database, and vendor logs.

A request ID is diagnostic correlation, not authentication. It should not grant access to logs or data.

## Metrics

Useful service metrics include:

- request and function invocation rate;
- error rate by safe category;
- latency percentiles;
- PostgreSQL query duration;
- pool total, idle, and waiting clients;
- active Realtime subscribers and reconnects;
- storage bytes and object count;
- quota rejections;
- worker and compute concurrency;
- backup age and restore-test result.

## Cardinality

Prometheus labels must have bounded cardinality. Function kind, outcome, route pattern, and HTTP status are safe examples. Backend IDs, user IDs, request IDs, raw URLs, function slugs, object paths, and error messages are not.

Put high-cardinality identifiers in structured logs or traces, where retention and access controls are appropriate.

## Slow queries

The data plane records query duration and warns above the configured slow-query threshold. Investigate query plans, missing indexes, broad scans, RLS expressions, lock waits, and excessive result size.

Do not fix every slow query by raising `statement_timeout`. A timeout is a blast-radius guard, not a performance strategy.

## Dashboards

At minimum, maintain views for:

- traffic, errors, and latency;
- database connection and query health;
- functions and external dependencies;
- Realtime connections;
- storage and quotas;
- deployment markers;
- backup and restore health.

Compare current signals with a normal baseline and annotate deploys. Absolute thresholds alone miss gradual regressions.

## Alerts

Alert on sustained user impact or capacity risk:

- elevated error ratio;
- high latency over several windows;
- database or PgBouncer unavailable;
- persistent pool waiters;
- backup overdue or restore test failed;
- storage or disk nearing capacity;
- repeated function-runtime failure;
- abnormal authentication rejection.

Each alert needs an owner, severity, user impact, first diagnostic query, and escalation path. Avoid alerts that fire on one harmless event and train operators to ignore them.

## Application telemetry

The LingCode SDK can record product events, screens, traces, errors, user IDs, and user properties. Application telemetry is separate from infrastructure logs. Define consent, retention, naming, and sensitive-data rules before broad collection.

Use telemetry to understand user outcomes; use protected backend logs and metrics to diagnose service behavior.
