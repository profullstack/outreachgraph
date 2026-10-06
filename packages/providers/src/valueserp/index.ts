/**
 * ValueSERP: a picture of the person, found the way a human would find one.
 *
 * Given a name, a title and a company, a person searches Google Images and
 * takes the headshot from the LinkedIn profile or the company's team page.
 * This does the same through a search API, and it is deliberately no cleverer
 * than that: one query, the first result whose page corroborates the person,
 * nothing otherwise.
 *
 * What makes it precise rather than merely plausible is the page the image
 * sits on, not the image. A picture is accepted only when it was published on
 * a LinkedIn profile whose title carries the person's name, or on the
 * company's own domain. "A face that came up for this name" is not evidence of
 * anything; "the picture on the team page of the company we already know they
 * work at" is. Identity precision beats recall (PRD §9), and a wrong face on a
 * lead is worse than no face.
 *
 * This reads search results. It never fetches LinkedIn itself, never logs in,
 * and never acts there — the human still does that in LinkedIn's own
 * interface. What it records is research: a URL the person published under
 * their own name.
 */

export interface ProfilePhotoQuery {
  readonly name: string;
  readonly title?: string | undefined;
  readonly company?: string | undefined;
  /** The company's own domain; a picture published there is accepted. */
  readonly companyDomain?: string | undefined;
}

export interface ProfilePhoto {
  readonly photoUrl: string;
  /** The page the picture was published on — the corroborating evidence. */
  readonly pageUrl: string;
  readonly source: 'linkedin' | 'site';
}

export interface ProfilePhotoFinder {
  findProfilePhoto(query: ProfilePhotoQuery): Promise<ProfilePhoto | undefined>;
}

/** One Google web result, as much of it as a caller reads. */
export interface WebResult {
  readonly title?: string | undefined;
  readonly link?: string | undefined;
  readonly snippet?: string | undefined;
}

/** Google web search, for the job-post intake: postings by keyword, people by company. */
export interface WebSearcher {
  /**
   * One query. Unlike the photo lookup this throws on a refusal: a keyword
   * search the operator is waiting on must say "out of credits" rather than
   * "found nothing".
   */
  search(query: string, options?: { num?: number }): Promise<readonly WebResult[]>;
}

export interface ValueSerpOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly searchTimeoutMs?: number;
}

const DEFAULT_BASE = 'https://api.valueserp.com';

/** A paid provider answered HTTP 402: no credits left, so stop asking. */
export class SearchOutOfCredits extends Error {
  readonly provider: string;
  constructor(provider: string) {
    super(`${provider} is out of credits (HTTP 402)`);
    this.name = 'SearchOutOfCredits';
    this.provider = provider;
  }
}

/** One image result, as much of it as this adapter reads. */
interface ImageResult {
  readonly title?: string;
  readonly link?: string;
  readonly image?: string;
  readonly original?: string;
  readonly thumbnail?: string;
  readonly domain?: string;
  readonly source?: string;
}

export class ValueSerpClient implements ProfilePhotoFinder, WebSearcher {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** Web search returns ten times the data an image lookup does, and ValueSERP can take 30 s. */
  private readonly searchTimeoutMs: number;

  constructor(options: ValueSerpOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.searchTimeoutMs = options.searchTimeoutMs ?? 60_000;
  }

