/**
 * Listening: finding people by what they said, not by who they work for.
 *
 * Every source of prospects until now started from a company. A keyword named
 * domains, the domains were crawled, the pages named people, and GitHub said
 * what those people had been doing. That works for selling developer tooling
 * to companies with engineering blogs, and it finds nobody at all for a trade
 * supplier whose buyers are a plumber posting in a local subreddit and a shop
 * owner complaining on a forum.
 *
 * A feed source inverts it. It searches a public feed for the language of a
 * problem — "can anyone recommend", "we're looking for", "still doing this by
 * hand" — and returns the posts, with their authors. The person comes from the
 * signal rather than the signal being looked up for a person already known.
 *
 * The interface is deliberately small, because the sources have almost nothing
 * in common underneath: Reddit is JSON over HTTP, RSS is XML pull, Bluesky is
 * an AT Protocol AppView, Nostr is a websocket subscription to relays. What
 * they share is the only thing the pipeline needs — a post, its text, its
 * author and when it happened.
 *
 * Reading is all any of these do. Whether the product may then *reply* is the
 * capability matrix's decision, and it differs sharply per network: a Bluesky
 * reply is permitted, a Reddit DM is not, and LinkedIn is off limits entirely.
 */

import type { Network, SignalType } from '@outreachgraph/domain';

export interface FeedSearchInput {
  /** Phrases to look for. Sources join these as the platform prefers. */
  readonly terms: readonly string[];
  /** Ignore anything older than this. Sources apply it as best they can. */
  readonly since?: Date;
  readonly limit?: number;
}

/** One public post, normalised. Vendor shapes never leave the adapter. */
export interface FeedPost {
  readonly network: Network;
  /** The platform's own id, so the same post is not ingested twice. */
  readonly externalId: string;
  /** The author's handle on this network — `u/name`, a DID, an npub. */
  readonly authorHandle: string;
  readonly authorDisplayName?: string;
  readonly authorUrl?: string;
  /** Where a human can read this post. Shown to the reviewer as evidence. */
  readonly url: string;
  readonly title?: string;
  readonly text: string;
  /** When the platform says it was posted. */
  readonly postedAt: string;
  /** Subreddit, feed title, relay — whatever names the corner it came from. */
  readonly container?: string;
}

export interface FeedSource {
  readonly network: Network;
  /** Stable identifier for logs and per-source configuration. */
  readonly slug: string;
  readonly displayName: string;
  search(input: FeedSearchInput): Promise<readonly FeedPost[]>;
}

/** Raised when a source is rate limited, so a run keeps partial results. */
export class FeedRateLimitError extends Error {
  readonly slug: string;

  constructor(slug: string) {
    super(`${slug} rate limit reached`);
    this.name = 'FeedRateLimitError';
    this.slug = slug;
  }
}

/**
 * What kind of signal a post is, decided by its wording alone.
 *
 * Deterministic on purpose. The model is expensive, rate-limited and
 * occasionally unavailable, and a listening run that produces nothing whenever
 * a provider is capped is a feature that appears broken at random. These
 * patterns are the same ones the high-intent signal types were named after, so
 * the cheap half stands on its own and the model only ever improves on it.
 *
 * Ordered most specific first: "does anyone recommend an alternative to X" is
 * a recommendation request, not merely a question, and reading it as the
 * weaker type would cost it its ranking.
 */
const PATTERNS: readonly { readonly type: SignalType; readonly test: RegExp }[] = [
  {
    type: 'recommendation_request',
    test: /\b(?:any(?:one|body)\s+(?:recommend|know\s+of|use|used)|recommendations?\s+for|suggestions?\s+for|alternatives?\s+to|looking\s+for\s+a|in\s+the\s+market\s+for|what\s+do\s+you\s+(?:use|guys\s+use))\b/i,
  },
  {
    type: 'purchase_intent',
    test: /\b(?:about\s+to\s+buy|ready\s+to\s+buy|budget\s+for|getting\s+quotes?|shopping\s+for|evaluating|trial(?:l)?ing|demo(?:ing)?)\b/i,
  },
  {
    type: 'competitor_mention',
    test: /\b(?:switch(?:ing|ed)?\s+(?:from|off)|migrat(?:e|ing)\s+(?:from|off)|moving\s+(?:away\s+)?from|cancel(?:ling|led)?\s+our)\b/i,
  },
  {
    type: 'public_complaint',
    test: /\b(?:fed\s+up|frustrat(?:ed|ing)|terrible|useless|waste\s+of\s+money|keeps?\s+(?:break|fail)ing|nightmare|hate\s+(?:that|how|using))\b/i,
  },
  {
    type: 'pain',
    test: /\b(?:still\s+doing\s+.{0,30}\bby\s+hand|manual(?:ly)?\s+(?:enter|track|copy)|spreadsheets?\b.{0,40}\b(?:mess|nightmare|pain)|takes?\s+(?:me\s+)?(?:hours|all\s+day)|wast(?:e|ing)\s+(?:hours|time))\b/i,
  },
  {
    type: 'hiring',
    test: /\b(?:we(?:'re| are)\s+hiring|join\s+our\s+team|now\s+hiring|looking\s+to\s+hire)\b/i,
  },
];

export interface Classification {
  readonly type: SignalType;
  /** 0..1 — how sure the wording is what it looks like. */
  readonly confidence: number;
}

/**
 * Classifies a post from its own words.
 *
 * Falls back to `public_question` for anything that asks something, and
 * `content_topic` otherwise — the weakest type, which is right for a post that
 * merely mentions the subject. Neither is a high-intent type, so a run that
 * finds only these ranks them below a real buying signal instead of promoting
 * chatter to the top of somebody's queue.
 */
export function classifyPost(text: string): Classification {
  for (const pattern of PATTERNS) {
    if (pattern.test.test(text)) return { type: pattern.type, confidence: 0.72 };
  }

  if (/\?/.test(text)) return { type: 'public_question', confidence: 0.55 };
  return { type: 'content_topic', confidence: 0.4 };
}

/**
 * True when the post is worth keeping for these terms.
 *
 * Platform search is loose — Reddit matches stemmed words, an RSS feed has no
 * search at all — so a term check runs on the text the source actually
 * returned. Without it a campaign for "payment reconciliation" collects every
 * post containing "payment".
 */
export function mentionsTerm(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = text.toLowerCase();
  return terms.some((term) => {
    const needle = term.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

/** Trims a post down to something a reviewer will actually read. */
export function excerpt(text: string, max = 600): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
