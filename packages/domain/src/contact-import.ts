/**
 * Cleaning a list of contacts on the way in.
 *
 * This is calibrated differently from `isLikelyRoleAccount`, and the
 * difference is the whole point. That function judges a name *scraped out of a
 * page*, where the prior is hostile: nobody put it there meaning "this is a
 * person", so a single lowercase token or a digit is good evidence of
 * furniture. An imported list is the opposite — every row is someone who typed
 * their own address into a signup form — so the same rules would delete real
 * users called `chovy` or `dave2`.
 *
 * So the strictness moves from the name to the address. A junk *name* is a
 * cosmetic problem on a real person and is repaired rather than rejected; a
 * junk *address* means there is no one to reach and the row is worthless. The
 * asset in a contact list is the mailbox.
 *
 * Everything here is a pure function over one row, so the rules can be argued
 * with in tests rather than discovered in production against seventeen
 * thousand records.
 */

/** Why a row was dropped. Stored per reject so an import explains itself. */
export type RejectReason =
  | 'no_email'
  | 'malformed_email'
  | 'undeliverable_domain'
  | 'disposable_domain'
  | 'role_address'
  | 'placeholder_address'
  | 'duplicate';

export interface RawContact {
  readonly email?: string | undefined;
  readonly name?: string | undefined;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly company?: string | undefined;
  readonly title?: string | undefined;
  readonly location?: string | undefined;
}

export interface CleanContact {
  readonly email: string;
  /** The key duplicates are judged on. Not what we send to. */
  readonly dedupeKey: string;
  readonly displayName: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly company?: string;
  readonly title?: string;
  readonly location?: string;
  readonly domain: string;
  /** True when the address is at a mailbox provider, not a company. */
  readonly freemail: boolean;
  /** Set when the supplied name was unusable and one was derived instead. */
  readonly nameDerived: boolean;
}

export type CleanResult =
  | { readonly ok: true; readonly contact: CleanContact }
  | { readonly ok: false; readonly reason: RejectReason; readonly detail: string };

/**
 * Mailboxes that exist to be thrown away.
 *
 * Kept short and to providers whose entire purpose is disposability. A long
 * blocklist scraped from the internet is a liability: it goes stale, and every
 * false positive here silently deletes a real person who happened to use a
 * small provider.
 */
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'sharklasers.com',
  '10minutemail.com',
  '10minutemail.net',
  'yopmail.com',
  'trashmail.com',
  'dispostable.com',
  'getnada.com',
  'maildrop.cc',
  'temp-mail.org',
  'tempmail.com',
  'throwawaymail.com',
  'fakeinbox.com',
  'mailnesia.com',
  'mytemp.email',
  'spam4.me',
  'byom.de',
  'discard.email',
]);

/**
 * Reserved by RFC 2606 and friends, plus the ones people type when they mean
 * "not a real address". A signup with one of these was never contactable.
 */
const UNDELIVERABLE_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'example.edu',
  'test.com',
  'test.org',
  'localhost',
  'domain.com',
  'email.com',
  'mail.com',
  'yourdomain.com',
  'company.com',
  'acme.com',
  'foo.com',
  'bar.com',
  'asdf.com',
  'none.com',
  'noemail.com',
  'no.com',
]);

/** TLDs that cannot resolve on the public internet. */
const UNDELIVERABLE_TLDS = new Set([
  'local',
  'localhost',
  'test',
  'invalid',
  'example',
  'internal',
]);

/**
 * Local parts that are a machine, not a person.
 *
 * Deliberately narrower than the role list used for scraping. `admin` and
 * `support` are excluded here on purpose: on a signup list they are frequently
 * a founder using their own domain, and dropping them loses exactly the sort
 * of user worth talking to. Only addresses that cannot receive a human reply
 * are rejected.
 */
const NON_HUMAN_LOCALS = new Set([
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'mailer-daemon',
  'mailerdaemon',
  'postmaster',
  'bounce',
  'bounces',
  'abuse',
  'devnull',
  'null',
  'undefined',
]);

