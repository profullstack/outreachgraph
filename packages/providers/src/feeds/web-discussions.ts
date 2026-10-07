/**
 * Discussion threads anywhere on the web, found through Google (ValueSERP).
 *
 * The Reddit archive can only read subreddits it is given, and the right
 * subreddit for a buyer is often one nobody would think to list: an r/Wazuh
 * user asking about network IDS, an r/jellyfin user asking how to secure a
 * server. Google indexes all of Reddit and the forums (Stack Exchange, Server
 * Fault, Quora, Indie Hackers) within hours, and filters by age.
 *
 * One query per site: ValueSERP ignores `site:a OR site:b`. Terms are OR-ed
 * in quoted groups, so a dozen keywords over five sites is about fifteen
 * searches. Google's snippet is a sentence, so a Reddit hit is filled in from
 * the Arctic Shift archive by post id: full text, author, posting time.
 */

import type { FetchLike } from '../site/fetch';
import { SearchOutOfCredits, type WebResult, type WebSearcher } from '../valueserp';
import {
  excerpt,
  mentionsTerm,
  type FeedPost,
  type FeedSearchInput,
  type FeedSource,
} from './source';
import { REDDIT_ARCHIVE } from './reddit';

export const DEFAULT_DISCUSSION_SITES = [
  'reddit.com',
  'stackexchange.com',
  'serverfault.com',
  'quora.com',
  'indiehackers.com',
] as const;

export interface WebDiscussionSourceOptions {
  readonly searcher: WebSearcher;
  readonly sites?: readonly string[];
  /** Keywords per query. */
  readonly termsPerQuery?: number;
  /** The archive that fills in Reddit hits. `null` keeps Google's snippet. */
  readonly archiveUrl?: string | null;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** Searches in flight at once. */
  readonly concurrency?: number;
}

interface ArchivePost {
  id?: string;
  author?: string;
  title?: string;
  selftext?: string;
  subreddit?: string;
  created_utc?: number;
  over_18?: boolean;
}

/** The Reddit post id in a thread URL, or undefined for anything else. */
export function redditPostId(url: string): string | undefined {
  return /reddit\.com\/r\/[^/]+\/comments\/([a-z0-9]+)/i.exec(url)?.[1]?.toLowerCase();
}

/** Thread pages only: a subreddit front page or a user profile is not a post. */
function isThread(url: string, site: string): boolean {
  if (site === 'reddit.com') return redditPostId(url) !== undefined;
  if (site === 'stackexchange.com' || site === 'serverfault.com')
    return /\/questions\/\d+/.test(url);
  if (site === 'quora.com') return !/quora\.com\/(profile|topic|q)\//i.test(url);
  if (site === 'indiehackers.com') return /\/(post|forum)\//.test(url);
  return true;
}

