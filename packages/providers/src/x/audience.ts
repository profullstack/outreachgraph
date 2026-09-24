/**
 * Who engaged with an X account, over the v2 API.
 *
 * Unlike Bluesky, none of this is free. `followers`, `liking_users` and
 * `retweeted_by` sit above the free tier, and the scopes the sender asked for
 * at connect time (`tweet.write`, `like.write`, `follows.write`) do not
 * include the reads. So the interesting behaviour in this file is not the
 * happy path — it is what happens when X says no.
 *
 * A 403 here is a fact about the workspace's plan or grant, and no number of
 * retries changes it. It comes back as `retryable: false` with a sentence
 * naming what to do, so the watcher can disable itself and tell the user,
 * rather than spending a daily quota rediscovering the same refusal. A 429 is
 * the opposite: the same call works in fifteen minutes.
 */

import type { FetchLike } from '../site/fetch';
import type {
  AudienceActor,
  AudienceEngagement,
  AudienceReadInput,
  AudienceReadResult,
  AudienceReader,
} from '../audience';
import { X_API } from './client';

/**
 * The reads this file makes, which a connection must have been granted.
 *
 * Not added to `X_SCOPES`: every account connected before this feature holds
 * a grant without them, and asking for more at connect time does not
 * retroactively widen one. `missingScopes` is what turns that into a sentence
 * telling the user to reconnect, instead of a 403 they have to interpret.
 */
export const X_AUDIENCE_SCOPES = ['follows.read', 'like.read'] as const;

export interface XAudienceOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** Scopes the stored grant actually has, so a refusal can be explained before it happens. */
  readonly grantedScopes?: readonly string[];
}

const USER_FIELDS = 'username,name,description,profile_image_url,public_metrics';

interface XUserPayload {
  id?: string;
  username?: string;
  name?: string;
  description?: string;
  profile_image_url?: string;
  public_metrics?: { followers_count?: number };
}

interface XTweetPayload {
  id?: string;
  text?: string;
  created_at?: string;
  referenced_tweets?: { type?: string }[];
}

/** Thrown internally so one refusal aborts a read without unwinding by hand. */
class XAudienceUnavailable extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'XAudienceUnavailable';
    this.retryable = retryable;
  }
}

export class XAudienceReader implements AudienceReader {
  readonly network = 'x' as const;
  readonly #accessToken: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #granted: readonly string[] | undefined;

  constructor(accessToken: string, options: XAudienceOptions = {}) {
    this.#accessToken = accessToken;
    this.#baseUrl = options.baseUrl ?? X_API;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#granted = options.grantedScopes;
  }

  /** Scopes this read needs that the stored grant does not have. */
  missingScopes(kinds: readonly AudienceEngagement['kind'][]): readonly string[] {
    if (!this.#granted) return [];

    const needed = new Set<string>();
    if (kinds.includes('follow')) needed.add('follows.read');
    if (kinds.includes('like')) needed.add('like.read');

    return [...needed].filter((scope) => !this.#granted?.includes(scope));
  }

  async read(input: AudienceReadInput): Promise<AudienceReadResult> {
    const missing = this.missingScopes(input.kinds);
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `this X connection was granted without ${missing.join(' and ')} — reconnect X to read them`,
        retryable: false,
      };
    }

    try {
      return { ok: true, engagements: await this.#collect(input) };
    } catch (error) {
      if (error instanceof XAudienceUnavailable) {
        return { ok: false, reason: error.message, retryable: error.retryable };
      }
      return {
        ok: false,
        reason: error instanceof Error ? error.message : 'x read failed',
        retryable: true,
      };
    }
  }

  async #collect(input: AudienceReadInput): Promise<readonly AudienceEngagement[]> {
    const account = await this.#userByUsername(input.account);
    if (!account?.id) throw new XAudienceUnavailable(`no X account for @${input.account}`, false);

    const engagements: AudienceEngagement[] = [];
    const wants = (kind: AudienceEngagement['kind']): boolean => input.kinds.includes(kind);

    if (wants('follow')) {
      const followers = await this.#get<{ data?: XUserPayload[] }>(
        `/2/users/${account.id}/followers`,
        {
          max_results: String(Math.min(100, Math.max(1, input.limit))),
          'user.fields': USER_FIELDS,
        },
      );

      for (const follower of followers?.data ?? []) {
        const actor = actorFrom(follower);
        if (actor) engagements.push({ kind: 'follow', actor });
        if (engagements.length >= input.limit) return engagements;
      }
    }

