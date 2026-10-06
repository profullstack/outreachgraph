# Idea Generator

Finds things worth building and selling, ranks them, and hands the best to chovy.com to build.

## Method

An idea is worth building when four things hold, and the score measures each:

| Question                           | Evidence                                                                           | Score                        |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------- |
| Do different people want it?       | Distinct people asking for it in the window, plus the attention their posts got    | `askers × 10 + attention`    |
| Will anyone pay?                   | A case study quoting revenue for a product like it; an asker saying they would pay | +15 per source, up to 3      |
| Is it more than one forum's quirk? | It comes up in several places: another subreddit, Ask HN, a newsletter             | +8 per extra source, up to 4 |
| How crowded is it?                 | Recent Show HN launches that match it                                              | 1: +5 · 2-3: −5 · 4+: −20    |

The verdict on each idea: **build** (wanted by 2+ people and someone pays), **validate** (one of the two), **watch** (neither yet), **crowded** (4+ matching launches). Ideas are listed by worth. An idea is still flagged `build` for the hand-off at `build_at` distinct askers.

This follows the indie-maker reading of "worth building" (for example Colin Armstrong's [Worth Building](https://armstr.ng/writing/worth-building), 2026-10-05): building is now cheap, so the scarce input is evidence of a real, specific want. Selling it needs one more piece of evidence, that money changes hands.

## Sources

Subreddits come through RSS Amplifier's mirror and the Arctic Shift archive, since Reddit blocks servers. Feeds come from the RSS Amplifier directory (`/api/feeds/<slug>`). Each feed has one of three roles:

- **asks**: people asking for tools, read like a subreddit. Ask HN, r/bootstrapping.
- **signals**: case studies, idea lists and essays on what sells. Kept when a post names a pain, a product making money, or a product someone should build. Starter Story, Indieniche, Micro SaaS Idea, Startup Acquisition Stories, Sidebean, Avy Faingezicht's "Startups I Didn't Start", mtlynch.io, Silicon Opera, Hypothesis Lab, Ash Maurya, Metaist, Flavio Copes, Venture Curator, Jeff Riggle, Jean Galea.
- **built**: launches. Never counted as demand. Matching launches are the idea's rivals. Show HN.

The defaults were chosen on 2026-10-06 by sweeping the directory for writing about what to build and sell, keeping feeds that were `live`. levels.io is in the directory but failing. armstr.ng has no feed of its own there; it only appears through the HN front-page mirror.

A model judge reads both kinds of candidates: `judgeAsks` for asks and `judgeSignals` for signals. It drops pitches and general advice, and names each product in words that group with the Reddit asks for the same thing. Without a model, the patterns decide.

## Surfaces

- Web: `/ideas`.
- API: `GET /api/v1/ideas`, `GET|PUT /api/v1/ideas/settings` (`subs`, `feeds`), `POST /api/v1/ideas/scan`, `POST /api/v1/ideas/:id/build`.
- CLI: `og ideas list | show <id> | scan [--subs a,b] [--feeds x,y] | subs [...] | feeds [slug asks:slug built:slug] | build <id>`.
- MCP: `list_ideas`, `get_idea`, `scan_ideas`, `set_idea_feeds`, `build_idea`.

## Limits

- Feed text is the directory's summary, about 300-400 characters. The judge sees the title and that summary, not the full post.
- Signals inside the window only (60 days by default). Older essays add nothing per scan.
- Ask HN is mostly discussion. Its few real tool asks arrive slowly.
