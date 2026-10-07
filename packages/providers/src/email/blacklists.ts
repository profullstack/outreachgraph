/**
 * Is the sending domain, or the server it sends from, on a public blocklist?
 *
 * The planner's deliverability check, run by the worker. Two kinds of list:
 *
 *   - **Domain lists** (Spamhaus DBL, SURBL, URIBL) are asked about the
 *     sending domain itself. These matter for every mailbox: a listed domain
 *     poisons mail from Gmail and Microsoft just as much as from a VPS.
 *   - **IP lists** (Spamhaus ZEN, SpamCop, Barracuda) are asked about the SMTP
 *     server's addresses. Only for self-hosted servers: Google's and
 *     Microsoft's sending IPs are shared by millions, and a listing there says
 *     nothing about this mailbox.
 *
 * A DNSBL answers with an A record in 127.0.0.0/8 when something is listed and
 * NXDOMAIN when it is not. Several also answer a *refusal* in that range —
 * Spamhaus returns 127.255.255.x to queries from public resolvers, URIBL
 * returns 127.0.0.1 — and a refusal read as a listing would stop a clean
 * mailbox. Each list's listing codes are therefore explicit; anything else is
 * "could not check", never "listed".
 */

import { resolve4 as nodeResolve4 } from 'node:dns/promises';

export interface BlacklistDeps {
  /** Injected so tests never touch the network. */
  readonly resolve4?: (name: string) => Promise<string[]>;
}

export type BlacklistVerdict = 'listed' | 'clean' | 'unknown';

export interface BlacklistResult {
  readonly list: string;
  /** What was looked up: the domain, or an IP. */
  readonly subject: string;
  readonly verdict: BlacklistVerdict;
  readonly code?: string;
}

export interface BlacklistReport {
  readonly results: readonly BlacklistResult[];
  /** The lists that named this mailbox, deduplicated. */
  readonly listedOn: readonly string[];
  readonly checkedAt: string;
}

interface ListSpec {
  readonly zone: string;
  readonly name: string;
  readonly listed: (code: string) => boolean;
}

const DOMAIN_LISTS: readonly ListSpec[] = [
  // 127.0.1.2-127.0.1.255 are listings; 127.255.255.x are refusals.
  { zone: 'dbl.spamhaus.org', name: 'Spamhaus DBL', listed: (c) => c.startsWith('127.0.1.') },
  // A bitmask in the last octet; bit 0 (value 1) is reserved/blocked.
  {
    zone: 'multi.surbl.org',
    name: 'SURBL',
    listed: (c) => c.startsWith('127.0.0.') && Number(c.split('.')[3]) > 1,
  },
  // 127.0.0.1 means the query was refused; 2, 4, 8 are listings.
  {
    zone: 'multi.uribl.com',
    name: 'URIBL',
    listed: (c) => ['127.0.0.2', '127.0.0.4', '127.0.0.8', '127.0.0.14'].includes(c),
  },
];

const IP_LISTS: readonly ListSpec[] = [
  {
    zone: 'zen.spamhaus.org',
    name: 'Spamhaus ZEN',
    listed: (c) => /^127\.0\.0\.(2|3|4|5|6|7|9|10|11)$/.test(c),
  },
  { zone: 'bl.spamcop.net', name: 'SpamCop', listed: (c) => c === '127.0.0.2' },
  { zone: 'b.barracudacentral.org', name: 'Barracuda', listed: (c) => c === '127.0.0.2' },
];

const TIMEOUT_MS = 4_000;
const NOT_LISTED = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

async function ask(
  resolve4: (name: string) => Promise<string[]>,
  query: string,
  spec: ListSpec,
  subject: string,
): Promise<BlacklistResult> {
  try {
    const answers = await Promise.race([
      resolve4(query),
      new Promise<string[]>((_, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })),
          TIMEOUT_MS,
        ).unref?.(),
      ),
    ]);
    const code = answers[0];
    if (!code) return { list: spec.name, subject, verdict: 'clean' };
    return {
      list: spec.name,
      subject,
      verdict: spec.listed(code) ? 'listed' : 'unknown',
      code,
    };
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    return { list: spec.name, subject, verdict: NOT_LISTED.has(code) ? 'clean' : 'unknown' };
  }
}

/** Reverses an IPv4 address for a DNSBL query: 1.2.3.4 -> 4.3.2.1. */
export function reverseIp(ip: string): string | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) {
    return undefined;
  }
  return parts.reverse().join('.');
}

const SHARED_PROVIDERS = new Set(['gmail', 'microsoft', 'zoho', 'fastmail', 'forwardemail']);

export async function checkBlacklists(
  input: {
    readonly domain: string;
    /** The SMTP host, checked by IP only for self-hosted servers. */
    readonly smtpHost?: string | null | undefined;
    readonly provider?: string | undefined;
  },
  deps: BlacklistDeps = {},
): Promise<BlacklistReport> {
  const resolve4 = deps.resolve4 ?? nodeResolve4;
  const domain = input.domain.trim().toLowerCase();

  const checks: Promise<BlacklistResult>[] = DOMAIN_LISTS.map((spec) =>
    ask(resolve4, `${domain}.${spec.zone}`, spec, domain),
  );

  if (input.smtpHost && !(input.provider && SHARED_PROVIDERS.has(input.provider))) {
    const ips = await resolve4(input.smtpHost).catch(() => [] as string[]);
    for (const ip of ips.slice(0, 3)) {
      const reversed = reverseIp(ip);
      if (!reversed) continue;
      for (const spec of IP_LISTS) checks.push(ask(resolve4, `${reversed}.${spec.zone}`, spec, ip));
    }
  }

  const results = await Promise.all(checks);
  const listedOn = [...new Set(results.filter((r) => r.verdict === 'listed').map((r) => r.list))];
  return { results, listedOn, checkedAt: new Date().toISOString() };
}
