import { describe, expect, test } from 'bun:test';
import type { FetchLike } from '../site/fetch';
import { BlueskyFeedSource } from './bluesky';
import { NostrSource, type NostrSocket } from './nostr';
import { RedditSource } from './reddit';
import { RssSource } from './rss';
import { classifyPost, excerpt, mentionsTerm, FeedRateLimitError } from './source';

/** Answers every request with one body, and records what was asked. */
function stub(body: unknown, status = 200): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];

  const fetchImpl: FetchLike = async (input) => {
    urls.push(input.toString());
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  };

  return { fetch: fetchImpl, urls };
}

describe('classifyPost', () => {
  test('recognises a recommendation request, the signal this product exists for', () => {
    expect(classifyPost('Can anyone recommend a decent invoicing tool?').type).toBe(
      'recommendation_request',
    );
    expect(classifyPost('Looking for a field service app for a 6-van outfit').type).toBe(
      'recommendation_request',
    );
    expect(classifyPost('any alternatives to QuickBooks for a small shop').type).toBe(
      'recommendation_request',
    );
  });

  test('a recommendation request outranks the question it also is', () => {
    // "does anyone recommend an alternative to X?" is both. Reading it as the
    // weaker type would cost it its ranking in the queue.
    const both = classifyPost('Does anyone recommend an alternative to our current system?');
    expect(both.type).toBe('recommendation_request');
  });

  test('recognises switching away from a competitor', () => {
    expect(classifyPost('We are migrating off Salesforce next quarter').type).toBe(
      'competitor_mention',
    );
  });

  test('recognises the manual-work complaint that sells most software', () => {
    expect(classifyPost('Still doing all our scheduling by hand and it takes hours').type).toBe(
      'pain',
    );
  });

  test('falls back to weak types rather than inventing intent', () => {
    // A run that finds only chatter must rank it below real buying signals,
    // not promote it to the top of somebody's queue.
    expect(classifyPost('What time does the trade show open?').type).toBe('public_question');
    expect(classifyPost('Here is a photo of our new van.').type).toBe('content_topic');
    expect(classifyPost('Here is a photo of our new van.').confidence).toBeLessThan(0.5);
  });
});

describe('mentionsTerm', () => {
  test('keeps only posts that really contain a term', () => {
    // Platform search is loose; without this a campaign for "payment
    // reconciliation" collects every post containing "payment".
    expect(mentionsTerm('we need payment reconciliation', ['payment reconciliation'])).toBe(true);
    expect(mentionsTerm('we take payment by card', ['payment reconciliation'])).toBe(false);
  });

  test('no terms means no filter', () => {
    expect(mentionsTerm('anything at all', [])).toBe(true);
  });
});

describe('excerpt', () => {
  test('collapses whitespace and truncates', () => {
    expect(excerpt('a\n\n  b')).toBe('a b');
    expect(excerpt('x'.repeat(700))).toHaveLength(600);
  });
});

