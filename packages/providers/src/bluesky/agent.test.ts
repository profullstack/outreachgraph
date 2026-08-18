/**
 * The write half of Bluesky.
 *
 * Two things here are easy to get wrong and silently ship: facet byte offsets,
 * which are UTF-8 while JavaScript strings are UTF-16, and the grapheme count,
 * which is not `String.length`. Both fail invisibly — the post goes out, it is
 * just wrong — so most of these tests are about them.
 */

import { describe, expect, test } from 'bun:test';
import {
  BlueskyAgent,
  BlueskyAuthError,
  BlueskyWriteError,
  detectFacets,
  fitPost,
  postUriFromUrl,
  POST_GRAPHEME_LIMIT,
} from './agent';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SESSION = { did: 'did:plc:me', handle: 'me.bsky.social', accessJwt: 'jwt-1' };

/** Records every request so a test can assert on what was actually sent. */
function recorder(responses: Record<string, Response | (() => Response)>) {
  const calls: Array<{ url: string; body: unknown; auth?: string }> = [];

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      ...(headers.get('authorization') ? { auth: headers.get('authorization')! } : {}),
    });

    const key = Object.keys(responses).find((k) => url.includes(k));
    const found = key ? responses[key] : undefined;
    if (!found) return new Response('{}', { status: 404 });
    return typeof found === 'function' ? found() : found.clone();
  };

  return { fetchImpl, calls };
}

describe('detectFacets', () => {
  test('finds a link and spans it', () => {
    const facets = detectFacets('read https://example.com/docs now');

    expect(facets).toHaveLength(1);
    expect(facets[0]?.index).toEqual({ byteStart: 5, byteEnd: 29 });
    expect(facets[0]?.features[0]?.uri).toBe('https://example.com/docs');
  });

  test('counts bytes, not JavaScript string indices', () => {
    // The emoji is two UTF-16 units and four UTF-8 bytes. A naive
    // implementation puts byteStart at 3 and underlines the wrong span.
    const text = '👋 https://example.com';
    const facets = detectFacets(text);

    expect(text.indexOf('https')).toBe(3);
    expect(facets[0]?.index.byteStart).toBe(5);
  });

  test('handles non-Latin text before a link', () => {
    const text = 'こんにちは https://example.com';
    const facets = detectFacets(text);

    // Five characters at three bytes each, plus the space.
    expect(facets[0]?.index.byteStart).toBe(16);
  });

  test('drops sentence punctuation from the link', () => {
    const facets = detectFacets('see https://example.com/docs.');

    expect(facets[0]?.features[0]?.uri).toBe('https://example.com/docs');
  });

  test('finds nothing in a post with no links', () => {
    expect(detectFacets('just a message')).toEqual([]);
  });

  test('spans every link in a post', () => {
    expect(detectFacets('https://a.dev and https://b.dev')).toHaveLength(2);
  });
});

describe('fitPost', () => {
  test('leaves a short post alone', () => {
    expect(fitPost('hello there')).toBe('hello there');
  });

  test('counts graphemes rather than UTF-16 units', () => {
    // 200 emoji: `String.length` says 400 and would truncate for no reason.
    const post = '👍'.repeat(200);

    expect(post.length).toBe(400);
    expect(fitPost(post)).toBe(post);
  });

  test('trims a genuinely over-long post', () => {
    const post = 'word '.repeat(200);
    const fitted = fitPost(post);

    const graphemes = [
      ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(fitted),
    ];
    expect(graphemes.length).toBeLessThanOrEqual(POST_GRAPHEME_LIMIT);
    expect(fitted.endsWith('…')).toBe(true);
  });

  test('breaks on a word rather than mid-word', () => {
    const fitted = fitPost(`${'alpha '.repeat(60)}beta`, 20);

    expect(fitted).not.toContain('alph…');
  });
});

describe('postUriFromUrl', () => {
  test('builds an at-uri from a permalink', () => {
    expect(postUriFromUrl('https://bsky.app/profile/alex.bsky.social/post/3k2a', 'did:plc:x')).toBe(
      'at://did:plc:x/app.bsky.feed.post/3k2a',
    );
  });

  test('returns nothing for a profile url', () => {
    expect(
      postUriFromUrl('https://bsky.app/profile/alex.bsky.social', 'did:plc:x'),
    ).toBeUndefined();
  });
});

