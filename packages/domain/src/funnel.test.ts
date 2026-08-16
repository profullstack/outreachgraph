import { describe, expect, test } from 'bun:test';
import { PROSPECT_STATUS } from './pipeline';
import {
  conversionRate,
  isAdvance,
  stageForStatus,
  summariseFunnel,
  FUNNEL_STAGES,
} from './funnel';

describe('stageForStatus', () => {
  test('every prospect status maps somewhere', () => {
    // A status with no stage would vanish from the funnel silently, which is
    // the failure mode most likely to go unnoticed.
    for (const status of PROSPECT_STATUS) {
      expect(stageForStatus(status)).toBeDefined();
    }
  });

  test('the engineering states collapse into the stages people recognise', () => {
    expect(stageForStatus('enriching')).toBe('discovered');
    expect(stageForStatus('resolved')).toBe('discovered');
    expect(stageForStatus('awaiting_approval')).toBe('ready');
    expect(stageForStatus('approved')).toBe('ready');
    expect(stageForStatus('executed')).toBe('contacted');
    expect(stageForStatus('waiting')).toBe('contacted');
    expect(stageForStatus('responded')).toBe('replied');
  });

  test('only genuine exits count as lost', () => {
    expect(stageForStatus('not_interested')).toBe('lost');
    expect(stageForStatus('suppressed')).toBe('lost');
    // Unqualified means "researched and not a fit" — it stops, it is not lost.
    expect(stageForStatus('unqualified')).toBe('researched');
    // An errored lead is stuck, not gone.
    expect(stageForStatus('error')).toBe('discovered');
  });
});

describe('summariseFunnel', () => {
  test('a funnel never widens as it descends', () => {
    // Only deep stages reported. Everything above must still be at least as
    // large, or the chart shows a funnel that fans out.
    const summary = summariseFunnel({ contacted: 3 }, { contacted: 5 });

    const reached = summary.stages.map((stage) => stage.reached);
    for (let index = 1; index < reached.length; index += 1) {
      expect(reached[index - 1] as number).toBeGreaterThanOrEqual(reached[index] as number);
    }
    expect(summary.total).toBe(5);
  });

  test('current occupancy and historical reach are separate numbers', () => {
    const summary = summariseFunnel(
      { discovered: 2, contacted: 4 },
      { discovered: 10, researched: 8, ready: 6, contacted: 4 },
    );

    const discovered = summary.stages[0];
    expect(discovered?.current).toBe(2);
    // Closing deals must not shrink the top of the funnel.
    expect(discovered?.reached).toBe(10);
  });

  test('an empty funnel is all zeroes rather than a crash', () => {
    const summary = summariseFunnel({});
    expect(summary.total).toBe(0);
    expect(summary.stages).toHaveLength(FUNNEL_STAGES.length);
  });

  test('lost is counted outside the stages', () => {
    const summary = summariseFunnel({ discovered: 5, lost: 2 });
    expect(summary.lost).toBe(2);
    expect(summary.stages.some((stage) => (stage.stage as string) === 'lost')).toBe(false);
  });
});

describe('conversionRate', () => {
  test('is a percentage of the stage above', () => {
    const from = { stage: 'discovered' as const, label: 'Found', current: 0, reached: 100 };
    const to = { stage: 'researched' as const, label: 'Researched', current: 0, reached: 40 };
    expect(conversionRate(from, to)).toBe(40);
  });

  test('an empty upper stage has no rate, rather than a rate of zero', () => {
    const from = { stage: 'discovered' as const, label: 'Found', current: 0, reached: 0 };
    const to = { stage: 'researched' as const, label: 'Researched', current: 0, reached: 0 };
    expect(conversionRate(from, to)).toBeUndefined();
  });
});

describe('isAdvance', () => {
  test('forward movement is an advance; sideways and lost are not', () => {
    expect(isAdvance('discovered', 'contacted')).toBe(true);
    expect(isAdvance(undefined, 'discovered')).toBe(true);
    expect(isAdvance('contacted', 'discovered')).toBe(false);
    expect(isAdvance('researched', 'researched')).toBe(false);
    expect(isAdvance('discovered', 'lost')).toBe(false);
  });
});
