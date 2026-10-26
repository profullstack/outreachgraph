/**
 * Launch radar: the makers of new launches, found and taken in with the
 * launch as evidence.
 *
 * What has to hold: each source reads only launches inside the window that
 * mention a phrase; one busy source cannot fill a run; Bluesky counts only
 * announcements; a failing source is reported, not fatal. Intake makes one
 * person per maker with the address and site their profile publishes, writes
 * the launch as a signal, leaves a launch it has seen alone, and never takes
 * in our own launches.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  DevToSource,
  GitHubClient,
  GitHubRepoSource,
  HackerNewsSource,
  type FeedPost,
  type FeedSource,
} from '@outreachgraph/providers';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { findLaunches, intakeLaunches, publishedEmail, resolveMaker } from './launch-radar';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

async function db(label: string): Promise<Client> {
  seeded = await seedDatabase(label);
  return seeded.db;
}

const AT = new Date('2026-10-26T18:00:00Z');
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function fakeFetch(routes: Record<string, unknown>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return json(body);
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const post = (overrides: Partial<FeedPost>): FeedPost => ({
  network: 'github',
  externalId: 'x',
  authorHandle: 'maker',
  url: 'https://github.com/maker/thing',
  text: 'a voice agent',
  postedAt: '2026-10-26T12:00:00Z',
  ...overrides,
});

describe('launch sources', () => {
  test('dev.to: newest articles in the window that mention a phrase, with the author links', async () => {
    const source = new DevToSource({
      fetchImpl: fakeFetch({
        'https://dev.to/api/articles/latest?per_page=1000&page=1': [
          {
            id: 1,
            title: 'I built a voice agent that joins phone calls',
            description: 'Show and tell',
            url: 'https://dev.to/ada/voice-1',
            published_at: '2026-10-26T15:00:00Z',
            tag_list: ['ai'],
            user: {
              username: 'ada',
              name: 'Ada',
              github_username: 'ada-gh',
              twitter_username: 'ada_x',
              website_url: 'https://ada.dev',
            },
          },
          {
            id: 2,
            title: 'Unrelated CSS tricks',
            url: 'https://dev.to/bob/css',
            published_at: '2026-10-26T14:00:00Z',
            user: { username: 'bob' },
          },
          {
            id: 3,
            title: 'An old voice agent post',
            url: 'https://dev.to/cy/old',
            published_at: '2026-10-20T14:00:00Z',
            user: { username: 'cy' },
          },
        ],
      }),
    });
    const posts = await source.search({
      terms: ['voice agent'],
      since: new Date('2026-10-25T18:00:00Z'),
    });
    expect(posts.map((p) => p.url)).toEqual(['https://dev.to/ada/voice-1']);
    expect(posts[0]!.authorLinks).toEqual([
      'https://github.com/ada-gh',
      'https://x.com/ada_x',
      'https://ada.dev',
    ]);
    expect(posts[0]!.container).toBe('dev.to');
  });

  test('Hacker News reads Show HN and Launch HN only', async () => {
    const seen: string[] = [];
    const source = new HackerNewsSource({
      tags: '(show_hn,launch_hn)',
      gapMs: 0,
      fetchImpl: fakeFetch({ 'https://hn.algolia.com': { hits: [] } }, seen),
    });
    await source.search({ terms: ['voice agent'] });
    expect(new URL(seen[0]!).searchParams.get('tags')).toBe('(show_hn,launch_hn)');
  });

  test('GitHub searches repositories created inside the window, owner as author', async () => {
    const seen: string[] = [];
    const source = new GitHubRepoSource({
      fetchImpl: fakeFetch(
        {
          'https://api.github.com/search/repositories': {
            items: [
              {
                full_name: 'ada/callbot',
                html_url: 'https://github.com/ada/callbot',
                description: 'voice agent for calls',
                created_at: '2026-10-26T10:00:00Z',
                fork: false,
                stargazers_count: 0,
                name: 'callbot',
                language: 'TypeScript',
                pushed_at: null,
                owner: { login: 'ada', type: 'User' },
              },
            ],
          },
        },
        seen,
      ),
    });
    const posts = await source.search({
      terms: ['voice agent'],
      since: new Date('2026-10-25T18:00:00Z'),
    });
    expect(new URL(seen[0]!).searchParams.get('q')).toBe(
      '"voice agent" created:>=2026-10-25 fork:false',
    );
    expect(posts[0]).toMatchObject({ authorHandle: 'ada', url: 'https://github.com/ada/callbot' });
  });
});

describe('findLaunches', () => {
  const fixed = (slug: string, posts: FeedPost[]): FeedSource => ({
    network: 'github',
    slug,
    displayName: slug,
    search: async () => posts,
  });

  test('takes sources in turn, keeps only Bluesky announcements, reports a failing source', async () => {
    const busy = Array.from({ length: 5 }, (_, i) =>
      post({ url: `https://github.com/a/${i}`, postedAt: `2026-10-26T1${i}:00:00Z` }),
    );
    const failing: FeedSource = {
      ...fixed('devto', []),
      search: async () => {
        throw new Error('dev.to down');
      },
    };
    const found = await findLaunches(
      [
        fixed('github', busy),
        fixed('bluesky', [
          post({
            network: 'bluesky',
            url: 'https://bsky.app/1',
            text: 'just shipped a voice agent',
          }),
          post({
            network: 'bluesky',
            url: 'https://bsky.app/2',
            text: 'voice agents are overhyped',
          }),
        ]),
        failing,
      ],
      { terms: ['voice agent'], since: AT, limit: 3 },
    );
    expect(found.posts.map((p) => p.url)).toEqual([
      'https://github.com/a/4',
      'https://bsky.app/1',
      'https://github.com/a/3',
    ]);
    expect(found.bySource).toEqual({ github: 5, bluesky: 1, devto: 'dev.to down' });
  });
});

describe('publishedEmail', () => {
  test('reads plain and bracket-obfuscated addresses, never a noreply', () => {
    expect(publishedEmail('reach me: ada [at] callbot [dot] dev')).toBe('ada@callbot.dev');
    expect(publishedEmail('Ada@Example.io or https://ada.io')).toBe('ada@example.io');
    expect(publishedEmail('123+ada@users.noreply.github.com')).toBeUndefined();
  });
});

describe('resolveMaker', () => {
  test('a dev.to author with a GitHub account becomes that GitHub person', async () => {
    const github = new GitHubClient({
      fetchImpl: fakeFetch({
        'https://api.github.com/users/ada-gh': {
          login: 'ada-gh',
          id: 7,
          name: 'Ada L',
          email: 'ada@callbot.dev',
          blog: 'callbot.dev',
          bio: 'voice things',
          html_url: 'https://github.com/ada-gh',
        },
      }),
    });
    const maker = await resolveMaker(
      post({
        network: 'website',
        container: 'dev.to',
        authorHandle: 'ada',
        url: 'https://dev.to/ada/voice-1',
        authorLinks: ['https://github.com/ada-gh', 'https://ada.dev'],
      }),
      { github },
    );
    expect(maker.person).toMatchObject({
      network: 'github',
      handle: 'ada-gh',
      displayName: 'Ada L',
    });
    expect(maker.email).toBe('ada@callbot.dev');
    expect(maker.website).toBe('https://callbot.dev');
  });
});

describe('intakeLaunches', () => {
  const github = new GitHubClient({
    fetchImpl: fakeFetch({
      'https://api.github.com/users/ada': {
        login: 'ada',
        id: 11,
        name: 'Ada',
        email: 'ada@callbot.dev',
        blog: 'https://callbot.dev',
        bio: 'Building callbot',
        html_url: 'https://github.com/ada',
      },
    }),
  });

  test('one person per maker, with the published address, the site and the launch as evidence', async () => {
    const client = await db('launch-intake');
    const launch = post({
      authorHandle: 'ada',
      url: 'https://github.com/ada/callbot',
      title: 'ada/callbot',
      text: 'voice agent that joins calls',
    });
    const first = await intakeLaunches(
      { db: client, makers: { github }, now: AT },
      { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId, posts: [launch] },
    );
    expect(first).toMatchObject({ launches: 1, people: 1, created: 1, withEmail: 1, known: 0 });

    const person = await queryOne<{ id: string }>(
      client,
      `SELECT person_id AS id FROM social_identities WHERE network = 'github' AND handle = 'ada'`,
    );
    const identities = await queryAll<{ network: string; handle: string }>(
      client,
      'SELECT network, handle FROM social_identities WHERE person_id = ? ORDER BY network',
      [person!.id],
    );
    expect(identities).toEqual([
      { network: 'email', handle: 'ada@callbot.dev' },
      { network: 'github', handle: 'ada' },
      { network: 'website', handle: 'callbot.dev' },
    ]);
    const signal = await queryOne<{ summary: string; source_url: string }>(
      client,
      `SELECT summary, source_url FROM signals WHERE person_id = ? AND signal_type = 'launch'`,
      [person!.id],
    );
    expect(signal).toEqual({
      summary: 'Launched: ada/callbot (github)',
      source_url: 'https://github.com/ada/callbot',
    });

    const again = await intakeLaunches(
      { db: client, makers: { github }, now: AT },
      { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId, posts: [launch] },
    );
    expect(again).toMatchObject({ known: 1, people: 0 });
  });

  test('our own launches are never taken in', async () => {
    const client = await db('launch-own');
    await client.execute({
      sql: 'UPDATE offerings SET url = ? WHERE id = ?',
      args: ['https://group.call.pit.world', SEED.offeringId],
    });
    const result = await intakeLaunches(
      { db: client, makers: { github }, now: AT },
      {
        workspaceId: SEED.workspaceId,
        campaignId: SEED.campaignId,
        posts: [
          post({
            network: 'website',
            container: 'dev.to',
            url: 'https://dev.to/chovy/groupcall',
            text: 'groupcall: a party line at group.call.pit.world',
          }),
        ],
      },
    );
    expect(result).toMatchObject({ own: 1, people: 0 });
  });
});
