---
title: Actions
description: Preview side-effecting named functions for external APIs, vendor SDKs, email, payments, and workflows that are deliberately not automatically retried.
slug: /functions/actions.html
availability: preview
updated: 2026-08-09
---
# Actions

An action performs work that cannot be part of a deterministic database transaction: calling an external API, sending email, charging a payment method, invoking an AI model, or coordinating a vendor workflow.

These operations have external side effects, so their reliability rules differ deliberately from queries and mutations.

## Definition

```ts
import { action, string } from '@lingcode/backend';

export const summarize = action({
  args: { text: string() },
  handler: async (ctx, args) => {
    const response = await fetch('https://api.example.com/summarize', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ctx.secrets.SUMMARY_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: args.text }),
    });
    if (!response.ok) throw new Error(`summary provider returned ${response.status}`);
    return response.json();
  },
});
```

## Retry semantics

Actions are **not automatically retried**. An external service may complete a side effect even when LingCode receives a timeout or broken connection. Automatically repeating the action could charge twice or send duplicate messages.

The application must choose a retry policy appropriate to the vendor. Prefer vendor-supported idempotency keys and persist workflow state before starting the side effect.

## Database access

An action may call named queries and mutations, but several calls do not form one transaction. State may change between calls.

A reliable workflow usually follows this sequence:

1. call a mutation that records the user's durable intent;
2. run the action with a stable workflow and vendor idempotency key;
3. call a mutation that records success or failure;
4. let subscribed queries update the UI.

## Secrets and outbound hosts

Secrets are declared by name and injected server-side. They never belong in arguments or return values.

Outbound network policy must prevent server-side request forgery. Production actions should call literal or owner-allow-listed HTTPS hosts, reject redirects to private networks, bound response sizes, and enforce timeouts.

## Authentication

Actions receive authenticated context, but external services do not automatically understand LingCode users. Map the LingCode identity to the vendor account explicitly and validate application permissions before performing a side effect.

## Scheduling

Actions are suitable targets for scheduled and durable workflows. A scheduler should persist attempt state, cap retries, apply backoff, and expose the last failure. Schedules do not represent an interactive end-user session unless the workflow intentionally stores an acting identity.

## Errors

Distinguish:

- application rejection, such as insufficient credits;
- vendor rejection, such as HTTP 429 or 402;
- ambiguous transport failure;
- developer error in action code;
- platform timeout or resource limit.

Return safe application errors to clients and retain vendor response details in protected server logs.

## Current alternatives

Until actions become Available, use current built-in functions for supported vendors, the allow-listed `http-fetch` built-in for generic HTTPS APIs, or a hosted Worker-compatible route for custom outbound logic.
