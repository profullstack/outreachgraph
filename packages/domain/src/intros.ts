/**
 * Introductions between two account holders who both asked for them (PRD §38).
 *
 * Everything else in this product starts from a prospect who has not heard of
 * the workspace. This starts from the opposite end: two people who each wrote
 * down who they want to meet and what they can offer, and who each have to say
 * yes before either learns how to reach the other.
 *
 * Three rules shape the file, and they are the reason it lives in the domain
 * package rather than next to the routes:
 *
 *   - **A match reads only what the two people wrote for this purpose.** Never
 *     a prospect record, a signal, a score or a provider result. That is what
 *     keeps §17.4 true here without a classifier: the only inputs are the three
 *     fields a person typed into their own intro card.
 *   - **Ranking is deterministic and explainable.** No model takes part. A match
 *     carries the words that produced it, so "why this person" has an answer.
 *   - **The gate fails closed.** `decideIntroRequest` names every reason a
 *     request may not be made; anything it does not recognise as allowed is
 *     refused.
 */

/** What somebody chose to show other members. Nothing here is derived. */
export interface IntroCard {
  /** The card's own id (`itp_`). Never the user id. */
  readonly id: string;
  readonly displayName: string;
  readonly headline: string;
  readonly lookingFor: string;
  readonly canOffer: string;
  readonly topics: readonly string[];
}

export const INTRO_LIMITS = {
  displayName: 80,
  headline: 140,
  lookingFor: 600,
  canOffer: 600,
  topics: 12,
  topicLength: 40,
  note: 600,
} as const;

/** A request that nobody answered stops being answerable after this long. */
export const INTRO_REQUEST_TTL_DAYS = 14;

/**
 * How many requests one person may open in a rolling day.
 *
 * Small on purpose. The pool is people who agreed to hear from other members,
 * and the first thing that would make them leave is hearing from the same
 * member's agent thirty times before lunch.
 */
export const INTRO_DAILY_REQUEST_LIMIT = 5;

export const INTRO_STATUSES = ['pending', 'accepted', 'declined', 'withdrawn', 'expired'] as const;
export type IntroStatus = (typeof INTRO_STATUSES)[number];

export function isIntroStatus(value: unknown): value is IntroStatus {
  return typeof value === 'string' && (INTRO_STATUSES as readonly string[]).includes(value);
}

/** Collapses whitespace and cuts to length. Empty in, empty out. */
export function cleanIntroText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Lowercased, deduplicated, bounded. Order is kept: the first topic is the main one. */
export function cleanIntroTopics(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of value) {
    const topic = cleanIntroText(entry, INTRO_LIMITS.topicLength).toLowerCase();
    if (!topic || seen.has(topic)) continue;
    seen.add(topic);
    out.push(topic);
    if (out.length === INTRO_LIMITS.topics) break;
  }

  return out;
}

/**
 * What a card must hold before it can be shown to anyone.
 *
 * A card with a name and nothing else would join the pool and match nobody,
 * and a card with no name would ask someone to accept a stranger. Returns the
 * missing fields so a client can say which.
 */
export function missingForOpenIntroCard(
  card: Pick<IntroCard, 'displayName' | 'lookingFor' | 'canOffer'>,
): string[] {
  const missing: string[] = [];
  if (!card.displayName) missing.push('displayName');
  if (!card.lookingFor) missing.push('lookingFor');
  if (!card.canOffer) missing.push('canOffer');
  return missing;
}

/**
 * Words that say nothing about who somebody wants to meet.
 *
 * Besides the usual function words this drops the vocabulary every card
 * shares ("looking", "people", "help"): two cards that overlap only on
 * "looking for people who can help" have nothing in common.
 */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'who',
  'that',
  'this',
  'from',
  'are',
  'was',
  'has',
  'have',
  'can',
  'our',
  'you',
  'your',
  'their',
  'they',
  'them',
  'into',
  'about',
  'also',
  'any',
  'all',
  'but',
  'not',
  'its',
  'out',
  'how',
  'what',
  'want',
  'wants',
  'need',
  'needs',
  'looking',
  'meet',
  'find',
  'help',
  'people',
  'person',
  'someone',
  'anyone',
  'offer',
  'offers',
  'work',
  'working',
  'would',
  'like',
  'more',
  'some',
  'new',
]);

/** The distinct meaningful words of a text, in first-seen order. */
export function introTerms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}+#.-]+/u)) {
    const term = raw.replace(/^[.-]+|[.-]+$/g, '');
    if (term.length < 3 || STOPWORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }

  return out;
}

