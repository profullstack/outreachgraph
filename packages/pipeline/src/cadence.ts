/**
 * Running a cadence (PRD §13, §16).
 *
 * The scheduler is deliberately boring: find the enrollments whose next step is
 * due, run one step each, move the pointer. Everything interesting is in what
 * "run a step" means, which is decided by the policy engine rather than by the
 * step.
 *
 * A step never sends anything itself. It produces a `recommendations` row and
 * stops, because that row is where approval, the draft, the policy re-check,
 * the rate limits, suppression and the funnel already meet. A cadence with its
 * own path to the wire would have to re-implement all six and would get one of
 * them wrong — most likely the daily cap, which is exactly the one whose
 * failure looks like a working product right up until a sending domain burns.
 */

import {
  dueAtFor,
  newId,
  validateCadence,
  type ActionKind,
  type CadenceProblem,
  type CadenceStatus,
  type CadenceStep,
  type Network,
  type StepOutcome,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { evaluatePolicy, type PolicyDecision, type PolicyRequest } from '@outreachgraph/policy';
import { emitEvent } from './events';

export interface CadenceRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly campaign_id: string | null;
  readonly name: string;
  readonly status: string;
}

/** How a due step was resolved, and why. */
export interface StepResolution {
  readonly outcome: StepOutcome;
  readonly decision: PolicyDecision;
  readonly gate?: string;
  readonly reason: string;
}

/**
 * The decision-to-mode mapping, in one place.
 *
 * `manual_only` is not a failure and is not reported as one. It is the
 * capability matrix working: LinkedIn messaging is prohibited to automate, so
 * the step becomes something a human does in LinkedIn's own interface, and the
 * funnel counts it the same either way. A cadence whose social steps all land
 * here is a plan working exactly as designed.
 */
export function modeForDecision(decision: PolicyDecision): StepOutcome {
  if (decision === 'allow' || decision === 'allow_with_approval') return 'automated';
  if (decision === 'manual_only') return 'manual';
  return 'skipped';
}

export interface DueEnrollment {
  readonly id: string;
  readonly cadence_id: string;
  readonly workspace_id: string;
  readonly campaign_id: string;
  readonly person_id: string;
  readonly current_step: number;
  readonly enrolled_at: string;
}

export interface AdvanceCadencesDeps {
  readonly db: Client;
  /**
   * Policy inputs for one (person, campaign). Supplied by the caller because
   * assembling them means counting actions, resolving addresses and reading
   * suppression — work the pipeline already does elsewhere and must not have a
   * second, drifting implementation of.
   */
  readonly policyFor: (
    enrollment: DueEnrollment,
    step: CadenceStep,
  ) => Promise<Omit<PolicyRequest, 'action' | 'network'>>;
  /** Writes the recommendation a runnable step produces. Returns its id. */
  readonly createRecommendation: (input: {
    readonly enrollment: DueEnrollment;
    readonly step: CadenceStep;
    readonly decision: PolicyDecision;
    readonly policyVersion: string;
  }) => Promise<string | undefined>;
  readonly now?: Date;
  /** Enrollments to advance in one tick. */
  readonly limit?: number;
}

export interface AdvanceResult {
  readonly considered: number;
  readonly automated: number;
  readonly manual: number;
  readonly skipped: number;
  readonly completed: number;
  readonly stopped: number;
}

const DEFAULT_LIMIT = 200;

/**
 * Advances every enrollment whose next step is due.
 *
 * One step per enrollment per tick, never a catch-up loop. An enrollment that
 * has been paused for a fortnight has several steps notionally overdue, and
 * firing them all at once would put four messages in front of one person in a
 * second — which is both the worst possible outreach and precisely the pattern
 * the rate limits exist to prevent. Running one and rescheduling means a
 * backlog drains at the plan's own pace.
 */
