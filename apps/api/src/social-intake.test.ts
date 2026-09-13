/**
 * The social intake route and the OpenProfile endpoint.
 *
 * What has to hold: a handle becomes a person in the default campaign with
 * an openprofile job queued, junk is named and the rest lands, a flat single
 * person is accepted, a campaign from another workspace is refused, and the
 * assembled Markdown is served as text/markdown only to a workspace that
 * holds the person.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

async function harness(label: string): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  const app = createApp({ db: seeded.db, authenticate: async () => ACTOR });
  return { app, seeded };
}

const get = (app: Hono<AppEnv>, path: string) => app.request(`/api/v1${path}`);
const post = (app: Hono<AppEnv>, path: string, body: unknown = {}) =>
  app.request(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /people/from-social', () => {
  test('a handle becomes a person in the default campaign with an openprofile job queued', async () => {
    const { app, seeded } = await harness('social-intake');
    const response = await post(app, '/people/from-social', {
      source: 'myna',
      people: [
        {
          network: 'bluesky',
          handle: '@ada.example',
          displayName: 'Ada',
          bio: 'Engines.',
          via: 'following',
        },
        { network: 'tiktok', handle: 'nope' },
      ],
    });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({ campaignId: SEED.campaignId, created: 1, existing: 0, queued: 1 });
    expect(body.rejected).toEqual([{ handle: 'nope', reason: 'unknown network tiktok' }]);
    expect(body.people[0]).toMatchObject({
      network: 'bluesky',
      handle: 'ada.example',
      created: true,
    });

    const listed = await (await get(app, '/people')).json();
    expect(listed.people.map((person: { id: string }) => person.id)).toContain(body.people[0].id);

    const job = await seeded.db.execute({
      sql: 'SELECT kind FROM jobs WHERE dedupe_key = ?',
      args: [`openprofile:${body.people[0].id}`],
    });
    expect(job.rows).toHaveLength(1);

    // No profile yet: the job has not run.
    expect((await get(app, `/people/${body.people[0].id}/openprofile.md`)).status).toBe(404);
    const detail = await (await get(app, `/people/${body.people[0].id}`)).json();
    expect(detail.openprofile).toBeNull();
  });

  test('a single person may be sent flat; a foreign campaign and an empty body are refused', async () => {
    const { app } = await harness('social-intake-flat');
    const flat = await post(app, '/people/from-social', {
      network: 'mastodon',
      handle: 'ada@hachyderm.io',
    });
    expect(flat.status).toBe(202);
    expect((await flat.json()).people[0]).toMatchObject({
      network: 'mastodon',
      handle: 'ada@hachyderm.io',
    });

    const foreign = await post(app, '/people/from-social', {
      campaignId: 'cmp_elsewhere',
      people: [{ network: 'x', handle: 'ada' }],
    });
    expect(foreign.status).toBe(404);

    expect((await post(app, '/people/from-social', {})).status).toBe(400);
  });
});

describe('GET /people/:id/openprofile.md', () => {
  test('serves the assembled Markdown to a workspace that holds the person', async () => {
    const { app, seeded } = await harness('social-intake-openprofile');
    await seeded.db.execute({
      sql: `INSERT INTO openprofiles (person_id, markdown, sources_json, published_url, generated_at)
            VALUES (?, ?, '[]', 'https://jane.example/.well-known/openprofile.md', ?)`,
      args: [SEED.personId, '# Jane\n\n- **Kind**: person\n', '2026-09-13T00:00:00.000Z'],
    });
    const response = await get(app, `/people/${SEED.personId}/openprofile.md`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('link')).toBe(
      '<https://jane.example/.well-known/openprofile.md>; rel="canonical"',
    );
    expect(await response.text()).toBe('# Jane\n\n- **Kind**: person\n');

    const detail = await (await get(app, `/people/${SEED.personId}`)).json();
    expect(detail.openprofile).toEqual({
      url: `/api/v1/people/${SEED.personId}/openprofile.md`,
      generatedAt: '2026-09-13T00:00:00.000Z',
      publishedUrl: 'https://jane.example/.well-known/openprofile.md',
      // Private until somebody switches it on; nobody has claimed or edited it.
      public: false,
      handle: null,
      claimedAt: null,
      editedAt: null,
    });

    expect((await get(app, '/people/per_nobody/openprofile.md')).status).toBe(404);
  });
});
