import { describe, expect, test } from 'bun:test';
import { resolveIdentity } from '@outreachgraph/identity';
import { deriveEvidence } from './evidence';
import { FixtureProvider, FIXTURE_CANDIDATES } from './fixture-provider';
import { enrichWithWaterfall, orderProviders } from './waterfall';

const JANE = FIXTURE_CANDIDATES[0]!;

describe('provider ordering', () => {
  test('consults the cheapest provider first', () => {
    const expensive = new FixtureProvider({ slug: 'expensive', costPerEnrichmentUsd: 0.5 });
    const cheap = new FixtureProvider({ slug: 'cheap', costPerEnrichmentUsd: 0.01 });
    const free = new FixtureProvider({ slug: 'free', costPerEnrichmentUsd: 0 });

    const ordered = orderProviders([expensive, cheap, free]);
    expect(ordered.map((p) => p.capabilities().slug)).toEqual(['free', 'cheap', 'expensive']);
  });

  test('breaks cost ties deterministically', () => {
    const a = new FixtureProvider({ slug: 'bravo', costPerEnrichmentUsd: 0.1 });
    const b = new FixtureProvider({ slug: 'alpha', costPerEnrichmentUsd: 0.1 });

    expect(orderProviders([a, b]).map((p) => p.capabilities().slug)).toEqual(['alpha', 'bravo']);
  });
});

describe('the waterfall (PRD §10.2)', () => {
  test('stops as soon as the confidence target is met', async () => {
    const cheap = new FixtureProvider({ slug: 'cheap', costPerEnrichmentUsd: 0.01 });
    const expensive = new FixtureProvider({ slug: 'expensive', costPerEnrichmentUsd: 1 });

    const result = await enrichWithWaterfall([expensive, cheap], {
      handles: { github: 'janesmith' },
    });

    expect(result.candidate?.fullName).toBe('Jane Smith');
    expect(result.attempts.map((a) => a.provider)).toEqual(['cheap']);
    expect(result.totalCostUsd).toBeCloseTo(0.01, 10);
  });

  test('keeps walking when the first provider is not confident enough', async () => {
    const weak = new FixtureProvider({ slug: 'weak', costPerEnrichmentUsd: 0, candidates: [] });
    const strong = new FixtureProvider({ slug: 'strong', costPerEnrichmentUsd: 0.05 });

    const result = await enrichWithWaterfall([weak, strong], {
      handles: { github: 'janesmith' },
    });

    expect(result.attempts.map((a) => a.outcome)).toEqual(['miss', 'hit']);
    expect(result.candidate?.fullName).toBe('Jane Smith');
  });

  test('a failing provider does not abort the walk', async () => {
    const broken = new FixtureProvider({
      slug: 'broken',
      costPerEnrichmentUsd: 0,
      failWith: 'upstream 503',
    });
    const working = new FixtureProvider({ slug: 'working', costPerEnrichmentUsd: 0.02 });

    const result = await enrichWithWaterfall([broken, working], {
      handles: { github: 'janesmith' },
    });

    expect(result.attempts[0]?.outcome).toBe('error');
    expect(result.attempts[0]?.error).toContain('503');
    expect(result.candidate?.fullName).toBe('Jane Smith');
  });

  test('skips a lookup already paid for', async () => {
    const provider = new FixtureProvider({ slug: 'apollo-ish', costPerEnrichmentUsd: 0.1 });

    const result = await enrichWithWaterfall(
      [provider],
      { handles: { github: 'janesmith' } },
      { requestHash: 'abc123', alreadyFetched: new Set(['apollo-ish:abc123']) },
    );

    expect(result.attempts[0]?.outcome).toBe('skipped_cached');
    expect(result.totalCostUsd).toBe(0);
    expect(result.candidate).toBeUndefined();
  });

  test('stops before exceeding the cost ceiling', async () => {
    const pricey = new FixtureProvider({ slug: 'pricey', costPerEnrichmentUsd: 5 });

    const result = await enrichWithWaterfall(
      [pricey],
      { handles: { github: 'janesmith' } },
      { maxCostUsd: 1 },
    );

    expect(result.attempts[0]?.outcome).toBe('skipped_budget');
    expect(result.totalCostUsd).toBe(0);
  });

  test('returns no candidate when nothing matches', async () => {
    const provider = new FixtureProvider();
    const result = await enrichWithWaterfall([provider], { fullName: 'Nobody At All' });

    expect(result.candidate).toBeUndefined();
    expect(result.matchConfidence).toBe(0);
    expect(result.provenance).toEqual({});
  });
});

