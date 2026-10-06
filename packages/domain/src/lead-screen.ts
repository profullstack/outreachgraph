/**
 * Screening a lead list before anything is sent to it.
 *
 * The contact cleaner (`contact-import.ts`) decides whether a row has a
 * mailbox at all. This decides whether the mailbox is worth a message, and it
 * is deliberately a *flag* rather than a reject: a screened lead is stored,
 * shown with its reason, and held back from sending until a human says
 * otherwise. Dropping them would repeat the failure this exists to fix, where
 * a list shrank on import and nobody could say which rows went or why.
 *
 * Every rule here came out of a real list. A 6,960-address signup export held
 * generated names ("Borer853"), relay mailboxes that hide who is behind them
 * (passmail, aleeas, simplelogin), throwaway domains shared by a handful of
 * unrelated signups, agents and test accounts, and role inboxes. Mailing those
 * costs sender reputation and buys nothing.
 *
 * Pure functions over rows, so each rule can be argued with in a test.
 */

import { isDisposableDomain, isFreemailDomain } from './contact-import';

/** Why a lead is held back from sending. */
export const SCREEN_FLAGS = [
  'generated_name',
  'relay_address',
  'temp_mail_domain',
  'agent_account',
  'role_address',
] as const;
export type ScreenFlag = (typeof SCREEN_FLAGS)[number];

export interface ScreenFinding {
  readonly flag: ScreenFlag;
  /** One sentence a person can check, naming the value that tripped it. */
  readonly detail: string;
}

/** The columns screening reads. Everything but the address is optional. */
export interface ScreenRow {
  readonly email?: string | undefined;
  readonly name?: string | undefined;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly companyDomain?: string | undefined;
}

/**
 * Forwarding services whose whole point is that the address does not say who
 * is behind it. The person may be real; the mailbox tells you nothing about an
 * employer, and a reply-rate on a relay is a reply-rate on a filter.
 */
const RELAY_DOMAINS = new Set([
  'passmail.net',
  'passmail.com',
  'passinbox.com',
  'passfwd.com',
  'aleeas.com',
  'slmail.me',
  'mozmail.com',
  'duck.com',
  'addy.io',
  'anonaddy.com',
  'anonaddy.me',
  'hidingmail.com',
  'agentmail.to',
  '33mail.com',
  'privaterelay.appleid.com',
  'relay.firefox.com',
]);

/** Relay brands that register under several TLDs: simplelogin.com, .co, .io, .fr... */
const RELAY_BRANDS = ['simplelogin', 'anonaddy'];

/**
 * Temp-mail domains seen in our own lists that are not on the cleaner's
 * disposable list. The shared-domain rule below catches most of these on its
 * own; the ones here were seen with fewer than three signups.
 */
const TEMP_MAIL_DOMAINS = new Set(['maildock.store', 'fake.legal']);

/**
 * Mailbox hosts that are not companies, beyond the consumer webmail the
 * cleaner already knows: newsletter platforms (a substack.com address is a
 * publication, not a person at Substack) and regional webmail.
 */
const NOT_A_COMPANY = new Set([
  'substack.com',
  'mail.com',
  'yandex.com',
  'rambler.ru',
  'list.ru',
  'bk.ru',
  'inbox.ru',
  'wp.pl',
  'o2.pl',
  'interia.pl',
  'hotmail.fr',
  'hotmail.de',
  'hotmail.it',
  'hotmail.es',
  'outlook.de',
  'outlook.fr',
  'live.fr',
  'live.de',
  'yahoo.fr',
  'yahoo.de',
  'yahoo.es',
  'yahoo.it',
  'yahoo.ca',
  'yahoo.co.in',
  'yahoo.co.jp',
  'yahoo.com.br',
  'uol.com.br',
  'bol.com.br',
  'gmx.net',
  'gmx.at',
  'gmx.ch',
  'protonmail.ch',
  'tuta.io',
  'tutanota.de',
  'skiff.com',
  'zohomail.com',
]);

/**
 * Inboxes a team reads, not a person. Wider than the cleaner's list, which
 * only rejects mailboxes nobody reads at all: `sales@` is read, it is just not
 * somebody, and a cold message to it lands in a ticket queue.
 */
const ROLE_LOCALS = new Set([
  'info',
  'admin',
  'administrator',
  'support',
  'help',
  'helpdesk',
  'sales',
  'contact',
  'contacts',
  'hello',
  'hi',
  'hey',
  'team',
  'office',
  'mail',
  'email',
  'enquiries',
  'enquiry',
  'inquiries',
  'inquiry',
  'billing',
  'accounts',
  'accounting',
  'finance',
  'invoices',
  'jobs',
  'careers',
  'hr',
  'recruiting',
  'press',
  'media',
  'pr',
  'marketing',
  'legal',
  'privacy',
  'security',
  'compliance',
  'webmaster',
  'hostmaster',
  'it',
  'dev',
  'developers',
  'engineering',
  'ops',
  'feedback',
  'partners',
  'partnerships',
  'service',
  'customerservice',
  'orders',
  'shop',
  'store',
  'reception',
  'general',
]);