/** Local parts that are somebody declining to give an address. */
const PLACEHOLDER_LOCALS = new Set([
  'test',
  'testing',
  'tester',
  'asdf',
  'asdfasdf',
  'qwerty',
  'abc',
  'abcd',
  'aaa',
  'aaaa',
  'xxx',
  'xxxx',
  'fake',
  'spam',
  'junk',
  'foo',
  'bar',
  'baz',
  'nobody',
  'noone',
  'none',
  'nothing',
  'anonymous',
  'unknown',
  'sample',
  'example',
  'user',
  'username',
  'email',
  'nope',
  'blah',
]);

const FREEMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'hotmail.com',
  'hotmail.co.uk',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.de',
  'mail.ru',
  'yandex.ru',
  'zoho.com',
  'fastmail.com',
  'hey.com',
  'tutanota.com',
]);

/**
 * Deliberately not RFC 5322. That grammar admits addresses no signup form
 * would ever produce, and implementing it faithfully accepts more junk than it
 * rejects. This is the shape of an address people actually type.
 */
const EMAIL_SHAPE = /^[^\s@,;:<>()[\]\\"]+@[^\s@,;:<>()[\]\\"]+$/;

/** Four or more of the same character running: `aaaa`, `zzzzzz`. */
const MASHED = /(.)\1{3,}/;

export function isFreemailDomain(domain: string): boolean {
  return FREEMAIL_DOMAINS.has(domain);
}

export function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(domain);
}

/**
 * Strips the parts of an address that do not change where mail lands.
 *
 * Gmail ignores dots and everything after a `+`, so `d.ave+news@gmail.com` and
 * `dave@gmail.com` are one mailbox and one person. Used only for spotting
 * duplicates — the address we store and send to is the one they gave us,
 * because a provider that *doesn't* do this would route the rewritten form
 * somewhere else or nowhere.
 */
export function emailDedupeKey(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const withoutTag = local.split('+')[0] ?? local;

  const canonical =
    domain === 'gmail.com' || domain === 'googlemail.com'
      ? withoutTag.replace(/\./g, '')
      : withoutTag;

  return `${canonical}@${domain}`;
}

