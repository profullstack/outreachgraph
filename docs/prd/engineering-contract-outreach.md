# OutreachGraph — Engineering Contract Acquisition Autopilot

**Status:** Proposed implementation PRD · **Date:** 2026-10-26 · **Owner:** Profullstack, Inc.
**Repository:** https://github.com/profullstack/outreachgraph
**Product:** https://outreachgraph.com
**Objective:** Make OutreachGraph autonomously research, qualify, and coordinate targeted engineering-contract outreach, while retaining verifiable evidence, deduplication, channel permissions, and human controls.

> Committed from the source document on 2026-10-26. Code cites it as `PRD-ECO §n`.
> Two private individuals named in §3 are replaced by their roles; nothing else is changed.
> Implementation status: `docs/prd-implementation-map.md` ("Engineering Contract Outreach PRD").

## 1. Executive decision

**Extend the existing OutreachGraph product. Do not create a second outreach service.** The current monorepo already contains the prospect pipeline, identity graph, evidence, scoring, deterministic policy gate, approval queue, cadences, email delivery, sender pools, inbox triage, API, CLI, MCP, and AutoGTM. Build a dedicated **Contract Acquisition** workflow over these foundations, and repair known incomplete UX paths first.

The product must help an experienced US-based software engineer or agency discover **new employers with live contract needs**, find the **person with hiring authority or an accountable internal recruiter**, verify how to contact them, send evidence-based personalized outreach, and turn replies into calls and paying engagements. Favor _direct employers_ over multi-layer agency chains; optional agency targeting remains available. Do not filter, infer, or rank prospects by race, ethnicity, nationality, ancestry, name origin, or native-language status. US location, role scope, professional English communication and verified authority are legitimate user-defined criteria.

**Important:** 200/day is a configurable _aspirational ceiling_, not a guaranteed daily throughput or a launch default. Actual sending is limited by verified leads, recipient suitability, law, sender health, provider limits, policy engine, and user preferences. Never make up contacts to fill quota.

## 2. Grounding and existing capabilities

Repository `README.md`, `CLAUDE.md`, and `docs/prd-implementation-map.md` inspected on 2026-10-26. The public site advertises policy-gated outreach, mailboxes, multi-step cadences, approvals, A/B variants, and unified inbox. The repo identifies:

- **Runtime:** Bun workspaces; TypeScript strict/ESM; Hono `/api/v1`; Next.js 16 PWA; Railway; Postgres in production via `@profullstack/libsql-pg`; SQLite for tests.
- **Reusable domain/pipeline:** `packages/domain`, `packages/providers`, `packages/pipeline`, `packages/identity`, `packages/signals`, `packages/scoring`, `packages/recommend`, `packages/ai`.
- **Existing delivery/compliance:** `packages/policy`, `packages/email`, `packages/pipeline/src/cadence*`, `packages/pipeline/src/receive-email.ts`, `triage-reply.ts`, `sender-pool.ts`.
- **Surfaces:** `apps/api`, `apps/web`, `apps/cli`, `apps/mcp`, `apps/server`; AutoGTM API and `og` CLI.
- **Known gaps per repo map:** campaign wizard not built; campaign UI placeholders; offering/voice editor missing; relationship-score inputs not populated; some social replies not recorded; scheduling links not started; ICP, discovery and intent agents not built. These are documented gaps, _not_ live production bug reproductions.

**Access limitation:** Public pages and GitHub code/docs were inspected, but the authenticated OutreachGraph account, live dashboard, production database, and real user flows were **not** audited. The engineering team must reproduce UI failures and assess deployed-vs-repo drift before estimating or claiming fixes. Do not ask for or store the user's password in a chat. Authenticate through the site's existing login, connected browser, or workspace-scoped API key; secrets remain in the product's secure credential store.

## 3. User story and initial campaign

As Anthony at Profullstack, I want to set my experience (30 years), portfolio/GitHub, preferred contract terms, location (Bay Area / remote US), engineering specialties, industry exclusions and direct-employer preference once. I click **Find Contract Work** and get a ranked pipeline of live opportunities and named people able to influence hiring. OutreachGraph should research, deduplicate, compose, send within configured constraints, track replies, and suggest the next action. I can inspect each source and every outgoing message. I should not need ChatGPT as a manual intermediary.

Initial campaign seed:

