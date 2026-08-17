/**
 * The guard is asymmetric on purpose.
 *
 * Dropping a real prospect loses one lead. Keeping a role account risks a
 * message addressed to "webmaster" and teaches the operator the queue is full
 * of junk. So these tests care most about two things: the observed junk is
 * caught, and no rule fires on a name a real person might have.
 */

import { describe, expect, test } from 'bun:test';
import { isLikelyRoleAccount, isPlausiblePersonName } from './person-name';

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
