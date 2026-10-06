import { describe, expect, test } from 'bun:test';
import {
  describeFindings,
  generatedNamePart,
  isConsumerMailDomain,
  isRelayDomain,
  isRoleLocal,
  nameFromAddress,
  parseFindings,
  screenContext,
  screenLead,
  type ScreenRow,
} from './lead-screen';
import { cleanContact } from './contact-import';

const flags = (row: ScreenRow, rows: readonly ScreenRow[] = [row]) =>
  screenLead(row, screenContext(rows)).map((finding) => finding.flag);

describe('screenLead', () => {
  test('a real person at a real company passes', () => {
    expect(
      flags({ email: 'ada.lovelace@acme.com', firstName: 'Ada', lastName: 'Lovelace' }),
    ).toEqual([]);
  });

  test('gmail is not a flag: real buyers use it', () => {
    expect(flags({ email: 'dave@gmail.com', name: 'Dave Mackenzie' })).toEqual([]);
  });

  test('a name with digits is generated', () => {
    expect(flags({ email: 'x1@acme.com', firstName: 'Jalen', lastName: 'Borer853' })).toContain(
      'generated_name',
    );
    expect(generatedNamePart({ name: 'Kuhic12 Lemke' })).toBe('Kuhic12');
    expect(generatedNamePart({ name: 'Mary-Jane Watson' })).toBeUndefined();
  });

  test('relay hosts are flagged, including every simplelogin TLD', () => {
    for (const domain of [
      'passmail.net',
      'passinbox.com',
      'passfwd.com',
      'aleeas.com',
      'simplelogin.com',
      'simplelogin.fr',
      'slmail.me',
      'mozmail.com',
      'duck.com',
      'addy.io',
      'anonaddy.me',
      'hidingmail.com',
      'agentmail.to',
    ]) {
      expect(isRelayDomain(domain)).toBe(true);
      expect(flags({ email: `someone@${domain}` })).toContain('relay_address');
    }
    expect(isRelayDomain('acme.com')).toBe(false);
  });

  test('known temp-mail domains are flagged on their own', () => {
    expect(flags({ email: 'abc@maildock.store' })).toContain('temp_mail_domain');
    expect(flags({ email: 'abc@fake.legal' })).toContain('temp_mail_domain');
  });

  test('three unrelated signups at one obscure domain is a temp-mail domain', () => {
    const rows = [
      { email: 'xk2p9@zzmail.biz' },
      { email: 'qq81l@zzmail.biz' },
      { email: 'mw0aa@zzmail.biz' },
    ];
    expect(flags(rows[0]!, rows)).toContain('temp_mail_domain');
    // Two is not enough to say.
    expect(flags(rows[0]!, rows.slice(0, 2))).not.toContain('temp_mail_domain');
  });

  test('colleagues at one company are not a temp-mail domain', () => {
    const named = [
      { email: 'ada.lovelace@acme.com' },
      { email: 'bob.ng@acme.com' },
      { email: 'cy.tan@acme.com' },
    ];
    expect(flags(named[0]!, named)).toEqual([]);

    const claimed = [
      { email: 'a1@acme.com', companyDomain: 'acme.com' },
      { email: 'b2@acme.com' },
      { email: 'c3@acme.com' },
    ];
    expect(flags(claimed[1]!, claimed)).not.toContain('temp_mail_domain');
  });

  test('agents, bots and test accounts are flagged', () => {
    expect(flags({ email: 'sales-bot@acme.com' })).toContain('agent_account');
    expect(flags({ email: 'qa.test3@acme.com' })).toContain('agent_account');
    expect(flags({ email: 'dana@acme.com', name: 'Dana Test' })).toContain('agent_account');
    expect(flags({ email: 'agentsmith@acme.com' })).not.toContain('agent_account');
  });

  test('role inboxes are flagged', () => {
    expect(flags({ email: 'info@acme.com' })).toContain('role_address');
    expect(flags({ email: 'sales.team@acme.com' })).toContain('role_address');
    expect(isRoleLocal('hello2')).toBe(true);
    expect(isRoleLocal('ada')).toBe(false);
  });

  test('findings explain themselves and survive storage', () => {
    const findings = screenLead({ email: 'info@passmail.net' });
    expect(describeFindings(findings)).toContain('relay_address: passmail.net');
    expect(parseFindings(JSON.stringify(findings))).toEqual(findings);
    expect(parseFindings('not json')).toEqual([]);
  });
});

describe('isConsumerMailDomain', () => {
  test('webmail, relays, temp mail and newsletter hosts are never a company', () => {
    for (const domain of ['gmail.com', 'substack.com', 'passmail.net', 'mailinator.com', 'qq.com'])
      expect(isConsumerMailDomain(domain)).toBe(true);
    expect(isConsumerMailDomain('acme.com')).toBe(false);
  });

  test('the importer never stores a webmail host as the company', () => {
    const result = cleanContact({ email: 'dave@acme.com', companyDomain: 'gmail.com' });
    expect(result.ok && result.contact.companyDomain).toBeFalsy();
  });
});

describe('nameFromAddress', () => {
  test('reads first.last, first_last and first-last', () => {
    expect(nameFromAddress('scott.perry@acme.com')).toEqual({
      firstName: 'Scott',
      lastName: 'Perry',
    });
    expect(nameFromAddress('gabriella_fiore@x.com')).toEqual({
      firstName: 'Gabriella',
      lastName: 'Fiore',
    });
    expect(nameFromAddress('ann-lee+news@x.com')).toEqual({ firstName: 'Ann', lastName: 'Lee' });
  });

  test('refuses what is not clearly a name', () => {
    for (const email of [
      'jsmith@x.com',
      'jordan.i@x.com',
      'john.smith42@x.com',
      'info.team@x.com',
      'sales.us@x.com',
      'a.b.c@x.com',
      'test.bot@x.com',
    ]) {
      expect(nameFromAddress(email)).toBeUndefined();
    }
  });
});
