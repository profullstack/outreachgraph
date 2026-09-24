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

### A person's OpenProfile.md

The `openprofile` job assembles one [OpenProfile.md](https://logicsrc.com/openprofile)
per person from their public profiles, through `@profullstack/openprofile`. It
is private until somebody switches it on, and it can be corrected from every
surface: what the owner writes wins section by section, the rest is still
generated, and a rewrite by the job never touches the corrections.

```bash
og profile per_...                            # the file, as this workspace sees it
og profile edit per_... [--file profile.md]   # correct it ($EDITOR when no --file)
og profile publish per_... --public|--private # list it for directories, or stop
```

The same three over HTTP: `GET /api/v1/people/{id}/openprofile.md`,
`PUT /api/v1/people/{id}/openprofile` (the whole file as `text/markdown`, or a
JSON overlay of `identity`, `headline`, `sections`, `public`, `handle`), and
`POST /api/v1/people/{id}/openprofile/publish {public}`. MCP:
`get_openprofile`, `update_openprofile`, `publish_openprofile`.

A public profile is served to anybody, minus email, phone and any Contact
section, and listed at `GET /api/v1/openprofiles?since=&limit=&cursor=` for a
directory such as nichedb.dev to pull. A suppressed person is never public.
The person may correct their own profile without a session here: an OpenAccess
bearer with the `openprofile:edit` scope is honoured when its principal is
provably them, by an email this deployment verified or by the OpenProfile.md
they publish.

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

## Public profile photos

Prospects, approval cards and the daily digest show a photo when a public source
supplies one. Crawls retain JSON-LD `Person.image` portraits and team images whose
alt text names the person, including lazy-loaded images and relative URLs. GitHub
enrichment keeps the public account's avatar. Photos are stored with the source
page in field provenance; existing photos are kept, and a later crawl or enrichment
can fill an empty photo even after image search previously missed.

These paths use the pages and public API responses already being read. Gravatar
and social profile intake remain available, and `VALUESERP_API_KEY` optionally
enables the bounded image-search fallback for LinkedIn and company team pages.
Nothing signs into LinkedIn or bypasses a blocked page. Missing or unavailable
photos show initials. Previously imported people gain these photos on their next
crawl or enrichment; this change does not run a production backfill.

## The three ideas worth knowing

**The policy engine is arithmetic, not judgement.** Every outbound action
passes through `packages/policy`. It is a pure function with no model in the
loop, it fails closed on anything the capability matrix does not describe, and
each gate may only tighten a decision — so gate ordering can never accidentally
re-permit something. LinkedIn automation is not "discouraged", it is gated:
it runs only through the member's own session, which exists only after the
workspace owner explicitly accepts LinkedIn's terms risk
(`og connect linkedin --accept-linkedin-risk`), and even then every invitation,
visit, follow, message and comment is paced, capped per kind, and approved by a
human unless a campaign opts into trusted automation. Without that session,
every LinkedIn action is a hand-off.

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

## Public directory

`GET /api/v1/public/directory` is the one keyless read: what the crawler learned
from pages that were already public, about things that are public by nature.
Companies and sites by their domain, and people only when they publish their own
profile (an OpenProfile.md they serve themselves, or a profile and a home page
that point at each other with rel=me). Never an email, a phone, a location, a
score, a signal, a campaign or a workspace. One row shape,
`{ id, kind: company|site|person, name, url, description, topics, country, openprofile, updated }`,
paged by `since` and an opaque `cursor`, cacheable for five minutes, sixty
requests a minute per caller. The rule lives in `apps/api/src/public-directory.ts`
and nowhere else; nichedb.dev reads it into its directory collection.

## AutoGTM API

The agent-facing surface: `/api/v1/autogtm/*`. Projects (one per product), campaigns with
budgets in dollars per day, a project-level autopilot that splits the ceiling across campaigns
by reply rate, an inbox with `need_reply` / `replied` / `sent` / `unsubscribed` tabs, replies,
hot leads, named suppress lists for addresses and domains, and an import that makes a campaign
from your own list.

Read `/api/v1/public/llms.txt` first (the quick guide) and `/api/v1/public/openapi.json` for
the schema. Both are keyless and rendered from one table in `apps/api/src/autogtm-docs.ts`, so
a route cannot appear in one and not the other; a test refuses a documented route that does not
exist.

Authenticate with a workspace key: mint one on `/settings` (or `POST /api/v1/api-keys` with a
session) and send it as `X-API-Key` on every request. A key acts with its owner's current
role and cannot mint keys. The service token and its scope headers still work for internal
callers.

A dollar budget becomes `max_contacts_per_day = floor(usd / price_per_contact_usd)` on the
campaign, which the policy engine enforces at send time like any other cap. Nothing in this
surface can send outside the engine: a reply is a `send_email` card marked as a follow-up,
approved by the call itself, and refused with 409 when the lead is suppressed or the budget is
spent.
