---
title: CLI and MCP tools
description: Manage LingCode Cloud backends from the IDE and coding agents with explicit, reviewable provisioning, migration, deployment, and inspection tools.
slug: /reference/cli-mcp.html
availability: available
updated: 2026-08-09
---

# CLI and MCP tools

LingCode's IDE integration exposes backend operations as structured MCP tools. This lets a coding agent create and update a backend from the project conversation while keeping account authorization, migration review, and production approval explicit.

## How the workflow works

1. The agent inspects the project and the current backend state.
2. It prepares source files or a migration in the workspace.
3. It shows the user the intended change and any risk.
4. It calls the narrow tool for that operation.
5. It verifies the returned backend state before claiming completion.

The agent should not require users to manually recreate ordinary message APIs in a separate backend dashboard. Application intent can be translated into backend source and migrations inside the IDE; security-sensitive and production actions still require explicit authorization.

## Core lifecycle tools

| Tool | Purpose |
| --- | --- |
| `provision_backend` | Create or attach the project's managed backend. |
| `deploy_backend_manifest` | Validate and deploy `lingcode/backend.json` and referenced backend source. |
| `backend_source_status` | Compare local backend source with the deployed immutable digest. |
| `apply_migration` | Apply an explicit, ordered database migration. |
| `describe_backend` | Read backend identity, capabilities, and connection metadata. |
| `delete_backend` | Permanently remove a backend after destructive-action confirmation. |

See [Backend as code](/docs/cloud/deployments/backend-as-code.html) for manifest hashing and drift detection, and [Production approval](/docs/cloud/deployments/production-approval.html) for the deploy-plan contract.

## Data tools

Inspection and data operations include `list_tables`, `query`, `select`, `insert`, `upsert`, `update`, `delete`, and `rpc`. The general `query` tool is read-only; schema and write changes must use the dedicated tools so their intent can be validated and audited.

Use pagination and selective columns when inspecting large tables. Data tools operate within the connected account and backend scope and must not be used to bypass application authorization policies.

## Function tools

Use `list_functions`, `upsert_function`, `test_function`, and `delete_function` to manage custom function definitions from the IDE. Saving definitions is unlimited; invocation compute remains metered by the selected plan.

Test a changed function before deployment. A successful save does not prove that runtime secrets, upstream dependencies, or user authorization are correct.

## Authentication and scope

The MCP server uses the user's authenticated LingCode account. Each operation resolves an account and backend scope before execution. The IDE exchanges the account credential for an expiring project-scoped token, so an agent credential cannot mint another token or access a different project. Newly issued credentials use hashed token lookup and are shown only in the issuance response.

Project tokens default to 30 days and can be requested for 1–90 days. Remote and collaboration WebSocket credentials expire within one hour. Rotate a credential immediately if it may have appeared in a prompt, log, screenshot, or source file.

The compatibility migration adds digest coverage with no forced reconnect for existing clients. Updating backend source does not normally require application users to reconnect; an explicitly revoked or rotated credential requires a new sign-in.

## Production safety

Production deployment is plan-bound and single-use. The approval contains the exact planId and digest, expires after 10 minutes, and is consumed after deployment. There is no watch deploy for production.

For destructive operations, the agent must identify the exact target and obtain confirmation. For migrations, prefer additive changes, make backfills resumable, and provide an explicit rollback or forward-fix strategy.

## Errors and verification

Tool errors include a stable code, a readable explanation, and when available a request ID. Resolve authorization, validation, or quota errors instead of repeatedly retrying them. Retry temporary transport failures with bounded backoff.

After every mutation, read back the relevant state. For deployments, use `backend_source_status`; for migrations, inspect the migration record and affected schema; for functions, run `test_function` and review runtime logs.

## Related guides

- [Deployments](/docs/cloud/deployments/)
- [Reliability](/docs/cloud/production/reliability.html)
- [Observability](/docs/cloud/production/observability.html)
- [Limits and quotas](/docs/cloud/limits.html)