- Candidate: Anthony / Profullstack; validate and let user edit professional profile and links.
- Market: San Jose / Bay Area, US remote; engineering contracts; direct employers first.
- Targets: CTO, VP Engineering, Head/Director of Engineering, engineering hiring manager, named internal technical recruiter; third-party agencies optional.
- Fit: software engineering, architecture, TypeScript/JavaScript, full stack, automation/AI, systems integration; user-configurable.
- Desired economics: editable rate range, contract type (1099/C2C/W2), term, remote/hybrid/on-site, availability.
- Language: outreach content in English, professional English interaction required for role; no native-speaker screening.
- Starting suppression/ledger: import and mark as **sent** the five previously verified messages: Pyramid general inbox, SGA general inbox, VARITE general inbox, a named VARITE recruiter, and a named SGA recruiter. Preserve original message IDs/dates and recipient identities from Gmail import; never manufacture history or re-send automatically.

## 4. Core workflows

### A. Discovery and evidence

1. Search direct-company career pages, ATS postings, reputable job feeds, employer engineering pages and publicly available named-professional pages. Implement providers behind `packages/providers`, with attribution and permissible access rules. No account-wall bypass, credential scraping, fabricated email addresses, or unauthorized LinkedIn automation.
2. Normalize opportunities by canonical employer domain, source job ID, URL, title, location, remote policy, pay, contract type, posted/last-seen date, closing status, recruiter/employer distinction and source timestamps.
3. Refresh jobs, mark expired/filled after evidence or repeated failed checks, preserve historical records and stale-warning UI. Do not represent old job listings as current.
4. Resolve named decision-makers from company sites, job contacts, voluntary/public professional profiles, or legitimate enrichment providers. Rank by evidence of connection to that vacancy, department, and hiring authority—not by name or protected attributes.
5. Require a **contactability proof**: published professional email, supplied/reply-confirmed address, compliant provider verification, or an on-platform human handoff. Do not guess and blast address patterns.
6. Attach a source URL, extraction time, confidence, role match and rationale to every job, contact and suggested action.

### B. Qualification and prioritization

Score **opportunity freshness**, contract match, skills fit, pay fit, employer type (direct/internal vs third-party), location/remote fit, contact authority, evidence strength and likelihood of a legitimate response. Keep separate scores: job fit, person authority, reachability and outreach readiness; never hide a missing source under a blended score. Show concise **Why this company / Why this person / Why now** explanations. Users can customize filters without enabling discriminatory proxy targeting.

### C. Identity-safe, company-wide deduplication

- Enforce idempotency by workspace + normalized employer/domain + normalized person identity + campaign/action + message fingerprint, with atomic locks to prevent concurrent workers double-sending.
- Link multiple postings at one employer to a single account-level dossier; allow distinct hiring teams when genuinely separate.
- Check prior Sent mail (initial import and incremental reconciliation), OutreachGraph sends, scheduled steps, open threads, suppression records and reply states before scheduling **and again at send time**.
- Preserve canonical contact merge provenance; never merge because of name and city alone.
- A sent message to a general inbox does not automatically block all named employees at that firm, but account-level throttles, relevance and user-configurable cool-down apply.
- Use idempotency keys for provider sends; ambiguous provider timeouts enter `delivery_unknown` and reconcile before retrying.

### D. Compose, approve and deliver

- Generate short 1:1 outreach grounded in **actual job evidence** and user-approved resume, Github/portfolio, expertise and availability. No invented relationships, qualifications, role details or urgency.
- Modes: `review_every_send` (default), `trusted_send` (explicit per campaign + eligible channel + verified contact + policy gate), `research_only`.
- Sender mailbox is connected in OutreachGraph settings with OAuth where available or product-supported SMTP, not by handing credentials to an assistant. An API key is workspace-scoped and revocable.
- Email remains the initial channel. LinkedIn: research via allowed public pages; direct contact as manual handoff unless separately authorized and technically compliant. Respect current capability matrix, terms, rate and session controls.
- Daily budgets: `research_limit`, `new_contacts_per_day`, `max_emails_per_day`, per-domain/day, per-recipient cooldown, working-hours window in `America/Los_Angeles`, and mailbox/provider health. 200/day is an optional upper bound subject to deliverability and controls; gradual ramp with domain reputation monitoring is mandatory.
- Honor opt-outs, legal requirements (including CAN-SPAM when applicable), bounce suppression, provider limits and recipient contact restrictions. Recheck deterministic policy at actual send.
- Follow-up cadence must stop on human reply, opt-out, bounce, placement, hiring rejection or manual pause; no repeated identical pitches.

### E. Replies to revenue

