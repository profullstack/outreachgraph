/**
 * Branching plans: step conditions and the acceptance window.
 *
 * Kept apart from `cadence.test.ts` because the two grow for different
 * reasons — that file is about the shape of a plan, this one about which of
 * its steps run.
 */

import { describe, expect, test } from 'bun:test';
import {
  MAX_ACCEPTANCE_WAIT_HOURS,
  STEP_CONDITIONS,
  stepConditionHolds,
  validateCadence,
  type CadenceStep,
  type StepConditionFacts,
} from './cadence';

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

/** The we-connect shaped plan this feature exists for. */
const LINKEDIN_THEN_EMAIL: readonly CadenceStep[] = [
  step({ position: 0, network: 'linkedin', action: 'view_profile' }),
  step({
    position: 1,
    network: 'linkedin',
    action: 'connect',
    delayHours: 24,
    waitForAcceptanceHours: 168,
    intent: 'mention their talk',
  }),
  step({
    position: 2,
    network: 'linkedin',
    action: 'send_dm',
    delayHours: 24,
    condition: 'if_connected',
  }),
  step({ position: 3, delayHours: 0, condition: 'if_not_connected' }),
];

const NOBODY: StepConditionFacts = { connected: false, replied: false, clicked: false };

describe('stepConditionHolds', () => {
  test('an omitted condition always holds', () => {
    expect(stepConditionHolds(undefined, NOBODY)).toBe(true);
    expect(stepConditionHolds('always', NOBODY)).toBe(true);
  });

  test.each([
    ['if_connected', { connected: true }, true],
    ['if_connected', {}, false],
    ['if_not_connected', { connected: true }, false],
    ['if_not_connected', {}, true],
    ['if_no_reply', { replied: true }, false],
    ['if_no_reply', {}, true],
    ['if_clicked', { clicked: true }, true],
    ['if_clicked', {}, false],
    ['if_not_clicked', { clicked: true }, false],
    ['if_not_clicked', {}, true],
  ] as const)('%s with %o is %s', (condition, facts, expected) => {
    expect(stepConditionHolds(condition, { ...NOBODY, ...facts })).toBe(expected);
  });

  test('every condition is handled', () => {
    for (const condition of STEP_CONDITIONS) {
      expect(typeof stepConditionHolds(condition, NOBODY)).toBe('boolean');
    }
  });
});

describe('validateCadence with conditions', () => {
  test('accepts visit, invite, then DM if accepted or email if not', () => {
    expect(validateCadence(LINKEDIN_THEN_EMAIL)).toEqual([]);
  });

  test('refuses a condition it does not know, naming the ones it does', () => {
    const problems = validateCadence([step({ condition: 'if_lucky' as never })]);
    expect(problems[0]?.message).toContain('"if_lucky" is not a condition we know');
    expect(problems[0]?.message).toContain('if_connected');
  });

  test('refuses a click condition with no email before it', () => {
    const problems = validateCadence([
      step({ network: 'bluesky', action: 'reply' }),
      step({ position: 1, condition: 'if_clicked' }),
    ]);
    expect(problems).toEqual([
      {
        step: 1,
        message:
          'A click can only follow an email we sent, and no step before this one sends an email.',
      },
    ]);

    expect(validateCadence([step(), step({ position: 1, condition: 'if_not_clicked' })])).toEqual(
      [],
    );
  });

  test('refuses a LinkedIn message that is not conditional on a connection', () => {
    const problems = validateCadence([step({ network: 'linkedin', action: 'send_dm' })]);
    expect(problems.map((p) => p.message)).toContain(
      'A LinkedIn message can only reach a connection, so this step needs the condition "if connected".',
    );
  });

  test('refuses an invitation only to people already connected', () => {
    const problems = validateCadence([
      step({ network: 'linkedin', action: 'connect', condition: 'if_connected' }),
    ]);
    expect(problems.map((p) => p.message)).toContain(
      'Inviting someone only if they are already a connection can never do anything.',
    );
  });

  test('only a LinkedIn invitation may wait for acceptance', () => {
    const problems = validateCadence([
      step({ waitForAcceptanceHours: 24 }),
      step({ position: 1, condition: 'if_not_connected' }),
    ]);
    expect(problems.map((p) => p.message)).toContain(
      'Only a LinkedIn connection request can wait for acceptance.',
    );
  });

  test('bounds the acceptance window', () => {
    const plan = (hours: number) => [
      step({ network: 'linkedin', action: 'connect', waitForAcceptanceHours: hours }),
      step({ position: 1, condition: 'if_not_connected' }),
    ];
    expect(validateCadence(plan(0))[0]?.message).toContain('between 1 and');
    expect(validateCadence(plan(MAX_ACCEPTANCE_WAIT_HOURS + 1))[0]?.message).toContain(
      'between 1 and',
    );
    expect(validateCadence(plan(1.5))[0]?.message).toContain('whole number');
    expect(validateCadence(plan(MAX_ACCEPTANCE_WAIT_HOURS))).toEqual([]);
  });

  test('a window with nothing waiting on it is refused', () => {
    const problems = validateCadence([
      step({ network: 'linkedin', action: 'connect', waitForAcceptanceHours: 168 }),
      step({ position: 1 }),
    ]);
    expect(problems[0]?.message).toContain('nothing would wait');
  });
});