/** Words that mark an address or a name as a machine or a test, not a buyer. */
const AGENT_WORDS = new Set([
  'bot',
  'bots',
  'agent',
  'agents',
  'aiagent',
  'test',
  'tests',
  'testing',
  'tester',
  'qa',
  'demo',
  'dummy',
  'sandbox',
  'staging',
  'automation',
  'automated',
  'crawler',
  'scraper',
  'gpt',
  'chatgpt',
  'claude',
  'openclaw',
  'llm',
]);

const lower = (value: string | undefined): string => (value ?? '').trim().toLowerCase();

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1) : '';
}

function localOf(email: string): string {
  const at = email.lastIndexOf('@');
  return (at >= 0 ? email.slice(0, at) : email).split('+')[0] ?? '';
}

/** `slmail.me`, `x.simplelogin.fr`, `privaterelay.appleid.com`: a forwarding service. */
export function isRelayDomain(domain: string): boolean {
  const host = lower(domain);
  if (!host) return false;
  for (const relay of RELAY_DOMAINS) {
    if (host === relay || host.endsWith(`.${relay}`)) return true;
  }
  const labels = host.split('.');
  return labels.some((label) => RELAY_BRANDS.includes(label));
}

/**
 * True when an address at this domain says nothing about an employer:
 * consumer webmail, a relay, a throwaway, a newsletter platform.
 *
 * The one test every "is this a company?" question goes through, so a gmail
 * address is never crawled as if Google employed the lead, and a relay is
 * never looked up as a company page.
 */
export function isConsumerMailDomain(domain: string): boolean {
  const host = lower(domain).replace(/^www\./, '');
  if (!host) return true;
  return (
    isFreemailDomain(host) ||
    isDisposableDomain(host) ||
    NOT_A_COMPANY.has(host) ||
    TEMP_MAIL_DOMAINS.has(host) ||
    isRelayDomain(host)
  );
}

/** `info@`, `sales.team@`: an inbox a team reads. */
export function isRoleLocal(local: string): boolean {
  const bare = lower(local).replace(/\d+$/, '');
  if (ROLE_LOCALS.has(bare)) return true;
  const parts = bare.split(/[._-]+/).filter(Boolean);
  return parts.length > 0 && parts.every((part) => ROLE_LOCALS.has(part));
}

/**
 * A name a generator produced rather than a person typed.
 *
 * Seeded fake-data libraries suffix surnames with digits ("Borer853",
 * "Kuhic12"), and a person almost never puts a number in their own name.
 * Only letters-then-digits inside a name part counts: a handle like `dave2`
 * arriving in the email column is the cleaner's business, not this one's.
 */
export function generatedNamePart(row: ScreenRow): string | undefined {
  const parts = [row.firstName, row.lastName, ...(row.name ?? '').split(/\s+/)]
    .map((part) => (part ?? '').trim())
    .filter(Boolean);
  return parts.find((part) => /\p{L}{2,}\d{1,4}$/u.test(part) || /^\d+\p{L}+/u.test(part));
}

function agentWord(row: ScreenRow, local: string): string | undefined {
  const tokens = [
    ...local.split(/[._\-\d]+/),
    ...[row.name, row.firstName, row.lastName].flatMap((value) =>
      lower(value).split(/[\s._\-\d]+/),
    ),
  ].filter(Boolean);
  return tokens.find((token) => AGENT_WORDS.has(token));
}

/** Whether an address's local part reads as somebody's name. */
function nameLike(row: ScreenRow, local: string): boolean {
  const bare = lower(local).replace(/\d+$/, '');
  if (/^[a-z]{2,}[._-][a-z]{2,}$/.test(bare)) return true;
  const first = lower(row.firstName ?? row.name?.split(/\s+/)[0]);
  const last = lower(row.lastName ?? row.name?.split(/\s+/).slice(1).join(' '));
  return Boolean(
    (first.length >= 2 && bare.includes(first)) || (last.length >= 2 && bare.includes(last)),
  );
}

/** What the whole list says about each domain in it. */
export interface ScreenContext {
  readonly domains: ReadonlyMap<string, DomainStats>;
}

export interface DomainStats {
  /** Leads in the list at this domain. */
  readonly leads: number;
  /** Of those, how many name it as their company. */
  readonly claimed: number;
  /** Of those, how many have an address that reads as their name. */
  readonly nameLike: number;
}