describe('provenance (PRD §10.3)', () => {
  test('attributes every returned field to its provider', async () => {
    const result = await enrichWithWaterfall([new FixtureProvider()], {
      handles: { github: 'janesmith' },
    });

    expect(result.provenance.fullName?.value).toBe('Jane Smith');
    expect(result.provenance.fullName?.provider).toBe('fixture');
    expect(result.provenance.fullName?.licenseClass).toBe('customer_owned');
    expect(result.provenance.fullName?.observedAt).toBe(JANE.observedAt);
  });

  test('attributes each linked identity', async () => {
    const result = await enrichWithWaterfall([new FixtureProvider()], {
      handles: { github: 'janesmith' },
    });

    expect(result.provenance['identity.github']?.value).toBe('janesmith');
    expect(result.provenance['identity.bluesky']?.value).toBe('jane.dev');
  });

  test('carries the source record id for deletion tracing', async () => {
    const result = await enrichWithWaterfall([new FixtureProvider()], {
      handles: { github: 'janesmith' },
    });

    expect(result.provenance.fullName?.sourceRecordId).toBe('fixture-jane-smith');
  });
});

describe('search', () => {
  test('filters by the campaign criteria', async () => {
    const provider = new FixtureProvider();

    const result = await provider.search({
      industries: ['SaaS'],
      employeeCountMin: 20,
      employeeCountMax: 500,
    });

    expect(result.candidates.map((c) => c.fullName)).toEqual(['Jane Smith', 'Priya Raman']);
  });

  test('filters by technology', async () => {
    const result = await new FixtureProvider().search({ technologies: ['bun'] });
    expect(result.candidates.map((c) => c.fullName)).toEqual(['Alex Chen']);
  });

  test('honours the limit', async () => {
    const result = await new FixtureProvider().search({ limit: 1 });
    expect(result.candidates).toHaveLength(1);
  });
});

describe('evidence derivation feeding the resolver', () => {
  test('a self-published cross-link resolves to a merge', () => {
    const identity = JANE.identities.find((i) => i.network === 'github')!;

    const evidence = deriveEvidence({
      identity,
      candidate: JANE,
      capabilities: new FixtureProvider().capabilities(),
      crossLinkedHandles: ['janesmith'],
      platformEmployer: 'Acme',
    });

    const resolution = resolveIdentity(evidence);

    expect(resolution.decision).toBe('merge');
    expect(resolution.verifiedBy).toContain('cross_linked_profile');
    expect(resolution.verifiedBy).toContain('same_employer');
  });

  test('a conflicting employer is emitted as negative evidence', () => {
    const identity = JANE.identities.find((i) => i.network === 'github')!;

    const evidence = deriveEvidence({
      identity,
      candidate: JANE,
      capabilities: new FixtureProvider().capabilities(),
      platformEmployer: 'Some Other Company',
    });

    expect(evidence.map((e) => e.kind)).toContain('conflicting_employer');

    const resolution = resolveIdentity(evidence);
    expect(resolution.contradictions.length).toBeGreaterThan(0);
  });

  test('emits nothing beyond the provider assertion without corroboration', () => {
    const identity = JANE.identities.find((i) => i.network === 'x') ?? JANE.identities[0]!;

    const evidence = deriveEvidence({
      identity,
      candidate: { ...JANE, personalDomain: undefined },
      capabilities: new FixtureProvider().capabilities(),
    });

    expect(evidence.map((e) => e.kind)).toEqual(['provider_asserted_link']);
  });
});
