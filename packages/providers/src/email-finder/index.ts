/**
 * Free-tier email finding: a person's address at their employer's domain.
 *
 * Three sources, all optional and all behind their own key:
 *
 *   - **Serper** (`SERPER_API_KEY`, 2,500 free searches): Google for the
 *     person's name next to `@domain`, keeping only addresses a page published.
 *   - **Hunter** (`HUNTER_API_KEY`, 50 finds a month free): its email finder,
 *     which answers with a score and its own verification status.
 *   - **ContactOut** (`CONTACTOUT_API_KEY`, 30 credits once): after the credits
 *     run out it still answers HTTP 200, with a sample profile of somebody else
 *     ("This is a sample response"). That body is treated as out of credits,
 *     never as data.
 *
 * None of them decides anything. Every address found here is checked against
 * the person's name and the domain's mail servers by `find_email` before the
 * sender can use it.
 */

import { SearchOutOfCredits, type WebResult, type WebSearcher } from '../valueserp';

export interface FinderQuery {
  readonly firstName: string;
  readonly lastName: string;
  readonly domain: string;
  readonly companyName?: string;
}

export interface FinderAnswer {
  readonly address: string;
  /** The provider's own confidence, 0..1. */
  readonly score: number;
  /** What the provider says about deliverability, when it says anything. */
  readonly status?: 'valid' | 'accept_all' | 'unknown' | 'invalid';
}

export interface EmailFinder {
  readonly name: string;
  /** One person, or undefined for no answer. Throws SearchOutOfCredits when spent. */
  find(query: FinderQuery): Promise<FinderAnswer | undefined>;
}

interface ClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const EMAIL = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

/** Every address at `domain` in a piece of text, lowercased. */
export function addressesAt(text: string, domain: string): string[] {
  const host = domain.toLowerCase();
  const found = new Set<string>();
  for (const match of text.matchAll(EMAIL)) {
    const address = match[0].toLowerCase().replace(/\.+$/, '');
    if (address.endsWith(`@${host}`)) found.add(address);
  }
  return [...found];
}

/** Reads a JSON body, or throws: a Cloudflare challenge page is not an answer. */
async function jsonBody(response: Response, provider: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${provider} answered ${response.status} with a non-JSON page`);
  }
}

// ----------------------------------------------------------------- Serper

/** Google web search through serper.dev. Implements the same interface as ValueSERP. */
export class SerperClient implements WebSearcher {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://google.serper.dev').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async search(
    query: string,
    options: { num?: number; period?: 'last_day' | 'last_week' | 'last_month' } = {},
  ): Promise<readonly WebResult[]> {
    const tbs = { last_day: 'qdr:d', last_week: 'qdr:w', last_month: 'qdr:m' } as const;
    const response = await this.fetchImpl(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: { 'X-API-KEY': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        q: query,
        num: Math.min(Math.max(options.num ?? 10, 1), 100),
        ...(options.period ? { tbs: tbs[options.period] } : {}),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // Serper says 400 "Not enough credits" rather than 402.
    if (response.status === 402) throw new SearchOutOfCredits('Serper');
    const body = (await jsonBody(response, 'Serper')) as {
      organic?: { title?: unknown; link?: unknown; snippet?: unknown }[];
      message?: unknown;
    };
    if (!response.ok) {
      const message = typeof body.message === 'string' ? body.message : '';
      if (/credits/i.test(message)) throw new SearchOutOfCredits('Serper');
      throw new Error(`Serper refused the search (${response.status}): ${message || 'no reason'}`);
    }
    return (Array.isArray(body.organic) ? body.organic : []).map((result) => ({
      ...(typeof result.title === 'string' ? { title: result.title } : {}),
      ...(typeof result.link === 'string' ? { link: result.link } : {}),
      ...(typeof result.snippet === 'string' ? { snippet: result.snippet } : {}),
    }));
  }
}

/**
 * The person's address as a public page printed it.
 *
 * One search, `"First Last" "@domain"`. Only addresses at the domain are kept;
 * which of them is this person is decided by the caller against their name.
 */
export class PublishedEmailFinder implements EmailFinder {
  readonly name: string;
  constructor(
    private readonly searcher: WebSearcher,
    name = 'search',
  ) {
    this.name = name;
  }

  async find(query: FinderQuery): Promise<FinderAnswer | undefined> {
    const results = await this.searcher.search(
      `"${query.firstName} ${query.lastName}" "@${query.domain}"`,
      { num: 10 },
    );
    const text = results.map((result) => `${result.title ?? ''} ${result.snippet ?? ''}`).join(' ');
    const first = query.firstName.toLowerCase();
    const last = query.lastName.toLowerCase();
    // The address that carries part of their name; a page listing a colleague
    // next to them does not make the colleague's address theirs.
    const address = addressesAt(text, query.domain).find((candidate) => {
      const local = candidate.slice(0, candidate.indexOf('@'));
      return local.includes(last) || local.includes(first);
    });
    return address ? { address, score: 0.8 } : undefined;
  }
}

// ----------------------------------------------------------------- Hunter

export class HunterEmailFinder implements EmailFinder {
  readonly name = 'hunter';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.hunter.io').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async find(query: FinderQuery): Promise<FinderAnswer | undefined> {
    const url = new URL('/v2/email-finder', this.baseUrl);
    url.searchParams.set('domain', query.domain);
    url.searchParams.set('first_name', query.firstName);
    url.searchParams.set('last_name', query.lastName);
    url.searchParams.set('api_key', this.apiKey);

    const response = await this.fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) return undefined;
    // 429 on the free plan means the month's finds are spent.
    if (response.status === 402 || response.status === 429) {
      throw new SearchOutOfCredits('Hunter');
    }
    const body = (await jsonBody(response, 'Hunter')) as {
      data?: { email?: unknown; score?: unknown; verification?: { status?: unknown } };
    };
    if (!response.ok) throw new Error(`Hunter answered ${response.status}`);

    const email = body.data?.email;
    if (typeof email !== 'string' || !email.includes('@')) return undefined;
    const status = body.data?.verification?.status;
    return {
      address: email.trim().toLowerCase(),
      score: typeof body.data?.score === 'number' ? body.data.score / 100 : 0.5,
      ...(status === 'valid' || status === 'accept_all' || status === 'invalid'
        ? { status }
        : { status: 'unknown' as const }),
    };
  }
}

// -------------------------------------------------------------- ContactOut

/** ContactOut's placeholder body once credits are spent: HTTP 200, someone else's profile. */
export function isContactOutSample(body: unknown): boolean {
  return /sample response/i.test(JSON.stringify(body ?? ''));
}

export class ContactOutEmailFinder implements EmailFinder {
  readonly name = 'contactout';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.contactout.com').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async find(query: FinderQuery): Promise<FinderAnswer | undefined> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/people/enrich`, {
      method: 'POST',
      headers: { token: this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        full_name: `${query.firstName} ${query.lastName}`,
        ...(query.companyName ? { company: [query.companyName] } : {}),
        company_domain: [query.domain],
        include: ['work_email'],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) return undefined;
    if (response.status === 402 || response.status === 429) {
      throw new SearchOutOfCredits('ContactOut');
    }
    const body = await jsonBody(response, 'ContactOut');
    // The trap: a 200 whose profile is a sample. Out of credits, not a match.
    if (isContactOutSample(body)) throw new SearchOutOfCredits('ContactOut');
    if (!response.ok) throw new Error(`ContactOut answered ${response.status}`);

    const address = addressesAt(JSON.stringify(body), query.domain)[0];
    return address ? { address, score: 0.7 } : undefined;
  }
}
