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
 *
 * **Reddit blocks datacenter addresses outright**, with a 403 that the direct
 * path used to read as "no posts", so a server with no token heard nothing at
 * all. Subreddit listening therefore reads RSS Amplifier's mirror of each
 * subreddit (`rssamplifier.com/r/<sub>.json`, filled by its own crawler) and,
 * for a subreddit it has not read yet, the Arctic Shift archive's newest
 * posts. Both answer servers anonymously. The terms are matched here, against
 * the newest posts, which is what `sort=new` search did anyway. Reddit itself
 * is still used for a site-wide search, and whenever an OAuth token is set.
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
/** RSS Amplifier's subreddit mirrors: `/r/<sub>.json`. */
export const REDDIT_MIRROR = 'https://rssamplifier.com';
/** The Arctic Shift archive, for subreddits the mirror has not read yet. */
export const REDDIT_ARCHIVE = 'https://arctic-shift.photon-reddit.com';

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
  /**
   * Where subreddit listings are read from when there is no token. `null`
   * goes to Reddit directly, which only works from an address Reddit allows.
   */
  readonly mirrorUrl?: string | null;
  /** The archive that stands in for a subreddit the mirror has not read. `null` turns it off. */
  readonly archiveUrl?: string | null;
  /** Least time between two archive requests; it answers 422 to anything faster. */
  readonly archiveGapMs?: number;
}

interface MirrorFeed {
  items?: {
    id?: string;
    title?: string;
    url?: string;
    summary?: string;
    content_text?: string;
    date_published?: string;
    authors?: { name?: string }[];
  }[];
}

interface ArchivePost {
  id?: string;
  author?: string;
  title?: string;
  selftext?: string;
  permalink?: string;
  subreddit?: string;
  created_utc?: number;
  over_18?: boolean;
  stickied?: boolean;
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
  readonly #mirrorUrl: string | null;
  readonly #archiveUrl: string | null;
  readonly #archiveGapMs: number;
  #archiveLast = 0;

  constructor(options: RedditSourceOptions = {}) {
    this.#mirrorUrl = options.mirrorUrl === undefined ? REDDIT_MIRROR : options.mirrorUrl;
    this.#archiveUrl = options.archiveUrl === undefined ? REDDIT_ARCHIVE : options.archiveUrl;
    this.#archiveGapMs = options.archiveGapMs ?? 2_000;
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

    if (this.#subreddits.length > 0 && !this.#accessToken && this.#mirrorUrl) {
      return this.#searchMirrored(terms, limit, input.since);
    }

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

  /**
   * The newest posts of each subreddit, from the mirror or the archive, kept
   * when they mention a term. One subreddit failing costs that subreddit,
   * not the run.
   */
  async #searchMirrored(
    terms: readonly string[],
    limit: number,
    since: Date | undefined,
  ): Promise<readonly FeedPost[]> {
    const posts: FeedPost[] = [];
    const seen = new Set<string>();

    for (const subreddit of this.#subreddits) {
      let found: FeedPost[] = [];
      try {
        found = await this.#fromMirror(subreddit);
        if (found.length === 0 && this.#archiveUrl)
          found = await this.#fromArchive(subreddit, since);
      } catch {
        continue;
      }

      let kept = 0;
      for (const post of found) {
        if (kept >= limit) break;
        if (seen.has(post.externalId)) continue;
        if (
          post.authorHandle === '[deleted]' ||
          post.authorHandle === 'AutoModerator' ||
          !post.authorHandle
        )
          continue;
        if (since && Date.parse(post.postedAt) < since.getTime()) continue;
        if (!mentionsTerm(`${post.title ?? ''}\n${post.text}`, terms)) continue;
        seen.add(post.externalId);
        posts.push(post);
        kept += 1;
      }
    }

    return posts;
  }

  async #getJson<T>(
    url: string,
    timeoutMs = this.#timeoutMs,
  ): Promise<{ status: number; body?: T }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.#fetch(url, {
        headers: { 'user-agent': this.#userAgent, accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) return { status: response.status };
      return { status: response.status, body: (await response.json()) as T };
    } finally {
      clearTimeout(timer);
    }
  }

  async #fromMirror(subreddit: string): Promise<FeedPost[]> {
    const { body } = await this.#getJson<MirrorFeed>(
      `${this.#mirrorUrl}/r/${encodeURIComponent(subreddit)}.json?limit=100`,
    );
    return (body?.items ?? []).flatMap((item) => {
      const id = (item.id ?? '').replace(/^t3_/, '');
      const author = (item.authors?.[0]?.name ?? '').replace(/^\/?u\//, '');
      const text = [item.title, item.content_text ?? item.summary]
        .filter(Boolean)
        .join('\n\n')
        .trim();
      if (!id || !text) return [];
      return [
        {
          network: 'reddit' as const,
          externalId: id,
          authorHandle: author,
          authorUrl: `https://www.reddit.com/user/${author}`,
          url: item.url ?? `https://www.reddit.com/r/${subreddit}/comments/${id}/`,
          ...(item.title ? { title: item.title } : {}),
          text: excerpt(text),
          postedAt: item.date_published ?? new Date().toISOString(),
          container: `r/${/\/r\/([^/]+)\//.exec(item.url ?? '')?.[1] ?? subreddit}`,
        },
      ];
    });
  }

  async #fromArchive(subreddit: string, since: Date | undefined): Promise<FeedPost[]> {
    const wait = this.#archiveLast + this.#archiveGapMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.#archiveLast = Date.now();

    const params = new URLSearchParams({ subreddit, limit: '100', sort: 'desc' });
    if (since) params.set('after', String(Math.floor(since.getTime() / 1000)));
    const { status, body } = await this.#getJson<{ data?: ArchivePost[] }>(
      `${this.#archiveUrl}/api/posts/search?${params.toString()}`,
      // A hundred full posts is a third of a megabyte from a free service.
      Math.max(this.#timeoutMs, 30_000),
    );
    if (status === 429) throw new FeedRateLimitError('reddit');

    return (body?.data ?? []).flatMap((post) => {
      if (!post.id || !post.author || post.over_18 || post.stickied) return [];
      const selftext =
        post.selftext === '[removed]' || post.selftext === '[deleted]' ? '' : post.selftext;
      const text = [post.title, selftext].filter(Boolean).join('\n\n').trim();
      if (!text) return [];
      return [
        {
          network: 'reddit' as const,
          externalId: post.id,
          authorHandle: post.author,
          authorUrl: `https://www.reddit.com/user/${post.author}`,
          url: post.permalink
            ? `https://www.reddit.com${post.permalink}`
            : `https://www.reddit.com/r/${subreddit}/comments/${post.id}/`,
          ...(post.title ? { title: post.title } : {}),
          text: excerpt(text),
          postedAt: post.created_utc
            ? new Date(post.created_utc * 1000).toISOString()
            : new Date().toISOString(),
          container: `r/${post.subreddit ?? subreddit}`,
        },
      ];
    });
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
