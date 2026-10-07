/**
 * List sources from the news: the planner's "signal" lists, built without a
 * data vendor (Hunter's planner: newly funded companies, new leadership in a
 * 60-90 day window, conference contacts).
 *
 *   - **Funding.** "Acme raises $12M Series A to ..." — a company with fresh
 *     budget. The company is the lead; its site is crawled for people.
 *   - **New leaders.** "Acme appoints Jane Doe as VP of Sales" — a new
 *     decision-maker with a 90-day mandate. The company is crawled; the
 *     appointment is the signal the message can reference.
 *   - **Events.** A conference's speakers or sponsors page in the product's
 *     market. The page itself is crawled for the people and companies on it.
 *
 * Headlines are parsed with fixed patterns, not a model: a lead is created
 * only from a headline that names a company in a recognisable shape, and the
 * headline plus snippet become the signal's evidence, so a draft can say
 * "congratulations on the Series A" and nothing it cannot back.
 */

export type ListSourceKind = 'funding' | 'leadership' | 'event';
export const LIST_SOURCE_KINDS: readonly ListSourceKind[] = ['funding', 'leadership', 'event'];

/** Days between scans of one kind for one product. */
export const LIST_SOURCE_EVERY_DAYS = 7;
/** Paid searches (news, web, domain lookups) per workspace per day. */
export const LIST_SOURCE_DAILY_SEARCHES = 40;
/** Companies taken from one scan, so one busy news week cannot flood a campaign. */
export const LIST_SOURCE_MAX_ITEMS = 8;

/** Words worth searching for, from the product's category and description. */
export function marketTerms(input: { readonly category: string; readonly name?: string }): string {
  // The category is what the product *is* ("developer payments
  // infrastructure"); quoting it whole is too narrow for news, so the two
  // most specific words are used, quoted together when there are two.
  const words = input.category
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP.has(word));
  return words.slice(0, 3).join(' ') || input.name || '';
}

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'tool',
  'tools',
  'platform',
  'software',
  'service',
  'services',
  'app',
  'apps',
  'solution',
  'solutions',
  'company',
  'online',
  'based',
  'your',
  'that',
]);

export function listSourceQuery(kind: ListSourceKind, terms: string, year: number): string {
  if (kind === 'funding') return `${terms} startup raises funding round`;
  if (kind === 'leadership')
    return `${terms} appoints OR names OR hires "vice president" OR chief OR "head of"`;
  return `${terms} conference ${year} speakers`;
}

export interface FundingHeadline {
  readonly company: string;
  readonly amount?: string;
  readonly round?: string;
}

export interface LeadershipHeadline {
  readonly company: string;
  readonly person: string;
  readonly title: string;
}

const COMPANY = String.raw`([A-Z][\w.&'’+-]*(?:\s+[A-Z0-9][\w.&'’+-]*){0,4}(?:,\s+(?:Inc|LLC|Ltd|Corp)\.?)?)`;
/** A decision-maker's title, as a headline writes it. */
const ROLE = String.raw`((?:Senior\s+|Executive\s+|Global\s+|Group\s+)?(?:Chief|VP|Vice President|SVP|EVP|Head|Director|Executive Director|Managing Director|General Manager|President|CEO|CFO|CTO|CRO|CMO|COO|CPO)[\w\s,&-]{0,60})`;
const AMOUNT = String.raw`(\$|€|£)\s?\d[\d.,]*\s?(?:million|billion|[MBK])?`;

const APPOINTS = new RegExp(
  String.raw`^${COMPANY}\s+(?:appoints|names|hires|welcomes|taps|promotes)\s+(?:former\s+[\w\s-]+?\s+)?([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,3})\s+(?:as\s+(?:its\s+|new\s+)*|to\s+)?${ROLE}`,
);
const JOINS = new RegExp(
  String.raw`^([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,3})\s+(?:joins|named|appointed)\s+${COMPANY}\s+as\s+${ROLE}`,
);

/** Generic words that open a headline but are not a company. */
const NOT_A_COMPANY =
  /^(the|a|an|this|that|who|which|it|they|startup|report|exclusive|why|how|ai|fintech|new|top|meet|company|firm)$/i;

