import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { recordStatus } from './stages';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

describe('recordStatus', () => {
  test('moves the lead and records the move', async () => {
    seeded = await seedDatabase('stages-record');
    const { db } = seeded;

    const result = await recordStatus(db, {
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      personId: SEED.personId,
      status: 'awaiting_approval',
    });

    expect(result.changed).toBe(true);
    expect(result.from).toBe('recommended');
    expect(result.stage).toBe('ready');

    const current = await queryOne<{ status: string }>(
      db,
      `SELECT status FROM campaign_people WHERE campaign_id = ? AND person_id = ?`,
      [SEED.campaignId, SEED.personId],
    );
    expect(current?.status).toBe('awaiting_approval');

    const events = await queryAll<{ from_status: string; to_status: string; stage: string }>(
      db,
      `SELECT from_status, to_status, stage FROM lead_stage_events WHERE person_id = ?`,
      [SEED.personId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.from_status).toBe('recommended');
    expect(events[0]?.stage).toBe('ready');
  });

  test('re-recording the same status writes no event', async () => {
    seeded = await seedDatabase('stages-idempotent');
    const { db } = seeded;

    // The pipeline re-runs stages when it resumes. A resumed run must not look
    // like a lead bouncing between stages.
    await recordStatus(db, {
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      personId: SEED.personId,
      status: 'qualified',
    });
    const second = await recordStatus(db, {
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      personId: SEED.personId,
      status: 'qualified',
    });

    expect(second.changed).toBe(false);

    const events = await queryAll<{ id: string }>(
      db,
      `SELECT id FROM lead_stage_events WHERE person_id = ?`,
      [SEED.personId],
    );
    expect(events).toHaveLength(1);
  });

  test('several internal moves inside one funnel stage each keep their event', async () => {
    seeded = await seedDatabase('stages-granular');
    const { db } = seeded;

    for (const status of ['enriching', 'resolved']) {
      await recordStatus(db, {
        workspaceId: SEED.workspaceId,
        campaignId: SEED.campaignId,
        personId: SEED.personId,
        status,
      });
    }

    const events = await queryAll<{ stage: string; to_status: string }>(
      db,
      `SELECT stage, to_status FROM lead_stage_events WHERE person_id = ? ORDER BY occurred_at`,
      [SEED.personId],
    );

    // Two distinct statuses, both mapping to "Found". The history keeps the
    // detail; the chart is what collapses it.
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.stage === 'discovered')).toBe(true);
  });

  test('a lead in no campaign is a no-op rather than a crash', async () => {
    seeded = await seedDatabase('stages-missing');
    const { db } = seeded;

    const result = await recordStatus(db, {
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      personId: 'per_nobody',
      status: 'qualified',
    });

    expect(result.changed).toBe(false);
  });
});
