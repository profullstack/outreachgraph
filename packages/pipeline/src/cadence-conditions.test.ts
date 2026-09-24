/**
 * Branching plans, run: a step's condition decides whether it runs, and an
 * acceptance window decides when a connection-dependent step is decided.
 *
 * The policy engine is stubbed permissive here (as in `cadence.test.ts`), so
 * the only thing standing between a step and a card is its condition.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { newId, type CadenceStep } from '@outreachgraph/domain';
import type { PolicyRequest } from '@outreachgraph/policy';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { advanceCadences, createCadence, enrollInCadence } from './cadence';
import { recordInvitationSent, recordObservedStatus } from './linkedin-connections';

let seeded: SeededDatabase | undefined;
afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const ENROLLED = new Date('2026-09-01T09:00:00.000Z');
const HOUR = 3_600_000;

function step(overrides: Partial<CadenceStep> = {}): CadenceStep {
  return {
    position: 0,
    network: 'email',
    action: 'send_email',
    delayHours: 0,
    stopOnReply: true,
    ...overrides,
  };
}

/** Visit, invite and wait a week, then message if accepted or email if not. */
const LINKEDIN_THEN_EMAIL: readonly CadenceStep[] = [
  step({ position: 0, network: 'linkedin', action: 'view_profile' }),
  step({ position: 1, network: 'linkedin', action: 'connect', waitForAcceptanceHours: 168 }),
  step({
    position: 2,
    network: 'linkedin',
    action: 'send_dm',
    delayHours: 24,
    condition: 'if_connected',
  }),
  step({ position: 3, condition: 'if_not_connected' }),
];

function permissive(): Omit<PolicyRequest, 'action' | 'network'> {
  return {
    approvalMode: 'draft_and_approve',
    hasConnectedAccount: true,
    personSuppressed: false,
    personBelievedMinor: false,
    personDeleted: false,
    identityConfidence: 0.99,
    minIdentityConfidence: 0.85,
    actionsToday: 0,
    maxActionsPerDay: 50,
    actionsToThisProspectThisWeek: 0,
    maxActionsPerProspectPerWeek: 50,
  };
}

