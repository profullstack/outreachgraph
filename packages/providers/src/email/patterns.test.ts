import { describe, expect, test } from 'bun:test';
import { applyPattern, candidateAddresses, inferPatterns, type EmailPattern } from './patterns';

const JACK = { firstName: 'Jack', lastName: 'Ellis' };

describe('rendering a pattern', () => {
  test.each([
    ['first', 'jack@usefathom.com'],
    ['first.last', 'jack.ellis@usefathom.com'],
    ['firstlast', 'jackellis@usefathom.com'],
    ['flast', 'jellis@usefathom.com'],
    ['first_last', 'jack_ellis@usefathom.com'],
    ['firstl', 'jacke@usefathom.com'],
    ['last.first', 'ellis.jack@usefathom.com'],
    ['f.last', 'j.ellis@usefathom.com'],
  ] as [EmailPattern, string][])('%s', (pattern, expected) => {
    expect(applyPattern(pattern, JACK, 'usefathom.com')).toBe(expected);
  });

  test('folds accents rather than dropping the character', () => {
    // Dropping it would produce `nijhf@`, which is nobody's address.
    expect(applyPattern('flast', { firstName: 'Pascal', lastName: 'Nijhöf' }, 'acme.com')).toBe(
      'pnijhof@acme.com',
    );
  });

  test('keeps a hyphenated first name joined, not truncated', () => {
    expect(
      applyPattern('first.last', { firstName: 'Tuan-Anh', lastName: 'Tran' }, 'acme.com'),
    ).toBe('tuananh.tran@acme.com');
  });

  test('a mononym gets `first` and no two-part pattern at all', () => {
    expect(applyPattern('first', { firstName: 'Cher' }, 'acme.com')).toBe('cher@acme.com');
    // Better to offer nothing than `c@acme.com`, which belongs to somebody else.
    expect(applyPattern('flast', { firstName: 'Cher' }, 'acme.com')).toBeUndefined();
    expect(applyPattern('first.last', { firstName: 'Cher' }, 'acme.com')).toBeUndefined();
  });

  test('strips a www. host so the address is not www-prefixed', () => {
    expect(applyPattern('first', JACK, 'www.usefathom.com')).toBe('jack@usefathom.com');
  });
});

describe('learning the shape from a confirmed address', () => {
  test('recognises the pattern a known address is written in', () => {
    expect(inferPatterns('j.ellis@usefathom.com', JACK, 'usefathom.com')).toContain('f.last');
  });

  test('returns every pattern that fits, because short names are ambiguous', () => {
    // Amy Ng's `amyng@` is both `firstlast` and, coincidentally, nothing else —
    // but `amy@` is `first` alone. The caller keeps all of them so a second
    // confirmation can narrow it rather than the module picking early.
    const fits = inferPatterns('amyng@acme.com', { firstName: 'Amy', lastName: 'Ng' }, 'acme.com');
    expect(fits).toContain('firstlast');
    expect(fits).not.toContain('first');
  });

  test('an address that fits nothing teaches nothing', () => {
    expect(inferPatterns('support@usefathom.com', JACK, 'usefathom.com')).toEqual([]);
  });

  test('is case and whitespace insensitive about the address', () => {
    expect(inferPatterns('  Jack.Ellis@UseFathom.com ', JACK, 'usefathom.com')).toContain(
      'first.last',
    );
  });
});

describe('proposing candidates', () => {
  test('a learned pattern outranks every prior', () => {
    const [best] = candidateAddresses(JACK, 'usefathom.com', ['f.last']);

    expect(best?.address).toBe('j.ellis@usefathom.com');
    expect(best?.derived).toBe(true);
  });

  test('an underived guess never reaches a confidence that could be acted on', () => {
    // The whole safety property: with nothing confirmed at the domain, no
    // candidate may look good enough for anything unattended to use it.
    for (const candidate of candidateAddresses(JACK, 'usefathom.com')) {
      expect(candidate.derived).toBe(false);
      expect(candidate.confidence).toBeLessThan(0.5);
    }
  });

  test('never proposes the same address twice', () => {
    const addresses = candidateAddresses(JACK, 'usefathom.com', ['first']).map((c) => c.address);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  test('ambiguous learning splits the confidence rather than claiming both', () => {
    const two = candidateAddresses(JACK, 'usefathom.com', ['first.last', 'flast']);
    const one = candidateAddresses(JACK, 'usefathom.com', ['first.last']);

    expect(two[0]?.confidence).toBeLessThan(one[0]?.confidence ?? 1);
  });

  test('a mononym yields something rather than nothing', () => {
    const candidates = candidateAddresses({ firstName: 'Cher' }, 'acme.com');
    expect(candidates.map((c) => c.address)).toEqual(['cher@acme.com']);
  });
});
