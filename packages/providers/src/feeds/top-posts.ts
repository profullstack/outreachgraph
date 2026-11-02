/**
 * Top posts: what got attention in a niche, read from public feeds with the
 * engagement each post earned.
 *
 * The listening sources answer "who is asking for this right now" and so read
 * the newest posts. The Content Radar asks a different question, "what is
 * working in this niche", and that needs the opposite order: the best
 * performing posts of the last weeks, each with its likes, reposts and
 * comments, so a founder can study the hook and borrow the structure.
 *
 * Every source here is keyless and answers servers:
 *
 *   hackernews  Algolia `search` (relevance), stories with points over a floor.
 *   bluesky     the AppView's `searchPosts?sort=top` (api.bsky.app; the public
 *               host 403s anonymous search) and `getAuthorFeed` for follows.
 *   devto       `/api/articles?tag=<t>&top=<days>`: dev.to ranks them itself.
 *   mastodon    an instance's public tag timeline, ranked here by favourites.
 *   reddit      the Arctic Shift archive. It records a score when it ingests a
 *               post and refreshes it about a day and a half later, so the
 *               newest two days all read "1". The window ends two days ago.
 *
 * TikTok, Instagram and X need a login to read, so they are not sources.
 */

import type { FetchLike } from '../site/fetch';
import { stripHtml } from './hackernews';
import { excerpt, FeedRateLimitError, mentionsTerm } from './source';

export const TOP_POST_SOURCES = ['hackernews', 'bluesky', 'devto', 'mastodon', 'reddit'] as const;
export type TopPostSource = (typeof TOP_POST_SOURCES)[number];

/** Networks an account can be followed on, keyless. */
export const FOLLOW_NETWORKS = ['bluesky', 'mastodon', 'hackernews', 'reddit', 'devto'] as const;
export type FollowNetwork = (typeof FOLLOW_NETWORKS)[number];

export function isTopPostSource(value: string): value is TopPostSource {
  return (TOP_POST_SOURCES as readonly string[]).includes(value);
}

export function isFollowNetwork(value: string): value is FollowNetwork {
  return (FOLLOW_NETWORKS as readonly string[]).includes(value);
}

export interface TopPost {
  readonly source: TopPostSource;
  readonly externalId: string;
  readonly url: string;
  readonly authorHandle?: string;
  readonly authorName?: string;
  readonly title?: string;
  readonly text: string;
  readonly postedAt: string;
  /** Subreddit, tag, "HN story". */
  readonly container?: string;
  readonly likes: number;
  readonly reposts: number;
  readonly comments: number;
  /** The term, subreddit, tag or handle that found it. */
  readonly matched?: string;
}

export interface TopPostQuery {
  readonly terms: readonly string[];
  readonly subreddits?: readonly string[];
  readonly tags?: readonly string[];
  /** Ignore anything older. Defaults to 30 days. */
  readonly since?: Date;
  /** Posts kept per source. */
  readonly limit?: number;
}

/**
 * One number to rank by within a source. A repost carries a post to a new
 * audience and a comment means it started a conversation, so both count for
 * more than a like.
 */
export function engagementScore(post: Pick<TopPost, 'likes' | 'reposts' | 'comments'>): number {
  return Math.round(post.likes + post.reposts * 2 + post.comments * 1.5);
}

/** `Building in public` → `buildinginpublic`, the way hashtags are written. */
export function tagFor(term: string): string {
  return term
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[^a-z0-9]/g, '');
}

export interface TopPostReaderOptions {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** Least time between two requests to the same host. */
  readonly gapMs?: number;
  readonly hnBase?: string;
  readonly blueskyBase?: string;
  readonly devtoBase?: string;
  readonly mastodonBase?: string;
  readonly archiveBase?: string;
  /** Archive pages (100 posts each) read per subreddit. */
  readonly archivePages?: number;
}

const DAY_MS = 86_400_000;
/** The archive's scores are refreshed about 36 h after a post; newer ones all read 1. */
const ARCHIVE_SETTLE_MS = 2 * DAY_MS;

export class TopPostReader {
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #gapMs: number;
  readonly #hn: string;
  readonly #bsky: string;
  readonly #devto: string;
  readonly #mastodon: string;
  readonly #archive: string;
  readonly #archivePages: number;
  readonly #last = new Map<string, number>();