Unified inbox classifies `interested`, `question`, `referral`, `no_current_opening`, `not_interested`, `out_of_office`, `unsubscribe`, `bounce`, `unknown`; route actionable replies to the user with draft responses and linked opportunity. Provide optional calendar-booking integration as a separately scheduled feature rather than requiring it for MVP. Track discovery → verified decision-maker → sent → delivered → replied → meeting → proposal → signed → revenue, with manually confirmable stage transitions and evidence.

## 5. UX requirements

Main navigation: **Contracts** → `Overview`, `Opportunities`, `Decision-makers`, `Campaigns`, `Inbox`, `Sending health`, `Settings`. Add a short mobile-first wizard to create a campaign: `My profile` → `Ideal contracts` → `Discovery sources` → `Sending rules` → `Review & launch`. All pages must use real `/api/v1` data; remove placeholder screens as part of this work.

Each opportunity card: employer, role, compensation (or **not listed**), contract type, location, discovered/verified date, source link, named contacts and confidence, prior outreach, next recommended action, and explicit exclusion reason if blocked. Company dossier groups roles, people, past messages and follow-ups. Approvals show side-by-side source claims and proposed email; single approve/skip and bulk operations that still run policy per action. Provide pause/resume, dry run, daily summary and CSV export.

## 6. Data model (new, workspace scoped)

Design forward-only migrations in **both** `migrations/` and `migrations-pg/`; choose next unused matching number, never rewrite shipped migration.

- `contract_search_profiles` (`workspace_id`, candidate profile/version, target geos, rate/terms, allowed company types, preferences, source policy).
- `contract_opportunities` (`workspace_id`, `canonical_employer_id`, external_id, source_id, title, terms, pay min/max/currency, location, posted/seen timestamps, state, source URL, evidence JSON, unique composite source key).
- `contract_opportunity_contacts` (`opportunity_id`, `person_id`, role_category, `authority_evidence_id`, confidence, verification/status).
- `external_outreach_events` (`workspace_id`, channel, mailbox, normalized recipient, provider message/thread ID, sent timestamp, campaign link, hash, source=`gmail_import|manual|...`).
- `contract_pipeline_stages` (`opportunity_id`, stage, changed_at, actor, evidence, reason).
- `contract_discovery_runs` (`workspace_id`, campaign_id, state, sources queried, page cursors, error summary, run stats, timestamps).

Reuse existing people, company, signal, campaign, cadence, suppression, events and sender-pool tables; avoid duplicated person/email or compliance stores. Minimize and encrypt sensitive contact data; deletion retains only existing suppression tombstones.

## 7. API / CLI / MCP contracts

All routes under `/api/v1`, authenticated and workspace-isolated; additive schemas in `packages/contracts`.

- `POST /contract-profiles`, `GET/PATCH /contract-profiles/:id`
- `POST /contract-discovery-runs` `{profile_id,dry_run:true|false}` → async `run_id`
- `GET /contract-discovery-runs/:id` → state, counts, checkpoint, errors
- `GET /contract-opportunities?status=&min_score=&company_type=&cursor=`
- `GET /contract-opportunities/:id` → evidence, contacts, history
- `POST /contract-opportunities/:id/recommend` → policy-evaluated actions
- `POST /outreach-imports/gmail` → OAuth permission flow or user-authorized bounded Sent import, reconciliation preview, idempotent commit; avoid storing Gmail tokens outside encrypted secrets
- `GET /contract-campaigns/:id/metrics` → verified funnel and deliverability

CLI: `og contracts init`, `og contracts discover --dry-run`, `og contracts opportunities`, `og contracts contacts`, `og contracts approve`, `og contracts status`, `og contracts import-sent`, `og contracts pause`. MCP equivalents expose discovery, read, review, approval, status and pause via the same API. No hidden bypass for machine callers.

All mutations accept a stable `Idempotency-Key` where relevant; 409 policy-denied responses report a machine-readable gate. Paginate reads, rate-limit providers, and enforce workspace roles/scopes.

## 8. Refactoring / cleanup workstream (must precede mass sends)

**Audit first, fix what tests reproduce:** inspect deployed build/version against repository, trace user login to wizard, opportunity ingestion, approval, send, IMAP reply, suppression, retries, sender status and mobile navigation. Write a reproducible issue with screenshots/log correlation for each actual bug. Do not claim any live issue is confirmed solely because a repo map calls a feature partial.

Engineering cleanup targets:

