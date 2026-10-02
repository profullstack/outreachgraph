/**
 * `/api/v1/job-posts` through the real app and a real temp database.
 *
 * What matters here: the list is CRUD a viewer can read but not change; a
 * keyword search needs a configured searcher and says so when there is none;
 * resolving now returns the people with their evidence; and a contact is
 * promoted into a named campaign only.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import type { WebResult, WebSearcher } from '@outreachgraph/providers';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

const OWNER: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};
const VIEWER: RequestActor = { ...OWNER, role: 'viewer' };

const RAYDAR = 'https://apply.workable.com/raydar/j/C39C58F585/';

const searcher: WebSearcher = {
  async search(query): Promise<readonly WebResult[]> {
    if (query.startsWith('site:apply.workable.com')) {
      return [{ link: RAYDAR, title: 'Senior Software Engineer - Raydar' }];
    }
    if (query.startsWith('site:linkedin.com/in "Raydar"')) {
      return [
        {
          link: 'https://www.linkedin.com/in/noah-kingsdale-9391aa166',
          title: 'Noah Kingsdale - VP of Technology at Raydar',
          snippet: 'At Raydar we help companies in emerging technologies find talent',
        },
      ];
    }
    return [];
  },
};

const fetchImpl = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith('/api/v1/accounts/raydar')) {
    return Response.json({ name: 'Raydar', url: 'http://raydar.xyz' });
  }
  if (url.endsWith('/jobs/C39C58F585')) {
    return Response.json({ title: 'Senior Software Engineer', remote: true, description: '' });
  }
  return new Response('', { status: 404 });
}) as typeof fetch;

async function harness(
  label: string,
  options: { actor?: RequestActor; search?: boolean } = {},
): Promise<Hono<AppEnv>> {
  const seeded = await seedDatabase(label);
  active = seeded;
  return createApp({
    db: seeded.db,
    authenticate: async () => options.actor ?? OWNER,
    ...(options.search === false ? {} : { jobSearcher: searcher }),
    jobReader: { fetchImpl },
  });
}

function send(app: Hono<AppEnv>, method: string, path: string, body?: unknown) {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('the list', () => {
  test('add, read, edit and remove a posting', async () => {
    const app = await harness('job-posts-api-crud');

    const created = await send(app, 'POST', '/job-posts', { urls: [RAYDAR, 'nope'] });
    expect(created.status).toBe(201);
    const { saved, rejected } = (await created.json()) as {
      saved: { id: string }[];
      rejected: unknown[];
    };
    expect(saved).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const id = saved[0]!.id;

    const listed = (await (await send(app, 'GET', '/job-posts')).json()) as {
      jobPosts: { id: string }[];
      searchEnabled: boolean;
    };
    expect(listed.jobPosts.map((p) => p.id)).toEqual([id]);
    expect(listed.searchEnabled).toBe(true);

    const patched = await send(app, 'PATCH', `/job-posts/${id}`, { status: 'applied' });
    expect(((await patched.json()) as { jobPost: { status: string } }).jobPost.status).toBe(
      'applied',
    );
    expect((await send(app, 'PATCH', `/job-posts/${id}`, { status: 'bogus' })).status).toBe(400);

    expect((await send(app, 'DELETE', `/job-posts/${id}`)).status).toBe(200);
    expect((await send(app, 'GET', `/job-posts/${id}`)).status).toBe(404);
  });

  test('a viewer can read the list but not change it', async () => {
    const app = await harness('job-posts-api-viewer', { actor: VIEWER });
    expect((await send(app, 'GET', '/job-posts')).status).toBe(200);
    expect((await send(app, 'POST', '/job-posts', { url: RAYDAR })).status).toBe(403);
  });
});

describe('search, resolve, promote', () => {
  test('keyword search adds the postings it finds', async () => {
    const app = await harness('job-posts-api-search');
    const response = await send(app, 'POST', '/job-posts/search', {
      keyword: 'senior software engineer (remote)',
      boards: ['workable'],
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { saved: { url: string }[]; queries: string[] };
    expect(result.saved.map((p) => p.url)).toEqual([RAYDAR]);
    expect(result.queries).toEqual(['site:apply.workable.com "senior software engineer" remote']);
  });

  test('without a search key, keyword search says what is missing', async () => {
    const keyless = await harness('job-posts-api-search-keyless', { search: false });
    const refused = await send(keyless, 'POST', '/job-posts/search', { keyword: 'engineer' });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('VALUESERP_API_KEY');
  });

  test('resolve finds the people, and promote needs a campaign', async () => {
    const app = await harness('job-posts-api-resolve');
    const { saved } = (await (await send(app, 'POST', '/job-posts', { url: RAYDAR })).json()) as {
      saved: { id: string }[];
    };
    const id = saved[0]!.id;

    const resolved = await send(app, 'POST', `/job-posts/${id}/resolve`);
    expect(resolved.status).toBe(200);
    const { jobPost } = (await resolved.json()) as {
      jobPost: { company: string; contacts: { id: string; name: string; role: string }[] };
    };
    expect(jobPost.company).toBe('Raydar');
    expect(jobPost.contacts).toEqual([
      expect.objectContaining({ name: 'Noah Kingsdale', role: 'engineering_leader' }),
    ]);
    const contactId = jobPost.contacts[0]!.id;

    const noCampaign = await send(
      app,
      'POST',
      `/job-posts/${id}/contacts/${contactId}/promote`,
      {},
    );
    expect(noCampaign.status).toBe(400);

    const promoted = await send(app, 'POST', `/job-posts/${id}/contacts/${contactId}/promote`, {
      campaignId: SEED.campaignId,
    });
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({ campaignId: SEED.campaignId, created: true });
  });
});
