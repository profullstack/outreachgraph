/**
 * Is this string a person, or a mailbox wearing a person's shape?
 *
 * Crawling a company site scrapes names out of prose, markup and JSON-LD, and
 * some of what comes back is not a human at all. Production held `webmaster`
 * (twice, at one company), `admin`, and other role accounts stored as people —
 * enriched, scored, and sitting in the approval queue as prospects. Left
 * alone, the fix that gave untitled people a signal would have turned each of
 * them into an outbound card, so a real message would eventually have gone to
 * a real inbox addressed to somebody called "webmaster".
 *
 * This is a guard, not a classifier. It answers "is this obviously not a
 * person" and defaults to yes-it-is-a-person, because the cost of the two
 * mistakes is not symmetric: dropping a real prospect loses one lead, while
 * keeping a role account risks an embarrassing message and, worse, teaches the
 * operator that the queue is full of junk. So every rule below fires only on
 * something a human name would not do.
 *
 * Deliberately not a completeness project. It does not attempt to validate
 * names — no length-of-surname rules, no alphabet restrictions, no "must have
 * two parts". Names are far too varied for that, and every such rule excludes
 * real people, disproportionately outside the anglosphere.
 */

/**
 * Mailbox and page-furniture words that are never a person's name.
 *
 * Matched against the whole normalised string, never as a substring: `Admin`
 * is rejected and `Admina Kovač` is not, `Contact` is rejected and `Contact
 * Nguyen` is not.
 */
const ROLE_WORDS = new Set([
  'webmaster',
  'admin',
  'administrator',
  'support',
  'info',
  'information',
  'contact',
  'contactus',
  'sales',
  'hello',
  'hi',
  'team',
  'staff',
  'office',
  'help',
  'helpdesk',
  'enquiries',
  'inquiries',
  'marketing',
  'press',
  'media',
  'careers',
  'jobs',
  'recruiting',
  'hr',
  'billing',
  'accounts',
  'accounting',
  'finance',
  'legal',
  'privacy',
  'security',
  'abuse',
  'postmaster',
  'noreply',
  'no-reply',
  'donotreply',
  'mail',
  'email',
  'newsletter',
  'subscribe',
  'unsubscribe',
  'blog',
  'news',
  'user',
  'users',
  'guest',
  'customer',
  'customers',
  'client',
  'clients',
  'service',
  'services',
  'general',
  'main',
  'home',
  'about',
  'login',
  'signup',
  'search',
  'menu',
  'anonymous',
  'unknown',
  'null',
  'undefined',
  'none',
  'test',
  'example',
  'company',
  'business',
  'owner',
  'manager',
  'editor',
  'author',
  'moderator',
  'bot',
]);

/** Collapsed whitespace, no surrounding punctuation, lowercased. */
function normalise(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .toLowerCase();
}

/**
 * True when a scraped string should not become a prospect.
 *
 * The rules, each firing only on something a real name would not do:
 *
 *   - Empty, or long enough to be a sentence rather than a name.
 *   - A role word, on its own or hyphen/dot-joined the way mailboxes are
 *     written (`no-reply`, `contact.us`).
 *   - Contains an `@`, a slash or a scheme — an address or a URL, not a name.
 *   - Contains a digit. Human names in company copy do not; `user123` and
 *     `Team 42` do.
 *   - A single all-lowercase token. A page that means a person capitalises
 *     them; `webmaster` and `jsmith` are written the way logins are. A single
 *     *capitalised* token is left alone, because plenty of people go by one
 *     name and rejecting them would be the exact over-reach this avoids.
 *   - More than six words, which is a sentence fragment the extractor mistook
 *     for a name.
 */
