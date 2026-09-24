import { describe, expect, test } from 'bun:test';
import { XAudienceReader } from './audience';

interface Route {
  readonly status?: number;
  readonly body?: unknown;
}

function fetchFrom(routes: Record<string, Route>, calls: string[] = []) {
  return async (input: string | URL | Request): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    calls.push(path);

    const route = routes[path];
    if (!route) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const ACCOUNT = { data: { id: '1', username: 'acme', name: 'Acme' } };

describe('XAudienceReader', () => {
  test('reads followers, likers and reposters', async () => {
    const reader = new XAudienceReader('token', {
      fetchImpl: fetchFrom({
        '/2/users/by/username/acme': { body: ACCOUNT },
        '/2/users/1/followers': {
          body: { data: [{ id: '2', username: 'dana', name: 'Dana', description: 'CTO' }] },
        },
        '/2/users/1/tweets': { body: { data: [{ id: '99', text: 'We shipped policy checks.' }] } },
        '/2/tweets/99/liking_users': { body: { data: [{ id: '3', username: 'sam' }] } },
        '/2/tweets/99/retweeted_by': { body: { data: [{ id: '4', username: 'kim' }] } },
      }),
    });

    const result = await reader.read({
      account: '@acme',
      kinds: ['follow', 'like', 'repost'],
      lookbackPosts: 5,
      limit: 50,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(
      result.engagements.map((engagement) => `${engagement.kind}:${engagement.actor.handle}`),
    ).toEqual(['follow:dana', 'like:sam', 'repost:kim']);
    expect(result.engagements[1]?.subjectUrl).toBe('https://x.com/acme/status/99');
    expect(result.engagements[1]?.subjectText).toBe('We shipped policy checks.');
  });

  test('a 403 is not retryable and names the plan', async () => {
    const reader = new XAudienceReader('token', {
      fetchImpl: fetchFrom({
        '/2/users/by/username/acme': { body: ACCOUNT },
        '/2/users/1/followers': { status: 403 },
      }),
    });

    const result = await reader.read({
      account: 'acme',
      kinds: ['follow'],
      lookbackPosts: 5,
      limit: 10,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(false);
    expect(result.reason).toContain('paid X API tier');
  });

  test('a 429 is retryable', async () => {
    const reader = new XAudienceReader('token', {
      fetchImpl: fetchFrom({
        '/2/users/by/username/acme': { body: ACCOUNT },
        '/2/users/1/followers': { status: 429 },
      }),
    });

    const result = await reader.read({
      account: 'acme',
      kinds: ['follow'],
      lookbackPosts: 5,
      limit: 10,
    });

    expect(result).toEqual({ ok: false, reason: 'X rate limit reached', retryable: true });
  });

  test('a grant without the read scopes is refused before a call is made', async () => {
    const calls: string[] = [];
    const reader = new XAudienceReader('token', {
      grantedScopes: ['tweet.read', 'tweet.write', 'like.write'],
      fetchImpl: fetchFrom({}, calls),
    });

    const result = await reader.read({
      account: 'acme',
      kinds: ['follow', 'like'],
      lookbackPosts: 5,
      limit: 10,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('follows.read and like.read');
    expect(result.reason).toContain('reconnect X');
    expect(result.retryable).toBe(false);
    expect(calls).toEqual([]);
  });

  test('a grant holding the read scopes proceeds', async () => {
    const reader = new XAudienceReader('token', {
      grantedScopes: ['follows.read', 'like.read'],
      fetchImpl: fetchFrom({
        '/2/users/by/username/acme': { body: ACCOUNT },
        '/2/users/1/followers': { body: { data: [{ id: '2', username: 'dana' }] } },
      }),
    });

    const result = await reader.read({
      account: 'acme',
      kinds: ['follow'],
      lookbackPosts: 5,
      limit: 10,
    });

    expect(result.ok).toBe(true);
  });

  test('bad credentials say so rather than retrying forever', async () => {
    const reader = new XAudienceReader('token', {
      fetchImpl: fetchFrom({ '/2/users/by/username/acme': { status: 401 } }),
    });

    const result = await reader.read({
      account: 'acme',
      kinds: ['follow'],
      lookbackPosts: 5,
      limit: 10,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(false);
    expect(result.reason).toContain('reconnect X');
  });

  test('mentions carry the mentioner’s own words', async () => {
    const reader = new XAudienceReader('token', {
      fetchImpl: fetchFrom({
        '/2/users/by/username/acme': { body: ACCOUNT },
        '/2/users/1/mentions': {
          body: {
            data: [
              {
                id: '77',
                text: 'anyone used @acme for this?',
                author_id: '5',
                created_at: '2026-09-24T10:00:00Z',
              },
            ],
            includes: { users: [{ id: '5', username: 'lee', name: 'Lee' }] },
          },
        },
      }),
    });

    const result = await reader.read({
      account: 'acme',
      kinds: ['mention'],
      lookbackPosts: 5,
      limit: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.engagements[0]?.actor.handle).toBe('lee');
    expect(result.engagements[0]?.subjectText).toBe('anyone used @acme for this?');
    expect(result.engagements[0]?.subjectUrl).toBe('https://x.com/lee/status/77');
  });
});
