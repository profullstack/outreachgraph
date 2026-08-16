import { describe, expect, test } from 'bun:test';
import { discoverCompanies, normaliseDomain } from './discover';
import type { GenerateInput, GenerateResult, TextModel } from './model';

/** Answers with a canned reply, and records what it was asked. */
function stubModel(text: string, refused = false): TextModel & { asked: GenerateInput[] } {
  const asked: GenerateInput[] = [];
  return {
    asked,
    async generate(input: GenerateInput): Promise<GenerateResult> {
      asked.push(input);
      return { text, model: 'stub', inputTokens: 0, outputTokens: 0, cachedTokens: 0, refused };
    },
  };
}

function throwingModel(message: string): TextModel {
  return {
    async generate(): Promise<GenerateResult> {
      throw new Error(message);
    },
  };
}

describe('normaliseDomain', () => {
  test('reduces every shape a model returns to one host', () => {
    expect(normaliseDomain('acme.com')).toBe('acme.com');
    expect(normaliseDomain('https://www.acme.com/about')).toBe('acme.com');
    expect(normaliseDomain('WWW.ACME.COM')).toBe('acme.com');
    expect(normaliseDomain('acme.com.')).toBe('acme.com');
  });

  test('rejects non-domains and the aggregators that are never a prospect', () => {
    expect(normaliseDomain('acme')).toBeUndefined();
    expect(normaliseDomain('')).toBeUndefined();
    expect(normaliseDomain(42)).toBeUndefined();
    expect(normaliseDomain('yelp.com')).toBeUndefined();
    expect(normaliseDomain('linkedin.com')).toBeUndefined();
    expect(normaliseDomain('example.com')).toBeUndefined();
  });
});

describe('discoverCompanies', () => {
  const reply = JSON.stringify({
    campaignName: 'Austin dental practices',
    brief: 'Independent dental practices in Austin, Texas.',
    companies: [
      { name: 'Bright Smile Dental', domain: 'https://www.brightsmile.com/', reason: 'Austin' },
      { name: 'Hill Country Dental', domain: 'hillcountrydental.com', reason: 'Austin' },
      // A duplicate of the first, in a different shape.
      { name: 'Bright Smile', domain: 'brightsmile.com' },
      // Never a prospect.
      { name: 'Yelp', domain: 'yelp.com' },
      // No usable domain.
      { name: 'Someone', domain: 'not a domain' },
    ],
  });

  test('normalises, dedupes and filters what the model returned', async () => {
    const result = await discoverCompanies(stubModel(reply), 'dental practices in Austin');

    expect(result.ok).toBe(true);
    expect(result.companies.map((c) => c.domain)).toEqual([
      'brightsmile.com',
      'hillcountrydental.com',
    ]);
    expect(result.campaignName).toBe('Austin dental practices');
  });

  test('reads a reply wrapped in a code fence', async () => {
    const result = await discoverCompanies(
      stubModel('Here you go:\n```json\n' + reply + '\n```'),
      'dentists',
    );
    expect(result.ok).toBe(true);
    expect(result.companies.length).toBeGreaterThan(0);
  });

  test('grounds the search in what the customer sells when known', async () => {
    const model = stubModel(reply);
    await discoverCompanies(model, 'dentists', { offeringSummary: 'scheduling software' });

    expect(model.asked[0]?.user).toContain('scheduling software');
  });

  test('an unreachable model is a reason, not a throw', async () => {
    const result = await discoverCompanies(throwingModel('usage limits'), 'dentists');

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('usage limits');
    expect(result.companies).toHaveLength(0);
  });

  test('a refusal and an unparseable reply both come back as reasons', async () => {
    expect((await discoverCompanies(stubModel('no', true), 'x')).ok).toBe(false);
    expect((await discoverCompanies(stubModel('not json at all'), 'x')).ok).toBe(false);
  });

  test('an empty query never reaches the model', async () => {
    const model = stubModel(reply);
    const result = await discoverCompanies(model, '   ');

    expect(result.ok).toBe(false);
    expect(model.asked).toHaveLength(0);
  });

  test('a list of only unusable companies is a failure, not an empty success', async () => {
    const result = await discoverCompanies(
      stubModel(JSON.stringify({ companies: [{ name: 'Yelp', domain: 'yelp.com' }] })),
      'dentists',
    );

    expect(result.ok).toBe(false);
  });
});
