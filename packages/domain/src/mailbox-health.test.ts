import { describe, expect, it } from 'bun:test';
import {
  bounceRisk,
  mailboxDomain,
  mailboxHealth,
  providerForDomain,
  providerFromMx,
} from './mailbox-health';

describe('mailboxDomain', () => {
  it('takes the part after the last @, lowercased', () => {
    expect(mailboxDomain('Ana@Acme.COM')).toBe('acme.com');
    expect(mailboxDomain(' sales@mail.acme.co.uk ')).toBe('mail.acme.co.uk');
  });

  it('refuses things that are not addresses', () => {
    expect(mailboxDomain('acme.com')).toBeUndefined();
    expect(mailboxDomain('@acme.com')).toBeUndefined();
    expect(mailboxDomain('ana@localhost')).toBeUndefined();
    expect(mailboxDomain('ana@acme..com')).toBeUndefined();
  });
});

describe('provider detection', () => {
  it('knows consumer domains without a lookup', () => {
    expect(providerForDomain('gmail.com')).toBe('gmail');
    expect(providerForDomain('Hotmail.com')).toBe('microsoft');
    expect(providerForDomain('acme.com')).toBeUndefined();
  });

  it('reads a company domain from where its mail goes', () => {
    expect(providerFromMx(['alt1.aspmx.l.google.com.'])).toBe('gmail');
    expect(providerFromMx(['acme-com.mail.protection.outlook.com'])).toBe('microsoft');
    expect(providerFromMx(['mx1.forwardemail.net'])).toBe('forwardemail');
    expect(providerFromMx(['in1-smtp.messagingengine.com'])).toBe('fastmail');
    expect(providerFromMx(['mx.zoho.eu'])).toBe('zoho');
  });

  it('does not match a suffix that only looks similar', () => {
    expect(providerFromMx(['mx.notgoogle.com'])).toBeUndefined();
    expect(providerFromMx(['mail.acme.com'])).toBeUndefined();
    expect(providerFromMx([])).toBeUndefined();
  });
});

describe('bounceRisk', () => {
  it('stays low below the minimum sample', () => {
    expect(bounceRisk(5, 3)).toBe('low');
    expect(bounceRisk(0, 0)).toBe('low');
  });

  it('rises from half the stop threshold', () => {
    expect(bounceRisk(100, 2)).toBe('low');
    expect(bounceRisk(100, 3)).toBe('medium');
    expect(bounceRisk(100, 5)).toBe('high');
  });
});

describe('mailboxHealth', () => {
  const healthy = {
    status: 'active',
    sends: 200,
    bounces: 0,
    readsReplies: true,
    replyCheckFailed: false,
    warmupProgress: 1,
  };

  it('is 100 with nothing wrong', () => {
    expect(mailboxHealth(healthy)).toEqual({ score: 100, bounceRisk: 'low', issues: [] });
  });

  it('climbs with warm-up', () => {
    expect(mailboxHealth({ ...healthy, warmupProgress: 0 }).score).toBe(50);
    expect(mailboxHealth({ ...healthy, warmupProgress: 0.5 }).score).toBe(75);
    expect(mailboxHealth({ ...healthy, warmupProgress: 0 }).issues).toContain('Warming up');
  });

  it('says why replies are a problem', () => {
    expect(mailboxHealth({ ...healthy, readsReplies: false }).issues[0]).toContain('IMAP');
    expect(mailboxHealth({ ...healthy, replyCheckFailed: true }).score).toBe(80);
  });

  it('never leaves 0..100', () => {
    const worst = mailboxHealth({
      status: 'revoked',
      sends: 100,
      bounces: 50,
      readsReplies: false,
      replyCheckFailed: true,
      warmupProgress: 0,
    });
    expect(worst.score).toBe(0);
    expect(worst.bounceRisk).toBe('high');
    expect(worst.issues[0]).toContain('reconnect');
  });
});
