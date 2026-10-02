/**
 * Job posts as an intake source.
 *
 * A company advertising a senior engineering role has said, in public and in
 * its own words, that it needs engineering done and has budget for it. That is
 * the best opening there is for offering agentic work: the claim is the
 * posting, and the posting is stored.
 *
 * The posting names a company, almost never a person. The work this module
 * supports is getting from one to the other: read the posting off the job
 * board's own public API, then search for the people who run that company and
 * keep only results that name it. Everything here is parsing and arithmetic so
 * the API, the worker and tests agree with no network between them.
 */

/** Job boards whose postings we can read through a public, keyless API. */
export const JOB_BOARDS = ['workable', 'greenhouse', 'lever', 'ashby'] as const;
export type JobBoard = (typeof JOB_BOARDS)[number];

/** A posting on any other site: kept, but read from the page itself. */
export type JobSource = JobBoard | 'other';

export function isJobBoard(value: unknown): value is JobBoard {
  return typeof value === 'string' && (JOB_BOARDS as readonly string[]).includes(value);
}

/** The host a keyword search is restricted to, per board. */
export const JOB_BOARD_SITES: Readonly<Record<JobBoard, string>> = {
  workable: 'apply.workable.com',
  greenhouse: 'job-boards.greenhouse.io',
  lever: 'jobs.lever.co',
  ashby: 'jobs.ashbyhq.com',
};

export const JOB_POST_STATUSES = [
  // Saved, not read yet.
  'new',
  // Read and searched; at least one person found.
  'contact_found',
  // Read and searched; nobody who could be shown to work there.
  'no_contact',
  // The board or the search refused; `last_error` says why.
  'failed',
  // The operator's own bookkeeping once they act on it.
  'contacted',
  'applied',
  'archived',
] as const;
export type JobPostStatus = (typeof JOB_POST_STATUSES)[number];

export function isJobPostStatus(value: unknown): value is JobPostStatus {
  return typeof value === 'string' && (JOB_POST_STATUSES as readonly string[]).includes(value);
}

/** Most postings one keyword search may add, across every board. */
export const MAX_SEARCH_RESULTS = 50;
/** Most URLs one request may save. */
export const MAX_JOB_URLS = 100;

export interface ParsedJobUrl {
  readonly source: JobSource;
  /** The company's slug on the board: `raydar` in apply.workable.com/raydar/j/…. */
  readonly account?: string | undefined;
  /** The board's id for the posting. */
  readonly jobId?: string | undefined;
  /** One spelling per posting, so the same job pasted twice is one row. */
  readonly url: string;
}

/**
 * Recognise a posting URL and reduce it to one canonical spelling.
 *
 * A board URL without a posting id (a company's job list, an /apply form with
 * no job) is refused rather than saved: there is nothing to read and nothing a
 * contact could be asked about.
 */
export function parseJobUrl(input: string): ParsedJobUrl | { reason: string } {
  const raw = input.trim();
  if (!raw) return { reason: 'empty' };

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { reason: 'not a url' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return { reason: 'unsupported scheme' };

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return { reason: 'not a domain' };
  }
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'apply.workable.com') {
    // /{account}/j/{code}/… or the account-less /j/{code}.
    const j = parts.indexOf('j');
    const code = j >= 0 ? parts[j + 1] : undefined;
    if (!code || !/^[A-Z0-9]{6,16}$/i.test(code)) return { reason: 'not a workable posting' };
    const account = j === 1 ? parts[0]?.toLowerCase() : undefined;
    const jobId = code.toUpperCase();
    return {
      source: 'workable',
      ...(account ? { account } : {}),
      jobId,
      url: account
        ? `https://apply.workable.com/${account}/j/${jobId}/`
        : `https://apply.workable.com/j/${jobId}/`,
    };
  }

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    const account = parts[0]?.toLowerCase();
    const jobId = parts[1] === 'jobs' ? parts[2] : (url.searchParams.get('gh_jid') ?? undefined);
    if (!account || !jobId || !/^\d+$/.test(jobId)) return { reason: 'not a greenhouse posting' };
    return {
      source: 'greenhouse',
      account,
      jobId,
      url: `https://job-boards.greenhouse.io/${account}/jobs/${jobId}`,
    };
  }

  if (host === 'jobs.lever.co' || host === 'jobs.ashbyhq.com') {
    const account = parts[0];
    const jobId = parts[1]?.toLowerCase();
    const source: JobBoard = host === 'jobs.lever.co' ? 'lever' : 'ashby';
    if (!account || !jobId || !/^[0-9a-f-]{36}$/.test(jobId)) {
      return { reason: `not a ${source} posting` };
    }
    return { source, account, jobId, url: `https://${host}/${account}/${jobId}` };
  }

  url.hash = '';
  return { source: 'other', url: url.toString() };
}