describe('BlueskyAgent', () => {
  test('logs in and keeps the session', async () => {
    const { fetchImpl, calls } = recorder({ createSession: json(200, SESSION) });
    const agent = new BlueskyAgent({ fetchImpl });

    const session = await agent.login('@me.bsky.social', 'app-pw');

    expect(session.did).toBe('did:plc:me');
    // The leading @ is stripped: Bluesky rejects the identifier with it.
    expect((calls[0]?.body as { identifier: string }).identifier).toBe('me.bsky.social');
  });

  test('raises a typed error for a bad app password', async () => {
    const { fetchImpl } = recorder({
      createSession: json(401, { error: 'AuthenticationRequired' }),
    });
    const agent = new BlueskyAgent({ fetchImpl });

    expect(agent.login('me.bsky.social', 'wrong')).rejects.toThrow(BlueskyAuthError);
  });

  test('refuses to post without a session', async () => {
    const { fetchImpl } = recorder({});
    const agent = new BlueskyAgent({ fetchImpl });

    expect(agent.reply({ text: 'hi', parent: { uri: 'at://x', cid: 'c1' } })).rejects.toThrow(
      BlueskyAuthError,
    );
  });

  test('replies with the thread root and the parent', async () => {
    const { fetchImpl, calls } = recorder({
      createSession: json(200, SESSION),
      createRecord: json(200, { uri: 'at://did:plc:me/app.bsky.feed.post/new', cid: 'c9' }),
    });
    const agent = new BlueskyAgent({ fetchImpl });
    await agent.login('me.bsky.social', 'pw');

    const parent = { uri: 'at://them/app.bsky.feed.post/2', cid: 'c2' };
    const root = { uri: 'at://them/app.bsky.feed.post/1', cid: 'c1' };
    const posted = await agent.reply({ text: 'good point about https://a.dev', parent, root });

    expect(posted.cid).toBe('c9');

    const record = (calls[1]?.body as { record: Record<string, unknown> }).record;
    expect(record.reply).toEqual({ root, parent });
    // Facets travel with the post, or the link is plain text nobody can click.
    expect(record.facets).toHaveLength(1);
    expect(calls[1]?.auth).toBe('Bearer jwt-1');
  });

  test('treats the parent as the root at the top of a thread', async () => {
    const { fetchImpl, calls } = recorder({
      createSession: json(200, SESSION),
      createRecord: json(200, { uri: 'at://x', cid: 'c9' }),
    });
    const agent = new BlueskyAgent({ fetchImpl });
    await agent.login('me.bsky.social', 'pw');

    const parent = { uri: 'at://them/app.bsky.feed.post/1', cid: 'c1' };
    await agent.reply({ text: 'hi', parent });

    const record = (calls[1]?.body as { record: { reply: { root: unknown } } }).record;
    expect(record.reply.root).toEqual(parent);
  });

  test('writes a follow to the right collection', async () => {
    const { fetchImpl, calls } = recorder({
      createSession: json(200, SESSION),
      createRecord: json(200, { uri: 'at://f', cid: 'cf' }),
    });
    const agent = new BlueskyAgent({ fetchImpl });
    await agent.login('me.bsky.social', 'pw');

    await agent.follow('did:plc:them');

    const body = calls[1]?.body as { collection: string; record: { subject: string } };
    expect(body.collection).toBe('app.bsky.graph.follow');
    expect(body.record.subject).toBe('did:plc:them');
  });

  test('surfaces a rate limit as a typed write error', async () => {
    const { fetchImpl } = recorder({
      createSession: json(200, SESSION),
      createRecord: new Response('slow down', { status: 429 }),
    });
    const agent = new BlueskyAgent({ fetchImpl });
    await agent.login('me.bsky.social', 'pw');

    expect(agent.reply({ text: 'hi', parent: { uri: 'at://x', cid: 'c1' } })).rejects.toThrow(
      BlueskyWriteError,
    );
  });

  test('reads a post’s cid so a reply can pin the version it answers', async () => {
    const { fetchImpl } = recorder({
      getPosts: json(200, { posts: [{ uri: 'at://them/post/1', cid: 'c1' }] }),
    });
    const agent = new BlueskyAgent({ fetchImpl });

    expect(await agent.getPost('at://them/post/1')).toEqual({ uri: 'at://them/post/1', cid: 'c1' });
  });

  test('returns nothing for a post that is gone', async () => {
    const { fetchImpl } = recorder({ getPosts: json(200, { posts: [] }) });
    const agent = new BlueskyAgent({ fetchImpl });

    expect(await agent.getPost('at://them/post/gone')).toBeUndefined();
  });
});