export interface IntroMatch {
  readonly card: IntroCard;
  /** 0–1. `0.6 × wantsMet + 0.4 × offersWanted`, rounded to three places. */
  readonly score: number;
  /** Words you asked for that this person offers or lists as a topic. */
  readonly theyOffer: readonly string[];
  /** Words they asked for that you offer or list as a topic. */
  readonly youOffer: readonly string[];
}

/** What the seeker asked for that the other side covers, as the asked words. */
function covered(wanted: readonly string[], supply: ReadonlySet<string>): string[] {
  return wanted.filter((term) => supply.has(term));
}

function supplyOf(card: Pick<IntroCard, 'canOffer' | 'topics'>): Set<string> {
  return new Set([...introTerms(card.canOffer), ...card.topics.flatMap((t) => introTerms(t))]);
}

/**
 * Scores one candidate for one seeker, or `undefined` when there is no match.
 *
 * A match requires the candidate to cover at least one thing the seeker asked
 * for. What the seeker could do for the candidate raises the score but cannot
 * create a match on its own: this list answers "who should I meet", and a
 * person who only wants something from you is their match, not yours.
 *
 * The weights favour your ask over theirs (0.6 / 0.4) for the same reason,
 * while still putting a two-way fit above a one-way one of equal coverage.
 */
export function scoreIntroMatch(seeker: IntroCard, candidate: IntroCard): IntroMatch | undefined {
  if (seeker.id === candidate.id) return undefined;

  const wanted = introTerms(seeker.lookingFor);
  const theyOffer = covered(wanted, supplyOf(candidate));
  if (wanted.length === 0 || theyOffer.length === 0) return undefined;

  const theyWant = introTerms(candidate.lookingFor);
  const youOffer = covered(theyWant, supplyOf(seeker));

  const wantsMet = theyOffer.length / wanted.length;
  const offersWanted = theyWant.length === 0 ? 0 : youOffer.length / theyWant.length;
  const score = Math.round((0.6 * wantsMet + 0.4 * offersWanted) * 1000) / 1000;

  return { card: candidate, score, theyOffer, youOffer };
}

/**
 * The best matches for a seeker, highest score first.
 *
 * Ties break on the card id so the same pool always produces the same order;
 * a list that reshuffles between two identical calls reads as a different
 * answer to the same question.
 */
export function rankIntroMatches(
  seeker: IntroCard,
  candidates: readonly IntroCard[],
  limit = 10,
): IntroMatch[] {
  const matches: IntroMatch[] = [];
  for (const candidate of candidates) {
    const match = scoreIntroMatch(seeker, candidate);
    if (match) matches.push(match);
  }

  matches.sort((a, b) => b.score - a.score || (a.card.id < b.card.id ? -1 : 1));
  return matches.slice(0, Math.max(0, limit));
}

/** Everything the gate needs to know, gathered by the caller from current state. */
export interface IntroRequestFacts {
  readonly requesterOpen: boolean;
  readonly targetOpen: boolean;
  readonly sameUser: boolean;
  /** Either side has declined the other before. A decline is not re-askable. */
  readonly blocked: boolean;
  /** A pending or accepted request already links the two, in either direction. */
  readonly alreadyLinked: boolean;
  readonly requestsInLastDay: number;
  readonly noteLength: number;
}

export type IntroDenial =
  | 'requester_not_open'
  | 'target_not_open'
  | 'same_user'
  | 'blocked'
  | 'already_linked'
  | 'daily_limit'
  | 'note_required';

export type IntroDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: IntroDenial };

/**
 * Whether a request may be opened, from current facts only.
 *
 * `target_not_open` and `blocked` are deliberately reported to the caller as
 * the same thing (see `apps/api/src/intros.ts`): telling a requester that a
 * specific person declined them is itself a disclosure the decliner did not
 * agree to. They stay distinct here so the audit log can tell them apart.
 */
export function decideIntroRequest(facts: IntroRequestFacts): IntroDecision {
  if (facts.sameUser) return { allowed: false, reason: 'same_user' };
  if (!facts.requesterOpen) return { allowed: false, reason: 'requester_not_open' };
  if (!facts.targetOpen) return { allowed: false, reason: 'target_not_open' };
  if (facts.blocked) return { allowed: false, reason: 'blocked' };
  if (facts.alreadyLinked) return { allowed: false, reason: 'already_linked' };
  if (facts.noteLength === 0) return { allowed: false, reason: 'note_required' };
  if (facts.requestsInLastDay >= INTRO_DAILY_REQUEST_LIMIT) {
    return { allowed: false, reason: 'daily_limit' };
  }
  return { allowed: true };
}