  constructor(options: TopPostReaderOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#gapMs = options.gapMs ?? 1_000;
    this.#hn = (options.hnBase ?? 'https://hn.algolia.com/api/v1').replace(/\/$/, '');
    this.#bsky = (options.blueskyBase ?? 'https://api.bsky.app').replace(/\/$/, '');
    this.#devto = (options.devtoBase ?? 'https://dev.to/api').replace(/\/$/, '');
    this.#mastodon = (options.mastodonBase ?? 'https://mastodon.social').replace(/\/$/, '');
    this.#archive = (options.archiveBase ?? 'https://arctic-shift.photon-reddit.com').replace(
      /\/$/,
      '',
    );
    this.#archivePages = Math.max(1, Math.min(options.archivePages ?? 3, 10));
  }

  /** The best posts from one source, highest engagement first. */
  async top(source: TopPostSource, query: TopPostQuery): Promise<TopPost[]> {
    const since = query.since ?? new Date(Date.now() - 30 * DAY_MS);
    const limit = Math.max(1, Math.min(query.limit ?? 20, 100));
    const terms = unique(query.terms).slice(0, 8);
    let posts: TopPost[];
    switch (source) {
      case 'hackernews':
        posts = await this.#hackernews(terms, since);
        break;
      case 'bluesky':
        posts = await this.#bluesky(terms, since);
        break;
      case 'devto':
        posts = await this.#devtoTop(unique([...(query.tags ?? []), ...terms.map(tagFor)]), since);
        break;
      case 'mastodon':
        posts = await this.#mastodonTags(
          unique([...(query.tags ?? []), ...terms.map(tagFor)]),
          since,
        );
        break;
      case 'reddit':
        posts = await this.#reddit(unique(query.subreddits ?? []), terms, since);
        break;
    }
    return rank(posts, limit);
  }

  /** An account's recent posts, highest engagement first. */
  async follow(
    network: FollowNetwork,
    handle: string,
    since = new Date(Date.now() - 30 * DAY_MS),
  ): Promise<TopPost[]> {
    const clean = handle.trim().replace(/^@/, '');
    if (!clean) return [];
    let posts: TopPost[];
    switch (network) {
      case 'bluesky':
        posts = await this.#blueskyAuthor(clean, since);
        break;
      case 'hackernews':
        posts = await this.#hnAuthor(clean, since);
        break;
      case 'reddit':
        posts = await this.#redditAuthor(clean.replace(/^\/?u\//i, ''), since);
        break;
      case 'devto':
        posts = await this.#devtoAuthor(clean, since);
        break;
      case 'mastodon':
        posts = await this.#mastodonAuthor(clean, since);
        break;
    }
    return rank(
      posts.map((post) => ({ ...post, matched: `@${clean}` })),
      40,
    );
  }

  /* ----------------------------------------------------------- sources */

  async #hackernews(terms: readonly string[], since: Date): Promise<TopPost[]> {
    const out: TopPost[] = [];
    for (const term of terms) {
      const params = new URLSearchParams({
        query: `"${term.replace(/"/g, '')}"`,
        tags: 'story',
        hitsPerPage: '30',
        numericFilters: `created_at_i>${Math.floor(since.getTime() / 1000)},points>2`,
      });
      const body = await this.#json<{ hits?: AlgoliaHit[] }>(
        'hackernews',
        `${this.#hn}/search?${params.toString()}`,
      );
      for (const hit of body?.hits ?? []) {
        const post = hnPost(hit, term);
        if (post && mentionsTerm(`${post.title ?? ''}\n${post.text}`, [term])) out.push(post);
      }
    }
    return out;
  }

  async #hnAuthor(handle: string, since: Date): Promise<TopPost[]> {
    const params = new URLSearchParams({
      tags: `story,author_${handle}`,
      hitsPerPage: '50',
      numericFilters: `created_at_i>${Math.floor(since.getTime() / 1000)}`,
    });
    const body = await this.#json<{ hits?: AlgoliaHit[] }>(
      'hackernews',
      `${this.#hn}/search_by_date?${params.toString()}`,
    );
    return (body?.hits ?? []).flatMap((hit) => {
      const post = hnPost(hit);
      return post ? [post] : [];
    });
  }

  async #bluesky(terms: readonly string[], since: Date): Promise<TopPost[]> {
    const out: TopPost[] = [];
    for (const term of terms) {
      const params = new URLSearchParams({
        q: term,
        sort: 'top',
        limit: '50',
        since: since.toISOString(),
      });
      const body = await this.#json<{ posts?: BskyPost[] }>(
        'bluesky',
        `${this.#bsky}/xrpc/app.bsky.feed.searchPosts?${params.toString()}`,
      );
      for (const raw of body?.posts ?? []) {
        const post = bskyPost(raw, term);
        if (post && Date.parse(post.postedAt) >= since.getTime() && mentionsTerm(post.text, [term]))
          out.push(post);
      }
    }
    return out;
  }

  async #blueskyAuthor(handle: string, since: Date): Promise<TopPost[]> {
    const params = new URLSearchParams({
      actor: handle,
      limit: '50',
      filter: 'posts_no_replies',
    });
    const body = await this.#json<{ feed?: { post?: BskyPost; reason?: unknown }[] }>(
      'bluesky',
      `${this.#bsky}/xrpc/app.bsky.feed.getAuthorFeed?${params.toString()}`,
    );
    return (body?.feed ?? []).flatMap((item) => {
      // A repost of someone else is in the feed but is not this account's post.
      if (item.reason || !item.post) return [];
      const post = bskyPost(item.post);
      return post && Date.parse(post.postedAt) >= since.getTime() ? [post] : [];
    });
  }

  async #devtoTop(tags: readonly string[], since: Date): Promise<TopPost[]> {
    const days = Math.max(1, Math.ceil((Date.now() - since.getTime()) / DAY_MS));
    const out: TopPost[] = [];
    for (const tag of tags.filter(Boolean).slice(0, 6)) {
      const body = await this.#json<DevToArticle[]>(
        'devto',
        `${this.#devto}/articles?tag=${encodeURIComponent(tag)}&top=${days}&per_page=30`,
      );
      for (const article of Array.isArray(body) ? body : []) {
        const post = devtoPost(article, `#${tag}`);
        if (post) out.push(post);
      }
    }
    return out;
  }

  async #devtoAuthor(username: string, since: Date): Promise<TopPost[]> {
    const body = await this.#json<DevToArticle[]>(
      'devto',
      `${this.#devto}/articles?username=${encodeURIComponent(username)}&per_page=30`,
    );
    return (Array.isArray(body) ? body : []).flatMap((article) => {
      const post = devtoPost(article);
      return post && Date.parse(post.postedAt) >= since.getTime() ? [post] : [];
    });
  }

  async #mastodonTags(tags: readonly string[], since: Date): Promise<TopPost[]> {
    const out: TopPost[] = [];
    for (const tag of tags.filter(Boolean).slice(0, 6)) {
      const body = await this.#json<MastodonStatus[]>(
        'mastodon',
        `${this.#mastodon}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=40`,
      );
      for (const status of Array.isArray(body) ? body : []) {
        const post = mastodonPost(status, `#${tag}`);
        if (post && Date.parse(post.postedAt) >= since.getTime()) out.push(post);
      }
    }
    // A tag timeline is chronological; a post nobody touched teaches nothing.
    return out.filter((post) => engagementScore(post) > 0);
  }

  async #mastodonAuthor(handle: string, since: Date): Promise<TopPost[]> {
    // `user@instance` reads from that instance; a bare name from the default one.
    const [user, host] = handle.split('@');
    const base = host ? `https://${host}` : this.#mastodon;
    const account = await this.#json<{ id?: string }>(
      'mastodon',
      `${base}/api/v1/accounts/lookup?acct=${encodeURIComponent(user ?? handle)}`,
    );
    if (!account?.id) return [];
    const body = await this.#json<MastodonStatus[]>(
      'mastodon',
      `${base}/api/v1/accounts/${encodeURIComponent(account.id)}/statuses?limit=40&exclude_replies=true&exclude_reblogs=true`,
    );
    return (Array.isArray(body) ? body : []).flatMap((status) => {
      const post = mastodonPost(status);
      return post && Date.parse(post.postedAt) >= since.getTime() ? [post] : [];
    });
  }

  async #reddit(
    subreddits: readonly string[],
    terms: readonly string[],
    since: Date,
  ): Promise<TopPost[]> {
    const before = Math.floor((Date.now() - ARCHIVE_SETTLE_MS) / 1000);
    const after = Math.floor(since.getTime() / 1000);
    if (before <= after) return [];
    const out: TopPost[] = [];
    for (const raw of subreddits.slice(0, 6)) {
      const subreddit = raw.replace(/^\/?r\//i, '');
      const posts = await this.#archivePosts({ subreddit }, after, before);
      for (const post of posts) {
        // A subreddit is already the audience: its best posts count whatever
        // they say. Terms only narrow a big general subreddit when they match.
        out.push({ ...post, matched: `r/${subreddit}` });
      }
    }
    if (terms.length === 0) return out;
    const matching = out.filter((post) => mentionsTerm(`${post.title ?? ''}\n${post.text}`, terms));
    return matching.length >= 5 ? matching : out;
  }

  async #redditAuthor(author: string, since: Date): Promise<TopPost[]> {
    return this.#archivePosts(
      { author },
      Math.floor(since.getTime() / 1000),
      Math.floor(Date.now() / 1000),
    );
  }

  async #archivePosts(
    filter: { subreddit?: string; author?: string },
    after: number,
    before: number,
  ): Promise<TopPost[]> {
    const all: ArchivePost[] = [];
    let cursor = before;
    for (let page = 0; page < this.#archivePages; page += 1) {
      const params = new URLSearchParams({
        ...filter,
        limit: '100',
        sort: 'desc',
        after: String(after),
        before: String(cursor),
      });
      const body = await this.#json<{ data?: ArchivePost[] }>(
        'reddit',
        `${this.#archive}/api/posts/search?${params.toString()}`,
        Math.max(this.#timeoutMs, 30_000),
      );
      const data = body?.data ?? [];
      all.push(...data);
      const oldest = data.at(-1)?.created_utc;
      if (data.length < 100 || oldest === undefined || oldest >= cursor) break;
      cursor = oldest;
    }
    return all.flatMap((post) => {
      if (!post.id || post.over_18 || post.stickied) return [];
      if (!post.author || post.author === '[deleted]' || post.author === 'AutoModerator') return [];
      const selftext =
        post.selftext === '[removed]' || post.selftext === '[deleted]' ? '' : post.selftext;
      const text = [post.title, selftext].filter(Boolean).join('\n\n').trim();
      if (!text) return [];
      return [
        {
          source: 'reddit' as const,
          externalId: post.id,
          url: post.permalink
            ? `https://www.reddit.com${post.permalink}`
            : `https://www.reddit.com/comments/${post.id}/`,
          authorHandle: post.author,
          ...(post.title ? { title: post.title } : {}),
          text: excerpt(text, 900),
          postedAt: new Date((post.created_utc ?? 0) * 1000).toISOString(),
          ...(post.subreddit ? { container: `r/${post.subreddit}` } : {}),
          likes: Math.max(0, Number(post.score ?? 0)),
          reposts: 0,
          comments: Math.max(0, Number(post.num_comments ?? 0)),
        },
      ];
    });
  }

  /* ------------------------------------------------------------ fetch */

  async #json<T>(host: string, url: string, timeoutMs = this.#timeoutMs): Promise<T | undefined> {
    const wait = (this.#last.get(host) ?? 0) + this.#gapMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.#last.set(host, Date.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.#fetch(url, {
        headers: {
          accept: 'application/json',
          // dev.to 403s an agent without a product/version token.
          'user-agent': 'OutreachGraph/1.0 (content radar; +https://outreachgraph.com)',
        },
        signal: controller.signal,
      });
      if (response.status === 429) throw new FeedRateLimitError(host);
      if (!response.ok) return undefined;
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ---------------------------------------------------------------- shapes */

