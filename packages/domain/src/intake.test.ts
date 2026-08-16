import { describe, expect, test } from 'bun:test';
import { classifyIntake, toHostname } from './intake';

describe('toHostname', () => {
  test('accepts the shapes people actually paste', () => {
    expect(toHostname('acme.com')).toBe('acme.com');
    expect(toHostname('https://acme.com')).toBe('acme.com');
    expect(toHostname('https://www.acme.com/about?ref=1')).toBe('acme.com');
    expect(toHostname('acme.com/team')).toBe('acme.com');
    expect(toHostname('  ACME.COM  ')).toBe('acme.com');
    expect(toHostname('shop.acme.co.uk')).toBe('shop.acme.co.uk');
  });

  test('rejects things that are not hosts', () => {
    expect(toHostname('')).toBeUndefined();
    expect(toHostname('acme')).toBeUndefined();
    expect(toHostname('dental practices in austin')).toBeUndefined();
    // A dot alone is not enough — a company name with a full stop is prose.
    expect(toHostname('Acme Inc.')).toBeUndefined();
    expect(toHostname('mailto:jane@acme.com')).toBeUndefined();
    expect(toHostname('ftp://acme.com')).toBeUndefined();
  });
});

describe('classifyIntake', () => {
  test('a domain-shaped input is a url', () => {
    const result = classifyIntake('https://www.acme.com/team');
    expect(result?.kind).toBe('url');
    expect(result?.value).toBe('acme.com');
    // The original survives for showing back to whoever typed it.
    expect(result?.raw).toBe('https://www.acme.com/team');
  });

  test('a description is a keyword', () => {
    const result = classifyIntake('dental practices in Austin');
    expect(result?.kind).toBe('keyword');
    expect(result?.value).toBe('dental practices in Austin');
  });

  test('a single word is a valid market, not an error', () => {
    expect(classifyIntake('dentists')?.kind).toBe('keyword');
  });

  test('nothing usable comes back undefined', () => {
    expect(classifyIntake('')).toBeUndefined();
    expect(classifyIntake('   ')).toBeUndefined();
    expect(classifyIntake('12345')).toBeUndefined();
  });

  test('a long phrase is capped rather than rejected', () => {
    const result = classifyIntake('a'.repeat(500));
    expect(result?.kind).toBe('keyword');
    expect(result?.value.length).toBe(300);
  });
});
