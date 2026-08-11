# OutreachGraph

## Repository

- One repository. Never create a separate marketing, API, worker, or infrastructure repository.
- Bun workspaces with shared packages for cross-service contracts. No Git submodules.
- TypeScript strict mode, plus `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.
- ESM only, kebab-case filenames, semicolons, `printWidth: 100`.
- One commit must be able to update the API, worker, packages, migrations, and Railway deployment together.
- The canonical requirements are the V1 PRD. **It is not yet committed** — add the source document at `docs/prd.md`, then update it in the same commit whenever a decision changes. `docs/prd-implementation-map.md` maps PRD sections to the code that implements them.

## Architecture

- `packages/domain` depends on nothing. Everything else may depend on it.
- Application code never imports `@libsql/client` directly — it goes through `packages/db`.
- Vendor objects never leak past `packages/providers`. Adding Apollo means adding an adapter, not changing callers.
- HTTP API paths live under `/api/v1`.
- All long-running Railway services need `/health/live`, `/health/ready`, structured logs, validated environment variables, and graceful SIGTERM.

## Non-negotiables

These come from the PRD and are not style preferences:

- **The Policy Engine is deterministic.** No LLM participates in a policy decision. It fails closed: an unknown network/action pair is DENY.
- **Policy is re-checked at execution time**, never trusted from the snapshot stored on the recommendation.
- **Human approval is the default.** `trusted_automation` is opt-in and additionally gated per capability.
- **No LinkedIn automation.** Research, evidence, and drafts only; the human acts in LinkedIn's own interface.
- **GitHub is a signal source, not a messaging channel.** No sales outreach in issues, PRs, or discussions.
- **Identity precision beats recall.** A merge needs corroborating evidence; name-plus-city never merges on its own.
- **Every personalised claim is grounded in stored evidence.** No source, no claim.
- **Suppression survives deletion.** Deleting a person leaves a minimal tombstone so a later provider lookup cannot re-ingest them.
- **Sensitive categories are never targeting or scoring inputs**, even when a public post reveals them.

## Migrations

- Forward-only. Never edit an applied migration — the runner rejects it by checksum. Write the next one.
- `bun run db:migrate`, `bun run db:status`, `bun run db:reset` (local file databases only).
- The container applies pending migrations at boot and refuses to start if they fail. That is safe only because the deployment is one container pinned to one replica; if `numReplicas` ever rises, set `RUN_MIGRATIONS=false` and run them as an explicit release step instead.

## Process

- `bun run check` before pushing: format, typecheck, tests.
- Tests are colocated (`src/foo.test.ts`) and run with `bun test` from the root.
- The whole pipeline must stay runnable with no API keys via the fixture provider.
