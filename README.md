# OutreachGraph

**Turn public intent signals into warm conversations.**

Apollo finds their contact info. OutreachGraph finds where they are actually
active, what they care about right now, and tells you the least intrusive
useful way to start the conversation — then refuses to send anything the
platform, the prospect, or your own rate limits say it should not.

## Status

Foundation. The deterministic core, the API, the PWA and one live provider are
built and tested; a prospect can go from a GitHub handle to a card in the
approval queue today. The LLM layer — the outreach composer and the rest of the
§20 agent suite — is not built. See
[`docs/prd-implementation-map.md`](docs/prd-implementation-map.md) for exactly
what exists.

## Quick start

```bash
bun install
bun run db:migrate          # applies migrations to ./local.db
bun test                    # 265 tests
bun run check               # format, typecheck, test
```

Run the API and the PWA:

```bash
bun run --filter '@outreachgraph/api' dev     # :8080
bun run --filter '@outreachgraph/web' dev     # :3000
```

No API keys are needed. The pipeline runs end to end on a deterministic
fixture provider, so a fresh checkout works with an empty `.env`.

## Layout

```text
apps/
  api/        Hono service on /api/v1
  web/        Next.js 16 mobile-first PWA
  worker/     background jobs: signal expiry, rescoring, privacy work
packages/
  domain/     canonical types — depends on nothing
  db/         Turso/libSQL client and migration runner
  policy/     the deterministic policy engine
  recommend/  next-best-action engine
  identity/   cross-network identity resolution
  signals/    signal decay
  scoring/    ICP fit, intent, reachability, relationship, opportunity
  providers/  vendor boundary and enrichment waterfall
  contracts/  request/response schemas shared by API and web
migrations/   forward-only .sql, applied in filename order
docker/       one Dockerfile per deployable service
```

## The pipeline

One GitHub handle goes all the way to a card in the approval queue:

```text
enrich → resolve identities → collect signals → score → recommend
```

`apps/worker/src/pipeline.ts` runs it. GitHub first because it is free, its
profiles carry links the person published themselves — `twitter_username`,
`blog`, `company` — and developer tooling is the launch wedge. A real profile
typically yields three linked identities before any paid provider is touched.

Each stage persists before the next runs, so a crash resumes rather than
restarting, and a half-enriched prospect is still inspectable.

## The three ideas worth knowing

**The policy engine is arithmetic, not judgement.** Every outbound action
passes through `packages/policy`. It is a pure function with no model in the
loop, it fails closed on anything the capability matrix does not describe, and
each gate may only tighten a decision — so gate ordering can never accidentally
re-permit something. LinkedIn automation is not "discouraged", it is
structurally unreachable.

**Policy is re-checked when you approve, not when the card was made.** A
recommendation stores the decision it was generated under, but
`POST /recommendations/:id/approve` runs the engine again against current
state. Suppression, a flipped feature flag, a spent rate limit, or a dropped
identity confidence all block an approval that would have been fine yesterday,
and the response names the gate that stopped it.

**Evidence combines with noisy-OR, so weak signals never reach certainty.**
Identity resolution and intent scoring both use `1 - Π(1 - eᵢ)`. Two 0.5
observations give 0.75, not 1.0. "Same name, same city" — the classic
false-merge trap — cannot merge two people no matter how many demographic
fields agree, and a pile of vague chatter never outranks one fresh explicit
question.

## Deleting a person

`DELETE /api/v1/people/:id` removes the profile, identities, signals, scores,
recommendations, and field provenance — and leaves a suppression tombstone
keyed on the platform account and hashed email. The tombstone is the point: it
survives the deletion so a later provider lookup cannot silently re-ingest
someone who opted out.

## Deployment

Railway, one service per Dockerfile, deploying from this repository.

The root `railway.json` configures the **default service** as the API. For each
additional service, open its settings and set the config file path — Railway
only reads a subdirectory config if you point it there:

| Service | Config file path            |
| ------- | --------------------------- |
| api     | `/railway.json`             |
| web     | `/apps/web/railway.json`    |
| worker  | `/apps/worker/railway.json` |

**Leave Root Directory unset.** These Dockerfiles expect the repository root as
their build context; scoping a service to `apps/web` breaks every `COPY` and
the workspace install.

Without a config file Railway falls back to railpack auto-detection, which
cannot find a start command in a Bun workspace and fails the build — that
symptom means the service is not pointed at its config.

Migrations run as an explicit release step, never from every replica. Set up
separate Turso databases, provider keys, and secrets per environment;
production customer data is never copied into staging.

## Conventions

See [`CLAUDE.md`](CLAUDE.md). The short version: TypeScript strict, ESM,
kebab-case, colocated tests, forward-only migrations, and a set of
non-negotiables that come from the PRD rather than from taste.
