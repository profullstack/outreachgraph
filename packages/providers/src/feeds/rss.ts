/**
 * RSS and Atom as a listening source.
 *
 * `rss` has been in the network list and the capability matrix since the first
 * commit with nothing behind it. It is the cheapest broad win available, and
 * the one with no gatekeeper at all: trade press, local news, industry blogs,
 * job boards, forum feeds, podcast feeds and Google News queries are all just
 * XML at a URL. For reaching buyers outside software — where there is no
 * GitHub profile and often no social presence worth the name — this is the
 * source with the widest coverage per unit of effort.
 *
 * It differs from the others in one way that shapes the whole adapter: **a
 * feed has no search.** Reddit and Bluesky are asked a question; a feed is a
 * list of whatever was published, and the matching happens here. So the terms
 * are applied locally to the title and body, and the feed URLs are the real
 * configuration — pointing this at three trade publications is worth more than
 * any query string.
 *
 * The parser is deliberately small and tolerant rather than a dependency.
 * Real feeds in the wild are malformed in ways a strict parser rejects
 * outright, and the failure mode that matters is one bad item, not one bad
 * item taking the whole run down with it.
 */

import type { FetchLike } from '../site/fetch';
import {
  excerpt,
  mentionsTerm,
  type FeedPost,
  type FeedSearchInput,
  type FeedSource,
} from './source';

export interface RssSourceOptions {
  /** The feeds to poll. This is the configuration that matters. */
  readonly feedUrls: readonly string[];
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export class RssSource implements FeedSource {
  readonly network = 'rss' as const;
  readonly slug = 'rss';
  readonly displayName = 'RSS and Atom feeds';

  readonly #feedUrls: readonly string[];
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: RssSourceOptions) {
    this.#feedUrls = options.feedUrls;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async search(input: FeedSearchInput): Promise<readonly FeedPost[]> {
    const terms = input.terms.filter((t) => t.trim().length > 0);
    const posts: FeedPost[] = [];

    for (const feedUrl of this.#feedUrls) {
      // One unreachable feed must not cost the run every other feed. A trade
      // publication going down for an afternoon is normal.
      let xml: string;
      try {
        xml = await this.#fetchFeed(feedUrl);
      } catch {
        continue;
      }

      const channelTitle = firstTag(xml, 'title') ?? feedUrl;

      for (const item of splitItems(xml)) {
        const title = textOf(firstTag(item, 'title') ?? '');
        const body = textOf(
          firstTag(item, 'content:encoded') ??
            firstTag(item, 'description') ??
            firstTag(item, 'summary') ??
            firstTag(item, 'content') ??
            '',
        );

        const text = [title, body].filter(Boolean).join('\n\n').trim();
        if (!text) continue;
        if (!mentionsTerm(text, terms)) continue;

        const link = itemLink(item);
        if (!link) continue;

        const postedAt = parseDate(
          firstTag(item, 'pubDate') ?? firstTag(item, 'published') ?? firstTag(item, 'updated'),
        );

        if (input.since && Date.parse(postedAt) < input.since.getTime()) continue;

        // A feed's author is often a byline and sometimes an address; the
        // publication is the reliable one, and a byline is a bonus.
        const author = textOf(
          firstTag(item, 'dc:creator') ?? firstTag(item, 'author') ?? '',
        ).replace(/\s*\(.*\)$/, '');

        posts.push({
          network: 'rss',
          externalId: textOf(firstTag(item, 'guid') ?? firstTag(item, 'id') ?? link),
          authorHandle: author || channelTitle,
          ...(author ? { authorDisplayName: author } : {}),
          url: link,
          ...(title ? { title } : {}),
          text: excerpt(text),
          postedAt,
          container: textOf(channelTitle),
        });

        if (input.limit && posts.length >= input.limit) return posts;
      }
    }

    return posts;
  }

  async #fetchFeed(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(url, {
        headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`feed ${url} returned ${response.status}`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }
}

/** RSS calls them `item`, Atom calls them `entry`. Both appear in the wild. */
function splitItems(xml: string): string[] {
  const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  if (items.length > 0) return items;
  return [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map((m) => m[0]);
}

function firstTag(xml: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  return pattern.exec(xml)?.[1];
}

/**
 * Atom puts the URL in an attribute, RSS in the element body.
 *
 * Atom feeds also carry several `link` elements — `alternate` is the article,
 * `self` is the feed itself, and taking the first match indiscriminately makes
 * every item point back at the feed.
 */
function itemLink(item: string): string | undefined {
  const alternate = /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(item);
  if (alternate?.[1]) return alternate[1];

  const body = /<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i.exec(item);
  const inline = body?.[1] ? textOf(body[1]) : '';
  if (inline) return inline;

  const href = /<link[^>]*href=["']([^"']+)["']/i.exec(item);
  return href?.[1];
}

/** Unwraps CDATA, strips markup and decodes the handful of entities that matter. */
function textOf(value: string): string {
  return (
    value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // Ampersand last, or a double-encoded entity decodes into markup.
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function parseDate(raw: string | undefined): string {
  if (!raw) return new Date().toISOString();
  const parsed = Date.parse(textOf(raw));
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}