/**
 * Turn what a person types into a search phrase.
 *
 * "senior software engineer (remote)" means the title, exactly, and the word
 * remote somewhere: the title is quoted so Google does not return every
 * engineer, and anything in parentheses is a loose qualifier.
 */
export function keywordTerms(keyword: string): string {
  const qualifiers: string[] = [];
  const title = keyword
    .replace(/\(([^)]*)\)/g, (_, inner: string) => {
      qualifiers.push(inner.trim());
      return ' ';
    })
    .replace(/["]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return [title ? `"${title}"` : '', ...qualifiers.filter(Boolean)].filter(Boolean).join(' ');
}

/**
 * One query per board.
 *
 * Measured, not assumed: ValueSERP ignores `site:a OR site:b` and returns
 * Indeed and ZipRecruiter listings instead, so each board costs one search.
 */
export function jobSearchQueries(
  keyword: string,
  boards: readonly JobBoard[] = JOB_BOARDS,
): { board: JobBoard; q: string }[] {
  const terms = keywordTerms(keyword);
  if (!terms) return [];
  return boards.map((board) => ({ board, q: `site:${JOB_BOARD_SITES[board]} ${terms}` }));
}

/**
 * A posting placed by a recruiter for someone else.
 *
 * Worth knowing before writing to anybody: the person to reach is at the
 * agency, and the employer is usually unnamed on purpose.
 */
export function isAgencyPosting(text: string): boolean {
  return /\bon behalf of (?:our|a|an) client\b|\bour client is\b|\brecruiting for (?:this role )?on behalf\b|\bfor one of our clients\b/i.test(
    text,
  );
}

// ----------------------------------------------------------------- contacts

/** Titles worth a search, in the words LinkedIn headlines use. */
const CONTACT_QUERY_TITLES = [
  'founder',
  'CEO',
  'CTO',
  '"head of engineering"',
  '"VP engineering"',
  '"engineering manager"',
  'recruiter',
  'talent',
];

/** `site:linkedin.com/in "Company" (founder OR CEO OR …)` */
export function contactSearchQuery(company: string): string {
  const name = company.replace(/["]/g, '').trim();
  return `site:linkedin.com/in "${name}" (${CONTACT_QUERY_TITLES.join(' OR ')})`;
}

const ROLE_WEIGHTS: readonly { pattern: RegExp; role: string; direct: number; agency: number }[] = [
  { pattern: /\b(co-?founder|founder)\b/i, role: 'founder', direct: 0.9, agency: 1 },
  { pattern: /\b(ceo|chief executive)\b/i, role: 'ceo', direct: 0.85, agency: 0.95 },
  { pattern: /\b(cto|chief technology|chief technical)\b/i, role: 'cto', direct: 1, agency: 0.6 },
  {
    pattern:
      /\b(vp|vice president|head|director)\b.{0,20}\b(engineering|technology|software|product)\b/i,
    role: 'engineering_leader',
    direct: 0.95,
    agency: 0.7,
  },
  {
    pattern: /\bengineering manager\b|\bmanager,? (software )?engineering\b/i,
    role: 'engineering_manager',
    direct: 0.8,
    agency: 0.4,
  },
  {
    pattern: /\b(recruit\w*|talent|people partner|hiring)\b/i,
    role: 'recruiter',
    direct: 0.6,
    agency: 0.8,
  },
];

export interface ContactRank {
  readonly role: string;
  readonly score: number;
}

/**
 * How useful a person is to write to about the posting, 0–1.
 *
 * For an employer, the people who own engineering first: they feel the gap
 * the posting describes and can buy agentic work instead of a hire. For an
 * agency, the founder and recruiters: they place the role and own the client.
 * Anybody whose headline says they left is discounted rather than dropped —
 * the search result is a snapshot and a human decides.
 *
 * The headline is the person's own one-line answer to "what do you do", so
 * it decides the role. The snippet is whatever Google cut from their profile
 * ("…the intersection of talent, strategy…") and only counts, discounted,
 * when the headline says nothing usable.
 */
export function rankContact(headline: string, snippet: string, agency: boolean): ContactRank {
  let best = roleIn(headline, agency);
  if (best.role === 'other' && snippet) {
    const fromSnippet = roleIn(snippet, agency);
    if (fromSnippet.role !== 'other') {
      best = { role: fromSnippet.role, score: round(fromSnippet.score * 0.8) };
    }
  }
  if (/\b(former|formerly|emeritus|previously|retired)\b|(^|\s)ex-/i.test(headline)) {
    best = { role: best.role, score: round(best.score * 0.4) };
  }
  return best;
}

function roleIn(text: string, agency: boolean): ContactRank {
  let best: ContactRank = { role: 'other', score: 0.3 };
  for (const weight of ROLE_WEIGHTS) {
    if (!weight.pattern.test(text)) continue;
    const score = agency ? weight.agency : weight.direct;
    if (score > best.score) best = { role: weight.role, score };
  }
  return best;
}

function round(score: number): number {
  return Math.round(score * 100) / 100;
}

/**
 * Whether a page names the person: first and last name, adjacent.
 *
 * Used on the company's own site. A team page listing "David Phillips. Founder
 * & CEO" is the company vouching for him; a LinkedIn result naming the company
 * is only him (or a namesake company) saying so.
 */
export function namedOnPage(text: string, fullName: string): boolean {
  const parts = fold(fullName)
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+/)
    .map((part) => part.replace(/[^a-z'-]/g, ''))
    .filter((part) => part.length >= 2);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last || first === last) return false;
  const haystack = fold(text).replace(/\s+/g, ' ');
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Allow a middle name or initial between them.
  return new RegExp(`(^|[^a-z])${escape(first)}( [a-z.'-]+)? ${escape(last)}([^a-z]|$)`).test(
    haystack,
  );
}

export interface SearchResultLike {
  readonly title?: string | undefined;
  readonly link?: string | undefined;
  readonly snippet?: string | undefined;
}

export interface LinkedInContact {
  readonly name: string;
  /** The profile slug: `davidphillips97`. */
  readonly handle: string;
  readonly profileUrl: string;
  /** What the search result says about them, kept verbatim as evidence. */
  readonly headline: string;
  readonly snippet: string;
}

/**
 * One search result, if it is a LinkedIn profile that names the company.
 *
 * The page title is "Name - Headline", and the result is accepted only when
 * the company appears as itself in the title or the snippet — "Raydar" alone,
 * or "Raydar Inc", but not "Raydar Studios", which is somebody else. That is
 * the precision rule for every identity here: a stranger who shares a word
 * with the company is worse than nobody.
 */
export function linkedInContactFrom(
  result: SearchResultLike,
  company: string,
): LinkedInContact | undefined {
  if (!result.link || !result.title) return undefined;

  let page: URL;
  try {
    page = new URL(result.link);
  } catch {
    return undefined;
  }
  const host = page.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return undefined;
  const match = /^\/in\/([^/?#]+)/.exec(page.pathname);
  if (!match?.[1]) return undefined;
  const handle = decodeURIComponent(match[1]).toLowerCase();

  const [rawName, ...rest] = result.title.split(/\s+[-–|]\s+/);
  const name = (rawName ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/,.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name.split(' ').length < 2 || /linkedin/i.test(name)) return undefined;

  const headline = rest
    .join(' - ')
    .replace(/\s*\|\s*LinkedIn\s*$/i, '')
    .trim();
  const snippet = (result.snippet ?? '').trim();
  if (!namesCompany(`${headline} · ${snippet}`, company)) return undefined;

  return {
    name,
    handle,
    profileUrl: `https://www.linkedin.com/in/${encodeURIComponent(handle)}`,
    headline,
    snippet,
  };
}

/** Suffixes that leave a company the same company. */
const SAME_COMPANY_SUFFIXES = new Set([
  'inc',
  'llc',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'gmbh',
  'plc',
  'hq',
]);

/**
 * Whether `text` mentions the company as itself.
 *
 * A mention followed by another capitalised word or "&" is a different
 * company with a longer name ("Raydar Studios", "Raydar & Associates"), unless
 * that word is a legal suffix. At least one clean mention is required.
 */
export function namesCompany(text: string, company: string): boolean {
  const name = fold(company).trim();
  if (name.length < 2) return false;
  const haystack = fold(text);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^a-z0-9])${escaped}(?![a-z0-9])`, 'g');

  for (const found of haystack.matchAll(pattern)) {
    const end = (found.index ?? 0) + found[0].length;
    // Read the next word from the original text, where case survives.
    const after = text.slice(end).match(/^\s*([&+]|[A-Za-z][\w'-]*)/);
    const next = after?.[1];
    if (!next) return true;
    if (next === '&' || next === '+') continue;
    if (/^[A-Z]/.test(next) && !SAME_COMPANY_SUFFIXES.has(next.toLowerCase())) continue;
    return true;
  }
  return false;
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * The company's own domain, from a URL a board or a page gave us.
 *
 * Job boards, social networks and link shorteners are not anybody's company,
 * so a "website" that points at one is no domain at all.
 */
export function companyDomainFrom(website: string | undefined): string | undefined {
  if (!website?.trim()) return undefined;
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname;
  } catch {
    return undefined;
  }
  host = host.toLowerCase().replace(/^www\./, '');
  if (!host.includes('.')) return undefined;
  if (NOT_A_COMPANY_DOMAIN.some((d) => host === d || host.endsWith(`.${d}`))) return undefined;
  return host;
}

const NOT_A_COMPANY_DOMAIN = [
  'workable.com',
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'ziprecruiter.com',
  'wellfound.com',
  'angel.co',
  'crunchbase.com',
  'facebook.com',
  'x.com',
  'twitter.com',
  'instagram.com',
  'youtube.com',
  'wikipedia.org',
  'bit.ly',
  'notion.site',
];

/**
 * Which published address belongs to which contact.
 *
 * A site that publishes `david@raydar.xyz` beside a founder named David has
 * told us his address; a site that publishes `jobs@` has told us nothing about
 * anybody. Only a local part that is the person's first name, first.last,
 * firstlast, or first initial + last name is accepted.
 */
export function addressBelongsTo(address: string, fullName: string): boolean {
  const local = address.split('@')[0]?.toLowerCase() ?? '';
  const names = fold(fullName)
    .split(/\s+/)
    .map((part) => part.replace(/[^a-z]/g, ''))
    .filter((part) => part.length >= 2);
  const first = names[0];
  const last = names[names.length - 1];
  if (!first || !local) return false;
  const shapes = new Set([first]);
  if (last && last !== first) {
    for (const shape of [
      `${first}.${last}`,
      `${first}${last}`,
      `${first}_${last}`,
      `${first[0]}${last}`,
      `${first[0]}.${last}`,
    ]) {
      shapes.add(shape);
    }
  }
  return shapes.has(local);
}