function cleanCompany(raw: string): string | undefined {
  const name = raw
    .trim()
    .replace(/[’']s$/i, '')
    .replace(/,$/, '');
  if (!name || NOT_A_COMPANY.test(name.split(/\s+/)[0] ?? '')) return undefined;
  return name.length <= 60 ? name : undefined;
}

function cleanTitle(raw: string): string {
  return raw
    .split(/\s+(?:to|in|amid|after|as|following|for|and|ahead)\s+/i)[0]!
    .replace(/[,\s-]+$/, '')
    .trim();
}

/** Words that describe a company in a headline rather than name it. */
const DESCRIPTORS = new Set([
  'startup',
  'start-up',
  'firm',
  'company',
  'platform',
  'provider',
  'maker',
  'fintech',
  'insurtech',
  'proptech',
  'healthtech',
  'edtech',
  'payments',
  'payment',
  'stablecoin',
  'ai',
  'saas',
  'software',
  'unicorn',
  'scaleup',
  'developer',
  'egyptian',
  'indian',
  'european',
  'british',
  'german',
  'french',
  'estonian',
  'nigerian',
  'israeli',
  'canadian',
  'us',
  'u.s.',
  'based',
  'backed',
  'and',
  'the',
  'a',
  'an',
  'its',
  'of',
  'for',
  'to',
  'in',
  'as',
  'by',
  'with',
  'rebrands',
  'exclusive',
  'breaking',
  'report',
  'mena',
  'cybersecurity',
  'security',
  'data',
  'cloud',
  'crypto',
  'web3',
  'b2b',
  'logistics',
  'climate',
  'robotics',
  'biotech',
  'legal',
]);

const FUNDING_VERB =
  /\s(raises|raised|secures|secured|closes|closed|lands|nabs|bags|gets|announces)\s/i;
const ROUND = /(pre-seed|seed|series\s+[a-h]\b|growth round|funding|round|\$|€|£)/i;

export function parseFundingHeadline(title: string): FundingHeadline | undefined {
  // "Exclusive: Split Pay raises..." prefixes go, and so does a quoted
  // tagline ("'Frontier Audio AI Company' Modulate Announces $25M Raise").
  const text = title
    .trim()
    .replace(/^[\w\s]{1,20}:\s+/, '')
    .replace(/^['‘“"][^'’”"]{1,80}['’”"]\s+/, '');
  const verb = FUNDING_VERB.exec(text);
  if (!verb || verb.index === undefined) return undefined;
  const after = text.slice(verb.index + verb[0].length);
  if (!ROUND.test(after.slice(0, 80))) return undefined;

  // The company is the words just before the verb, read backwards until a
  // descriptor ("fintech startup"), and with an appositive dropped: in
  // "Latitude, founded by Stripe alums, raises" the subject is before the
  // first comma.
  let before = text.slice(0, verb.index).trim();
  if (before.includes(',')) before = before.split(',')[0]!.trim();
  const words = before.split(/\s+/);
  // "Pay-i rebrands as Ascerta and raises": the conjunction is not the name.
  while (words.length > 0 && /^(and|which|who|that|now)$/i.test(words[words.length - 1]!)) {
    words.pop();
  }
  const name: string[] = [];
  for (let i = words.length - 1; i >= 0 && name.length < 4; i -= 1) {
    const word = words[i]!.replace(/[’']s$/i, '').replace(/^['‘“"]+|['’”"]+$/g, '');
    if (!word) break;
    if (DESCRIPTORS.has(word.toLowerCase())) break;
    name.unshift(word);
  }
  const company = cleanCompany(name.join(' '));
  if (!company || company.length < 2) return undefined;

  const amount = new RegExp(`^(?:an?\\s+)?(${AMOUNT})`, 'i').exec(after)?.[1];
  const round = /(pre-seed|seed|series\s+[a-h]\b)/i.exec(after)?.[1];
  return {
    company,
    ...(amount ? { amount: amount.replace(/\s+/g, ' ').trim() } : {}),
    ...(round ? { round: round.replace(/\s+/g, ' ').trim() } : {}),
  };
}

export function parseLeadershipHeadline(title: string): LeadershipHeadline | undefined {
  // Headlines are title-cased ("Acme Appoints Jane Doe"), but the patterns
  // need capitals to find names, so only the verbs are lowered.
  const text = title
    .trim()
    .replace(
      /\b(Appoints|Names|Hires|Welcomes|Taps|Promotes|Joins|Named|Appointed|As|To|Its|New)\b/g,
      (verb) => verb.toLowerCase(),
    );
  const appoints = APPOINTS.exec(text);
  if (appoints) {
    const company = cleanCompany(appoints[1] ?? '');
    if (company && appoints[2] && appoints[3]) {
      return { company, person: appoints[2].trim(), title: cleanTitle(appoints[3]) };
    }
  }
  const joins = JOINS.exec(text);
  if (joins) {
    const company = cleanCompany(joins[2] ?? '');
    if (company && joins[1] && joins[3]) {
      return { company, person: joins[1].trim(), title: cleanTitle(joins[3]) };
    }
  }
  return undefined;
}

/** A conference page worth crawling for people: its speakers, sponsors or exhibitors. */
export function isEventPeoplePage(url: string): boolean {
  try {
    const { pathname, hostname } = new URL(url);
    if (/(linkedin|facebook|twitter|x\.com|youtube|eventbrite|meetup)\./i.test(hostname))
      return false;
    return /\/(speakers?|sponsors?|exhibitors?|partners|lineup|agenda)(\/|$|\.)/i.test(pathname);
  } catch {
    return false;
  }
}

/**
 * True when a page is about a past edition: every year it names (in the URL
 * or title) is before `year`. "PlatformCon 2024 speakers" is not a 2026
 * contact list; a page naming no year at all is taken.
 */
export function isPastEvent(url: string, title: string, year: number): boolean {
  const years = `${url} ${title}`.match(/\b20\d{2}\b/g)?.map(Number) ?? [];
  return years.length > 0 && years.every((found) => found < year);
}
