/**
 * Working out *whose* profile a link is.
 *
 * This is the gap that made the product's premise not work. The extractor could
 * always recognise a link to X or LinkedIn, and `PersonCandidate.identities`
 * has always been stored — but the only thing that ever filled it was a JSON-LD
 * `Person` node carrying `sameAs`, which almost no site publishes. Production
 * bore that out exactly: 208 people, one social handle between them. Every
 * social link a team page offered was parsed, found to belong to nobody in
 * particular, and filed against the company.
 *
 * The missing evidence is not in the link. It is in where the link *sits*. A
 * team page is a list of cards, and a card keeps a person's name and their
 * links together:
 *
 *     <div class="member">
 *       <h3>Jane Okafor</h3><p>CTO</p>
 *       <a href="https://x.com/janeokafor">…</a>
 *       <a href="mailto:jane@acme.com">…</a>
 *     </div>
 *
 * So a link goes to the person whose name is *nearest* to it, and everything
 * else stays the company's.
 *
 * Nearest, rather than "the name that came before it" — which is what this did
 * first, and which a real page immediately disproved. Smashing Magazine wraps
 * each avatar in that person's profile link and carries the name in the image's
 * alt text, so the link comes *before* the name it belongs to:
 *
 *     <a href=https://twitter.com/aaronbeall><img alt="Aaron Beall"></a>
 *
 * Reading forwards from each name gave all 185 people the *next* person's
 * account — every single one wrong, and confidently so. Distance is indifferent
 * to which side the markup puts things on, and both layouts are common.
 *
 * Four guards keep it honest, because the failure to avoid is confidently
 * putting the company's own account on whichever employee sits nearest it:
 *
 *   - **Too far from every name is the company's.** Footer and navigation links
 *     are the common case.
 *   - **No clear winner is the company's.** Two names about equally close mean
 *     the markup cannot say, so it does not get to guess.
 *   - **Site furniture is always the company's**, however near a name lands.
 *   - **A handle claimed by two people is the company's.** One account cannot
 *     be two humans; repeated under every card it is a share button.
 *
 * What this deliberately does not do is guess from resemblance. A handle is
 * never attributed because it merely looks like somebody's name; resemblance
 * only ever *raises confidence* in a link that proximity already placed.
 */

import type { Network } from '@outreachgraph/domain';
import type { CandidateIdentity } from '../provider';
import { matchesName, parseEmail, type FoundEmail } from './emails';
import { anchors, isRelMe, labelName, networkForUrl } from './extract';

/**
 * How far from a name a link may sit and still be that person's.
 *
 * A card of markup — heading, title, a couple of icons — is a few hundred
 * characters. Beyond this the link is somewhere else on the page and the
 * proximity means nothing, which is what keeps the company's own accounts off
 * whoever happens to be listed nearby.
 */
const OWNERSHIP_WINDOW = 600;

/**
 * How close a name has to be *after* a link to claim it.
 *
 * This is a caption's distance, not a heading's. A name a few dozen characters
 * past a link is that link's label; a name several hundred characters past it is
 * the next card starting, and the link belongs to the card it is already in.
 */
const ADJACENT_WINDOW = 120;

/**
 * Regions that describe the site rather than any person on it.
 *
 * The character cap alone is not enough, and the first run of these tests
 * proved it: on a compact team page the footer sits well within 2000 characters
 * of the last person's name, so the company's own LinkedIn was handed to
 * whoever happened to be listed last. These elements are the page telling us
 * outright that their contents are site furniture, which is far better evidence
 * than a distance. A block stops at one, and anything inside one is the
 * company's no matter where it falls.
 */
