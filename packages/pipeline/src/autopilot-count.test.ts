import { afterEach, describe, expect, test } from 'bun:test';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { countActionsToday } from './autopilot';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

async function action(
  id: string,
  status: string,
  createdAt: string,
  executedAt: string | null,
): Promise<void> {
  await seeded!.db.execute({
    sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
                               mode, status, created_at, executed_at)
          VALUES (?, ?, ?, ?, 'send_email', 'email', 'customer_managed', ?, ?, ?)`,
    args: [
      id,
      SEED.workspaceId,
      SEED.recommendationId,
      SEED.personId,
      status,
      createdAt,
      executedAt,
    ],
  });
}

describe("autopilot's daily count", () => {
  const at = new Date('2026-10-26T20:00:00.000Z');

  test('counts what went out today, not approvals waiting on a hold', async () => {
    seeded = await seedDatabase('autopilot-count-held');
    await action('act_sent', 'completed', '2026-10-26T11:00:00.000Z', '2026-10-26T11:00:01.000Z');
    // Approved today, held by the weekly per-prospect limit until next week.
    await action('act_held', 'queued', '2026-10-26T16:00:00.000Z', null);
    await action('act_bad', 'failed', '2026-10-26T16:00:00.000Z', null);
    await action('act_gone', 'cancelled', '2026-10-26T16:00:00.000Z', null);

    expect(await countActionsToday(seeded.db, SEED.workspaceId, at)).toBe(1);
  });

  test('counts a held email on the day it is finally sent', async () => {
    seeded = await seedDatabase('autopilot-count-released');
    await action('act_old', 'completed', '2026-10-19T16:00:00.000Z', '2026-10-26T09:00:00.000Z');
    await action('act_yday', 'completed', '2026-10-25T16:00:00.000Z', '2026-10-25T16:00:01.000Z');

    expect(await countActionsToday(seeded.db, SEED.workspaceId, at)).toBe(1);
  });
});
