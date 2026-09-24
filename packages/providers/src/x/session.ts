/**
 * X through the member's own logged-in browser session.
 *
 * X's API has had no free tier for new developers since February 2026, and
 * the workspace owner declined to pay for it. The free route is the one the
 * x.com web app itself uses: its internal GraphQL and 1.1 endpoints,
 * authenticated by the session cookies `auth_token` and `ct0`. That is
 * against X's terms, and the owner opted into it knowingly on 2026-09-24, as
 * they did for LinkedIn.
 *
 * X locks accounts that post like a script faster than LinkedIn does, so the
 * pacing in `social-delivery.ts` is tighter for X, and any sign the session is
 * no longer accepted revokes it rather than retrying.
 *
 * Two things here are undocumented and move without notice: the GraphQL
 * operation ids (overridable through `queryIds`), and X's growing demand for
 * an `x-client-transaction-id` header on some operations. A request refused
 * for either is reported on the card, which falls back to a hand-off.
 */

import type { FetchLike } from '../site/fetch';
import type { XPoster, XUser } from './client';

/**
 * The bearer the x.com web client ships in its own JavaScript. It identifies
 * the web app, not a person; the session cookies are what identify the member.
 */
export const X_WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

/** GraphQL operation ids as last seen in the web app's bundle. */
export const X_DEFAULT_QUERY_IDS = {
  CreateTweet: 'a1p9RWpkYKBjWv_I3WzS-A',
  FavoriteTweet: 'lI07N6Otwv1PhnEgXILM7A',
} as const;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export class XSessionError extends Error {
  constructor(message = 'x rejected the session cookies') {
    super(message);
    this.name = 'XSessionError';
  }
}

export class XSessionWriteError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'XSessionWriteError';
    this.status = status;
  }
}

export interface XSessionCookies {
  readonly authToken: string;
  readonly ct0: string;
}

export interface XSessionOptions {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly queryIds?: Partial<Record<keyof typeof X_DEFAULT_QUERY_IDS, string>>;
}

/** Strips `name=` and quotes, so a value pasted with either still works. */
function cookieValue(raw: string, name: string): string {
  return raw
    .trim()
    .replace(new RegExp(`^${name}=`), '')
    .replace(/^"|"$/g, '');
}

export class XSession implements XPoster {
  readonly #authToken: string;
  readonly #ct0: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #queryIds: Record<keyof typeof X_DEFAULT_QUERY_IDS, string>;
  #me: XUser | undefined;

  constructor(cookies: XSessionCookies, options: XSessionOptions = {}) {
    this.#authToken = cookieValue(cookies.authToken, 'auth_token');
    this.#ct0 = cookieValue(cookies.ct0, 'ct0');
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#queryIds = { ...X_DEFAULT_QUERY_IDS, ...options.queryIds };
  }

  /** Who the cookies belong to. Doubles as the credential check. */
  async me(): Promise<XUser> {
    if (this.#me) return this.#me;
    const body = (await this.#request(
      'GET',
      'https://api.x.com/1.1/account/verify_credentials.json?skip_status=true',
    )) as { id_str?: string; screen_name?: string } | undefined;
    if (!body?.id_str || !body.screen_name) {
      throw new XSessionError('x returned no account for the session');
    }
    this.#me = { id: body.id_str, username: body.screen_name };
    return this.#me;
  }

  async reply(input: { text: string; inReplyTo: string }): Promise<{ id: string; url: string }> {
    const body = (await this.#graphql('CreateTweet', {
      tweet_text: input.text,
      reply: { in_reply_to_tweet_id: input.inReplyTo, exclude_reply_user_ids: [] },
      dark_request: false,
      media: { media_entities: [], possibly_sensitive: false },
      semantic_annotation_ids: [],
    })) as {
      data?: { create_tweet?: { tweet_results?: { result?: { rest_id?: string } } } };
      errors?: { message?: string }[];
    };

    const id = body.data?.create_tweet?.tweet_results?.result?.rest_id;
    if (!id) {
      throw new XSessionWriteError(
        `x did not create the post: ${body.errors?.[0]?.message ?? 'no id returned'}`,
        200,
      );
    }
    const me = await this.me();
    return { id, url: `https://x.com/${me.username}/status/${id}` };
  }

  async like(tweetId: string): Promise<void> {
    const body = (await this.#graphql('FavoriteTweet', { tweet_id: tweetId })) as {
      errors?: { message?: string }[];
    };
    // Liking something already liked is an error X reports and we do not mind.
    const error = body.errors?.[0]?.message;
    if (error && !/already/i.test(error)) throw new XSessionWriteError(`x: ${error}`, 200);
  }

  async follow(targetUserId: string): Promise<void> {
    await this.#request(
      'POST',
      'https://x.com/i/api/1.1/friendships/create.json',
      new URLSearchParams({ user_id: targetUserId, include_profile_interstitial_type: '1' }),
    );
  }

  async userIdFor(username: string): Promise<string | undefined> {
    const handle = username.replace(/^@/, '');
    if (!/^\w{1,15}$/.test(handle)) return undefined;
    try {
      const body = (await this.#request(
        'GET',
        `https://api.x.com/1.1/users/show.json?screen_name=${handle}`,
      )) as { id_str?: string } | undefined;
      return body?.id_str;
    } catch (error) {
      if (error instanceof XSessionWriteError && error.status === 404) return undefined;
      throw error;
    }
  }

  async #graphql(
    operation: keyof typeof X_DEFAULT_QUERY_IDS,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    const id = this.#queryIds[operation];
    return this.#request('POST', `https://x.com/i/api/graphql/${id}/${operation}`, {
      variables,
      queryId: id,
      features: {},
    });
  }

  async #request(
    method: 'GET' | 'POST',
    url: string,
    body?: Record<string, unknown> | URLSearchParams,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${X_WEB_BEARER}`,
      cookie: `auth_token=${this.#authToken}; ct0=${this.#ct0}`,
      'x-csrf-token': this.#ct0,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      'user-agent': USER_AGENT,
      origin: 'https://x.com',
      referer: 'https://x.com/home',
    };
    let payload: string | undefined;
    if (body instanceof URLSearchParams) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = body.toString();
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const response = await this.#fetch(url, {
      method,
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    // 401 is a logged-out session; 403 with code 326 or 64 is a locked or
    // suspended account. Either way this session must not be used again.
    const code = (parsed as { errors?: { code?: number }[] } | undefined)?.errors?.[0]?.code;
    if (
      response.status === 401 ||
      (response.status >= 300 && response.status < 400) ||
      (response.status === 403 && (code === 326 || code === 64 || code === 32))
    ) {
      throw new XSessionError(`x ${response.status}: the session is logged out or locked`);
    }

    if (!response.ok) {
      const detail =
        (parsed as { errors?: { message?: string }[] } | undefined)?.errors?.[0]?.message ??
        text.slice(0, 200);
      throw new XSessionWriteError(`x ${response.status}: ${detail}`, response.status);
    }

    return parsed;
  }
}
