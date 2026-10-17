# Site audits

Every company's homepage, bulk imports included, is audited by [seo.rank](https://github.com/moshcoder/seo.rank) (score 0-100, grade, the fixes that matter most) and the latest result is kept per company in `site_audits`.

## When an audit runs

- **On intake.** Every path that records a new company queues an `seo_audit` job (dedupe key `seo_audit:<host>`): crawls, the URL/keyword pipeline, contact imports (one batch per chunk), job posts and list sources. Platform domains (gmail.com, substack.com, github.com, ...) are skipped.
- **The sweep.** Each round spends what the jobs left of its budget in three tiers: lead companies (someone works there; never audited newest first, then the oldest due audit), then every other company never audited (the bulk imports, ~14k a day, newest first), then their due re-audits. Imports get no job row; the sweep reaches them within a round or two.
- **Re-audit.** A good audit is due again after 30 days; a site that refused (unreachable, not HTML, private address) after 7 days.
- **By hand.** `POST /api/v1/people/:id/site-audit`, `og site-audit refresh <personId>`, MCP `get_site_audit` with `refresh`, or "audit again" on the prospect page.

Both run in the worker's site-audit runner, its own loop beside the tick. The main serial drain never claims an `seo_audit` job, so audits cannot hold up a crawl or a send.

## Failures

| seo.rank answer                                                 | what happens                                                                                                                                                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200                                                             | stored, `status = ok`, due in 30 days                                                                                                                                                         |
| 400 / 422 (the site's answer)                                   | stored, `status = failed`, due in 7 days                                                                                                                                                      |
| 429 / 503 / 401 (seo.rank out of capacity, or our key is wrong) | the round stops, the job goes back with its attempt refunded (10-minute hold), nothing recorded                                                                                               |
| 5xx, timeout, connection refused                                | the job retries with the queue's backoff (30 s doubling) and is dead (`failed`) after 6 attempts; the sweep's own record backs off 1 h doubling and is `dead` after 5, tried again in 30 days |

A transient error keeps the last good result on screen.

## Surfaces

- API: `siteAudit` on `GET /api/v1/people/:id`; `GET|POST /api/v1/people/:id/site-audit`; `GET /api/v1/site-audits/stats`.
- CLI: `og site-audit <personId> [--json]`, `og site-audit refresh <personId>`, `og site-audit stats`.
- MCP: `get_site_audit`, `site_audit_stats`.
- Web: "Homepage audit" on the prospect page.
- Drafting: a good audit from the last 60 days is offered to the composer as an optional, grounded line of CONTEXT ("Their homepage ... 58/100, grade F. Top issues: ..."), to be used only when it connects to the offering. It changes no send behaviour or volume.

## Configuration

| env                     | default                            |                                                                                           |
| ----------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `SEORANK_API_KEY`       | (none: audits are queued, not run) | the `outreachgraph` key in seo.rank's `SEORANK_API_KEYS`                                  |
| `SEORANK_URL`           | `http://127.0.0.1:8790`            | on dev2 the container uses `http://10.200.48.1` (host nginx on the docker bridge gateway) |
| `SEORANK_HOST`          |                                    | `seo.rank`, the Host header for that nginx vhost                                          |
| `SEO_AUDITS_PER_ROUND`  | 10                                 | audits per round                                                                          |
| `SEO_AUDIT_ROUND_MS`    | 60000                              | so about 14,400 a day, inside the key's 50,000/day                                        |
| `SEO_AUDIT_CONCURRENCY` | 3                                  | under seo.rank's keyed gate of 4                                                          |

## Rate

Measured on dev2 2026-10-17: seo.rank serves ~75-100 keyed audits a minute at concurrency 4 (p50 ~2 s, p90 ~8 s), ~20 ms of CPU and a ~290 KB page per audit (so ~12-20 GB a day inbound at full rate). 30 a minute is about a third of that ceiling, keeps up with ~14k imports a day and drains a backlog at ~29k a day on top. At 1M companies the 30-day re-audit alone would need ~33k a day: revisit then.

## Using the score: picking imported companies

`pickImportedLeads` (`POST /campaigns/:id/discover/leads`, `og sources pick`, MCP `pick_imported_leads`) chooses which imported companies get the paid people-finding crawl. Default `sort=weak_seo`: reachable homepages scoring under 70 first, most issues (warnings plus failures, `site_audits.issues`) then lowest score first; then companies not audited yet; then the rest by importer rank. `sort=rank` keeps the importer's order. `maxScore=N` keeps only audited sites at or under N. A site seo.rank could not read (`failed`/`dead`) is never picked. Preview without queuing: `GET /api/v1/lead-sources/candidates`, `og sources candidates`, MCP `preview_imported_leads`, and the "Next picks" table on `/sources`.

## Company refresh

The same change re-reads known companies: once an hour `refreshStaleCompanies` queues ordinary `crawl_site` jobs (`crawl:<host>`) for the companies not read for `COMPANY_REFRESH_STALE_DAYS` (30), stalest first, `COMPANY_REFRESH_PER_DAY / 24` at a time (default 150 a day), filed under the campaign that most recently touched one of their people. Only companies with someone in an active campaign are re-read, and a workspace with 25 or more crawls outstanding is skipped so its own work comes first. A crawl costs one extraction call on the chain's first model; no paid lookup (ValueSERP, PDL) is re-run.
