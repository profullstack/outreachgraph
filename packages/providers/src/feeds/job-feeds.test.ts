/**
 * Public job feeds: what has to hold is that a posting becomes a company with
 * its own domain where the post names one (never a job board's), that a feed
 * matches a role keyword loosely ("contract" is the offer, not a filter), and
 * that Himalayas keeps only postings open to the United States.
 */

import { describe, expect, test } from 'bun:test';
import {
  addressesIn,
  employerDomain,
  HimalayasFeed,
  HnHiringFeed,
  hnPost,
  matchesJobKeyword,
} from './job-feeds';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return json(body);
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('matching a role keyword', () => {
  test('"contract" is the offer, not a filter', () => {
    expect(matchesJobKeyword('contract software engineer', 'Senior Software Engineer')).toBe(true);
    expect(matchesJobKeyword('contract full stack engineer', 'Full-Stack Engineer, Remote')).toBe(
      true,
    );
    expect(matchesJobKeyword('contract full stack engineer', 'Fullstack developer')).toBe(true);
  });

  test('needs a role word and every other word', () => {
    expect(matchesJobKeyword('contract software engineer', 'Account Executive, software')).toBe(
      false,
    );
    expect(matchesJobKeyword('contract full stack engineer', 'Backend Engineer')).toBe(false);
  });
});

describe('the employer domain', () => {
  test('a company site, with careers. and jobs. folded in', () => {
    expect(employerDomain('https://www.prairielearn.com/')).toBe('prairielearn.com');
    expect(employerDomain('https://careers.acme.io/roles')).toBe('acme.io');
  });

  test('never a job board or a link host', () => {
    expect(employerDomain('https://jobs.ashbyhq.com/acme/123')).toBeUndefined();
    expect(employerDomain('https://boards.greenhouse.io/acme')).toBeUndefined();
    expect(employerDomain('https://www.ycombinator.com/companies/acme')).toBeUndefined();
    expect(employerDomain('https://forms.gle/abc')).toBeUndefined();
  });

  test('addresses, including the [at] spelling', () => {
    expect(addressesIn('mail jane [at] acme [dot] com or jobs@acme.com.')).toEqual([
      'jane@acme.com',
      'jobs@acme.com',
    ]);
  });
});

describe('Hacker News: Who is hiring', () => {
  const comment = {
    id: 4242,
    author: 'janedoe',
    created_at: '2026-10-02T15:00:00Z',
    text:
      'Acme Robotics | Senior Full-Stack Engineer | REMOTE (US) | ' +
      '<a href="https:&#x2F;&#x2F;acmerobotics.com&#x2F;jobs" rel="nofollow">https:&#x2F;&#x2F;acmerobotics.com&#x2F;jobs</a>' +
      '<p>We build robots in TypeScript. Email jane@acmerobotics.com with a note.',
  };

  test('a post is a company, its site and the addresses it publishes', () => {
    const post = hnPost(comment);
    expect(post?.company).toBe('Acme Robotics');
    expect(post?.domain).toBe('acmerobotics.com');
    expect(post?.emails).toEqual(['jane@acmerobotics.com']);
    expect(post?.author).toBe('janedoe');
    expect(post?.url).toBe('https://news.ycombinator.com/item?id=4242');
  });

  test('reads the newest thread and keeps the postings that match', async () => {
    const feed = new HnHiringFeed({
      threads: 1,
      fetchImpl: fakeFetch({
        'https://hn.algolia.com/api/v1/search_by_date': {
          hits: [
            { objectID: '2', title: 'Ask HN: Who wants to be hired? (October 2026)' },
            { objectID: '1', title: 'Ask HN: Who is hiring? (October 2026)' },
          ],
        },
        'https://hn.algolia.com/api/v1/items/1': {
          children: [
            comment,
            { id: 4343, author: 'x', text: 'Beta Corp | Account Executive | NYC' },
            { id: 4444, author: 'y', text: null },
          ],
        },
      }),
    });
    const posts = await feed.search({ keyword: 'contract full stack engineer', limit: 10 });
    expect(posts.map((p) => p.company)).toEqual(['Acme Robotics']);
  });
});

describe('Himalayas', () => {
  test('keeps only postings open to the United States, paging until the limit', async () => {
    const job = (company: string, where: string[]) => ({
      title: 'Senior Software Engineer',
      companyName: company,
      excerpt: 'TypeScript',
      locationRestrictions: where,
      pubDate: 1_793_000_000,
      guid: `https://himalayas.app/companies/${company}/jobs/1`,
    });
    const feed = new HimalayasFeed({
      pages: 2,
      fetchImpl: fakeFetch({
        'https://himalayas.app/jobs/api/search?q=software%20engineer&page=1': {
          jobs: [job('us-co', ['United States']), job('br-co', ['Brazil'])],
        },
        'https://himalayas.app/jobs/api/search?q=software%20engineer&page=2': {
          jobs: [job('anywhere-co', [])],
        },
      }),
    });
    const posts = await feed.search({ keyword: 'contract software engineer', limit: 10 });
    expect(posts.map((p) => p.company)).toEqual(['us-co', 'anywhere-co']);
    expect(posts[0]?.postedAt).toBe(new Date(1_793_000_000 * 1000).toISOString());
  });
});
