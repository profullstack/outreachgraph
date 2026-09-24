/**
 * X as somewhere the product may actually act.
 *
 * The capability matrix has marked X replies, likes and follows `official_api`
 * since V1, but nothing in the codebase could post to X, so every X card was
 * `allow` on paper and held in practice. Production had 188 of them.
 *
 * Authentication is OAuth 2.1: authorization code with PKCE (see `oauth.ts`),
 * a user-context bearer token, and a refresh token that X rotates on every
 * use. This client only ever holds the bearer; getting and renewing it is the
 * caller's job, because the renewed pair has to be written back to the
 * database or the next refresh fails.
 */

import type { FetchLike } from '../site/fetch';

export const X_API = 'https://api.x.com';

/** X counts weighted characters; plain text under this is always accepted. */
export const X_POST_LIMIT = 280;

export class XAuthError extends Error {
  constructor(message = 'x rejected the credentials') {
    super(message);
    this.name = 'XAuthError';
  }
}

export class XWriteError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'XWriteError';
    this.status = status;
  }
}

export interface XUser {
  readonly id: string;
  readonly username: string;
}

export interface XClientOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

/** `https://x.com/someone/status/123` (or twitter.com) to `123`. */
export function tweetIdFromUrl(url: string): string | undefined {
  const match = /(?:x|twitter)\.com\/[^/]+\/status(?:es)?\/(\d+)/i.exec(url);
  return match?.[1];
}

export class XClient {
  readonly #accessToken: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  #me: XUser | undefined;

  constructor(accessToken: string, options: XClientOptions = {}) {
    this.#accessToken = accessToken;
    this.#baseUrl = options.baseUrl ?? X_API;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** The account the tokens belong to. Doubles as the credential check. */
  async me(): Promise<XUser> {
    if (this.#me) return this.#me;
    const body = await this.#request('GET', '/2/users/me');
    const data = (body as { data?: { id?: string; username?: string } }).data;
    if (!data?.id || !data.username) throw new XAuthError('x returned no account for the tokens');
    this.#me = { id: data.id, username: data.username };
    return this.#me;
  }

  async reply(input: { text: string; inReplyTo: string }): Promise<{ id: string; url: string }> {
    const body = await this.#request('POST', '/2/tweets', {
      text: input.text,
      reply: { in_reply_to_tweet_id: input.inReplyTo },
    });
    const id = (body as { data?: { id?: string } }).data?.id;
    if (!id) throw new XWriteError('x accepted the post but returned no id', 200);
    const me = await this.me();
    return { id, url: `https://x.com/${me.username}/status/${id}` };
  }

  async like(tweetId: string): Promise<void> {
    const me = await this.me();
    await this.#request('POST', `/2/users/${me.id}/likes`, { tweet_id: tweetId });
  }

  async follow(targetUserId: string): Promise<void> {
    const me = await this.me();
    await this.#request('POST', `/2/users/${me.id}/following`, { target_user_id: targetUserId });
  }

  async userIdFor(username: string): Promise<string | undefined> {
    const handle = username.replace(/^@/, '');
    if (!/^\w{1,15}$/.test(handle)) return undefined;
    try {
      const body = await this.#request('GET', `/2/users/by/username/${handle}`);
      return (body as { data?: { id?: string } }).data?.id;
    } catch (error) {
      if (error instanceof XWriteError && error.status === 404) return undefined;
      throw error;
    }
  }

  async #request(method: 'GET' | 'POST', path: string, json?: unknown): Promise<unknown> {
    const url = `${this.#baseUrl}${path}`;
    const headers: Record<string, string> = { authorization: `Bearer ${this.#accessToken}` };
    if (json !== undefined) headers['content-type'] = 'application/json';

    const response = await this.#fetch(url, {
      method,
      headers,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (response.status === 401) throw new XAuthError();
    if (!response.ok) {
      // X explains a refusal in `detail` or `errors[0].message`; a 403 on a
      // write is usually the app's access tier, which is worth saying plainly.
      const detail =
        (parsed as { detail?: string } | undefined)?.detail ??
        (parsed as { errors?: { message?: string }[] } | undefined)?.errors?.[0]?.message ??
        text.slice(0, 200);
      throw new XWriteError(`x ${response.status}: ${detail}`, response.status);
    }

    return parsed;
  }
}
