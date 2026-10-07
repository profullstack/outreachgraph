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

const COMPANY = String.raw`([A-Z][\w.&'’+-]*(?:\s+[A-Z0-9][\w.&'’+-]*){0,4})`;
const AMOUNT = String.raw`(\$|€|£)\s?\d[\d.,]*\s?(?:million|billion|[MBK])?`;

const FUNDING = new RegExp(
  String.raw`^${COMPANY}\s+(?:raises|secures|closes|lands|nabs|bags|announces)\s+(?:an?\s+)?(${AMOUNT})?[^.]*?(pre-seed|seed|series\s+[a-h]\b|growth|funding|round)`,
  'i',
);
const APPOINTS = new RegExp(
  String.raw`^${COMPANY}\s+(?:appoints|names|hires|welcomes|taps|promotes)\s+(?:former\s+[\w\s-]+?\s+)?([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,3})\s+(?:as\s+(?:its\s+|new\s+)*|to\s+)?((?:Chief|VP|Vice President|SVP|EVP|Head|Director|General Manager|President|CEO|CFO|CTO|CRO|CMO|COO|CPO)[\w\s,&-]{0,60})`,
);
const JOINS = new RegExp(
  String.raw`^([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,3})\s+(?:joins|named|appointed)\s+${COMPANY}\s+as\s+((?:Chief|VP|Vice President|SVP|EVP|Head|Director|General Manager|President|CEO|CFO|CTO|CRO|CMO|COO|CPO)[\w\s,&-]{0,60})`,
);

/** Generic words that open a headline but are not a company. */
const NOT_A_COMPANY = /^(the|a|an|this|startup|report|exclusive|why|how|ai|fintech|new|top|meet)$/i;

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
    .split(/\s+(?:to|in|amid|after|as|following|for)\s+/i)[0]!
    .replace(/[,\s-]+$/, '')
    .trim();
}

export function parseFundingHeadline(title: string): FundingHeadline | undefined {
  const match = FUNDING.exec(title.trim());
  if (!match) return undefined;
  const company = cleanCompany(match[1] ?? '');
  if (!company) return undefined;
  return {
    company,
    ...(match[2] ? { amount: match[2].replace(/\s+/g, ' ').trim() } : {}),
    ...(match[4] ? { round: match[4].replace(/\s+/g, ' ').trim() } : {}),
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
