/**
 * A workspace that sells more than one thing.
 *
 * The schema always allowed it — `offerings` is keyed by workspace and every
 * campaign names the offering it sells — but every read in the profile module
 * was `ORDER BY created_at ASC LIMIT 1`. Setup could see only the first row, so
 * describing a second product overwrote the first, and the single campaign was
 * repointed at the new offering. A company with two products could sell one.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { queryAll, queryOne } from '@outreachgraph/db';
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

  return {
    app: createApp({ db: seeded.db, authenticate: async () => ACTOR }),
    seeded,
  };
}

function profile(name: string, extra: Record<string, unknown> = {}) {
  return {
    offering: {
      name,
      category: 'developer tooling',
      description: `${name} does a thing.`,
      valuePropositions: [`${name} is fast`],
      likelyPains: ['manual work'],
      competitors: [],
    },
    icp: {
      titles: ['Head of Platform'],
      seniorities: ['senior'],
      industries: ['software'],
      technologies: [],
      keywords: [name.toLowerCase()],
      exclusions: [],
    },
    voice: { style: `the ${name} voice`, instructions: 'no hype', maxWords: 120 },
    ...extra,
  };
}

async function save(
  app: Hono<AppEnv>,
  body: Record<string, unknown>,
  query = '',
): Promise<Response> {
  return app.request(`/api/v1/onboarding/profile${query}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('more than one product', () => {
  test('adding a second leaves the first alone', async () => {
    const { app, seeded } = await harness('products-add-second');

    await save(app, profile('Loopwright'));
    await save(app, profile('Sinkhole'), '?new=1');

    const offerings = await queryAll<{ name: string }>(
      seeded.db,
      'SELECT name FROM offerings WHERE workspace_id = ? ORDER BY created_at ASC',
      [SEED.workspaceId],
    );

    // Without `?new=1` this was one row, renamed.
    expect(offerings.map((o) => o.name)).toEqual(['Loopwright', 'Sinkhole']);
  });

  test('each product gets its own campaign, so both keep selling', async () => {
    const { app, seeded } = await harness('products-own-campaign');

    await save(app, profile('Loopwright'));
    await save(app, profile('Sinkhole'), '?new=1');

    const campaigns = await queryAll<{ name: string; offering_id: string; status: string }>(
      seeded.db,
      `SELECT c.name, c.offering_id, c.status FROM campaigns c
        WHERE c.workspace_id = ? ORDER BY c.created_at ASC`,
      [SEED.workspaceId],
    );

    // The seed ships one campaign, which the first product adopts; the second
    // gets its own. Repointing the single campaign is what used to happen, and
    // it silently stopped the first product being sold.
    //
    // Anything not archived is still selling — the pipeline and autopilot both
    // gate on `status != 'archived'` rather than on one particular value.
    const live = campaigns.filter((c) => c.status !== 'archived');
    expect(live).toHaveLength(2);
    expect(new Set(live.map((c) => c.offering_id)).size).toBe(2);
  });

  test('each product has its own voice', async () => {
    const { app, seeded } = await harness('products-own-voice');

    await save(app, profile('Loopwright'));
    await save(app, profile('Sinkhole'), '?new=1');

    const voices = await queryAll<{ style: string }>(
      seeded.db,
      'SELECT style FROM voice_profiles WHERE workspace_id = ? ORDER BY created_at ASC',
      [SEED.workspaceId],
    );

    // A security tool and a design tool should not sound the same.
    expect(voices.map((v) => v.style)).toEqual(['the Loopwright voice', 'the Sinkhole voice']);
  });

  test('each product has its own ICP', async () => {
    const { app, seeded } = await harness('products-own-icp');

    await save(app, profile('Loopwright'));
    await save(app, profile('Sinkhole'), '?new=1');

    const filters = await queryAll<{ keywords: string }>(
      seeded.db,
      `SELECT f.keywords FROM campaign_filters f
         JOIN campaigns c ON c.id = f.campaign_id
        WHERE c.workspace_id = ? ORDER BY c.created_at ASC`,
      [SEED.workspaceId],
    );

    expect(filters).toHaveLength(2);
    expect(filters.map((f) => f.keywords)).toEqual([
      JSON.stringify(['loopwright']),
      JSON.stringify(['sinkhole']),
    ]);
  });
});

describe('GET /products', () => {
  test('lists everything the workspace sells', async () => {
    const { app } = await harness('products-list');

    await save(app, profile('Loopwright'));
    await save(app, profile('Sinkhole'), '?new=1');

    const response = await app.request('/api/v1/products');
    const body = (await response.json()) as {
      products: { name: string; offeringId: string; campaignId: string | null }[];
    };

    expect(body.products.map((p) => p.name)).toEqual(['Loopwright', 'Sinkhole']);
    expect(body.products.every((p) => p.campaignId)).toBe(true);
  });
});

describe('loading one product', () => {
  test('returns the one asked for, not always the first', async () => {
    const { app } = await harness('products-load-one');

    await save(app, profile('Loopwright'));
    await save(app, profile('Sinkhole'), '?new=1');

    const list = (await (await app.request('/api/v1/products')).json()) as {
      products: { name: string; offeringId: string }[];
    };
    const second = list.products.find((p) => p.name === 'Sinkhole');

    const response = await app.request(
      `/api/v1/onboarding/profile?offeringId=${second?.offeringId}`,
    );
    const body = (await response.json()) as {
      configured: boolean;
      offering?: { name: string };
      voice?: { style: string };
      icp?: { keywords: string[] };
    };

    expect(body.configured).toBe(true);
    expect(body.offering?.name).toBe('Sinkhole');
    // The voice and ICP must come from this product's campaign; unscoped, they
    // came from the first product's.
    expect(body.voice?.style).toBe('the Sinkhole voice');
    expect(body.icp?.keywords).toEqual(['sinkhole']);
  });

  test('carries the full product list so the UI can offer a choice', async () => {
    const { app } = await harness('products-load-list');

    await save(app, profile('Loopwright'));
    await save(app, profile('Sinkhole'), '?new=1');

    const body = (await (await app.request('/api/v1/onboarding/profile')).json()) as {
      products?: { name: string }[];
    };

    expect(body.products?.map((p) => p.name)).toEqual(['Loopwright', 'Sinkhole']);
  });

  test('editing by id updates that product rather than the first', async () => {
    const { app, seeded } = await harness('products-edit-by-id');

    await save(app, profile('Loopwright'));
    await save(app, profile('Sinkhole'), '?new=1');

    const list = (await (await app.request('/api/v1/products')).json()) as {
      products: { name: string; offeringId: string }[];
    };
    const second = list.products.find((p) => p.name === 'Sinkhole');

    await save(app, profile('Sinkhole Pro', { offeringId: second?.offeringId }));

    const names = await queryAll<{ name: string }>(
      seeded.db,
      'SELECT name FROM offerings WHERE workspace_id = ? ORDER BY created_at ASC',
      [SEED.workspaceId],
    );
    expect(names.map((n) => n.name)).toEqual(['Loopwright', 'Sinkhole Pro']);
  });

  test('a product id from another workspace is not found', async () => {
    const { app, seeded } = await harness('products-foreign-id');

    await save(app, profile('Loopwright'));

    // An id straight from a request body. Unchecked, one workspace could
    // rewrite another's offering.
    await seeded.db.execute({
      sql: `INSERT INTO organizations (id, name, slug, created_at, updated_at)
            VALUES ('org_other', 'Other', 'other', '2026-01-01', '2026-01-01')`,
      args: [],
    });
    await seeded.db.execute({
      sql: `INSERT INTO workspaces (id, organization_id, name, slug, created_at, updated_at)
            VALUES ('wsp_other', 'org_other', 'Other', 'other', '2026-01-01', '2026-01-01')`,
      args: [],
    });
    await seeded.db.execute({
      sql: `INSERT INTO offerings (id, workspace_id, name, category, created_at, updated_at)
            VALUES ('off_other', 'wsp_other', 'Theirs', 'x', '2026-01-01', '2026-01-01')`,
      args: [],
    });

    const response = await save(app, profile('Mine', { offeringId: 'off_other' }));
    expect(response.status).toBe(404);

    const theirs = await queryOne<{ name: string }>(
      seeded.db,
      'SELECT name FROM offerings WHERE id = ?',
      ['off_other'],
    );
    expect(theirs?.name).toBe('Theirs');
  });
});

describe('DELETE /products/:id', () => {
  test('archives the campaigns and keeps the history', async () => {
    const { app, seeded } = await harness('products-archive');

    await save(app, profile('Loopwright'));
    await save(app, profile('Sinkhole'), '?new=1');

    const list = (await (await app.request('/api/v1/products')).json()) as {
      products: { name: string; offeringId: string }[];
    };
    const second = list.products.find((p) => p.name === 'Sinkhole');

    const response = await app.request(`/api/v1/products/${second?.offeringId}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);

    const campaign = await queryOne<{ status: string }>(
      seeded.db,
      'SELECT status FROM campaigns WHERE offering_id = ?',
      [second?.offeringId ?? ''],
    );
    expect(campaign?.status).toBe('archived');

    // The offering row survives: recommendations, actions and interactions all
    // hang off it, and tidying a settings page must not delete what was sent.
    const offering = await queryOne<{ name: string }>(
      seeded.db,
      'SELECT name FROM offerings WHERE id = ?',
      [second?.offeringId ?? ''],
    );
    expect(offering?.name).toBe('Sinkhole');

    // The other product keeps running.
    const others = await queryAll<{ status: string }>(
      seeded.db,
      `SELECT status FROM campaigns WHERE workspace_id = ? AND offering_id != ?`,
      [SEED.workspaceId, second?.offeringId ?? ''],
    );
    expect(others.some((c) => c.status !== 'archived')).toBe(true);
  });

  test('404s for a product this workspace does not own', async () => {
    const { app } = await harness('products-archive-unknown');
    const response = await app.request('/api/v1/products/off_nope', { method: 'DELETE' });
    expect(response.status).toBe(404);
  });
});
