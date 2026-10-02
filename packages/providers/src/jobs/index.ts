/**
 * Reading a job posting off the board that published it.
 *
 * Workable, Greenhouse, Lever and Ashby each publish their postings through a
 * keyless JSON API — the one their own embeddable job widgets use — so reading
 * one is a single GET, not a scrape. Anything else is read from the page's own
 * title and meta tags, which is less but is never wrong about what the page
 * says.
 *
 * Nothing here decides who to contact. It returns what the posting says, in
 * the posting's words, so the claim "you're hiring a senior engineer" is
 * grounded in a stored document.
 */

import { companyDomainFrom, parseJobUrl, type ParsedJobUrl } from '@outreachgraph/domain';

export interface JobPosting {
  readonly url: string;
  readonly title?: string | undefined;
  readonly company?: string | undefined;
  /** The company's own domain, when the board says what it is. */
  readonly companyDomain?: string | undefined;
  readonly location?: string | undefined;
  readonly remote?: boolean | undefined;
  readonly salary?: string | undefined;
  readonly postedAt?: string | undefined;
  /** Plain text, trimmed to `MAX_DESCRIPTION`. */
  readonly description?: string | undefined;
  /** The canonical URL, which may differ from the one given (an account-less Workable link). */
  readonly canonicalUrl?: string | undefined;
}

export interface JobReaderOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const MAX_DESCRIPTION = 6_000;
const USER_AGENT = 'OutreachGraph/1.0 (+https://outreachgraph.com)';

/** Read one posting. Throws when the board refuses or the posting is gone. */
export async function readJobPosting(
  parsed: ParsedJobUrl,
  options: JobReaderOptions = {},
): Promise<JobPosting> {
  const get = getter(options);

  switch (parsed.source) {
    case 'workable':
      return readWorkable(parsed, get);
    case 'greenhouse':
      return readGreenhouse(parsed, get);
    case 'lever':
      return readLever(parsed, get);
    case 'ashby':
      return readAshby(parsed, get);
    case 'other':
      return readPage(parsed.url, get);
  }
}

type Get = (url: string, init?: { redirect?: RequestRedirect }) => Promise<Response>;