1. Replace campaign UI placeholders with functional API-backed screens and accessible loading, empty, error and resume states.
2. Implement one canonical campaign creation/service layer, consumed by PWA, CLI and MCP rather than separate mutation logic.
3. Centralize normalizers for employers, job IDs, identities, emails and provider event keys; use database uniqueness and transactional outbox pattern.
4. Make worker discovery/send/reply jobs durable, checkpointed, replay-safe and observable; support dead-letter queue and manual retry only after reconciliation.
5. Fix partial relationship score by populating actual confirmed interactions, not assumed engagement.
6. Make offering/voice profile editable so generated messages never use a generic placeholder.
7. Add production readiness checks, structured logs, per-provider failure dashboards, secret/config validation, migration smoke tests and mobile PWA smoke tests.
8. Preserve architecture rules in `CLAUDE.md`: TypeScript strict, Bun, Hono, Postgres production, dual forward-only migrations, `packages/policy` fail-closed and approval defaults.

## 9. Test and acceptance criteria

- **Zero duplicate deliveries** across job aliases, retries, competing workers and imported Sent items in deterministic adversarial test fixtures.
- Previously emailed Pyramid, SGA and VARITE addresses appear as **contacted**, with exact imported timestamps/IDs and no new send to those exact recipients absent explicit user action.
- Given 100 seeded opportunities with overlapping jobs/people, canonical employer clustering is correct on fixtures, and contact recommendation displays linked evidence; uncertain identities stay separate.
- No auto-email without verified contact route, compelling job relevance, authorized channel, sufficient sender health, policy pass, and a valid message supported by source evidence.
- 200/day configured is **never interpreted as a minimum**; send count can be zero if no legitimate eligible contacts. Caps must never be exceeded even under concurrent execution.
- Cancellation/pause stops unsent steps; suppression and reply events stop follow-up before next send.
- `review_every_send` requires affirmative approval; `trusted_send` cannot circumvent a policy denial or channel limits.
- New /contract screens work at iPhone viewport and desktop; keyboard accessible, clear errors and resumption after refresh.
- All meaningful state transitions recorded with actor/time/source and visible in activity ledger.
- End-to-end contract fixture test runs without external API keys; provider contract tests use mocks; staging smoke tests use sandbox mailboxes.
- `bun run check` passes; both DB dialect migrations are tested; no regression to existing AutoGTM/marketing campaigns.

## 10. Instrumentation and success criteria

Capture daily: discovered opportunities, unique direct employers, fresh listings verified, contacts verified, percentage internal hiring authority, duplicates blocked, drafts accepted/rejected, emails attempted/delivered/bounced, unsubscribes, replies, positive replies, meetings booked, proposals, signed contracts and revenue. Display conversion _by source/provider_ with sample sizes, not just volume. Initial product success: user can independently import the existing five messages, launch one contract campaign, identify and contact at least one **new** verified relevant decision-maker, see the delivery/result, and avoid duplicates. Do not set artificial revenue guarantees.

## 11. Implementation sequence

**Phase 0 — Audit / stability:** reproduce defects, compare production and repository, create regression suite, fix critical auth/campaign/send/reply paths. Exit when send-once, suppression, privacy and rollback tests are green.

**Phase 1 — Contract discovery + dedup:** new job/provider adapters, normalized opportunities and sourcing evidence, company dossier, verified role contacts, Sent mail reconciliation, search profile API and opportunities UI. Exit when relevant jobs and named decision-makers display with proof and accurate contacted state.

**Phase 2 — Campaign UX + delivery:** wizard, profile/voice editing, composer grounded in job evidence, approvals, rate ramp, policy-bound sending, reliable worker jobs. Exit when campaign can run safely end-to-end from web and CLI.

**Phase 3 — Response and optimization:** reply linking, meeting/proposal funnel, source performance, optional integrations, trusted automation and measured sending ramp. Exit when all funnel metrics reconcile to underlying records.

Ship behind workspace feature flag `contract_acquisition`; enable initially for the owner's workspace; migrate slowly, record baseline metrics, keep one-click rollback that pauses new tasks without losing evidence.

## 12. Out of scope / prohibited shortcuts

No indiscriminate scraped mass-email blasts, race/nationality/native-language-based targeting, guessed emails, bypassing protected sites, LinkedIn password collection, automatic unauthorized LinkedIn DM automation, hidden policy bypass, arbitrary 200/day minimum, or re-contacting opted-out parties. No second database, send service, agent-specific privileged policy route, or promise of guaranteed contracts.

## 13. Engineering handoff / first commands