describe('RedditSource', () => {
  const listing = {
    data: {
      children: [
        {
          kind: 't3',
          data: {
            id: 'abc123',
            author: 'plumber_pete',
            title: 'Can anyone recommend job scheduling software?',
            selftext: 'Running 6 vans and still doing scheduling by hand.',
            permalink: '/r/plumbing/comments/abc123/x/',
            subreddit: 'plumbing',
            created_utc: 1_760_000_000,
          },
        },
      ],
    },
  };

  test('returns the post, its author and a link a human can open', async () => {
    const { fetch } = stub(listing);
    const source = new RedditSource({ fetchImpl: fetch });

    const posts = await source.search({ terms: ['scheduling'] });

    expect(posts).toHaveLength(1);
    expect(posts[0]?.authorHandle).toBe('plumber_pete');
    expect(posts[0]?.url).toBe('https://www.reddit.com/r/plumbing/comments/abc123/x/');
    expect(posts[0]?.container).toBe('r/plumbing');
    expect(posts[0]?.network).toBe('reddit');
  });

  test('scopes to the configured subreddits', async () => {
    // The single highest-leverage setting for a non-technical campaign: three
    // trade subreddits beat an unscoped search of all of Reddit.
    const { fetch, urls } = stub(listing);
    const source = new RedditSource({ fetchImpl: fetch, subreddits: ['plumbing', 'hvac'] });

    await source.search({ terms: ['scheduling'] });

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/r/plumbing/search.json');
    expect(urls[0]).toContain('restrict_sr=on');
    expect(urls[1]).toContain('/r/hvac/search.json');
  });

  test('quotes multi-word terms so they are not split', async () => {
    // Unquoted, "field service software" silently becomes any post containing
    // "software".
    const { fetch, urls } = stub(listing);
    await new RedditSource({ fetchImpl: fetch }).search({ terms: ['field service software'] });

    // `URLSearchParams` writes spaces as `+`, so read the value back the way
    // Reddit will rather than by decoding the raw string.
    const query = new URL(urls[0] ?? '').searchParams.get('q');
    expect(query).toBe('"field service software"');
  });

  test('drops deleted authors, bots and NSFW posts', async () => {
    const { fetch } = stub({
      data: {
        children: [
          { data: { id: '1', author: '[deleted]', title: 'recommend something', created_utc: 1 } },
          { data: { id: '2', author: 'AutoModerator', title: 'recommend something' } },
          { data: { id: '3', author: 'real', title: 'recommend something', over_18: true } },
        ],
      },
    });

    const posts = await new RedditSource({ fetchImpl: fetch }).search({ terms: ['recommend'] });
    expect(posts).toHaveLength(0);
  });

  test('sends a descriptive user agent, which Reddit requires', async () => {
    // A generic or absent agent is refused with a 429 that reads like a rate
    // limit rather than a rejection.
    let agent: string | undefined;
    const fetchImpl: FetchLike = async (_input, init) => {
      agent = new Headers(init?.headers).get('user-agent') ?? undefined;
      return new Response('{}', { status: 200 });
    };

    await new RedditSource({ fetchImpl }).search({ terms: ['x'] });
    expect(agent).toContain('outreachgraph');
  });

  test('raises a typed error on a rate limit so a run keeps partial work', async () => {
    const { fetch } = stub({}, 429);
    await expect(new RedditSource({ fetchImpl: fetch }).search({ terms: ['x'] })).rejects.toThrow(
      FeedRateLimitError,
    );
  });

  test('no terms means no request at all', async () => {
    const { fetch, urls } = stub(listing);
    expect(await new RedditSource({ fetchImpl: fetch }).search({ terms: [] })).toHaveLength(0);
    expect(urls).toHaveLength(0);
  });
});