function getter(options: JobReaderOptions): Get {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return async (url, init = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/html;q=0.9' },
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

async function json<T>(get: Get, url: string): Promise<T> {
  const response = await get(url);
  if (response.status === 404) throw new Error('the posting is gone (404)');
  if (!response.ok) throw new Error(`the board answered ${response.status} for ${url}`);
  return (await response.json()) as T;
}

// ------------------------------------------------------------------ workable

interface WorkableAccount {
  name?: string;
  url?: string;
}

interface WorkableJob {
  title?: string;
  remote?: boolean;
  workplace?: string;
  published?: string;
  location?: { city?: string; region?: string | null; country?: string };
  salary_from?: number;
  salary_to?: number;
  salary_currency_iso_code?: string;
  salary_frequency?: string;
  description?: string;
  requirements?: string;
}

async function readWorkable(parsed: ParsedJobUrl, get: Get): Promise<JobPosting> {
  let account = parsed.account;
  if (!account) {
    // apply.workable.com/j/CODE answers with a redirect naming the account.
    const response = await get(parsed.url, { redirect: 'manual' });
    const location = response.headers.get('location') ?? '';
    const resolved = parseJobUrl(new URL(location, parsed.url).toString());
    if ('reason' in resolved || !resolved.account) {
      throw new Error('workable did not say which company this posting belongs to');
    }
    account = resolved.account;
  }

  const base = `https://apply.workable.com/api`;
  const [company, job] = await Promise.all([
    json<WorkableAccount>(get, `${base}/v1/accounts/${encodeURIComponent(account)}`),
    json<WorkableJob>(
      get,
      `${base}/v2/accounts/${encodeURIComponent(account)}/jobs/${encodeURIComponent(parsed.jobId ?? '')}`,
    ),
  ]);

  const place = [job.location?.city, job.location?.region, job.location?.country]
    .filter(Boolean)
    .join(', ');
  const salary =
    job.salary_from || job.salary_to
      ? `${money(job.salary_from)}–${money(job.salary_to)} ${job.salary_currency_iso_code ?? ''} ${job.salary_frequency ? `per ${job.salary_frequency}` : ''}`
          .replace(/\s+/g, ' ')
          .trim()
      : undefined;

  return {
    url: parsed.url,
    canonicalUrl: `https://apply.workable.com/${account}/j/${parsed.jobId}/`,
    title: job.title,
    company: company.name,
    companyDomain: companyDomainFrom(company.url),
    location: place || undefined,
    remote: job.remote ?? job.workplace === 'remote',
    salary,
    postedAt: job.published,
    description: plain(`${job.description ?? ''}\n${job.requirements ?? ''}`),
  };
}

function money(value: number | undefined): string {
  return typeof value === 'number' ? value.toLocaleString('en-US') : '?';
}

// ---------------------------------------------------------------- greenhouse

interface GreenhouseJob {
  title?: string;
  company_name?: string;
  location?: { name?: string };
  first_published?: string;
  updated_at?: string;
  content?: string;
}

async function readGreenhouse(parsed: ParsedJobUrl, get: Get): Promise<JobPosting> {
  const job = await json<GreenhouseJob>(
    get,
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(parsed.account ?? '')}/jobs/${encodeURIComponent(parsed.jobId ?? '')}`,
  );
  const location = job.location?.name;
  return {
    url: parsed.url,
    title: job.title,
    company: job.company_name,
    location,
    remote: location ? /remote/i.test(location) : undefined,
    postedAt: job.first_published ?? job.updated_at,
    // Greenhouse escapes its HTML once more than it needs to.
    description: plain(decodeEntities(job.content ?? '')),
  };
}

// --------------------------------------------------------------------- lever

interface LeverJob {
  text?: string;
  categories?: { location?: string; commitment?: string };
  workplaceType?: string;
  createdAt?: number;
  descriptionPlain?: string;
  additionalPlain?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

async function readLever(parsed: ParsedJobUrl, get: Get): Promise<JobPosting> {
  const job = await json<LeverJob>(
    get,
    `https://api.lever.co/v0/postings/${encodeURIComponent(parsed.account ?? '')}/${encodeURIComponent(parsed.jobId ?? '')}`,
  );
  // Lever's API does not name the company. Its hosted page does, the other
  // way round from every other board: "Ethena - Senior Software Engineer",
  // and a header logo whose alt text is "Ethena logo".
  const html = await get(parsed.url)
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => '');
  const company =
    /class="main-header-logo"[^>]*>\s*<img[^>]*alt="([^"]+?) logo"/i.exec(html)?.[1] ??
    /<title>([^<]+?)\s+-\s+/i.exec(html)?.[1];
  const range = job.salaryRange;

  return {
    url: parsed.url,
    title: job.text,
    company: company ? decodeEntities(company).trim() : undefined,
    location: job.categories?.location,
    remote: job.workplaceType === 'remote' || /remote/i.test(job.categories?.location ?? ''),
    salary:
      range?.min || range?.max
        ? `${money(range.min)}–${money(range.max)} ${range.currency ?? ''} ${range.interval ?? ''}`
            .replace(/\s+/g, ' ')
            .trim()
        : undefined,
    postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : undefined,
    description: clip(`${job.descriptionPlain ?? ''}\n${job.additionalPlain ?? ''}`),
  };
}

// --------------------------------------------------------------------- ashby

interface AshbyJob {
  id?: string;
  title?: string;
  location?: string;
  isRemote?: boolean;
  publishedAt?: string;
  descriptionPlain?: string;
  compensation?: { compensationTierSummary?: string };
}