    if (wants('mention')) {
      const mentions = await this.#get<{
        data?: XTweetPayload[];
        includes?: { users?: XUserPayload[] };
      }>(`/2/users/${account.id}/mentions`, {
        max_results: String(Math.min(100, Math.max(5, input.limit))),
        'tweet.fields': 'created_at,author_id',
        expansions: 'author_id',
        'user.fields': USER_FIELDS,
      });

      const authors = new Map((mentions?.includes?.users ?? []).map((user) => [user.id, user]));
      for (const tweet of mentions?.data ?? []) {
        const author = authors.get((tweet as { author_id?: string }).author_id);
        const actor = actorFrom(author);
        if (!actor || !tweet.id) continue;

        engagements.push({
          kind: 'mention',
          actor,
          subjectId: tweet.id,
          subjectUrl: `https://x.com/${actor.handle}/status/${tweet.id}`,
          ...(tweet.text ? { subjectText: tweet.text } : {}),
          ...(tweet.created_at ? { at: tweet.created_at } : {}),
        });
        if (engagements.length >= input.limit) return engagements;
      }
    }

    if (!wants('like') && !wants('repost')) return engagements;

    const timeline = await this.#get<{ data?: XTweetPayload[] }>(`/2/users/${account.id}/tweets`, {
      max_results: String(Math.min(100, Math.max(5, input.lookbackPosts))),
      'tweet.fields': 'created_at,referenced_tweets',
      exclude: 'retweets,replies',
    });

    const posts = (timeline?.data ?? []).filter((tweet) => tweet.id).slice(0, input.lookbackPosts);

    for (const post of posts) {
      if (engagements.length >= input.limit) break;

      const subject = {
        subjectId: post.id as string,
        subjectUrl: `https://x.com/${account.username ?? input.account}/status/${post.id}`,
        ...(post.text ? { subjectText: post.text } : {}),
      };

      if (wants('like')) {
        const likers = await this.#get<{ data?: XUserPayload[] }>(
          `/2/tweets/${post.id}/liking_users`,
          { max_results: '100', 'user.fields': USER_FIELDS },
        );

        for (const user of likers?.data ?? []) {
          const actor = actorFrom(user);
          if (!actor) continue;
          engagements.push({ kind: 'like', actor, ...subject });
          if (engagements.length >= input.limit) return engagements;
        }
      }

      if (wants('repost')) {
        const reposters = await this.#get<{ data?: XUserPayload[] }>(
          `/2/tweets/${post.id}/retweeted_by`,
          { max_results: '100', 'user.fields': USER_FIELDS },
        );

        for (const user of reposters?.data ?? []) {
          const actor = actorFrom(user);
          if (!actor) continue;
          engagements.push({ kind: 'repost', actor, ...subject });
          if (engagements.length >= input.limit) return engagements;
        }
      }
    }

    return engagements;
  }

  async #userByUsername(username: string): Promise<XUserPayload | undefined> {
    const body = await this.#get<{ data?: XUserPayload }>(
      `/2/users/by/username/${encodeURIComponent(username.replace(/^@/, ''))}`,
      { 'user.fields': USER_FIELDS },
    );
    return body?.data;
  }

  async #get<T>(path: string, params: Record<string, string>): Promise<T | undefined> {
    const url = new URL(path, this.#baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const response = await this.#fetch(url.toString(), {
      headers: { authorization: `Bearer ${this.#accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (response.ok) return (await response.json()) as T;

    // A deleted post or a suspended account: an answer about that one call.
    if (response.status === 404) return undefined;

    if (response.status === 401) {
      throw new XAudienceUnavailable('X rejected the stored credentials — reconnect X', false);
    }
    if (response.status === 403) {
      throw new XAudienceUnavailable(
        `X refused ${path.replace(/\/\d+/g, '/…')} — this read needs a paid X API tier ` +
          `(${X_AUDIENCE_SCOPES.join(', ')} on a plan that includes it)`,
        false,
      );
    }
    if (response.status === 429) {
      throw new XAudienceUnavailable('X rate limit reached', true);
    }

    throw new XAudienceUnavailable(`x ${path} failed: ${response.status}`, response.status >= 500);
  }
}

function actorFrom(user: XUserPayload | undefined): AudienceActor | undefined {
  const handle = user?.username?.trim();
  if (!handle) return undefined;

  return {
    handle,
    ...(user?.id ? { platformUserId: user.id } : {}),
    ...(user?.name?.trim() ? { displayName: user.name.trim() } : {}),
    ...(user?.description?.trim() ? { bio: user.description.trim() } : {}),
    ...(user?.profile_image_url ? { avatarUrl: user.profile_image_url } : {}),
    profileUrl: `https://x.com/${handle}`,
    ...(typeof user?.public_metrics?.followers_count === 'number'
      ? { followers: user.public_metrics.followers_count }
      : {}),
  };
}
