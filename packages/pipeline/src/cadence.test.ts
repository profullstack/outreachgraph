/**
 * A cadence, and the one thing that makes it different from a sequencer.
 *
 * The mode of a step is not a property of the step. The same plan produces an
 * automated touch on a network we may automate and a human touch on one we may
 * not, decided by the capability matrix at execution time, and both land in the
 * same funnel. Most of these tests are about that.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { newId, type CadenceStep } from '@outreachgraph/domain';
import type { PolicyRequest } from '@outreachgraph/policy';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import {
  advanceCadences,
  createCadence,
  enrollInCadence,
  modeForDecision,
  setCadenceStatus,
  stopEnrollment,
} from './cadence';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

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

/** Policy inputs permissive enough that the capability matrix is what decides. */
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
    maxActionsPerProspectPerWeek: 5,
  };
}

interface RunOptions {
  readonly policy?: Partial<Omit<PolicyRequest, 'action' | 'network'>>;
  readonly createsRecommendation?: boolean;
  readonly at?: Date;
}

async function advance(db: Client, options: RunOptions = {}) {
  const made: Array<{ network: string; action: string }> = [];

  const result = await advanceCadences(
    {
      db,
      policyFor: async () => ({ ...permissive(), ...options.policy }),
      createRecommendation: async ({ step: s }) => {
        if (options.createsRecommendation === false) return undefined;
        made.push({ network: s.network, action: s.action });
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
      ...(options.at ? { now: options.at } : {}),
    },
    SEED.workspaceId,
  );

  return { result, made };
}

async function plan(db: Client, steps: readonly CadenceStep[]): Promise<string> {
  const created = await createCadence(db, {
    workspaceId: SEED.workspaceId,
    campaignId: SEED.campaignId,
    name: 'Test plan',
    steps,
    status: 'active',
  });

  if (!created.created) throw new Error(JSON.stringify(created.problems));
  return created.cadenceId;
}

async function enroll(db: Client, cadenceId: string, at?: Date) {
  return enrollInCadence(db, {
    cadenceId,
    workspaceId: SEED.workspaceId,
    campaignId: SEED.campaignId,
    personId: SEED.personId,
    ...(at ? { at } : {}),
  });
}

async function runs(db: Client) {
  return queryAll<{
    step_position: number;
    outcome: string;
    network: string;
    policy_gate: string | null;
  }>(
    db,
    'SELECT step_position, outcome, network, policy_gate FROM cadence_step_runs ORDER BY occurred_at, step_position',
  );
}

async function enrollment(db: Client) {
  return queryOne<{
    status: string;
    current_step: number;
    next_due_at: string | null;
    stopped_reason: string | null;
  }>(
    db,
    'SELECT status, current_step, next_due_at, stopped_reason FROM cadence_enrollments LIMIT 1',
  );
}

describe('modeForDecision', () => {
  test('maps every decision to a mode', () => {
    expect(modeForDecision('allow')).toBe('automated');
    expect(modeForDecision('allow_with_approval')).toBe('automated');
    expect(modeForDecision('manual_only')).toBe('manual');
    expect(modeForDecision('deny')).toBe('skipped');
  });
});

describe('createCadence', () => {
  test('writes a plan and its steps', async () => {
    seeded = await seedDatabase('cadence-create');
    const id = await plan(seeded.db, [step(), step({ position: 1, delayHours: 48 })]);

    const steps = await queryAll(seeded.db, 'SELECT * FROM cadence_steps WHERE cadence_id = ?', [
      id,
    ]);
    expect(steps).toHaveLength(2);
  });

  test('refuses a malformed plan without writing anything', async () => {
    seeded = await seedDatabase('cadence-invalid');

    const created = await createCadence(seeded.db, {
      workspaceId: SEED.workspaceId,
      name: 'Broken',
      steps: [step({ position: 3 })],
    });

    expect(created.created).toBe(false);
    expect(await queryAll(seeded.db, 'SELECT id FROM cadences')).toHaveLength(0);
  });

  test('refuses a nameless plan', async () => {
    seeded = await seedDatabase('cadence-noname');

    const created = await createCadence(seeded.db, {
      workspaceId: SEED.workspaceId,
      name: '   ',
      steps: [step()],
    });

    expect(created.created).toBe(false);
  });
});

describe('enrollInCadence', () => {
  test('schedules the first step', async () => {
    seeded = await seedDatabase('cadence-enroll');
    const id = await plan(seeded.db, [step({ delayHours: 24 })]);

    const at = new Date('2026-08-18T09:00:00.000Z');
    const result = await enroll(seeded.db, id, at);

    expect(result.enrolled).toBe(true);
    if (result.enrolled) expect(result.firstDueAt).toBe('2026-08-19T09:00:00.000Z');
  });

  test('refuses to enrol the same person twice', async () => {
    seeded = await seedDatabase('cadence-double');
    const id = await plan(seeded.db, [step()]);

    await enroll(seeded.db, id);
    const second = await enroll(seeded.db, id);

    expect(second.enrolled).toBe(false);
    if (!second.enrolled) expect(second.reason).toContain('already');
  });

  test('refuses a cadence with no steps', async () => {
    seeded = await seedDatabase('cadence-empty');
    const { db } = seeded;

    // Written directly, because `createCadence` will not produce one.
    await db.execute({
      sql: `INSERT INTO cadences (id, workspace_id, name, status, created_at, updated_at)
            VALUES ('cad_empty', ?, 'Empty', 'active', ?, ?)`,
      args: [SEED.workspaceId, now(), now()],
    });

    const result = await enrollInCadence(db, {
      cadenceId: 'cad_empty',
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      personId: SEED.personId,
    });

    expect(result.enrolled).toBe(false);
  });

  test('refuses a cadence belonging to another workspace', async () => {
    seeded = await seedDatabase('cadence-crossws');
    const id = await plan(seeded.db, [step()]);

    const result = await enrollInCadence(seeded.db, {
      cadenceId: id,
      workspaceId: 'wsp_somebody_else',
      campaignId: SEED.campaignId,
      personId: SEED.personId,
    });

    expect(result.enrolled).toBe(false);
  });
});

describe('advanceCadences', () => {
  test('runs a due step and schedules the next', async () => {
    seeded = await seedDatabase('cadence-advance');
    const { db } = seeded;
    const id = await plan(db, [step(), step({ position: 1, delayHours: 72 })]);
    await enroll(db, id, new Date('2026-08-18T09:00:00.000Z'));

    const { result, made } = await advance(db, { at: new Date('2026-08-18T09:00:01.000Z') });

    expect(result.considered).toBe(1);
    expect(result.automated).toBe(1);
    expect(made).toEqual([{ network: 'email', action: 'send_email' }]);

    const row = await enrollment(db);
    expect(row?.current_step).toBe(1);
    expect(row?.next_due_at).toBe('2026-08-21T09:00:00.000Z');
  });

  test('leaves a step that is not due yet alone', async () => {
    seeded = await seedDatabase('cadence-notdue');
    const { db } = seeded;
    const id = await plan(db, [step({ delayHours: 48 })]);
    await enroll(db, id, new Date('2026-08-18T09:00:00.000Z'));

    const { result } = await advance(db, { at: new Date('2026-08-18T10:00:00.000Z') });

    expect(result.considered).toBe(0);
  });

  test('turns a step we may not automate into a human one', async () => {
    // The whole point. LinkedIn messaging is `manual_only` in the capability
    // matrix, so the same plan shape produces a human touch here rather than
    // being refused or, worse, automated.
    seeded = await seedDatabase('cadence-manual');
    const { db } = seeded;
    const id = await plan(db, [step({ network: 'linkedin', action: 'send_dm' })]);
    await enroll(db, id, new Date('2026-08-18T09:00:00.000Z'));

    const { result } = await advance(db, { at: new Date('2026-08-18T09:00:01.000Z') });

    expect(result.manual).toBe(1);
    expect(result.automated).toBe(0);

    const recorded = await runs(db);
    expect(recorded[0]?.outcome).toBe('manual');
  });

  test('runs a mixed plan in both modes', async () => {
    seeded = await seedDatabase('cadence-mixed');
    const { db } = seeded;
    const id = await plan(db, [
      step({ position: 0, network: 'email', action: 'send_email' }),
      step({ position: 1, network: 'linkedin', action: 'send_dm', delayHours: 24 }),
    ]);
    await enroll(db, id, new Date('2026-08-18T09:00:00.000Z'));

    const first = await advance(db, { at: new Date('2026-08-18T09:00:01.000Z') });
    const second = await advance(db, { at: new Date('2026-08-19T09:00:01.000Z') });

    expect(first.result.automated).toBe(1);
    expect(second.result.manual).toBe(1);

    // Both steps are in the same table, counted the same way. A campaign where
    // the email half advances and the social half vanishes is a campaign whose
    // numbers are wrong.
    const recorded = await runs(db);
    expect(recorded.map((r) => r.outcome)).toEqual(['automated', 'manual']);
  });

  test('records the gate when a step is denied', async () => {
    seeded = await seedDatabase('cadence-denied');
    const { db } = seeded;
    const id = await plan(db, [step()]);
    await enroll(db, id, new Date('2026-08-18T09:00:00.000Z'));

    const { result } = await advance(db, {
      at: new Date('2026-08-18T09:00:01.000Z'),
      policy: { personSuppressed: true },
    });

    expect(result.skipped).toBe(1);

    const recorded = await runs(db);
    expect(recorded[0]?.outcome).toBe('skipped');
    expect(recorded[0]?.policy_gate).toBe('person_ineligible');
  });

  test('stops the whole plan when they reply', async () => {
    seeded = await seedDatabase('cadence-replied');
    const { db } = seeded;
    const id = await plan(db, [step(), step({ position: 1, delayHours: 24 })]);
    await enroll(db, id, new Date('2026-08-18T09:00:00.000Z'));

    await db.execute({
      sql: `INSERT INTO interactions (id, workspace_id, person_id, network, direction,
            state, occurred_at, recorded_at)
            VALUES (?, ?, ?, 'email', 'inbound', 'replied', ?, ?)`,
      args: [newId('interaction'), SEED.workspaceId, SEED.personId, now(), now()],
    });

    const { result } = await advance(db, { at: new Date('2026-08-18T09:00:01.000Z') });

    expect(result.stopped).toBe(1);

    const row = await enrollment(db);
    expect(row?.status).toBe('stopped');
    expect(row?.stopped_reason).toBe('they replied');
    // And it stays stopped rather than producing a refused card every tick.
    expect(row?.next_due_at).toBeNull();
  });

  test('completes an enrollment at the end of the plan', async () => {
    seeded = await seedDatabase('cadence-complete');
    const { db } = seeded;
    const id = await plan(db, [step()]);
    await enroll(db, id, new Date('2026-08-18T09:00:00.000Z'));

    const { result } = await advance(db, { at: new Date('2026-08-18T09:00:01.000Z') });

    expect(result.completed).toBe(1);
    expect((await enrollment(db))?.status).toBe('completed');
  });

  test('advances one step per tick, never a backlog at once', async () => {
    // An enrollment paused for a fortnight has several steps notionally
    // overdue. Firing them together would put three messages in front of one
    // person in a second, which is the exact pattern the limits exist to stop.
    seeded = await seedDatabase('cadence-backlog');
    const { db } = seeded;
    const id = await plan(db, [
      step({ position: 0 }),
      step({ position: 1, delayHours: 1 }),
      step({ position: 2, delayHours: 1 }),
    ]);
    await enroll(db, id, new Date('2026-08-01T09:00:00.000Z'));

    const { result, made } = await advance(db, { at: new Date('2026-08-18T09:00:00.000Z') });

    expect(result.considered).toBe(1);
    expect(made).toHaveLength(1);
  });

  test('ignores enrollments on a paused cadence', async () => {
    seeded = await seedDatabase('cadence-paused');
    const { db } = seeded;
    const id = await plan(db, [step()]);
    await enroll(db, id, new Date('2026-08-18T09:00:00.000Z'));
    await setCadenceStatus(db, SEED.workspaceId, id, 'paused');

    const { result } = await advance(db, { at: new Date('2026-08-18T09:00:01.000Z') });

    expect(result.considered).toBe(0);
  });

  test('counts a step that produced no card as skipped, not as sent', async () => {
    seeded = await seedDatabase('cadence-nodraft');
    const { db } = seeded;
    const id = await plan(db, [step()]);
    await enroll(db, id, new Date('2026-08-18T09:00:00.000Z'));

    const { result } = await advance(db, {
      at: new Date('2026-08-18T09:00:01.000Z'),
      createsRecommendation: false,
    });

    expect(result.automated).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('does not touch another workspace’s enrollments', async () => {
    seeded = await seedDatabase('cadence-isolation');
    const { db } = seeded;
    const id = await plan(db, [step()]);
    await enroll(db, id, new Date('2026-08-18T09:00:00.000Z'));

    const result = await advanceCadences(
      {
        db,
        policyFor: async () => permissive(),
        createRecommendation: async () => newId('recommendation'),
        now: new Date('2026-08-18T09:00:01.000Z'),
      },
      'wsp_somebody_else',
    );

    expect(result.considered).toBe(0);
  });
});

describe('stopEnrollment', () => {
  test('takes somebody off a plan', async () => {
    seeded = await seedDatabase('cadence-stop');
    const { db } = seeded;
    const id = await plan(db, [step(), step({ position: 1, delayHours: 24 })]);
    const enrolled = await enroll(db, id, new Date('2026-08-18T09:00:00.000Z'));
    if (!enrolled.enrolled) throw new Error('not enrolled');

    expect(
      await stopEnrollment(db, SEED.workspaceId, enrolled.enrollmentId, 'changed my mind'),
    ).toBe(true);

    const { result } = await advance(db, { at: new Date('2026-08-20T09:00:00.000Z') });
    expect(result.considered).toBe(0);
  });

  test('reports when there was nothing to stop', async () => {
    seeded = await seedDatabase('cadence-stop-missing');

    expect(await stopEnrollment(seeded.db, SEED.workspaceId, 'enr_nope', 'x')).toBe(false);
  });
});
