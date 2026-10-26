/**
 * Public job feeds: companies hiring right now, read without a key.
 *
 * The job-board search used to be `site:jobs.lever.co "keyword"` through
 * ValueSERP. By 2026-10-26 ValueSERP answered every `site:` query with the
 * open web (Indeed, ZipRecruiter, blog posts about contracting), so the
 * workflow's two job-board steps found 0 postings a run while the account
 * still had 21,000 credits. These read the boards' own public feeds instead:
 *
 *   - **Hacker News "Who is hiring?"**, the latest monthly threads through
 *     Algolia. A post is usually written by the founder or hiring manager,
 *     names the company's site, and a quarter of them publish an address.
 *   - **Himalayas**, a remote board with a keyword search (5,000 results a
 *     query, 20 a page), so a run can page deep enough to meet new companies.
 *   - **RemoteOK** and **Jobicy**, the newest developer postings.
 *
 * A post is a company, a role and, where the feed says, the company's own
 * domain. Most feeds give only a name; the caller looks the domain up.
 */

import type { FetchLike } from '../site/fetch';
import { stripHtml } from './hackernews';

export interface JobFeedPost {
  /** Feed slug: `hn_hiring`, `himalayas`, `remoteok`, `jobicy`. */
  readonly feed: string;
  /** Where a human reads the posting; unique per posting. */
  readonly url: string;
  readonly company: string;
  /** The company's own domain, when the post names it. */
  readonly domain?: string | undefined;
  readonly title?: string | undefined;
  readonly location?: string | undefined;
  /** Plain text, for agency screening and the evidence line. */
  readonly text: string;
  readonly postedAt?: string | undefined;
  /** Addresses published in the post itself. */
  readonly emails: readonly string[];
  /** Who wrote the post, where the feed says (an HN user). */
  readonly author?: string | undefined;
}

export interface JobFeedSearch {
  /** The role keyword, e.g. "contract software engineer". */
  readonly keyword: string;
  readonly limit: number;
}

export interface JobFeed {
  readonly slug: string;
  search(input: JobFeedSearch): Promise<readonly JobFeedPost[]>;
}

export interface JobFeedOptions {
  readonly fetchImpl?: FetchLike | undefined;
  readonly timeoutMs?: number | undefined;
}

/** RemoteOK and Himalayas refuse a bare client; a browser UA is what they serve. */
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

/** Job-board and link hosts that are never the employer's own domain. */
const NOT_EMPLOYER =
  /(?:^|\.)(?:ycombinator\.com|greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|bamboohr\.com|recruitee\.com|smartrecruiters\.com|breezy\.hr|jobvite\.com|myworkdayjobs\.com|workday\.com|rippling\.com|wellfound\.com|angel\.co|linkedin\.com|github\.com|gitlab\.com|google\.com|forms\.gle|notion\.site|notion\.so|docs\.google\.com|bit\.ly|calendly\.com|typeform\.com|tally\.so|airtable\.com|twitter\.com|x\.com|youtube\.com|medium\.com|substack\.com|apple\.com|remoteok\.com|himalayas\.app|jobicy\.com|teamtailor\.com|personio\.de|join\.com|dover\.com|gem\.com|welcometothejungle\.com|otta\.com|hire\.withgoogle\.com)$/i;

/** Words that make a keyword a role rather than a qualifier. */
const ROLE_WORDS =
  /\b(?:engineer|engineers|engineering|developer|developers|programmer|swe|sre|devops|architect|cto)\b/i;
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'for',
  'of',
  'in',
  'at',
  'to',
  'or',
  'with',
  'contract',
  'contractor',
  'freelance',
  'remote',
  'senior',
  'hiring',
  'job',
  'jobs',
  'role',
]);

/**
 * Whether a posting is about the keyword.
 *
 * Loose on purpose: "contract software engineer" should match a post hiring
 * "Senior Software Engineer", because the offer is a contractor to a team that
 * needs engineers, not a reply to the word "contract". A post must name a role
 * word, and every other keyword word except qualifiers like "contract".
 */
