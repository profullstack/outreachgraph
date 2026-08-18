import { describe, expect, test } from 'bun:test';
import { StubModel } from './model';
import { expandTerm, mergeTerms, MAX_EXPANSIONS_PER_TERM } from './synonyms';

function expansions(list: readonly string[]): string {
  return JSON.stringify({ expansions: list });
}

describe('expandTerm', () => {
  test('returns the phrases people actually use', async () => {
    const model = new StubModel(
      expansions(['our Stripe fees are killing us', 'looking for a Stripe alternative']),
    );

    const result = await expandTerm(model, 'payments provider');

    expect(result.expansions).toEqual([
      'our Stripe fees are killing us',
      'looking for a Stripe alternative',
    ]);
  });

  test('drops single words that would match an entire industry', async () => {
    const model = new StubModel(expansions(['payments', 'billing', 'switching off Stripe']));

    expect((await expandTerm(model, 'payments provider')).expansions).toEqual([
      'switching off Stripe',
    ]);
  });

  test('drops an expansion identical to the term', async () => {
    const model = new StubModel(expansions(['Payments Provider', 'moving off Braintree']));

    expect((await expandTerm(model, 'payments provider')).expansions).toEqual([
      'moving off Braintree',
    ]);
  });

  test('caps how far one term can widen a search', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `some phrase number ${i}`);
    const model = new StubModel(expansions(many));

    expect((await expandTerm(model, 'payments provider')).expansions).toHaveLength(
      MAX_EXPANSIONS_PER_TERM,
    );
  });

  test('expands to nothing when the model returns prose', async () => {
    const model = new StubModel('Sure! Here are some ideas: fees, billing, payments.');

    // Failing closed here means literal matching, which is the behaviour with
    // no API key at all — never a broken campaign.
    expect((await expandTerm(model, 'payments provider')).expansions).toEqual([]);
  });

  test('does not call the model for a term too short to be useful', async () => {
    const model = new StubModel(expansions(['anything at all']));

    const result = await expandTerm(model, 'ai');

    expect(result.expansions).toEqual([]);
    expect(model.calls).toHaveLength(0);
  });

  test('expands to nothing when the model refuses', async () => {
    const model = {
      generate: async () => ({
        text: '',
        model: 'stub',
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        refused: true,
      }),
    };

    expect((await expandTerm(model, 'payments provider')).expansions).toEqual([]);
  });
});

describe('mergeTerms', () => {
  test('keeps every original term first', async () => {
    const merged = mergeTerms(
      ['payments provider'],
      new Map([['payments provider', ['our Stripe fees are killing us']]]),
    );

    expect(merged[0]).toBe('payments provider');
    expect(merged).toHaveLength(2);
  });

  test('never drops an original, whatever the expansion said', () => {
    // A user who typed a term has a right to expect it searched.
    const merged = mergeTerms(['payments provider'], new Map());

    expect(merged).toEqual(['payments provider']);
  });

  test('deduplicates case-insensitively across terms', () => {
    const merged = mergeTerms(
      ['payments provider', 'billing platform'],
      new Map([
        ['payments provider', ['moving off Stripe']],
        ['billing platform', ['Moving Off Stripe']],
      ]),
    );

    expect(merged).toEqual(['payments provider', 'billing platform', 'moving off Stripe']);
  });

  test('is the identity function with no expansions at all', () => {
    const terms = ['payments provider', 'billing platform'];

    expect(mergeTerms(terms, new Map())).toEqual(terms);
  });
});
