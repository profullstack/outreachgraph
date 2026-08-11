import { describe, expect, test } from 'bun:test';
import { EMPTY_FILTERS, type CampaignFilters } from '@outreachgraph/domain';
import type { DecayableSignal } from '@outreachgraph/signals';
import {
  scoreIcpFit,
  scoreIntent,
  scoreOpportunity,
  scoreReachability,
  scoreRelationship,
} from './scores';
import { DEFAULT_WEIGHTS, normalizeWeights } from './weights';

const NOW = new Date('2026-08-11T12:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function filters(overrides: Partial<CampaignFilters> = {}): CampaignFilters {
  return { ...EMPTY_FILTERS, ...overrides };
}

describe('ICP fit (PRD §12.1)', () => {
  test('a full match scores 100', () => {
    const result = scoreIcpFit(
      { title: 'VP Engineering', industry: 'SaaS', country: 'United States', employeeCount: 120 },
      filters({
        titles: ['VP Engineering'],
        industries: ['SaaS'],
        countries: ['United States'],
        employeeCountMin: 20,
        employeeCountMax: 500,
      }),
    );

    expect(result.score).toBe(100);
    expect(result.excluded).toBe(false);
    expect(result.missed).toHaveLength(0);
  });

  test('a partial match scores proportionally', () => {
    const result = scoreIcpFit(
      { title: 'VP Engineering', industry: 'Healthcare' },
      filters({ titles: ['VP Engineering'], industries: ['SaaS'] }),
    );

    expect(result.score).toBe(50);
    expect(result.matched).toEqual(['title']);
    expect(result.missed).toEqual(['industry']);
  });

  test('an exclusion disqualifies outright', () => {
    const result = scoreIcpFit(
      { title: 'Recruiter', industry: 'Staffing' },
      filters({ titles: ['Recruiter'], exclusions: ['staffing'] }),
    );

    expect(result.excluded).toBe(true);
    expect(result.score).toBe(0);
  });

  test('ignores criteria the campaign did not specify', () => {
    // Says nothing about funding, so the prospect is not penalised for it.
    const result = scoreIcpFit({ title: 'CTO' }, filters({ titles: ['CTO'] }));
    expect(result.score).toBe(100);
  });

  test('a company outside the size band misses', () => {
    const result = scoreIcpFit(
      { employeeCount: 5000 },
      filters({ employeeCountMin: 20, employeeCountMax: 500 }),
    );

    expect(result.missed).toContain('company size');
    expect(result.score).toBe(0);
  });

  test('with no criteria at all everyone is a neutral fit', () => {
    expect(scoreIcpFit({ title: 'Anyone' }, filters()).score).toBe(50);
  });

  test('matches technology case-insensitively', () => {
    const result = scoreIcpFit(
      { technologies: ['Next.js', 'Postgres'] },
      filters({ technologies: ['next.js'] }),
    );
    expect(result.score).toBe(100);
  });
});

describe('intent (PRD §12.3)', () => {
  function signal(overrides: Partial<DecayableSignal> = {}): DecayableSignal {
    return {
      type: 'content_topic',
      observedAt: daysAgo(0),
      sourceTimestamp: daysAgo(0),
      confidence: 1,
      relevance: 1,
      ...overrides,
    };
  }

  test('no signals means no intent', () => {
    const result = scoreIntent({ signals: [], now: NOW });

    expect(result.score).toBe(0);
    expect(result.topSignal).toBeUndefined();
    expect(result.contributingCount).toBe(0);
  });

  test('one explicit fresh request produces high intent', () => {
    const result = scoreIntent({
      signals: [signal({ type: 'recommendation_request', sourceTimestamp: daysAgo(0.2) })],
      now: NOW,
    });

    expect(result.score).toBe(100);
    expect(result.topSignal?.type).toBe('recommendation_request');
  });

  test('one fresh explicit request beats a pile of stale chatter', () => {
    const explicit = scoreIntent({
      signals: [signal({ type: 'recommendation_request', sourceTimestamp: daysAgo(0.2) })],
      now: NOW,
    });

    const chatter = scoreIntent({
      signals: Array.from({ length: 8 }, () =>
        signal({ type: 'content_topic', sourceTimestamp: daysAgo(75), relevance: 0.3 }),
      ),
      now: NOW,
    });

    expect(explicit.score).toBeGreaterThan(chatter.score);
  });

  test('corroborating signals accumulate with diminishing returns', () => {
    const one = scoreIntent({ signals: [signal({ relevance: 0.5 })], now: NOW }).score;
    const two = scoreIntent({
      signals: [signal({ relevance: 0.5 }), signal({ type: 'pain', relevance: 0.5 })],
      now: NOW,
    }).score;

    expect(two).toBeGreaterThan(one);
    expect(two).toBeLessThanOrEqual(100);
  });

  test('decayed signals contribute less than fresh ones', () => {
    const fresh = scoreIntent({
      signals: [signal({ sourceTimestamp: daysAgo(1) })],
      now: NOW,
    }).score;
    const stale = scoreIntent({
      signals: [signal({ sourceTimestamp: daysAgo(70) })],
      now: NOW,
    }).score;

    expect(stale).toBeLessThan(fresh);
  });

  test('a campaign can weight a signal type down to nothing', () => {
    const result = scoreIntent({
      signals: [signal({ type: 'hiring' })],
      signalWeights: { hiring: 0 },
      now: NOW,
    });

    expect(result.score).toBe(0);
    expect(result.contributingCount).toBe(0);
  });

  test('reports the strongest signal as the reason', () => {
    const result = scoreIntent({
      signals: [
        signal({ type: 'content_topic', relevance: 0.2 }),
        signal({ type: 'purchase_intent', relevance: 1 }),
      ],
      now: NOW,
    });

    expect(result.topSignal?.type).toBe('purchase_intent');
  });

  test('expired signals are excluded entirely', () => {
    const result = scoreIntent({
      signals: [signal({ expiresAt: daysAgo(1) })],
      now: NOW,
    });

    expect(result.score).toBe(0);
  });
});

