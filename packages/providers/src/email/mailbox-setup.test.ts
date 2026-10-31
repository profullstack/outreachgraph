import { describe, expect, it } from 'bun:test';
import {
  checkSendingDomain,
  createSendingDomainCheckCache,
  lookupMailboxSettings,
  parseAutoconfig,
} from './mailbox-setup';

const AUTOCONFIG = `<?xml version="1.0"?>
<clientConfig version="1.1"><emailProvider id="example.net">
  <incomingServer type="pop3"><hostname>pop.example.net</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
  <incomingServer type="imap"><hostname>imap.example.net</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
  <outgoingServer type="smtp"><hostname>%EMAILDOMAIN%</hostname><port>25</port><socketType>PLAIN</socketType></outgoingServer>
  <outgoingServer type="smtp"><hostname>SMTP.example.net</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
</emailProvider></clientConfig>`;

function txtTable(table: Record<string, string[]>) {
  return async (name: string): Promise<string[][]> => {
    const rows = table[name];
    if (!rows) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return rows.map((row) => [row]);
  };
}

describe('parseAutoconfig', () => {
  it('takes the first usable IMAP and SMTP entries', () => {
    expect(parseAutoconfig(AUTOCONFIG)).toEqual({
      imap: { host: 'imap.example.net', port: 993, secure: true },
      smtp: { host: 'smtp.example.net', port: 587, secure: false },
    });
  });

  it('returns nothing for a document without servers', () => {
    expect(parseAutoconfig('<clientConfig/>')).toBeUndefined();
  });
});

describe('lookupMailboxSettings', () => {
  it('falls back to the MX provider’s autoconfig', async () => {
    const asked: string[] = [];
    const result = await lookupMailboxSettings('acme.com', {
      resolveMx: async () => [{ exchange: 'mx2.example.net.', priority: 20 }],
      fetchAutoconfig: async (domain) => {
        asked.push(domain);
        return domain === 'example.net' ? AUTOCONFIG : undefined;
      },
    });
    expect(asked).toEqual(['acme.com', 'example.net']);
    expect(result.mx).toEqual(['mx2.example.net']);
    expect(result.autoconfig?.imap?.host).toBe('imap.example.net');
  });

  it('survives DNS and ISPDB failures', async () => {
    const result = await lookupMailboxSettings('acme.com', {
      resolveMx: async () => {
        throw new Error('SERVFAIL');
      },
      fetchAutoconfig: async () => {
        throw new Error('offline');
      },
    });
    expect(result).toEqual({ domain: 'acme.com', mx: [] });
  });
});

describe('checkSendingDomain', () => {
  it('passes a domain with everything published', async () => {
    const report = await checkSendingDomain(
      'acme.com',
      { provider: 'gmail' },
      {
        resolveMx: async () => [{ exchange: 'aspmx.l.google.com', priority: 1 }],
        resolveTxt: txtTable({
          'acme.com': ['v=spf1 include:_spf.google.com ~all', 'google-site-verification=x'],
          '_dmarc.acme.com': ['v=DMARC1; p=none; rua=mailto:d@acme.com'],
          'google._domainkey.acme.com': ['v=DKIM1; k=rsa; p=MIIB'],
        }),
      },
    );
    expect(report.status).toBe('pass');
    expect(report.dkim.value).toBe('google._domainkey');
  });

  it('fails what is missing and says what to add', async () => {
    const report = await checkSendingDomain(
      'acme.com',
      { provider: 'microsoft' },
      { resolveMx: async () => [], resolveTxt: txtTable({}) },
    );
    expect(report.status).toBe('fail');
    expect(report.mx.status).toBe('fail');
    expect(report.spf.detail).toContain('include:spf.protection.outlook.com');
    expect(report.dmarc.detail).toContain('_dmarc.acme.com');
    expect(report.dkim.status).toBe('warn');
  });

  it('warns when SPF leaves out the sending provider, and fails two SPF records', async () => {
    const mx = async () => [{ exchange: 'mx1.forwardemail.net', priority: 10 }];
    const one = await checkSendingDomain(
      'acme.com',
      { provider: 'forwardemail' },
      {
        resolveMx: mx,
        resolveTxt: txtTable({
          'acme.com': ['v=spf1 include:_spf.google.com -all'],
          '_dmarc.acme.com': ['v=DMARC1; p=quarantine'],
        }),
      },
    );
    expect(one.spf.status).toBe('warn');
    expect(one.dkim.detail).toContain('Forward Email');

    const two = await checkSendingDomain(
      'acme.com',
      {},
      {
        resolveMx: mx,
        resolveTxt: txtTable({ 'acme.com': ['v=spf1 -all', 'v=spf1 include:x ~all'] }),
      },
    );
    expect(two.spf.status).toBe('fail');
  });

  it('verifies Forward Email’s per-domain DKIM selector through its API and public DNS', async () => {
    const selectorHost = 'fe-36190d4cf0._domainkey.profullstack.com';
    const report = await checkSendingDomain(
      'profullstack.com',
      { provider: 'forwardemail', forwardEmailApiToken: 'test-token' },
      {
        resolveMx: async () => [{ exchange: 'mx1.forwardemail.net', priority: 10 }],
        resolveTxt: txtTable({
          'profullstack.com': ['v=spf1 include:spf.forwardemail.net -all'],
          '_dmarc.profullstack.com': ['v=DMARC1; p=none'],
          [selectorHost]: ['v=DKIM1; k=rsa; p=MIIB'],
        }),
        fetchForwardEmailDkim: async (domain, token) => {
          expect(domain).toBe('profullstack.com');
          expect(token).toBe('test-token');
          return { selectorHost, verified: true };
        },
      },
    );

    expect(report.dkim.status).toBe('pass');
    expect(report.dkim.value).toBe('fe-36190d4cf0._domainkey');
    expect(report.dkim.detail).toContain('Forward Email verifies');
  });

  it('shares one Forward Email domain check across mailboxes on the same domain', async () => {
    const selectorHost = 'fe-36190d4cf0._domainkey.profullstack.com';
    const cache = createSendingDomainCheckCache();
    let mxLookups = 0;
    let selectorLookups = 0;
    let apiChecks = 0;
    const deps = {
      domainCheckCache: cache,
      resolveMx: async () => {
        mxLookups += 1;
        return [{ exchange: 'mx1.forwardemail.net', priority: 10 }];
      },
      resolveTxt: async (name: string) => {
        if (name === selectorHost) selectorLookups += 1;
        const records: Record<string, string[]> = {
          'profullstack.com': ['v=spf1 include:spf.forwardemail.net -all'],
          '_dmarc.profullstack.com': ['v=DMARC1; p=none'],
          [selectorHost]: ['v=DKIM1; k=rsa; p=MIIB'],
        };
        return records[name]?.map((record) => [record]) ?? [];
      },
      fetchForwardEmailDkim: async () => {
        apiChecks += 1;
        return { selectorHost, verified: true };
      },
    };
    const options = {
      provider: 'forwardemail',
      forwardEmailApiToken: 'test-token',
    };

    const [firstMailbox, secondMailbox] = await Promise.all([
      checkSendingDomain('profullstack.com', options, deps),
      checkSendingDomain('PROFULLSTACK.com', options, deps),
    ]);

    expect(firstMailbox.dkim.status).toBe('pass');
    expect(secondMailbox.dkim).toEqual(firstMailbox.dkim);
    expect(mxLookups).toBe(1);
    expect(selectorLookups).toBe(1);
    expect(apiChecks).toBe(1);
  });
});