export function isLikelyRoleAccount(name: string): boolean {
  const cleaned = normalise(name);

  if (!cleaned) return true;
  if (cleaned.length > 80) return true;

  if (/[@/\\]|https?:/.test(cleaned)) return true;
  if (/\d/.test(cleaned)) return true;

  const words = cleaned.split(' ');
  if (words.length > 6) return true;

  // `no-reply`, `contact.us`, `info_desk` — one mailbox, punctuation-joined.
  const joined = cleaned.replace(/[.\-_]/g, '');
  if (ROLE_WORDS.has(cleaned) || ROLE_WORDS.has(joined)) return true;

  // Every part being a role word means the whole thing is furniture:
  // "contact team", "sales office".
  if (words.length > 1 && words.every((word) => ROLE_WORDS.has(word.replace(/[.\-_]/g, '')))) {
    return true;
  }

  if (words.length === 1) {
    const original = name.trim();
    // All-lowercase single token: written like a login, not like a name.
    if (original === original.toLowerCase() && /\p{Ll}/u.test(original)) return true;
  }

  return false;
}

/**
 * Honorifics and post-nominals, which belong to neither name part.
 *
 * Only the unambiguous ones. `Miss` is absent because it is also a surname,
 * and stripping it would rename a real person.
 */
const TITLES = new Set(['mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'professor', 'sir', 'dame']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'mba', 'esq']);

/**
 * Surname particles, which belong with the surname rather than starting it.
 *
 * "Ludwig van Beethoven" has the surname "van Beethoven", not "Beethoven", and
 * an address derived from the wrong half is simply a wrong address.
 */
const PARTICLES = new Set([
  'van',
  'von',
  'de',
  'del',
  'della',
  'der',
  'den',
  'di',
  'da',
  'do',
  'dos',
  'das',
  'du',
  'la',
  'le',
  'el',
  'al',
  'bin',
  'ibn',
  'ter',
  'ten',
  'op',
  'mac',
  'mc',
  'st',
]);

export interface SplitName {
  readonly firstName: string;
  /** Absent for mononyms. Plenty of people have exactly one name. */
  readonly lastName?: string;
}

/**
 * Splits a display name into the two parts an address pattern needs.
 *
 * Production stores the whole name in `display_name` and leaves `first_name`
 * and `last_name` null — 212 of 213 people. Nothing noticed, because nothing
 * needed the parts until deriving `jack@usefathom.com` from "Jack Ellis" did.
 *
 * Deliberately conservative, and the reason is asymmetry again: this feeds
 * address derivation, and a wrongly split name produces a plausible-looking
 * address for somebody who does not exist. So anything ambiguous returns
 * `undefined` rather than a guess, and a role account returns `undefined`
 * outright — `webmaster` has no first name to find.
 *
 * The middle is dropped rather than guessed at. "Mary Anne Evans" gives
 * `mary` / `evans`: the parts that address patterns actually use.
 */
export function splitPersonName(name: string): SplitName | undefined {
  if (isLikelyRoleAccount(name)) return undefined;

  const bare = (word: string): string => word.replace(/[.,]/g, '').toLowerCase();

  let words = normalise(name)
    .split(' ')
    .filter((word) => word.length > 0);

  // Strip honorifics from the front and post-nominals from the back, each
  // repeatedly: "Dr. Prof. Jane Okafor PhD" is one person, not four words.
  while (words.length > 1 && TITLES.has(bare(words[0] ?? ''))) words = words.slice(1);
  while (words.length > 1 && SUFFIXES.has(bare(words.at(-1) ?? ''))) words = words.slice(0, -1);

  // A comma means the surname was written first: "Okafor, Jane".
  const comma = name.indexOf(',');
  if (comma > 0 && !SUFFIXES.has(bare(name.slice(comma + 1)))) {
    const surname = normalise(name.slice(0, comma));
    const rest = normalise(name.slice(comma + 1)).split(' ')[0];
    if (surname && rest) return { firstName: rest, lastName: surname };
  }

  const first = words[0];
  if (!first) return undefined;
  if (words.length === 1) return { firstName: first };

  // Walk back over any particles so they stay attached to the surname.
  let start = words.length - 1;
  while (start > 1 && PARTICLES.has(bare(words[start - 1] ?? ''))) start -= 1;

  const lastName = words.slice(start).join(' ');
  return lastName ? { firstName: first, lastName } : { firstName: first };
}

/** The inverse, for readability at call sites that gate on the good case. */
export function isPlausiblePersonName(name: string): boolean {
  return !isLikelyRoleAccount(name);
}
