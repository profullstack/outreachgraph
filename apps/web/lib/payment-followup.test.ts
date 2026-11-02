import { describe, expect, test } from 'bun:test';
import type { BehindCustomerView } from './api';
import { draftFollowUp, owedText } from './payment-followup';

const base: BehindCustomerView = {
  key: 'k',
  name: 'Northgate Logistics',
  email: 'ops@northgate.example',
  business_name: 'Acme',
  action: 'retry',
  owed: [{ currency: 'GBP', amount: 390 }],
  items: [
    {
      kind: 'card',
      id: 't1',
      amount: 390,
      currency: 'GBP',
      date: '2026-09-09T00:00:00Z',
      title: 'Card payment declined Sep 9',
      detail: 'Not enough money in the account at the time.',
      href: '/transactions/t1',
    },
  ],
  history: { line: 'Paying since Mar 2026 · never missed before' },
};

describe('draftFollowUp', () => {
  test('a retry names the amount and asks to try again', () => {
    const d = draftFollowUp(base)!;
    expect(d.to).toBe('ops@northgate.example');
    expect(d.subject).toBe('Your payment to Acme');
    expect(d.body).toStartWith('Hi Northgate,');
    expect(d.body).toContain('£390.00');
    expect(d.mailto.startsWith('mailto:ops%40northgate.example?subject=')).toBe(true);
  });

  test('a flagged card never tells the cardholder why', () => {
    const d = draftFollowUp({ ...base, action: 'do_not_chase' })!;
    expect(d.body).toContain('was declined');
    expect(d.body).not.toMatch(/stolen|fraud|lost|flag/i);
  });

  test('an invoice reminder names the invoice', () => {
    const d = draftFollowUp({
      ...base,
      action: 'remind',
      owed: [{ currency: 'USD', amount: 500 }],
      items: [{ ...base.items[0]!, kind: 'invoice', title: 'Invoice INV-7' }],
    })!;
    expect(d.subject).toBe('Invoice INV-7 from Acme');
    expect(d.body).toContain('invoice INV-7 for $500.00 is overdue');
  });

  test('no email address, no draft', () => {
    expect(draftFollowUp({ ...base, email: null })).toBeUndefined();
  });

  test('mixed currencies are listed, not added', () => {
    expect(
      owedText({
        owed: [
          { currency: 'USD', amount: 500 },
          { currency: 'GBP', amount: 390 },
        ],
      }),
    ).toBe('$500.00 + £390.00');
  });
});
