# URL-first pipeline — implementation plan

**Goal.** Paste a company URL, or up to 100 at once. OutreachGraph reads the
homepage, works out who is worth talking to there, finds those people across the
networks it is allowed to look at, and produces an approval card with a drafted
message.

**Status.** Not started. This document is the plan, not a record of work.

---

## 1. What the pipeline does today

`POST /prospects` takes one GitHub handle and runs the whole chain inline, in
the request (`apps/api/src/app.ts:334`, `packages/pipeline/src/pipeline.ts:60`):

| Stage | Where |
| --- | --- |
| enrich | `github.enrich({ handles: { github: handle } })` — `pipeline.ts:69` |
| suppression check | `isSuppressed` — `pipeline.ts:88` |
| resolve identities | `linkIdentities` — `pipeline.ts:100` |
| research | `github.activity` → `extractSignals` — `pipeline.ts:106` |
| score | `rescoreProspect` — `pipeline.ts:118` |
| recommend | `createRecommendation` — `pipeline.ts:122` |
| draft | `draftForRecommendation` — `pipeline.ts:140` |
| await approval | `setStatus(…, 'awaiting_approval')` — `pipeline.ts:145` |

GitHub is not one source among several here. It is the **anchor identity**: if
`github.enrich` returns nothing the run stops at `no GitHub profile for …`
before a person record exists.

## 2. What already exists and gets reused

This is the good news, and it is most of the system.

- **`companies`** table with a unique index on `domain`
  (`migrations/0001_identity_graph.sql:5`). A URL maps onto an existing entity;
  no schema change needed to hold the company.
- **`source_documents`** — `url`, `title`, `excerpt`, `content_hash`,
  `license_class`, `availability`, `expires_at`
  (`migrations/0002_signals.sql:8`). Purpose-built for storing a fetched page.
  The unique index on `(workspace_id, content_hash)` gives crawl dedupe for
  free.
- **`signals.company_id`** already exists alongside `person_id`
  (`migrations/0002_signals.sql:29`), so company-level signals are modelled.
- **Provider interface** — `PersonEnrichmentInput` already accepts
  `companyDomain`, `companyName`, `title` and `profileUrls`, and `search()`
  takes titles, seniorities, technologies and keywords
  (`packages/providers/src/provider.ts:29`). A URL-first flow needs no change
  to this interface.
- **`enrichWithWaterfall`** — multi-provider ordering by cost and capability,
  built, tested, and **currently unused**: the API passes `providers: []`
  (`apps/api/src/app.ts:365`). Wiring providers in is configuration, not
  construction.
- **Identity resolver**, evidence and confidence scoring
  (`packages/identity/src/resolver.ts`).
- **Policy engine**, default-deny, per-network capability matrix
  (`packages/policy/`). Crucially, `website/observe` and
  `website/refresh_research` are already `research_only`, reason "Permitted
  public web retrieval" (`capability-matrix.ts:175`). **Homepage crawling is an
  already-sanctioned capability with no adapter behind it** — not a new policy
  category to argue about.
- **Scoring, recommendation engine, AI drafting with grounding, approval queue,
  suppression, deletion, audit.**

## 3. What is missing

Four things, in dependency order.

### Gap A — no durable job queue

`JOB_KINDS` (`packages/pipeline/src/jobs.ts:19`) is a return-type enum, not a
queue. **There is no jobs table.** The worker loop
(`apps/server/src/index.ts:249`) is a `while` loop on `WORKER_TICK_MS` that runs
exactly two things: `expireSignals` and `processDeletion`.

Combined with `POST /prospects` running the pipeline synchronously in the
request, 100 URLs is not a slow request — it is an impossible one. A single URL
will fan out to a crawl, an extraction, an identity search per candidate person
and a draft per recommendation. This gap blocks everything else and has to go
first.

### Gap B — no site fetcher or extractor

Nothing in `packages/providers/` fetches a web page. There is no HTML parser, no
robots.txt handling, no rate limiter, no charset or redirect handling.

### Gap C — the pipeline is hard-anchored on GitHub

`runPipeline(options, handle)` takes a handle and starts from GitHub. A
URL-first run inverts the order: the company is known first and people are
discovered from it.

### Gap D — one adapter

`packages/providers/` contains `github/` and a fixture. The eleven networks in
`packages/domain/src/networks.ts` and the per-network policy rules describe a
system with many adapters; only one was written.

---

## 4. Proposed shape

```
URL ──▶ fetch ──▶ extract ──▶ candidate people ──▶ [existing chain, per person]
        (new)     (new)        (new)                resolve → research → score
                                                    → recommend → draft → approve
```

The new work is entirely in front of the existing chain. Once a URL has produced
a `PersonCandidate`, everything downstream already works — that is why this is
a tractable project rather than a rewrite.

### Phase 1 — the job queue

The prerequisite for everything else.

