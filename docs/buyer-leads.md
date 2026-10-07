# Buyer leads

People in public communities who look ready to buy what a brand sells: a quoted
excerpt, a link, an intent score with its reason, a reply drafted on request,
and a daily digest email. The same job as Needle's "Auto Search" lead digest,
inside OutreachGraph.

**Nothing is ever posted for you.** Replies are drafts. A human reads the
thread, edits the reply and posts it under their own name, then marks the lead
replied. There is no route, CLI verb or MCP tool that posts to a community.

## How it works

1. **Monitor.** One per brand or product: keywords, subreddits, sources
   (`reddit`, `hackernews`, `bluesky`), an intent floor (default 60) and a
   schedule (default every 6 hours, never more often than hourly). A name, a
   URL or a product id is enough: the model suggests keywords (category,
   problems, competitors) and subreddits.
2. **Scan.** The worker scans due monitors one at a time, beside the tick.
   - Reddit blocks servers, so subreddits are read from the
     [Arctic Shift](https://arctic-shift.photon-reddit.com) archive: newest
     posts, up to five pages of 100 per subreddit back to the last scan, paced
     2.5 s apart (it answers 422 to anything faster). Its full-text search times
     out on busy subreddits, so it is not used. No subreddits: no Reddit.
   - Hacker News through Algolia `search_by_date`, one quoted request per
     keyword, 1 s apart.
   - Bluesky through `api.bsky.app` (`public.api.bsky.app` answers
     `searchPosts` with 403 to anonymous callers).
   - A post must contain a keyword as whole words; `exclude` words drop it.
3. **Score.** The model classifies each post rather than picking a number
   (asked for a number, it anchored on the floor):
   - `kind`: `seeking` 88, `problem` 72, `discussion` 35, `promo` 5 (vendors,
     ads, courses, launches, job and hiring threads), `offtopic` 0;
   - `fit` of the brand: `high` x1, `medium` x0.85, `low` x0.5;
   - a one-line reason.

   Up to 60 posts per scan, 10 per call, best wording first within each source
   with sources taking turns. A post waits at 45 (below the floor) until judged,
   and every scan judges the last 7 days' backlog first. With no model at all
   the wording classifier scores, and only a request for recommendations clears
   60 (`judged: false`). Every matched post is stored once (`community_leads`,
   unique per monitor, source and post id), lead or not, so nothing is scored
   twice.
4. **Reply.** `Draft AI reply` writes 40-120 words: answer the question first,
   disclose the affiliation, name the product at most once.
5. **Digest.** Once per UTC day after the workspace's digest hour
   (`workspace_settings.digest_hour_utc`, default 13), to the notify address,
   only when there are new leads over the floor from the last 3 days. Each lead
   is sent once (`digested_at`). Claimed through `notifications`
   (`community_leads_digest`), so overlapping ticks cannot send two.

## Surfaces

- Web: `/buyer-leads` (linked from Products, each product page, Signals and
  Settings). `?lead=<id>` focuses one lead, which is where the digest links.
- API: `/api/v1/buyer-leads`
  - `GET /` leads (`status`, `monitor`, `minIntent`, `limit`) and monitors
  - `GET|POST /monitors`, `GET|PATCH|DELETE /monitors/:id`
  - `POST /monitors/:id/scan`
  - `GET|PATCH /:id` (status `new|replied|dismissed`, `replyDraft`)
  - `POST /:id/draft`
- CLI: `og buyers list|show|draft|replied|dismiss|reopen|monitors|add|set|scan|rm`
  (`og leads` is the CSV lead import).
- MCP: `list_buyer_leads`, `create_buyer_lead_monitor`,
  `update_buyer_lead_monitor`, `scan_buyer_lead_monitor`,
  `draft_buyer_lead_reply`, `update_buyer_lead`.

Tables: `lead_monitors`, `community_leads` (migration 0059; 0060 and 0061 re-queued
rows scored by the earlier rules).
