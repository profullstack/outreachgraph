import { afterEach, describe, expect, test } from 'bun:test';
import { queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { abResults, promoteAbWinners, variantStats } from './ab-winners';
import { createCadence } from './cadence';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

async function testedCadence(db: Client): Promise<string> {
  const created = await createCadence(db, {
    workspaceId: SEED.workspaceId,
    campaignId: SEED.campaignId,
    name: 'Tested',
    status: 'active',
    steps: [
      {
        position: 0,
        network: 'email',
        action: 'send_email',
        delayHours: 0,
        stopOnReply: true,
        intent: 'reference their post',
        variants: ['ask who owns onboarding'],
      },
    ],
  });
  if (!created.created) throw new Error('cadence not created');
  return created.cadenceId;
}

/**
 * `people` prospects on one arm of step 0, each sent to, `replies` of whom
 * answered — through the poll's spelling, `responded`.
 */
async function arm(
  db: Client,
  cadenceId: string,
  variant: string,
  people: number,
  replies: number,
): Promise<void> {
  const sentAt = '2026-09-01T10:00:00.000Z';
  for (let i = 0; i < people; i += 1) {
    const key = `${variant}${i}`;
    const statements = [
      {
        sql: `INSERT INTO people (id, display_name, status, identity_confidence, created_at, updated_at)
              VALUES (?, ?, 'active', 0.95, ?, ?)`,
        args: [`per_${key}`, `Person ${key}`, sentAt, sentAt],
      },
      {
        sql: `INSERT INTO cadence_enrollments (id, cadence_id, workspace_id, campaign_id, person_id,
              status, current_step, enrolled_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'completed', 1, ?, ?)`,
        args: [
          `enr_${key}`,
          cadenceId,
          SEED.workspaceId,
          SEED.campaignId,
          `per_${key}`,
          sentAt,
          sentAt,
        ],
      },
      {
        sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
              reason, policy_status, policy_version, status, created_at, variant)
              VALUES (?, ?, ?, ?, 'send_email', 'email', 'Cadence step 1', 'allow', 'v', 'executed', ?, ?)`,
        args: [`rec_${key}`, SEED.workspaceId, SEED.campaignId, `per_${key}`, sentAt, variant],
      },
      {
        sql: `INSERT INTO cadence_step_runs (id, enrollment_id, workspace_id, step_position, network,
              action, outcome, recommendation_id, occurred_at, variant)
              VALUES (?, ?, ?, 0, 'email', 'send_email', 'automated', ?, ?, ?)`,
        args: [`run_${key}`, `enr_${key}`, SEED.workspaceId, `rec_${key}`, sentAt, variant],
      },
      {
        sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
              mode, status, created_at, executed_at)
              VALUES (?, ?, ?, ?, 'send_email', 'email', 'customer_managed', 'completed', ?, ?)`,
        args: [`act_${key}`, SEED.workspaceId, `rec_${key}`, `per_${key}`, sentAt, sentAt],
      },
    ];
    if (i < replies) {
      statements.push({
        sql: `INSERT INTO interactions (id, workspace_id, person_id, network, direction, state,
              occurred_at, recorded_at)
              VALUES (?, ?, ?, 'email', 'inbound', 'responded', ?, ?)`,
        args: [`int_${key}`, SEED.workspaceId, `per_${key}`, '2026-09-02T10:00:00.000Z', sentAt],
      });
    }
    await db.batch(statements);
  }
}

describe('promoteAbWinners', () => {
  test('a clear winner becomes the step intent, and the test is recorded', async () => {
    seeded = await seedDatabase('ab-promote');
    const { db } = seeded;
    const cadenceId = await testedCadence(db);
    await arm(db, cadenceId, 'A', 60, 1);
    await arm(db, cadenceId, 'B', 60, 9);

    // Poll-recorded replies count.
    const stats = await variantStats(db, SEED.workspaceId, cadenceId);
    expect(stats.map((row) => [row.variant, row.sent, row.replied])).toEqual([
      ['A', 60, 1],
      ['B', 60, 9],
    ]);

    const promoted = await promoteAbWinners(db, SEED.workspaceId);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.winner).toBe('B');

    const step = await queryOne<{ intent: string; variants_json: string | null }>(
      db,
      `SELECT intent, variants_json FROM cadence_steps WHERE cadence_id = ? AND position = 0`,
      [cadenceId],
    );
    expect(step?.intent).toBe('ask who owns onboarding');
    expect(step?.variants_json).toBeNull();

    const [result] = await abResults(db, SEED.workspaceId, { cadenceId });
    expect(result?.winner).toBe('B');
    expect(result?.basis).toBe('significant');

    // Decided runs no longer count, so a fresh test on the step starts at zero.
    expect(await variantStats(db, SEED.workspaceId, cadenceId)).toEqual([]);
  });

  test('a test still short of 50 per arm is left alone', async () => {
    seeded = await seedDatabase('ab-wait');
    const { db } = seeded;
    const cadenceId = await testedCadence(db);
    await arm(db, cadenceId, 'A', 60, 0);
    await arm(db, cadenceId, 'B', 20, 8);

    expect(await promoteAbWinners(db, SEED.workspaceId)).toEqual([]);
  });
});
