import { describe, expect, test } from 'bun:test';
import { isNonBuyerDesk, refuseRecipient } from './recipient-guard';

const OWN = new Set(['ugig.net', 'coinpayportal.com']);

describe('refuseRecipient', () => {
  test('desks that file tickets are refused, however they are spelled', () => {
    for (const address of [
      'support@acme.com',
      'Support+EU@acme.com',
      'help.desk@acme.com',
      'abuse@host.example',
      'security@host.example',
      'no-reply@acme.com',
      'noreply-billing@acme.com',
    ]) {
      expect(isNonBuyerDesk(address)).toBe(true);
    }
  });

  test('the shared inboxes small companies actually read stay allowed', () => {
    for (const address of ['hello@acme.com', 'info@acme.com', 'sales@acme.com', 'jane@acme.com']) {
      expect(refuseRecipient(address, OWN)).toBeUndefined();
    }
  });

  test('the workspace’s own domains are never prospects, subdomains included', () => {
    expect(refuseRecipient('hello@ugig.net', OWN)).toContain('own products');
    expect(refuseRecipient('jane@mail.coinpayportal.com', OWN)).toContain('own products');
    expect(refuseRecipient('jane@notugig.net', OWN)).toBeUndefined();
  });

  test('says which desk it is', () => {
    expect(refuseRecipient('abuse@host.example', OWN)).toBe(
      'abuse@host.example is a abuse desk, not a buyer',
    );
  });
});
