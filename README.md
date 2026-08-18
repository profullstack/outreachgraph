# OutreachGraph

**Turn public intent signals into warm conversations.**

Apollo finds their contact info. OutreachGraph finds where they are actually
active, what they care about right now, and tells you the least intrusive
useful way to start the conversation — then refuses to send anything the
platform, the prospect, or your own rate limits say it should not.

## Status

The deterministic core, the API, the PWA, the outreach composer and the
execution layer are built and tested. A prospect can go from a GitHub handle to
a drafted, policy-checked card in the approval queue, be enrolled on a
multi-step cadence, be contacted by email or by a public Bluesky reply, and
have the reply move their score — today.

The rest of the §20 agent suite is not built. See
[`docs/prd-implementation-map.md`](docs/prd-implementation-map.md) for exactly
what exists.

## Quick start

```bash
bun install
bun run db:migrate          # applies migrations to ./local.db
bun test                    # 1231 tests
bun run check               # format, typecheck, test
```

Run the API and the PWA:

```bash
bun run --filter '@outreachgraph/api' dev     # :8080
bun run --filter '@outreachgraph/web' dev     # :3000
```

### The machine surfaces

`og` and the MCP server are clients of `/api/v1` and nothing else. That is not
a convenience: the policy engine runs server-side, so a surface that could
reach past it would be a surface where the gates are optional.

```bash
export OUTREACHGRAPH_API_URL=http://localhost:8080
export OUTREACHGRAPH_API_TOKEN=$API_TOKEN
export OUTREACHGRAPH_WORKSPACE_ID=wsp_...
export OUTREACHGRAPH_ORGANIZATION_ID=org_...

bun apps/cli/src/index.ts today          # the approval queue
bun apps/cli/src/index.ts prospects      # ranked prospects
bun apps/mcp/src/index.ts                # MCP over stdio
```

The MCP server's claim is that an agent driving it **cannot be talked into
breaking a platform's terms**. That holds because the refusal is a pure
function on the server rather than an instruction in a prompt: every mutation
is an HTTP call that re-runs the deterministic policy engine, the engine fails
closed, and the process holds no database handle — so there is no faster path a
persuasive caller can be pointed at.

No API keys are needed. The pipeline runs end to end on a deterministic
fixture provider, so a fresh checkout works with an empty `.env`.

### Sending outreach

Outreach leaves through the workspace's **own** SMTP server, connected on
Settings. The password is authenticated against the real server before anything
is stored, so a saved mailbox is by construction a working one. Workspaces with
no mailbox connected fall back to the platform mailer, and which of the two
carried a message is recorded on every send and shown in the live status panel.

Storing a customer's mail password needs a key to encrypt it with —
`SECRET_ENCRYPTION_KEY`, documented in `.env.example`. Without it, connecting a
mailbox is refused rather than stored in the clear.

## Layout

```text
apps/
  api/        Hono service on /api/v1
  web/        Next.js 16 mobile-first PWA
  server/     the single entrypoint: API, PWA and the background loop
packages/
  ai/         the only package that talks to a model: composer + quality gates
  pipeline/   the discovery-to-queue chain and its background jobs
  email/      the sending boundary: Resend for account mail, SMTP for outreach
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

The pipeline lives in a package rather than an app because both the API
(adding a prospect on demand) and the background loop run the same chain — an
app importing another app's source would make the dependency direction a lie.

## The pipeline

One GitHub handle goes all the way to a card in the approval queue:

```text
enrich → resolve identities → collect signals → score → recommend
```

`packages/pipeline/src/pipeline.ts` runs it, and `POST /api/v1/prospects` is
how a person starts it from the UI. GitHub first because it is free, its
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

**A draft that fails its checks is withheld, not shown with a warning.** The
composer only ever sees stored evidence, stored facts and your own offering —
there is no path by which it learns something it may not cite. Its output then
runs deterministic gates: every specific assertion must appear in that
evidence, or the draft is rejected and rewritten once naming the exact invented
fragments. Still failing, nothing is shown. The card keeps the prospect, the
evidence and the recommended action, and you write the message. A bad draft
next to a caveat is still a bad draft someone might approve.

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
