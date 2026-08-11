# PRD → code map

Where each part of the V1 PRD lives. Code comments cite section numbers
(`PRD §16.3`) and this table is the index for them.

> The PRD source document itself is not yet in the repository. Add it at
> `docs/prd.md` so these references resolve.

## Implemented

| PRD section                        | Implementation                                                           | Tests                             |
| ---------------------------------- | ------------------------------------------------------------------------ | --------------------------------- |
| §8 Prospect pipeline               | `packages/domain/src/pipeline.ts`                                        | —                                 |
| §9.1–9.3 Identity graph, evidence  | `packages/domain/src/person.ts`                                          | —                                 |
| §9.4 Confidence bands, thresholds  | `packages/domain/src/confidence.ts`                                      | `identity/src/resolver.test.ts`   |
| §9.5 Resolution model              | `packages/identity/src/resolver.ts`, `weights.ts`                        | 25 tests                          |
| §10.1 Provider interface           | `packages/providers/src/provider.ts`                                     | —                                 |
| §10.2 Waterfall                    | `packages/providers/src/waterfall.ts`                                    | 17 tests                          |
| §10.3 Provenance                   | `packages/domain/src/provenance.ts`, `providers/src/waterfall.ts`        | included above                    |
| §11.1–11.2 Signal schema and types | `packages/domain/src/signal.ts`                                          | —                                 |
| §11.3 Signal decay                 | `packages/signals/src/decay.ts`                                          | 35 tests                          |
| §12.1–12.6 Scoring                 | `packages/scoring/src/scores.ts`, `weights.ts`                           | 31 tests                          |
| §13.1 Action kinds                 | `packages/domain/src/networks.ts`                                        | —                                 |
| §13.2 Recommendation schema        | `packages/domain/src/outreach.ts`                                        | —                                 |
| §14.2 Quality checks (types)       | `packages/domain/src/outreach.ts`                                        | —                                 |
| §15 Approval queue                 | `apps/api` `GET /recommendations`                                        | `apps/api/src/app.test.ts`        |
| §16 Platform policy                | `packages/policy/src/capability-matrix.ts`                               | 46 tests                          |
| §16.2 Policy modes                 | `packages/policy/src/capability-matrix.ts`                               | included above                    |
| §16.3–16.6 Per-network rules       | `packages/policy/src/capability-matrix.ts`                               | included above                    |
| §17.3 Suppression                  | `packages/domain/src/compliance.ts`, migration `0004`                    | `apps/api/src/app.test.ts`        |
| §17.4 Sensitive categories         | `packages/domain/src/compliance.ts`                                      | —                                 |
| §17.5 Minors                       | `evaluateEligibility`, policy `person_ineligible` gate                   | policy tests                      |
| §17.6 Source deletion              | `apps/worker/src/jobs.ts` `markSourceUnavailable`                        | worker tests                      |
| §18 Rate limits, cooldowns         | `packages/policy/src/engine.ts`                                          | policy tests                      |
| §20.8 Policy engine                | `packages/policy/src/engine.ts`                                          | 46 tests                          |
| §21 Database model                 | `migrations/0000`–`0004`                                                 | `packages/db/src/migrate.test.ts` |
| §23 API endpoints                  | `apps/api/src/app.ts`                                                    | 31 tests                          |
| §34 Workspace isolation            | `apps/api/src/repository.ts`                                             | `apps/api/src/app.test.ts`        |
| §37 Feature flags                  | `feature_flags` table, policy `feature_flag` gate                        | policy + API tests                |
| §13 Next-best-action               | `packages/recommend/src/engine.ts`                                       | 25 tests                          |
| §20.6 Strategy agent               | `packages/recommend` — deterministic, chooses only from `allowedActions` | included above                    |
| §16.6 GitHub as a signal source    | `packages/providers/src/github/`                                         | 27 tests                          |
| §8 Pipeline, end to end            | `apps/worker/src/pipeline.ts`                                            | 11 tests + live GitHub run        |

## Partially implemented

| PRD section              | State                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §7 Wizard                | Domain types and contracts exist (`packages/domain/src/campaign.ts`, `packages/contracts`). No wizard UI or ICP agent.                                                                                                                                                                                                  |
| §12.5 Relationship score | Scoring function exists; nothing populates its inputs yet.                                                                                                                                                                                                                                                              |
| §22 Person model         | Schema complete. No ORM layer beyond `packages/db` helpers.                                                                                                                                                                                                                                                             |
| §27 Conversations        | Interaction states and rows exist; no inbound ingestion.                                                                                                                                                                                                                                                                |
| §30 Billing              | `usage_events` and `billing_accounts` tables; no metering enforcement or payment provider.                                                                                                                                                                                                                              |
| §1.1 PWA                 | `apps/web` — installable manifest, service worker, offline fallback, update prompt, safe-area layout, bottom nav, approval card, signal feed. Prospects and campaign screens are placeholders. No push notifications; icons are SVG only, so raster icons are still needed for older Android. No Lighthouse gate in CI. |
| §25.1–25.3 UI            | Today, Signals and Approvals render live API data. The §25.2 prospect page is not built.                                                                                                                                                                                                                                |

## Not started

- §7 Campaign wizard UI.
- §14 Outreach composer. Recommendations reach the queue with a grounded reason and a `groundedSignalIds` allow-list, but nothing writes the message body yet — this is where the first LLM enters the product.
- §20 agent suite beyond the Strategy Agent (ICP, discovery, research, intent, composer).
- §10 Remaining provider adapters — Apollo, PDL, Bluesky, X.
- §26 Natural-language search.
- §28 CRM and Slack integrations.
- §36 Admin surface.
- Authentication beyond the injected `authenticate` hook.

## Deliberate deviations

**Bun instead of pnpm/Node.** The PRD mandates Bun (§1.1). No other project in
`src/profullstack/` combines Bun with Hono and Turso — the house pattern for
Turso services is pnpm on Node 22–24. This repository follows the PRD and
therefore establishes the Bun pattern rather than following precedent.

**Raw SQL migrations instead of Drizzle.** The PRD calls for
"libSQL / SQLite-compatible SQL" with "migrations committed to the repository"
(§1.1). A forward-only runner over numbered `.sql` files satisfies that with a
smaller dependency surface. Drizzle with `dialect: "turso"` is the alternative
already proven in the `nightcell7` repository if an ORM becomes worthwhile.
