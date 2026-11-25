/**
 * Bluesky post search as a listening source.
 *
 * Distinct from `BlueskyProvider`, which resolves a person already found to
 * their handle. This runs the other way: it searches public posts and the
 * person falls out of the result.
 *
 * The one network where finding and contacting are both already permitted. The
 * capability matrix marks `bluesky/reply` and `bluesky/comment` as
 * `official_api` — a public reply from an account the customer connected is a
 * legitimate action — while DMs stay manual. So a Bluesky signal can lead to a
 * reply in the same place the conversation is happening, which is the least
 * intrusive outreach the product can do anywhere.
 *
 * The AppView is genuinely public: no key, no contract, no per-seat cost. That
 * is why it ships alongside Reddit rather than behind a commercial decision.
 */

import type { FetchLike } from '../site/fetch';
import { BLUESKY_API } from '../bluesky/provider';
import {
  excerpt,
  mentionsTerm,
  FeedRateLimitError,
  type FeedPost,
  type FeedSearchInput,
  type FeedSource,
} from './source';

export interface BlueskyFeedSourceOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /**
   * Keep only authors whose handle ends with this, e.g. `.social.w3bs.org`.
   * A PDS such as social.w3bs.org federates into the Bluesky AppView, so its
   * posts are searched there and picked out by handle; the PDS's own search
   * proxies the AppView and needs a signed-in account.
   */
  readonly handleSuffix?: string;
  readonly slug?: string;
  readonly displayName?: string;
}

/** Bluesky-protocol hosts with their own web client, by handle suffix. */
const WEB_CLIENTS: readonly { suffix: string; origin: string }[] = [
  { suffix: '.social.w3bs.org', origin: 'https://social.w3bs.org' },
];

function webOrigin(handle: string): string {
  return WEB_CLIENTS.find((c) => handle.endsWith(c.suffix))?.origin ?? 'https://bsky.app';
}

interface SearchResponse {
  posts?: {
    uri?: string;
    cid?: string;
    author?: { did?: string; handle?: string; displayName?: string };
    record?: { text?: string; createdAt?: string };
    indexedAt?: string;
  }[];
}

export class BlueskyFeedSource implements FeedSource {
  readonly network = 'bluesky' as const;
  readonly slug: string;
  readonly displayName: string;

  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #handleSuffix: string | undefined;

  constructor(options: BlueskyFeedSourceOptions = {}) {
    this.slug = options.slug ?? 'bluesky';
    this.displayName = options.displayName ?? 'Bluesky';
    this.#handleSuffix = options.handleSuffix?.toLowerCase();
    this.#baseUrl = options.baseUrl ?? BLUESKY_API;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async search(input: FeedSearchInput): Promise<readonly FeedPost[]> {
    const terms = input.terms.filter((t) => t.trim().length > 0);
    if (terms.length === 0) return [];

    const posts: FeedPost[] = [];
    const seen = new Set<string>();

    // Searched one term at a time: the endpoint has no OR, and a space-joined
    // query is an implicit AND that matches almost nothing.
    for (const term of terms) {
      const response = await this.#searchTerm(term, Math.min(input.limit ?? 25, 100));

      for (const post of response.posts ?? []) {
        const text = post.record?.text?.trim();
        const handle = post.author?.handle;
        if (!text || !handle || !post.uri) continue;
        if (this.#handleSuffix && !handle.toLowerCase().endsWith(this.#handleSuffix)) continue;
        if (!mentionsTerm(text, terms)) continue;

        const postedAt = post.record?.createdAt ?? post.indexedAt ?? new Date().toISOString();
        if (input.since && Date.parse(postedAt) < input.since.getTime()) continue;
        if (seen.has(post.uri)) continue;
        seen.add(post.uri);

        posts.push({
          network: 'bluesky',
          externalId: post.uri,
          authorHandle: handle,
          ...(post.author?.displayName ? { authorDisplayName: post.author.displayName } : {}),
          authorUrl: `${webOrigin(handle)}/profile/${handle}`,
          url: webUrlFor(handle, post.uri),
          text: excerpt(text),
          postedAt,
        });
      }
    }

    return posts;
  }

  async #searchTerm(term: string, limit: number): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: term, limit: String(limit), sort: 'latest' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(
        `${this.#baseUrl}/xrpc/app.bsky.feed.searchPosts?${params.toString()}`,
        { headers: { accept: 'application/json' }, signal: controller.signal },
      );

      if (response.status === 429) throw new FeedRateLimitError('bluesky');
      if (!response.ok) return {};

      return (await response.json()) as SearchResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Turns an `at://` URI into a link a person can open.
 *
 * The AT Protocol identifies a post by DID and record key; bsky.app wants the
 * handle and the same record key. Storing the raw `at://` URI as the evidence
 * link would give the reviewer something they cannot click.
 */
function webUrlFor(handle: string, uri: string): string {
  const rkey = uri.split('/').pop();
  const origin = webOrigin(handle);
  return rkey ? `${origin}/profile/${handle}/post/${rkey}` : `${origin}/profile/${handle}`;
}
