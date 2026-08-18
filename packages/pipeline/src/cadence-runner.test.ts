/**
 * The production wiring, tested against the real policy engine.
 *
 * `cadence.test.ts` proves the scheduler with a permissive stub, which is the
 * right way to test scheduling and the wrong way to be sure a cadence obeys
 * the gates. These tests use the real inputs, because the failure this guards
 * against is a cadence that quietly sends past a limit the approval path
 * respects.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { newId, type CadenceStep } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { createCadence, enrollInCadence } from './cadence';
import { runCadences } from './cadence-runner';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const ENROLLED = new Date('2026-08-18T09:00:00.000Z');
const DUE = new Date('2026-08-18T09:00:01.000Z');

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

async function planAndEnrol(db: Client, steps: readonly CadenceStep[]): Promise<void> {
  const created = await createCadence(db, {
    workspaceId: SEED.workspaceId,
    campaignId: SEED.campaignId,
    name: 'Runner plan',
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
}

async function cards(db: Client) {
  return queryAll<{ action: string; network: string; policy_status: string; reason: string }>(
    db,
    `SELECT action, network, policy_status, reason FROM recommendations
      WHERE reason LIKE 'Cadence step%' ORDER BY created_at`,
  );
}

describe('runCadences', () => {
  test('writes a real recommendation for a permitted step', async () => {
    seeded = await seedDatabase('runner-permitted');
    const { db } = seeded;
    await planAndEnrol(db, [step({ intent: 'reference their settlement post' })]);

    const result = await runCadences(
      { db, platformEmailEnabled: true, now: DUE },
      SEED.workspaceId,
    );

    expect(result.automated).toBe(1);

    const written = await cards(db);
    expect(written).toHaveLength(1);
    expect(written[0]?.network).toBe('email');
    // The step's intent reaches the card, so a reviewer knows what this touch
    // is for rather than seeing an unexplained second email.
    expect(written[0]?.reason).toContain('settlement post');
  });

  test('refuses a suppressed person through the real gate', async () => {
    seeded = await seedDatabase('runner-suppressed');
    const { db } = seeded;
    await planAndEnrol(db, [step()]);

    await db.execute({
      sql: `UPDATE people SET status = 'suppressed' WHERE id = ?`,
      args: [SEED.personId],
    });

    const result = await runCadences(
      { db, platformEmailEnabled: true, now: DUE },
      SEED.workspaceId,
    );

    expect(result.skipped).toBe(1);
    expect(await cards(db)).toHaveLength(0);
  });

  test('honours a suppression tombstone, not just the person row', async () => {
    // The tombstone is what survives deletion, so a cadence that only checked
    // `people.status` would happily re-contact somebody who opted out.
    seeded = await seedDatabase('runner-tombstone');
    const { db } = seeded;
    await planAndEnrol(db, [step()]);

    const suppressionId = newId('suppression');
    await db.execute({
      sql: `INSERT INTO suppression_entries (id, workspace_id, scope, reason, source, created_at)
            VALUES (?, ?, 'workspace', 'opted out', 'unsubscribe', ?)`,
      args: [suppressionId, SEED.workspaceId, now()],
    });
    await db.execute({
      sql: `INSERT INTO suppression_keys (match_key, suppression_id, scope, workspace_id)
            VALUES (?, ?, 'workspace', ?)`,
      args: [`person:${SEED.personId}`, suppressionId, SEED.workspaceId],
    });

    const result = await runCadences(
      { db, platformEmailEnabled: true, now: DUE },
      SEED.workspaceId,
    );

    expect(result.skipped).toBe(1);
  });

  test('does not queue the same step twice', async () => {
    seeded = await seedDatabase('runner-idempotent');
    const { db } = seeded;
    await planAndEnrol(db, [step(), step({ position: 1, delayHours: 0 })]);

    // Both steps are the same (network, action) and both fall due immediately,
    // so the second tick must find the first card rather than add another ask.
    await runCadences({ db, platformEmailEnabled: true, now: DUE }, SEED.workspaceId);
    await runCadences({ db, platformEmailEnabled: true, now: DUE }, SEED.workspaceId);

    expect(await cards(db)).toHaveLength(1);
  });

  test('records a manual step for a network we may not automate', async () => {
    seeded = await seedDatabase('runner-manual');
    const { db } = seeded;
    await planAndEnrol(db, [step({ network: 'linkedin', action: 'send_dm' })]);

    const result = await runCadences(
      { db, platformEmailEnabled: true, now: DUE },
      SEED.workspaceId,
    );

    expect(result.manual).toBe(1);

    const run = await queryOne<{ outcome: string; policy_decision: string }>(
      db,
      'SELECT outcome, policy_decision FROM cadence_step_runs LIMIT 1',
    );
    expect(run?.outcome).toBe('manual');
    expect(run?.policy_decision).toBe('manual_only');
  });

  test('leaves the plan alone when nothing is due', async () => {
    seeded = await seedDatabase('runner-notdue');
    const { db } = seeded;
    await planAndEnrol(db, [step({ delayHours: 72 })]);

    const result = await runCadences(
      { db, platformEmailEnabled: true, now: DUE },
      SEED.workspaceId,
    );

    expect(result.considered).toBe(0);
  });
});
