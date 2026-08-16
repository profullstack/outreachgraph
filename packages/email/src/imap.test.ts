/**
 * Telling a human reply from a machine's.
 *
 * This classification decides whether a prospect is removed from outreach for
 * good, so a false positive is expensive and silent: one out-of-office would
 * stop every future message to that person, and nobody goes looking for
 * outreach that never happened. A false negative merely means we mail someone
 * who answered, which is visible and recoverable.
 */

import { describe, expect, test } from 'bun:test';
import { classifyAutomated, parseHeaders } from './imap';

describe('parsing headers', () => {
  test('lowercases names and keeps values', () => {
    const headers = parseHeaders('Auto-Submitted: auto-replied\r\nPrecedence: bulk');

    expect(headers['auto-submitted']).toBe('auto-replied');
    expect(headers['precedence']).toBe('bulk');
  });

  test('unfolds a value continued on the next line', () => {
    // A folded value matches none of the checks below if it is read line by
    // line, which is how an auto-reply gets through as a real one.
    const headers = parseHeaders('X-Auto-Response-Suppress: DR,\r\n RN, NRN');

    expect(headers['x-auto-response-suppress']).toBe('DR, RN, NRN');
  });

  test('ignores a line with no colon', () => {
    expect(parseHeaders('not a header\r\nSubject: hi')['subject']).toBe('hi');
  });
});

describe('classifying a sender', () => {
  test('a plain human reply is not automated', () => {
    expect(classifyAutomated('jane@acme.com', { subject: 'Re: hello' })).toBeUndefined();
  });

  test('the null return path is a bounce', () => {
    expect(classifyAutomated('jane@acme.com', { 'return-path': '<>' })).toBe('bounce');
  });

  test('mailer-daemon is a bounce whatever the headers say', () => {
    expect(classifyAutomated('mailer-daemon@acme.com', {})).toBe('bounce');
    expect(classifyAutomated('postmaster@acme.com', {})).toBe('bounce');
  });

  test('no-reply addresses never represent a person', () => {
    for (const address of ['no-reply@x.com', 'noreply@x.com', 'donotreply@x.com']) {
      expect(classifyAutomated(address, {})).toBe('bounce');
    }
  });

  test('Auto-Submitted marks an auto-reply', () => {
    expect(classifyAutomated('jane@acme.com', { 'auto-submitted': 'auto-replied' })).toBe(
      'auto_reply',
    );
    expect(classifyAutomated('jane@acme.com', { 'auto-submitted': 'auto-generated' })).toBe(
      'auto_reply',
    );
  });

  test('Auto-Submitted: no is the one value that means a person wrote it', () => {
    // RFC 3834 requires ordinary mail to say `no` when it says anything, so
    // treating any present value as automated would skip real replies.
    expect(classifyAutomated('jane@acme.com', { 'auto-submitted': 'no' })).toBeUndefined();
    expect(classifyAutomated('jane@acme.com', { 'auto-submitted': 'No' })).toBeUndefined();
  });

  test('vendor auto-reply headers are honoured', () => {
    expect(classifyAutomated('jane@acme.com', { 'x-autoreply': 'yes' })).toBe('auto_reply');
    expect(classifyAutomated('jane@acme.com', { 'x-autorespond': 'yes' })).toBe('auto_reply');
    expect(classifyAutomated('jane@acme.com', { 'x-auto-response-suppress': 'OOF' })).toBe(
      'auto_reply',
    );
  });

  test('bulk and junk precedence are not replies', () => {
    expect(classifyAutomated('jane@acme.com', { precedence: 'bulk' })).toBe('bulk');
    expect(classifyAutomated('jane@acme.com', { precedence: 'junk' })).toBe('bulk');
  });

  test('a bounce outranks an auto-reply when both look true', () => {
    // Reported as the thing that needs the different follow-up.
    expect(classifyAutomated('mailer-daemon@acme.com', { 'auto-submitted': 'auto-replied' })).toBe(
      'bounce',
    );
  });
});
