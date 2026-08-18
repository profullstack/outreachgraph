/**
 * Bluesky as somewhere the product may actually act.
 *
 * `provider.ts` reads the public AppView and stops there. This is the other
 * half: an authenticated client that can reply, follow and like on behalf of a
 * connected account, which the capability matrix marks `official_api` for all
 * three.
 *
 * Why this network first, out of every non-email channel:
 *
 *   - LinkedIn, X DMs, Reddit and Instagram are `manual_only` or worse, and
 *     correctly so. A cadence step there is a human's job by design.
 *   - Bluesky's write API is open, documented, and has no gatekeeper deciding
 *     whether we are allowed to be a client. There is no contract to sign, no
 *     per-seat cost, and no review queue that can withdraw access later.
 *
 * So this is the first — and currently only — channel where a plan can run
 * unattended without either breaking a platform's terms or depending on a
 * commercial relationship that can be revoked. That is what makes "compliant
 * multichannel" a product rather than a euphemism for "you do it yourself".
 *
 * Writes go to a PDS (`bsky.social` by default), not to the public AppView.
 * The two are different hosts with different auth, and pointing a write at the
 * read host fails in a way that reads like a credential problem.
 */

import type { FetchLike } from '../site/fetch';

/** Where writes go. The read-only AppView cannot accept them. */
export const BLUESKY_PDS = 'https://bsky.social';

/** Bluesky's own limit, counted in graphemes rather than UTF-16 units. */
export const POST_GRAPHEME_LIMIT = 300;

export class BlueskyAuthError extends Error {
  constructor(message = 'bluesky rejected the credentials') {
    super(message);
    this.name = 'BlueskyAuthError';
  }
}

export class BlueskyWriteError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'BlueskyWriteError';
    this.status = status;
  }
}

export interface BlueskySession {
  readonly did: string;
  readonly handle: string;
  readonly accessJwt: string;
}

/** A record's address on the network: both halves are required to reply to it. */
export interface PostRef {
  readonly uri: string;
  readonly cid: string;
}

export interface BlueskyAgentOptions {
  readonly service?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

/**
 * A link span inside a post, in UTF-8 byte offsets.
 *
 * The byte offsets are the whole reason this type exists. AT Protocol indexes
 * facets by byte, and JavaScript indexes strings by UTF-16 code unit, so any
 * post containing an emoji or a non-Latin character before a link will have
 * its link underline land on the wrong span — or be rejected outright — if the
 * two are confused. Every non-ASCII character makes the drift worse.
 */
export interface Facet {
  readonly index: { readonly byteStart: number; readonly byteEnd: number };
  readonly features: ReadonlyArray<{ readonly $type: string; readonly uri: string }>;
}

const LINK_PATTERN = /https?:\/\/[^\s<>[\]{}"'`]+/g;
const TRAILING = /[.,;:!?'"]+$/;

/**
 * Finds the links in a post and gives them byte-accurate spans.
 *
 * Without facets a URL in a Bluesky post is plain text: visible, not
 * clickable. For an outreach reply whose only call to action is a link, that
 * is the difference between a touch and a dead end.
 */
export function detectFacets(text: string): readonly Facet[] {
  const encoder = new TextEncoder();
  const facets: Facet[] = [];

  for (const match of text.matchAll(LINK_PATTERN)) {
    const raw = match[0];
    const index = match.index;
    if (index === undefined) continue;

    const uri = trimTrailing(raw);
    if (!uri) continue;

    // Encode the prefix rather than counting characters: this is the only way
    // to get a byte offset that agrees with the server's view of the string.
    const byteStart = encoder.encode(text.slice(0, index)).length;
    const byteEnd = byteStart + encoder.encode(uri).length;

    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri }],
    });
  }

  return facets;
}

function trimTrailing(raw: string): string {
  let url = raw.replace(TRAILING, '');
  while (url.endsWith(')')) {
    const opens = (url.match(/\(/g) ?? []).length;
    const closes = (url.match(/\)/g) ?? []).length;
    if (opens >= closes) break;
    url = url.slice(0, -1).replace(TRAILING, '');
  }
  return url;
}

/**
 * Trims a post to the network's limit, counting graphemes.
 *
 * `String.length` counts UTF-16 units, so a message of 200 emoji would be
 * reported as 400 and truncated for no reason, while some scripts would be
 * undercounted and rejected by the server. `Intl.Segmenter` counts what
 * Bluesky counts.
 */
