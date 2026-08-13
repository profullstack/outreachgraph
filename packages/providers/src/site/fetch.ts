/**
 * The bounded page fetcher.
 *
 * Every limit here exists because the alternative is a worker that a single
 * hostile or broken URL can hold forever: a redirect loop, a response that
 * never ends, a host that accepts the connection and then goes quiet.
 *
 * The user agent names the product and carries a contact URL. That is the only
 * way an operator who does not want us can tell us so, and it is the difference
 * between a crawler and an unattributed scraper.
 */

import { isAllowed, parseRobots, type RobotsRules } from './robots';

export const USER_AGENT =
  'OutreachGraphBot/0.1 (+https://outreachgraph.com/bot; research retrieval)';

const MAX_REDIRECTS = 5;
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;

export type FetchOutcome =
  'ok' | 'robots_denied' | 'not_html' | 'too_large' | 'unreachable' | 'http_error';

export interface FetchedPage {
  readonly outcome: FetchOutcome;
  /** Where the body actually came from, after redirects. */
  readonly finalUrl: string;
  readonly status?: number;
  readonly html?: string;
  readonly contentHash?: string;
  readonly fetchedAt: string;
  readonly detail?: string;
  /** What the site asked for between requests, if it said. */
  readonly crawlDelaySeconds?: number;
}

/**
 * Just enough of `fetch` to make the call.
 *
 * Not `typeof fetch`: Bun's global carries extras such as `preconnect`, and
 * requiring those would mean a test stub has to impersonate the runtime rather
 * than answer a request.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FetchOptions {
  readonly userAgent?: string;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  /** Injected in tests; defaults to global fetch. */
  readonly fetchImpl?: FetchLike;
  /** Skips the robots round trip when the caller already has the rules. */
  readonly robots?: RobotsRules;
}

/** SHA-256 of the body, so an unchanged page can be recognised and skipped. */
async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Reads robots.txt for an origin.
 *
 * A missing or unreadable file means "no rules", not "deny everything" — the
 * overwhelming majority of sites have no robots.txt and every one of them is
 * fetchable. A 5xx is treated the same way rather than as a temporary block,
 * which is a deliberate simplification worth revisiting if it ever bites.
 */
export async function loadRobots(origin: string, options: FetchOptions = {}): Promise<RobotsRules> {
  const doFetch = options.fetchImpl ?? fetch;
  const agent = options.userAgent ?? USER_AGENT;

  try {
    const response = await doFetch(new URL('/robots.txt', origin).toString(), {
      headers: { 'user-agent': agent, accept: 'text/plain' },
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });

    if (!response.ok) return { disallow: [], allow: [] };
    return parseRobots(await response.text(), agent);
  } catch {
    return { disallow: [], allow: [] };
  }
}

/**
 * Fetches one page, or explains why it did not.
 *
 * Never throws for an expected refusal. A blocked or unreachable URL is an
 * outcome the caller records against the batch, not an exception that fails a
 * hundred other URLs alongside it.
 */
export async function fetchPage(url: string, options: FetchOptions = {}): Promise<FetchedPage> {
  const doFetch = options.fetchImpl ?? fetch;
  const agent = options.userAgent ?? USER_AGENT;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const fetchedAt = new Date().toISOString();

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { outcome: 'unreachable', finalUrl: url, fetchedAt, detail: 'not a url' };
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { outcome: 'unreachable', finalUrl: url, fetchedAt, detail: 'unsupported scheme' };
  }

  const robots = options.robots ?? (await loadRobots(target.origin, options));
  if (!isAllowed(robots, target.pathname)) {
    return {
      outcome: 'robots_denied',
      finalUrl: target.toString(),
      fetchedAt,
      detail: 'robots.txt disallows this path',
      ...(robots.crawlDelaySeconds === undefined
        ? {}
        : { crawlDelaySeconds: robots.crawlDelaySeconds }),
    };
  }

  // Redirects are followed by hand so each hop can be re-checked against
  // robots: a site that allows `/` and denies `/app` should not be crawled at
  // `/app` merely because `/` redirected there.
  let current = target;
  let response: Response | undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    try {
      response = await doFetch(current.toString(), {
        headers: { 'user-agent': agent, accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (error) {
      return {
        outcome: 'unreachable',
        finalUrl: current.toString(),
        fetchedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    if (response.status < 300 || response.status >= 400) break;

    const location = response.headers.get('location');
    if (!location) break;

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return {
        outcome: 'http_error',
        finalUrl: current.toString(),
        fetchedAt,
        status: response.status,
      };
    }

    // A redirect off the origin needs that origin's own robots.
    const hopRules =
      next.origin === current.origin ? robots : await loadRobots(next.origin, options);
    if (!isAllowed(hopRules, next.pathname)) {
      return {
        outcome: 'robots_denied',
        finalUrl: next.toString(),
        fetchedAt,
        detail: 'redirect target is disallowed',
      };
    }

    current = next;

    if (hop === MAX_REDIRECTS) {
      return {
        outcome: 'http_error',
        finalUrl: current.toString(),
        fetchedAt,
        detail: 'too many redirects',
      };
    }
  }

  if (!response) {
    return { outcome: 'unreachable', finalUrl: current.toString(), fetchedAt };
  }

  if (!response.ok) {
    return {
      outcome: 'http_error',
      finalUrl: current.toString(),
      status: response.status,
      fetchedAt,
      detail: `http ${response.status}`,
    };
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    return {
      outcome: 'not_html',
      finalUrl: current.toString(),
      status: response.status,
      fetchedAt,
      detail: contentType,
    };
  }

  // Trust the declared length when it is present and absurd, but do not trust
  // its absence — the body is measured after reading either way.
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    return {
      outcome: 'too_large',
      finalUrl: current.toString(),
      status: response.status,
      fetchedAt,
      detail: `${declared} bytes`,
    };
  }

  let html: string;
  try {
    html = await response.text();
  } catch (error) {
    return {
      outcome: 'unreachable',
      finalUrl: current.toString(),
      fetchedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (html.length > maxBytes) {
    return {
      outcome: 'too_large',
      finalUrl: current.toString(),
      status: response.status,
      fetchedAt,
      detail: `${html.length} bytes`,
    };
  }

  return {
    outcome: 'ok',
    finalUrl: current.toString(),
    status: response.status,
    html,
    contentHash: await hash(html),
    fetchedAt,
    ...(robots.crawlDelaySeconds === undefined
      ? {}
      : { crawlDelaySeconds: robots.crawlDelaySeconds }),
  };
}
