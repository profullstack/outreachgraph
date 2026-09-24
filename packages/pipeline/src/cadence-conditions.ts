/**
 * Step conditions, at the moment a step falls due.
 *
 * A branching plan is still a list: each step may carry a condition, and a
 * step whose condition is false is skipped on the record while the enrollment
 * moves on. "If accepted, message them; otherwise, email them" is two
 * neighbouring steps with opposite conditions. This module answers the one
 * question the scheduler asks of such a step — run it, skip it, or not yet —
 * from facts the product has already stored. It never calls a network: the
 * LinkedIn connection state is whatever the acceptance check last recorded.
 *
 * "Not yet" exists for exactly one case. A connect step with an acceptance
 * window makes every later connection-dependent step wait, while the
 * invitation might still be accepted, instead of deciding the moment its own
 * delay elapses. Without that, "if connected" would be read a day after the
 * invitation went out and be false for nearly everyone.
 *
 * Kept out of `cadence.ts` so the scheduler's own functions change by a few
 * lines, and the columns this reads (added in 0042) are loaded and saved in
 * one place.
 */

import {
  isConnectionCondition,
  isStepCondition,
  STEP_CONDITION_LABELS,
  stepConditionHolds,
  type CadenceStep,
  type StepCondition,
} from '@outreachgraph/domain';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';

/**
 * How often a waiting step looks again. The acceptance check reads each
 * pending invitation once a day, so looking more often than this would only
 * re-read the same row.
 */
export const ACCEPTANCE_RECHECK_HOURS = 6;

export type ConditionVerdict =
  | { readonly kind: 'run' }
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'wait'; readonly until: Date; readonly reason: string };

/** Reads the branching columns and lays them over steps loaded without them. */
export async function withBranching(
  db: Client,
  cadenceId: string,
  steps: readonly CadenceStep[],
): Promise<readonly CadenceStep[]> {
  const rows = await queryAll<{
    position: number;
    run_condition: string | null;
    wait_for_acceptance_hours: number | null;
  }>(
    db,
    `SELECT position, run_condition, wait_for_acceptance_hours
       FROM cadence_steps WHERE cadence_id = ?`,
    [cadenceId],
  );
  const byPosition = new Map(rows.map((row) => [row.position, row]));

  return steps.map((step) => {
    const row = byPosition.get(step.position);
    const condition = row?.run_condition;
    const wait = row?.wait_for_acceptance_hours;
    return {
      ...step,
      ...(condition && isStepCondition(condition) && condition !== 'always' ? { condition } : {}),
      ...(typeof wait === 'number' && wait > 0 ? { waitForAcceptanceHours: wait } : {}),
    };
  });
}

/** Writes the branching columns for a freshly inserted plan. */
export async function saveBranching(
  db: Client,
  cadenceId: string,
  steps: readonly CadenceStep[],
): Promise<void> {
  for (const step of steps) {
    if (!step.condition && step.waitForAcceptanceHours === undefined) continue;
    await db.execute({
      sql: `UPDATE cadence_steps SET run_condition = ?, wait_for_acceptance_hours = ?
             WHERE cadence_id = ? AND position = ?`,
      args: [
        step.condition && step.condition !== 'always' ? step.condition : null,
        step.waitForAcceptanceHours ?? null,
        cadenceId,
        step.position,
      ],
    });
  }
}

/**
 * Decides whether a due step runs.
 *
 * Deterministic, like the policy engine that runs after it: the same stored
 * facts always give the same answer, and a skip names the condition in a
 * sentence rather than a code.
 */
export async function resolveStepCondition(
  db: Client,
  enrollment: { readonly id: string; readonly workspace_id: string; readonly person_id: string },
  step: CadenceStep,
  steps: readonly CadenceStep[],
  at: Date,
): Promise<ConditionVerdict> {
  const condition: StepCondition = step.condition ?? 'always';
  if (condition === 'always') return { kind: 'run' };

  const facts = await conditionFacts(db, enrollment.workspace_id, enrollment.person_id);

  if (isConnectionCondition(condition) && !facts.connected) {
    const until = await acceptanceWindowEnd(db, enrollment.id, step, steps);
    if (until && at < until) {
      const recheck = new Date(at.getTime() + ACCEPTANCE_RECHECK_HOURS * 3_600_000);
      return {
        kind: 'wait',
        until: recheck < until ? recheck : until,
        reason: 'Waiting to see whether they accept the LinkedIn invitation.',
      };
    }
  }

  if (stepConditionHolds(condition, facts)) return { kind: 'run' };
  return { kind: 'skip', reason: skipReason(condition) };
}

function skipReason(condition: StepCondition): string {
  const label = STEP_CONDITION_LABELS[condition];
  switch (condition) {
    case 'if_connected':
      return `This step runs ${label}, and they are not.`;
    case 'if_not_connected':
      return `This step runs ${label}, and they are one.`;
    case 'if_no_reply':
      return `This step runs ${label}, and they replied.`;
    case 'if_clicked':
      return `This step runs ${label}, and they have not clicked one.`;
    case 'if_not_clicked':
      return `This step runs ${label}, and they clicked one.`;
    case 'always':
      return 'This step always runs.';
  }
}

async function conditionFacts(
  db: Client,
  workspaceId: string,
  personId: string,
): Promise<{ connected: boolean; replied: boolean; clicked: boolean }> {
  const connection = await queryOne<{ status: string }>(
    db,
    `SELECT status FROM linkedin_connections WHERE workspace_id = ? AND person_id = ?`,
    [workspaceId, personId],
  );
  const engagement = await queryOne<{ replied: number | null; clicked: number | null }>(
    db,
    `SELECT sum(CASE WHEN state = 'replied' THEN 1 ELSE 0 END) AS replied,
            sum(CASE WHEN state = 'clicked' THEN 1 ELSE 0 END) AS clicked
       FROM interactions
      WHERE workspace_id = ? AND person_id = ? AND direction = 'inbound'`,
    [workspaceId, personId],
  );

  return {
    connected: connection?.status === 'connected',
    replied: Number(engagement?.replied ?? 0) > 0,
    clicked: Number(engagement?.clicked ?? 0) > 0,
  };
}

/**
 * When the acceptance window governing this step closes, if one does.
 *
 * The window belongs to the nearest earlier LinkedIn connect step that has
 * one, and it opens when that step actually ran for this enrollment — not
 * when it was scheduled, and not when a human later approved its card. A
 * connect step that was skipped opened no window: there is nothing to wait
 * for.
 */
async function acceptanceWindowEnd(
  db: Client,
  enrollmentId: string,
  step: CadenceStep,
  steps: readonly CadenceStep[],
): Promise<Date | undefined> {
  const connect = [...steps]
    .filter(
      (s) =>
        s.position < step.position &&
        s.network === 'linkedin' &&
        s.action === 'connect' &&
        s.waitForAcceptanceHours !== undefined,
    )
    .sort((a, b) => b.position - a.position)[0];
  if (!connect?.waitForAcceptanceHours) return undefined;

  const ran = await queryOne<{ occurred_at: string }>(
    db,
    `SELECT occurred_at FROM cadence_step_runs
      WHERE enrollment_id = ? AND step_position = ? AND outcome IN ('automated', 'manual')
      ORDER BY occurred_at DESC LIMIT 1`,
    [enrollmentId, connect.position],
  );
  if (!ran) return undefined;

  return new Date(Date.parse(ran.occurred_at) + connect.waitForAcceptanceHours * 3_600_000);
}
