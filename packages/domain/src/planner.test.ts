import { describe, expect, test } from 'bun:test';
import { validateCadence } from './cadence';
import { PLANNER_YEAR, plannerMonth, plannerPeriod, touchesWithWinner } from './planner';

describe('PLANNER_YEAR', () => {
  test('twelve months, Q1 M1 to Q4 M3 in order', () => {
    expect(PLANNER_YEAR).toHaveLength(12);
    expect(PLANNER_YEAR.map((month) => `Q${month.quarter}M${month.month}`)).toEqual([
      'Q1M1',
      'Q1M2',
      'Q1M3',
      'Q2M1',
      'Q2M2',
      'Q2M3',
      'Q3M1',
      'Q3M2',
      'Q3M3',
      'Q4M1',
      'Q4M2',
      'Q4M3',
    ]);
  });

  test('every play is a valid cadence, with and without a winning angle', () => {
    for (const month of PLANNER_YEAR) {
      for (const play of month.plays) {
        for (const winner of [undefined, 'Ask who owns the budget for this.']) {
          const steps = touchesWithWinner(play.touches, winner).map((touch, position) => ({
            position,
            network: 'email' as const,
            action: 'send_email' as const,
            delayHours: touch.delayHours,
            stopOnReply: true,
            intent: touch.intent,
            ...(touch.variants.length > 0 ? { variants: touch.variants } : {}),
          }));
          expect(validateCadence(steps)).toEqual([]);
        }
      }
    }
  });

  test('play keys are unique, and every excluded play exists', () => {
    const keys = PLANNER_YEAR.flatMap((month) => month.plays.map((play) => play.key));
    expect(new Set(keys).size).toBe(keys.length);
    for (const month of PLANNER_YEAR) {
      for (const play of month.plays) {
        for (const excluded of play.segment.excludePlays ?? []) expect(keys).toContain(excluded);
      }
    }
  });

  test('February is Q1 M2, the case study to non-responders', () => {
    const at = new Date('2026-02-10T12:00:00Z');
    expect(plannerMonth(at).plays[0]?.key).toBe('case_study_non_responders');
    expect(plannerPeriod(at)).toBe('2026-02');
  });

  test('{{winner}} becomes a variant only when there is a winner', () => {
    const play = PLANNER_YEAR[6]!.plays[0]!;
    expect(touchesWithWinner(play.touches, undefined)[0]?.variants).toEqual([]);
    expect(touchesWithWinner(play.touches, 'Ask one question')[0]?.variants).toEqual([
      'Ask one question',
    ]);
  });
});
