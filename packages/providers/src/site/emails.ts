/**
 * Contact addresses published on a company page.
 *
 * The product had no way to reach anyone. Every other stage worked — a URL
 * became a company, people, signals, a score and a drafted message — and then
 * stopped at a card, because nothing anywhere held an address to send it to.
 *
 * Two kinds of address come off a page and they are not interchangeable:
 *
 *   - A **personal** address belongs to someone the page names. `jane@acme.com`
 *     next to "Jane Okafor, Head of Ops" is that person, and a message that
 *     opens "Hi Jane" is correct.
 *   - A **role** address belongs to the company. Nobody named Jane reads
 *     `info@acme.com`, so a message sent there must not pretend otherwise.
 *
 * Conflating them is how automated outreach earns its reputation, so the two
 * are separated here and stay separated all the way to the send.
 */

/**
 * Local parts that are a function rather than a person.
 *
 * Deliberately generous: a false "this is a role address" costs a slightly
 * less personal greeting, while a false "this is a person" mails a named
 * stranger's greeting to a shared inbox.
 */
const ROLE_LOCAL_PARTS = new Set([
  'info',
  'hello',
  'hi',
  'contact',
  'contactus',
  'enquiries',
  'enquiry',
  'inquiries',
  'inquiry',
  'sales',
  'support',
  'help',
  'helpdesk',
  'service',
  'services',
  'customerservice',
  'admin',
  'administrator',
  'office',
  'team',
  'mail',
  'email',
  'general',
  'press',
  'media',
  'pr',
  'marketing',
  'jobs',
  'careers',
  'recruiting',
  'recruitment',
  'hr',
  'people',
  'billing',
  'accounts',
  'accounting',
  'finance',
  'invoices',
  'legal',
  'privacy',
  'security',
  'abuse',
  'compliance',
  'webmaster',
  'postmaster',
  'hostmaster',
  'noreply',
  'no-reply',
  'donotreply',
  'bounce',
  'bounces',
  'newsletter',
  'subscribe',
  'unsubscribe',
  'orders',
  'booking',
  'bookings',
  'reservations',
  'appointments',
  'partners',
  'partnerships',
  'investors',
  'ir',
]);

/**
 * Addresses that are never a prospect regardless of local part.
 *
 * Example domains and the placeholder addresses that ship inside templates
 * are on real pages far more often than anyone expects.
 */
const IGNORED_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'domain.com',
  'yourdomain.com',
  'email.com',
  'sentry.io',
  'wixpress.com',
  'squarespace.com',
]);

/** Extensions that mean this "address" was really a filename in a CSS url(). */
const FILE_SUFFIX = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|ico|pdf|mp4|webm)$/i;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export interface FoundEmail {
  readonly address: string;
  readonly localPart: string;
  readonly domain: string;
  /** True when the local part names a function rather than a human. */
  readonly isRole: boolean;
}

/** Normalises and validates one candidate address, or rejects it. */
export function parseEmail(raw: string): FoundEmail | undefined {
  const address = raw
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '')
    .split('?')[0];
  if (!address) return undefined;

  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return undefined;

  const localPart = address.slice(0, at);
  const domain = address.slice(at + 1);

  if (IGNORED_DOMAINS.has(domain)) return undefined;
  if (FILE_SUFFIX.test(domain)) return undefined;
  if (!domain.includes('.')) return undefined;
  // A local part that is entirely hex is almost always a tracking id or a
  // hashed address embedded in markup, not something a human reads.
  if (/^[0-9a-f]{16,}$/.test(localPart)) return undefined;

  return {
    address,
    localPart,
    domain,
    isRole:
      ROLE_LOCAL_PARTS.has(localPart.replace(/[._-]/g, '')) || ROLE_LOCAL_PARTS.has(localPart),
  };
}

/**
 * Every address on a page, `mailto:` links first.
 *
 * A `mailto:` is a deliberate publication — the site is asking to be written
 * to — whereas an address in prose might be quoted from somewhere else, so the
 * two are gathered separately and the deliberate ones rank first.
 */
export function findEmails(html: string): readonly FoundEmail[] {
  const seen = new Map<string, FoundEmail>();

  const add = (raw: string): void => {
    const parsed = parseEmail(raw);
    if (parsed && !seen.has(parsed.address)) seen.set(parsed.address, parsed);
  };

  for (const match of html.matchAll(/mailto:([^"'\s>)]+)/gi)) {
    if (match[1]) add(match[1]);
  }

  // The body text pass runs second so `mailto:` ordering survives. Script and
  // style blocks are dropped first: both are dense with strings that look like
  // addresses and are never contact details.
  const prose = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');

  for (const match of prose.matchAll(EMAIL_PATTERN)) add(match[0]);

  return [...seen.values()];
}

/**
 * Decides whether `address` belongs to `fullName`.
 *
 * Only the shapes a human would actually recognise count. `jane.okafor@`,
 * `jokafor@`, `jane@` and `okafor@` are all Jane Okafor; `j@` is not — a
 * single letter matches too many people to send a named message to.
 */
export function matchesName(localPart: string, fullName: string): boolean {
  const parts = fullName
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.replace(/[^a-z]/g, ''))
    .filter((part) => part.length > 1);

  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last) return false;

  const local = localPart.toLowerCase().replace(/[^a-z]/g, '');
  if (local.length < 3) return false;

  const candidates = new Set<string>([first, last, `${first}${last}`, `${last}${first}`]);
  if (first[0]) {
    candidates.add(`${first[0]}${last}`);
    candidates.add(`${last}${first[0]}`);
  }
  if (last[0]) candidates.add(`${first}${last[0]}`);

  return candidates.has(local);
}

export interface AssignedEmails {
  /** Personal addresses, keyed by the full name they were matched to. */
  readonly byPerson: ReadonlyMap<string, string>;
  /** The company's best role address, if the page published one. */
  readonly companyEmail?: string;
}

/**
 * Splits the addresses on a page between the people it names and the company.
 *
 * An address whose domain is not the company's is left alone entirely — it is
 * someone's agency, their personal Gmail in a bio, or a partner's contact, and
 * none of those is who this crawl is about.
 */
export function assignEmails(
  emails: readonly FoundEmail[],
  names: readonly string[],
  companyDomain?: string,
): AssignedEmails {
  const byPerson = new Map<string, string>();

  const onDomain = companyDomain
    ? emails.filter((email) => sharesRegistrableDomain(email.domain, companyDomain))
    : emails;

  for (const name of names) {
    const match = onDomain.find((email) => !email.isRole && matchesName(email.localPart, name));
    if (match && !byPerson.has(name)) byPerson.set(name, match.address);
  }

  const claimed = new Set(byPerson.values());
  // Role addresses in listed order: `findEmails` puts deliberate `mailto:`
  // links first, so the first survivor is the one the site most meant to give.
  const companyEmail = onDomain.find((email) => email.isRole && !claimed.has(email.address));

  return {
    byPerson,
    ...(companyEmail ? { companyEmail: companyEmail.address } : {}),
  };
}

/**
 * True when two hosts belong to the same site.
 *
 * `mail.acme.com` and `acme.com` are the same company; a naive equality test
 * drops perfectly good addresses published on a subdomain. This compares the
 * last two labels, which is wrong for `co.uk`-style suffixes in the strictest
 * sense but errs toward keeping an address rather than discarding one.
 */
function sharesRegistrableDomain(a: string, b: string): boolean {
  const tail = (host: string): string =>
    host
      .toLowerCase()
      .replace(/^www\./, '')
      .split('.')
      .slice(-2)
      .join('.');
  return tail(a) === tail(b);
}
