/**
 * Who engaged with a Bluesky account, from the public AppView.
 *
 * The same argument that put Bluesky first as an identity source applies
 * twice over here: reading an account's likers and reposters needs no key, no
 * contract and no permission from the account itself, so the whole audience
 * feature can ship, be tested and be demonstrated without a commercial
 * decision attached. On X the identical feature is gated behind a paid tier.
 *
 * Read-only against `public.api.bsky.app`. Nothing in this file can write.
 */

import type { FetchLike } from '../site/fetch';
import type {
  AudienceActor,
  AudienceEngagement,
  AudienceReadInput,
  AudienceReadResult,
  AudienceReader,
} from '../audience';
import { BLUESKY_API, BlueskyRateLimitError } from './provider';

export interface BlueskyAudienceOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

interface ProfileView {
  did?: string;
  handle?: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  followersCount?: number;
}

interface PostView {
  uri?: string;
  cid?: string;
  author?: ProfileView;
  record?: { text?: string; createdAt?: string; reply?: unknown };
  indexedAt?: string;
}

interface FeedItem {
  post?: PostView;
  reason?: { $type?: string };
  reply?: unknown;
}

/** `at://did:plc:abc/app.bsky.feed.post/3k…` → the web URL a human can open. */
export function postUrlFor(uri: string, handle: string): string | undefined {
  const rkey = uri.split('/').pop();
  return rkey && uri.startsWith('at://')
    ? `https://bsky.app/profile/${handle}/post/${rkey}`
    : undefined;
}

export class BlueskyAudienceReader implements AudienceReader {
  readonly network = 'bluesky' as const;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: BlueskyAudienceOptions = {}) {
    this.#baseUrl = options.baseUrl ?? BLUESKY_API;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async read(input: AudienceReadInput): Promise<AudienceReadResult> {
    try {
      return { ok: true, engagements: await this.#collect(input) };
    } catch (error) {
      if (error instanceof BlueskyRateLimitError) {
        return { ok: false, reason: 'bluesky rate limit reached', retryable: true };
      }
      return {
        ok: false,
        reason: error instanceof Error ? error.message : 'bluesky read failed',
        retryable: true,
      };
    }
  }

  async #collect(input: AudienceReadInput): Promise<readonly AudienceEngagement[]> {
    const profile = await this.#get<ProfileView>('app.bsky.actor.getProfile', {
      actor: input.account,
    });
    if (!profile?.did) throw new Error(`no bluesky account for ${input.account}`);

    const handle = profile.handle ?? input.account;
    const engagements: AudienceEngagement[] = [];
    const wants = (kind: AudienceEngagement['kind']): boolean => input.kinds.includes(kind);

    // Followers first: the cheapest call, and the one kind that needs no post.
    if (wants('follow')) {
      const followers = await this.#get<{ followers?: ProfileView[] }>(
        'app.bsky.graph.getFollowers',
        {
          actor: profile.did,
          limit: String(Math.min(100, input.limit)),
        },
      );

      for (const follower of followers?.followers ?? []) {
        const actor = actorFrom(follower);
        if (actor) engagements.push({ kind: 'follow', actor });
        if (engagements.length >= input.limit) return engagements;
      }
    }

    const needsPosts = wants('like') || wants('repost') || wants('reply');
    if (!needsPosts) return engagements;

    const feed = await this.#get<{ feed?: FeedItem[] }>('app.bsky.feed.getAuthorFeed', {
      actor: profile.did,
      limit: String(Math.min(100, input.lookbackPosts)),
      // The account's own posts and replies. Reposts of other people's work
      // are not this account's post, so its engagement is not its audience.
      filter: 'posts_no_replies',
    });

    const posts = (feed?.feed ?? [])
      .filter((item) => item.reason === undefined && item.post?.author?.did === profile.did)
      .map((item) => item.post)
      .filter((post): post is PostView => post?.uri !== undefined)
      .slice(0, input.lookbackPosts);

    for (const post of posts) {
      if (engagements.length >= input.limit) break;

      const uri = post.uri as string;
      const subject = {
        subjectId: uri,
        ...(postUrlFor(uri, handle) ? { subjectUrl: postUrlFor(uri, handle) } : {}),
        ...(post.record?.text ? { subjectText: post.record.text } : {}),
      };

      if (wants('like')) {
        const likes = await this.#get<{ likes?: { actor?: ProfileView; createdAt?: string }[] }>(
          'app.bsky.feed.getLikes',
          { uri, limit: '100' },
        );

        for (const like of likes?.likes ?? []) {
          const actor = actorFrom(like.actor);
          if (!actor) continue;
          engagements.push({
            kind: 'like',
            actor,
            ...subject,
            ...(like.createdAt ? { at: like.createdAt } : {}),
          });
          if (engagements.length >= input.limit) return engagements;
        }
      }

      if (wants('repost')) {
        const reposts = await this.#get<{ repostedBy?: ProfileView[] }>(
          'app.bsky.feed.getRepostedBy',
          {
            uri,
            limit: '100',
          },
        );

        for (const by of reposts?.repostedBy ?? []) {
          const actor = actorFrom(by);
          if (!actor) continue;
          engagements.push({ kind: 'repost', actor, ...subject });
          if (engagements.length >= input.limit) return engagements;
        }
      }

      if (wants('reply')) {
        const thread = await this.#get<{ thread?: ThreadNode }>('app.bsky.feed.getPostThread', {
          uri,
          depth: '1',
        });

        for (const reply of thread?.thread?.replies ?? []) {
          const author = reply.post?.author;
          // The account replying in its own thread is a conversation, not a lead.
          if (!author || author.did === profile.did) continue;
          const actor = actorFrom(author);
          if (!actor) continue;

          engagements.push({
            kind: 'reply',
            actor,
            ...subject,
            // The reply's own words are the evidence, not the post it answers.
            ...(reply.post?.record?.text ? { subjectText: reply.post.record.text } : {}),
            ...(reply.post?.indexedAt ? { at: reply.post.indexedAt } : {}),
          });
          if (engagements.length >= input.limit) return engagements;
        }
      }
    }

    return engagements;
  }

  async #get<T>(path: string, params: Record<string, string>): Promise<T | undefined> {
    const url = new URL(`/xrpc/${path}`, this.#baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const response = await this.#fetch(url.toString(), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (response.status === 429) throw new BlueskyRateLimitError();
    // A deleted post or an unknown actor is an answer, not a fault.
    if (response.status === 400 || response.status === 404) return undefined;
    if (!response.ok) throw new Error(`bluesky ${path} failed: ${response.status}`);

    return (await response.json()) as T;
  }
}

interface ThreadNode {
  post?: PostView;
  replies?: ThreadNode[];
}

/** A profile with no handle cannot be looked up again, so it is not a person. */
function actorFrom(profile: ProfileView | undefined): AudienceActor | undefined {
  const handle = profile?.handle?.trim();
  if (!handle) return undefined;

  return {
    handle,
    ...(profile?.did ? { platformUserId: profile.did } : {}),
    ...(profile?.displayName?.trim() ? { displayName: profile.displayName.trim() } : {}),
    ...(profile?.description?.trim() ? { bio: profile.description.trim() } : {}),
    ...(profile?.avatar ? { avatarUrl: profile.avatar } : {}),
    profileUrl: `https://bsky.app/profile/${handle}`,
    ...(typeof profile?.followersCount === 'number' ? { followers: profile.followersCount } : {}),
  };
}