async function tick(db: Client, at: Date) {
  return advanceCadences(
    {
      db,
      policyFor: async () => permissive(),
      createRecommendation: async ({ step: s }) => {
        const id = newId('recommendation');
        await db.execute({
          sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action,
                network, priority, reason, policy_status, policy_version, expected_goal,
                status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 50, 'cadence step', 'allow_with_approval', 'test',
                'start_conversation', 'pending', ?)`,
          args: [id, SEED.workspaceId, SEED.campaignId, SEED.personId, s.action, s.network, now()],
        });
        return id;
      },
      now: at,
    },
    SEED.workspaceId,
  );
}

async function start(db: Client, steps: readonly CadenceStep[]): Promise<string> {
  const created = await createCadence(db, {
    workspaceId: SEED.workspaceId,
    campaignId: SEED.campaignId,
    name: 'Branching plan',
    steps,
    status: 'active',
  });
  if (!created.created) throw new Error(JSON.stringify(created.problems));
  await enrollInCadence(db, {
    cadenceId: created.cadenceId,
    workspaceId: SEED.workspaceId,
    campaignId: SEED.campaignId,
    personId: SEED.personId,
    at: ENROLLED,
  });
  return created.cadenceId;
}

async function runs(db: Client) {
  return queryAll<{
    step_position: number;
    outcome: string;
    policy_gate: string | null;
    policy_decision: string | null;
    detail: string;
  }>(
    db,
    `SELECT step_position, outcome, policy_gate, policy_decision, detail
       FROM cadence_step_runs ORDER BY occurred_at, step_position`,
  );
}

async function enrollment(db: Client) {
  return queryOne<{ current_step: number; next_due_at: string | null; status: string }>(
    db,
    'SELECT current_step, next_due_at, status FROM cadence_enrollments LIMIT 1',
  );
}

/** Runs the visit and the invitation, which fall due together at enrollment. */
async function throughInvitation(db: Client): Promise<void> {
  await tick(db, new Date(ENROLLED.getTime() + 1000));
  await tick(db, new Date(ENROLLED.getTime() + 2000));
  await recordInvitationSent(db, {
    workspaceId: SEED.workspaceId,
    personId: SEED.personId,
    profileRef: 'https://www.linkedin.com/in/jane-doe/',
    at: new Date(ENROLLED.getTime() + 3000).toISOString(),
  });
}

describe('conditions, stored and read back', () => {
  test('the API shape survives a round trip through the database', async () => {
    seeded = await seedDatabase('branch-roundtrip');
    const { db } = seeded;
    const cadenceId = await start(db, LINKEDIN_THEN_EMAIL);

    const rows = await queryAll<{
      position: number;
      run_condition: string | null;
      wait_for_acceptance_hours: number | null;
    }>(
      db,
      `SELECT position, run_condition, wait_for_acceptance_hours FROM cadence_steps
        WHERE cadence_id = ? ORDER BY position`,
      [cadenceId],
    );
    expect(rows).toEqual([
      { position: 0, run_condition: null, wait_for_acceptance_hours: null },
      { position: 1, run_condition: null, wait_for_acceptance_hours: 168 },
      { position: 2, run_condition: 'if_connected', wait_for_acceptance_hours: null },
      { position: 3, run_condition: 'if_not_connected', wait_for_acceptance_hours: null },
    ]);
  });
});

describe('a false condition', () => {
  test('is skipped on the record, named, and the plan moves on', async () => {
    seeded = await seedDatabase('branch-skip');
    const { db } = seeded;
    await start(db, [
      step(),
      step({ position: 1, condition: 'if_clicked' }),
      step({ position: 2 }),
    ]);

    await tick(db, new Date(ENROLLED.getTime() + 1000));
    const result = await tick(db, new Date(ENROLLED.getTime() + 2000));
    expect(result.skipped).toBe(1);

    const skipped = (await runs(db))[1]!;
    expect(skipped).toMatchObject({
      step_position: 1,
      outcome: 'skipped',
      policy_gate: 'condition',
      policy_decision: null,
    });
    expect(skipped.detail).toContain('only if they clicked a link');

    // The step after it still runs.
    await tick(db, new Date(ENROLLED.getTime() + 3000));
    expect((await runs(db)).map((r) => r.outcome)).toEqual(['automated', 'skipped', 'automated']);
    expect((await enrollment(db))?.status).toBe('completed');
  });

  test('a click on an earlier email makes "if clicked" true', async () => {
    seeded = await seedDatabase('branch-clicked');
    const { db } = seeded;
    await start(db, [step(), step({ position: 1, condition: 'if_clicked' })]);
    await tick(db, new Date(ENROLLED.getTime() + 1000));

    await db.execute({
      sql: `INSERT INTO interactions (id, workspace_id, person_id, network, direction, state,
            occurred_at, recorded_at)
            VALUES (?, ?, ?, 'email', 'inbound', 'clicked', ?, ?)`,
      args: [newId('interaction'), SEED.workspaceId, SEED.personId, now(), now()],
    });

    const result = await tick(db, new Date(ENROLLED.getTime() + 2000));
    expect(result.automated).toBe(1);
  });

  test('"if no reply" skips once they have replied, even with stop-on-reply off', async () => {
    seeded = await seedDatabase('branch-no-reply');
    const { db } = seeded;
    await start(db, [
      step({ stopOnReply: false }),
      step({ position: 1, condition: 'if_no_reply', stopOnReply: false }),
    ]);
    await tick(db, new Date(ENROLLED.getTime() + 1000));

    await db.execute({
      sql: `INSERT INTO interactions (id, workspace_id, person_id, network, direction, state,
            occurred_at, recorded_at)
            VALUES (?, ?, ?, 'email', 'inbound', 'replied', ?, ?)`,
      args: [newId('interaction'), SEED.workspaceId, SEED.personId, now(), now()],
    });

    const result = await tick(db, new Date(ENROLLED.getTime() + 2000));
    expect(result.skipped).toBe(1);
    expect((await runs(db))[1]?.detail).toContain('they replied');
  });
});

describe('the acceptance window', () => {
  test('holds the branch while the invitation is open, then takes the accepted side', async () => {
    seeded = await seedDatabase('branch-accepted');
    const { db } = seeded;
    await start(db, LINKEDIN_THEN_EMAIL);
    await throughInvitation(db);

    // A day later the DM step is due, but nobody has accepted: it waits.
    const dayLater = new Date(ENROLLED.getTime() + 25 * HOUR);
    const waited = await tick(db, dayLater);
    expect(waited.waiting).toBe(1);
    expect(await runs(db)).toHaveLength(2);
    const held = await enrollment(db);
    expect(held?.current_step).toBe(2);
    expect(Date.parse(held!.next_due_at!)).toBe(dayLater.getTime() + 6 * HOUR);

    // They accept; the next look runs the DM and the email branch is skipped.
    await recordObservedStatus(db, {
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      profileRef: 'https://www.linkedin.com/in/jane-doe/',
      status: 'connected',
    });
    await tick(db, new Date(dayLater.getTime() + 6 * HOUR));
    await tick(db, new Date(dayLater.getTime() + 6 * HOUR + 1000));

    const recorded = await runs(db);
    expect(recorded.map((r) => [r.step_position, r.outcome])).toEqual([
      [0, 'automated'],
      [1, 'automated'],
      [2, 'automated'],
      [3, 'skipped'],
    ]);
    expect(recorded[3]?.detail).toContain('not a LinkedIn connection, and they are one');
  });

  test('when the window closes unanswered, the email branch runs instead', async () => {
    seeded = await seedDatabase('branch-lapsed');
    const { db } = seeded;
    await start(db, LINKEDIN_THEN_EMAIL);
    await throughInvitation(db);

    // Waits at every look inside the week...
    for (let hours = 25; hours < 168; hours += 24) {
      const result = await tick(db, new Date(ENROLLED.getTime() + hours * HOUR));
      expect(result.waiting ?? 0).toBeLessThanOrEqual(1);
    }
    expect(await runs(db)).toHaveLength(2);

    // ...and decides once it has passed.
    const after = new Date(ENROLLED.getTime() + 169 * HOUR);
    await tick(db, after);
    await tick(db, new Date(after.getTime() + 1000));

    const recorded = await runs(db);
    expect(recorded.map((r) => [r.step_position, r.outcome])).toEqual([
      [0, 'automated'],
      [1, 'automated'],
      [2, 'skipped'],
      [3, 'automated'],
    ]);
    expect(recorded[2]?.detail).toContain(
      'only if they are a LinkedIn connection, and they are not',
    );
  });

  test('a window never waits past its own end', async () => {
    seeded = await seedDatabase('branch-window-end');
    const { db } = seeded;
    await start(db, LINKEDIN_THEN_EMAIL);
    await throughInvitation(db);

    const nearEnd = new Date(ENROLLED.getTime() + 166 * HOUR);
    await tick(db, nearEnd);
    const held = await enrollment(db);
    // Six hours would overshoot the window; it looks again when the window closes.
    expect(Date.parse(held!.next_due_at!)).toBeLessThanOrEqual(
      ENROLLED.getTime() + 168 * HOUR + 2000,
    );
  });

  test('someone already connected takes the connected branch without waiting', async () => {
    seeded = await seedDatabase('branch-already');
    const { db } = seeded;
    await start(db, LINKEDIN_THEN_EMAIL);
    await tick(db, new Date(ENROLLED.getTime() + 1000));
    await recordObservedStatus(db, {
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      profileRef: 'jane-doe',
      status: 'connected',
    });
    await tick(db, new Date(ENROLLED.getTime() + 2000));

    const result = await tick(db, new Date(ENROLLED.getTime() + 25 * HOUR));
    expect(result.waiting ?? 0).toBe(0);
    expect(result.automated).toBe(1);
  });
});
