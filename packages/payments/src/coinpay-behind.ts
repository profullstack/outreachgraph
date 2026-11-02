/**
 * The customer's own CoinPay account, read for who is behind on paying them.
 *
 * Not the billing client in `coinpay.ts`: that one is OutreachGraph's merchant
 * account, selling credits. This one carries a key the *workspace* pasted in
 * and reads one endpoint, `GET /api/payments/behind`, which joins the
 * merchant's overdue invoices and declined card payments per customer and says
 * what to do about each. Read-only: nothing here can move money or send mail.
 *
 * The report shape is copied from coinpayportal `src/lib/payments/behind.ts`
 * and trimmed to what Today shows. Unknown fields are ignored, so the portal
 * may grow the report without breaking this side.
 */

const DEFAULT_BASE_URL = 'https://coinpayportal.com/api';

export type BehindAction =
  | 'do_not_chase'
  | 'unreachable'
  | 'retry'
  | 'new_card'
  | 'unfinished'
  | 'call_bank'
  | 'chase'
  | 'remind';

export interface BehindItem {
  readonly kind: 'invoice' | 'card';
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly date: string;
  readonly title: string;
  readonly detail: string;
  /** Path on the CoinPay portal, e.g. `/invoices/<id>`. */
  readonly href: string;
}

export interface BehindCustomer {
  readonly key: string;
  readonly name: string;
  readonly email: string | null;
  readonly business_name: string | null;
  readonly action: BehindAction;
  readonly owed: ReadonlyArray<{ currency: string; amount: number }>;
  readonly items: readonly BehindItem[];
  readonly history: { readonly line: string; readonly paid_count: number };
}

export interface BehindGroup {
  readonly action: BehindAction;
  readonly title: string;
  readonly todo: string;
  readonly customers: readonly BehindCustomer[];
}

export interface BehindReport {
  readonly as_of: string;
  readonly summary: string;
  readonly totals: ReadonlyArray<{ currency: string; amount: number }>;
  readonly counts: { customers: number; invoices: number; card_failures: number };
  readonly groups: readonly BehindGroup[];
}

export class CoinPayMerchantError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CoinPayMerchantError';
    this.status = status;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CoinPayMerchantConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  /** Per request, in ms (default 15s). */
  readonly timeoutMs?: number;
}

export class CoinPayMerchant {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(config: CoinPayMerchantConfig) {
    this.apiKey = config.apiKey.trim();
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  /** The portal origin, for links back to an invoice or card payment. */
  get portalUrl(): string {
    return this.baseUrl.replace(/\/api$/, '');
  }

  /** Who is behind. `days` is how far back a declined card still counts. */
  async behind(options: { businessId?: string; days?: number } = {}): Promise<BehindReport> {
    const params = new URLSearchParams();
    if (options.businessId) params.set('business_id', options.businessId);
    if (options.days) params.set('days', String(options.days));
    const qs = params.toString();

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/payments/behind${qs ? `?${qs}` : ''}`, {
        headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new CoinPayMerchantError(
        `CoinPay could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    }

    const body = (await response.json().catch(() => ({}))) as Partial<BehindReport> & {
      success?: boolean;
      error?: string;
    };

    if (response.status === 401 || response.status === 403) {
      throw new CoinPayMerchantError(
        'CoinPay refused the API key. Create a new one under Businesses > API keys.',
        response.status,
      );
    }
    if (!response.ok || body.success === false || !Array.isArray(body.groups)) {
      throw new CoinPayMerchantError(
        `CoinPay ${response.status}: ${body.error ?? 'unexpected response'}`,
        response.ok ? 502 : response.status,
      );
    }

    return {
      as_of: String(body.as_of ?? new Date().toISOString()),
      summary: String(body.summary ?? ''),
      totals: body.totals ?? [],
      counts: body.counts ?? { customers: 0, invoices: 0, card_failures: 0 },
      groups: body.groups,
    };
  }
}
