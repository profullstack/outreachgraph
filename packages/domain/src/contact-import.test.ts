/**
 * The import rules.
 *
 * Two failure directions, and they are not symmetric. Letting junk through
 * costs a bounce and a little sender reputation. Rejecting a real user is
 * silent, permanent, and removes exactly the person who opted in — so the
 * false-positive tests below are the ones that matter most.
 */

import { describe, expect, test } from 'bun:test';
import {
  cleanContact,
  emailDedupeKey,
  isFreemailDomain,
  mapHeaders,
  nameFromEmail,
} from './contact-import';

function ok(email: string, rest: Record<string, string> = {}) {
  const result = cleanContact({ email, ...rest });
  if (!result.ok) throw new Error(`expected ${email} to be kept, got ${result.reason}`);
  return result.contact;
}

function rejected(email: string, rest: Record<string, string> = {}) {
  const result = cleanContact({ email, ...rest });
  if (result.ok) throw new Error(`expected ${email} to be rejected, it was kept`);
  return result;
}

describe('addresses that must be rejected', () => {
  test('an empty or malformed address', () => {
    expect(cleanContact({ email: '' }).ok).toBe(false);
    expect(rejected('not-an-address').reason).toBe('malformed_email');
    expect(rejected('two@at@signs.com is spaced').reason).toBe('malformed_email');
  });

  test('a domain that cannot receive mail', () => {
    expect(rejected('dave@example.com').reason).toBe('undeliverable_domain');
    expect(rejected('dave@localhost').reason).toBe('undeliverable_domain');
    expect(rejected('dave@myapp.local').reason).toBe('undeliverable_domain');
    expect(rejected('dave@nodot').reason).toBe('undeliverable_domain');
  });

  test('a throwaway mailbox', () => {
    expect(rejected('someone@mailinator.com').reason).toBe('disposable_domain');
    expect(rejected('someone@10minutemail.com').reason).toBe('disposable_domain');
  });

  test('an address no human reads', () => {
    expect(rejected('noreply@realcompany.com').reason).toBe('role_address');
    expect(rejected('mailer-daemon@realcompany.com').reason).toBe('role_address');
  });

  test('a placeholder somebody typed to get past the form', () => {
    expect(rejected('test@gmail.com').reason).toBe('placeholder_address');
    expect(rejected('test123@gmail.com').reason).toBe('placeholder_address');
    expect(rejected('asdf@gmail.com').reason).toBe('placeholder_address');
    expect(rejected('qwerty@gmail.com').reason).toBe('placeholder_address');
    expect(rejected('nobody@gmail.com').reason).toBe('placeholder_address');
  });

  test('keyboard mash', () => {
    expect(rejected('aaaaaa@gmail.com').reason).toBe('placeholder_address');
    expect(rejected('sdfffffgh@gmail.com').reason).toBe('placeholder_address');
  });
});

describe('real users that must survive', () => {
  // The expensive mistakes. Each of these is rejected by the *scraping* rules
  // in `isLikelyRoleAccount`, and each is a genuine person on a signup list.
  test('a single lowercase handle', () => {
    expect(ok('chovy@gmail.com', { name: 'chovy' }).displayName).toBe('chovy');
  });

  test('a name with a digit in it', () => {
    expect(ok('dave2@gmail.com', { name: 'dave2' }).displayName).toBe('dave2');
  });

  test('admin and support at their own domain', () => {
    // Frequently a founder. Dropping these loses the best users on the list.
    expect(ok('admin@theirstartup.com').email).toBe('admin@theirstartup.com');
    expect(ok('support@theirstartup.com').email).toBe('support@theirstartup.com');
  });

  test('freemail is completely normal for an app signup', () => {
    expect(ok('dave.mackenzie@gmail.com').freemail).toBe(true);
    expect(ok('dave@theircompany.com').freemail).toBe(false);
    expect(isFreemailDomain('proton.me')).toBe(true);
  });

  test('a plus tag is kept on the address we send to', () => {
    // Stripping it would send somewhere the provider may not route.
    expect(ok('dave+outreach@fastmail.com').email).toBe('dave+outreach@fastmail.com');
  });

  test('an address is lowercased and untrimmed of surrounding junk', () => {
    expect(ok('  "Dave@Example.IO" ').email).toBe('dave@example.io');
  });
});

describe('names', () => {
  test('a junk name is repaired rather than fatal', () => {
    // The mailbox is the asset; the name is cosmetic.
    const contact = ok('dave.mackenzie@corp.com', { name: 'asdf asdf' });

    expect(contact.nameDerived).toBe(true);
    expect(contact.displayName).toBe('Dave Mackenzie');
  });

  test('a missing name is derived from the address', () => {
    expect(nameFromEmail('dave.mackenzie@corp.com')).toBe('Dave Mackenzie');
    expect(nameFromEmail('dave_mackenzie@corp.com')).toBe('Dave Mackenzie');
  });

  test('an opaque handle is left alone rather than invented into a name', () => {
    expect(nameFromEmail('dmack91@corp.com')).toBe('dmack91');
  });

  test('first and last are combined when there is no full name', () => {
    const contact = ok('d@corp.com', { firstName: 'Dave', lastName: 'Mackenzie' });

    expect(contact.displayName).toBe('Dave Mackenzie');
    expect(contact.firstName).toBe('Dave');
  });

  test('a name that is a url or an address is not a name', () => {
    expect(ok('dave@corp.com', { name: 'https://corp.com' }).nameDerived).toBe(true);
    expect(ok('dave@corp.com', { name: 'dave@corp.com' }).nameDerived).toBe(true);
  });
});

describe('duplicates', () => {
  test('gmail dots and tags are one mailbox', () => {
    expect(emailDedupeKey('d.a.ve+news@gmail.com')).toBe('dave@gmail.com');
    expect(emailDedupeKey('dave@gmail.com')).toBe('dave@gmail.com');
  });

  test('dots are significant everywhere else', () => {
    // Only Gmail promises this. Assuming it universally merges two people.
    expect(emailDedupeKey('d.ave@fastmail.com')).toBe('d.ave@fastmail.com');
  });

  test('a repeat within the same file is caught', () => {
    const seen = new Set(['dave@gmail.com']);

    expect(cleanContact({ email: 'd.ave@gmail.com' }, seen)).toMatchObject({
      ok: false,
      reason: 'duplicate',
    });
  });
});

describe('mapHeaders', () => {
  test('finds the address column whatever it is called', () => {
    expect(mapHeaders(['Email'])).toEqual({ email: 0 });
    expect(mapHeaders(['E-Mail Address'])).toEqual({ email: 0 });
    expect(mapHeaders(['email_address'])).toEqual({ email: 0 });
    expect(mapHeaders(['Primary Email'])).toEqual({ email: 0 });
  });

  test('maps the columns an export actually has', () => {
    const mapping = mapHeaders(['id', 'First Name', 'Last Name', 'email', 'Company', 'Job Title']);

    expect(mapping).toMatchObject({ firstName: 1, lastName: 2, email: 3, company: 4, title: 5 });
    expect(mapping.id).toBeUndefined();
  });

  test('the first matching column wins', () => {
    expect(mapHeaders(['email', 'secondary email']).email).toBe(0);
  });
});
