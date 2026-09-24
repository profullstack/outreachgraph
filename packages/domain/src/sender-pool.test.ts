import { describe, expect, test } from 'bun:test';
import {
  bounceRateExceeded,
  choosePoolSender,
  configuredCap,
  effectiveDailyCap,
  isAuthFailure,
  isRecipientBounce,
  nextUtcDay,
  warmupCap,
  warmupComplete,
  warmupDay,
  type PoolCandidate,
  type SenderCapInput,
} from './sender-pool';

const START = '2026-09-01T10:00:00.000Z';

function on(day: number, hour = 12): Date {
  return new Date(Date.UTC(2026, 8, 1 + day, hour));
}

function account(overrides: Partial<SenderCapInput> = {}): SenderCapInput {
  return {
    network: 'email',
    status: 'active',
    dailyCap: null,
    warmupEnabled: true,
    warmupStartedAt: START,
    ...overrides,
  };
}

describe('warm-up ramp', () => {
  test('counts UTC calendar days from the start, never below zero', () => {
    expect(warmupDay(START, on(0))).toBe(0);
    expect(warmupDay(START, on(0, 23))).toBe(0);
    expect(warmupDay(START, on(1, 0))).toBe(1);
    expect(warmupDay(START, on(9))).toBe(9);
    // A start in the future is day 0, not a negative allowance.
    expect(warmupDay(START, new Date(Date.UTC(2026, 7, 20)))).toBe(0);
    expect(warmupDay('not a date', on(3))).toBe(0);
  });

  test('email starts at 5 and adds 3 a day; LinkedIn starts at 5 and adds 2', () => {
    expect([0, 1, 2, 5].map((day) => warmupCap('email', day))).toEqual([5, 8, 11, 20]);
    expect([0, 1, 2, 5].map((day) => warmupCap('linkedin', day))).toEqual([5, 7, 9, 15]);
  });

  test('the effective cap is the smaller of the ramp and the configured cap', () => {
    expect(effectiveDailyCap(account(), on(0))).toBe(5);
    expect(effectiveDailyCap(account(), on(4))).toBe(17);
    // Day 15 of email: the ramp (50) meets the default cap (50).
    expect(effectiveDailyCap(account(), on(15))).toBe(50);
    expect(effectiveDailyCap(account(), on(40))).toBe(50);
    expect(effectiveDailyCap(account({ dailyCap: 12 }), on(4))).toBe(12);
    expect(effectiveDailyCap(account({ network: 'linkedin' }), on(30))).toBe(25);
  });

  test('warm-up off means the configured cap from day one', () => {
    expect(effectiveDailyCap(account({ warmupEnabled: false }), on(0))).toBe(50);
    expect(effectiveDailyCap(account({ warmupStartedAt: null }), on(0))).toBe(50);
    expect(warmupComplete(account({ warmupEnabled: false }), on(0))).toBe(true);
  });

  test('an account that is not active has no capacity at all', () => {
    for (const status of ['paused', 'error', 'revoked']) {
      expect(effectiveDailyCap(account({ status, warmupEnabled: false }), on(20))).toBe(0);
    }
  });

  test('warm-up is complete once the ramp stops binding', () => {
    expect(warmupComplete(account(), on(14))).toBe(false);
    expect(warmupComplete(account(), on(15))).toBe(true);
    expect(warmupComplete(account({ dailyCap: 8 }), on(1))).toBe(true);
  });

  test('a missing or nonsensical cap falls back to the network default', () => {
    expect(configuredCap({ network: 'email', dailyCap: null })).toBe(50);
    expect(configuredCap({ network: 'linkedin', dailyCap: null })).toBe(25);
    expect(configuredCap({ network: 'x', dailyCap: null })).toBe(20);
    expect(configuredCap({ network: 'email', dailyCap: -3 })).toBe(50);
    expect(configuredCap({ network: 'email', dailyCap: 0 })).toBe(0);
    expect(configuredCap({ network: 'email', dailyCap: 7.9 })).toBe(7);
  });

  test('the next UTC day is midnight after', () => {
    expect(nextUtcDay(on(3, 17)).toISOString()).toBe('2026-09-05T00:00:00.000Z');
  });
});

function candidate(id: string, overrides: Partial<PoolCandidate> = {}): PoolCandidate {
  return { id, status: 'active', effectiveCap: 10, sentToday: 0, lastUsedAt: null, ...overrides };
}

