/**
 * Job posts: collect, resolve, promote.
 *
 * What has to hold: a posting pasted twice is one row; a keyword search keeps
 * only real postings; resolving reads the board, keeps only LinkedIn results
 * that name the company as itself, and attaches an address the company
 * published to the person it belongs to; and promoting goes through the
 * ordinary social intake, so the person lands in the campaign with their
 * employer's domain and that address, and nothing is sent.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import type { WebResult, WebSearcher } from '@outreachgraph/providers';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import {
  deleteJobPost,
  listJobPosts,
  promoteJobPostContact,
  resolveJobPost,
  saveJobPosts,
  searchJobPosts,
  updateJobPost,
} from './job-posts';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

async function db(label: string): Promise<Client> {
  seeded = await seedDatabase(label);
  return seeded.db;
}

const RAYDAR = 'https://apply.workable.com/raydar/j/C39C58F585/';

/** Answers by the first matching substring of the query, and records every query. */
function searcherOf(answers: Record<string, WebResult[]>, queries: string[] = []): WebSearcher {
  return {
    async search(query) {
      queries.push(query);
      const key = Object.keys(answers).find((k) => query.includes(k));
      return key ? (answers[key] ?? []) : [];
    },
  };
}

/** Workable's API and raydar.xyz, as they answered on 2026-10-02. */
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.endsWith('/api/v1/accounts/raydar')) {
    return json({ name: 'Raydar', url: 'http://raydar.xyz' });
  }
  if (url.endsWith('/api/v2/accounts/raydar/jobs/C39C58F585')) {
    return json({
      title: 'Senior Software Engineer',
      remote: true,
      location: { country: 'United States', city: '' },
      salary_from: 180000,
      salary_to: 250000,
      salary_currency_iso_code: 'USD',
      salary_frequency: 'year',
      published: '2026-10-01T00:00:00.000Z',
      description:
        '<p>Our client is an education technology company.</p><p>Raydar is recruiting for this role on behalf of our client.</p>',
    });
  }
  if (url === 'https://raydar.xyz/company') {
    return new Response(
      '<ol><li>David Phillips. Founder &amp; CEO</li><li>Noah Kingsdale. VP, Technology</li></ol>' +
        '<p>Hiring? Write to David at <a href="mailto:david@raydar.xyz">david@raydar.xyz</a></p>',
    );
  }
  return new Response('not found', { status: 404 });
}) as typeof fetch;

const LINKEDIN: WebResult[] = [
  {
    link: 'https://www.linkedin.com/in/davidphillips97',
    title: 'David Phillips - Raydar',
    snippet: 'Building teams & products in emerging tech. · Experience: Raydar',
  },
  {
    link: 'https://www.linkedin.com/in/vanessa-vallador-153672237',
    title: 'Vanessa Vallador - Senior Tech Recruiter @ Raydar',
    snippet: 'Senior Tech Recruiter @ Raydar',
  },
  {
    link: 'https://uk.linkedin.com/in/chris-rayson-820b0126',
    title: 'Chris Rayson - Director at Raydar Studios Ltd',
    snippet: 'Raydar Studios is a dynamic new independent media company',
  },
  {
    // Live 2026-10-02: a different Raydar that names itself the same way.
    link: 'https://www.linkedin.com/in/mrraydaniels',
    title: 'Ray Daniels - Music Executive| The Culture Referee',
    snippet:
      'Operated at the intersection of talent, strategy, and execution. Founded Raydar as a full-service music company',
  },
  {
    link: 'https://www.linkedin.com/in/noah-kingsdale-9391aa166',
    title: 'Noah Kingsdale - VP of Technology at Raydar',
    snippet: 'At Raydar we help companies in emerging technologies find the talent they need',
  },
];

