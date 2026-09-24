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
  /**
   * Whether this step runs at all, decided when it falls due. Omitted means
   * `always`. A false condition skips the step, on the record, and the plan
   * moves on — two neighbouring steps with opposite conditions are a branch.
   */
  readonly condition?: StepCondition;
  /**
   * On a LinkedIn `connect` step: how long a later connection-dependent step
   * waits for the invitation to be accepted before deciding. Omitted means it
   * decides the moment it falls due.
   */
  readonly waitForAcceptanceHours?: number;
  /**
   * Alternate intents to A/B test against `intent`, which is variant A.
   *
   * Each enrollment is assigned one variant per step by `pickVariant`, so the
   * same person always gets the same angle however often the step is retried,
   * and the split across a cadence is even without anything being stored in
   * advance.
   */
  readonly variants?: readonly string[];
}

/**
 * What a step may be conditional on.
 *
 * Each is a fact the product already records, read at the moment the step
 * falls due: the LinkedIn connection state (from `linkedin_connections`), a
 * reply, or a click on a tracked link in an earlier email. Nothing here is a
 * guess about intent, and nothing is evaluated by a model — a condition is as
 * deterministic as the policy engine that runs after it.
 */
export const STEP_CONDITIONS = [
  'always',
  'if_connected',
  'if_not_connected',
  'if_no_reply',
  'if_clicked',
  'if_not_clicked',
] as const;
export type StepCondition = (typeof STEP_CONDITIONS)[number];

export function isStepCondition(value: unknown): value is StepCondition {
  return typeof value === 'string' && (STEP_CONDITIONS as readonly string[]).includes(value);
}

/** How a condition reads to a person, for skip reasons and the editor. */
export const STEP_CONDITION_LABELS: Readonly<Record<StepCondition, string>> = {
  always: 'always',
  if_connected: 'only if they are a LinkedIn connection',
  if_not_connected: 'only if they are not a LinkedIn connection',
  if_no_reply: 'only if they have not replied',
  if_clicked: 'only if they clicked a link',
  if_not_clicked: 'only if they have not clicked a link',
};

/** The facts a condition is evaluated against. */
export interface StepConditionFacts {
  readonly connected: boolean;
  readonly replied: boolean;
  readonly clicked: boolean;
}

/** Whether a condition depends on the LinkedIn connection state. */
export function isConnectionCondition(condition: StepCondition | undefined): boolean {
  return condition === 'if_connected' || condition === 'if_not_connected';
}

/**
 * Evaluates one condition. Pure and total: an omitted condition is `always`.
 */
export function stepConditionHolds(
  condition: StepCondition | undefined,
  facts: StepConditionFacts,
): boolean {
  switch (condition ?? 'always') {
    case 'always':
      return true;
    case 'if_connected':
      return facts.connected;
    case 'if_not_connected':
      return !facts.connected;
    case 'if_no_reply':
      return !facts.replied;
    case 'if_clicked':
      return facts.clicked;
    case 'if_not_clicked':
      return !facts.clicked;
  }
}

/** The longest a connect step may wait for acceptance: LinkedIn's own invites last longer, a plan should not. */
export const MAX_ACCEPTANCE_WAIT_HOURS = 24 * 30;

/**
 * The longest a single gap may be.
 *
 * A year is not a cadence, it is a leak: an enrollment nobody will remember
 * agreeing to, firing at a prospect whose consent context is long gone.
 */
export const MAX_STEP_DELAY_HOURS = 24 * 90;

/** How many touches one plan may contain. */
export const MAX_STEPS = 12;

/**
 * Alternates a step may carry on top of its own intent: A plus B, C and D.
 *
 * More arms than this and a cadence of realistic size never sends enough of
 * any one of them to tell the angles apart, so the report would show noise
 * dressed up as a winner.
 */
export const MAX_STEP_VARIANTS = 3;

