# Audience watches

Every other intake in OutreachGraph starts from a stranger. A keyword names
companies, a crawl names the people on their pages, a feed search finds someone
complaining about a category in public. An audience watch starts from the
opposite end: the people who already engaged with **your** account.

Somebody followed you, liked your post, reposted it, replied to it or mentioned
you. That act is public, it names both parties, and nothing about it was
inferred — which makes it the cheapest grounded claim the product can make, and
the fastest-decaying one. A like from this morning is something the person
remembers. A like from three weeks ago is not, and a message that opens by
reminding them reads worse than a cold one.

## What happens when a watch runs

1. The reader asks the network who engaged, over a window of recent posts.
2. Anything already recorded for that watch is dropped. A poll re-reads its
   whole window every time it runs, so the ledger is keyed on the act —
   `(watch, kind, actor, post)` — not on when we saw it.
3. Each new engager is opened through the same intake a social client
   hand-off uses (`intakeSocialPeople`): one person, one campaign membership,
   their bio as a `content_topic` signal, and an `openprofile` job to find out
   who they actually are.
4. The engagement itself becomes an `audience_engagement` signal, with the
   post's own words as evidence and its URL as the source.
5. `runRules` gets a `signal_received` event. An automation rule is what turns
   that into an enrolment on a cadence — the only route from a signal to a
   plan, because a rule can queue work and cannot send.

Everything after step 5 is the machinery that already existed: the policy
engine, the capability matrix, the daily caps, human approval.

## What a watch does not do

**It does not promote anybody.** A handle that clicked a heart is still a
handle, so an engager is written at the same handle-only identity confidence as
any other social hand-off — below the workspace's `min_outreach_confidence`
floor. The policy engine goes on refusing outbound until something else works
out who they are. This is the intended behaviour, not a gap to route around.

**It does not send.** Nothing in `packages/pipeline/src/audience.ts` reaches a
network to write. The most an engagement can do on its own is produce a card.

**It does not invent warmth.** Someone who likes a post, unlikes it and likes it
again is one signal, because the product cannot tell that apart from a re-read.

## The three networks

| Network  | How it reads                    | What it needs                                                        |
| -------- | ------------------------------- | -------------------------------------------------------------------- |
| Bluesky  | Public AppView, unauthenticated | Nothing. Type a handle and it works.                                 |
| X        | X API v2, user context          | A connected X account on a plan that permits the reads (below).      |
| LinkedIn | Hand-off only                   | Somebody posts what they saw to `POST /api/v1/audience/engagements`. |

### Why X often refuses

The sender's OAuth grant asked for `tweet.write`, `like.write` and
`follows.write` — writes, because that is what sending needed. Reading
followers and likers needs `follows.read` and `like.read`, and the endpoints
themselves (`/2/users/:id/followers`, `/2/tweets/:id/liking_users`,
`/2/tweets/:id/retweeted_by`) sit above X's free tier.

So two different refusals are reported differently:

- A grant made without the read scopes is refused **before any call**, naming
  the scopes and telling the user to reconnect X.
- A 403 from X itself is reported as needing a paid tier.

Both are `retryable: false`, which **disables the watch** and writes a workflow
event. Retrying an unpaid tier every half hour for a month produces nothing but
a quota bill. A 429 or a 5xx is `retryable: true`: the reason is recorded, the
watch stays on, and the next tick tries again.

A cookie session (`og connect x --session`) can post, like and follow, but is
not an audience reader — these reads go through the v2 API.

### Why LinkedIn is hand-off only

LinkedIn acts only through the member's own session, and only after the
workspace owner explicitly accepted that risk (`og connect linkedin
--accept-linkedin-risk`). That opt-in covers invitations, visits, follows and
messages. Reading reactions on a post is not one of them, and the repository
rule is that anything new on LinkedIn goes through the same gate or stays a
hand-off. It stays a hand-off: create the watch with `mode: handoff` and post
what you saw.

## Using it

```sh
# Bluesky: works immediately, no credentials.
og audience watch bluesky:you.bsky.social --campaign cmp_123 --kinds like,repost,reply

# Read it now rather than waiting for the interval.
og audience run awt_...

og audience list
og audience unwatch awt_...
```

Over HTTP:

| Route                               | Does                                                            |
| ----------------------------------- | --------------------------------------------------------------- |
| `GET /api/v1/audience`              | Every watch, the networks, the kinds, the limits.               |
| `POST /api/v1/audience`             | Create or edit a watch (keyed on network + account + campaign). |
| `DELETE /api/v1/audience/:id`       | Stop watching.                                                  |
| `POST /api/v1/audience/:id/run`     | Read it now. Reports a refusal rather than a 500.               |
| `POST /api/v1/audience/engagements` | Hand engagements over for a network we cannot read.             |

Every route is approver-only: a watch decides who the product spends research
on, which is the same kind of decision as approving outreach.

MCP exposes `list_audience_watches` and `watch_audience`.

## Turning engagement into outreach

A watch on its own fills a campaign with warm strangers and stops. The step
that makes it a sequence is a rule:

```json
{
  "trigger": "signal_received",
  "condition": { "signalType": "audience_engagement", "minRelevance": 0.6 },
  "action": "enroll_cadence",
  "actionConfig": { "cadenceId": "cad_..." }
}
```

`minRelevance` is how you say "repliers and reposters, not every passing
follower", because relevance is set by how much effort the act took:

| Kind    | Relevance |
| ------- | --------- |
| follow  | 0.35      |
| like    | 0.45      |
| repost  | 0.65      |
| reply   | 0.80      |
| mention | 0.80      |

## Tuning a watch

| Knob            | Default | Meaning                                                       |
| --------------- | ------- | ------------------------------------------------------------- |
| `pollMinutes`   | 30      | How often to read. 5 at the fastest.                          |
| `lookbackPosts` | 10      | How many recent posts to read engagement on. 50 at the most.  |
| `perRunCap`     | 100     | Most engagements one run may open as people. 500 at the most. |

`perRunCap` is the one that matters when a post goes wide: without it a single
popular post would put a thousand strangers into a campaign in one tick.