  async search(query: string, options: { num?: number } = {}): Promise<readonly WebResult[]> {
    const url = new URL('/search', this.baseUrl);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(Math.min(Math.max(options.num ?? 20, 1), 100)));
    url.searchParams.set('gl', 'us');
    url.searchParams.set('hl', 'en');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.searchTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      const body = (await response.json().catch(() => ({}))) as {
        organic_results?: { title?: unknown; link?: unknown; snippet?: unknown }[];
        request_info?: { success?: boolean; message?: string };
      };
      // Out of credits is not a miss: every search after it would fail too, so
      // a sweep stops on it rather than stamping people as looked up.
      if (response.status === 402) throw new SearchOutOfCredits('ValueSERP');
      if (!response.ok || body.request_info?.success === false) {
        throw new Error(
          `ValueSERP refused the search (${response.status}): ${body.request_info?.message ?? 'no reason given'}`,
        );
      }
      const results = Array.isArray(body.organic_results) ? body.organic_results : [];
      return results.map((result) => ({
        ...(typeof result.title === 'string' ? { title: result.title } : {}),
        ...(typeof result.link === 'string' ? { link: result.link } : {}),
        ...(typeof result.snippet === 'string' ? { snippet: result.snippet } : {}),
      }));
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`ValueSERP did not answer within ${this.searchTimeoutMs / 1000} s`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One search, one answer, or none.
   *
   * A miss is the common case and costs a credit either way, which is why the
   * caller stamps the person as looked up regardless. Network failures are a
   * miss too: this runs in a sweep, and one flaky response should cost that
   * person's picture, not the run.
   */
  async findProfilePhoto(query: ProfilePhotoQuery): Promise<ProfilePhoto | undefined> {
    const name = query.name.trim();
    if (!name) return undefined;

    const terms = [`"${name}"`, query.company?.trim(), query.title?.trim()].filter(Boolean);

    const url = new URL('/search', this.baseUrl);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('search_type', 'images');
    url.searchParams.set('q', terms.join(' '));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return undefined;

      const body = (await response.json()) as { image_results?: ImageResult[] };
      const results = Array.isArray(body.image_results) ? body.image_results : [];

      for (const result of results) {
        const match = corroborate(result, query);
        if (match) return match;
      }

      return undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Whether one result is evidence enough.
 *
 * Exported for the tests and for anyone auditing what "corroborated" means:
 * the page is a LinkedIn profile titled with the person's name, or the page is
 * on the company's own domain and titled with their name.
 */
export function corroborate(
  result: ImageResult,
  query: ProfilePhotoQuery,
): ProfilePhoto | undefined {
  const photoUrl = firstHttp(result.image, result.original, result.thumbnail);
  const pageUrl = firstHttp(result.link, result.source);
  if (!photoUrl || !pageUrl) return undefined;

  const title = result.title ?? '';
  if (!carriesName(title, query.name)) return undefined;

  let host: string;
  let path: string;
  try {
    const page = new URL(pageUrl);
    host = page.hostname.toLowerCase();
    path = page.pathname;
  } catch {
    return undefined;
  }

  if (isLinkedInProfile(host, path)) return { photoUrl, pageUrl, source: 'linkedin' };

  const domain = query.companyDomain
    ?.trim()
    .toLowerCase()
    .replace(/^www\./, '');
  if (domain && (host === domain || host.endsWith(`.${domain}`))) {
    return { photoUrl, pageUrl, source: 'site' };
  }

  return undefined;
}

/** `linkedin.com/in/<slug>` on any LinkedIn host — a profile, not a company page. */
export function isLinkedInProfile(host: string, path: string): boolean {
  const onLinkedIn = host === 'linkedin.com' || host.endsWith('.linkedin.com');
  return onLinkedIn && /^\/in\/[^/]+/.test(path);
}

/**
 * Every part of the name that could be a name, present in the title.
 *
 * Initials and particles ("J", "de") are too short to mean anything and are
 * not required; "Mark Ramsey" needs both `mark` and `ramsey`. Case and
 * diacritics are folded so "Klaudia Majcher" matches "KLAUDIA MAJCHER" and
 * "Stefan Wienold" matches a title that spells it with a different accent.
 */
export function carriesName(title: string, name: string): boolean {
  const haystack = fold(title);
  const parts = fold(name)
    .split(/[\s,]+/)
    .filter((part) => part.length >= 2);

  if (parts.length === 0) return false;
  return parts.every((part) => haystack.includes(part));
}

function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function firstHttp(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) return candidate;
  }
  return undefined;
}
