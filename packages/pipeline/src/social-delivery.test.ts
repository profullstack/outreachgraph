import { afterEach, describe, expect, test } from 'bun:test';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { POST_PACING, scheduleSocialDelivery } from './social-delivery';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const HOUR = 3_600_000;
const actor = { actorKind: 'user', actorId: 'usr_test' } as const;

describe('posting pace', () => {
  test('a public post goes out at most once every four hours', async () => {
    seeded = await seedDatabase('social-post-gap');
    const nowMs = Date.parse('2026-10-26T15:00:00.000Z');

    const first = await scheduleSocialDelivery(
      seeded.db,
      { workspaceId: SEED.workspaceId, actionId: 'act_p1', network: 'x', actor, kind: 'reply' },
      nowMs,
    );
    const second = await scheduleSocialDelivery(
      seeded.db,
      { workspaceId: SEED.workspaceId, actionId: 'act_p2', network: 'x', actor, kind: 'reply' },
      nowMs,
    );

    expect(POST_PACING.minGapMs).toBe(4 * HOUR);
    expect(Date.parse(second.runAt) - Date.parse(first.runAt)).toBeGreaterThanOrEqual(4 * HOUR);
  });

  test('a profile visit is not spaced four hours behind a post', async () => {
    seeded = await seedDatabase('social-visit-gap');
    const nowMs = Date.parse('2026-10-26T15:00:00.000Z');

    await scheduleSocialDelivery(
      seeded.db,
      {
        workspaceId: SEED.workspaceId,
        actionId: 'act_p1',
        network: 'linkedin',
        actor,
        kind: 'reply',
      },
      nowMs,
    );
    const visit = await scheduleSocialDelivery(
      seeded.db,
      {
        workspaceId: SEED.workspaceId,
        actionId: 'act_v1',
        network: 'linkedin',
        actor,
        kind: 'view_profile',
      },
      nowMs,
    );

    expect(Date.parse(visit.runAt) - nowMs).toBeLessThan(HOUR);
  });

  test('waits for a hold the approval was given', async () => {
    seeded = await seedDatabase('social-not-before');
    const nowMs = Date.parse('2026-10-26T15:00:00.000Z');

    const held = await scheduleSocialDelivery(
      seeded.db,
      {
        workspaceId: SEED.workspaceId,
        actionId: 'act_h1',
        network: 'x',
        actor,
        kind: 'reply',
        notBeforeMs: nowMs + 30 * HOUR,
      },
      nowMs,
    );

    expect(Date.parse(held.runAt)).toBeGreaterThanOrEqual(nowMs + 30 * HOUR);
  });
});
