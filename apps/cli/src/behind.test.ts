import { describe, expect, test } from 'bun:test';
import { commandByName, formatBehind } from './commands';

describe('og behind', () => {
  test('is a command, and connect/disconnect accept coinpay', () => {
    expect(commandByName('behind')).toBeDefined();
    expect(commandByName('connect')?.usage).toContain('og connect coinpay');
    expect(commandByName('disconnect')?.usage).toContain('coinpay');
  });

  test('says how to connect when CoinPay is not connected', () => {
    expect(formatBehind({ state: 'not_connected' })).toContain('og connect coinpay');
  });

  test('passes a locked or error message through', () => {
    expect(formatBehind({ state: 'locked', message: 'locked: unlock your keys' })).toBe(
      'locked: unlock your keys',
    );
  });

  test('prints the summary, each group, and each person with reason and history', () => {
    const out = formatBehind({
      state: 'ok',
      summary: '1 customer is behind on £390.00: 3 declined card payments.',
      groups: [
        {
          title: 'Likely to go through on a retry',
          todo: 'Send the payment link again in a few days.',
          customers: [
            {
              name: 'Northgate Logistics',
              email: 'ops@northgate.example',
              owed: [{ currency: 'GBP', amount: 390 }],
              items: [{ detail: 'Not enough money in the account at the time.' }],
              history: { line: 'Paying since Mar 2026 · never missed before' },
            },
          ],
        },
      ],
    });
    expect(out).toStartWith('1 customer is behind on £390.00');
    expect(out).toContain('Likely to go through on a retry: Send the payment link again');
    expect(out).toContain('Northgate Logistics');
    expect(out).toContain('£390.00');
    expect(out).toContain('Not enough money in the account at the time.');
    expect(out).toContain('ops@northgate.example · Paying since Mar 2026 · never missed before');
  });
});
