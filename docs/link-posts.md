# Posts from a link

Paste a URL on **Approve → Manual posts** (`/approvals?tab=handoffs`), pick the
networks, and get one hand-off card per network: the post written in the
workspace's voice and sized to that network, a character count against its
limit, **Copy**, **Open <network>** (the network's own composer, prefilled
where it allows it), numbered steps, **Mark done**, **Regenerate** and **Skip**.

**Nothing is ever posted for you.** LinkedIn forbids automation, Reddit and
Hacker News have no write path we may use, and Facebook's composer takes a link
and nothing else. A person reads every card and presses Post themselves.

## How it works

1. **Read the page.** The API fetches the URL like a link unfurler: one fetch,
   every hop checked against private addresses (the URL comes from a request
   body), robots.txt not consulted because this is one page a person asked for,
   not a crawl. It keeps `og:title`/`<title>`, the description, and the main
   text (`<article>`, else `<main>`, else the body, without nav/header/footer),
   up to 6,000 characters. A page that cannot be read (403, PDF, timeout) is a
   422 unless `notes` describe it; then the posts are written from the notes.
2. **Pick the voice.** `offeringId` when given; otherwise the product whose site
   the link is on (host or subdomain match), otherwise the first product. The
   product's voice profile (style + instructions) and its name/URL/description
   go to the model. A link on the poster's own site is written as its maker
   (and disclosed on Reddit and HN); anyone else's is shared, not pitched.
3. **Write.** One model call through the deployment's fallback chain for all
   the networks asked for (`LINK_POST_FORMATS` in
   `packages/domain/src/link-posts.ts` holds each network's norms and limits).
   The answer is cleaned: the URL is removed from the text (the card adds it
   where the network wants it), em and en dashes become commas, and a post over
   its limit is cut at a word boundary.
4. **Cards.** Stored in `link_posts` (migration `0064`), page text included, so
   **Regenerate** rewrites one card from the stored page with a new angle
   without fetching it again.

| Network     | Limit                   | Card                                                    |
| ----------- | ----------------------- | ------------------------------------------------------- |
| LinkedIn    | 3,000 (aim 600-1,300)   | text + link; opens `feed/?shareActive=true&text=`       |
| X           | 280, any link counts 23 | text + link; opens `x.com/intent/post`                  |
| Reddit      | title 300               | title, subreddit, first comment; opens `r/<sub>/submit` |
| Hacker News | title 80                | title, optional first comment; opens `submitlink`       |
| Facebook    | (aim < 500)             | text to paste; opens `sharer.php?u=` (link only)        |
| Bluesky     | 300 including the link  | text + link; opens `bsky.app/intent/compose`            |
| Mastodon    | 500, any link counts 23 | text + link; opens `<instance>/share` (mastodon.social) |
| Threads     | 500                     | text + link; opens `threads.net/intent/post`            |

Editing the text in the browser rebuilds the Open link, so what opens is what
was edited. Mark done stores the final wording and, optionally, the URL of the
live post.

## API

All under `/api/v1/link-posts`. Reading is open to every member; drafting,
regenerating and marking are approver-only. Drafts and regenerates share a
throttle of 40 an hour per workspace.

- `GET /link-posts?status=open|done|skipped|all` → `{ posts, networks, defaultNetworks, draftingEnabled, posting: 'manual' }`
- `POST /link-posts` `{ url, networks?: ['linkedin', ...], offeringId?, notes?, mastodonInstance? }` → 201 `{ batchId, page, posts, missing }`
- `GET /link-posts/:id`
- `PATCH /link-posts/:id` `{ text?, title?, subreddit?, mastodonInstance?, status? }`
- `POST /link-posts/:id/regenerate` `{ notes? }`
- `POST /link-posts/:id/done` `{ postedUrl?, text?, title? }`
- `POST /link-posts/:id/skip`
- `DELETE /link-posts/:id`

Errors: 400 bad input, 403 viewer, 422 `page_unreadable` (add `notes`),
429 throttled, 502 `draft_failed`, 503 `no_model`.

## CLI

```
og linkpost https://example.com/launch --to linkedin,x,reddit,hackernews [--notes "angle"] [--product off_...]
og linkpost list [--status open|done|skipped|all]
og linkpost show <id>
og linkpost regen <id> [--notes "a different angle"]
og linkpost done <id> [--url https://www.linkedin.com/feed/update/...]
og linkpost skip <id>
```

(`og post` is the older command that opens a composer for a recommendation.)

## MCP

- `draft_posts_from_link` `{ url, networks?, offeringId?, notes? }`
- `list_link_posts` `{ status? }`
- `regenerate_link_post` `{ id, notes? }`
- `mark_link_post` `{ id, outcome: 'done' | 'skipped', postedUrl? }`