/**
 * The status a stored request reads as right now.
 *
 * Expiry is computed rather than swept: a pending row past its date is expired
 * the moment anyone looks, so no job has to run for an old request to stop
 * being acceptable.
 */
export function effectiveIntroStatus(
  stored: IntroStatus,
  expiresAt: string,
  nowIso: string,
): IntroStatus {
  return stored === 'pending' && expiresAt <= nowIso ? 'expired' : stored;
}

export type IntroResponse = 'accept' | 'decline' | 'withdraw';

/**
 * Who may move a request, and from where.
 *
 * Only the person asked can accept or decline; only the person who asked can
 * withdraw; and only a request still pending can move at all. An accepted
 * introduction cannot be un-made by either side, because by then each already
 * holds the other's address.
 */
export function nextIntroStatus(
  current: IntroStatus,
  response: IntroResponse,
  role: 'requester' | 'target',
): IntroStatus | undefined {
  if (current !== 'pending') return undefined;
  if (response === 'withdraw') return role === 'requester' ? 'withdrawn' : undefined;
  if (role !== 'target') return undefined;
  return response === 'accept' ? 'accepted' : 'declined';
}

// ------------------------------------------------------------ auto-drafts

/** What OutreachGraph knows about a member, to draft their card from. */
export interface IntroDraftSource {
  readonly name?: string | null;
  readonly email?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly jobTitle?: string | null;
  readonly companyDomain?: string | null;
  readonly offerings: readonly {
    readonly name: string;
    readonly category?: string | null;
    readonly description?: string | null;
    readonly valuePropositions?: readonly string[];
    readonly likelyPains?: readonly string[];
  }[];
}

export type IntroCardDraft = Omit<IntroCard, 'id'>;

function firstSentence(text: string | null | undefined, max: number): string {
  const t = cleanIntroText(text ?? '', 1_000);
  if (!t) return '';
  const first = t.split(/(?<=[.!?])\s/)[0] ?? t;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

function companyFromDomain(domain: string | null | undefined): string {
  const d = cleanIntroText(domain ?? '', 120)
    .toLowerCase()
    .replace(/^www\./, '');
  return d.includes('.') ? d : '';
}

/**
 * A card written for the member from what they told OutreachGraph: their name
 * and role, and the products they sell. Pure, so the same facts always give
 * the same draft and an unchanged member is not rewritten.
 *
 * The draft is never opened by this: a member's card is shown to others only
 * after their own click.
 */
export function draftIntroCard(source: IntroDraftSource): IntroCardDraft {
  const fullName = [source.firstName, source.lastName]
    .map((v) => cleanIntroText(v ?? '', 40))
    .filter(Boolean)
    .join(' ');
  const displayName = cleanIntroText(
    fullName || source.name || (source.email ?? '').split('@')[0] || '',
    INTRO_LIMITS.displayName,
  );

  const offerings = source.offerings.filter((o) => cleanIntroText(o.name, 80)).slice(0, 4);
  const names = offerings.map((o) => cleanIntroText(o.name, 60));
  const company = companyFromDomain(source.companyDomain);
  const role = cleanIntroText(source.jobTitle ?? '', 60);
  const building = names.slice(0, 2).join(' and ');

  let headline = '';
  if (role && company) headline = `${role} at ${company}`;
  else if (role) headline = building ? `${role}, building ${building}` : role;
  else if (building) headline = `Building ${building}`;
  else if (company) headline = `At ${company}`;

  const canOffer = offerings
    .map((o) => {
      const what =
        firstSentence(o.valuePropositions?.[0], 140) || firstSentence(o.description, 140);
      const name = cleanIntroText(o.name, 60);
      return what ? `${name}: ${what}` : name;
    })
    .join(' ');

  const pains = offerings
    .flatMap((o) => (o.likelyPains ?? []).slice(0, 1))
    .map((p) => firstSentence(p, 120))
    .filter(Boolean)
    .slice(0, 3);
  const lookingFor = names.length
    ? `Customers and partners for ${names.slice(0, 3).join(', ')}.` +
      (pains.length ? ` Especially people dealing with: ${pains.join(' ')}` : '')
    : '';

  return {
    displayName,
    headline: cleanIntroText(headline, INTRO_LIMITS.headline),
    lookingFor: cleanIntroText(lookingFor, INTRO_LIMITS.lookingFor),
    canOffer: cleanIntroText(canOffer, INTRO_LIMITS.canOffer),
    topics: cleanIntroTopics(
      offerings
        .map((o) => o.category ?? '')
        .filter((c) => c && c.length <= INTRO_LIMITS.topicLength),
    ),
  };
}
