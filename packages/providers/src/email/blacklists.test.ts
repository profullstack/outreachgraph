import { describe, expect, test } from 'bun:test';
import { checkBlacklists, reverseIp } from './blacklists';

/** A resolver answering from a table; anything missing is NXDOMAIN. */
function table(answers: Record<string, string[]>) {
  const asked: string[] = [];
  return {
    asked,
    resolve4: async (name: string): Promise<string[]> => {
      asked.push(name);
      const hit = answers[name];
      if (hit) return hit;
      throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    },
  };
}

describe('checkBlacklists', () => {
  test('a clean domain on a shared provider: domain lists only, no IP lookups', async () => {
    const dns = table({});
    const report = await checkBlacklists(
      { domain: 'acme.com', smtpHost: 'smtp.gmail.com', provider: 'gmail' },
      dns,
    );
    expect(report.listedOn).toEqual([]);
    expect(report.results.every((r) => r.verdict === 'clean')).toBe(true);
    expect(dns.asked.some((name) => name.includes('smtp.gmail.com'))).toBe(false);
  });

  test('a Spamhaus DBL listing is a listing; a public-resolver refusal is not', async () => {
    const listed = await checkBlacklists(
      { domain: 'spammy.example' },
      table({ 'spammy.example.dbl.spamhaus.org': ['127.0.1.2'] }),
    );
    expect(listed.listedOn).toEqual(['Spamhaus DBL']);

    const refused = await checkBlacklists(
      { domain: 'acme.com' },
      table({
        'acme.com.dbl.spamhaus.org': ['127.255.255.254'],
        'acme.com.multi.uribl.com': ['127.0.0.1'],
      }),
    );
    expect(refused.listedOn).toEqual([]);
    expect(refused.results.filter((r) => r.verdict === 'unknown').map((r) => r.list)).toEqual([
      'Spamhaus DBL',
      'URIBL',
    ]);
  });

  test('a self-hosted server is checked by IP', async () => {
    const report = await checkBlacklists(
      { domain: 'acme.com', smtpHost: 'mail.acme.com' },
      table({
        'mail.acme.com': ['203.0.113.7'],
        '7.113.0.203.zen.spamhaus.org': ['127.0.0.4'],
      }),
    );
    expect(report.listedOn).toEqual(['Spamhaus ZEN']);
  });

  test('reverseIp', () => {
    expect(reverseIp('1.2.3.4')).toBe('4.3.2.1');
    expect(reverseIp('::1')).toBeUndefined();
    expect(reverseIp('1.2.3.400')).toBeUndefined();
  });
});