- Migration `0007_jobs.sql`: a `jobs` table — `id`, `workspace_id`, `kind`,
  `payload_json`, `status` (`pending | running | done | failed`),
  `attempts`, `run_after`, `last_error`, timestamps. Index on
  `(status, run_after)`.
- Claim with a conditional `UPDATE … WHERE status = 'pending'` returning the
  row, so a claim cannot be double-taken. Single replica today, but the guard
  costs nothing and `numReplicas` will not stay at 1 forever.
- Extend the worker loop to drain the queue each tick, with bounded attempts and
  exponential `run_after` backoff.
- Reuse the existing `JOB_KINDS` union — it becomes the real thing it already
  describes.

*Deliberately not Redis.* `REDIS_URL` sits empty in the vault and unreferenced
in the code. Turso is already there, already backed up, and a table is enough at
this volume.

### Phase 2 — the site provider

A new `packages/providers/src/site/` adapter.

- `fetchHomepage(url)` — HEAD then GET, follow a bounded number of redirects,
  cap body size, respect `robots.txt`, send a descriptive User-Agent with a
  contact URL, and honour `Retry-After`. Per-host concurrency of 1 and a
  politeness delay.
- Store the result as a `source_document` with `network = 'website'`,
  `license_class` set from the policy engine's `research_only` classification,
  and `content_hash` so a re-crawl of unchanged content is free.
- `extractCompany(html)` — name, description, technologies, social links from
  `<link rel="me">`, footer anchors, JSON-LD `Organization`, and OpenGraph.
  Upsert into `companies` on `domain`.
- `extractPeople(html)` — team/about pages, JSON-LD `Person`, bylines. Returns
  `PersonCandidate[]` in the **existing** shape, so nothing downstream changes.

The policy engine gates the fetch as `website/observe` before any request is
made, not after. A denied fetch is recorded, not attempted.

**This is the phase that needs a decision before code.** Extraction quality
determines whether the product works, and there are two routes: deterministic
parsing (cheap, predictable, brittle across bespoke marketing sites) or an LLM
extraction pass over cleaned text (robust, costed per URL, and it must stay
inside the grounding rule — every claim traces to stored evidence). A hybrid is
likely: deterministic for structured markup, LLM only where that finds nothing.

### Phase 3 — company-first entry points

- `POST /prospects/by-url` — one URL, enqueues `crawl_site`, returns the job id.
- `POST /prospects/bulk` — up to 100 URLs, validated and deduped by normalised
  host, enqueues one job each, returns a batch id.
- `GET /batches/:id` — per-URL status, so the UI can show progress rather than a
  spinner.
- Refactor `runPipeline` to accept a `PersonCandidate` rather than a handle,
  with the GitHub path becoming one caller that produces such a candidate. This
  keeps every existing test meaningful.
- Meter it: `usage_events` already exists, and 100 crawls plus enrichment plus
  drafts is the first genuinely expensive operation in the product.

### Phase 4 — fan-out across networks

- A `findIdentities(candidate)` step that queries each configured provider for
  the networks it declares, then feeds the results through the existing
  resolver — which already refuses to merge on a name match alone.
- Wire real providers into that empty `providers: []` array.
- Add adapters in the order the policy matrix already permits: `bluesky`
  (official API, no key), then `x` (official API, paid), then an enrichment
  vendor such as Apollo for `email`. **Not LinkedIn** — the capability matrix
  makes every LinkedIn action `manual_only`, and that is a stated
  non-negotiable.

---

## 5. Sequencing and risk

| Phase | Depends on | Main risk |
| --- | --- | --- |
| 1 — job queue | — | Low. Well-understood, fully testable offline. |
| 2 — site provider | 1 | **High.** Extraction quality is the product. |
| 3 — entry points | 1, 2 | Medium. Mostly refactor; touches tested code. |
| 4 — network fan-out | 2, 3 | Medium. Per-vendor cost, quota and contract terms. |

Phase 1 is worth doing regardless of what happens to the rest — the synchronous
`POST /prospects` is already a latency problem at one URL.

### Things that will bite

- **Crawl etiquette is a product risk, not a footnote.** The PRD is strict about
  what may be retrieved and retained. Robots handling, identifiable User-Agent
  and rate limits belong in the first commit of Phase 2, not a later hardening
  pass.
- **The grounding rule applies to crawled text too.** "No stored evidence, no
  claim" means an extracted job title has to be traceable to a stored
  `source_document`, exactly as a GitHub signal is.
- **Homepages rarely name individuals.** Many URLs will yield a company and no
  people. The flow needs a defined answer for that — enrichment lookup by
  company domain, or a card that asks the operator for a name — decided before
  it is discovered in testing.
- **A drafted message per prospect at 100 URLs is a real bill.** The model call
  already supports prompt caching (`packages/ai/src/model.ts`); the cached
  prefix should carry the workspace voice profile and offering, which is
  constant across a batch.