export function fitPost(text: string, limit = POST_GRAPHEME_LIMIT): string {
  const trimmed = text.trim();
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const graphemes = [...segmenter.segment(trimmed)].map((s) => s.segment);

  if (graphemes.length <= limit) return trimmed;

  const cut = graphemes.slice(0, limit - 1).join('');
  const lastSpace = cut.lastIndexOf(' ');

  // Break on a word when one is near the end, so a trimmed post does not end
  // mid-word. A very long single token has no sensible break, so it is cut.
  const body = lastSpace > cut.length * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

/** Turns a bsky.app permalink into the AT-URI a reply has to target. */
export function postUriFromUrl(url: string, did: string): string | undefined {
  const match = /\/profile\/([^/]+)\/post\/([A-Za-z0-9]+)/.exec(url);
  const rkey = match?.[2];
  if (!rkey) return undefined;
  return `at://${did}/app.bsky.feed.post/${rkey}`;
}

export class BlueskyAgent {
  readonly #service: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  #session: BlueskySession | undefined;

  constructor(options: BlueskyAgentOptions = {}) {
    this.#service = options.service ?? BLUESKY_PDS;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  get session(): BlueskySession | undefined {
    return this.#session;
  }

  /**
   * Exchanges an app password for a session.
   *
   * App passwords, never the account password. Bluesky issues them
   * individually and they can be revoked one at a time, so a workspace can
   * disconnect us without changing the password they use themselves.
   */
  async login(identifier: string, appPassword: string): Promise<BlueskySession> {
    const response = await this.#post('com.atproto.server.createSession', {
      identifier: identifier.replace(/^@/, ''),
      password: appPassword,
    });

    if (response.status === 401 || response.status === 400) {
      throw new BlueskyAuthError();
    }
    if (!response.ok) {
      throw new BlueskyWriteError(`createSession failed: ${response.status}`, response.status);
    }

    const body = (await response.json()) as {
      did?: string;
      handle?: string;
      accessJwt?: string;
    };

    if (!body.did || !body.accessJwt) throw new BlueskyAuthError('no session was returned');

    this.#session = {
      did: body.did,
      handle: body.handle ?? identifier,
      accessJwt: body.accessJwt,
    };

    return this.#session;
  }

  /** Resolves a handle to the did that identifies it permanently. */
  async resolveHandle(handle: string): Promise<string | undefined> {
    const url = new URL('/xrpc/com.atproto.identity.resolveHandle', this.#service);
    url.searchParams.set('handle', handle.replace(/^@/, ''));

    const response = await this.#fetch(url.toString(), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (!response.ok) return undefined;
    const body = (await response.json()) as { did?: string };
    return body.did;
  }

  /**
   * Fetches the post a reply will attach to.
   *
   * Both the uri and the cid are needed: the cid pins the exact version of the
   * record, and a reply carrying a stale one is rejected. That is a feature —
   * it stops us replying to a post that has since been changed out from under
   * the message we wrote about it.
   */
  async getPost(uri: string): Promise<PostRef | undefined> {
    const url = new URL('/xrpc/app.bsky.feed.getPosts', this.#service);
    url.searchParams.set('uris', uri);

    const response = await this.#fetch(url.toString(), {
      headers: {
        accept: 'application/json',
        ...(this.#session ? { authorization: `Bearer ${this.#session.accessJwt}` } : {}),
      },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (!response.ok) return undefined;

    const body = (await response.json()) as {
      posts?: Array<{ uri?: string; cid?: string }>;
    };

    const post = body.posts?.[0];
    if (!post?.uri || !post.cid) return undefined;

    return { uri: post.uri, cid: post.cid };
  }

  /**
   * Posts a reply to an existing post.
   *
   * `root` is the thread's first post and `parent` is what is being answered.
   * Passing the parent as both is correct only when replying at the top of a
   * thread; getting it wrong detaches the reply from the conversation, which
   * on this network means nobody in the thread sees it.
   */
  async reply(input: {
    readonly text: string;
    readonly parent: PostRef;
    readonly root?: PostRef;
  }): Promise<PostRef> {
    const session = this.#requireSession();
    const text = fitPost(input.text);

    return this.#createRecord(session, 'app.bsky.feed.post', {
      text,
      createdAt: new Date().toISOString(),
      facets: detectFacets(text),
      reply: {
        root: input.root ?? input.parent,
        parent: input.parent,
      },
    });
  }

  async follow(did: string): Promise<PostRef> {
    const session = this.#requireSession();
    return this.#createRecord(session, 'app.bsky.graph.follow', {
      subject: did,
      createdAt: new Date().toISOString(),
    });
  }

  async like(post: PostRef): Promise<PostRef> {
    const session = this.#requireSession();
    return this.#createRecord(session, 'app.bsky.feed.like', {
      subject: post,
      createdAt: new Date().toISOString(),
    });
  }

  #requireSession(): BlueskySession {
    if (!this.#session) throw new BlueskyAuthError('not logged in');
    return this.#session;
  }

  async #createRecord(
    session: BlueskySession,
    collection: string,
    record: Record<string, unknown>,
  ): Promise<PostRef> {
    const response = await this.#post(
      'com.atproto.repo.createRecord',
      { repo: session.did, collection, record },
      session.accessJwt,
    );

    if (response.status === 401) throw new BlueskyAuthError('the session expired');

    if (!response.ok) {
      const detail = await response.text();
      throw new BlueskyWriteError(
        `${collection} failed: ${response.status} ${detail.slice(0, 200)}`,
        response.status,
      );
    }

    const body = (await response.json()) as { uri?: string; cid?: string };
    if (!body.uri || !body.cid) {
      throw new BlueskyWriteError(`${collection} returned no record`, response.status);
    }

    return { uri: body.uri, cid: body.cid };
  }

  async #post(method: string, body: unknown, token?: string): Promise<Response> {
    return this.#fetch(new URL(`/xrpc/${method}`, this.#service).toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
  }
}