async function readAshby(parsed: ParsedJobUrl, get: Get): Promise<JobPosting> {
  const account = parsed.account ?? '';
  const [board, page] = await Promise.all([
    json<{ jobs?: AshbyJob[] }>(
      get,
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(account)}?includeCompensation=true`,
    ),
    get(`https://jobs.ashbyhq.com/${encodeURIComponent(account)}`).then((r) =>
      r.ok ? r.text() : '',
    ),
  ]);

  const job = board.jobs?.find((candidate) => candidate.id?.toLowerCase() === parsed.jobId);
  if (!job) throw new Error('the posting is gone (no longer on the company board)');

  // The board page embeds the organisation's name and public website.
  const organisation =
    /"organization":\{[^{}]*?"name":"([^"]+)"[^{}]*?"publicWebsite":"([^"]*)"/.exec(page);

  return {
    url: parsed.url,
    title: job.title,
    company: organisation?.[1] ? decodeJsonString(organisation[1]) : undefined,
    companyDomain: companyDomainFrom(organisation?.[2] ? decodeJsonString(organisation[2]) : ''),
    location: job.location,
    remote: job.isRemote,
    salary: job.compensation?.compensationTierSummary ?? undefined,
    postedAt: job.publishedAt,
    description: clip(job.descriptionPlain ?? ''),
  };
}

// ---------------------------------------------------------------- any page

async function readPage(url: string, get: Get): Promise<JobPosting> {
  const response = await get(url);
  if (!response.ok) throw new Error(`the page answered ${response.status}`);
  const html = await response.text();

  const meta = (name: string): string | undefined => {
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`,
      'i',
    );
    const reversed = new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`,
      'i',
    );
    const found = pattern.exec(html)?.[1] ?? reversed.exec(html)?.[1];
    return found ? decodeEntities(found).trim() || undefined : undefined;
  };

  const title =
    meta('og:title') ?? decodeEntities(/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '');
  // "Senior Software Engineer - Ethena" on Lever; "Role @ Company" on Ashby.
  const split = /^(.*?)\s+(?:-|–|@|at|\|)\s+([^-–@|]+)$/.exec(title.trim());
  const company = meta('og:site_name') ?? split?.[2]?.trim();

  return {
    url,
    title: split?.[1]?.trim() || title.trim() || undefined,
    company: company || undefined,
    description: clip(meta('og:description') ?? meta('description') ?? ''),
  };
}

// --------------------------------------------------------------- addresses

/** Pages on a company's site that most often name its people. */
const COMPANY_PAGES = ['/', '/company', '/about', '/team', '/about-us', '/contact'];

/** Visible text kept per site: enough for a team page, not a whole blog. */
const MAX_SITE_TEXT = 60_000;

export interface CompanySite {
  /** Addresses at the company's domain, published on its own pages. */
  readonly emails: readonly string[];
  /** The pages' visible text, for checking who the company itself names. */
  readonly text: string;
}

/**
 * What the company says about itself on its own site.
 *
 * Two uses, both as evidence the company put there: a founder's own published
 * address ("Write to David at david@raydar.xyz") attaches to the founder, and
 * a name on the team page tells the Raydar that recruits engineers from the
 * Raydar that produces music, which a LinkedIn search result cannot.
 */
export async function readCompanySite(
  domain: string,
  options: JobReaderOptions = {},
): Promise<CompanySite> {
  const get = getter({ timeoutMs: 10_000, ...options });
  const found = new Set<string>();
  const texts: string[] = [];
  const pattern = /[a-z0-9._%+-]+@([a-z0-9-]+\.)+[a-z]{2,}/gi;

  // Team pages live wherever the site put them; its sitemap says where.
  const fromSitemap = await get(`https://${domain}/sitemap.xml`)
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => '');
  const extra = [...fromSitemap.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
    .map((m) => m[1] ?? '')
    .filter((loc) => /\/(about|team|people|leadership|company|founders?)(\/|-|$)/i.test(loc))
    .map((loc) => {
      try {
        const url = new URL(loc);
        const host = url.hostname.replace(/^www\./, '');
        return host === domain ? url.pathname : undefined;
      } catch {
        return undefined;
      }
    })
    .filter((path): path is string => Boolean(path) && !COMPANY_PAGES.includes(path!))
    .slice(0, 3);

  await Promise.all(
    [...COMPANY_PAGES, ...extra].map(async (path) => {
      try {
        const response = await get(`https://${domain}${path}`);
        if (!response.ok) return;
        const html = await response.text();
        for (const match of html.matchAll(pattern)) {
          const address = match[0].toLowerCase();
          const host = address.split('@')[1] ?? '';
          if (host === domain || host.endsWith(`.${domain}`)) found.add(address);
        }
        texts.push(plain(html.slice(0, 500_000), MAX_SITE_TEXT) ?? '');
      } catch {
        // One page refusing costs that page, not the others.
      }
    }),
  );
  return { emails: [...found].sort(), text: texts.join('\n').slice(0, MAX_SITE_TEXT) };
}

// --------------------------------------------------------------------- text

function plain(html: string, max = MAX_DESCRIPTION): string | undefined {
  const text = decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6])>|<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' '),
  );
  return clip(text, max);
}

function clip(text: string, max = MAX_DESCRIPTION): string | undefined {
  const cleaned = text
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}
