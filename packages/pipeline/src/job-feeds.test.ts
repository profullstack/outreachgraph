/**
 * Job feeds into a campaign: each new company is queued for a crawl with the
 * posting as a company-level `hiring` signal; a company the campaign already
 * has, an agency, or a posting seen before is passed over; a name with no
 * site gets one domain search; an address the posting publishes for a named
 * person becomes that person, and a role address becomes the company's.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import type { JobFeed, JobFeedPost, WebSearcher } from '@outreachgraph/providers';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { intakeJobFeeds, nameFromAddress } from './job-feeds';

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

const posting = (overrides: Partial<JobFeedPost>): JobFeedPost => ({
  feed: 'hn_hiring',
  url: 'https://news.ycombinator.com/item?id=1',
  company: 'Beta Labs',
  domain: 'betalabs.io',
  title: 'Beta Labs | Senior Full-Stack Engineer | Remote (US)',
  text: 'We need a senior full-stack engineer.',
  postedAt: '2026-10-02T15:00:00Z',
  emails: [],
  author: 'founder_b',
  ...overrides,
});

const feedOf = (posts: readonly JobFeedPost[]): JobFeed => ({
  slug: 'fake',
  search: async () => posts,
});

describe('intakeJobFeeds', () => {
  test('a new company: posting recorded, hiring signal, crawl queued', async () => {
    const client = await db('job-feeds-new');
    const result = await intakeJobFeeds(
      { db: client, feeds: [feedOf([posting({})])], now: AT },
      {
        workspaceId: SEED.workspaceId,
        campaignId: SEED.campaignId,
        keyword: 'contract software engineer',
        limit: 10,
      },
    );
    expect(result.companies).toBe(1);

    const job = await queryOne<{ payload_json: string }>(
      client,
      `SELECT payload_json FROM jobs WHERE kind = 'crawl_site' AND dedupe_key = ?`,
      [`crawl:${SEED.campaignId}:betalabs.io`],
    );
    expect(JSON.parse(job!.payload_json)).toEqual({
      url: 'https://betalabs.io',
      campaignId: SEED.campaignId,
    });

    const signal = await queryOne<{ signal_type: string; company_id: string; source_url: string }>(
      client,
      `SELECT s.signal_type, s.company_id, s.source_url FROM signals s
         JOIN companies co ON co.id = s.company_id WHERE co.domain = 'betalabs.io'`,
    );
    expect(signal?.signal_type).toBe('hiring');
    expect(signal?.source_url).toBe('https://news.ycombinator.com/item?id=1');

    const post = await queryOne<{ campaign_id: string; company_domain: string }>(
      client,
      'SELECT campaign_id, company_domain FROM job_posts WHERE url = ?',
      ['https://news.ycombinator.com/item?id=1'],
    );
    expect(post).toEqual({ campaign_id: SEED.campaignId, company_domain: 'betalabs.io' });

    // The next run leaves it alone.
    const again = await intakeJobFeeds(
      { db: client, feeds: [feedOf([posting({})])], now: AT },
      {
        workspaceId: SEED.workspaceId,
        campaignId: SEED.campaignId,
        keyword: 'contract software engineer',
        limit: 10,
      },
    );
    expect(again).toMatchObject({ companies: 0, known: 1 });
  });

  test('passes over companies already in the campaign, agencies and repeats in one run', async () => {
    const client = await db('job-feeds-skip');
    const result = await intakeJobFeeds(
      {
        db: client,
        feeds: [
          feedOf([
            // Acme is the seed campaign's company.
            posting({ url: 'https://x/1', company: 'Acme', domain: 'acme.com' }),
            posting({ url: 'https://x/2', company: 'Pinnacle Staffing', domain: 'pinnacle.com' }),
            posting({
              url: 'https://x/3',
              company: 'Gamma',
              domain: 'gamma.dev',
              text: 'We are hiring on behalf of our client, a fintech.',
            }),
            posting({ url: 'https://x/4', company: 'Delta', domain: 'delta.dev' }),
            posting({ url: 'https://x/5', company: 'Delta', domain: 'delta.dev' }),
          ]),
        ],
        now: AT,
      },
      {
        workspaceId: SEED.workspaceId,
        campaignId: SEED.campaignId,
        keyword: 'software engineer',
        limit: 10,
      },
    );
    expect(result).toMatchObject({ companies: 1, known: 1, agencies: 2 });
    const crawls = await queryAll<{ dedupe_key: string }>(
      client,
      `SELECT dedupe_key FROM jobs WHERE kind = 'crawl_site'`,
    );
    expect(crawls.map((c) => c.dedupe_key)).toEqual([`crawl:${SEED.campaignId}:delta.dev`]);
  });

  test('a name with no site costs one search; with none left it is skipped', async () => {
    const client = await db('job-feeds-lookup');
    const queries: string[] = [];
    const searcher: WebSearcher = {
      search: async (q: string) => {
        queries.push(q);
        return [{ link: 'https://www.epsilonai.com/', title: 'Epsilon AI', snippet: '' }];
      },
    } as unknown as WebSearcher;
    const result = await intakeJobFeeds(
      {
        db: client,
        searcher,
        feeds: [
          feedOf([
            posting({ url: 'https://h/1', company: 'Epsilon AI', domain: undefined }),
            posting({ url: 'https://h/2', company: 'Zeta Systems', domain: undefined }),
          ]),
        ],
        now: AT,
      },
      {
        workspaceId: SEED.workspaceId,
        campaignId: SEED.campaignId,
        keyword: 'software engineer',
        limit: 10,
        domainLookups: 1,
      },
    );
    expect(queries).toEqual(['"Epsilon AI" official site']);
    expect(result).toMatchObject({ companies: 1, noDomain: 1 });
  });

  test('a named address in the posting is that person; a role address is the company’s', async () => {
    const client = await db('job-feeds-people');
    const result = await intakeJobFeeds(
      {
        db: client,
        feeds: [
          feedOf([
            posting({
              emails: ['jane.doe@betalabs.io', 'jobs@betalabs.io', 'someone@gmail.com'],
            }),
          ]),
        ],
        now: AT,
      },
      {
        workspaceId: SEED.workspaceId,
        campaignId: SEED.campaignId,
        keyword: 'software engineer',
        limit: 10,
      },
    );
    expect(result.postedPeople).toBe(1);

    const person = await queryOne<{ display_name: string; domain: string; email: string }>(
      client,
      `SELECT p.display_name, co.domain, si.handle AS email
         FROM people p
         JOIN companies co ON co.id = p.current_company_id
         JOIN social_identities si ON si.person_id = p.id AND si.network = 'email'
         JOIN campaign_people cp ON cp.person_id = p.id AND cp.campaign_id = ?`,
      [SEED.campaignId],
    );
    expect(person).toEqual({
      display_name: 'Jane Doe',
      domain: 'betalabs.io',
      email: 'jane.doe@betalabs.io',
    });

    const company = await queryOne<{ contact_email: string }>(
      client,
      `SELECT contact_email FROM companies WHERE domain = 'betalabs.io'`,
    );
    expect(company?.contact_email).toBe('jobs@betalabs.io');
  });
});

describe('nameFromAddress', () => {
  test('a name, or nothing', () => {
    expect(nameFromAddress('jane.doe@acme.com')).toBe('Jane Doe');
    expect(nameFromAddress('jane@acme.com')).toBe('Jane');
    expect(nameFromAddress('jobs@acme.com')).toBeUndefined();
    expect(nameFromAddress('hiring@acme.com')).toBeUndefined();
    expect(nameFromAddress('jd2024@acme.com')).toBeUndefined();
  });
});