/** Collapses whitespace and strips wrapping quotes a spreadsheet left behind. */
function tidy(value: string | undefined): string {
  return (value ?? '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a supplied name is not worth keeping.
 *
 * Note what is *not* here: single lowercase tokens and digits, both of which
 * `isLikelyRoleAccount` rejects. On a signup list those are `chovy` and
 * `dave2` — real people, typed by themselves.
 */
function isJunkName(name: string): boolean {
  const lower = name.toLowerCase();

  if (!lower) return true;
  if (lower.length > 80) return true;
  if (/[@/\\]|https?:/.test(lower)) return true;
  if (MASHED.test(lower)) return true;

  const words = lower.split(' ').filter(Boolean);

  // "test test", "asdf asdf", "fake name" — every part is filler.
  if (words.length > 0 && words.every((word) => PLACEHOLDER_LOCALS.has(word))) return true;

  // Purely punctuation or digits.
  if (!/\p{L}/u.test(name)) return true;

  return false;
}

/**
 * A display name from the address, for rows that arrived without a usable one.
 *
 * `dave.mackenzie@` becomes `Dave Mackenzie`; `dmack91@` stays `dmack91`,
 * because inventing a name from an opaque handle is worse than showing the
 * handle. Capitalising is only applied where the separator says the local part
 * really is words.
 */
export function nameFromEmail(email: string): string {
  const local = tidy(email.split('@')[0] ?? '');
  if (!local) return email;

  const parts = local
    .split(/[._-]+/)
    .filter(Boolean)
    .filter((part) => !/^\d+$/.test(part));

  if (parts.length < 2) return local;

  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

/**
 * Cleans one row, or explains why it cannot be used.
 *
 * `seen` carries the dedupe keys already accepted, so a duplicate inside the
 * file is caught in the same pass as everything else. It is mutated by the
 * caller rather than here, because deciding what counts as already-imported
 * needs the database and this stays pure.
 */
export function cleanContact(raw: RawContact, seen?: ReadonlySet<string>): CleanResult {
  const email = tidy(raw.email).toLowerCase();

  if (!email) return { ok: false, reason: 'no_email', detail: 'no address in the row' };

  if (!EMAIL_SHAPE.test(email)) {
    return { ok: false, reason: 'malformed_email', detail: `not an address: ${email}` };
  }

  const atIndex = email.lastIndexOf('@');
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);

  if (!domain.includes('.')) {
    return { ok: false, reason: 'undeliverable_domain', detail: `no public domain: ${domain}` };
  }

  const tld = domain.slice(domain.lastIndexOf('.') + 1);

  if (UNDELIVERABLE_TLDS.has(tld) || UNDELIVERABLE_DOMAINS.has(domain)) {
    return { ok: false, reason: 'undeliverable_domain', detail: `cannot receive mail: ${domain}` };
  }

  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { ok: false, reason: 'disposable_domain', detail: `throwaway mailbox: ${domain}` };
  }

  const bareLocal = local.split('+')[0] ?? local;

  if (NON_HUMAN_LOCALS.has(bareLocal)) {
    return { ok: false, reason: 'role_address', detail: `nobody reads ${bareLocal}@` };
  }

  // `test`, `test1`, `asdf99` — filler with an optional counter, which is what
  // a form gets when somebody wants past it rather than into it.
  const stripped = bareLocal.replace(/\d+$/, '');

  if (PLACEHOLDER_LOCALS.has(bareLocal) || PLACEHOLDER_LOCALS.has(stripped)) {
    return { ok: false, reason: 'placeholder_address', detail: `placeholder address: ${email}` };
  }

  if (MASHED.test(bareLocal)) {
    return { ok: false, reason: 'placeholder_address', detail: `keyboard mash: ${email}` };
  }

  const dedupeKey = emailDedupeKey(email);

  if (seen?.has(dedupeKey)) {
    return { ok: false, reason: 'duplicate', detail: `already in this import: ${dedupeKey}` };
  }

  const first = tidy(raw.firstName);
  const last = tidy(raw.lastName);
  const supplied = tidy(raw.name) || [first, last].filter(Boolean).join(' ');

  // A junk name is repaired, never fatal. The mailbox is the asset.
  const usable = supplied && !isJunkName(supplied);
  const displayName = usable ? supplied : nameFromEmail(email);

  return {
    ok: true,
    contact: {
      email,
      dedupeKey,
      displayName,
      ...(usable && first ? { firstName: first } : {}),
      ...(usable && last ? { lastName: last } : {}),
      ...(tidy(raw.company) ? { company: tidy(raw.company) } : {}),
      ...(tidy(raw.title) ? { title: tidy(raw.title) } : {}),
      ...(tidy(raw.location) ? { location: tidy(raw.location) } : {}),
      domain,
      freemail: FREEMAIL_DOMAINS.has(domain),
      nameDerived: !usable,
    },
  };
}

/**
 * Maps a spreadsheet's headers onto the fields we understand.
 *
 * Exported because the browser uses it to show a mapping before anything is
 * uploaded. Header names in the wild are `Email`, `email_address`, `E-Mail`
 * and `Primary Email`, and asking somebody to rename their columns first is
 * how an import feature goes unused.
 */
export function mapHeaders(headers: readonly string[]): Record<string, number> {
  const mapping: Record<string, number> = {};

  const match = (index: number, header: string): void => {
    const key = header.toLowerCase().replace(/[\s_-]+/g, '');

    const assign = (field: string): void => {
      if (mapping[field] === undefined) mapping[field] = index;
    };

    if (/^(e?mail(address)?|primaryemail|emailaddr)$/.test(key)) assign('email');
    else if (/^(first(name)?|givenname|forename)$/.test(key)) assign('firstName');
    else if (/^(last(name)?|surname|familyname)$/.test(key)) assign('lastName');
    else if (/^(name|fullname|displayname|contactname)$/.test(key)) assign('name');
    else if (/^(company|organi[sz]ation|employer|account)$/.test(key)) assign('company');
    else if (/^(title|jobtitle|role|position)$/.test(key)) assign('title');
    else if (/^(location|city|country|region)$/.test(key)) assign('location');
  };

  headers.forEach((header, index) => match(index, header));

  return mapping;
}
