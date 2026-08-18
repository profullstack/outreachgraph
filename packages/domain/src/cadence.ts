/**
 * Cadences: an ordered plan of touches over time (PRD §13).
 *
 * Everything here is pure. Whether a given step may run is not decided in this
 * module and cannot be — that is `packages/policy`'s job, evaluated against the
 * capability matrix at execution time. This file only describes what a plan
 * *is*, refuses ones that are malformed, and does the date arithmetic.
 *
 * Keeping the two apart is what lets one cadence be legal on Bluesky and
 * hand-driven on LinkedIn without being written twice.
 */

import {
  isActionKind,
  isNetwork,
  isOutboundAction,
  type ActionKind,
  type Network,
} from './networks';

export const CADENCE_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type CadenceStatus = (typeof CADENCE_STATUSES)[number];

export const ENROLLMENT_STATUSES = ['active', 'completed', 'stopped'] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

/** What actually happened when a step came due. */
export const STEP_OUTCOMES = ['automated', 'manual', 'skipped'] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];

export interface CadenceStep {
  /** 0-based and contiguous across a cadence. */
  readonly position: number;
  readonly network: Network;
  readonly action: ActionKind;
  /** Hours after the previous step, or after enrollment for position 0. */
  readonly delayHours: number;
  /** Whether a reply ends the enrollment when this step comes due. */
  readonly stopOnReply: boolean;
  /** What this touch is for. Guidance for the composer, never a template. */
  readonly intent?: string;
}

/**
 * The longest a single gap may be.
 *
 * A year is not a cadence, it is a leak: an enrollment nobody will remember
 * agreeing to, firing at a prospect whose consent context is long gone.
 */
export const MAX_STEP_DELAY_HOURS = 24 * 90;

/** How many touches one plan may contain. */
export const MAX_STEPS = 12;

export interface CadenceProblem {
  readonly step?: number;
  readonly message: string;
}

/**
 * Refuses a plan that cannot be run, with a sentence rather than a constraint
 * violation.
 *
 * The interesting rule is the last one. A cadence whose every step is an
 * internal action is a plan that never contacts anybody — it is almost always
 * a half-built draft, and letting it go active means a user watches an
 * enrollment "work" for a week and produce nothing.
 */
export function validateCadence(steps: readonly CadenceStep[]): readonly CadenceProblem[] {
  const problems: CadenceProblem[] = [];

  if (steps.length === 0) {
    return [{ message: 'A cadence needs at least one step.' }];
  }

  if (steps.length > MAX_STEPS) {
    problems.push({ message: `A cadence may have at most ${MAX_STEPS} steps.` });
  }

  const sorted = [...steps].sort((a, b) => a.position - b.position);

  sorted.forEach((step, index) => {
    if (step.position !== index) {
      problems.push({
        step: step.position,
        message: `Steps must be numbered from 0 with no gaps; found ${step.position} where ${index} was expected.`,
      });
    }

    if (!isNetwork(step.network)) {
      problems.push({ step: index, message: `"${step.network}" is not a network we know.` });
    }

    if (!isActionKind(step.action)) {
      problems.push({ step: index, message: `"${step.action}" is not an action we know.` });
    }

    if (!Number.isInteger(step.delayHours) || step.delayHours < 0) {
      problems.push({
        step: index,
        message: 'A delay must be a whole number of hours, not negative.',
      });
    } else if (step.delayHours > MAX_STEP_DELAY_HOURS) {
      problems.push({
        step: index,
        message: `A gap of more than ${MAX_STEP_DELAY_HOURS / 24} days is not a cadence.`,
      });
    }
  });

  // A plan that never contacts anybody.
  //
  // Every action is a real one and every delay is sane, so nothing above
  // fires, but the cadence only ever observes and refreshes research. It is
  // almost always a half-built draft, and the cost of allowing it is that
  // somebody watches an enrollment tick through a week of steps and produces
  // no outreach, with nothing anywhere saying why.
  if (
    sorted.length > 0 &&
    sorted.every((step) => isActionKind(step.action) && !isOutboundAction(step.action))
  ) {
    problems.push({
      message: 'This plan never contacts anybody — at least one step has to reach a person.',
    });
  }

  return problems;
}

/**
 * When step `position` falls due for someone enrolled at `enrolledAt`.
 *
 * Cumulative, because `delayHours` is relative to the previous step. Returns
 * `undefined` past the end of the plan, which is how the caller learns an
 * enrollment is finished without having to compare counts itself.
 */
export function dueAtFor(
  enrolledAt: Date,
  steps: readonly CadenceStep[],
  position: number,
): Date | undefined {
  if (position < 0 || position >= steps.length) return undefined;

  const sorted = [...steps].sort((a, b) => a.position - b.position);
  let hours = 0;

  for (let index = 0; index <= position; index += 1) {
    hours += sorted[index]?.delayHours ?? 0;
  }

  return new Date(enrolledAt.getTime() + hours * 3_600_000);
}

/**
 * Total wall-clock length of a plan, in hours. Shown when building one, so
 * "five touches" also reads as "over three weeks".
 */
export function cadenceDurationHours(steps: readonly CadenceStep[]): number {
  return steps.reduce((total, step) => total + Math.max(0, step.delayHours), 0);
}
