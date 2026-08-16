import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { queryOne } from '@outreachgraph/db';
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

async function harness(
  label: string,
  options: { suggest?: typeof import('@outreachgraph/providers').suggestSubreddits } = {},
): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;

  const app = createApp({
    db: seeded.db,
    authenticate: async () => ACTOR,
    ...(options.suggest ? { suggestSubreddits: options.suggest } : {}),
  });

  return { app, seeded };
}

async function put(app: Hono<AppEnv>, path: string, body: unknown): Promise<Response> {
  return app.request(`/api/v1${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('campaign listening targets', () => {
  test('a new campaign listens nowhere', async () => {
    const { app } = await harness('listening-default');

    const response = await app.request(`/api/v1/campaigns/${SEED.campaignId}/listening`);
    const body = await response.json();

    expect(response.status).toBe(200);
    // Listening polls networks and writes people, so it is opt-in per campaign.
    expect(body.sources).toEqual([]);
    expect(body.available).toContain('reddit');
  });

  test('targets are stored against the campaign that set them', async () => {
    const { app, seeded } = await harness('listening-save');

    const response = await put(app, `/campaigns/${SEED.campaignId}/listening`, {
      sources: ['reddit'],
      subreddits: ['r/plumbing', 'https://www.reddit.com/r/HVAC/'],
      feeds: [],
    });

    expect(response.status).toBe(200);

    const row = await queryOne<{ listen_sources: string; listen_subreddits: string }>(
      seeded.db,
      'SELECT listen_sources, listen_subreddits FROM campaign_filters WHERE campaign_id = ?',
      [SEED.campaignId],
    );

    // Stored normalised, so the worker never has to parse a pasted URL.
    expect(JSON.parse(row?.listen_subreddits ?? '[]')).toEqual(['plumbing', 'HVAC']);
    expect(JSON.parse(row?.listen_sources ?? '[]')).toEqual(['reddit']);
  });

  test('an unsupported network is refused rather than quietly dropped', async () => {
    const { app } = await harness('listening-unknown');

    const response = await put(app, `/campaigns/${SEED.campaignId}/listening`, {
      sources: ['reddit', 'facebook'],
    });

    // Facebook has no public post search to poll. Accepting it would leave the
    // screen reading "listening: on" while nothing happens.
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('facebook');
  });

  test('rss without a feed URL is refused', async () => {
    const { app } = await harness('listening-rss-empty');

    const response = await put(app, `/campaigns/${SEED.campaignId}/listening`, {
      sources: ['rss'],
      feeds: [],
    });

    expect(response.status).toBe(400);
  });

  test('another workspace’s campaign is not found', async () => {
    const { app } = await harness('listening-tenancy');

    const response = await app.request('/api/v1/campaigns/cmp_not_yours/listening');
    expect(response.status).toBe(404);
  });
});

describe('subreddit suggestions', () => {
  test('suggests communities from the campaign’s own keywords', async () => {
    const { app, seeded } = await harness('listening-suggest', {
      suggest: async (terms) => [
        {
          name: 'Plumbing',
          title: 'Plumbing',
          subscribers: 120_000,
          description: '',
          url: 'https://www.reddit.com/r/Plumbing',
          matchedTerms: [...terms],
        },
      ],
    });

    await seeded.db.execute({
      sql: `INSERT INTO campaign_filters (campaign_id, keywords, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(campaign_id) DO UPDATE SET keywords = excluded.keywords`,
      args: [SEED.campaignId, JSON.stringify(['scheduling software']), '2026-08-10T00:00:00.000Z'],
    });

    const response = await app.request(
      `/api/v1/campaigns/${SEED.campaignId}/listening/suggestions`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.suggestions[0].name).toBe('Plumbing');
    // The operator should not have to know the communities; the keywords they
    // already gave during setup are enough to find them.
    expect(body.terms).toContain('scheduling software');
  });

  test('no keywords means no suggestions and no request', async () => {
    let called = false;
    const { app, seeded } = await harness('listening-suggest-empty', {
      suggest: async () => {
        called = true;
        return [];
      },
    });

    await seeded.db.execute({
      sql: `UPDATE campaign_filters SET keywords = '[]' WHERE campaign_id = ?`,
      args: [SEED.campaignId],
    });
    await seeded.db.execute({
      sql: `UPDATE offerings SET competitors = '[]' WHERE id = ?`,
      args: [SEED.offeringId],
    });

    const response = await app.request(
      `/api/v1/campaigns/${SEED.campaignId}/listening/suggestions`,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).suggestions).toEqual([]);
    expect(called).toBe(false);
  });
});
