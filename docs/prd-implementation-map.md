# PRD → code map

Where each part of the V1 PRD lives. Code comments cite section numbers
(`PRD §16.3`) and this table is the index for them.

> The PRD source document itself is not yet in the repository. Add it at
> `docs/prd.md` so these references resolve.

## Implemented

| PRD section                        | Implementation                                                                                                                                  | Tests                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| §8 Prospect pipeline               | `packages/domain/src/pipeline.ts`                                                                                                               | —                                  |
| §9.1–9.3 Identity graph, evidence  | `packages/domain/src/person.ts`                                                                                                                 | —                                  |
| §9.4 Confidence bands, thresholds  | `packages/domain/src/confidence.ts`                                                                                                             | `identity/src/resolver.test.ts`    |
| §9.5 Resolution model              | `packages/identity/src/resolver.ts`, `weights.ts`                                                                                               | 25 tests                           |
| §10.1 Provider interface           | `packages/providers/src/provider.ts`                                                                                                            | —                                  |
| §10.2 Waterfall                    | `packages/providers/src/waterfall.ts`                                                                                                           | 17 tests                           |
| §10.3 Provenance                   | `packages/domain/src/provenance.ts`, `providers/src/waterfall.ts`                                                                               | included above                     |
| §11.1–11.2 Signal schema and types | `packages/domain/src/signal.ts`                                                                                                                 | —                                  |
| §11.3 Signal decay                 | `packages/signals/src/decay.ts`                                                                                                                 | 35 tests                           |
| §12.1–12.6 Scoring                 | `packages/scoring/src/scores.ts`, `weights.ts`                                                                                                  | 31 tests                           |
| §13.1 Action kinds                 | `packages/domain/src/networks.ts`                                                                                                               | —                                  |
| §13.2 Recommendation schema        | `packages/domain/src/outreach.ts`                                                                                                               | —                                  |
| §14.1 Outreach composer            | `packages/ai/src/composer.ts`, `model.ts`, `draft.ts`                                                                                           | 29 tests                           |
| §14.1 Model fallback chain         | `packages/ai/src/fallback.ts`, `openai.ts`, `gemini.ts`                                                                                         | `packages/ai/src/fallback.test.ts` |
| §14.2 Quality checks               | `packages/ai/src/checks.ts`, `packages/domain/src/outreach.ts`                                                                                  | 40 tests                           |
| §14.3 Personalised video           | `packages/media/src/script.ts`, `renderer.ts`, `render.ts`                                                                                      | 36 tests                           |
| §15 Approval queue                 | `apps/api` `GET /recommendations`                                                                                                               | `apps/api/src/app.test.ts`         |
| §16 Platform policy                | `packages/policy/src/capability-matrix.ts`                                                                                                      | 46 tests                           |
| §16.2 Policy modes                 | `packages/policy/src/capability-matrix.ts`                                                                                                      | included above                     |
| §16.3–16.6 Per-network rules       | `packages/policy/src/capability-matrix.ts`                                                                                                      | included above                     |
| §17.3 Suppression                  | `packages/domain/src/compliance.ts`, migration `0004`                                                                                           | `apps/api/src/app.test.ts`         |
| §17.4 Sensitive categories         | `packages/domain/src/compliance.ts`                                                                                                             | —                                  |
| §17.5 Minors                       | `evaluateEligibility`, policy `person_ineligible` gate                                                                                          | policy tests                       |
| §17.6 Source deletion              | `packages/pipeline/src/jobs.ts` `markSourceUnavailable`                                                                                         | pipeline tests                     |
| §18 Rate limits, cooldowns         | `packages/policy/src/engine.ts`                                                                                                                 | policy tests                       |
| §20.8 Policy engine                | `packages/policy/src/engine.ts`                                                                                                                 | 46 tests                           |
| §21 Database model                 | `migrations/0000`–`0007`                                                                                                                        | `packages/db/src/migrate.test.ts`  |
| §23 API endpoints                  | `apps/api/src/app.ts`                                                                                                                           | 61 tests                           |
| Content Studio                     | `packages/ai/src/content.ts`, `apps/api/src/content-drafts.ts`, `apps/web/app/(app)/content/`; migration `0083`                                 | —                                  |
| §34 Workspace isolation            | `apps/api/src/repository.ts`                                                                                                                    | `apps/api/src/app.test.ts`         |
| §37 Feature flags                  | `feature_flags` table, policy `feature_flag` gate                                                                                               | policy + API tests                 |
| §13 Next-best-action               | `packages/recommend/src/engine.ts`                                                                                                              | 25 tests                           |
| §20.6 Strategy agent               | `packages/recommend` — deterministic, chooses only from `allowedActions`                                                                        | included above                     |
| §16.6 GitHub as a signal source    | `packages/providers/src/github/`                                                                                                                | 27 tests                           |
| §8 Pipeline, end to end            | `packages/pipeline/src/pipeline.ts`, `POST /prospects`                                                                                          | 11 + 8 tests, live GitHub run      |
| §25.2 Prospect list and detail     | `apps/web/app/prospects/`, `GET /people`                                                                                                        | 2 API tests + build                |
| §34 Email verification             | `packages/email/`, `apps/api/src/auth.ts`, migration `0006`                                                                                     | 7 + 11 tests                       |
| §12.5 Relationship score           | `packages/pipeline/src/engagement.ts`, migration `0018`                                                                                         | 17 tests                           |
| §13 Cadences                       | `packages/domain/src/cadence.ts`, `pipeline/src/cadence*.ts`, `0019`                                                                            | 19 + 21 + 6 tests                  |
| Cadence A/B variants + open pixel  | `domain/src/cadence.ts` (`guidanceFor`), `pipeline/src/engagement.ts`, `0040`                                                                   | 12 + 8 + 7 tests                   |
| §16.4 Bluesky writes               | `providers/src/bluesky/agent.ts`, `pipeline/src/outreach-bluesky.ts`                                                                            | 21 + 7 tests                       |
| §26 Term expansion                 | `packages/ai/src/synonyms.ts`, `pipeline/src/term-expansion.ts`, `0020`                                                                         | 11 + 8 tests                       |
| §20 Research grid                  | `packages/ai/src/grid.ts`, `pipeline/src/research-grid.ts`                                                                                      | 8 + 15 tests                       |
| §7 Playbooks                       | `packages/domain/src/playbooks.ts`                                                                                                              | 8 tests                            |
| §30 Metering                       | `packages/domain/src/plans.ts`, `pipeline/src/metering.ts`                                                                                      | 17 tests                           |
| §28 Rules                          | `packages/domain/src/rules.ts`, `pipeline/src/rules.ts`, `0021`                                                                                 | 22 tests                           |
| §28 Webhooks, Slack, CRM sync      | `pipeline/src/webhooks.ts` (on `@profullstack/webhooks`), `webhook-store.ts`, `crm-sync.ts`, `providers/src/{webhooks,crm,net}`, `0041`, `0079` | 92 tests; `docs/webhooks.md`       |
| §18 Sender pools and warm-up       | `domain/src/sender-pool.ts`, `pipeline/src/sender-pool.ts`, `0044`                                                                              | 19 + 15 + 5 + 3 tests              |
| §23 MCP and CLI                    | `apps/mcp/`, `apps/cli/`                                                                                                                        | 13 + 17 tests                      |
| §8/§11 Audience as intake          | `domain/src/audience.ts`, `pipeline/src/audience{,-readers}.ts`, `providers/src/{bluesky,x}/audience.ts`, `0045`                                | 22 + 13 + 14 + 11 + 4 tests        |

