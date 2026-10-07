import { describe, expect, test } from 'bun:test';
import { SearchOutOfCredits, type WebSearcher } from '../valueserp';
import { quoteGroups, redditPostId, WebDiscussionSource } from './web-discussions';

describe('WebDiscussionSource', () => {
  test('one query per site, quoted OR groups, threads only, Reddit filled in from the archive', async () => {
    const queries: Array<{ q: string; period?: string }> = [];
    const searcher: WebSearcher = {
      search: async (q, options) => {
        queries.push({ q, ...(options?.period ? { period: options.period } : {}) });
        if (q.startsWith('site:reddit.com'))
          return [
            {
              title: 'I have a question about network IDS : r/Wazuh',
              link: 'https://www.reddit.com/r/Wazuh/comments/1WYS9L1/i_have_a_question/',
              snippet: 'short',
            },
            { title: 'r/selfhosted', link: 'https://www.reddit.com/r/selfhosted/' },
          ];
        if (q.startsWith('site:serverfault.com'))
          return [
            {
              title: 'Which intrusion detection for a small VPS fleet?',
              link: 'https://serverfault.com/questions/12345/which-ids',
              snippet: 'Looking for intrusion detection that is light on resources.',
            },
            { title: 'Tag', link: 'https://serverfault.com/tags/ids' },
          ];
        return [];
      },
    };
    const archiveCalls: string[] = [];
    const source = new WebDiscussionSource({
      searcher,
      concurrency: 1,
      sites: ['reddit.com', 'serverfault.com'],
      termsPerQuery: 2,
      fetchImpl: (async (url: string) => {
        archiveCalls.push(url);
        return new Response(
          JSON.stringify({
            data: [
              {
                id: '1wys9l1',
                author: 'opsperson',
                title: 'I have a question about network IDS integration',
                selftext: 'Which intrusion detection do you run next to Wazuh?',
                subreddit: 'Wazuh',
                created_utc: Math.floor(Date.now() / 1000) - 3600,
              },
            ],
          }),
        );
      }) as unknown as typeof fetch,
    });

    const posts = await source.search({
      terms: ['intrusion detection', 'wazuh', 'siem'],
      since: new Date(Date.now() - 6 * 3_600_000),
    });

    expect(queries).toEqual([
      { q: 'site:reddit.com ("intrusion detection" OR "wazuh")', period: 'last_day' },
      { q: 'site:reddit.com ("siem")', period: 'last_day' },
      { q: 'site:serverfault.com ("intrusion detection" OR "wazuh")', period: 'last_day' },
      { q: 'site:serverfault.com ("siem")', period: 'last_day' },
    ]);
    expect(archiveCalls).toEqual([
      'https://arctic-shift.photon-reddit.com/api/posts/ids?ids=1wys9l1',
    ]);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      network: 'reddit',
      externalId: '1wys9l1',
      authorHandle: 'opsperson',
      container: 'r/Wazuh',
      url: 'https://www.reddit.com/r/Wazuh/comments/1wys9l1/',
    });
    expect(posts[1]).toMatchObject({
      network: 'website',
      externalId: 'https://serverfault.com/questions/12345/which-ids',
      container: 'serverfault.com',
    });
  });

  test('one slow query is retried and costs only itself; all failing, or no credits, fails the source', async () => {
    let calls = 0;
    const flaky = new WebDiscussionSource({
      searcher: {
        search: async (q) => {
          calls += 1;
          if (q.includes('quora') || (q.includes('serverfault') && calls < 2))
            throw new Error('ValueSERP did not answer within 90 s');
          return q.includes('serverfault')
            ? [{ title: 'IDS?', link: 'https://serverfault.com/questions/1/ids', snippet: 'siem?' }]
            : [];
        },
      },
      sites: ['serverfault.com', 'quora.com'],
      concurrency: 1,
      archiveUrl: null,
    });
    const posts = await flaky.search({ terms: ['siem'] });
    expect(posts.map((p) => p.externalId)).toEqual(['https://serverfault.com/questions/1/ids']);

    const down = new WebDiscussionSource({
      searcher: {
        search: async () => {
          throw new Error('ValueSERP did not answer within 90 s');
        },
      },
      archiveUrl: null,
    });
    await expect(down.search({ terms: ['siem'] })).rejects.toThrow('did not answer');

    let searched = 0;
    const broke = new WebDiscussionSource({
      searcher: {
        search: async () => {
          searched += 1;
          throw new SearchOutOfCredits('ValueSERP');
        },
      },
      concurrency: 1,
      archiveUrl: null,
    });
    await expect(broke.search({ terms: ['siem'] })).rejects.toThrow('out of credits');
    expect(searched).toBe(1);
  });

  test('helpers', () => {
    expect(quoteGroups(['a', 'b "c"', 'a', 'd'], 2)).toEqual(['"a" OR "b c"', '"d"']);
    expect(redditPostId('https://old.reddit.com/r/x/comments/AbC12/title/')).toBe('abc12');
    expect(redditPostId('https://www.reddit.com/r/x/')).toBeUndefined();
  });
});