describe('RssSource', () => {
  const feed = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>Trade Weekly</title>
      <item>
        <title>Shop owners say scheduling is their biggest headache</title>
        <description><![CDATA[<p>Still doing it by hand, owners told us.</p>]]></description>
        <link>https://trade.example/story-1</link>
        <guid>story-1</guid>
        <pubDate>Wed, 06 Aug 2026 10:00:00 GMT</pubDate>
        <dc:creator>A. Reporter</dc:creator>
      </item>
      <item>
        <title>Unrelated piece about paint</title>
        <description>Nothing to do with it.</description>
        <link>https://trade.example/story-2</link>
        <pubDate>Wed, 06 Aug 2026 11:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;

  test('matches terms locally, because a feed has no search', async () => {
    const { fetch } = stub(feed);
    const source = new RssSource({ feedUrls: ['https://trade.example/feed'], fetchImpl: fetch });

    const posts = await source.search({ terms: ['scheduling'] });

    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe('https://trade.example/story-1');
    expect(posts[0]?.container).toBe('Trade Weekly');
    expect(posts[0]?.authorHandle).toBe('A. Reporter');
  });

  test('unwraps CDATA and strips markup out of the body', async () => {
    const { fetch } = stub(feed);
    const posts = await new RssSource({
      feedUrls: ['https://trade.example/feed'],
      fetchImpl: fetch,
    }).search({ terms: ['scheduling'] });

    expect(posts[0]?.text).toContain('Still doing it by hand');
    expect(posts[0]?.text).not.toContain('<p>');
  });

  test('reads Atom entries and their alternate link', async () => {
    // Taking the first `link` indiscriminately makes every item point back at
    // the feed itself.
    const atom = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Local News</title>
        <link rel="self" href="https://news.example/feed"/>
        <entry>
          <title>Council seeks invoicing supplier</title>
          <link rel="alternate" href="https://news.example/story"/>
          <id>tag:news,2026:1</id>
          <updated>2026-08-06T10:00:00Z</updated>
          <summary>Looking for a supplier.</summary>
        </entry>
      </feed>`;

    const { fetch } = stub(atom);
    const posts = await new RssSource({
      feedUrls: ['https://news.example/feed'],
      fetchImpl: fetch,
    }).search({ terms: ['invoicing'] });

    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe('https://news.example/story');
  });

  test('one dead feed does not cost the run the others', async () => {
    let call = 0;
    const fetchImpl: FetchLike = async () => {
      call += 1;
      if (call === 1) throw new Error('connection refused');
      return new Response(feed, { status: 200 });
    };

    const posts = await new RssSource({
      feedUrls: ['https://down.example/feed', 'https://trade.example/feed'],
      fetchImpl,
    }).search({ terms: ['scheduling'] });

    expect(posts).toHaveLength(1);
  });
});

describe('BlueskyFeedSource', () => {
  const response = {
    posts: [
      {
        uri: 'at://did:plc:abc/app.bsky.feed.post/xyz789',
        author: { did: 'did:plc:abc', handle: 'pete.bsky.social', displayName: 'Pete' },
        record: {
          text: 'anyone recommend a good invoicing tool?',
          createdAt: '2026-08-06T10:00:00Z',
        },
      },
    ],
  };

  test('turns an at:// uri into a link a reviewer can click', async () => {
    const { fetch } = stub(response);
    const posts = await new BlueskyFeedSource({ fetchImpl: fetch }).search({
      terms: ['invoicing'],
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe('https://bsky.app/profile/pete.bsky.social/post/xyz789');
    expect(posts[0]?.authorHandle).toBe('pete.bsky.social');
  });

  test('searches one term at a time, since the endpoint has no OR', async () => {
    // A space-joined query is an implicit AND that matches almost nothing.
    const { fetch, urls } = stub(response);
    await new BlueskyFeedSource({ fetchImpl: fetch }).search({
      terms: ['invoicing', 'scheduling'],
    });

    expect(urls).toHaveLength(2);
  });

  test('does not return the same post twice across terms', async () => {
    const { fetch } = stub(response);
    const posts = await new BlueskyFeedSource({ fetchImpl: fetch }).search({
      terms: ['invoicing', 'recommend'],
    });

    expect(posts).toHaveLength(1);
  });
});

describe('NostrSource', () => {
  /** A relay that replies with stored events and then EOSE. */
  function relay(events: unknown[]): () => NostrSocket {
    return () => {
      const handlers: Record<string, ((event?: { data: unknown }) => void)[]> = {};

      const socket: NostrSocket = {
        send: () => {
          for (const event of events) {
            for (const handler of handlers.message ?? []) {
              handler({ data: JSON.stringify(['EVENT', 'og-1-25', event]) });
            }
          }
          for (const handler of handlers.message ?? []) {
            handler({ data: JSON.stringify(['EOSE', 'og-1-25']) });
          }
        },
        close: () => {},
        addEventListener: (type: string, handler: (event?: { data: unknown }) => void) => {
          (handlers[type] ??= []).push(handler);
          if (type === 'open') queueMicrotask(() => handler());
        },
      } as NostrSocket;

      return socket;
    };
  }

  test('closes on EOSE rather than streaming forever', async () => {
    // A subscription does not end on its own; without this the query never
    // returns.
    const source = new NostrSource({
      relays: ['wss://relay.test'],
      socketFactory: relay([
        {
          id: 'e1',
          pubkey: 'npubabc',
          kind: 1,
          created_at: 1_760_000_000,
          content: 'anyone recommend a bookkeeper?',
        },
      ]),
    });

    const posts = await source.search({ terms: ['bookkeeper'], limit: 25 });

    expect(posts).toHaveLength(1);
    expect(posts[0]?.authorHandle).toBe('npubabc');
    expect(posts[0]?.url).toBe('https://njump.me/e1');
  });

  test('filters locally, because not every relay implements search', async () => {
    // A relay without NIP-50 ignores the field and streams recent notes; that
    // would otherwise turn a targeted search into a firehose.
    const source = new NostrSource({
      relays: ['wss://relay.test'],
      socketFactory: relay([
        { id: 'e1', pubkey: 'a', kind: 1, created_at: 1, content: 'gm' },
        { id: 'e2', pubkey: 'b', kind: 1, created_at: 1, content: 'need a bookkeeper' },
      ]),
    });

    const posts = await source.search({ terms: ['bookkeeper'] });
    expect(posts.map((p) => p.externalId)).toEqual(['e2']);
  });

  test('a relay that refuses to connect is skipped, not fatal', async () => {
    // Relays are independent volunteers; one being down is the normal case.
    const source = new NostrSource({
      relays: ['wss://down.test', 'wss://up.test'],
      socketFactory: ((url: string) => {
        if (url === 'wss://down.test') throw new Error('refused');
        return relay([
          { id: 'e1', pubkey: 'a', kind: 1, created_at: 1, content: 'need a bookkeeper' },
        ])();
      }) as never,
    });

    const posts = await source.search({ terms: ['bookkeeper'] });
    expect(posts).toHaveLength(1);
  });

  test('times out on a relay that connects and says nothing', async () => {
    const source = new NostrSource({
      relays: ['wss://silent.test'],
      timeoutMs: 20,
      socketFactory: () =>
        ({
          send: () => {},
          close: () => {},
          addEventListener: (type: string, handler: () => void) => {
            if (type === 'open') queueMicrotask(handler);
          },
        }) as unknown as NostrSocket,
    });

    expect(await source.search({ terms: ['x'] })).toHaveLength(0);
  });
});