describe('collecting postings', () => {
  test('a posting pasted twice, in two spellings, is one row; junk is rejected', async () => {
    const client = await db('job-posts-save');
    const result = await saveJobPosts(client, {
      workspaceId: SEED.workspaceId,
      urls: [RAYDAR, 'apply.workable.com/raydar/j/c39c58f585/apply', 'https://jobs.lever.co/acme'],
    });
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0]).toMatchObject({ url: RAYDAR, source: 'workable', status: 'new' });
    expect(result.rejected).toEqual([
      { url: 'https://jobs.lever.co/acme', reason: 'not a lever posting' },
    ]);

    const again = await saveJobPosts(client, { workspaceId: SEED.workspaceId, urls: [RAYDAR] });
    expect(again.duplicates).toEqual([RAYDAR]);

    const jobs = await queryAll<{ kind: string }>(
      client,
      `SELECT kind FROM jobs WHERE workspace_id = ? AND kind = 'resolve_job_post'`,
      [SEED.workspaceId],
    );
    expect(jobs).toHaveLength(1);
  });

  test('a keyword search runs one query per board and keeps only postings', async () => {
    const client = await db('job-posts-search');
    const queries: string[] = [];
    const searcher = searcherOf(
      {
        'apply.workable.com': [
          { link: RAYDAR, title: 'Senior Software Engineer - Raydar' },
          { link: 'https://apply.workable.com/raydar/', title: 'Raydar jobs' },
        ],
        'jobs.lever.co': [
          {
            link: 'https://jobs.lever.co/ethena/f85bcfd1-8d2c-4cf5-a6ab-1c8ddab14c65',
            title: 'Senior Software Engineer - Ethena',
          },
        ],
      },
      queries,
    );

    const result = await searchJobPosts(
      { db: client, searcher },
      { workspaceId: SEED.workspaceId, keyword: 'senior software engineer (remote)' },
    );

    expect(queries).toHaveLength(4);
    expect(queries[0]).toBe('site:apply.workable.com "senior software engineer" remote');
    expect(result.found).toBe(2);
    expect(result.saved.map((post) => post.source).sort()).toEqual(['lever', 'workable']);
    expect(result.saved.every((post) => post.keyword === 'senior software engineer (remote)')).toBe(
      true,
    );
  });
});

describe('resolving a posting', () => {
  test('reads the board, finds the people, and attaches the published address', async () => {
    const client = await db('job-posts-resolve');
    const { saved } = await saveJobPosts(client, { workspaceId: SEED.workspaceId, urls: [RAYDAR] });
    const id = saved[0]!.id;

    const { post, contacts } = await resolveJobPost(
      {
        db: client,
        searcher: searcherOf({ 'site:linkedin.com/in': LINKEDIN }),
        reader: { fetchImpl: fakeFetch },
      },
      SEED.workspaceId,
      id,
    );

    expect(post).toMatchObject({
      title: 'Senior Software Engineer',
      company: 'Raydar',
      companyDomain: 'raydar.xyz',
      salary: '180,000–250,000 USD per year',
      agency: true,
      status: 'contact_found',
      publishedEmails: ['david@raydar.xyz'],
    });
    // Raydar Studios is somebody else, and is dropped outright. The music
    // Raydar names itself exactly like the recruiter does, so only the
    // company's own team page can tell them apart: it names David and Noah.
    // Vanessa is not on it but her own headline says Raydar, so she keeps
    // her rank; Ray Daniels only has Raydar in his snippet, so he sinks.
    expect(contacts).toBe(4);
    expect(post.contacts.map((c) => [c.name, c.onCompanySite, c.score])).toEqual([
      ['David Phillips', true, 0.9],
      ['Noah Kingsdale', true, 0.85],
      ['Vanessa Vallador', false, 0.8],
      ['Ray Daniels', false, 0.38],
    ]);
    expect(post.contacts[1]?.role).toBe('engineering_leader');
    // His LinkedIn headline never says founder; raydar.xyz publishing his
    // address is what puts him first.
    expect(post.contacts[0]).toMatchObject({
      score: 0.9,
      email: 'david@raydar.xyz',
      emailSource: 'company_site',
      profileUrl: 'https://www.linkedin.com/in/davidphillips97',
    });
    // No campaign on the posting: nobody is promoted unasked.
    expect(post.contacts.every((c) => c.personId === undefined)).toBe(true);
  });

  test('with no search key the posting is still read, and says why nobody was found', async () => {
    const client = await db('job-posts-nokey');
    const { saved } = await saveJobPosts(client, { workspaceId: SEED.workspaceId, urls: [RAYDAR] });
    const { post } = await resolveJobPost(
      { db: client, reader: { fetchImpl: fakeFetch } },
      SEED.workspaceId,
      saved[0]!.id,
    );
    expect(post.status).toBe('no_contact');
    expect(post.company).toBe('Raydar');
    expect(post.lastError).toContain('VALUESERP_API_KEY');
  });

  test('a posting that is gone fails with the reason', async () => {
    const client = await db('job-posts-gone');
    const { saved } = await saveJobPosts(client, {
      workspaceId: SEED.workspaceId,
      urls: ['https://apply.workable.com/raydar/j/AAAAAAAAAA/'],
    });
    await expect(
      resolveJobPost(
        { db: client, reader: { fetchImpl: fakeFetch } },
        SEED.workspaceId,
        saved[0]!.id,
      ),
    ).rejects.toThrow('404');
    const [post] = await listJobPosts(client, SEED.workspaceId);
    expect(post).toMatchObject({ status: 'failed' });
    expect(post?.lastError).toContain('404');
  });
});