interface AlgoliaHit {
  objectID?: string;
  author?: string;
  title?: string | null;
  story_text?: string | null;
  url?: string | null;
  points?: number | null;
  num_comments?: number | null;
  created_at_i?: number;
}

interface BskyPost {
  uri?: string;
  author?: { handle?: string; displayName?: string };
  record?: { text?: string; createdAt?: string };
  indexedAt?: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
}

interface DevToArticle {
  id?: number;
  title?: string;
  description?: string;
  url?: string;
  published_at?: string;
  positive_reactions_count?: number;
  public_reactions_count?: number;
  comments_count?: number;
  user?: { username?: string; name?: string };
}

interface MastodonStatus {
  id?: string;
  url?: string | null;
  uri?: string;
  content?: string;
  created_at?: string;
  favourites_count?: number;
  reblogs_count?: number;
  replies_count?: number;
  account?: { acct?: string; display_name?: string; url?: string };
}

interface ArchivePost {
  id?: string;
  author?: string;
  title?: string;
  selftext?: string;
  permalink?: string;
  subreddit?: string;
  created_utc?: number;
  score?: number;
  num_comments?: number;
  over_18?: boolean;
  stickied?: boolean;
}

function hnPost(hit: AlgoliaHit, matched?: string): TopPost | undefined {
  if (!hit.objectID || !hit.title) return undefined;
  const body = stripHtml(hit.story_text ?? '');
  return {
    source: 'hackernews',
    externalId: hit.objectID,
    url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    ...(hit.author ? { authorHandle: hit.author } : {}),
    title: hit.title,
    text: excerpt([hit.title, body, hit.url ?? ''].filter(Boolean).join('\n\n'), 900),
    postedAt: new Date((hit.created_at_i ?? 0) * 1000).toISOString(),
    container: hit.title.startsWith('Show HN') ? 'Show HN' : 'HN story',
    likes: Math.max(0, Number(hit.points ?? 0)),
    reposts: 0,
    comments: Math.max(0, Number(hit.num_comments ?? 0)),
    ...(matched ? { matched } : {}),
  };
}

