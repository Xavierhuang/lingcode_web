---
title: Function error handling
description: Preview the function error taxonomy, safe production redaction, retry boundaries, request identifiers, logging, and client handling patterns.
slug: /functions/errors.html
availability: preview
updated: 2026-08-09
---
# Function error handling

Useful function errors tell an application what it can do next without leaking implementation details. LingCode distinguishes expected application errors, validation errors, developer errors, resource-limit errors, and platform errors.

## Error categories

| Category | Example | Client behavior | Retry |
| --- | --- | --- | --- |
| Application error | Room is archived | Show the safe message or branch on code | Only after user state changes |
| Validation error | `body` exceeds 10,000 characters | Fix the request | No |
| Authorization error | User cannot edit this project | Sign in or remove the action | No |
| Developer error | Accessing a missing property | Show a generic failure; inspect logs | No automatic retry |
| Resource limit | Query scanned too much data | Change query/index/pagination | No |
| Transaction conflict | PostgreSQL `40001` | Platform retries a mutation within budget | Automatic for mutations only |
| Platform error | Temporary internal connection failure | Retry according to response policy | Platform or bounded client retry |

## Application errors

Throw a structured application error for a condition the UI is expected to handle:

```ts
throw new LingCodeError('room_archived', {
  message: 'This room no longer accepts messages.',
  roomId: args.roomId,
});
```

Codes are stable API. Messages are user-facing copy and may change or be localized. Data must contain only values safe for the caller.

## Developer errors

A bug, invalid return value, unexpected database result, or uncaught exception is a developer error. Development environments may return a useful stack trace to an authorized developer.

In production, developer errors are redacted to a generic server error with a request identifier. Full function name, stack, duration, attempt count, and database error metadata remain in protected logs.

## Actions and ambiguous failure

An action may complete an external side effect and lose the response. Because the outcome is ambiguous, actions are not automatically retried. Use a durable workflow record and vendor idempotency key so reconciliation can determine the actual result.

## Mutations and retry

Mutations retry only serialization and deadlock errors because their transaction has not committed. Every attempt starts from a new snapshot. The platform stops after three total attempts and returns the final safe error.

Customer exceptions, validation failures, RLS denials, timeouts, and explicit application errors are not retryable transaction conflicts.

## Client handling

```tsx
try {
  await sendMessage({ roomId, body });
} catch (error) {
  if (isLingCodeError(error, 'room_archived')) {
    showArchivedState();
  } else {
    showUnexpectedError(error.requestId);
  }
}
```

Do not branch on English error text. Use a documented code and retain the request identifier in bug reports.

## Logging

Logs should include request ID, backend, function, kind, outcome, duration, attempt count, conflict count, and safe structured fields. They must not include access tokens, anon keys, secret values, full private request bodies, or unrestricted vendor responses.

Metrics use low-cardinality labels such as function kind and outcome. Backend IDs, user IDs, and function slugs belong in logs and traces, not Prometheus label values.

## Current behavior

Current custom functions return `function_error` for handler failures, `functions_runtime_unavailable` when Deno cannot run, and a timeout message when the wall-clock limit terminates the subprocess. The Preview Python runtime adds `python_runtime_unavailable` (HTTP 503, when firejail or `python3` is missing from the API host) and `python_runtime_not_enabled` (HTTP 403, when the backend has not been enrolled in the Preview). Consult [Custom functions](/docs/cloud/functions/custom-functions.html) for available behavior while this error contract remains Preview.