describe('reachability (PRD §12.4)', () => {
  test('an active, connected, previously responsive prospect scores high', () => {
    const score = scoreReachability({
      daysSinceLastActivity: 1,
      reachableNetworkCount: 3,
      hasConnectedAccount: true,
      publicRepliesEnabled: true,
      hasRespondedBefore: true,
    });

    expect(score).toBe(100);
  });

  test('a dormant account with nowhere to reach them scores zero', () => {
    const score = scoreReachability({
      daysSinceLastActivity: 900,
      reachableNetworkCount: 0,
      hasConnectedAccount: false,
    });

    expect(score).toBe(0);
  });

  test('recent activity outranks stale activity', () => {
    const base = { reachableNetworkCount: 1, hasConnectedAccount: false };
    const recent = scoreReachability({ ...base, daysSinceLastActivity: 2 });
    const stale = scoreReachability({ ...base, daysSinceLastActivity: 100 });

    expect(recent).toBeGreaterThan(stale);
  });

  test('extra networks stop helping past the cap', () => {
    const base = { daysSinceLastActivity: 1, hasConnectedAccount: false };
    const two = scoreReachability({ ...base, reachableNetworkCount: 2 });
    const twenty = scoreReachability({ ...base, reachableNetworkCount: 20 });

    expect(twenty).toBe(two);
  });
});

describe('relationship (PRD §12.5)', () => {
  test('an opted-in prior responder scores highest', () => {
    const score = scoreRelationship({
      optedIn: true,
      previouslyReplied: true,
      existingCustomerContact: true,
      mutualPublicInteraction: true,
      followsYou: true,
    });

    expect(score).toBe(100);
  });

  test('a stranger scores zero', () => {
    expect(scoreRelationship({})).toBe(0);
  });

  test('an opt-in outweighs a bare follow', () => {
    expect(scoreRelationship({ optedIn: true })).toBeGreaterThan(
      scoreRelationship({ followsYourCompany: true }),
    );
  });
});

describe('opportunity (PRD §12.6)', () => {
  test('applies the published default weights', () => {
    const result = scoreOpportunity({
      icpFit: 100,
      intent: 100,
      reachability: 100,
      relationship: 100,
      identity: 100,
    });

    expect(result.opportunity).toBe(100);
    expect(result.weights).toEqual(DEFAULT_WEIGHTS);
  });

  test('weights each component as specified', () => {
    // Only ICP fit is present, weighted at 35%.
    const result = scoreOpportunity({
      icpFit: 100,
      intent: 0,
      reachability: 0,
      relationship: 0,
      identity: 0,
    });

    expect(result.opportunity).toBe(35);
  });

  test('ICP fit and intent dominate the ranking', () => {
    const fitAndIntent = scoreOpportunity({
      icpFit: 100,
      intent: 100,
      reachability: 0,
      relationship: 0,
      identity: 0,
    }).opportunity;

    const everythingElse = scoreOpportunity({
      icpFit: 0,
      intent: 0,
      reachability: 100,
      relationship: 100,
      identity: 100,
    }).opportunity;

    expect(fitAndIntent).toBeGreaterThan(everythingElse);
  });

  test('per-campaign weights override the defaults', () => {
    const intentLed = scoreOpportunity({
      icpFit: 0,
      intent: 100,
      reachability: 0,
      relationship: 0,
      identity: 0,
      weights: { icpFit: 0.1, intent: 0.8, reachability: 0.05, relationship: 0.05, identity: 0 },
    });

    expect(intentLed.opportunity).toBe(80);
  });

  test('retains the weights used, so an old score stays explainable', () => {
    const result = scoreOpportunity({
      icpFit: 50,
      intent: 50,
      reachability: 50,
      relationship: 50,
      identity: 50,
    });

    const total = Object.values(result.weights).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  test('never exceeds 100', () => {
    const result = scoreOpportunity({
      icpFit: 100,
      intent: 100,
      reachability: 100,
      relationship: 100,
      identity: 100,
      weights: { icpFit: 5, intent: 5, reachability: 5, relationship: 5, identity: 5 },
    });

    expect(result.opportunity).toBeLessThanOrEqual(100);
  });
});

describe('weight normalisation', () => {
  test('rescales weights that do not sum to one', () => {
    const normalized = normalizeWeights({
      icpFit: 70,
      intent: 60,
      reachability: 30,
      relationship: 30,
      identity: 10,
    });

    const total = Object.values(normalized).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(normalized.icpFit).toBeCloseTo(0.35, 10);
  });

  test('rejects negative weights', () => {
    expect(() =>
      normalizeWeights({ icpFit: -1, intent: 1, reachability: 1, relationship: 1, identity: 1 }),
    ).toThrow(/non-negative/);
  });

  test('rejects an all-zero set rather than dividing by zero', () => {
    expect(() =>
      normalizeWeights({ icpFit: 0, intent: 0, reachability: 0, relationship: 0, identity: 0 }),
    ).toThrow(/must not all be zero/);
  });
});