export function matchesJobKeyword(keyword: string, text: string): boolean {
  const haystack = text.toLowerCase().replace(/[-_/]/g, ' ');
  if (!ROLE_WORDS.test(haystack)) return false;
  const words = keyword
    .toLowerCase()
    .replace(/[^a-z0-9+#. ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w) && !ROLE_WORDS.test(w));
  return words.every((w) =>
    w === 'full' || w === 'stack'
      ? /\bfull\s*stack\b|\bfullstack\b/.test(haystack)
      : haystack.includes(w),
  );
}

/** The search phrase a board with its own search should be given. */
export function jobFeedQuery(keyword: string): string {
  const words = keyword
    .toLowerCase()
    .replace(/[^a-z0-9+#. ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w));
  return words.join(' ') || 'software engineer';
}

/** The employer's domain from a URL, or undefined for boards and link hosts. */
export function employerDomain(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (!host.includes('.') || NOT_EMPLOYER.test(host)) return undefined;
    // careers.acme.com and jobs.acme.com are acme.com.
    return host.replace(/^(?:careers|jobs|apply|join|work|hire|boards)\./, '');
  } catch {
    return undefined;
  }
}

/** Every address in a text, including `name [at] host [dot] com`. */
export function addressesIn(text: string): string[] {
  const plain = text
    .replace(/\s*[[({<]\s*at\s*[\])}>]\s*/gi, '@')
    .replace(/\s*[[({<]\s*dot\s*[\])}>]\s*/gi, '.');
  const found = new Set<string>();
  for (const match of plain.matchAll(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi)) {
    const address = match[0].toLowerCase().replace(/\.+$/, '');
    if (!/noreply|no-reply|example\.(?:com|org)$/.test(address)) found.add(address);
  }
  return [...found];
}

async function getJson<T>(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
  browser = false,
): Promise<T> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', ...(browser ? { 'user-agent': BROWSER_UA } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${new URL(url).hostname} answered ${response.status}`);
  return (await response.json()) as T;
}

// ------------------------------------------------------------ Hacker News

interface HnItem {
  id?: number;
  author?: string;
  text?: string | null;
  created_at?: string;
  title?: string;
  children?: HnItem[];
}

/**
 * "Ask HN: Who is hiring?", the newest `threads` months. One post per company,
 * written in the house format: `Company | Role | Location | URL`.
 */
export class HnHiringFeed implements JobFeed {
  readonly slug = 'hn_hiring';
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #threads: number;

  constructor(options: JobFeedOptions & { readonly threads?: number } = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#threads = options.threads ?? 2;
  }

  async search(input: JobFeedSearch): Promise<readonly JobFeedPost[]> {
    const stories = await getJson<{ hits?: { objectID: string; title?: string }[] }>(
      this.#fetch,
      'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=12',
      this.#timeoutMs,
    );
    const threads = (stories.hits ?? [])
      .filter((h) => /who is hiring/i.test(h.title ?? ''))
      .slice(0, this.#threads);

    const posts: JobFeedPost[] = [];
    for (const thread of threads) {
      const item = await getJson<HnItem>(
        this.#fetch,
        `https://hn.algolia.com/api/v1/items/${thread.objectID}`,
        this.#timeoutMs,
      );
      for (const child of item.children ?? []) {
        if (posts.length >= input.limit) return posts;
        const post = hnPost(child);
        if (post && matchesJobKeyword(input.keyword, post.text)) posts.push(post);
      }
    }
    return posts;
  }
}

/** One top-level hiring comment, or undefined when it is not a posting. */
export function hnPost(child: HnItem): JobFeedPost | undefined {
  if (!child.id || !child.text) return undefined;
  const html = child.text;
  const text = stripHtml(html);
  const firstLine = stripHtml(html.split(/<p>/i)[0] ?? '');
  const company = firstLine
    .split(/\s+[|—–]\s+|\s+-\s+|\s*\|\s*/)[0]
    ?.replace(/\s*\(.*$/, '')
    .replace(/\s+https?:\/\/\S+/, '')
    .trim();
  if (!company || company.length > 80) return undefined;

  const links = [...html.matchAll(/href="([^"]+)"/gi)].map((m) =>
    m[1]!.replace(/&#x2F;/g, '/').replace(/&amp;/g, '&'),
  );
  const emails = addressesIn(text);
  const domain =
    links.map(employerDomain).find(Boolean) ??
    emails.map((e) => employerDomain(`https://${e.split('@')[1]}`)).find(Boolean);

  return {
    feed: 'hn_hiring',
    url: `https://news.ycombinator.com/item?id=${String(child.id)}`,
    company,
    domain,
    title: firstLine.slice(0, 200),
    text: text.slice(0, 4_000),
    postedAt: child.created_at,
    emails,
    author: child.author,
  };
}

// --------------------------------------------------------------- Himalayas

interface HimalayasJob {
  title?: string;
  companyName?: string;
  companySlug?: string;
  excerpt?: string;
  locationRestrictions?: string[];
  pubDate?: number | string;
  guid?: string;
  applicationLink?: string;
}

/** Himalayas' keyword search, US-eligible postings only, `pages` deep. */
export class HimalayasFeed implements JobFeed {
  readonly slug = 'himalayas';
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #pages: number;

  constructor(options: JobFeedOptions & { readonly pages?: number } = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#pages = options.pages ?? 15;
  }

  async search(input: JobFeedSearch): Promise<readonly JobFeedPost[]> {
    const q = encodeURIComponent(jobFeedQuery(input.keyword));
    const posts: JobFeedPost[] = [];
    for (let page = 1; page <= this.#pages && posts.length < input.limit; page += 1) {
      const body = await getJson<{ jobs?: HimalayasJob[] }>(
        this.#fetch,
        `https://himalayas.app/jobs/api/search?q=${q}&page=${String(page)}`,
        this.#timeoutMs,
        true,
      );
      const jobs = body.jobs ?? [];
      if (jobs.length === 0) break;
      for (const job of jobs) {
        if (posts.length >= input.limit) break;
        const where = job.locationRestrictions ?? [];
        if (where.length > 0 && !where.includes('United States')) continue;
        const url = job.guid ?? job.applicationLink;
        if (!job.companyName || !url) continue;
        const posted = Number(job.pubDate);
        posts.push({
          feed: this.slug,
          url,
          company: job.companyName,
          title: job.title,
          location: where.join(', ') || 'Remote',
          text: `${job.title ?? ''}\n${job.excerpt ?? ''}`,
          ...(Number.isFinite(posted) && posted > 0
            ? { postedAt: new Date(posted * 1000).toISOString() }
            : {}),
          emails: [],
        });
      }
    }
    return posts;
  }
}

// ---------------------------------------------------------------- RemoteOK

interface RemoteOkJob {
  id?: string;
  company?: string;
  position?: string;
  tags?: string[];
  location?: string;
  description?: string;
  url?: string;
  date?: string;
}

export class RemoteOkFeed implements JobFeed {
  readonly slug = 'remoteok';
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: JobFeedOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  async search(input: JobFeedSearch): Promise<readonly JobFeedPost[]> {
    const body = await getJson<RemoteOkJob[]>(
      this.#fetch,
      'https://remoteok.com/api?tag=dev',
      this.#timeoutMs,
      true,
    );
    const posts: JobFeedPost[] = [];
    // The first element is the API's legal notice, not a job.
    for (const job of body.slice(1)) {
      if (posts.length >= input.limit) break;
      if (!job.company || !job.url) continue;
      const description = stripHtml(job.description ?? '');
      const text = `${job.position ?? ''}\n${(job.tags ?? []).join(' ')}\n${description}`;
      if (!matchesJobKeyword(input.keyword, text)) continue;
      posts.push({
        feed: this.slug,
        url: job.url,
        company: job.company,
        title: job.position,
        location: job.location,
        text: text.slice(0, 4_000),
        postedAt: job.date,
        emails: [],
      });
    }
    return posts;
  }
}

// ------------------------------------------------------------------ Jobicy

interface JobicyJob {
  url?: string;
  jobTitle?: string;
  companyName?: string;
  jobGeo?: string;
  jobExcerpt?: string;
  pubDate?: string;
}

export class JobicyFeed implements JobFeed {
  readonly slug = 'jobicy';
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: JobFeedOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  async search(input: JobFeedSearch): Promise<readonly JobFeedPost[]> {
    const body = await getJson<{ jobs?: JobicyJob[] }>(
      this.#fetch,
      'https://jobicy.com/api/v2/remote-jobs?count=50&geo=usa&industry=dev',
      this.#timeoutMs,
    );
    const posts: JobFeedPost[] = [];
    for (const job of body.jobs ?? []) {
      if (posts.length >= input.limit) break;
      if (!job.companyName || !job.url) continue;
      const text = `${job.jobTitle ?? ''}\n${stripHtml(job.jobExcerpt ?? '')}`;
      if (!matchesJobKeyword(input.keyword, text)) continue;
      posts.push({
        feed: this.slug,
        url: job.url,
        company: job.companyName,
        title: job.jobTitle,
        location: job.jobGeo,
        text,
        postedAt: job.pubDate,
        emails: [],
      });
    }
    return posts;
  }
}

/** Every keyless job feed, in the order a run reads them. */
export function buildJobFeeds(options: JobFeedOptions = {}): JobFeed[] {
  return [
    new HnHiringFeed(options),
    new HimalayasFeed(options),
    new RemoteOkFeed(options),
    new JobicyFeed(options),
  ];
}
