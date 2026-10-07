import { describe, expect, test } from 'bun:test';
import { inBusinessHours, nextBusinessOpening, recipientTimezone } from './timing';

describe('recipientTimezone', () => {
  test.each([
    [{ personLocation: 'San Francisco Bay Area' }, 'America/Los_Angeles'],
    [{ personLocation: 'Irvine, CA' }, 'America/Los_Angeles'],
    [{ personLocation: 'Toronto, ON, CA' }, 'America/New_York'],
    [{ personLocation: 'Austin, TX, United States' }, 'America/Chicago'],
    [{ personLocation: 'Berlin, Germany' }, 'Europe/Berlin'],
    [{ personLocation: 'Remote or onsite' }, 'America/New_York'],
    [{ companyLocation: 'London' }, 'Europe/London'],
    [{ address: 'jan@firma.de' }, 'Europe/Berlin'],
    [{ address: 'jane@acme.com' }, 'America/New_York'],
  ] as const)('%o → %s', (input, zone) => {
    expect(recipientTimezone(input).zone).toBe(zone);
  });

  test('the person beats the company, the company beats the domain', () => {
    expect(
      recipientTimezone({ personLocation: 'Tokyo', companyLocation: 'Berlin', address: 'a@b.fr' }),
    ).toEqual({ zone: 'Asia/Tokyo', source: 'person' });
  });
});

describe('business hours', () => {
  // Wednesday 2026-10-07.
  test('Wednesday 10:00 in New York is open; 20:00 is not; Saturday is not', () => {
    expect(inBusinessHours(new Date('2026-10-07T14:00:00Z'), 'America/New_York')).toBe(true);
    expect(inBusinessHours(new Date('2026-10-08T00:00:00Z'), 'America/New_York')).toBe(false);
    expect(inBusinessHours(new Date('2026-10-10T15:00:00Z'), 'America/New_York')).toBe(false);
  });

  test('Friday evening opens Monday 08:00 local', () => {
    const opening = nextBusinessOpening(new Date('2026-10-09T23:30:00Z'), 'America/New_York');
    expect(opening.toISOString()).toBe('2026-10-12T12:00:00.000Z');
  });
});
