/**
 * seo.rank: an on-page SEO audit of one URL (github.com/moshcoder/seo.rank).
 *
 * Our own service, on the same box. OutreachGraph calls it with an API key,
 * which skips the public 10-a-day limit and has its own daily cap, and asks
 * for the small `fields=summary` answer: score, grade, the top fixes, when.
 *
 * Errors are sorted into the three things a caller does differently:
 *
 *   - `SeoRankRefused`: the site's answer (400 refused/invalid, 422 the audit
 *     itself failed: unreachable, not HTML). Retrying soon changes nothing.
 *   - `SeoRankUnavailable`: seo.rank is out of capacity for now (429 daily cap,
 *     503 busy or capped). Not this site's fault; hold everything and wait.
 *   - anything else (5xx, a dropped connection, a timeout): transient, retry
 *     with backoff.
 */

export interface SeoRankFix {
  readonly id: string;
  readonly label: string;
  readonly priority: 'high' | 'medium' | 'low';
  readonly fix: string;
}

export interface SeoRankAudit {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly score: number;
  readonly grade: string;
  readonly summary: { readonly pass: number; readonly warn: number; readonly fail: number };
  readonly fixes: readonly SeoRankFix[];
  readonly checkedAt: string;
}

export interface SeoRankAuditor {
  audit(url: string): Promise<SeoRankAudit>;
}

export class SeoRankRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SeoRankRefused';
  }
}

export class SeoRankUnavailable extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Seconds, from Retry-After. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'SeoRankUnavailable';
  }
}

export interface SeoRankOptions {
  readonly apiKey: string;
  /** Default http://127.0.0.1:8790, the listener on dev2. */
  readonly baseUrl?: string;
  /**
   * A Host header to send, for reaching seo.rank through a local nginx by
   * address (from a container, the docker bridge gateway) rather than by name:
   * seo.rank is a Moshpit name that dev2's resolver does not know.
   */
  readonly host?: string;
  /** How many fixes to ask for. */
  readonly top?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export class SeoRankClient implements SeoRankAuditor {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: SeoRankOptions) {
    this.base = (options.baseUrl ?? 'http://127.0.0.1:8790').replace(/\/+$/, '');
    this.doFetch = options.fetch ?? fetch;
  }

  async audit(url: string): Promise<SeoRankAudit> {
    const query = new URLSearchParams({
      url,
      fields: 'summary',
      top: String(this.options.top ?? 5),
    });
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.options.apiKey}`,
    };
    if (this.options.host) headers.host = this.options.host;

    // An audit fetches the page, robots.txt, a sitemap and the http check; the
    // server's own caps are 12 s per fetch, so 45 s is generous, not hopeful.
    const response = await this.doFetch(`${this.base}/api/audit?${query}`, {
      headers,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 45_000),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      typeof body.error === 'string' ? body.error : `seo.rank answered ${response.status}`;

    if (response.ok) return parseAudit(body);
    if (response.status === 400 || response.status === 422) {
      throw new SeoRankRefused(message, response.status);
    }
    if (response.status === 429 || response.status === 503) {
      const retry = Number(response.headers.get('retry-after'));
      throw new SeoRankUnavailable(
        message,
        response.status,
        Number.isFinite(retry) && retry > 0 ? retry : undefined,
      );
    }
    // 401 means our key is wrong: a configuration fault every job shares, so it
    // holds the queue like an outage rather than burning each job's attempts.
    if (response.status === 401) throw new SeoRankUnavailable(message, 401);
    throw new Error(message);
  }
}

function parseAudit(body: Record<string, unknown>): SeoRankAudit {
  const summary = (body.summary ?? {}) as Record<string, unknown>;
  const fixes = Array.isArray(body.fixes) ? body.fixes : [];
  if (typeof body.score !== 'number') throw new Error('seo.rank returned no score');
  return {
    url: String(body.url ?? ''),
    finalUrl: String(body.finalUrl ?? body.url ?? ''),
    status: Number(body.status ?? 0),
    score: body.score,
    grade: String(body.grade ?? ''),
    summary: {
      pass: Number(summary.pass ?? 0),
      warn: Number(summary.warn ?? 0),
      fail: Number(summary.fail ?? 0),
    },
    fixes: fixes
      .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
      .map((f) => ({
        id: String(f.id ?? ''),
        label: String(f.label ?? ''),
        priority: (['high', 'medium', 'low'].includes(String(f.priority))
          ? f.priority
          : 'low') as SeoRankFix['priority'],
        fix: String(f.fix ?? ''),
      })),
    checkedAt: String(body.checkedAt ?? new Date().toISOString()),
  };
}