describe('choosing a sender', () => {
  test('sticks to the account already talking to the person', () => {
    const pool = [candidate('a', { sentToday: 9 }), candidate('b')];
    expect(choosePoolSender(pool, 'a')).toEqual({ kind: 'picked', id: 'a', reason: 'continuity' });
  });

  test('waits for that account when it is full rather than switching', () => {
    const pool = [candidate('a', { sentToday: 10 }), candidate('b')];
    expect(choosePoolSender(pool, 'a')).toEqual({
      kind: 'deferred',
      reason: 'continuity_capped',
      id: 'a',
    });
  });

  test('waits for a paused account, but reassigns one that is gone for good', () => {
    expect(choosePoolSender([candidate('a', { status: 'paused' }), candidate('b')], 'a')).toEqual({
      kind: 'deferred',
      reason: 'continuity_paused',
      id: 'a',
    });
    expect(choosePoolSender([candidate('a', { status: 'error' }), candidate('b')], 'a')).toEqual({
      kind: 'picked',
      id: 'b',
      reason: 'capacity',
    });
    expect(choosePoolSender([candidate('b')], 'removed')).toEqual({
      kind: 'picked',
      id: 'b',
      reason: 'capacity',
    });
  });

  test('otherwise picks the account with the most room today', () => {
    const pool = [
      candidate('a', { sentToday: 6 }),
      candidate('b', { effectiveCap: 5, sentToday: 0 }),
      candidate('c', { effectiveCap: 30, sentToday: 20 }),
    ];
    expect(choosePoolSender(pool)).toEqual({ kind: 'picked', id: 'c', reason: 'capacity' });
  });

  test('ties go round robin: least recently used first, never-used before all', () => {
    const pool = [
      candidate('a', { lastUsedAt: '2026-09-01T10:05:00Z' }),
      candidate('b', { lastUsedAt: '2026-09-01T10:01:00Z' }),
      candidate('c', { lastUsedAt: '2026-09-01T10:03:00Z' }),
    ];
    expect(choosePoolSender(pool)).toMatchObject({ id: 'b' });
    expect(choosePoolSender([...pool, candidate('d')])).toMatchObject({ id: 'd' });
    // Equal on everything: the lowest id, so the answer is deterministic.
    expect(choosePoolSender([candidate('z'), candidate('m')])).toMatchObject({ id: 'm' });
  });

  test('defers when every active account is at its cap', () => {
    const pool = [candidate('a', { sentToday: 10 }), candidate('b', { effectiveCap: 0 })];
    expect(choosePoolSender(pool)).toEqual({ kind: 'deferred', reason: 'all_capped' });
  });

  test('reports no active account apart from a full pool', () => {
    expect(choosePoolSender([])).toEqual({ kind: 'none_active' });
    expect(choosePoolSender([candidate('a', { status: 'paused' })])).toEqual({
      kind: 'none_active',
    });
  });

  test('a pool of one always answers with that account while it has room', () => {
    expect(choosePoolSender([candidate('only', { effectiveCap: 50, sentToday: 49 })])).toEqual({
      kind: 'picked',
      id: 'only',
      reason: 'capacity',
    });
  });
});

describe('account health', () => {
  test('stops past 5% of the last 100 sends', () => {
    expect(bounceRateExceeded(100, 5)).toBe(false);
    expect(bounceRateExceeded(100, 6)).toBe(true);
    // Never measured over more than the window.
    expect(bounceRateExceeded(400, 6)).toBe(true);
  });

  test('a single early bounce does not stop a new account, but a bad list does', () => {
    expect(bounceRateExceeded(1, 1)).toBe(false);
    expect(bounceRateExceeded(3, 1)).toBe(false);
    expect(bounceRateExceeded(3, 2)).toBe(true);
    expect(bounceRateExceeded(50, 0)).toBe(false);
  });

  test('recognises a rejected login and a refused recipient', () => {
    expect(isAuthFailure('email send failed (535): 5.7.8 Username and Password not accepted')).toBe(
      true,
    );
    expect(isAuthFailure('Invalid login: 534-5.7.9 Application-specific password required')).toBe(
      true,
    );
    expect(isAuthFailure('email send failed (550): 5.1.1 user unknown')).toBe(false);

    expect(
      isRecipientBounce('email send failed (550): 5.1.1 The email account does not exist'),
    ).toBe(true);
    expect(isRecipientBounce('Recipient address rejected: User unknown in virtual table')).toBe(
      true,
    );
    expect(isRecipientBounce('email send failed (421): try again later')).toBe(false);
    expect(isRecipientBounce('connect ETIMEDOUT')).toBe(false);
  });
});