## Partially implemented

| PRD section              | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §7 Wizard                | Domain types and contracts exist (`packages/domain/src/campaign.ts`, `packages/contracts`). No wizard UI or ICP agent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| §12.5 Relationship score | Scoring function exists; nothing populates its inputs yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| §22 Person model         | Schema complete. No ORM layer beyond `packages/db` helpers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| §27 Conversations        | Replies are read over IMAP (`packages/pipeline/src/receive-email.ts`) with their text; absence notices and bounces are filed as `direction = 'automated'` and never count as a reply. `triage_reply` (`packages/pipeline/src/triage-reply.ts`) labels each reply (rules first, model second), suppresses on a rule-matched stop request, and drafts an answer (`composeReply`) as a copilot card, sending unattended only when `decideAutoReply` holds. Unified inbox at `/api/v1/inbox`, `og inbox`, MCP `list_inbox`/`get_thread`/`reply_to_thread`, web `/inbox`. Social replies are not yet recorded. |
| §30 Billing              | `usage_events` and `billing_accounts` tables; no metering enforcement or payment provider.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| §1.1 PWA                 | `apps/web` — installable manifest, service worker, offline fallback, update prompt, safe-area layout, bottom nav, approval card, signal feed, prospect list and detail, add-prospect flow, email verification. Campaign screens are still placeholders. No push notifications; icons are SVG only, so raster icons are still needed for older Android. No Lighthouse gate in CI.                                                                                                                                                                                                                          |
| §25.1–25.3 UI            | Today, Signals, Approvals, Prospects and prospect detail all render live API data. Offering and voice editing are not built, so drafts are grounded in a placeholder offering until a user edits it in the database.                                                                                                                                                                                                                                                                                                                                                                                      |

