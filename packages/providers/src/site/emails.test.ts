import { describe, expect, test } from 'bun:test';
import { assignEmails, findEmails, matchesName, parseEmail } from './emails';

describe('parseEmail', () => {
  test('normalises and classifies', () => {
    expect(parseEmail('Jane.Okafor@Acme.com')?.address).toBe('jane.okafor@acme.com');
    expect(parseEmail('mailto:info@acme.com?subject=hi')?.address).toBe('info@acme.com');
    expect(parseEmail('info@acme.com')?.isRole).toBe(true);
    expect(parseEmail('jane@acme.com')?.isRole).toBe(false);
    // Punctuation in a role local part still reads as a role.
    expect(parseEmail('no-reply@acme.com')?.isRole).toBe(true);
  });

  test('rejects the things that look like addresses but are not', () => {
    expect(parseEmail('not an email')).toBeUndefined();
    expect(parseEmail('jane@example.com')).toBeUndefined();
    expect(parseEmail('@acme.com')).toBeUndefined();
    expect(parseEmail('jane@localhost')).toBeUndefined();
    // A filename swept out of a CSS url().
    expect(parseEmail('sprite@2x.png')).toBeUndefined();
    // A hashed id embedded in markup.
    expect(parseEmail('a1b2c3d4e5f60718@acme.com')).toBeUndefined();
  });

  /**
   * The address that reached production and was only caught by an SMTP server.
   *
   * `kontakt@assarchristian.se\\\` has an `@`, and its "domain" does contain a
   * dot, so every structural check above passed it. Three send attempts later
   * the provider answered `501 5.1.3 Bad recipient address syntax` and
   * autopilot gave up on the lead permanently — the failure count is per
   * recommendation and never resets.
   */
  test('rejects an address carrying characters no address may contain', () => {
    // Three literal trailing backslashes, written as escapes: a raw string
    // cannot end in one without escaping its own closing delimiter.
    expect(parseEmail('kontakt@assarchristian.se\\\\\\')).toBeUndefined();
    expect(parseEmail('jane@acme.com>')).toBeUndefined();
    expect(parseEmail('jane@acme,com')).toBeUndefined();
    expect(parseEmail('jane doe@acme.com')).toBeUndefined();
    expect(parseEmail('jane@-acme.com')).toBeUndefined();
    expect(parseEmail('jane@acme-.com')).toBeUndefined();
    expect(parseEmail('jane@@acme.com')).toBeUndefined();

    // The neighbours it must not take with it.
    expect(parseEmail("o'brien@acme.com")?.address).toBe("o'brien@acme.com");
    expect(parseEmail('jane+tag@acme.co.uk')?.address).toBe('jane+tag@acme.co.uk');
    expect(parseEmail('j@sub-domain.acme.com')?.address).toBe('j@sub-domain.acme.com');
    expect(parseEmail('a_b.c@xn--80ak6aa92e.com')?.address).toBe('a_b.c@xn--80ak6aa92e.com');
  });
});

describe('findEmails', () => {
  test('deliberate mailto links rank ahead of addresses in prose', () => {
    const html = `
      <p>Write to us at hello@acme.com or ring.</p>
      <a href="mailto:jane@acme.com">Jane</a>
    `;

    const found = findEmails(html);
    expect(found[0]?.address).toBe('jane@acme.com');
    expect(found.map((e) => e.address)).toContain('hello@acme.com');
  });

  test('script and style blocks are not mined for addresses', () => {
    const html = `
      <script>const tracking = "abc@segment.io";</script>
      <style>.x{background:url(sprite@2x.png)}</style>
      <p>jane@acme.com</p>
    `;

    expect(findEmails(html).map((e) => e.address)).toEqual(['jane@acme.com']);
  });

  test('the same address twice is one result', () => {
    const html = '<a href="mailto:jane@acme.com">a</a> jane@acme.com';
    expect(findEmails(html)).toHaveLength(1);
  });
});

describe('matchesName', () => {
  test('recognises the conventional shapes', () => {
    expect(matchesName('jane.okafor', 'Jane Okafor')).toBe(true);
    expect(matchesName('jokafor', 'Jane Okafor')).toBe(true);
    expect(matchesName('jane', 'Jane Okafor')).toBe(true);
    expect(matchesName('okafor', 'Jane Okafor')).toBe(true);
    expect(matchesName('okaforj', 'Jane Okafor')).toBe(true);
  });

  test('refuses matches too weak to send a named message on', () => {
    // One letter matches too many people.
    expect(matchesName('j', 'Jane Okafor')).toBe(false);
    expect(matchesName('sales', 'Jane Okafor')).toBe(false);
    expect(matchesName('bob', 'Jane Okafor')).toBe(false);
  });
});

describe('assignEmails', () => {
  test('splits personal addresses from the company inbox', () => {
    const found = findEmails(`
      <a href="mailto:jane.okafor@acme.com">Jane</a>
      <a href="mailto:info@acme.com">General</a>
    `);

    const assigned = assignEmails(found, ['Jane Okafor'], 'acme.com');

    expect(assigned.byPerson.get('Jane Okafor')).toBe('jane.okafor@acme.com');
    expect(assigned.companyEmail).toBe('info@acme.com');
  });

  test('an address on another domain belongs to neither', () => {
    const found = findEmails('<a href="mailto:jane@her-agency.com">Jane</a>');
    const assigned = assignEmails(found, ['Jane Okafor'], 'acme.com');

    expect(assigned.byPerson.size).toBe(0);
    expect(assigned.companyEmail).toBeUndefined();
  });

  test('a subdomain is the same company', () => {
    const found = findEmails('<a href="mailto:jane@mail.acme.com">Jane</a>');
    const assigned = assignEmails(found, ['Jane Okafor'], 'acme.com');

    expect(assigned.byPerson.get('Jane Okafor')).toBe('jane@mail.acme.com');
  });

  test('a personal address is never also handed to the company', () => {
    const found = findEmails('<a href="mailto:jane@acme.com">Jane</a>');
    const assigned = assignEmails(found, ['Jane Okafor'], 'acme.com');

    expect(assigned.byPerson.get('Jane Okafor')).toBe('jane@acme.com');
    expect(assigned.companyEmail).toBeUndefined();
  });

  test('a page naming nobody still yields the company inbox', () => {
    const found = findEmails('<a href="mailto:hello@acme.com">Say hi</a>');
    const assigned = assignEmails(found, [], 'acme.com');

    expect(assigned.companyEmail).toBe('hello@acme.com');
  });

  /**
   * A `mailto:` inside an escaped string — JSON embedded in a page — used to
   * capture its own escaping. The address survived validation and shipped.
   *
   * Worth keeping as its own case because the old behaviour was not simply
   * "returns nothing useful": it returned the corrupted address *first*, since
   * `mailto:` hits deliberately outrank prose, with the clean address second.
   * The right address was on the page the whole time and lost to its own
   * broken twin.
   */
  test('an escaped mailto does not carry its escaping into the address', () => {
    const html = String.raw`<a href=\"mailto:kontakt@assarchristian.se\\\">Kontakt</a>`;
    const found = findEmails(html);

    expect(found.map((e) => e.address)).toEqual(['kontakt@assarchristian.se']);
  });
});
