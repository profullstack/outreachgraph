/**
 * The guard is asymmetric on purpose.
 *
 * Dropping a real prospect loses one lead. Keeping a role account risks a
 * message addressed to "webmaster" and teaches the operator the queue is full
 * of junk. So these tests care most about two things: the observed junk is
 * caught, and no rule fires on a name a real person might have.
 */

import { describe, expect, test } from 'bun:test';
import { isLikelyRoleAccount, isPlausiblePersonName, splitPersonName } from './person-name';

describe('role accounts are not prospects', () => {
  test('the ones actually found in production', () => {
    // `webmaster` at hithisisbarcelona.com, `admin` at elysiantales.com.
    expect(isLikelyRoleAccount('webmaster')).toBe(true);
    expect(isLikelyRoleAccount('admin')).toBe(true);
  });

  test('mailbox words, however they are punctuated or cased', () => {
    for (const name of ['Support', 'INFO', 'no-reply', 'contact.us', 'Sales', 'help_desk']) {
      expect(isLikelyRoleAccount(name)).toBe(true);
    }
  });

  test('phrases made entirely of furniture', () => {
    expect(isLikelyRoleAccount('contact team')).toBe(true);
    expect(isLikelyRoleAccount('customer service')).toBe(true);
  });

  test('addresses and URLs are not names', () => {
    expect(isLikelyRoleAccount('hello@acme.com')).toBe(true);
    expect(isLikelyRoleAccount('https://acme.com/team')).toBe(true);
  });

  test('anything carrying a digit', () => {
    expect(isLikelyRoleAccount('user123')).toBe(true);
    expect(isLikelyRoleAccount('Team 42')).toBe(true);
  });

  test('a sentence the extractor mistook for a name', () => {
    expect(isLikelyRoleAccount('We are a small team based in Barcelona')).toBe(true);
  });

  test('empty and whitespace', () => {
    expect(isLikelyRoleAccount('')).toBe(true);
    expect(isLikelyRoleAccount('   ')).toBe(true);
  });

  test('a lowercase single token reads as a login, not a name', () => {
    expect(isLikelyRoleAccount('jsmith')).toBe(true);
    expect(isLikelyRoleAccount('bhavesh')).toBe(true);
  });
});

describe('real people are left alone', () => {
  test('ordinary names', () => {
    for (const name of [
      'Dana Whitfield',
      'Jeremy Singer-Vine',
      'Anita Asharee',
      "Siobhán O'Connor",
      'Ana María Ruiz Gómez',
      '王小明',
      'Nguyễn Thị Minh Khai',
    ]) {
      expect(isPlausiblePersonName(name)).toBe(true);
    }
  });

  /**
   * The rule is whole-string, never substring. A surname containing a role
   * word is a real surname, and this is the mistake that would quietly delete
   * real prospects.
   */
  test('names that merely contain a role word', () => {
    for (const name of [
      'Admina Kovač',
      'Contact Nguyen',
      'Bill Manager',
      'Grace Hopper',
      'Info Tanaka',
    ]) {
      expect(isPlausiblePersonName(name)).toBe(true);
    }
  });

  /**
   * A single *capitalised* token stays. Plenty of people go by one name, and
   * rejecting them is the over-reach this guard is written to avoid.
   */
  test('a capitalised mononym', () => {
    expect(isPlausiblePersonName('Prince')).toBe(true);
    expect(isPlausiblePersonName('Björk')).toBe(true);
  });

  test('a long-but-plausible full name', () => {
    expect(isPlausiblePersonName('Maria Fernanda de Souza Oliveira Lima')).toBe(true);
  });
});

/**
 * Splitting feeds address derivation, so a wrong split is not a cosmetic bug:
 * it produces a plausible-looking address belonging to nobody, which bounces
 * and is charged to our sending domain. Ambiguity therefore returns nothing.
 */
describe('splitting a display name', () => {
  test('the ordinary two-part case', () => {
    expect(splitPersonName('Jack Ellis')).toEqual({ firstName: 'jack', lastName: 'ellis' });
  });

  test('keeps a hyphenated given name whole', () => {
    expect(splitPersonName('Tuan-Anh Tran')).toEqual({ firstName: 'tuan-anh', lastName: 'tran' });
  });

  test('drops the middle rather than guessing at it', () => {
    expect(splitPersonName('Mary Anne Evans')).toEqual({ firstName: 'mary', lastName: 'evans' });
  });

  test('keeps a surname particle with the surname', () => {
    // "Beethoven" alone is the wrong surname, and so is the address built on it.
    expect(splitPersonName('Ludwig van Beethoven')).toEqual({
      firstName: 'ludwig',
      lastName: 'van beethoven',
    });
    expect(splitPersonName('Maria de la Cruz')).toEqual({
      firstName: 'maria',
      lastName: 'de la cruz',
    });
  });

  test('strips honorifics and post-nominals', () => {
    expect(splitPersonName('Dr. Jane Okafor')).toEqual({ firstName: 'jane', lastName: 'okafor' });
    expect(splitPersonName('John Smith Jr.')).toEqual({ firstName: 'john', lastName: 'smith' });
  });

  test('handles surname-first, written with a comma', () => {
    expect(splitPersonName('Okafor, Jane')).toEqual({ firstName: 'jane', lastName: 'okafor' });
  });

  test('a mononym has a first name and no surname', () => {
    expect(splitPersonName('Prince')).toEqual({ firstName: 'prince' });
  });

  test('a role account splits into nothing at all', () => {
    // `webmaster` was a real prospect in production. It has no first name.
    expect(splitPersonName('webmaster')).toBeUndefined();
    expect(splitPersonName('no-reply')).toBeUndefined();
    expect(splitPersonName('')).toBeUndefined();
  });

  test('every name the guard accepts yields a usable first name', () => {
    for (const name of ['Grace Hopper', 'Björk', 'Maria Fernanda de Souza Oliveira Lima']) {
      expect(splitPersonName(name)?.firstName).toBeTruthy();
    }
  });
});
