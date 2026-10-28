# Campaign hubs

Media buyers on X, Bluesky or LinkedIn do not gather in a group with a name.
The community there is conversational: it lives in the replies under a
handful of accounts everybody in it follows and answers (on LinkedIn, the
comments under ad-account screenshots). Finding a campaign's audience on
those networks means finding those few accounts.

`og hubs <campaign>` ranks them from the campaign's own leads.

## How it ranks

For each lead in the campaign with a social identity (confidence 0.6 or
more) on Bluesky, Mastodon, X or LinkedIn, up to 60 leads:

| Network     | Read                                         | How                                                                                                                                   |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Bluesky     | who they follow, whose posts they replied to | `api.bsky.app` `app.bsky.graph.getFollows` (3 pages of 100) and `app.bsky.feed.getAuthorFeed?filter=posts_with_replies` (50), keyless |
| Mastodon    | who they follow                              | the lead's own instance, `/api/v1/accounts/:id/following` (80)                                                                        |
| X, LinkedIn | nothing                                      | no public read without an account; the lead's own handle is listed as a hub to watch by hand (`leadHub: true`, score 0.5)             |

Then:

- **At least two different leads behind a hub**, so one lead's favourite
  account is not a hub.
- **score = leads following + 2 x leads that replied to it.** A reply is the
  stronger signal: it is where the conversation already happens.
- `bsky.app` (every account's default follow) and the lead itself are skipped.
- The top 25 are kept, then the hand-watched X and LinkedIn leads.

The ranking is stored whole in `campaign_hubs` (migration 0080) and
recomputed only on request, since it reads every lead's graph (about a second
per Bluesky lead).

Nothing here follows or posts anything. myna does the watching: `myna
outreachgraph hubs <campaign>` imports the ranking, `myna hubs scan` drafts
replies under the hubs' newest posts, and a person approves each one before
myna's pacing sends it (mynaposter `docs/hubs.md`).

## Surfaces

- API: `GET /api/v1/campaigns/:id/hubs[?limit=N]` is the last ranking (`computedAt: null` before the first).
  `POST` recomputes it (approvers only).
- CLI: `og hubs <campaignId> [--refresh] [--limit 25] [--json]`
- MCP: `campaign_hubs` (`campaignId`, `refresh`, `limit`)

Response:

```json
{
  "campaign": { "id": "cmp_…", "name": "…" },
  "product": { "name": "…", "url": "…", "about": "…" },
  "leads": 44,
  "handles": 15,
  "read": 9,
  "hubs": [
    {
      "network": "bluesky",
      "handle": "…",
      "score": 5,
      "followedBy": 1,
      "repliedBy": 2,
      "why": "followed by 1 of 9 leads, 2 replied to it",
      "url": "https://bsky.app/profile/…"
    },
    { "network": "x", "handle": "…", "score": 0.5, "leadHub": true, "why": "a lead on X; …" }
  ],
  "failures": [{ "handle": "bluesky:…", "reason": "400 from api.bsky.app" }],
  "computedAt": "2026-10-28T…"
}
```
