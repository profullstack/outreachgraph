import { afterEach, describe, expect, test } from 'bun:test';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { countActionsToday, countCampaignActionsToday } from './autopilot';

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

  test("a campaign's count is its own sends, not the workspace's", async () => {
    seeded = await seedDatabase('autopilot-count-campaign');
    await action('act_ours', 'completed', '2026-10-26T11:00:00.000Z', '2026-10-26T11:00:01.000Z');
    // Another campaign in the same workspace sent two today.
    // Copy every column, so the fixture keeps up with the schema.
    await seeded.db.execute({
      sql: `CREATE TEMP TABLE c AS SELECT * FROM campaigns WHERE id = ?`,
      args: [SEED.campaignId],
    });
    await seeded.db.execute({ sql: "UPDATE c SET id = 'cmp_other'", args: [] });
    await seeded.db.execute({ sql: 'INSERT INTO campaigns SELECT * FROM c', args: [] });
    await seeded.db.execute({
      sql: `CREATE TEMP TABLE r AS SELECT * FROM recommendations WHERE id = ?`,
      args: [SEED.recommendationId],
    });
    await seeded.db.execute({
      sql: "UPDATE r SET id = 'rec_other', campaign_id = 'cmp_other'",
      args: [],
    });
    await seeded.db.execute({ sql: 'INSERT INTO recommendations SELECT * FROM r', args: [] });
    for (const id of ['act_o1', 'act_o2']) {
      await seeded.db.execute({
        sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
                                   mode, status, created_at, executed_at)
              VALUES (?, ?, 'rec_other', ?, 'send_email', 'email', 'customer_managed',
                      'completed', '2026-10-26T12:00:00.000Z', '2026-10-26T12:00:01.000Z')`,
        args: [id, SEED.workspaceId, SEED.personId],
      });
    }

    expect(await countActionsToday(seeded.db, SEED.workspaceId, at)).toBe(3);
    expect(await countCampaignActionsToday(seeded.db, SEED.workspaceId, SEED.campaignId, at)).toBe(
      1,
    );
    expect(await countCampaignActionsToday(seeded.db, SEED.workspaceId, 'cmp_other', at)).toBe(2);
  });
});
