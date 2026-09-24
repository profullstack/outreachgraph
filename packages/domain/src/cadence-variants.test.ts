import { describe, expect, test } from 'bun:test';
import {
  guidanceFor,
  MAX_STEP_VARIANTS,
  pickVariant,
  validateCadence,
  variantLabel,
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

describe('variantLabel', () => {
  test('letters the arms from A', () => {
    expect([0, 1, 2, 3].map(variantLabel)).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('pickVariant', () => {
  test('is stable for the same enrollment and step', () => {
    const first = pickVariant('enr_abc', 2, 3);
    for (let i = 0; i < 10; i += 1) expect(pickVariant('enr_abc', 2, 3)).toBe(first);
  });

  test('always answers 0 when there is only one arm', () => {
    expect(pickVariant('enr_abc', 0, 1)).toBe(0);
    expect(pickVariant('enr_abc', 0, 0)).toBe(0);
  });

  test('splits a population roughly evenly', () => {
    const counts = [0, 0];
    for (let i = 0; i < 2000; i += 1) {
      const arm = pickVariant(`enr_${i.toString(36)}_${(i * 7919).toString(36)}`, 0, 2);
      counts[arm] = (counts[arm] ?? 0) + 1;
    }

    // A fair coin over 2,000 flips lands within 45–55% essentially always.
    expect(counts[0]! / 2000).toBeGreaterThan(0.45);
    expect(counts[0]! / 2000).toBeLessThan(0.55);
  });

  test('assigns consecutive steps independently', () => {
    // If the position were not hashed in, everybody on B at step 0 would be
    // on B at step 1 too.
    let same = 0;
    for (let i = 0; i < 1000; i += 1) {
      const id = `enr_${i}`;
      if (pickVariant(id, 0, 2) === pickVariant(id, 1, 2)) same += 1;
    }

    expect(same).toBeGreaterThan(400);
    expect(same).toBeLessThan(600);
  });
});

describe('guidanceFor', () => {
  test('reports no variant for an untested step', () => {
    expect(guidanceFor('enr_1', step({ intent: 'reference their talk' }))).toEqual({
      intent: 'reference their talk',
    });
  });

  test('reports nothing for a step with no intent', () => {
    expect(guidanceFor('enr_1', step())).toEqual({});
  });

  test('hands out every arm across enough enrollments', () => {
    const tested = step({ intent: 'reference their talk', variants: ['ask for an intro'] });
    const seen = new Map<string, string>();

    for (let i = 0; i < 100; i += 1) {
      const guidance = guidanceFor(`enr_${i}`, tested);
      seen.set(guidance.variant!, guidance.intent!);
    }

    expect(seen.get('A')).toBe('reference their talk');
    expect(seen.get('B')).toBe('ask for an intro');
  });
});

describe('validateCadence with variants', () => {
  test('accepts a tested step', () => {
    expect(
      validateCadence([step({ intent: 'reference their talk', variants: ['ask for an intro'] })]),
    ).toEqual([]);
  });

  test('refuses variants without an intent to compare them to', () => {
    const problems = validateCadence([step({ variants: ['ask for an intro'] })]);
    expect(problems.map((p) => p.message).join(' ')).toContain('the intent is variant A');
  });

  test('refuses too many arms', () => {
    const variants = Array.from({ length: MAX_STEP_VARIANTS + 1 }, (_, i) => `angle ${i}`);
    const problems = validateCadence([step({ intent: 'base', variants })]);
    expect(problems.some((p) => p.message.includes('at most'))).toBe(true);
  });

  test('refuses an empty or repeated arm', () => {
    const empty = validateCadence([step({ intent: 'base', variants: ['  '] })]);
    expect(empty[0]?.message).toBe('Variant B is empty.');

    const repeated = validateCadence([step({ intent: 'Base', variants: ['other', 'base'] })]);
    expect(repeated[0]?.message).toBe('Variant C repeats an earlier one.');
  });
});