function bskyPost(raw: BskyPost, matched?: string): TopPost | undefined {
  const text = raw.record?.text?.trim();
  const handle = raw.author?.handle;
  if (!raw.uri || !text || !handle) return undefined;
  const rkey = raw.uri.split('/').pop();
  return {
    source: 'bluesky',
    externalId: raw.uri,
    url: rkey
      ? `https://bsky.app/profile/${handle}/post/${rkey}`
      : `https://bsky.app/profile/${handle}`,
    authorHandle: handle,
    ...(raw.author?.displayName?.trim() ? { authorName: raw.author.displayName.trim() } : {}),
    text: excerpt(text, 900),
    postedAt: raw.record?.createdAt ?? raw.indexedAt ?? new Date().toISOString(),
    likes: Math.max(0, Number(raw.likeCount ?? 0)),
    reposts: Math.max(0, Number(raw.repostCount ?? 0) + Number(raw.quoteCount ?? 0)),
    comments: Math.max(0, Number(raw.replyCount ?? 0)),
    ...(matched ? { matched } : {}),
  };
}

function devtoPost(article: DevToArticle, matched?: string): TopPost | undefined {
  if (!article.id || !article.url || !article.title) return undefined;
  return {
    source: 'devto',
    externalId: `devto:${article.id}`,
    url: article.url,
    ...(article.user?.username ? { authorHandle: article.user.username } : {}),
    ...(article.user?.name ? { authorName: article.user.name } : {}),
    title: article.title,
    text: excerpt([article.title, article.description].filter(Boolean).join('\n\n'), 900),
    postedAt: article.published_at ?? new Date().toISOString(),
    container: 'dev.to',
    likes: Math.max(
      0,
      Number(article.public_reactions_count ?? article.positive_reactions_count ?? 0),
    ),
    reposts: 0,
    comments: Math.max(0, Number(article.comments_count ?? 0)),
    ...(matched ? { matched } : {}),
  };
}

function mastodonPost(status: MastodonStatus, matched?: string): TopPost | undefined {
  const text = stripHtml((status.content ?? '').replace(/<br\s*\/?>/gi, '\n'));
  const url = status.url ?? status.uri;
  if (!status.id || !text || !url) return undefined;
  return {
    source: 'mastodon',
    externalId: url,
    url,
    ...(status.account?.acct ? { authorHandle: status.account.acct } : {}),
    ...(status.account?.display_name ? { authorName: status.account.display_name } : {}),
    text: excerpt(text, 900),
    postedAt: status.created_at ?? new Date().toISOString(),
    likes: Math.max(0, Number(status.favourites_count ?? 0)),
    reposts: Math.max(0, Number(status.reblogs_count ?? 0)),
    comments: Math.max(0, Number(status.replies_count ?? 0)),
    ...(matched ? { matched } : {}),
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function rank(posts: readonly TopPost[], limit: number): TopPost[] {
  const seen = new Set<string>();
  return [...posts]
    .sort((a, b) => engagementScore(b) - engagementScore(a))
    .filter((post) => {
      if (seen.has(post.externalId)) return false;
      seen.add(post.externalId);
      return true;
    })
    .slice(0, limit);
}
