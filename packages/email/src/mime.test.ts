/**
 * Reading a reply's words out of its raw source.
 *
 * The cases are the shapes mail clients actually send: a bare text body, a
 * `multipart/alternative` with an encoded plain part, HTML only, and a
 * delivery report whose only useful fact is who it was about.
 */

import { describe, expect, test } from 'bun:test';
import { failedRecipientFromSource, plainTextFromSource } from './mime';

describe('plainTextFromSource', () => {
  test('a plain message', () => {
    const raw = 'From: jane@acme.com\r\nSubject: Re: x\r\n\r\nSure, tell me more.\r\n';
    expect(plainTextFromSource(raw)).toBe('Sure, tell me more.');
  });

  test('multipart/alternative prefers the plain part and decodes it', () => {
    const raw = [
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Caf=C3=A9 at 3? Send pric=',
      'ing.',
      '--b1',
      'Content-Type: text/html',
      '',
      '<p>ignored</p>',
      '--b1--',
    ].join('\r\n');
    expect(plainTextFromSource(raw)).toBe('Café at 3? Send pricing.');
  });

  test('base64 plain text', () => {
    const encoded = Buffer.from('Interested — call me').toString('base64');
    const raw = `Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n\n${encoded}\n`;
    expect(plainTextFromSource(raw)).toBe('Interested — call me');
  });

  test('HTML only is de-tagged, and quoted history dropped', () => {
    const raw =
      'Content-Type: text/html\n\n<div>Yes please<br>Jane</div><blockquote>old thread</blockquote>';
    expect(plainTextFromSource(raw)).toBe('Yes please\nJane');
  });
});

describe('failedRecipientFromSource', () => {
  test('reads the RFC 3464 field', () => {
    const raw = 'Content-Type: message/delivery-status\n\nFinal-Recipient: rfc822; Jane@Acme.com\n';
    expect(failedRecipientFromSource(raw)).toBe('jane@acme.com');
  });

  test('falls back to X-Failed-Recipients', () => {
    expect(failedRecipientFromSource('X-Failed-Recipients: bob@acme.com\n\nbody')).toBe(
      'bob@acme.com',
    );
  });

  test('nothing to find', () => {
    expect(failedRecipientFromSource('Subject: hi\n\nhello')).toBeUndefined();
  });
});
