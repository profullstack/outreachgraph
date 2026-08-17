/**
 * Company address patterns, learned rather than guessed.
 *
 * The product cannot reach anyone. Every prospect in production has a name and
 * a company domain and no personal address, so every message falls back to the
 * company's shared inbox — which is what made one `support@` receive fourteen
 * messages, and what the address limits now correctly refuse.
 *
 * Crawling deeper does not fix it. `/team`, `/about` and `/contact` were read
 * for eight of these companies and every published address was a role mailbox;
 * modern SaaS simply does not put staff addresses on the marketing site. Nor is
 * scraping commit metadata an option: the addresses are public, but using them
 * for unsolicited mail is exactly what the platforms that publish them forbid.
 *
 * So the only honest routes are a licensed provider, or this — work out the
 * shape a company uses from an address already known to be right, and apply it
 * to a colleague. The distinction that makes it honest is between the two:
 *
 *   - **Deriving** from a *known* address is an inference with a stated basis.
 *     `jack@usefathom.com` being right makes `first@usefathom.com` the shape,
 *     and a colleague's address under that shape is a claim with evidence.
 *   - **Guessing** with no known address is a shot in the dark. It is offered
 *     here too, but ranked below and marked as such, because a wrong guess
 *     bounces — and bounces are charged to the sending domain's reputation,
 *     not to the guess.
 *
 * Nothing in this module decides to send anything. It proposes candidates; a
 * verifier or a human confirms one before it can ever be addressed.
 */

/** The shapes companies actually use, in rough order of how common they are. */
export const EMAIL_PATTERNS = [
  'first',
  'first.last',
  'firstlast',
  'flast',
  'first_last',
  'firstl',
  'last',
  'last.first',
  'f.last',
] as const;

export type EmailPattern = (typeof EMAIL_PATTERNS)[number];

export interface NameParts {
  readonly firstName: string;
  readonly lastName?: string;
}

/**
 * Strips a name to what can appear in a local part.
 *
 * Accents are folded rather than dropped — `Nijhof` and `Nijhöf` are the same
 * mailbox at every provider that matters, and dropping the character would
 * produce `nijhf`, an address belonging to nobody.
 */
function localise(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Renders one pattern for one name, or nothing when a part it needs is absent. */
export function applyPattern(
  pattern: EmailPattern,
  name: NameParts,
  domain: string,
): string | undefined {
  const first = localise(name.firstName);
  const last = name.lastName ? localise(name.lastName) : '';
  const host = domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');

  if (!first || !host) return undefined;
  // Every two-part pattern needs a surname. A mononym gets `first` and nothing
  // else, rather than an address with a hole where the surname should be.
  if (!last && pattern !== 'first' && pattern !== 'last') return undefined;

  const local = ((): string | undefined => {
    switch (pattern) {
      case 'first':
        return first;
      case 'last':
        return last || undefined;
      case 'first.last':
        return `${first}.${last}`;
      case 'firstlast':
        return `${first}${last}`;
      case 'flast':
        return `${first[0]}${last}`;
      case 'first_last':
        return `${first}_${last}`;
      case 'firstl':
        return `${first}${last[0]}`;
      case 'last.first':
        return `${last}.${first}`;
      case 'f.last':
        return `${first[0]}.${last}`;
    }
  })();

  return local ? `${local}@${host}` : undefined;
}

/**
 * Which pattern an address already known to be correct is written in.
 *
 * This is the learning step, and the whole reason the rest of the module is
 * worth having: one confirmed address at a company turns every colleague from
 * a guess into a derivation. Returns every pattern that reproduces the address,
 * because short names are genuinely ambiguous — `amy@acme.com` for Amy Ng is
 * both `first` and, if her surname were absent, nothing else. The caller keeps
 * them all rather than picking, so a second confirmed address can narrow it.
 */
export function inferPatterns(
  address: string,
  name: NameParts,
  domain: string,
): readonly EmailPattern[] {
  const target = address.trim().toLowerCase();
  return EMAIL_PATTERNS.filter((pattern) => applyPattern(pattern, name, domain) === target);
}

export interface AddressCandidate {
  readonly address: string;
  readonly pattern: EmailPattern;
  /**
   * True when the pattern was learned from a confirmed address at this domain,
   * false when it is only this module's prior about what companies tend to do.
   */
  readonly derived: boolean;
  /** 0..1. Never high enough on its own to make an address sendable. */
  readonly confidence: number;
}

/**
 * Every address this person plausibly has at this domain, best first.
 *
 * With a learned pattern the answer is usually one address and it is worth
 * something. Without one this is a ranked list of guesses, and the confidences
 * say so: the ceiling for an underived candidate is deliberately below any
 * threshold that would let it be used unattended.
 */
export function candidateAddresses(
  name: NameParts,
  domain: string,
  /** Patterns confirmed at this domain, from `inferPatterns`. */
  known: readonly EmailPattern[] = [],
): readonly AddressCandidate[] {
  const seen = new Set<string>();
  const out: AddressCandidate[] = [];

  const push = (pattern: EmailPattern, derived: boolean, confidence: number): void => {
    const address = applyPattern(pattern, name, domain);
    if (!address || seen.has(address)) return;
    seen.add(address);
    out.push({ address, pattern, derived, confidence });
  };

  // A single learned pattern is a strong claim; several mean the confirmed
  // address was ambiguous, so each is worth proportionally less.
  const share = known.length > 0 ? 0.8 / known.length + 0.1 : 0;
  for (const pattern of known) push(pattern, true, Math.min(0.9, share));

  // The priors. Capped well below anything the policy engine would act on
  // unattended — these are for a human to confirm, not for a machine to use.
  for (const [index, pattern] of EMAIL_PATTERNS.entries()) {
    push(pattern, false, Math.max(0.1, 0.35 - index * 0.03));
  }

  return out;
}