/**
 * Counts the list by domain, once, so the shared-domain rule can see past the
 * row it is judging. Built over the *whole* list: a chunk of five hundred
 * would miss a temp-mail domain whose signups were spread across chunks.
 */
export function screenContext(rows: readonly ScreenRow[]): ScreenContext {
  const domains = new Map<string, { leads: number; claimed: number; nameLike: number }>();
  for (const row of rows) {
    const email = lower(row.email);
    const domain = domainOf(email);
    if (!domain) continue;
    const stats = domains.get(domain) ?? { leads: 0, claimed: 0, nameLike: 0 };
    stats.leads += 1;
    if (lower(row.companyDomain).replace(/^www\./, '') === domain) stats.claimed += 1;
    if (nameLike(row, localOf(email))) stats.nameLike += 1;
    domains.set(domain, stats);
  }
  return { domains };
}

/** Three unrelated signups at one obscure domain is a throwaway, not a company. */
export const SHARED_DOMAIN_MIN = 3;

/**
 * Every reason this lead should not be mailed, or none.
 *
 * Consumer webmail is not a flag: plenty of real buyers use gmail. It is only
 * never treated as their company (see `isConsumerMailDomain`).
 */
export function screenLead(row: ScreenRow, context?: ScreenContext): ScreenFinding[] {
  const email = lower(row.email);
  const domain = domainOf(email);
  const local = localOf(email);
  const findings: ScreenFinding[] = [];

  const generated = generatedNamePart(row);
  if (generated) {
    findings.push({
      flag: 'generated_name',
      detail: `the name "${generated}" carries digits, which a fake-data generator does and a person does not`,
    });
  }

  if (domain && isRelayDomain(domain)) {
    findings.push({
      flag: 'relay_address',
      detail: `${domain} is a forwarding relay that hides who is behind the address`,
    });
  }

  if (domain && TEMP_MAIL_DOMAINS.has(domain)) {
    findings.push({ flag: 'temp_mail_domain', detail: `${domain} is a temp-mail domain` });
  } else if (domain && !isConsumerMailDomain(domain) && context) {
    const stats = context.domains.get(domain);
    // Colleagues share a domain too. They differ from a throwaway in that
    // somebody names it as their company, or their addresses spell names.
    if (
      stats &&
      stats.leads >= SHARED_DOMAIN_MIN &&
      stats.claimed === 0 &&
      stats.nameLike * 2 < stats.leads
    ) {
      findings.push({
        flag: 'temp_mail_domain',
        detail:
          `${domain} is shared by ${stats.leads} leads in this list, none names it as their ` +
          'company and their addresses are not names: it looks like a temp-mail domain',
      });
    }
  }

  const agent = agentWord(row, local);
  if (agent) {
    findings.push({
      flag: 'agent_account',
      detail: `"${agent}" in the address or name marks a bot, agent or test account`,
    });
  }

  if (local && isRoleLocal(local)) {
    findings.push({
      flag: 'role_address',
      detail: `${local}@ is a team inbox, not a person`,
    });
  }

  return findings;
}

/** One line for a report cell: `relay_address: ...; role_address: ...`. */
export function describeFindings(findings: readonly ScreenFinding[]): string {
  return findings.map((finding) => `${finding.flag}: ${finding.detail}`).join('; ');
}

/** Parses stored findings, tolerating anything malformed as "none". */
export function parseFindings(json: string | null | undefined): ScreenFinding[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ScreenFinding =>
        Boolean(entry) &&
        typeof (entry as ScreenFinding).flag === 'string' &&
        typeof (entry as ScreenFinding).detail === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * `scott.perry@acme.com` -> Scott / Perry.
 *
 * Stricter than `nameFromEmail`, which only makes a display label: these go
 * into first_name and last_name, where a wrong value is a wrong greeting. Only
 * the unambiguous shape counts: exactly two alphabetic parts of two or more
 * letters joined by `.`, `_` or `-`, neither a role word. `jsmith`, `john.s`
 * and `john.smith42` say too little to be a name.
 */
export function nameFromAddress(
  email: string,
): { readonly firstName: string; readonly lastName: string } | undefined {
  const local = lower(email.slice(0, email.lastIndexOf('@'))).replace(/\+.*$/, '');
  const match = /^([a-z]{2,})[._-]([a-z]{2,})$/.exec(local);
  if (!match?.[1] || !match[2]) return undefined;
  if (ROLE_LOCALS.has(match[1]) || ROLE_LOCALS.has(match[2])) return undefined;
  if (AGENT_WORDS.has(match[1]) || AGENT_WORDS.has(match[2])) return undefined;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return { firstName: cap(match[1]), lastName: cap(match[2]) };
}
