/**
 * Hacker News as a listening source, through Algolia's public search.
 *
 * HN is where developers and founders ask "what do you use for X" in a comment
 * thread, and Algolia indexes every story and comment within a minute or two.
 * The API is keyless and answers servers, unlike Reddit.
 *
 * One request per term: Algolia treats a multi-word query as an AND of words,
 * so terms cannot be OR-ed into one query without matching nothing. Requests
 * are paced so a monitor with a dozen terms is a polite trickle, not a burst.
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

export const HN_SEARCH_API = 'https://hn.algolia.com/api/v1';

export interface HackerNewsSourceOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** Least time between two requests. */
  readonly gapMs?: number;
}

interface AlgoliaHit {
  objectID?: string;
  author?: string;
  title?: string | null;
  story_title?: string | null;
  story_text?: string | null;
  comment_text?: string | null;
  url?: string | null;
  story_id?: number | null;
  created_at_i?: number;
  _tags?: string[];
}

/** Algolia returns HTML in comment and story text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .trim();
}

export class HackerNewsSource implements FeedSource {
  readonly network = 'hackernews' as const;
  readonly slug = 'hackernews';
  readonly displayName = 'Hacker News';

  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #gapMs: number;
  #last = 0;

  constructor(options: HackerNewsSourceOptions = {}) {
    this.#baseUrl = options.baseUrl ?? HN_SEARCH_API;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#gapMs = options.gapMs ?? 1_000;
  }

  async search(input: FeedSearchInput): Promise<readonly FeedPost[]> {
    const terms = [...new Set(input.terms.map((t) => t.trim()).filter((t) => t.length > 0))];
    if (terms.length === 0) return [];

    const limit = Math.min(input.limit ?? 30, 100);
    const posts: FeedPost[] = [];
    const seen = new Set<string>();

    for (const term of terms) {
      const hits = await this.#searchTerm(term, limit, input.since);

      for (const hit of hits) {
        if (!hit.objectID || !hit.author) continue;
        const comment = hit._tags?.includes('comment') ?? false;
        const title = (comment ? hit.story_title : hit.title) ?? undefined;
        const body = stripHtml((comment ? hit.comment_text : hit.story_text) ?? '');
        const text = [comment ? '' : title, body].filter(Boolean).join('\n\n').trim();
        if (!text) continue;
        // Algolia matches words anywhere and stems them; the phrase has to be there.
        if (!mentionsTerm(`${title ?? ''}\n${text}`, [term])) continue;
        if (seen.has(hit.objectID)) continue;
        seen.add(hit.objectID);

        const postedAt = hit.created_at_i
          ? new Date(hit.created_at_i * 1000).toISOString()
          : new Date().toISOString();
        if (input.since && Date.parse(postedAt) < input.since.getTime()) continue;

        posts.push({
          network: 'hackernews',
          externalId: hit.objectID,
          authorHandle: hit.author,
          authorUrl: `https://news.ycombinator.com/user?id=${encodeURIComponent(hit.author)}`,
          url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          ...(title ? { title } : {}),
          text: excerpt(text),
          postedAt,
          container: comment ? 'HN comment' : 'HN story',
        });
      }
    }

    return posts;
  }

  async #searchTerm(term: string, limit: number, since: Date | undefined): Promise<AlgoliaHit[]> {
    const wait = this.#last + this.#gapMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.#last = Date.now();

    const params = new URLSearchParams({
      query: `"${term.replace(/"/g, '')}"`,
      tags: '(story,comment)',
      hitsPerPage: String(limit),
    });
    if (since) params.set('numericFilters', `created_at_i>${Math.floor(since.getTime() / 1000)}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}/search_by_date?${params.toString()}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.status === 429) throw new FeedRateLimitError('hackernews');
      if (!response.ok) return [];
      const body = (await response.json()) as { hits?: AlgoliaHit[] };
      return body.hits ?? [];
    } finally {
      clearTimeout(timer);
    }
  }
}
