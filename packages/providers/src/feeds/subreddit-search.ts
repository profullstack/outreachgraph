/**
 * Finding the communities a campaign should listen to.
 *
 * Scoping Reddit to a few subreddits is the difference between signal and
 * noise, but it asks the operator for something they usually do not have.
 * Someone selling scheduling software to plumbing contractors knows their
 * buyer precisely and has still never heard of r/Plumbing — and "go and work
 * out which subreddits your customers use" is a research task handed back to
 * the person who bought the product to avoid exactly that.
 *
 * Reddit indexes its own communities, so the answer is already available: the
 * campaign's keywords are the query, and the matching subreddits are the
 * suggestion. The operator picks from a list of real communities with real
 * subscriber counts instead of guessing at names.
 *
 * Suggestions only. Nothing here writes targeting — a human still chooses,
 * because a plausible-looking community that turns out to be the wrong trade
 * costs a week of irrelevant signals before anyone notices.
 */

import type { FetchLike } from '../site/fetch';
import { FeedRateLimitError } from './source';
import { REDDIT_API } from './reddit';

export interface SubredditSuggestion {
  /** Bare name, ready to store: `plumbing`, not `r/plumbing`. */
  readonly name: string;
  readonly title: string;
  readonly subscribers: number;
  readonly description: string;
  readonly url: string;
  /** Which of the campaign's terms found this community. */
  readonly matchedTerms: readonly string[];
}

export interface SuggestSubredditsOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
  readonly accessToken?: string;
  /** Suggestions to return. */
  readonly limit?: number;
}

interface SubredditListing {
  data?: {
    children?: {
      data?: {
        display_name?: string;
        title?: string;
        public_description?: string;
        subscribers?: number;
        over18?: boolean;
        over_18?: boolean;
        subreddit_type?: string;
        quarantine?: boolean;
      };
    }[];
  };
}

const DEFAULT_AGENT = 'outreachgraph/0.1 (listening; +https://outreachgraph.com)';

/**
 * Dead and near-dead communities crowd out real ones.
 *
 * Deliberately low rather than "large subreddits only": a 400-member local
 * trade subreddit is often a far better target than a two-million-member
 * general one, because everyone in it shares the buyer's exact problem.
 */
const MIN_SUBSCRIBERS = 200;

export async function suggestSubreddits(
  terms: readonly string[],
  options: SuggestSubredditsOptions = {},
): Promise<readonly SubredditSuggestion[]> {
  const queries = [...new Set(terms.map((term) => term.trim()).filter((term) => term.length >= 3))];
  if (queries.length === 0) return [];

  const baseUrl = options.baseUrl ?? REDDIT_API;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const limit = Math.min(options.limit ?? 20, 50);

  const found = new Map<string, { suggestion: SubredditSuggestion; matched: Set<string> }>();

  for (const term of queries) {
    const listing = await fetchSubreddits(term, {
      baseUrl,
      fetchImpl,
      timeoutMs,
      userAgent: options.userAgent ?? DEFAULT_AGENT,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    });

    for (const child of listing.data?.children ?? []) {
      const data = child.data;
      const name = data?.display_name?.trim();
      if (!data || !name) continue;

      // Private and restricted communities cannot be searched later, so
      // suggesting one produces a target that silently returns nothing.
      if (data.subreddit_type && data.subreddit_type !== 'public') continue;
      if (data.over18 === true || data.over_18 === true) continue;
      if (data.quarantine === true) continue;

      const subscribers = data.subscribers ?? 0;
      if (subscribers < MIN_SUBSCRIBERS) continue;

      const key = name.toLowerCase();
      const existing = found.get(key);

      if (existing) {
        existing.matched.add(term);
        continue;
      }

      found.set(key, {
        matched: new Set([term]),
        suggestion: {
          name,
          title: data.title?.trim() ?? name,
          subscribers,
          description: data.public_description?.trim() ?? '',
          url: `${REDDIT_API}/r/${name}`,
          matchedTerms: [],
        },
      });
    }
  }

  return (
    [...found.values()]
      .map(({ suggestion, matched }) => ({ ...suggestion, matchedTerms: [...matched] }))
      // A community matching two of the campaign's terms is a better bet than a
      // larger one matching a single word, so breadth of match outranks size.
      .sort(
        (a, b) => b.matchedTerms.length - a.matchedTerms.length || b.subscribers - a.subscribers,
      )
      .slice(0, limit)
  );
}

async function fetchSubreddits(
  term: string,
  options: {
    baseUrl: string;
    fetchImpl: FetchLike;
    timeoutMs: number;
    userAgent: string;
    accessToken?: string;
  },
): Promise<SubredditListing> {
  const params = new URLSearchParams({ q: term, limit: '25', raw_json: '1' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await options.fetchImpl(
      `${options.baseUrl}/subreddits/search.json?${params.toString()}`,
      {
        headers: {
          'user-agent': options.userAgent,
          accept: 'application/json',
          ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
        },
        signal: controller.signal,
      },
    );

    if (response.status === 429) throw new FeedRateLimitError('reddit');
    if (!response.ok) return {};

    return (await response.json()) as SubredditListing;
  } finally {
    clearTimeout(timer);
  }
}
