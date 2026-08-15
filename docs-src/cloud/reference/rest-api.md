---
title: REST API
description: Call LingCode Cloud directly over HTTPS and handle authentication, envelopes, errors, pagination, and CORS safely.
slug: /reference/rest-api.html
availability: available
updated: 2026-08-09
---

# REST API

LingCode Cloud exposes HTTPS endpoints for clients that cannot use the JavaScript SDK. The REST API uses the same authentication, row-level security, quotas, and audit boundaries as SDK requests.

## Base URL and headers

Send requests to the backend URL shown in the LingCode backend panel. Include the public backend key and, for signed-in operations, the user's bearer token.

```http
Authorization: Bearer USER_ACCESS_TOKEN
X-LingCode-Key: PUBLIC_ANON_KEY
Content-Type: application/json
```

Never expose a service-role key to an untrusted client. Service credentials bypass user-level policy boundaries and belong only in controlled server environments.

## Success envelope

Successful JSON responses use the envelope { ok: true, data }. Collection responses may also include pagination metadata.

```json
{
  "ok": true,
  "data": [{ "id": "msg_123", "body": "Hello" }],
  "page": { "nextCursor": "opaque-cursor" }
}
```

Do not infer success from a JSON body alone. Always check the HTTP status first, then validate the envelope.

## Errors

Failures use an appropriate HTTP status and a structured error with a stable code and readable message.

```json
{
  "ok": false,
  "error": {
    "code": "quota_exceeded",
    "message": "Compute quota exceeded",
    "requestId": "req_..."
  }
}
```

Use the error code for application behavior. Record the request ID when contacting support. Do not show internal details or stack traces directly to end users.

Common status categories include:

- `200`–`299` for successful reads, writes, and accepted operations.
- `400` for invalid input or an invalid query.
- `401` for missing or expired credentials.
- `403` when the authenticated identity lacks permission.
- `404` when the routed resource does not exist or is intentionally hidden.
- `409` for conflicts such as a uniqueness violation.
- `402` when a metered quota is exhausted.
- `429` for temporary rate limiting.
- `500`–`599` for server or dependency failures.

## Data requests

Table endpoints accept filters, selected columns, ordering, limits, and cursor pagination. Prefer cursor pagination for feeds that can change while the user is reading. Treat cursors as opaque values and do not construct or modify them.

## Function requests

Invoke a deployed function through its function route with a JSON request body. The response's HTTP status, headers, and body come from the function gateway after authentication and quota checks.

```http
POST /functions/v1/send-welcome-email
Authorization: Bearer USER_ACCESS_TOKEN
Content-Type: application/json

{"userId":"user_123"}
```

Use an idempotency key for retryable operations with side effects when the endpoint supports one. Set client timeouts and retry only safe failures with exponential backoff and jitter.

## CORS

Browser calls must originate from an allowed origin. Configure the exact production origins needed by the application. Avoid wildcard origins for endpoints that accept credentials.

## Versioning

Versioned routes keep breaking API changes isolated. New optional response fields may appear without a version change, so clients should ignore fields they do not recognize.

## Related guides

- [JavaScript SDK](/docs/cloud/reference/javascript-sdk.html)
- [Errors](/docs/cloud/functions/errors.html)
- [Limits and quotas](/docs/cloud/limits.html)
- [Observability](/docs/cloud/production/observability.html)
