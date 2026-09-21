import { describe, expect, test } from 'bun:test';
import {
  allocateDailyBudget,
  autogtmStatus,
  capUnderCeiling,
  CONTACT_PRICE_USD,
  dailyContactsFor,
  replyRate,
  usdForContacts,
} from './autogtm';

describe('CONTACT_PRICE_USD', () => {
  test('is the smallest pack price per credit', () => {
    // pack_100 is $15 for 100 credits.
    expect(CONTACT_PRICE_USD).toBe(0.15);
  });
});

describe('dailyContactsFor', () => {
  test('floors to whole contacts', () => {
    expect(dailyContactsFor(0.44)).toBe(2);
    expect(dailyContactsFor(0.45)).toBe(3);
    expect(dailyContactsFor(15)).toBe(100);
  });

  test('nothing, nonsense and negatives buy zero', () => {
    expect(dailyContactsFor(0)).toBe(0);
    expect(dailyContactsFor(-3)).toBe(0);
    expect(dailyContactsFor(Number.NaN)).toBe(0);
  });

  test('round-trips through usdForContacts', () => {
    expect(usdForContacts(dailyContactsFor(30))).toBe(30);
  });
});

describe('allocateDailyBudget', () => {
  test('sums to the total exactly', () => {
    const split = allocateDailyBudget({
      totalUsd: 10,
      campaigns: [
        { id: 'a', contacted: 100, replies: 9 },
        { id: 'b', contacted: 100, replies: 1 },
        { id: 'c', contacted: 0, replies: 0 },
      ],
    });

    const sum = [...split.values()].reduce((acc, value) => acc + value, 0);
    expect(Math.round(sum * 100) / 100).toBe(10);
  });

  test('a campaign that replies more gets more', () => {
    const split = allocateDailyBudget({
      totalUsd: 10,
      campaigns: [
        { id: 'strong', contacted: 100, replies: 9 },
        { id: 'weak', contacted: 100, replies: 1 },
      ],
    });

    expect(split.get('strong')!).toBeGreaterThan(split.get('weak')!);
  });

  test('a new campaign is not starved', () => {
    const split = allocateDailyBudget({
      totalUsd: 10,
      campaigns: [
        { id: 'proven', contacted: 1000, replies: 200 },
        { id: 'new', contacted: 0, replies: 0 },
      ],
    });

    // At least its share of the exploration slice.
    expect(split.get('new')!).toBeGreaterThanOrEqual(1);
  });

  test('is deterministic', () => {
    const input = {
      totalUsd: 7.77,
      campaigns: [
        { id: 'a', contacted: 3, replies: 1 },
        { id: 'b', contacted: 30, replies: 2 },
      ],
    };
    expect([...allocateDailyBudget(input)]).toEqual([...allocateDailyBudget(input)]);
  });

  test('no campaigns or no money allocates nothing', () => {
    expect(allocateDailyBudget({ totalUsd: 10, campaigns: [] }).size).toBe(0);
    const zero = allocateDailyBudget({
      totalUsd: 0,
      campaigns: [{ id: 'a', contacted: 1, replies: 1 }],
    });
    expect(zero.get('a')).toBe(0);
  });
});

describe('capUnderCeiling', () => {
  test('leaves budgets alone when they fit', () => {
    const budgets = new Map([
      ['a', 3],
      ['b', 4],
    ]);
    expect(capUnderCeiling(budgets, 10)).toBe(budgets);
  });

  test('scales proportionally when they do not', () => {
    const capped = capUnderCeiling(
      new Map([
        ['a', 30],
        ['b', 10],
      ]),
      20,
    );
    expect(capped.get('a')).toBe(15);
    expect(capped.get('b')).toBe(5);
  });
});

describe('autogtmStatus', () => {
  test('maps every row shape somewhere sensible', () => {
    expect(autogtmStatus({ status: 'archived', approval_mode: 'draft_and_approve' })).toBe(
      'archived',
    );
    expect(autogtmStatus({ status: 'paused', approval_mode: 'trusted_automation' })).toBe(
      'listening',
    );
    expect(autogtmStatus({ status: 'draft', approval_mode: 'draft_and_approve' })).toBe(
      'discovery',
    );
    expect(autogtmStatus({ status: 'active', approval_mode: 'trusted_automation' })).toBe(
      'outreach',
    );
    expect(autogtmStatus({ status: 'active', approval_mode: 'draft_and_approve' })).toBe('review');
    expect(autogtmStatus({ status: 'active', approval_mode: 'research_only', contacted: 0 })).toBe(
      'discovery',
    );
  });
});

describe('replyRate', () => {
  test('is a fraction, zero before anything is sent', () => {
    expect(replyRate(0, 0)).toBe(0);
    expect(replyRate(200, 7)).toBe(0.035);
  });
});
