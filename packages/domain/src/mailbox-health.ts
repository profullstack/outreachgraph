/**
 * Mailboxes: telling a provider from an address, and a mailbox's health from
 * its numbers.
 *
 * The Mailboxes page asks two things of a person adding an address: the
 * address and its password. Everything else — which provider runs the domain,
 * the SMTP and IMAP hosts, the ports and TLS modes — is something we can work
 * out, and asking for it is how a connection ends up half-configured (the
 * mailbox that sent for two weeks and never read a reply had an SMTP host and
 * no IMAP host). These are the pure halves of that: the DNS lookups live in
 * `@outreachgraph/providers`, the rows in the pipeline.
 *
 * The health score is one number for a glance down a list of mailboxes. It is
 * explanation, not policy: nothing reads it to decide whether to send. The
 * bounce rule that does stop a mailbox lives in `sender-pool.ts` and is
 * unchanged.
 */

import { BOUNCE_MIN_SAMPLE, BOUNCE_THRESHOLD } from './sender-pool';

/** The providers a mailbox can be recognised as. Ids match `SMTP_PRESETS`. */
export const MAILBOX_PROVIDERS = [
  'gmail',
  'microsoft',
  'fastmail',
  'forwardemail',
  'zoho',
  'custom',
] as const;
export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];

/**
 * Which provider receives mail for a domain, from its MX hosts.
 *
 * MX rather than the domain name, because the domains that matter here are
 * company domains: `acme.com` on Google Workspace says nothing about Google
 * until you look at where its mail goes. Suffix matches on the exchange, so
 * `alt1.aspmx.l.google.com` and `aspmx.l.google.com` both read as Google.
 */
const MX_SUFFIXES: ReadonlyArray<readonly [string, MailboxProvider]> = [
  ['google.com', 'gmail'],
  ['googlemail.com', 'gmail'],
  ['outlook.com', 'microsoft'],
  ['protection.outlook.com', 'microsoft'],
  ['messagingengine.com', 'fastmail'],
  ['forwardemail.net', 'forwardemail'],
  ['zoho.com', 'zoho'],
  ['zoho.eu', 'zoho'],
  ['zoho.in', 'zoho'],
];

/** Consumer domains whose provider is known without a lookup. */
const KNOWN_DOMAINS: Readonly<Record<string, MailboxProvider>> = {
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
  'outlook.com': 'microsoft',
  'hotmail.com': 'microsoft',
  'live.com': 'microsoft',
  'msn.com': 'microsoft',
  'fastmail.com': 'fastmail',
  'fastmail.fm': 'fastmail',
  'zoho.com': 'zoho',
  'zohomail.com': 'zoho',
};

/** The domain of an address, lowercased, or undefined when it has none. */
export function mailboxDomain(email: string): string | undefined {
  const at = email.trim().lastIndexOf('@');
  if (at < 1) return undefined;
  const domain = email
    .trim()
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : undefined;
}

export function providerForDomain(domain: string): MailboxProvider | undefined {
  return KNOWN_DOMAINS[domain.toLowerCase()];
}

export function providerFromMx(exchanges: readonly string[]): MailboxProvider | undefined {
  for (const raw of exchanges) {
    const host = raw.toLowerCase().replace(/\.$/, '');
    for (const [suffix, provider] of MX_SUFFIXES) {
      if (host === suffix || host.endsWith(`.${suffix}`)) return provider;
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ health

export type BounceRisk = 'low' | 'medium' | 'high';

/**
 * How close a mailbox is to the bounce rule that would stop it.
 *
 * High at the threshold itself, medium from half of it. Below the minimum
 * sample a single bounce is noise, so the risk reads low until there is
 * enough sending to judge — the same reasoning the stop rule uses.
 */
export function bounceRisk(sends: number, bounces: number): BounceRisk {
  if (sends <= 0 || sends < BOUNCE_MIN_SAMPLE) return 'low';
  const rate = bounces / sends;
  if (rate >= BOUNCE_THRESHOLD) return 'high';
  if (rate >= BOUNCE_THRESHOLD / 2) return 'medium';
  return 'low';
}

export interface MailboxHealthInput {
  /** `active`, `paused`, `error` or `revoked`. */
  readonly status: string;
  readonly sends: number;
  readonly bounces: number;
  /** Whether an IMAP host is configured, so replies can be read at all. */
  readonly readsReplies: boolean;
  /** The last reply check failed. */
  readonly replyCheckFailed: boolean;
  /** Warm-up progress, 0 to 1; 1 when off or finished. */
  readonly warmupProgress: number;
}

export interface MailboxHealth {
  /** 0–100. */
  readonly score: number;
  readonly bounceRisk: BounceRisk;
  /** What is holding the score down, worst first, in words a human can act on. */
  readonly issues: readonly string[];
}

/**
 * One number for a mailbox, and the reasons it is not 100.
 *
 * Warm-up carries half of it, so a new mailbox climbs as it earns its volume
 * (the shape people expect from Swokei-style "health"). Everything else is a
 * deduction for something a human can fix: a stopped account, bounces, and
 * replies that cannot be read.
 */
export function mailboxHealth(input: MailboxHealthInput): MailboxHealth {
  const issues: string[] = [];
  const progress = Math.min(1, Math.max(0, input.warmupProgress));
  let score = 50 + Math.round(50 * progress);

  if (input.status === 'error' || input.status === 'revoked') {
    score -= 50;
    issues.push(input.status === 'revoked' ? 'Signed out: reconnect it' : 'Stopped: needs a look');
  }

  const risk = bounceRisk(input.sends, input.bounces);
  if (risk === 'high') {
    score -= 30;
    issues.push('Bounce rate is over 5%: clean the list');
  } else if (risk === 'medium') {
    score -= 15;
    issues.push('Bounce rate is climbing');
  }

  if (!input.readsReplies) {
    score -= 20;
    issues.push('Replies are not read: add IMAP');
  } else if (input.replyCheckFailed) {
    score -= 20;
    issues.push('Could not read the inbox on the last check');
  }

  if (progress < 1) issues.push('Warming up');

  return { score: Math.max(0, Math.min(100, score)), bounceRisk: risk, issues };
}
