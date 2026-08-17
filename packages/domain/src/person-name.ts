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

/** The inverse, for readability at call sites that gate on the good case. */
export function isPlausiblePersonName(name: string): boolean {
  return !isLikelyRoleAccount(name);
}
