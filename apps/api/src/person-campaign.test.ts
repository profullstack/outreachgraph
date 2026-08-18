/**
 * The campaign a prospect belongs to travels with the prospect.
 *
 * Anything acting on somebody has to act within a campaign, because that is
 * what decides the brief a draft is written against and which filters scored
 * them. A caller left to guess will eventually guess wrong, and the failure is
 * quiet: the person gets enrolled under a campaign they were never part of and
 * is then written to against the wrong offering.
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

describe('GET /people/:id', () => {
  test('names the campaign the person is in', async () => {
    const { app } = await harness('person-campaign');

    const response = await app.request(`/api/v1/people/${SEED.personId}`);
    const body = (await response.json()) as { campaignId: string | null };

    expect(response.status).toBe(200);
    expect(body.campaignId).toBe(SEED.campaignId);
  });

  test('reports null rather than guessing when they are in none', async () => {
    const { app, seeded } = await harness('person-nocampaign');

    await seeded.db.execute({
      sql: 'DELETE FROM campaign_people WHERE person_id = ?',
      args: [SEED.personId],
    });

    const response = await app.request(`/api/v1/people/${SEED.personId}`);
    const body = (await response.json()) as { campaignId: string | null };

    expect(body.campaignId).toBeNull();
  });

  test('does not name a campaign from another workspace', async () => {
    const { app, seeded } = await harness('person-campaign-isolation');

    // The membership row survives; the campaign moves out of reach.
    await seeded.db.execute({
      sql: `INSERT INTO workspaces (id, organization_id, name, slug, created_at, updated_at)
            VALUES ('wsp_elsewhere', ?, 'Elsewhere', 'elsewhere', ?, ?)`,
      args: [SEED.organizationId, new Date().toISOString(), new Date().toISOString()],
    });
    await seeded.db.execute({
      sql: `UPDATE campaigns SET workspace_id = 'wsp_elsewhere' WHERE id = ?`,
      args: [SEED.campaignId],
    });

    const response = await app.request(`/api/v1/people/${SEED.personId}`);
    const body = (await response.json()) as { campaignId: string | null };

    expect(body.campaignId).toBeNull();
  });
});