export async function advanceCadences(
  deps: AdvanceCadencesDeps,
  workspaceId: string,
): Promise<AdvanceResult> {
  const { db } = deps;
  const at = deps.now ?? new Date();
  const stamp = at.toISOString();

  const due = await queryAll<DueEnrollment>(
    db,
    `SELECT e.id, e.cadence_id, e.workspace_id, e.campaign_id, e.person_id,
            e.current_step, e.enrolled_at
       FROM cadence_enrollments e
       JOIN cadences c ON c.id = e.cadence_id
      WHERE e.workspace_id = ?
        AND e.status = 'active'
        AND c.status = 'active'
        AND e.next_due_at IS NOT NULL
        AND e.next_due_at <= ?
   ORDER BY e.next_due_at
      LIMIT ?`,
    [workspaceId, stamp, deps.limit ?? DEFAULT_LIMIT],
  );

  let automated = 0;
  let manual = 0;
  let skipped = 0;
  let completed = 0;
  let stopped = 0;

  for (const enrollment of due) {
    const steps = await loadSteps(db, enrollment.cadence_id);
    const step = steps.find((s) => s.position === enrollment.current_step);

    // The pointer is past the end: the plan is finished.
    if (!step) {
      await finish(db, enrollment.id, 'completed', undefined, stamp);
      completed += 1;
      continue;
    }

    // A reply ends the plan before the policy engine is even asked. The
    // `conversation_open` gate would refuse the step anyway, but that would
    // leave the enrollment alive and generating a refused card every time the
    // next step fell due, for as long as the cadence ran.
    if (step.stopOnReply && (await hasReplied(db, enrollment))) {
      await finish(db, enrollment.id, 'stopped', 'they replied', stamp);
      await record(
        db,
        enrollment,
        step,
        {
          outcome: 'skipped',
          decision: 'deny',
          gate: 'conversation_open',
          reason: 'They replied, so the rest of the plan is a human decision.',
        },
        undefined,
        stamp,
      );
      stopped += 1;
      continue;
    }

    // The step is passed because several policy inputs are network-specific —
    // `hasConnectedAccount` most obviously. Resolving them workspace-wide would
    // let an email credential authorise a Bluesky step.
    const base = await deps.policyFor(enrollment, step);
    const verdict = evaluatePolicy({ ...base, network: step.network, action: step.action });
    const outcome = modeForDecision(verdict.decision);

    let recommendationId: string | undefined;
    if (outcome !== 'skipped') {
      recommendationId = await deps.createRecommendation({
        enrollment,
        step,
        decision: verdict.decision,
        policyVersion: verdict.policyVersion,
      });

      // A step that should have produced a card and did not is a skip, not a
      // success. Reporting it as automated would show a campaign advancing
      // through a plan that put nothing in front of anybody.
      if (!recommendationId) {
        await record(
          db,
          enrollment,
          step,
          {
            outcome: 'skipped',
            decision: verdict.decision,
            reason: 'Nothing could be drafted for this step.',
          },
          undefined,
          stamp,
        );
        skipped += 1;
        await moveOn(db, enrollment, steps, stamp);
        continue;
      }
    }

    await record(
      db,
      enrollment,
      step,
      {
        outcome,
        decision: verdict.decision,
        ...(verdict.gate ? { gate: verdict.gate } : {}),
        reason: verdict.reason,
      },
      recommendationId,
      stamp,
    );

    if (outcome === 'automated') automated += 1;
    else if (outcome === 'manual') manual += 1;
    else skipped += 1;

    const finished = await moveOn(db, enrollment, steps, stamp);
    if (finished) completed += 1;

    await emitEvent(db, {
      workspaceId: enrollment.workspace_id,
      campaignId: enrollment.campaign_id,
      personId: enrollment.person_id,
      phase: 'social',
      level: outcome === 'skipped' ? 'warn' : 'info',
      message: describe(step, outcome, verdict.reason),
      detail: {
        cadenceId: enrollment.cadence_id,
        step: step.position,
        network: step.network,
        action: step.action,
        outcome,
      },
    });
  }

  return { considered: due.length, automated, manual, skipped, completed, stopped };
}

