/**
 * dev.to as a launch source: the newest articles, read through the public API.
 *
 * dev.to's search endpoint answers servers with an empty list (2026-10-26),
 * so this pages `/api/articles/latest` — about a thousand articles every four
 * hours — back to `since` and matches the terms here. Each article carries its
 * author's GitHub, X and website, which become `authorLinks`.
 */

import type { FetchLike } from '../site/fetch';
import {
  excerpt,
  mentionsTerm,
  type FeedPost,
  type FeedSearchInput,
  type FeedSource,
} from './source';

export const DEVTO_API = 'https://dev.to/api';

export interface DevToSourceOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** Articles per page; dev.to accepts up to 1000. */
  readonly pageSize?: number;
  /** Pages read at most per search, newest first. */
  readonly maxPages?: number;
}

interface DevToArticle {
  id?: number;
  title?: string;
  description?: string;
  url?: string;
  published_at?: string;
  tag_list?: string[] | string;
  user?: {
    username?: string;
    name?: string;
    github_username?: string | null;
    twitter_username?: string | null;
    website_url?: string | null;
  };
}

export class DevToSource implements FeedSource {
  readonly network = 'website' as const;
  readonly slug = 'devto';
  readonly displayName = 'dev.to';

  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #pageSize: number;
  readonly #maxPages: number;

  constructor(options: DevToSourceOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? DEVTO_API).replace(/\/$/, '');
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#pageSize = options.pageSize ?? 1000;
    this.#maxPages = options.maxPages ?? 6;
  }

  async search(input: FeedSearchInput): Promise<readonly FeedPost[]> {
    const terms = [...new Set(input.terms.map((t) => t.trim()).filter((t) => t.length > 0))];
    if (terms.length === 0) return [];
    const limit = input.limit ?? 30;
    const posts: FeedPost[] = [];

    for (let page = 1; page <= this.#maxPages && posts.length < limit; page += 1) {
      const articles = await this.#page(page);
      if (articles.length === 0) break;
      let older = false;
      for (const article of articles) {
        const postedAt = article.published_at ?? '';
        if (input.since && Date.parse(postedAt) < input.since.getTime()) {
          older = true;
          continue;
        }
        const username = article.user?.username;
        if (!article.id || !article.url || !username) continue;
        const tags = Array.isArray(article.tag_list)
          ? article.tag_list.join(' ')
          : (article.tag_list ?? '');
        const text = [article.title, article.description, tags].filter(Boolean).join('\n');
        if (!mentionsTerm(text, terms)) continue;

        const user = article.user!;
        const links = [
          user.github_username ? `https://github.com/${user.github_username}` : '',
          user.twitter_username ? `https://x.com/${user.twitter_username}` : '',
          user.website_url ?? '',
        ].filter((link) => /^https?:\/\//i.test(link));
        posts.push({
          network: 'website',
          externalId: `devto:${article.id}`,
          authorHandle: username,
          ...(user.name ? { authorDisplayName: user.name } : {}),
          authorUrl: `https://dev.to/${username}`,
          url: article.url,
          ...(article.title ? { title: article.title } : {}),
          text: excerpt([article.title, article.description].filter(Boolean).join('\n\n')),
          postedAt,
          container: 'dev.to',
          authorLinks: links,
        });
        if (posts.length >= limit) break;
      }
      if (older) break;
    }
    return posts;
  }

  async #page(page: number): Promise<DevToArticle[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(
        `${this.#baseUrl}/articles/latest?per_page=${this.#pageSize}&page=${page}`,
        { headers: { accept: 'application/json' }, signal: controller.signal },
      );
      if (!response.ok) return [];
      const body = (await response.json()) as unknown;
      return Array.isArray(body) ? (body as DevToArticle[]) : [];
    } finally {
      clearTimeout(timer);
    }
  }
}
