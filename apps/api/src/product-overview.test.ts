import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from './app';
import type { RequestActor } from './context';
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

describe('GET /products/:id/overview', () => {
  test('one product with its campaign and the people it found', async () => {
    active = await seedDatabase('product-overview');
    const app = createApp({ db: active.db, authenticate: async () => ACTOR });

    const response = await app.request(`/api/v1/products/${SEED.offeringId}/overview`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.product.offeringId).toBe(SEED.offeringId);
    expect(body.campaign.id).toBe(SEED.campaignId);
    expect(body.leads.map((l: { person_id: string }) => l.person_id)).toContain(SEED.personId);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  test('another workspace’s product is not found', async () => {
    active = await seedDatabase('product-overview-404');
    const app = createApp({ db: active.db, authenticate: async () => ACTOR });

    const response = await app.request('/api/v1/products/off_not_ours/overview');
    expect(response.status).toBe(404);
  });
});
