import { describe, expect, test } from 'bun:test';
import { BlueskyAudienceReader, postUrlFor } from './audience';

const DID = 'did:plc:acme';

interface Route {
  readonly status?: number;
  readonly body?: unknown;
}

/** Answers XRPC calls from a map keyed by method name. Anything else 404s. */
function fetchFrom(routes: Record<string, Route>, calls: string[] = []) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    const method = url.pathname.replace('/xrpc/', '');
    calls.push(method);

    const route = routes[method];
    if (!route) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const PROFILE = { did: DID, handle: 'acme.bsky.social', displayName: 'Acme' };

const FEED = {
  feed: [
    {
      post: {
        uri: `at://${DID}/app.bsky.feed.post/abc`,
        author: PROFILE,
        record: { text: 'We shipped deterministic policy checks.' },
      },
    },
    // A repost of someone else's post: the account's timeline, not its work.
    {
      post: {
        uri: 'at://did:plc:other/app.bsky.feed.post/xyz',
        author: { did: 'did:plc:other', handle: 'other' },
      },
      reason: { $type: 'app.bsky.feed.defs#reasonRepost' },
    },
  ],
};

describe('BlueskyAudienceReader', () => {
  test('reads followers, likers, reposters and repliers as engagements', async () => {
    const reader = new BlueskyAudienceReader({
      fetchImpl: fetchFrom({
        'app.bsky.actor.getProfile': { body: PROFILE },
        'app.bsky.graph.getFollowers': {
          body: {
            followers: [{ did: 'did:plc:dana', handle: 'dana.bsky.social', description: 'CTO' }],
          },
        },
        'app.bsky.feed.getAuthorFeed': { body: FEED },
        'app.bsky.feed.getLikes': {
          body: {
            likes: [
              {
                actor: { did: 'did:plc:sam', handle: 'sam.bsky.social' },
                createdAt: '2026-09-24T10:00:00Z',
              },
            ],
          },
        },
        'app.bsky.feed.getRepostedBy': {
          body: { repostedBy: [{ did: 'did:plc:kim', handle: 'kim.bsky.social' }] },
        },
        'app.bsky.feed.getPostThread': {
          body: {
            thread: {
              replies: [
                {
                  post: {
                    author: { did: 'did:plc:lee', handle: 'lee.bsky.social' },
                    record: { text: 'How do you handle policy versioning?' },
                    indexedAt: '2026-09-24T11:00:00Z',
                  },
                },
                // The account answering in its own thread is not a lead.
                { post: { author: PROFILE, record: { text: 'Good question' } } },
              ],
            },
          },
        },
      }),
    });

    const result = await reader.read({
      account: 'acme.bsky.social',
      kinds: ['follow', 'like', 'repost', 'reply'],
      lookbackPosts: 5,
      limit: 50,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byKind = Object.fromEntries(
      result.engagements.map((engagement) => [engagement.kind, engagement]),
    );

    expect(result.engagements).toHaveLength(4);
    expect(byKind.follow?.actor.handle).toBe('dana.bsky.social');
    expect(byKind.follow?.subjectId).toBeUndefined();
    expect(byKind.like?.actor.handle).toBe('sam.bsky.social');
    expect(byKind.like?.subjectText).toBe('We shipped deterministic policy checks.');
    expect(byKind.like?.subjectUrl).toBe('https://bsky.app/profile/acme.bsky.social/post/abc');
    expect(byKind.repost?.actor.handle).toBe('kim.bsky.social');
    // A reply's evidence is what the replier said, not the post they answered.
    expect(byKind.reply?.subjectText).toBe('How do you handle policy versioning?');
  });

  test('asks only for the kinds it was told to read', async () => {
    const calls: string[] = [];
    const reader = new BlueskyAudienceReader({
      fetchImpl: fetchFrom(
        {
          'app.bsky.actor.getProfile': { body: PROFILE },
          'app.bsky.graph.getFollowers': { body: { followers: [] } },
        },
        calls,
      ),
    });

    const result = await reader.read({
      account: 'acme.bsky.social',
      kinds: ['follow'],
      lookbackPosts: 5,
      limit: 50,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(['app.bsky.actor.getProfile', 'app.bsky.graph.getFollowers']);
  });

  test('stops at the cap rather than draining a viral post', async () => {
    const likes = Array.from({ length: 40 }, (_, index) => ({
      actor: { did: `did:plc:${index}`, handle: `person${index}.bsky.social` },
    }));

    const reader = new BlueskyAudienceReader({
      fetchImpl: fetchFrom({
        'app.bsky.actor.getProfile': { body: PROFILE },
        'app.bsky.feed.getAuthorFeed': { body: FEED },
        'app.bsky.feed.getLikes': { body: { likes } },
      }),
    });

    const result = await reader.read({
      account: 'acme.bsky.social',
      kinds: ['like'],
      lookbackPosts: 5,
      limit: 10,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.engagements).toHaveLength(10);
  });

  test('an unknown account is a reason, not an empty audience', async () => {
    const reader = new BlueskyAudienceReader({
      fetchImpl: fetchFrom({ 'app.bsky.actor.getProfile': { status: 400 } }),
    });

    const result = await reader.read({
      account: 'nobody.bsky.social',
      kinds: ['follow'],
      lookbackPosts: 5,
      limit: 10,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no bluesky account');
  });

  test('a rate limit is retryable', async () => {
    const reader = new BlueskyAudienceReader({
      fetchImpl: fetchFrom({ 'app.bsky.actor.getProfile': { status: 429 } }),
    });

    const result = await reader.read({
      account: 'acme.bsky.social',
      kinds: ['follow'],
      lookbackPosts: 5,
      limit: 10,
    });

    expect(result).toEqual({ ok: false, reason: 'bluesky rate limit reached', retryable: true });
  });
});

describe('postUrlFor', () => {
  test('builds the web URL a human can open', () => {
    expect(postUrlFor(`at://${DID}/app.bsky.feed.post/abc`, 'acme.bsky.social')).toBe(
      'https://bsky.app/profile/acme.bsky.social/post/abc',
    );
  });

  test('refuses anything that is not an at:// URI', () => {
    expect(postUrlFor('https://example.com/post', 'acme')).toBeUndefined();
  });
});
