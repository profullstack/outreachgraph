/**
 * Turning an address into the page it points at.
 *
 * The tests that matter are the ones that must resolve to *nothing*. A wrong
 * publication URL costs one wasted fetch; a rule that sends every Gmail
 * address to google.com costs sixteen thousand fetches of a page about nobody,
 * and looks like the feature working.
 */

import { describe, expect, test } from 'bun:test';
import { presenceBreakdown, webPresenceFor } from './web-presence';

describe('publications', () => {
  test('a substack handle is that publication', () => {
    // Measured: 5,934 of one real 16,268-row list. The local part is the
    // subdomain, so the page is certain rather than guessed.
    expect(webPresenceFor('0xshah@substack.com')).toMatchObject({
      url: 'https://0xshah.substack.com',
      kind: 'publication',
    });
  });

  test('the other newsletter and blog hosts', () => {
    expect(webPresenceFor('nils@ghost.io')?.url).toBe('https://nils.ghost.io');
    expect(webPresenceFor('dave@medium.com')?.url).toBe('https://medium.com/@dave');
    expect(webPresenceFor('show@anchor.fm')?.url).toBe('https://anchor.fm/show');
    expect(webPresenceFor('news@beehiiv.com')?.url).toBe('https://news.beehiiv.com');
  });

  test('a local part that cannot be a subdomain resolves to nothing', () => {
    // `first.last@substack.com` is not `first.last.substack.com`; dots and
    // plus tags would build a hostname that does not exist.
    expect(webPresenceFor('first.last@substack.com')).toBeUndefined();
    expect(webPresenceFor('dave+news@substack.com')).toBeUndefined();
    expect(webPresenceFor('under_score@substack.com')).toBeUndefined();
  });

  test('the basis says where the page came from', () => {
    expect(webPresenceFor('pasta@substack.com')?.basis).toContain('publication handle');
  });
});

describe('company domains', () => {
  test('a company mailbox points at that company', () => {
    expect(webPresenceFor('dave@acme.io')).toMatchObject({
      url: 'https://acme.io',
      kind: 'company',
    });
  });

  test('a subdomain is kept, because that is where the mail lands', () => {
    expect(webPresenceFor('dave@eng.acme.io')?.url).toBe('https://eng.acme.io');
  });
});

describe('addresses that must point nowhere', () => {
  test('consumer mailboxes', () => {
    // The expensive mistake: 33% of the list. Crawling these would read
    // Google's homepage five thousand times.
    for (const email of [
      'dave@gmail.com',
      'dave@yahoo.com',
      'dave@hotmail.com',
      'dave@proton.me',
      'dave@icloud.com',
      'dave@outlook.com',
      'dave@qq.com',
    ]) {
      expect(webPresenceFor(email)).toBeUndefined();
    }
  });

  test('forwarders and mail hosts that are not the person', () => {
    // These look like company domains and are not: crawling them reads a
    // hosting company's marketing page.
    expect(webPresenceFor('x@agentmail.to')).toBeUndefined();
    expect(webPresenceFor('x@duck.com')).toBeUndefined();
    expect(webPresenceFor('x@privaterelay.appleid.com')).toBeUndefined();
    expect(webPresenceFor('x@fastmail.com')).toBeUndefined();
  });

  test('malformed input', () => {
    expect(webPresenceFor('not-an-address')).toBeUndefined();
    expect(webPresenceFor('@nolocal.com')).toBeUndefined();
    expect(webPresenceFor('dave@nodot')).toBeUndefined();
  });
});

describe('presenceBreakdown', () => {
  test('says what a list will actually reach before anyone waits for it', () => {
    const breakdown = presenceBreakdown([
      '0xshah@substack.com',
      'nils@substack.com',
      'dave@acme.io',
      'someone@gmail.com',
      'other@gmail.com',
      'third@yahoo.com',
    ]);

    expect(breakdown).toEqual({ publication: 2, company: 1, none: 3 });
  });
});
