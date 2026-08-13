import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { StubModel } from '@outreachgraph/ai';
import { SiteProvider, type FetchLike } from '@outreachgraph/providers';
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

const SITE_HTML = `<html><head><title>Loopwright</title></head><body>
  <h1>Reliability tooling for agent teams</h1>
  <p>Catch agent regressions before your customers do.</p>
</body></html>`;

function stubNetwork(html = SITE_HTML): FetchLike {
  return async (input) =>
    input.toString().endsWith('/robots.txt')
      ? new Response('', { headers: { 'content-type': 'text/plain' } })
      : new Response(html, { headers: { 'content-type': 'text/html' } });
}

const GOOD_DRAFT = JSON.stringify({
  offering: {
    name: 'Loopwright',
    category: 'developer tooling',
    description: 'Reliability tooling for agent teams.',
    valuePropositions: ['Catch regressions early'],
    likelyPains: ['Agents fail silently in production'],
    competitors: [],
  },
  icp: {
    titles: ['Staff Engineer', 'Head of Platform'],
    seniorities: ['senior'],
    industries: ['software'],
    technologies: ['python'],
    keywords: ['agent reliability'],
    exclusions: ['students'],
  },
  voice: { style: 'direct and technical', instructions: 'no hype', maxWords: 120 },
  whereToFind: ['GitHub issues on agent frameworks — people describe failures there.'],
});

async function harness(
  label: string,
  options: { actor?: RequestActor | null; model?: StubModel; verified?: boolean } = {},
): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;

  if (options.verified === false) {
    await seeded.db.execute({
      sql: 'UPDATE users SET email_verified_at = NULL WHERE id = ?',
      args: [SEED.userId],
    });
  }

  const app = createApp({
    db: seeded.db,
    authenticate: async () => options.actor ?? (options.actor === null ? undefined : ACTOR),
    site: new SiteProvider({ fetchImpl: stubNetwork() }),
    ...(options.model ? { model: options.model } : {}),
  });

  return { app, seeded };
}