function describe(step: CadenceStep, outcome: StepOutcome, reason: string): string {
  const what = `step ${step.position + 1} (${step.action} on ${step.network})`;
  if (outcome === 'automated') return `Queued ${what}.`;
  if (outcome === 'manual') return `${what} is yours to send — ${reason}`;
  return `Skipped ${what} — ${reason}`;
}

async function loadSteps(db: Client, cadenceId: string): Promise<readonly CadenceStep[]> {
  const rows = await queryAll<{
    position: number;
    network: string;
    action: string;
    delay_hours: number;
    stop_on_reply: number;
    intent: string | null;
  }>(
    db,
    `SELECT position, network, action, delay_hours, stop_on_reply, intent
       FROM cadence_steps WHERE cadence_id = ? ORDER BY position`,
    [cadenceId],
  );

  return rows.map((row) => ({
    position: row.position,
    network: row.network as Network,
    action: row.action as ActionKind,
    delayHours: row.delay_hours,
    stopOnReply: row.stop_on_reply === 1,
    ...(row.intent ? { intent: row.intent } : {}),
  }));
}

async function hasReplied(db: Client, enrollment: DueEnrollment): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM interactions
      WHERE workspace_id = ? AND person_id = ? AND direction = 'inbound' AND state = 'replied'`,
    [enrollment.workspace_id, enrollment.person_id],
  );
  return Number(row?.n ?? 0) > 0;
}

/**
 * Moves the pointer to the next step and schedules it.
 *
 * The next due time is computed from the *enrollment* date rather than from
 * now, so a tick that runs late does not push the whole remaining plan late
 * with it. Returns true when the plan is finished.
 */
async function moveOn(
  db: Client,
  enrollment: DueEnrollment,
  steps: readonly CadenceStep[],
  stamp: string,
): Promise<boolean> {
  const next = enrollment.current_step + 1;
  const dueAt = dueAtFor(new Date(enrollment.enrolled_at), steps, next);

  if (!dueAt) {
    await finish(db, enrollment.id, 'completed', undefined, stamp);
    return true;
  }

  await db.execute({
    sql: `UPDATE cadence_enrollments
             SET current_step = ?, next_due_at = ?, updated_at = ?
           WHERE id = ?`,
    args: [next, dueAt.toISOString(), stamp, enrollment.id],
  });

  return false;
}

async function finish(
  db: Client,
  enrollmentId: string,
  status: 'completed' | 'stopped',
  reason: string | undefined,
  stamp: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE cadence_enrollments
             SET status = ?, next_due_at = NULL, stopped_reason = ?, updated_at = ?
           WHERE id = ?`,
    args: [status, reason ?? null, stamp, enrollmentId],
  });
}

async function record(
  db: Client,
  enrollment: DueEnrollment,
  step: CadenceStep,
  resolution: StepResolution,
  recommendationId: string | undefined,
  stamp: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO cadence_step_runs (id, enrollment_id, workspace_id, step_position,
          network, action, outcome, policy_decision, policy_gate, recommendation_id,
          detail, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId('cadenceRun'),
      enrollment.id,
      enrollment.workspace_id,
      step.position,
      step.network,
      step.action,
      resolution.outcome,
      resolution.decision,
      resolution.gate ?? null,
      recommendationId ?? null,
      resolution.reason.slice(0, 500),
      stamp,
    ],
  });
}

// -------------------------------------------------------------- authoring

export interface CreateCadenceInput {
  readonly workspaceId: string;
  readonly campaignId?: string | undefined;
  readonly name: string;
  readonly steps: readonly CadenceStep[];
  readonly status?: 'draft' | 'active';
}

export type CreateCadenceResult =
  | { readonly created: true; readonly cadenceId: string }
  | { readonly created: false; readonly problems: readonly CadenceProblem[] };

/**
 * Writes a plan, or explains why it is not one.
 *
 * Validation happens before the first insert rather than per-row, so a bad
 * step cannot leave half a cadence behind for somebody to enroll into.
 */
