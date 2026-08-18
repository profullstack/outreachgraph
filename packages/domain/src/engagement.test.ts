import { describe, expect, test } from 'bun:test';
import {
  classifyFetch,
  extractUrls,
  rewriteUrls,
  trackedLinkUrl,
  PREFETCH_WINDOW_SECONDS,
} from './engagement';

describe('extractUrls', () => {
  test('finds an absolute url', () => {
    expect(extractUrls('have a look at https://example.com/docs today')).toEqual([
      'https://example.com/docs',
    ]);
  });

  test('leaves a bare domain alone', () => {
    // Rewriting this would turn prose into a link the writer never wrote.
    expect(extractUrls('we compared stripe.com and adyen.com')).toEqual([]);
  });

  test('drops sentence punctuation that follows a url', () => {
    expect(extractUrls('the changelog is at https://example.com/changelog.')).toEqual([
      'https://example.com/changelog',
    ]);
  });

  test('keeps parentheses the url itself opens', () => {
    expect(extractUrls('https://en.wikipedia.org/wiki/Bracket_(disambiguation)')).toEqual([
      'https://en.wikipedia.org/wiki/Bracket_(disambiguation)',
    ]);
  });

  test('drops a closing paren the url did not open', () => {
    expect(extractUrls('see the docs (https://example.com/docs)')).toEqual([
      'https://example.com/docs',
    ]);
  });

  test('deduplicates a url used twice', () => {
    const text = 'https://example.com/a and again https://example.com/a';
    expect(extractUrls(text)).toEqual(['https://example.com/a']);
  });

  test('finds several distinct urls', () => {
    expect(extractUrls('https://a.dev then https://b.dev')).toEqual([
      'https://a.dev',
      'https://b.dev',
    ]);
  });
});

describe('rewriteUrls', () => {
  test('replaces a url and reports the count', () => {
    const result = rewriteUrls('read https://example.com/docs now', () => 'https://t.test/abc');

    expect(result.text).toBe('read https://t.test/abc now');
    expect(result.rewritten).toBe(1);
  });

  test('preserves punctuation that followed the url', () => {
    const result = rewriteUrls('see https://example.com/docs.', () => 'https://t.test/abc');

    expect(result.text).toBe('see https://t.test/abc.');
  });

  test('leaves a url alone when the replacer declines', () => {
    // A link we could not persist stays in the body rather than vanishing from
    // a sentence that depends on it.
    const result = rewriteUrls('read https://example.com/docs now', () => undefined);

    expect(result.text).toBe('read https://example.com/docs now');
    expect(result.rewritten).toBe(0);
  });

  test('rewrites each url with its own replacement', () => {
    const result = rewriteUrls('https://a.dev and https://b.dev', (url) =>
      url.includes('a.dev') ? 'https://t.test/1' : 'https://t.test/2',
    );

    expect(result.text).toBe('https://t.test/1 and https://t.test/2');
    expect(result.rewritten).toBe(2);
  });

  test('leaves a body with no links untouched', () => {
    const result = rewriteUrls('no links here at all', () => 'https://t.test/x');

    expect(result.text).toBe('no links here at all');
    expect(result.rewritten).toBe(0);
  });
});

describe('classifyFetch', () => {
  const sentAt = new Date('2026-08-18T10:00:00.000Z');

  test('counts a normal browser as a person', () => {
    expect(
      classifyFetch({
        userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Safari/537.36',
        sentAt,
        fetchedAt: new Date('2026-08-18T10:40:00.000Z'),
      }),
    ).toBeUndefined();
  });

  test('names a self-identifying crawler', () => {
    expect(
      classifyFetch({
        userAgent: 'Mozilla/5.0 (compatible; SomeBot/1.0)',
        sentAt,
        fetchedAt: new Date('2026-08-18T10:40:00.000Z'),
      }),
    ).toBe('bot');
  });

  test('names a mail security scanner', () => {
    expect(
      classifyFetch({
        userAgent: 'Proofpoint URL Defense',
        sentAt,
        fetchedAt: new Date('2026-08-18T11:00:00.000Z'),
      }),
    ).toBe('bot');
  });

  test('treats an immediate fetch as a prefetch', () => {
    expect(
      classifyFetch({
        userAgent: 'Mozilla/5.0 Chrome/140',
        sentAt,
        fetchedAt: new Date(sentAt.getTime() + 2000),
      }),
    ).toBe('prefetch');
  });

  test('counts a fetch just outside the prefetch window', () => {
    expect(
      classifyFetch({
        userAgent: 'Mozilla/5.0 Chrome/140',
        sentAt,
        fetchedAt: new Date(sentAt.getTime() + (PREFETCH_WINDOW_SECONDS + 1) * 1000),
      }),
    ).toBeUndefined();
  });

  test('counts a missing user agent as a person', () => {
    // Privacy-minded clients strip it, and those are exactly this product's
    // audience — refusing to count them would bias the metric.
    expect(
      classifyFetch({ sentAt, fetchedAt: new Date('2026-08-18T10:40:00.000Z') }),
    ).toBeUndefined();
  });

  test('does not use the prefetch rule without a send time', () => {
    expect(classifyFetch({ userAgent: 'Chrome/140', fetchedAt: new Date() })).toBeUndefined();
  });

  test('ignores a clock that puts the fetch before the send', () => {
    expect(
      classifyFetch({
        userAgent: 'Chrome/140',
        sentAt,
        fetchedAt: new Date(sentAt.getTime() - 60_000),
      }),
    ).toBeUndefined();
  });
});

describe('trackedLinkUrl', () => {
  test('builds the redirect path', () => {
    expect(trackedLinkUrl('https://app.test', 'tok_1')).toBe('https://app.test/t/tok_1');
  });

  test('tolerates a trailing slash on the origin', () => {
    expect(trackedLinkUrl('https://app.test/', 'tok_1')).toBe('https://app.test/t/tok_1');
  });
});
