/**
 * Reddit as a listening source.
 *
 * The best non-technical coverage available without a commercial agreement.
 * The people a trade supplier, an accountant or a local services business want
 * to reach are not writing engineering blogs, and they are not on GitHub —
 * they are in r/smallbusiness, r/plumbing, r/restaurateurs and a hundred local
 * subreddits, posting the exact sentence this product exists to notice: "can
 * anyone recommend a decent…".
 *
 * Read-only, and it must stay that way here. The capability matrix disables
 * `reddit/send_dm` as a product decision, and it is right to: unsolicited DMs
 * are what Reddit's own rules call spam, and the fastest way to have a sending
 * identity banned. What Reddit is good for is finding the person and the
 * problem. Contact happens where contact is welcome — usually their business
 * email, which is why the mailbox work matters more than another DM channel.
 *
 * Two operational notes that are easy to get wrong:
 *
 *   - **The User-Agent is load-bearing.** Reddit blocks generic and absent
 *     agents outright, and the failure is a 429 that looks like a rate limit
 *     rather than a rejection. A descriptive agent is the difference between
 *     working and appearing to be throttled forever.
 *   - **`.json` on a public listing needs no credentials**, but it is metered
 *     per client. For anything beyond a light poll, register an OAuth app and
 *     pass a token — the request shape here is unchanged, so that is a header,
 *     not a rewrite.
 */

import type { FetchLike } from '../site/fetch';
import {
  excerpt,
  mentionsTerm,
  FeedRateLimitError,
  type FeedPost,
  type FeedSearchInput,
  type FeedSource,
} from './source';

export const REDDIT_API = 'https://www.reddit.com';

export interface RedditSourceOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /**
   * Restricts the search to specific subreddits.
   *
   * The single highest-leverage setting for a non-technical campaign: an
   * unscoped search of all of Reddit for "invoicing" returns mostly noise,
   * while the same terms inside three trade subreddits return the actual
   * buyers. Empty means site-wide.
   */
  readonly subreddits?: readonly string[];
  /** Sent verbatim. Reddit blocks generic agents. */
  readonly userAgent?: string;
  /** OAuth bearer token, for deployments that registered an app. */
  readonly accessToken?: string;
}

interface RedditListing {
  data?: {
    children?: {
      kind?: string;
      data?: {
        id?: string;
        name?: string;
        author?: string;
        title?: string;
        selftext?: string;
        body?: string;
        permalink?: string;
        url?: string;
        subreddit?: string;
        created_utc?: number;
        over_18?: boolean;
        stickied?: boolean;
      };
    }[];
  };
}

const DEFAULT_AGENT = 'outreachgraph/0.1 (listening; +https://outreachgraph.com)';

export class RedditSource implements FeedSource {
  readonly network = 'reddit' as const;
  readonly slug = 'reddit';
  readonly displayName = 'Reddit';

  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #subreddits: readonly string[];
  readonly #userAgent: string;
  readonly #accessToken: string | undefined;

  constructor(options: RedditSourceOptions = {}) {
    this.#baseUrl = options.baseUrl ?? REDDIT_API;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#subreddits = options.subreddits ?? [];
    this.#userAgent = options.userAgent ?? DEFAULT_AGENT;
    this.#accessToken = options.accessToken;
  }

  async search(input: FeedSearchInput): Promise<readonly FeedPost[]> {
    const terms = input.terms.filter((t) => t.trim().length > 0);
    if (terms.length === 0) return [];

    const limit = Math.min(input.limit ?? 25, 100);
    const query = buildQuery(terms);

    // One request per subreddit rather than an OR across them: Reddit's
    // `subreddit:` operator is unreliable on the public search endpoint, and a
    // per-subreddit listing is also what keeps one busy community from
    // crowding out the rest of the results.
    const targets = this.#subreddits.length > 0 ? this.#subreddits : [undefined];
    const posts: FeedPost[] = [];
    const seen = new Set<string>();

    for (const subreddit of targets) {
      const listing = await this.#fetchListing(query, subreddit, limit, input.since);

      for (const child of listing.data?.children ?? []) {
        const data = child.data;
        if (!data?.id || !data.author) continue;

        // Deleted authors and removed posts keep their row but lose their
        // content; a prospect called `[deleted]` is not a prospect.
        if (data.author === '[deleted]' || data.author === 'AutoModerator') continue;
        if (data.over_18 || data.stickied) continue;

        const text = [data.title, data.selftext ?? data.body].filter(Boolean).join('\n\n').trim();
        if (!text) continue;
        if (!mentionsTerm(text, terms)) continue;

        const postedAt = data.created_utc
          ? new Date(data.created_utc * 1000).toISOString()
          : new Date().toISOString();

        if (input.since && Date.parse(postedAt) < input.since.getTime()) continue;
        if (seen.has(data.id)) continue;
        seen.add(data.id);

        posts.push({
          network: 'reddit',
          externalId: data.id,
          authorHandle: data.author,
          authorUrl: `https://www.reddit.com/user/${data.author}`,
          url: data.permalink ? `https://www.reddit.com${data.permalink}` : (data.url ?? ''),
          ...(data.title ? { title: data.title } : {}),
          text: excerpt(text),
          postedAt,
          ...(data.subreddit ? { container: `r/${data.subreddit}` } : {}),
        });
      }
    }

    return posts;
  }

  async #fetchListing(
    query: string,
    subreddit: string | undefined,
    limit: number,
    since: Date | undefined,
  ): Promise<RedditListing> {
    const path = subreddit ? `/r/${encodeURIComponent(subreddit)}/search.json` : '/search.json';

    const params = new URLSearchParams({
      q: query,
      sort: 'new',
      limit: String(limit),
      // Reddit's coarse windows. Anything narrower is filtered by timestamp
      // after the fact, because the API offers no finer control.
      t: windowFor(since),
      type: 'link',
      raw_json: '1',
    });

    if (subreddit) params.set('restrict_sr', 'on');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}?${params.toString()}`, {
        headers: {
          'user-agent': this.#userAgent,
          accept: 'application/json',
          ...(this.#accessToken ? { authorization: `Bearer ${this.#accessToken}` } : {}),
        },
        signal: controller.signal,
      });

      if (response.status === 429) throw new FeedRateLimitError('reddit');
      if (!response.ok) return {};

      return (await response.json()) as RedditListing;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Builds the query Reddit actually understands.
 *
 * Terms are OR-ed and quoted. Quoting matters: unquoted multi-word terms are
 * treated as separate words, so "field service software" silently becomes any
 * post containing "software".
 */
function buildQuery(terms: readonly string[]): string {
  return terms.map((term) => `"${term.replace(/"/g, '')}"`).join(' OR ');
}

/** Reddit's `t` parameter only has these steps. */
function windowFor(since: Date | undefined): string {
  if (!since) return 'month';

  const days = (Date.now() - since.getTime()) / 86_400_000;
  if (days <= 1) return 'day';
  if (days <= 7) return 'week';
  if (days <= 31) return 'month';
  if (days <= 366) return 'year';
  return 'all';
}
