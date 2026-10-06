/**
 * The DNS half of adding a mailbox: where a domain's mail goes, what its
 * autoconfig says, and whether it is set up to send cold email at all.
 *
 * Two questions, both asked of public DNS (and, for settings, Mozilla's
 * public ISPDB), never of the mailbox itself — logging in is the pipeline's
 * job and needs the password:
 *
 *   1. **What are this address's servers?** `lookupMailboxSettings` returns the
 *      MX hosts (the pipeline turns a known one into a preset) and, for a
 *      provider we do not know, the ISPDB's IMAP and SMTP entries.
 *   2. **Will its mail be trusted?** `checkSendingDomain` reads MX, SPF, DMARC
 *      and DKIM. Cold email from a domain without them lands in spam or is
 *      refused, whatever the copy says, and the person adding the mailbox is
 *      the one who can fix it.
 *
 * Every lookup is injectable so tests never touch the network, and every
 * failure degrades to "unknown" rather than throwing: a DNS timeout must not
 * stop someone connecting a mailbox.
 */

import { resolveMx as nodeResolveMx, resolveTxt as nodeResolveTxt } from 'node:dns/promises';

export interface MailboxDnsDeps {
  readonly resolveMx?: (
    domain: string,
  ) => Promise<ReadonlyArray<{ exchange: string; priority: number }>>;
  readonly resolveTxt?: (name: string) => Promise<string[][]>;
  /** Fetches the ISPDB document. Return undefined for "none". */
  readonly fetchAutoconfig?: (domain: string) => Promise<string | undefined>;
}

export interface ServerSettings {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS (465/993) rather than STARTTLS. */
  readonly secure: boolean;
}

export interface MailboxLookup {
  readonly domain: string;
  /** MX exchanges, lowest priority first, without the trailing dot. */
  readonly mx: readonly string[];
  /** From the ISPDB, when it knows the domain or its MX provider. */
  readonly autoconfig?: {
    readonly smtp?: ServerSettings;
    readonly imap?: ServerSettings;
  };
}

const ISPDB = 'https://autoconfig.thunderbird.net/v1.1/';
const LOOKUP_TIMEOUT_MS = 4_000;

export async function lookupMailboxSettings(
  domain: string,
  deps: MailboxDnsDeps = {},
): Promise<MailboxLookup> {
  const mx = await mxHosts(domain, deps);
  const fetchAutoconfig = deps.fetchAutoconfig ?? defaultFetchAutoconfig;

  // The ISPDB is keyed by the domain people sign in with, and also holds the
  // big hosting providers. A company domain is rarely in it, but the domain
  // its mail is handled by often is, so the MX's registrable domain is tried
  // second.
  const candidates = [domain, ...mx.map(registrableDomain)].filter(
    (value, index, all): value is string => Boolean(value) && all.indexOf(value) === index,
  );

  for (const candidate of candidates.slice(0, 3)) {
    const xml = await fetchAutoconfig(candidate).catch(() => undefined);
    const parsed = xml ? parseAutoconfig(xml) : undefined;
    if (parsed && (parsed.smtp || parsed.imap)) return { domain, mx, autoconfig: parsed };
  }

  return { domain, mx };
}

/**
 * The IMAP and SMTP entries from a Thunderbird autoconfig document.
 *
 * Regex rather than an XML parser: the format is small, stable and flat, and
 * the only thing taken from it is a hostname, a port and a socket type for
 * each of two servers. The first entry of each type wins, which is the order
 * the ISPDB lists its preferred configuration in.
 */