## Not started

- §7 Campaign wizard UI.
- §20 agent suite beyond the Strategy Agent, the composer and the research grid
  (ICP, discovery, intent).
- §10 Remaining provider adapters — Apollo, PDL, X.
- §26 Natural-language search over the whole graph. Term expansion covers the
  campaign-matching half.
- §28 CRM coverage beyond HubSpot and Pipedrive (Salesforce needs OAuth and a connected
  app). Webhooks, Slack and HubSpot/Pipedrive push are built; Zapier, Make and n8n work
  through the generic signed webhook.
- §36 Admin surface.
- Scheduling links. Blocked on a Google OAuth client this repository does not
  have; the rest of the work (availability, timezones, a booking page) is real
  and unstarted.
- A desktop app. Deliberately unbuilt: the only justification is holding a
  logged-in browser session so a manual social step is one keystroke, and there
  is no usage data yet saying anyone wants that.

## The build order these came in

Each phase shipped on its own and made the next cheaper, which is why the
dependency order is worth recording:

1. Engagement tracking, because scoring was blind to what actually happened
   and everything downstream reads a score.
2. The cadence engine, which needs somewhere for a plan to send.
3. Bluesky writes, which proves a cadence can run unattended somewhere.
4. The research grid and playbooks, which need prospects worth asking about.
5. MCP and CLI, which are wrappers over an API that had to exist first.
6. Rules and metering, which need tracking to trigger on and sending to count.

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

## Engineering Contract Outreach PRD (`docs/prd/engineering-contract-outreach.md`)

Cited in code as `PRD-ECO §n`.

| Section                              | Implementation                                                                                                                                                     | Tests                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| §14 English → workflow               | `packages/domain/src/workflow.ts` (deterministic reader), `apps/api/src/workflows.ts` `interpretWorkflow` (model proposes; rules decide autopilot)                 | 12 + API tests                   |
| §14 Typed, validated DAG             | `packages/domain/src/workflow-graph.ts`: 13 step types, unknown actions/cycles refused, send must follow verify + dedupe + draft + approval                        | 18 tests                         |
| §14 Versions, publish                | `workflow_versions` (migration `0075`); edits never change the running version until published                                                                     | `apps/api/src/workflows.test.ts` |
| §14 Durable runner                   | `packages/pipeline/src/workflow-runner.ts`: per-step idempotency keys (`workflow_step_effects`), blocked-step isolation, cancel, 5/30/120 min retries, dead-letter | API tests                        |
| §14 Schedule + events                | `nextWorkflowRunAt` (IANA zone, DST-correct), `runDueWorkflows` in the worker tick: slots, reply events, retries, each claimed once                                | domain + API tests               |
| §14 Dry run                          | `previewWorkflow`: per-step checks, matched postings, per-person address + evidence + send / no-send from the policy engine and dedupe                             | API tests                        |
| §14 De-duplication                   | `deduplicateCampaign`: suppression + any email from another campaign or recorded outside the product, by person and by address                                     | API tests                        |
| §14 API / CLI / MCP                  | `/api/v1/workflows/*`, `apps/cli/src/workflow-commands.ts` (`og workflow*`), MCP `*_workflow*` tools; request schemas in `packages/contracts`                      | 4 CLI + 1 MCP + API tests        |
| §14 UI                               | Workflows tab; `/workflows`, `/workflows/new`, `/workflows/[id]`, `/workflows/[id]/runs/[runId]`; plan graph, node editor, versions, run log                       | web typecheck                    |
| §14 Engineering Contract Acquisition | `ENGINEERING_CONTRACT_TEMPLATE`: job boards + Bay Area / remote-US discovery, hiring-authority titles, agencies excluded, 200/day ceiling, review mode             | domain tests                     |

What §14 does **not** yet cover, because the Phase 1 pieces it builds on do not
exist yet:

- **Imported Sent history.** Dedupe reads every send the product made and any
  outbound email `interactions` row from outside a campaign; there is no Gmail
  Sent import (`POST /outreach-imports/gmail`, `external_outreach_events`) to
  fill that table from Gmail yet.
- **Contract-specific steps.** `discover_opportunities` uses the existing job-post
  search and market discovery; `contract_opportunities`, pay-rate filters
  ("above $100/hour") and the Contracts navigation (§5) are not built.
- **Per-domain daily caps and a sender ramp** beyond what the sender pool and the
  per-address weekly limit already enforce.
- **`wait`, `classify_reply`, `branch`, `notify`, `log_crm`** describe and report the
  existing cadence timing, reply triage, alerts and CRM sync; they do not yet
  schedule anything of their own.
