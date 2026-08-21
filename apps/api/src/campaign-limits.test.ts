/**
 * Tuning a campaign's throughput and anti-spam limits.
 *
 * These knobs were read from `campaigns.budget_json` from the first release
 * and written by nothing, so every campaign in production ran on the
 * hard-coded fallbacks and the only way to change one was a direct database
 * write. The tests worth having are the ones proving the bounds hold: a
 * settings screen that can be talked into unlimited mail to one mailbox is
 * worse than no settings screen.
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

async function harness(
  label: string,
  actor: RequestActor | null = ACTOR,
): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;

  const app = createApp({ db: seeded.db, authenticate: async () => actor ?? undefined });
  return { app, seeded };
}

async function patch(app: Hono<AppEnv>, body: unknown): Promise<Response> {
  return app.request(`/api/v1/campaigns/${SEED.campaignId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function budget(seeded: SeededDatabase): Promise<Record<string, unknown>> {
  const row = await seeded.db.execute({
    sql: 'SELECT budget_json FROM campaigns WHERE id = ?',
    args: [SEED.campaignId],
  });

  return JSON.parse(String(row.rows[0]?.budget_json ?? '{}')) as Record<string, unknown>;
}

describe('campaign limits', () => {
  test('stores the limits it is given', async () => {
    const { app, seeded } = await harness('limits-set');

    const response = await patch(app, {
      limits: { maxActionsPerDay: 200, maxActionsPerAddressPerWeek: 3 },
    });

    expect(response.status).toBe(200);

    const stored = await budget(seeded);
    expect(stored.maxActionsPerDay).toBe(200);
    expect(stored.maxActionsPerAddressPerWeek).toBe(3);
  });

  test('merges rather than replacing the rest of the budget', async () => {
    // budget_json also carries the spend ceilings. Raising a send cap must not
    // quietly drop the AI budget on its way past.
    const { app, seeded } = await harness('limits-merge');

    await seeded.db.execute({
      sql: 'UPDATE campaigns SET budget_json = ? WHERE id = ?',
      args: [JSON.stringify({ maxAiSpendUsd: 42, maxActionsPerDay: 50 }), SEED.campaignId],
    });

    await patch(app, { limits: { maxActionsPerDay: 300 } });

    const stored = await budget(seeded);
    expect(stored.maxActionsPerDay).toBe(300);
    expect(stored.maxAiSpendUsd).toBe(42);
  });

  test('omitting a key leaves it alone rather than resetting it', async () => {
    const { app, seeded } = await harness('limits-partial');

    await patch(app, { limits: { maxActionsPerDay: 120, minHoursBetweenActions: 24 } });
    await patch(app, { limits: { maxActionsPerDay: 130 } });

    const stored = await budget(seeded);
    expect(stored.maxActionsPerDay).toBe(130);
    expect(stored.minHoursBetweenActions).toBe(24);
  });

  test('refuses a per-mailbox cap that would bury one inbox', async () => {
    // The daily cap is throughput and may be large. The per-recipient caps are
    // the ones that stop a mailbox being buried, so they top out at one a day.
    const { app, seeded } = await harness('limits-mailbox');

    const response = await patch(app, { limits: { maxActionsPerAddressPerWeek: 50 } });

    expect(response.status).toBe(400);
    expect(await budget(seeded)).not.toHaveProperty('maxActionsPerAddressPerWeek');
  });

  test('refuses a negative cap', async () => {
    const { app } = await harness('limits-negative');

    expect((await patch(app, { limits: { maxActionsPerDay: -1 } })).status).toBe(400);
  });

  test('refuses an empty limits object', async () => {
    const { app } = await harness('limits-empty');

    expect((await patch(app, { limits: {} })).status).toBe(400);
  });

  test('a viewer cannot change the limits', async () => {
    const { app } = await harness('limits-viewer', { ...ACTOR, role: 'viewer' });

    expect((await patch(app, { limits: { maxActionsPerDay: 999 } })).status).toBe(403);
  });

  test('writes an audit row naming what changed', async () => {
    const { app, seeded } = await harness('limits-audit');

    await patch(app, { limits: { maxActionsPerDay: 250 } });

    const rows = await seeded.db.execute({
      sql: `SELECT event_type, detail_json FROM audit_events
             WHERE workspace_id = ? AND event_type = 'campaign.limits_changed'`,
      args: [SEED.workspaceId],
    });

    expect(rows.rows.length).toBe(1);
    expect(JSON.parse(String(rows.rows[0]?.detail_json))).toEqual({ maxActionsPerDay: 250 });
  });
});