1. Clone `profullstack/outreachgraph`; read `CLAUDE.md`, `README.md` and `docs/prd-implementation-map.md`.
2. Inspect `apps/web/app`, `apps/api/src`, `packages/pipeline`, `packages/providers`, `packages/policy`, `packages/email`, and both migration directories.
3. Run `bun install && bun run check`, then smoke-test locally with the fixture provider.
4. Produce baseline UI screenshots, a discovered-bugs ledger, API/DB impact map and migration-number audit.
5. Implement Phase 0 first; ship protected Phase 1 increments with colocated tests and CI checks.
6. Update `docs/prd-implementation-map.md` as code lands. Preserve the existing product's policy invariants.

### Useful references

- Product: https://outreachgraph.com/
- Repository: https://github.com/profullstack/outreachgraph
- Existing documented implementation map: https://github.com/profullstack/outreachgraph/blob/main/docs/prd-implementation-map.md
- Existing engineering rules: https://github.com/profullstack/outreachgraph/blob/main/CLAUDE.md

## 14. Custom Workflows — first-class navigation (new requirement, priority P0/P1)

**User story:** As a workspace owner, I can describe an outreach workflow in plain English, review an explicit execution plan, save it, and run it repeatedly from a dedicated **Workflows** nav item without writing code. Example: "Find new US-based engineering contract roles above $100/hour, identify verified direct-hire decision makers, exclude previously contacted or suppressed addresses, draft a tailored email for approval, send within configured limits, and report replies."

### Product / UX

- Add **Workflows** as its own top-level responsive nav item in web/PWA (desktop sidebar and mobile navigation with overflow if needed). Routes: `/workflows`, `/workflows/new`, `/workflows/[id]`, `/workflows/[id]/runs/[runId]`.
- List saved workflows with name, owner, enabled/paused state, last/next run, failures and outcomes; duplicate, archive, export/import and delete.
- Editor: natural-language description plus deterministic **plan preview**, editable nodes/inputs/conditions, schedule and trigger, test-run with fixtures, explicit publish/enable, per-node run log, manual resume/stop, and version history. Show estimated contacts/day and actual caps.
- Starter template: **Engineering Contract Acquisition**, using the contract-discovery and outreach capability described above. Other templates must use the same primitives.

### Runtime / safety

- Translate descriptions into validated, versioned workflow definitions (typed JSON DAG/state machine); LLM proposes a plan but **never executes arbitrary code** or bypasses `packages/policy`. Reject unknown actions and cycles; apply workspace permissions, tenant isolation and execution quotas.
- Step types: discover opportunities, enrich company/person, verify contact, score/filter, deduplicate, generate evidence-backed draft, human approval, policy-checked send, wait, classify reply, branch, log to CRM, notify. Every send re-runs policy at execution time. Race/ethnicity/nationality/native-language filtering is not supported.
- Durable execution: idempotency keys on each side-effect step, transactional state transitions, retry with bounded backoff, dead-letter queue, cancellation/pause, cron scheduling with timezone/DST handling, and event-triggered execution. A resumed run must not duplicate an email.
- Model schemas in `packages/domain` and `packages/contracts`; orchestrate in `packages/pipeline`; expose only through `/api/v1/workflows` and related run endpoints, reusable by web, `og` CLI and MCP. Persist with forward-only paired SQLite/Postgres migrations. The policy engine remains the sole send authority.
- API minimum: CRUD workflows, validate/preview, dry-run, publish/pause, run/cancel/resume, list runs/events, clone/version. Authenticate and audit all mutations; constrain descriptions and provider inputs to prevent prompt injection and secret leakage.

### Acceptance criteria

1. User opens a distinct **Workflows** navigation item and creates one from a plain-English description; app presents an inspectable graph/step plan and errors before activation.
2. A dry run shows matched jobs, verified-contact evidence, and send/no-send decisions **without** transmitting messages.
3. The engineering-contract template can reuse existing imported Sent history; identical recipient+campaign/opportunity and suppressed records are blocked.
4. A workflow with 200/day requested respects actual policy limits, sender ramp, campaign budgets, approvals and opt-outs; exceeding limits queues or refuses rather than bypassing gates.
5. Restart/retry after any step yields no duplicate external side effect; run logs show why each action succeeded, skipped or failed.
6. CLI and MCP can list/inspect/run workflows by the same API, without privileged alternative execution paths.
7. Mobile navigation and workflow editor remain usable, and all relevant tests pass under `bun run check`.

### Implementation order amendment

After Phase 0 stability work, deliver the workflow schema, validated planner, runner and top-level nav together with the contract-acquisition template; then enable live sending only after deduplication, policy checks, approval and safe retry tests pass. Avoid building a separate automation backend; refactor existing cadence/jobs into reusable workflow operations where sensible.