export function quoteGroups(terms: readonly string[], size: number): string[] {
  const clean = [...new Set(terms.map((t) => t.replace(/"/g, '').trim()).filter(Boolean))];
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += size) {
    groups.push(
      clean
        .slice(i, i + size)
        .map((t) => `"${t}"`)
        .join(' OR '),
    );
  }
  return groups;
}

export class WebDiscussionSource implements FeedSource {
  readonly network = 'website' as const;
  readonly slug = 'web';
  readonly displayName = 'Web (Google)';

  readonly #searcher: WebSearcher;
  readonly #sites: readonly string[];
  readonly #termsPerQuery: number;
  readonly #archiveUrl: string | null;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #concurrency: number;

  constructor(options: WebDiscussionSourceOptions) {
    this.#concurrency = Math.max(1, options.concurrency ?? 4);
    this.#searcher = options.searcher;
    this.#sites = options.sites?.length ? options.sites : DEFAULT_DISCUSSION_SITES;
    this.#termsPerQuery = Math.max(1, options.termsPerQuery ?? 5);
    this.#archiveUrl = options.archiveUrl === undefined ? REDDIT_ARCHIVE : options.archiveUrl;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async search(input: FeedSearchInput): Promise<readonly FeedPost[]> {
    const groups = quoteGroups(input.terms, this.#termsPerQuery);
    if (groups.length === 0) return [];
    const ageMs = input.since ? Date.now() - input.since.getTime() : Infinity;
    const period = ageMs <= 36 * 3_600_000 ? 'last_day' : 'last_week';

    // A query takes 8-60 s, so they run a few at a time. One slow or refused
    // query costs that query, retried once; out of credits stops everything,
    // and the source only fails when no query answered at all.
    const queries = this.#sites.flatMap((site) =>
      groups.map((group) => ({ site, q: `site:${site} (${group})` })),
    );
    const answered: { site: string; results: readonly WebResult[] }[] = [];
    let lastError: unknown;
    let next = 0;
    const worker = async () => {
      while (next < queries.length) {
        const query = queries[next++]!;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const results = await this.#searcher.search(query.q, { num: 30, period });
            answered.push({ site: query.site, results });
            break;
          } catch (error) {
            if (error instanceof SearchOutOfCredits) throw error;
            lastError = error;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#concurrency, queries.length) }, worker));
    if (answered.length === 0 && lastError) throw lastError;

    const hits = new Map<string, { result: WebResult; site: string }>();
    for (const { site, results } of answered) {
      for (const result of results) {
        if (!result.link || !isThread(result.link, site)) continue;
        const key = redditPostId(result.link) ?? result.link.split('#')[0]!;
        if (!hits.has(key)) hits.set(key, { result, site });
      }
    }

    const reddit = await this.#archivePosts(
      [...hits.keys()].filter(
        (key) => /^[a-z0-9]+$/.test(key) && hits.get(key)?.site === 'reddit.com',
      ),
    );

    const posts: FeedPost[] = [];
    for (const [key, { result, site }] of hits) {
      const link = result.link!;
      const archived = reddit.get(key);
      if (archived) {
        if (archived.over_18 || !archived.author || archived.author === '[deleted]') continue;
        const selftext =
          archived.selftext === '[removed]' || archived.selftext === '[deleted]'
            ? ''
            : (archived.selftext ?? '');
        const text = [archived.title, selftext].filter(Boolean).join('\n\n').trim();
        const postedAt = archived.created_utc
          ? new Date(archived.created_utc * 1000).toISOString()
          : new Date().toISOString();
        if (input.since && Date.parse(postedAt) < input.since.getTime()) continue;
        if (!mentionsTerm(text, input.terms)) continue;
        posts.push({
          network: 'reddit',
          externalId: key,
          authorHandle: archived.author,
          authorUrl: `https://www.reddit.com/user/${archived.author}`,
          url: `https://www.reddit.com/r/${archived.subreddit ?? 'all'}/comments/${key}/`,
          ...(archived.title ? { title: archived.title } : {}),
          text: excerpt(text),
          postedAt,
          ...(archived.subreddit ? { container: `r/${archived.subreddit}` } : {}),
        });
        continue;
      }
      const text = [result.title, result.snippet].filter(Boolean).join('\n\n').trim();
      if (!text) continue;
      posts.push({
        network: site === 'reddit.com' ? 'reddit' : 'website',
        externalId: key,
        authorHandle: 'unknown',
        url: link,
        ...(result.title ? { title: result.title } : {}),
        text: excerpt(text),
        // Google's age filter already bounded it; the exact time is unknown.
        postedAt: new Date().toISOString(),
        container: site,
      });
    }
    return posts;
  }

  /** Full posts by id from the archive, a hundred at a time. Failures leave the snippet. */
  async #archivePosts(ids: readonly string[]): Promise<Map<string, ArchivePost>> {
    const found = new Map<string, ArchivePost>();
    if (!this.#archiveUrl || ids.length === 0) return found;
    for (let i = 0; i < ids.length; i += 100) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const response = await this.#fetch(
          `${this.#archiveUrl}/api/posts/ids?ids=${ids.slice(i, i + 100).join(',')}`,
          { headers: { accept: 'application/json' }, signal: controller.signal },
        );
        if (!response.ok) continue;
        const body = (await response.json()) as { data?: ArchivePost[] };
        for (const post of body.data ?? []) if (post.id) found.set(post.id.toLowerCase(), post);
      } catch {
        // The snippet is still a lead; the archive being slow is not a failure.
      } finally {
        clearTimeout(timer);
      }
    }
    return found;
  }
}