const FURNITURE = /<(footer|nav|header|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

interface Range {
  readonly start: number;
  readonly end: number;
}

function furnitureRanges(html: string): Range[] {
  const ranges: Range[] = [];

  for (const match of html.matchAll(FURNITURE)) {
    if (match.index === undefined) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }

  return ranges;
}

function within(ranges: readonly Range[], index: number): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

/**
 * Confidence for a link found inside one person's block.
 *
 * These sit above 0.85 on purpose, and the reason is a trap rather than
 * optimism: `people.identity_confidence` is the **minimum** across a person's
 * identities, and the policy engine refuses outreach below
 * `workspaces.min_outreach_confidence` (0.85 by default). A social handle
 * stored at, say, 0.7 would therefore drag an otherwise contactable person
 * below the threshold — so discovering *more* about somebody would make them
 * unreachable, and adding this feature would have quietly switched off email
 * outreach for every person it succeeded on.
 *
 * The way out is not to inflate the number. It is to only attribute at all when
 * the evidence genuinely is this strong: the company published the link inside
 * that person's own card, and it appears nowhere else on the page. Anything
 * weaker stays with the company, where it costs nothing.
 */
const CONFIDENCE_WITH_NAME_MATCH = 0.92;
const CONFIDENCE_BLOCK_ONLY = 0.88;

/** Where one person's name appears in the markup. */
export interface NameHit {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/** Loose equality for two renderings of the same name. */
function sameName(a: string, b: string | undefined): boolean {
  if (!b) return false;
  const key = (value: string) => value.toLowerCase().replace(/[^a-z]/g, '');
  return key(a) === key(b);
}

/** Escapes a person's name for use inside a regular expression. */
function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every position a person's name appears at, ignoring site furniture.
 *
 * The parts are joined loosely because a card frequently splits a name across
 * markup — `<span>Jane</span> <span>Okafor</span>` — and a literal search would
 * miss it and lose the person entirely.
 */
export function nameHits(html: string, names: readonly string[]): NameHit[] {
  const furniture = furnitureRanges(html);
  const hits: NameHit[] = [];

  for (const name of names) {
    const parts = name.trim().split(/\s+/).filter(Boolean).map(escape);
    if (parts.length === 0) continue;

    // At least one separator between the parts, and a boundary either side.
    //
    // Allowing zero separators made a person's own handle match their name:
    // `x.com/janeokafor` satisfies /Jane…Okafor/ with nothing in between, which
    // put a phantom copy of the name on top of the very link it should have
    // been measured against. The boundaries stop "Jane Okafor" matching inside
    // "Mary Jane Okafor-Smith" for the same reason.
    const between = '(?:\\s|&nbsp;|&#160;|<[^>]{0,120}>){1,6}';
    const pattern = new RegExp(`(?<![\\w@.-])${parts.join(between)}(?![\\w-])`, 'gi');

    for (const match of html.matchAll(pattern)) {
      if (match.index === undefined) continue;
      // A name in the footer is a credit line, not a card.
      if (within(furniture, match.index)) continue;
      hits.push({ name, start: match.index, end: match.index + match[0].length });
    }
  }

  return hits.sort((a, b) => a.start - b.start);
}

/**
 * Whose name governs this offset.
 *
 * Two layouts dominate real pages and they run in opposite directions, so the
 * rule has to handle both:
 *
 *   1. **Card.** `<h3>Jane Okafor</h3> … <a href=…>` — the name comes first and
 *      owns everything until the next person is named.
 *   2. **Linked avatar.** `<a href=…><img alt="Aaron Beall"></a>` — the link
 *      comes first, with the name immediately after or inside the same tag.
 *
 * A pure "name that precedes it" rule gets (2) wrong by a whole person, and a
 * pure "nearest name" rule gets (1) wrong whenever the next card's heading is
 * closer than the current card's own — both were tried, and both were wrong on
 * real pages. So the preceding name governs by default, and a following name
 * only wins when it is *adjacent*: inside the same tag, or a few dozen
 * characters away, which is the signature of a caption rather than the start of
 * the next card.
 */
function governingName(
  html: string,
  hits: readonly NameHit[],
  index: number,
  span: number,
): string | undefined {
  let preceding: NameHit | undefined;
  let following: NameHit | undefined;

  for (const hit of hits) {
    if (hit.end <= index) preceding = hit;
    else if (!following && hit.start >= index) following = hit;
  }

  // A name inside the element itself — an image's alt text, a title attribute —
  // is as direct a statement of ownership as the markup offers.
  if (following && following.start < index + span) return following.name;

  const beforeDistance = preceding ? index - preceding.end : Infinity;
  const afterDistance = following ? following.start - index : Infinity;

  // A caption just past the link beats a heading further back — but only if
  // nothing structural separates them.
  //
  // Distance alone cannot tell a caption from the start of the next card, and
  // the fixture proves it: the next person's heading sits 82 characters after
  // the previous person's email link, closer than that person's own name 147
  // characters back. What actually separates them is the `</div><div>` between,
  // which a caption inside the same card never has.
  if (
    following &&
    afterDistance <= ADJACENT_WINDOW &&
    afterDistance < beforeDistance &&
    !crossesBoundary(html, index + span, following.start)
  ) {
    return following.name;
  }

  if (beforeDistance <= OWNERSHIP_WINDOW) return preceding?.name;

  return undefined;
}

/**
 * Elements that end one record and begin the next.
 *
 * Inline markup — a `<span>` around a caption, a `<br>`, an `<img>` — keeps a
 * link and a name in the same card. These do not.
 */
const RECORD_BOUNDARY = /<\/?(?:div|li|tr|td|article|section|ul|ol|table|main|dl|dd|dt)\b/i;

function crossesBoundary(html: string, from: number, to: number): boolean {
  if (to <= from) return false;
  return RECORD_BOUNDARY.test(html.slice(from, to));
}

interface LinkHit {
  readonly network: Network;
  readonly handle: string;
  readonly profileUrl: string;
  readonly index: number;
  /** Length of the whole element, so a name inside it counts as adjacent. */
  readonly span: number;
  /** The element's own label, when it names a person. */
  readonly label?: string;
  readonly relMe: boolean;
}

/**
 * Every network link on the page, with where it is.
 *
 * `extract.ts` already parses these but discards the offsets, and the offset is
 * the entire signal here.
 */
function scanLinks(html: string, handleOf: (url: string) => string | undefined): LinkHit[] {
  const hits: LinkHit[] = [];

  for (const anchor of anchors(html)) {
    const network = networkForUrl(anchor.href);
    if (!network) continue;

    const handle = handleOf(anchor.href);
    if (!handle) continue;

    hits.push({
      network,
      handle,
      profileUrl: anchor.href,
      index: anchor.index,
      span: anchor.element.length,
      ...(labelName(anchor.element) ? { label: labelName(anchor.element) } : {}),
      relMe: isRelMe(anchor.tag),
    });
  }

  return hits;
}

interface EmailHit {
  readonly found: FoundEmail;
  readonly index: number;
}

/** Every address on the page, with where it is. */
function scanEmails(html: string): EmailHit[] {
  const hits: EmailHit[] = [];
  const seen = new Set<string>();

  const add = (raw: string, index: number): void => {
    const found = parseEmail(raw);
    if (!found) return;
    const key = `${found.address}:${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ found, index });
  };

  for (const match of html.matchAll(/mailto:([^"'\s>)]+)/gi)) {
    if (match[1] !== undefined && match.index !== undefined) add(match[1], match.index);
  }

  for (const match of html.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
    if (match.index !== undefined) add(match[0], match.index);
  }

  return hits;
}

export interface AttributionResult {
  /** Handles belonging to one named person, keyed by that person's full name. */
  readonly identitiesByPerson: ReadonlyMap<string, readonly CandidateIdentity[]>;
  /** Personal addresses, keyed by full name. Role addresses are never here. */
  readonly emailsByPerson: ReadonlyMap<string, string>;
  /** Everything the page published that belongs to nobody in particular. */
  readonly companyIdentities: readonly CandidateIdentity[];
}

export interface AttributeOptions {
  readonly html: string;
  readonly people: readonly string[];
  /** Injected so this module does not duplicate `extract.ts`'s handle rules. */
  readonly handleOf: (url: string) => string | undefined;
}

/**
 * Splits a page's links and addresses between its people and the company.
 *
 * The company keeps anything ambiguous. That asymmetry is deliberate: a
 * company-level link that was really someone's personal account costs a little
 * recall, while a personal-level link that was really the company's would put a
 * named human's outreach on the wrong account entirely.
 */
export function attributeToPeople(options: AttributeOptions): AttributionResult {
  const { html, people, handleOf } = options;

  const hits = nameHits(html, people);
  const furniture = furnitureRanges(html);
  const links = scanLinks(html, handleOf);
  const emails = scanEmails(html);

  /** Site furniture belongs to the company however close a name happens to be. */
  const owns = (index: number, span = 0, label?: string): string | undefined => {
    if (within(furniture, index)) return undefined;

    const governing = governingName(html, hits, index, span);

    // The element's own label is the authority on whose link it is.
    //
    // Smashing Magazine lists 185 contributors as linked portraits, and the
    // model names only some of them. For a link whose portrait is captioned
    // with somebody we were never told about, the nearest *known* name is the
    // person listed before them — so without this every unknown contributor's
    // account was handed to the previous one.
    if (label) return sameName(label, governing) ? governing : undefined;

    return governing;
  };

  const companyIdentities = new Map<string, CandidateIdentity>();
  const identitiesByPerson = new Map<string, CandidateIdentity[]>();
  const emailsByPerson = new Map<string, string>();

  // ------------------------------------------------------------------ links
  //
  // Grouped by identity first, because the decision is about the identity as a
  // whole: one that turns up under two people, or once inside a card and again
  // in the footer, is the company's however good any single placement looked.
  const byIdentity = new Map<string, LinkHit[]>();
  for (const hit of links) {
    const key = `${hit.network}:${hit.handle.toLowerCase()}`;
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), hit]);
  }

  for (const [key, hits] of byIdentity) {
    const first = hits[0];
    if (!first) continue;

    const owners = new Set<string>();
    let unowned = false;

    for (const hit of hits) {
      const owner = owns(hit.index, hit.span, hit.label);
      if (owner) owners.add(owner);
      else unowned = true;
    }

    const owner = owners.size === 1 ? [...owners][0] : undefined;

    // Either guard failing sends it to the company.
    if (!owner || unowned) {
      companyIdentities.set(key, {
        network: first.network,
        handle: first.handle,
        profileUrl: first.profileUrl,
        providerConfidence: hits.some((hit) => hit.relMe) ? 0.9 : 0.6,
      });
      continue;
    }

    const named = matchesName(first.handle, owner);

    identitiesByPerson.set(owner, [
      ...(identitiesByPerson.get(owner) ?? []),
      {
        network: first.network,
        handle: first.handle,
        profileUrl: first.profileUrl,
        providerConfidence:
          named || hits.some((hit) => hit.relMe)
            ? CONFIDENCE_WITH_NAME_MATCH
            : CONFIDENCE_BLOCK_ONLY,
      },
    ]);
  }

  // ----------------------------------------------------------------- emails
  //
  // The same rule, and it matters as much: matching `jane@acme.com` to "Jane
  // Okafor" by name is the only mechanism there has ever been, and production
  // has zero personal addresses to show for it. Plenty of sites publish
  // `j.okafor@`, `jane.o@`, or an address that looks nothing like the person —
  // all of which sit inside that person's card and say exactly whose they are.
  const byAddress = new Map<string, EmailHit[]>();
  for (const hit of emails) {
    byAddress.set(hit.found.address, [...(byAddress.get(hit.found.address) ?? []), hit]);
  }

  for (const [address, hits] of byAddress) {
    const first = hits[0];
    // A role address is the company's by definition — nobody named Jane reads
    // `info@`, and greeting a shared inbox by a person's name is worse than not
    // writing at all.
    if (!first || first.found.isRole) continue;

    const owners = new Set<string>();
    let unowned = false;

    for (const hit of hits) {
      const owner = owns(hit.index);
      if (owner) owners.add(owner);
      else unowned = true;
    }

    if (owners.size !== 1 || unowned) continue;

    const owner = [...owners][0];
    if (owner && !emailsByPerson.has(owner)) emailsByPerson.set(owner, address);
  }

  return {
    identitiesByPerson,
    emailsByPerson,
    companyIdentities: [...companyIdentities.values()],
  };
}

/**
 * Folds several pages' attributions into one, under the same rules.
 *
 * A crawl reads a site rather than a page, and the page whose layout says whose
 * profile is whose is usually not the page the crawl was pointed at: the cards
 * are on `/team`, while the footer carrying the company's own accounts is on
 * every page. Deciding per page and concatenating the answers would throw away
 * the guard that matters most here — a handle inside Jane's card on the team
 * page and in the homepage footer is the company's, not Jane's — because
 * neither page sees the other's copy of it.
 *
 * So the cross-page view re-applies the same two tests. A handle claimed by two
 * different people, or claimed by one and filed against the company by any
 * page, goes to the company.
 */
export function mergeAttribution(results: readonly AttributionResult[]): AttributionResult {
  const keyOf = (identity: CandidateIdentity) =>
    `${identity.network}:${identity.handle?.toLowerCase()}`;

  const claimants = new Map<string, Set<string>>();
  const personBest = new Map<string, CandidateIdentity>();
  const companySeen = new Map<string, CandidateIdentity>();

  for (const result of results) {
    for (const [person, identities] of result.identitiesByPerson) {
      for (const identity of identities) {
        const key = keyOf(identity);
        const previous = personBest.get(key);

        // The same identity read twice keeps its strongest reading: a page that
        // could match the handle to the name saw more than one that could not.
        if (!previous || (identity.providerConfidence ?? 0) > (previous.providerConfidence ?? 0)) {
          personBest.set(key, identity);
        }

        claimants.set(key, (claimants.get(key) ?? new Set<string>()).add(person));
      }
    }

    for (const identity of result.companyIdentities) {
      const key = keyOf(identity);
      if (!companySeen.has(key)) companySeen.set(key, identity);
    }
  }

  const identitiesByPerson = new Map<string, CandidateIdentity[]>();
  const companyIdentities = new Map<string, CandidateIdentity>(companySeen);

  for (const [key, owners] of claimants) {
    const identity = personBest.get(key);
    if (!identity) continue;

    if (owners.size === 1 && !companySeen.has(key)) {
      const owner = [...owners][0];
      if (owner)
        identitiesByPerson.set(owner, [...(identitiesByPerson.get(owner) ?? []), identity]);
      continue;
    }

    // Demoted. A handle two people both appeared to own was never seen as the
    // company's on any page, so there is no company-shaped reading of it to
    // fall back on — rebuild one at the confidence an unattributed link gets.
    if (!companyIdentities.has(key)) {
      companyIdentities.set(key, { ...identity, providerConfidence: 0.6 });
    }
  }

  // Addresses go the same way, and one person still keeps one address: an
  // address two people appear to own is nobody's, and the first page to place
  // an address with somebody is the one that counts.
  const addressClaimants = new Map<string, Set<string>>();
  const placements: Array<readonly [string, string]> = [];

  for (const result of results) {
    for (const [person, address] of result.emailsByPerson) {
      addressClaimants.set(
        address,
        (addressClaimants.get(address) ?? new Set<string>()).add(person),
      );
      placements.push([person, address]);
    }
  }

  const emailsByPerson = new Map<string, string>();
  for (const [person, address] of placements) {
    if (addressClaimants.get(address)?.size !== 1) continue;
    if (!emailsByPerson.has(person)) emailsByPerson.set(person, address);
  }

  return {
    identitiesByPerson,
    emailsByPerson,
    companyIdentities: [...companyIdentities.values()],
  };
}
