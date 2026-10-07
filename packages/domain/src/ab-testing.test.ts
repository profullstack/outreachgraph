import { describe, expect, test } from 'bun:test';
import { decideAbTest, zScore } from './ab-testing';

describe('decideAbTest', () => {
  test('waits for 50 sends on every arm', () => {
    const decision = decideAbTest([
      { variant: 'A', sent: 120, replied: 2 },
      { variant: 'B', sent: 40, replied: 10 },
    ]);
    expect(decision.decided).toBe(false);
  });

  test('a clear leader at 50+ each wins on significance', () => {
    const decision = decideAbTest([
      { variant: 'A', sent: 60, replied: 1 },
      { variant: 'B', sent: 60, replied: 9 },
    ]);
    expect(decision).toMatchObject({ decided: true, winner: 'B', basis: 'significant' });
  });

  test('a small lead is not a result', () => {
    const decision = decideAbTest([
      { variant: 'A', sent: 80, replied: 3 },
      { variant: 'B', sent: 80, replied: 4 },
    ]);
    expect(decision.decided).toBe(false);
  });

  test('at 200+ each the best wins; no winner over A keeps A', () => {
    expect(
      decideAbTest([
        { variant: 'A', sent: 210, replied: 6 },
        { variant: 'B', sent: 205, replied: 8 },
      ]),
    ).toMatchObject({ decided: true, winner: 'B', basis: 'sample_cap' });
    expect(
      decideAbTest([
        { variant: 'A', sent: 210, replied: 0 },
        { variant: 'B', sent: 205, replied: 0 },
      ]),
    ).toMatchObject({ decided: true, winner: 'A' });
    // Two challengers tied at the top still beat the original.
    expect(
      decideAbTest([
        { variant: 'A', sent: 200, replied: 2 },
        { variant: 'B', sent: 200, replied: 6 },
        { variant: 'C', sent: 200, replied: 6 },
      ]),
    ).toMatchObject({ decided: true, winner: 'B' });
  });

  test('z is positive when the first arm leads', () => {
    expect(
      zScore({ variant: 'B', sent: 100, replied: 10 }, { variant: 'A', sent: 100, replied: 2 }),
    ).toBeGreaterThan(2);
  });
});