/** The longest one intent may be. It is guidance for a sentence, not a brief. */
export const MAX_INTENT_LENGTH = 500;

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

    if (step.intent !== undefined && step.intent.length > MAX_INTENT_LENGTH) {
      problems.push({
        step: index,
        message: `An intent may be at most ${MAX_INTENT_LENGTH} characters.`,
      });
    }

    problems.push(...variantProblems(step, index));
  });

  // Conditions and acceptance windows. Checked here, where the plan is still
  // being written, because each mistake below produces a plan that runs
  // without error and does something other than what its author meant.
  sorted.forEach((step, index) => {
    if (step.condition !== undefined && !isStepCondition(step.condition)) {
      problems.push({
        step: index,
        message: `"${String(step.condition)}" is not a condition we know. Use one of: ${STEP_CONDITIONS.join(', ')}.`,
      });
    }

    const earlier = sorted.slice(0, index);

    // A click is only ever recorded on a tracked link in an email we sent, so
    // with no email before it this condition is decided before the plan runs.
    if (
      (step.condition === 'if_clicked' || step.condition === 'if_not_clicked') &&
      !earlier.some((s) => s.action === 'send_email')
    ) {
      problems.push({
        step: index,
        message:
          'A click can only follow an email we sent, and no step before this one sends an email.',
      });
    }

    // Messaging on LinkedIn reaches only a 1st-degree connection; an
    // unconditional LinkedIn message step fails for everyone who is not one.
    if (
      step.network === 'linkedin' &&
      step.action === 'send_dm' &&
      step.condition !== 'if_connected'
    ) {
      problems.push({
        step: index,
        message:
          'A LinkedIn message can only reach a connection, so this step needs the condition "if connected".',
      });
    }

    // Inviting someone who is already a connection is refused by LinkedIn.
    if (
      step.network === 'linkedin' &&
      step.action === 'connect' &&
      step.condition === 'if_connected'
    ) {
      problems.push({
        step: index,
        message: 'Inviting someone only if they are already a connection can never do anything.',
      });
    }

    if (step.waitForAcceptanceHours !== undefined) {
      if (step.network !== 'linkedin' || step.action !== 'connect') {
        problems.push({
          step: index,
          message: 'Only a LinkedIn connection request can wait for acceptance.',
        });
      } else if (
        !Number.isInteger(step.waitForAcceptanceHours) ||
        step.waitForAcceptanceHours < 1 ||
        step.waitForAcceptanceHours > MAX_ACCEPTANCE_WAIT_HOURS
      ) {
        problems.push({
          step: index,
          message: `Waiting for acceptance must be a whole number of hours between 1 and ${MAX_ACCEPTANCE_WAIT_HOURS} (${MAX_ACCEPTANCE_WAIT_HOURS / 24} days).`,
        });
      } else if (!sorted.slice(index + 1).some((s) => isConnectionCondition(s.condition))) {
        problems.push({
          step: index,
          message:
            'This step waits for acceptance, but no later step is "if connected" or "if not connected", so nothing would wait.',
        });
      }
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

// ------------------------------------------------------------------ variants

function variantProblems(step: CadenceStep, index: number): readonly CadenceProblem[] {
  const variants = step.variants;
  if (variants === undefined || variants.length === 0) return [];

  const problems: CadenceProblem[] = [];

  // Variant A is the step's own intent. Without one there is nothing for B to
  // be compared against — "no guidance" versus "some guidance" is a test of
  // whether guidance helps, which is not what anybody setting up an A/B means.
  if (!step.intent?.trim()) {
    problems.push({
      step: index,
      message: 'Give the step an intent before adding variants — the intent is variant A.',
    });
  }

  if (variants.length > MAX_STEP_VARIANTS) {
    problems.push({
      step: index,
      message: `A step may have at most ${MAX_STEP_VARIANTS} variants besides its intent.`,
    });
  }

  const seen = new Set([step.intent?.trim().toLowerCase() ?? '']);
  variants.forEach((variant, n) => {
    const label = variantLabel(n + 1);
    const text = typeof variant === 'string' ? variant.trim() : '';

    if (!text) {
      problems.push({ step: index, message: `Variant ${label} is empty.` });
    } else if (text.length > MAX_INTENT_LENGTH) {
      problems.push({
        step: index,
        message: `Variant ${label} may be at most ${MAX_INTENT_LENGTH} characters.`,
      });
    } else if (seen.has(text.toLowerCase())) {
      // Two arms with the same words would split the sample in half and then
      // report whatever difference chance produced as a finding.
      problems.push({ step: index, message: `Variant ${label} repeats an earlier one.` });
    }

    seen.add(text.toLowerCase());
  });

  return problems;
}

/** `0` is A, the step's own intent; `1` is B, and so on. */
export function variantLabel(index: number): string {
  return String.fromCharCode(65 + index);
}

/**
 * Which arm of a step one enrollment gets, as an index into `[intent, ...variants]`.
 *
 * A hash of the enrollment and the step rather than a random draw, so a step
 * that is retried after a failed tick lands on the same arm, and so the
 * assignment needs no column of its own to stay stable. Hashing the position
 * in as well keeps the arms of consecutive steps independent: without it the
 * people who got B on step one would be exactly the people who get B on step
 * two, and a difference at step two could be step one's doing.
 */
export function pickVariant(enrollmentId: string, position: number, arms: number): number {
  if (arms <= 1) return 0;

  // FNV-1a, 32-bit, then murmur3's finaliser. The finaliser is not optional:
  // FNV's low bit depends only on the parity of the input's characters, so
  // `% 2` on the raw hash put every enrollment on opposite arms at steps 0
  // and 1 — a perfectly anti-correlated split that looks even in aggregate.
  let hash = 0x811c9dc5;
  for (const char of `${enrollmentId}:${position}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;

  return (hash >>> 0) % arms;
}

export interface StepGuidance {
  /** `A`, `B`, … — or undefined when the step is not being tested. */
  readonly variant?: string;
  /** The intent this enrollment's message should serve, if the step has one. */
  readonly intent?: string;
}

/**
 * The intent one enrollment's touch at `step` should serve, and which arm it came from.
 *
 * A step with no variants reports no variant at all, rather than "A", so the
 * report only ever shows arms for steps that were actually being tested.
 */
export function guidanceFor(enrollmentId: string, step: CadenceStep): StepGuidance {
  const intent = step.intent?.trim();
  const variants = (step.variants ?? []).map((v) => v.trim()).filter(Boolean);

  if (!intent) return {};
  if (variants.length === 0) return { intent };

  const arms = [intent, ...variants];
  const index = pickVariant(enrollmentId, step.position, arms.length);

  return { variant: variantLabel(index), intent: arms[index] ?? intent };
}
