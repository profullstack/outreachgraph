import { describe, expect, test } from 'bun:test';
import type { SignalType } from '@outreachgraph/domain';
import {
  ageInDays,
  decayFactor,
  DEFAULT_STEPS,
  effectiveWeight,
  isArchival,
  isExpired,
  profileFor,
  type DecayableSignal,
} from './decay';

const NOW = new Date('2026-08-11T12:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function signal(overrides: Partial<DecayableSignal> = {}): DecayableSignal {
  return {
    type: 'content_topic',
    observedAt: daysAgo(0),
    confidence: 1,
    relevance: 1,
    ...overrides,
  };
}

describe('the global curve (PRD §11.3)', () => {
  // content_topic is neither high-intent nor durable, so it uses the
  // unscaled global table.
  test.each([
    [0, 1.0],
    [7, 1.0],
    [8, 0.85],
    [14, 0.85],
    [15, 0.65],
    [30, 0.65],
    [31, 0.4],
    [60, 0.4],
    [61, 0.2],
    [90, 0.2],
  ])('at %i days the factor is %f', (days, expected) => {
    expect(decayFactor('content_topic', days)).toBeCloseTo(expected, 10);
  });

  test('falls to archival past the last step', () => {
    expect(decayFactor('content_topic', 91)).toBeLessThan(0.2);
    expect(decayFactor('content_topic', 365)).toBeLessThan(0.2);
  });

  test('treats a future timestamp as brand new rather than trusting it', () => {
    expect(decayFactor('content_topic', -30)).toBe(1);
  });

  test('the published steps are the PRD table', () => {
    expect(DEFAULT_STEPS.map((s) => s.factor)).toEqual([1.0, 0.85, 0.65, 0.4, 0.2]);
  });
});

describe('per-type profiles', () => {
  test('a vendor question goes stale within days', () => {
    // "Which payments vendor should I use today?" — PRD §11.3 says ~72h.
    const fresh = decayFactor('recommendation_request', 1);
    const week = decayFactor('recommendation_request', 7);

    expect(fresh).toBe(1);
    expect(week).toBeLessThan(0.7);
  });

  test('a job change stays useful for about 60 days', () => {
    // PRD §11.3 says a job change may remain useful for 60 days.
    expect(decayFactor('role_change', 60)).toBeGreaterThanOrEqual(0.65);
    expect(decayFactor('role_change', 30)).toBeGreaterThanOrEqual(0.85);
  });

  test('durable signals outlast high-intent ones at the same age', () => {
    expect(decayFactor('role_change', 21)).toBeGreaterThan(decayFactor('public_question', 21));
  });

  test.each([
    ['purchase_intent', 'fast'],
    ['recommendation_request', 'fast'],
    ['public_complaint', 'fast'],
    ['role_change', 'durable'],
    ['funding', 'durable'],
    ['technology_adoption', 'durable'],
    ['content_topic', 'standard'],
    ['community_activity', 'standard'],
  ] as [SignalType, string][])('classifies %s as %s', (type, expected) => {
    expect(profileFor(type)).toBe(expected as never);
  });

  test('an explicit profile overrides the type default', () => {
    const forced = decayFactor('recommendation_request', 30, { profile: 'durable' });
    const natural = decayFactor('recommendation_request', 30);

    expect(forced).toBeGreaterThan(natural);
  });
});

describe('effective weight', () => {
  test('is freshness times confidence times relevance', () => {
    const weight = effectiveWeight(
      signal({
        type: 'content_topic',
        sourceTimestamp: daysAgo(10),
        confidence: 0.8,
        relevance: 0.5,
      }),
      NOW,
    );

    // 0.85 (8–14 day bucket) × 0.8 × 0.5
    expect(weight).toBeCloseTo(0.34, 10);
  });

  test('prefers the source timestamp over when we happened to see it', () => {
    const old = effectiveWeight(
      signal({ sourceTimestamp: daysAgo(80), observedAt: daysAgo(0) }),
      NOW,
    );
    const fresh = effectiveWeight(signal({ sourceTimestamp: daysAgo(1) }), NOW);

    expect(old).toBeLessThan(fresh);
  });

  test('falls back to observedAt when the source has no date', () => {
    const weight = effectiveWeight(signal({ observedAt: daysAgo(1) }), NOW);
    expect(weight).toBe(1);
  });

  test('an expired signal contributes nothing', () => {
    const expired = signal({ sourceTimestamp: daysAgo(1), expiresAt: daysAgo(0.5) });

    expect(isExpired(expired, NOW)).toBe(true);
    expect(effectiveWeight(expired, NOW)).toBe(0);
  });

  test('an unparseable timestamp decays to archival rather than throwing', () => {
    const weight = effectiveWeight(signal({ sourceTimestamp: 'not a date' }), NOW);
    expect(weight).toBeGreaterThanOrEqual(0);
    expect(weight).toBeLessThan(0.1);
  });
});

describe('archival', () => {
  test('an ancient standard signal is archival', () => {
    expect(isArchival(signal({ sourceTimestamp: daysAgo(400) }), NOW)).toBe(true);
  });

  test('a recent signal is not', () => {
    expect(isArchival(signal({ sourceTimestamp: daysAgo(2) }), NOW)).toBe(false);
  });

  test('a durable signal survives past the global 90-day cliff', () => {
    const old = signal({ type: 'funding', sourceTimestamp: daysAgo(120) });
    expect(isArchival(old, NOW)).toBe(false);
  });
});

describe('ageInDays', () => {
  test('measures elapsed days', () => {
    expect(ageInDays(daysAgo(5), NOW)).toBeCloseTo(5, 6);
  });

  test('returns infinity for an unparseable value', () => {
    expect(ageInDays('nonsense', NOW)).toBe(Number.POSITIVE_INFINITY);
  });
});
