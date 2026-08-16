/**
 * What the user typed, and which path it starts.
 *
 * One box takes both "acme.com" and "dental practices in Austin", so something
 * has to decide which is which. That decision is deterministic and lives here
 * rather than being handed to the model: asking an LLM to classify its own
 * input adds a network call, a failure mode and a cost to a question that a
 * dot and a space already answer.
 */

/** A domain-shaped intake goes straight to the crawler; a phrase goes to discovery. */
export type IntakeKind = 'url' | 'keyword';

export interface ClassifiedIntake {
  readonly kind: IntakeKind;
  /**
   * For `url`, the bare hostname — lowercased, no scheme, no `www.`, no path.
   * For `keyword`, the trimmed phrase as typed.
   */
  readonly value: string;
  /** The original input, untouched, for showing back to whoever typed it. */
  readonly raw: string;
}

/**
 * Two-letter suffixes are accepted wholesale as country codes.
 *
 * Listing every ccTLD would be a maintenance burden for no benefit: the cost
 * of guessing wrong is one crawl of a host that does not resolve, which the
 * queue already reports as a failed job with the reason attached.
 */
const KNOWN_TLDS = new Set([
  'com',
  'net',
  'org',
  'edu',
  'gov',
  'mil',
  'int',
  'info',
  'biz',
  'io',
  'ai',
  'co',
  'dev',
  'app',
  'tech',
  'agency',
  'studio',
  'design',
  'digital',
  'online',
  'site',
  'shop',
  'store',
  'cloud',
  'health',
  'care',
  'clinic',
  'dental',
  'law',
  'legal',
  'finance',
  'capital',
  'ventures',
  'partners',
  'group',
  'company',
  'consulting',
  'services',
  'solutions',
  'systems',
  'software',
  'media',
  'news',
  'blog',
  'xyz',
  'me',
  'tv',
  'cc',
  'ltd',
  'llc',
  'inc',
  'plus',
  'life',
  'world',
  'global',
]);

function looksLikeTld(suffix: string): boolean {
  return suffix.length === 2 || KNOWN_TLDS.has(suffix);
}

/**
 * Reduces a URL or bare domain to its hostname, or returns nothing.
 *
 * Anything with a scheme is parsed properly; anything without one is only
 * treated as a host when it is a single token that ends in a plausible TLD.
 * "Acme Inc." has a dot and is not a domain, which is why the space matters.
 */
export function toHostname(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);

  // A non-http scheme is not something the crawler can fetch, and `mailto:` in
  // particular would otherwise slip through as a host.
  if (withScheme && !/^https?:\/\//i.test(trimmed)) return undefined;

  let host: string;

  if (withScheme) {
    try {
      host = new URL(trimmed).hostname;
    } catch {
      return undefined;
    }
  } else {
    // Allow a path on a bare domain — people paste `acme.com/about` constantly.
    const head = trimmed.split(/[/?#]/)[0] ?? '';
    if (!head || /\s/.test(head)) return undefined;
    host = head;
  }

  host = host
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');

  if (!host.includes('.')) return undefined;
  if (!/^[a-z0-9.-]+$/.test(host)) return undefined;
  if (host.startsWith('.') || host.startsWith('-') || host.includes('..')) return undefined;

  const labels = host.split('.');
  const suffix = labels[labels.length - 1] ?? '';
  if (!/^[a-z]+$/.test(suffix) || !looksLikeTld(suffix)) return undefined;
  if (labels.some((label) => label.length === 0)) return undefined;

  return host;
}

/**
 * Decides whether an intake is a company to crawl or a market to search for.
 *
 * The tie-break is deliberate: when something is domain-shaped it is treated
 * as a domain, because someone who types `acme.com` wanting a keyword search
 * for the string "acme.com" does not exist, while the reverse mistake — going
 * off to hallucinate companies named after a site the user already handed us —
 * would be both slower and wrong.
 */
export function classifyIntake(raw: string): ClassifiedIntake | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const host = toHostname(trimmed);
  if (host) return { kind: 'url', value: host, raw: trimmed };

  // Anything left is a description. A single word is still a valid market
  // ("dentists"), so there is no minimum beyond having some letters in it.
  if (!/[a-z]/i.test(trimmed)) return undefined;

  return { kind: 'keyword', value: trimmed.slice(0, 300), raw: trimmed };
}
