/**
 * The library is data, so the tests are about it staying runnable data: every
 * play has to produce a cadence the engine will actually accept.
 */

import { describe, expect, test } from 'bun:test';
import { PLAYBOOKS, playbookBySlug, playbookDurationHours } from './playbooks';
import { validateCadence, type CadenceStep } from './cadence';
import { isActionKind, isNetwork } from './networks';

function toCadence(steps: readonly { network: string; action: string; delayHours: number }[]) {
  return steps.map((step, index): CadenceStep => ({
    position: index,
    network: step.network as never,
    action: step.action as never,
    delayHours: step.delayHours,
    stopOnReply: true,
  }));
}

describe('PLAYBOOKS', () => {
  test('every play is a cadence the engine accepts', () => {
    // The whole value of a playbook is that it runs without editing. A play
    // that fails validation is a worked example of something impossible.
    for (const playbook of PLAYBOOKS) {
      expect(validateCadence(toCadence(playbook.steps))).toEqual([]);
    }
  });

  test('every step names a real network and action', () => {
    for (const playbook of PLAYBOOKS) {
      for (const step of playbook.steps) {
        expect(isNetwork(step.network)).toBe(true);
        expect(isActionKind(step.action)).toBe(true);
      }
    }
  });

  test('slugs are unique', () => {
    const slugs = PLAYBOOKS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('every play carries keywords and questions worth asking', () => {
    for (const playbook of PLAYBOOKS) {
      expect(playbook.keywords.length).toBeGreaterThan(0);
      expect(playbook.gridQuestions.length).toBeGreaterThan(0);
      expect(playbook.intake.length).toBeGreaterThan(40);
    }
  });

  test('the first step never waits', () => {
    // A play whose opening touch is scheduled for later reads, to whoever
    // enrolled someone, as a campaign that silently did nothing.
    for (const playbook of PLAYBOOKS) {
      expect(playbook.steps[0]?.delayHours).toBe(0);
    }
  });
});

describe('playbookBySlug', () => {
  test('finds a play', () => {
    expect(playbookBySlug('competitor-switchers')?.name).toBe('Competitor switchers');
  });

  test('returns nothing for an unknown slug', () => {
    expect(playbookBySlug('nope')).toBeUndefined();
  });
});

describe('playbookDurationHours', () => {
  test('sums the plan', () => {
    const playbook = playbookBySlug('competitor-switchers')!;
    expect(playbookDurationHours(playbook)).toBe(72);
  });
});
