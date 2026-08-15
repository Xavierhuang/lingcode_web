---
title: Security at LingCode Cloud
description: The security controls, operational boundaries, and shared-responsibility model used to protect LingCode Cloud accounts, credentials, applications, and data.
slug: /security/
availability: available
updated: 2026-08-09
---

# Security at LingCode Cloud

LingCode Cloud is designed with layered controls across authentication, tenant isolation, secrets, functions, deployments, and operations. Security is an ongoing risk-management process, not a promise that any online service is invulnerable. This page documents controls customers can evaluate and the responsibilities they retain.

## Account and credential protection

- Production starts fail closed when the session secret, token pepper, or configured Cloud signing secret is missing or weak.
- Password sign-in uses bcrypt and dual account/address password throttling. Authentication failures do not disclose whether an account exists.
- Newly issued account credentials use hashed token lookup with a versioned HMAC-SHA-256 digest. The raw credential is returned only at issuance and credential responses use `Cache-Control: no-store`.
- Existing credentials receive digest coverage through an additive migration with no forced reconnect. Compatibility plaintext is retained only for the staged migration and is measured by a read-only migration report.
- IDE and agent access uses an expiring project-scoped token. Remote and collaboration links use separate one-hour scoped credentials instead of exposing a long-lived account credential.
- Explicit rotation and password reset revoke active credential families.

## Data and tenant isolation

- Each managed backend receives a separate PostgreSQL tenant schema and database role.
- The data gateway resolves the authenticated backend and role before executing an operation.
- Row-level security supports per-user application authorization. Application teams must enable and test policies for client-accessible tables; administrative server paths remain a privileged boundary.
- Public anonymous keys identify a backend but are not secrets. Authorization must come from row-level policies, authenticated user context, and server-only credentials.

## Secrets and function execution

- User-provided service credentials are encrypted with AES-256-GCM before storage and are decrypted only for the operation that needs them.
- Custom functions run with deny-by-default Deno permissions, bounded execution time, restricted request size, and an outbound-host allowlist.
- Server-side fetch validation blocks unsupported protocols and private or loopback destinations. Additional DNS-pinning defenses remain on the security roadmap.
- Logs and migration reports are designed to exclude raw credentials, token digests, cookies, and secret values.

## Deployment safeguards

- Production backend changes use a preview followed by an exact, digest-bound approval.
- Approval plans expire after 10 minutes, are single-use, and cannot be replayed with altered content.
- Production has no automatic watch deployment. Destructive and security-sensitive actions require an explicit target and confirmation.
- Backend source status compares deployed artifacts with their expected SHA-256 hashes.

## Browser and transport safeguards

- Production sessions use Secure, HttpOnly, SameSite cookies.
- Responses set content-type, framing, referrer, browser-permission, and HTTPS transport security headers.
- LingCode Cloud is served over HTTPS; customers must also use HTTPS for their own custom domains and upstream services.

## Shared responsibility

LingCode protects the managed control plane, gateway, credential lifecycle, and platform isolation controls. Customers remain responsible for:

- writing and testing row-level security policies for their application data;
- granting the minimum project roles and removing access when it is no longer needed;
- keeping secrets out of source code, prompts, client bundles, and logs;
- validating function inputs and authorization, especially before external side effects;
- reviewing production plans, monitoring their application, and maintaining appropriate retention and recovery requirements.

Use the [Production checklist](/docs/cloud/production/) before launching an application that handles sensitive or regulated data.

## Verification and security roadmap

This release includes automated tests for production configuration, security headers, password throttling, token migration, expiry, revocation, project scoping, deployment confirmation, function sandboxing, and private-network request blocking.

The security roadmap includes per-backend signing-key rotation, stronger default row-level-security enforcement for newly created backends, DNS-pinned outbound requests, compute host-isolation release gates, recurring backup-restore exercises, and independent penetration testing. Roadmap items are not represented as completed controls.

## Reporting a security concern

Do not include passwords, access tokens, private keys, or customer data in an initial report. Contact LingCode support with a concise description, affected URL or component, reproduction conditions, and potential impact. Reports are triaged privately and remediation is prioritized by exploitability and customer impact.

Last reviewed: August 9, 2026.
