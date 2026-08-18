import { describe, expect, test } from 'bun:test';
import {
  cadenceDurationHours,
  dueAtFor,
  MAX_STEPS,
  MAX_STEP_DELAY_HOURS,
  validateCadence,
  type CadenceStep,
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

const PLAN: readonly CadenceStep[] = [
  step({ position: 0, delayHours: 0 }),
  step({ position: 1, network: 'bluesky', action: 'reply', delayHours: 72 }),
  step({ position: 2, delayHours: 96 }),
];

describe('validateCadence', () => {
  test('accepts a well-formed plan', () => {
    expect(validateCadence(PLAN)).toEqual([]);
  });

  test('refuses an empty plan', () => {
    expect(validateCadence([])).toHaveLength(1);
  });

  test('refuses a gap in the numbering', () => {
    const problems = validateCadence([step({ position: 0 }), step({ position: 2 })]);

    expect(problems.some((p) => p.message.includes('no gaps'))).toBe(true);
  });

  test('refuses a plan that does not start at zero', () => {
    expect(validateCadence([step({ position: 1 })])).not.toEqual([]);
  });

  test('refuses an unknown network', () => {
    const problems = validateCadence([step({ network: 'myspace' as never })]);

    expect(problems.some((p) => p.message.includes('myspace'))).toBe(true);
  });

  test('refuses an unknown action', () => {
    const problems = validateCadence([step({ action: 'telepathy' as never })]);

    expect(problems.some((p) => p.message.includes('telepathy'))).toBe(true);
  });

  test('refuses a negative delay', () => {
    const problems = validateCadence([step({ delayHours: -1 })]);

    expect(problems.some((p) => p.message.includes('negative'))).toBe(true);
  });

  test('refuses a gap longer than the cap', () => {
    const problems = validateCadence([step({ delayHours: MAX_STEP_DELAY_HOURS + 1 })]);

    expect(problems.some((p) => p.message.includes('not a cadence'))).toBe(true);
  });

  test('refuses more steps than the cap', () => {
    const many = Array.from({ length: MAX_STEPS + 1 }, (_, i) => step({ position: i }));

    expect(validateCadence(many).some((p) => p.message.includes('at most'))).toBe(true);
  });

  test('refuses a plan that never contacts anybody', () => {
    // Every action is real and every delay is sane, so nothing else fires —
    // but the plan only ever observes, which is a half-built draft.
    const problems = validateCadence([
      step({ position: 0, action: 'observe' }),
      step({ position: 1, action: 'refresh_research', delayHours: 24 }),
    ]);

    expect(problems.some((p) => p.message.includes('never contacts anybody'))).toBe(true);
  });

  test('accepts a plan that observes first and then reaches out', () => {
    const problems = validateCadence([
      step({ position: 0, action: 'observe' }),
      step({ position: 1, action: 'send_email', delayHours: 24 }),
    ]);

    expect(problems).toEqual([]);
  });

  test('reports every problem rather than only the first', () => {
    const problems = validateCadence([
      step({ position: 0, delayHours: -5 }),
      step({ position: 1, network: 'nope' as never }),
    ]);

    expect(problems.length).toBeGreaterThanOrEqual(2);
  });
});

describe('dueAtFor', () => {
  const enrolled = new Date('2026-08-18T09:00:00.000Z');

  test('runs the first step at enrollment when its delay is zero', () => {
    expect(dueAtFor(enrolled, PLAN, 0)?.toISOString()).toBe('2026-08-18T09:00:00.000Z');
  });

  test('accumulates delays across steps', () => {
    // 72h after enrollment, not 72h after "now".
    expect(dueAtFor(enrolled, PLAN, 1)?.toISOString()).toBe('2026-08-21T09:00:00.000Z');
    // 72 + 96 = 168h.
    expect(dueAtFor(enrolled, PLAN, 2)?.toISOString()).toBe('2026-08-25T09:00:00.000Z');
  });

  test('returns nothing past the end of the plan', () => {
    expect(dueAtFor(enrolled, PLAN, 3)).toBeUndefined();
  });

  test('returns nothing for a negative position', () => {
    expect(dueAtFor(enrolled, PLAN, -1)).toBeUndefined();
  });

  test('honours position rather than array order', () => {
    const shuffled = [PLAN[2]!, PLAN[0]!, PLAN[1]!];

    expect(dueAtFor(enrolled, shuffled, 1)?.toISOString()).toBe('2026-08-21T09:00:00.000Z');
  });
});

describe('cadenceDurationHours', () => {
  test('sums the plan', () => {
    expect(cadenceDurationHours(PLAN)).toBe(168);
  });

  test('is zero for an empty plan', () => {
    expect(cadenceDurationHours([])).toBe(0);
  });
});