export function parseAutoconfig(
  xml: string,
): { smtp?: ServerSettings; imap?: ServerSettings } | undefined {
  const pick = (type: 'imap' | 'smtp'): ServerSettings | undefined => {
    const tag = type === 'imap' ? 'incomingServer' : 'outgoingServer';
    const pattern = new RegExp(`<${tag}[^>]*type="${type}"[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
    for (const match of xml.matchAll(pattern)) {
      const body = match[1] ?? '';
      const host = /<hostname>\s*([^<\s]+)\s*<\/hostname>/i.exec(body)?.[1];
      const port = Number(/<port>\s*(\d+)\s*<\/port>/i.exec(body)?.[1]);
      const socket = /<socketType>\s*([^<\s]+)\s*<\/socketType>/i.exec(body)?.[1]?.toUpperCase();
      // %EMAILDOMAIN% placeholders mean "the domain you typed"; a host we
      // would have to invent is not one we can vouch for.
      if (!host || host.includes('%') || !Number.isInteger(port) || port <= 0) continue;
      if (socket === 'PLAIN') continue;
      return { host: host.toLowerCase(), port, secure: socket === 'SSL' };
    }
    return undefined;
  };

  const smtp = pick('smtp');
  const imap = pick('imap');
  if (!smtp && !imap) return undefined;
  return { ...(smtp ? { smtp } : {}), ...(imap ? { imap } : {}) };
}

// --------------------------------------------------------------- deliverability

export type DnsStatus = 'pass' | 'warn' | 'fail';

export interface DnsCheck {
  readonly status: DnsStatus;
  /** The record as found, when there is one. */
  readonly value?: string;
  /** What it means, and what to do when it is not a pass. */
  readonly detail: string;
}

export interface SendingDomainReport {
  readonly domain: string;
  readonly mx: DnsCheck;
  readonly spf: DnsCheck;
  readonly dkim: DnsCheck;
  readonly dmarc: DnsCheck;
  /** Worst of the four. */
  readonly status: DnsStatus;
  readonly checkedAt: string;
}

/**
 * The SPF include each provider publishes. A domain whose SPF record does not
 * name its own sending provider fails SPF on every message it sends.
 */
const SPF_INCLUDES: Readonly<Record<string, string>> = {
  gmail: '_spf.google.com',
  microsoft: 'spf.protection.outlook.com',
  fastmail: 'spf.messagingengine.com',
  forwardemail: 'spf.forwardemail.net',
  zoho: 'zoho',
};

/**
 * DKIM selectors worth trying. DKIM lives at `<selector>._domainkey.<domain>`
 * and the selector is not discoverable from DNS, so the best a check can do is
 * try the ones providers use by default. A miss is therefore a warning, never
 * a failure: Forward Email, for one, issues a random `fe-…` selector per
 * domain that no list can contain.
 */
const DKIM_SELECTORS: Readonly<Record<string, readonly string[]>> = {
  gmail: ['google'],
  microsoft: ['selector1', 'selector2'],
  fastmail: ['fm1', 'fm2', 'fm3'],
  zoho: ['zmail', 'zoho'],
  forwardemail: [],
};
const COMMON_SELECTORS = [
  'default',
  'mail',
  'dkim',
  'k1',
  's1',
  's2',
  'smtp',
  'selector1',
  'google',
];

export async function checkSendingDomain(
  domain: string,
  options: { readonly provider?: string } = {},
  deps: MailboxDnsDeps = {},
): Promise<SendingDomainReport> {
  const resolveTxt = deps.resolveTxt ?? defaultResolveTxt;
  const txt = async (name: string): Promise<string[]> =>
    (await withTimeout(resolveTxt(name)).catch(() => [] as string[][])).map((chunks) =>
      chunks.join(''),
    );

  const [mxList, rootTxt, dmarcTxt] = await Promise.all([
    mxHosts(domain, deps),
    txt(domain),
    txt(`_dmarc.${domain}`),
  ]);

  const mx: DnsCheck =
    mxList.length > 0
      ? { status: 'pass', value: mxList.join(', '), detail: 'Replies have somewhere to land.' }
      : {
          status: 'fail',
          detail: 'No MX record: replies to this address bounce. Add your provider’s MX records.',
        };

  const spfRecords = rootTxt.filter((record) => /^v=spf1(\s|$)/i.test(record.trim()));
  const include = options.provider ? SPF_INCLUDES[options.provider] : undefined;
  const spf: DnsCheck =
    spfRecords.length === 0
      ? {
          status: 'fail',
          detail: `No SPF record. Add a TXT record on ${domain} such as "v=spf1 ${include ? `include:${include} ` : ''}~all".`,
        }
      : spfRecords.length > 1
        ? {
            status: 'fail',
            value: spfRecords.join(' | '),
            detail: 'More than one SPF record, which receivers treat as none. Merge them into one.',
          }
        : include && !spfRecords[0]!.toLowerCase().includes(include)
          ? {
              status: 'warn',
              value: spfRecords[0]!,
              detail: `SPF does not include ${include}, so mail from this mailbox may fail SPF.`,
            }
          : { status: 'pass', value: spfRecords[0]!, detail: 'Receivers can check who may send.' };

  const dmarcRecord = dmarcTxt.find((record) => /^v=DMARC1/i.test(record.trim()));
  const policy = dmarcRecord
    ? /;\s*p\s*=\s*(\w+)/i.exec(dmarcRecord)?.[1]?.toLowerCase()
    : undefined;
  const dmarc: DnsCheck = !dmarcRecord
    ? {
        status: 'fail',
        detail: `No DMARC record. Gmail and Yahoo require one from bulk senders; add a TXT record on _dmarc.${domain} such as "v=DMARC1; p=none; rua=mailto:dmarc@${domain}".`,
      }
    : policy === 'none'
      ? {
          status: 'pass',
          value: dmarcRecord,
          detail: 'Published (monitoring only, p=none). Enough for cold email.',
        }
      : { status: 'pass', value: dmarcRecord, detail: `Published, policy ${policy ?? 'set'}.` };

  const selectors = [
    ...(options.provider ? (DKIM_SELECTORS[options.provider] ?? []) : []),
    ...COMMON_SELECTORS,
  ].filter((value, index, all) => all.indexOf(value) === index);
  let dkimFound: { selector: string; record: string } | undefined;
  for (const selector of selectors) {
    const records = await txt(`${selector}._domainkey.${domain}`);
    const record = records.find((r) => /v=DKIM1|k=rsa|p=/i.test(r));
    if (record) {
      dkimFound = { selector, record };
      break;
    }
  }
  const dkim: DnsCheck = dkimFound
    ? {
        status: 'pass',
        value: `${dkimFound.selector}._domainkey`,
        detail: 'A signing key is published, so messages can be signed.',
      }
    : {
        status: 'warn',
        detail:
          options.provider === 'forwardemail'
            ? 'Forward Email uses its own selector, which cannot be looked up from outside. Check it is verified in Forward Email.'
            : 'No DKIM key under the usual selectors. Turn on DKIM signing in your mail provider, or ignore this if it uses a custom selector.',
      };

  const order: DnsStatus[] = ['pass', 'warn', 'fail'];
  const status = [mx, spf, dkim, dmarc].reduce<DnsStatus>(
    (worst, check) => (order.indexOf(check.status) > order.indexOf(worst) ? check.status : worst),
    'pass',
  );

  return { domain, mx, spf, dkim, dmarc, status, checkedAt: new Date().toISOString() };
}

// ------------------------------------------------------------------ plumbing

async function mxHosts(domain: string, deps: MailboxDnsDeps): Promise<string[]> {
  const resolveMx = deps.resolveMx ?? nodeResolveMx;
  const records = await withTimeout(resolveMx(domain)).catch(() => []);
  return [...records]
    .filter((record) => record.exchange && record.exchange !== '.')
    .sort((a, b) => a.priority - b.priority)
    .map((record) => record.exchange.replace(/\.$/, '').toLowerCase());
}

/** The last two labels, or three for the common two-level public suffixes. */
function registrableDomain(host: string): string {
  const labels = host.split('.');
  const twoLevel = /^(co|com|net|org|ac|gov)\.[a-z]{2}$/.test(labels.slice(-2).join('.'));
  return labels.slice(twoLevel ? -3 : -2).join('.');
}

function defaultResolveTxt(name: string): Promise<string[][]> {
  return nodeResolveTxt(name);
}

async function defaultFetchAutoconfig(domain: string): Promise<string | undefined> {
  // A fixed host with the domain as a path segment: nothing the user types can
  // send this request anywhere but Mozilla's ISPDB.
  const response = await fetch(`${ISPDB}${encodeURIComponent(domain)}`, {
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!response.ok) return undefined;
  return (await response.text()).slice(0, 64_000);
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('dns timeout')), LOOKUP_TIMEOUT_MS).unref?.(),
    ),
  ]);
}