async function post(app: Hono<AppEnv>, path: string, body: unknown): Promise<Response> {
  return app.request(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function put(app: Hono<AppEnv>, path: string, body: unknown): Promise<Response> {
  return app.request(`/api/v1${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /onboarding/profile', () => {
  test('an unverified email cannot spend a model call', async () => {
    const model = new StubModel(GOOD_DRAFT);
    const { app } = await harness('onboard-unverified', { model, verified: false });

    const response = await post(app, '/onboarding/profile', { url: 'loopwright.io' });

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('email_unverified');
    // The gate has to sit in front of the spend, not merely in front of the
    // reply: an unverified signup that still burned a call would be an open
    // invitation to do it a thousand times.
    expect(model.calls).toHaveLength(0);
  });

  test('a verified caller gets a draft back', async () => {
    const model = new StubModel(GOOD_DRAFT);
    const { app } = await harness('onboard-draft', { model });

    const response = await post(app, '/onboarding/profile', { url: 'loopwright.io' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.draft.offering.name).toBe('Loopwright');
    expect(body.draft.icp.titles).toContain('Staff Engineer');
    expect(body.draft.whereToFind.length).toBeGreaterThan(0);
  });

  test('nothing is written until the draft is confirmed', async () => {
    const model = new StubModel(GOOD_DRAFT);
    const { app, seeded } = await harness('onboard-no-write', { model });

    await post(app, '/onboarding/profile', { url: 'loopwright.io' });

    const offering = await queryOne<{ name: string }>(
      seeded.db,
      'SELECT name FROM offerings WHERE workspace_id = ? ORDER BY created_at LIMIT 1',
      [SEED.workspaceId],
    );

    // A model's reading of a marketing page is a suggestion. Adopting it
    // silently would ground every later draft in something nobody checked.
    expect(offering?.name).not.toBe('Loopwright');
  });

  test('without a model configured it says so rather than failing opaquely', async () => {
    const { app } = await harness('onboard-nomodel');

    const response = await post(app, '/onboarding/profile', { url: 'loopwright.io' });
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toContain('by hand');
  });

  test('a site we cannot read is explained in terms of the site', async () => {
    const model = new StubModel(GOOD_DRAFT);
    const seeded = await seedDatabase('onboard-blocked');
    active = seeded;

    const app = createApp({
      db: seeded.db,
      authenticate: async () => ACTOR,
      model,
      site: new SiteProvider({
        fetchImpl: async (input) =>
          input.toString().endsWith('/robots.txt')
            ? new Response('User-agent: *\nDisallow: /', {
                headers: { 'content-type': 'text/plain' },
              })
            : new Response('<html></html>'),
      }),
    });

    const response = await post(app, '/onboarding/profile', { url: 'loopwright.io' });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('robots.txt');
  });

  test('an unparseable model reply is a 502, not a saved profile', async () => {
    const model = new StubModel('I am not JSON');
    const { app } = await harness('onboard-badreply', { model });

    const response = await post(app, '/onboarding/profile', { url: 'loopwright.io' });
    expect(response.status).toBe(502);
  });
});

describe('PUT /onboarding/profile', () => {
  const PROFILE = {
    url: 'https://loopwright.io',
    offering: {
      name: 'Loopwright',
      category: 'developer tooling',
      description: 'Reliability tooling.',
      valuePropositions: ['Catch regressions'],
      likelyPains: ['Silent failures'],
      competitors: [],
    },
    icp: {
      titles: ['Staff Engineer'],
      seniorities: [],
      industries: ['software'],
      technologies: [],
      keywords: ['agent reliability'],
      exclusions: [],
    },
    voice: { style: 'direct', instructions: 'no hype', maxWords: 120 },
  };

  test('a confirmed profile replaces the placeholder offering', async () => {
    const { app, seeded } = await harness('onboard-save');

    const response = await put(app, '/onboarding/profile', PROFILE);
    expect(response.status).toBe(200);

    const offering = await queryOne<{ name: string; likely_pains: string }>(
      seeded.db,
      'SELECT name, likely_pains FROM offerings WHERE workspace_id = ? ORDER BY created_at LIMIT 1',
      [SEED.workspaceId],
    );

    expect(offering?.name).toBe('Loopwright');
    expect(offering?.likely_pains).toContain('Silent failures');
  });

  test('the ICP lands on the campaign the pipeline actually reads', async () => {
    const { app, seeded } = await harness('onboard-filters');

    await put(app, '/onboarding/profile', PROFILE);

    const filters = await queryOne<{ titles: string; keywords: string }>(
      seeded.db,
      `SELECT f.titles, f.keywords FROM campaign_filters f
         JOIN campaigns c ON c.id = f.campaign_id
        WHERE c.workspace_id = ? LIMIT 1`,
      [SEED.workspaceId],
    );

    expect(filters?.titles).toContain('Staff Engineer');
    expect(filters?.keywords).toContain('agent reliability');
  });

  test('saving twice corrects the profile rather than creating a rival', async () => {
    const { app, seeded } = await harness('onboard-twice');

    await put(app, '/onboarding/profile', PROFILE);
    await put(app, '/onboarding/profile', {
      ...PROFILE,
      offering: { ...PROFILE.offering, name: 'Loopwright v2' },
    });

    const rows = await seeded.db.execute({
      sql: 'SELECT COUNT(*) AS n FROM offerings WHERE workspace_id = ?',
      args: [SEED.workspaceId],
    });

    expect(Number(rows.rows[0]!.n)).toBe(1);
  });

  test('an incomplete profile is rejected', async () => {
    const { app } = await harness('onboard-invalid');

    const response = await put(app, '/onboarding/profile', { offering: { name: '' } });
    expect(response.status).toBe(400);
  });

  test('GET reports an unconfigured workspace as unconfigured', async () => {
    const { app } = await harness('onboard-get');

    const before = await (await app.request('/api/v1/onboarding/profile')).json();
    expect(before.configured).toBe(false);

    await put(app, '/onboarding/profile', PROFILE);

    const after = await (await app.request('/api/v1/onboarding/profile')).json();
    expect(after.configured).toBe(true);
    expect(after.offering.name).toBe('Loopwright');
  });
});