export async function createCadence(
  db: Client,
  input: CreateCadenceInput,
): Promise<CreateCadenceResult> {
  const problems = validateCadence(input.steps);
  if (problems.length > 0) return { created: false, problems };

  const name = input.name.trim();
  if (!name) return { created: false, problems: [{ message: 'A cadence needs a name.' }] };

  const id = newId('cadence');
  const stamp = now();

  await db.execute({
    sql: `INSERT INTO cadences (id, workspace_id, campaign_id, name, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.workspaceId,
      input.campaignId ?? null,
      name,
      input.status ?? 'draft',
      stamp,
      stamp,
    ],
  });

  for (const step of [...input.steps].sort((a, b) => a.position - b.position)) {
    await db.execute({
      sql: `INSERT INTO cadence_steps (id, cadence_id, position, network, action,
            delay_hours, stop_on_reply, intent)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId('cadenceStep'),
        id,
        step.position,
        step.network,
        step.action,
        step.delayHours,
        step.stopOnReply ? 1 : 0,
        step.intent ?? null,
      ],
    });
  }

  return { created: true, cadenceId: id };
}

/** Flips a cadence between draft, active, paused and archived. */
export async function setCadenceStatus(
  db: Client,
  workspaceId: string,
  cadenceId: string,
  status: CadenceStatus,
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE cadences SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    args: [status, now(), cadenceId, workspaceId],
  });

  return (result.rowsAffected ?? 0) > 0;
}

// ------------------------------------------------------------- enrolling

export interface EnrollInput {
  readonly cadenceId: string;
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly personId: string;
  readonly at?: Date;
}

export type EnrollResult =
  | { readonly enrolled: true; readonly enrollmentId: string; readonly firstDueAt: string }
  | { readonly enrolled: false; readonly reason: string };

/**
 * Puts one prospect on a cadence.
 *
 * Refuses rather than throws for the answers a caller needs to read back: an
 * empty plan, somebody already enrolled, a cadence in another workspace. The
 * unique constraint is the real guard against double enrollment; this check
 * exists so the common case returns a sentence instead of a stack trace.
 */
export async function enrollInCadence(db: Client, input: EnrollInput): Promise<EnrollResult> {
  const cadence = await queryOne<{ id: string; status: string }>(
    db,
    'SELECT id, status FROM cadences WHERE id = ? AND workspace_id = ?',
    [input.cadenceId, input.workspaceId],
  );

  if (!cadence) return { enrolled: false, reason: 'no such cadence' };
  if (cadence.status === 'archived') return { enrolled: false, reason: 'that cadence is archived' };

  const steps = await loadSteps(db, input.cadenceId);
  if (steps.length === 0) return { enrolled: false, reason: 'that cadence has no steps' };

  const existing = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM cadence_enrollments WHERE cadence_id = ? AND person_id = ?',
    [input.cadenceId, input.personId],
  );
  if (existing) return { enrolled: false, reason: 'they are already on this cadence' };

  const at = input.at ?? new Date();
  const firstDue = dueAtFor(at, steps, 0) ?? at;
  const id = newId('enrollment');

  await db.execute({
    sql: `INSERT INTO cadence_enrollments (id, cadence_id, workspace_id, campaign_id, person_id,
          status, current_step, next_due_at, enrolled_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
    args: [
      id,
      input.cadenceId,
      input.workspaceId,
      input.campaignId,
      input.personId,
      firstDue.toISOString(),
      at.toISOString(),
      now(),
    ],
  });

  return { enrolled: true, enrollmentId: id, firstDueAt: firstDue.toISOString() };
}

/** Takes somebody off a cadence, e.g. because a human decided to. */
export async function stopEnrollment(
  db: Client,
  workspaceId: string,
  enrollmentId: string,
  reason: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE cadence_enrollments
             SET status = 'stopped', next_due_at = NULL, stopped_reason = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND status = 'active'`,
    args: [reason, now(), enrollmentId, workspaceId],
  });

  return (result.rowsAffected ?? 0) > 0;
}
