# Content Radar

Find what gets attention in a product's niche, understand why, and turn it into
posts for the product. It runs on its own every day; a person can steer it or do
any step by hand.

Surfaces: web `/content` (Discover, Saved, Following, Studio, Drafts), API
`/api/v1/content-radar`, CLI `og radar`, MCP tools `content_radar_overview`,
`configure_content_radar`, `scan_content_radar`, `list_content_references`,
`add_content_reference`, `update_content_reference`, `create_from_reference`,
`follow_content_account`, `unfollow_content_account`, `list_content_follows`,
`list_studio_assets`.

## What runs on its own

The server tick calls `runContentRadar` beside the main loop (one sweep at a
time; `CONTENT_RADAR=off` stops it):

1. **Radars.** Every product with a running campaign gets a radar on first
   sweep. Terms and subreddits come from the product's buyer-lead monitor, else
   the model's suggestion, else the category and named competitors. Tags are
   the terms written as hashtags.
2. **Discover.** Each radar is read once every 24 hours (four scans per sweep,
   so 50 products spread over ticks). The best performing posts of the last 30
   days, per source:

   | Source      | How                                                                   |
   | ----------- | --------------------------------------------------------------------- |
   | Hacker News | Algolia `search`, stories with more than 2 points, per term           |
   | Bluesky     | `api.bsky.app` `searchPosts?sort=top` per term (the public host 403s) |
   | dev.to      | `/api/articles?tag=<t>&top=30` per tag                                |
   | Mastodon    | mastodon.social public tag timeline, posts with any engagement        |
   | Reddit      | Arctic Shift, each audience subreddit, window ending 2 days ago       |

   The archive records a Reddit score at ingest and refreshes it about a day
   and a half later, so the newest two days all read 1; the window skips them.
   A subreddit is already the audience, so its best posts count whatever they
   say; terms only narrow it when at least five posts match.

   Followed accounts (Bluesky, Mastodon `user@instance`, Hacker News, Reddit,
   dev.to) are read in the same scan. TikTok, Instagram and X need a login and
   are not read; save their posts by link with the text pasted.

3. **Hooks.** Up to 30 unjudged references per scan, most engaging first, ten
   per model call: a hook type from a fixed list (contrarian, question, story,
   how-to, list, numbers first, mindset shift, fresh angle, launch, behind the
   scenes, audience conversation, product positioning), why it worked, and an
   angle for the product. With no model, the wording names the hook and the
   reference shows "(from the wording)".
4. **Drafts.** Up to `RADAR_DRAFTS_PER_DAY` (3) per workspace per UTC day,
   counted by link posts with `created_by = 'content_radar'`. Products take
   turns (longest since last draft first, one a day each); each uses its best
   unused reference (saved first, then model-judged, then engagement). A failed
   draft spends the product's turn for the day and records `last_error`; it
   never dismisses the reference.

## Create from a reference

`POST /references/:id/create` with any of `formats: posts, storyboard, image`:

- **posts**: one link-post card per network on the radar (default LinkedIn,
  Bluesky, Mastodon, X, Reddit) linking the product URL, written by the
  ordinary link-post writer with the reference passed as structure to borrow
  ("do not copy its words"). They land in Manual posts. The dev2
  `outreachgraph-autopost` cron posts open Bluesky, Mastodon and LinkedIn
  cards through myna (4 h gap, 3 a day per network); X and Reddit stay for a
  person. A product with no URL skips posts.
- **storyboard**: 3 to 5 scenes, 15 to 35 seconds: hook, story, invitation,
  each with on-screen text, voiceover and the shot.
- **image**: a 1080x1350 card (eyebrow, headline, support line, footer,
  caption) rendered from a template as SVG at
  `GET /assets/:id/image.svg`. No image model is called. The web Studio
  exports it to PNG in the browser.

The reference becomes `used`.

## Data

Migration `0084_content_radar`: `content_radars` (one per product),
`content_follows`, `content_references` (unique per workspace, source,
external id; numbers refresh on every sighting), `content_assets`.

## Cost

Every source is keyless. Model calls per product per day: at most 3 hook
batches, plus 2 per draft (posts and studio), so at most about 9 a day for a
workspace that drafts its 3. The model chain is the deployment's usual one.