describe('promoting a contact', () => {
  test('lands in the campaign with the employer and the published address, nothing sent', async () => {
    const client = await db('job-posts-promote');
    const { saved } = await saveJobPosts(client, {
      workspaceId: SEED.workspaceId,
      urls: [RAYDAR],
      campaignId: SEED.campaignId,
    });

    // With a campaign on the posting, the best contact is promoted on resolve.
    const { post, promoted } = await resolveJobPost(
      {
        db: client,
        searcher: searcherOf({ 'site:linkedin.com/in': LINKEDIN }),
        reader: { fetchImpl: fakeFetch },
      },
      SEED.workspaceId,
      saved[0]!.id,
    );
    expect(promoted).toBeDefined();
    expect(post.contacts[0]?.personId).toBe(promoted);

    const person = await queryOne<{ display_name: string; domain: string | null }>(
      client,
      `SELECT p.display_name, co.domain FROM people p
         LEFT JOIN companies co ON co.id = p.current_company_id WHERE p.id = ?`,
      [promoted!],
    );
    expect(person).toMatchObject({ display_name: 'David Phillips', domain: 'raydar.xyz' });

    const emails = await queryAll<{ address: string; source: string }>(
      client,
      'SELECT address, source FROM person_emails WHERE person_id = ?',
      [promoted!],
    );
    expect(emails).toEqual([{ address: 'david@raydar.xyz', source: 'site' }]);

    const member = await queryOne<{ n: number }>(
      client,
      'SELECT COUNT(*) AS n FROM campaign_people WHERE campaign_id = ? AND person_id = ?',
      [SEED.campaignId, promoted!],
    );
    expect(Number(member?.n)).toBe(1);

    const sent = await queryAll(client, `SELECT id FROM actions WHERE status = 'sent'`);
    expect(sent).toHaveLength(0);

    // The recruiter, promoted by hand, has no address: find_email is queued.
    const vanessa = post.contacts.find((c) => c.name === 'Vanessa Vallador')!;
    const second = await promoteJobPostContact(
      client,
      SEED.workspaceId,
      vanessa.id,
      SEED.campaignId,
    );
    expect(second).toMatchObject({ email: false, findEmailQueued: true });
  });
});

test('update and delete', async () => {
  const client = await db('job-posts-crud');
  const { saved } = await saveJobPosts(client, { workspaceId: SEED.workspaceId, urls: [RAYDAR] });
  const id = saved[0]!.id;

  const updated = await updateJobPost(client, SEED.workspaceId, id, {
    status: 'applied',
    notes: 'Applied 2026-10-02',
  });
  expect(updated).toMatchObject({ status: 'applied', notes: 'Applied 2026-10-02' });

  expect(await deleteJobPost(client, SEED.workspaceId, id)).toBe(true);
  expect(await deleteJobPost(client, SEED.workspaceId, id)).toBe(false);
  expect(await listJobPosts(client, SEED.workspaceId)).toEqual([]);
});
