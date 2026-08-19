/**
 * CoinPayPortal, the rail credits are bought over.
 *
 * Crypto rather than cards, and that is a product decision worth stating: the
 * people this tool is sold to are frequently the ones a card processor is
 * least willing to underwrite — cold outreach sits close enough to categories
 * that acquirers decline, and a payment rail that can freeze the account is a
 * rail that can end the business on somebody else's risk model. A settled
 * chain payment cannot be reversed six weeks later by a chargeback either,
 * which for a prepaid consumable is the whole ballgame.
 *
 * The client is deliberately thin. CoinPayPortal hosts the checkout page, so
 * we never see a wallet, never hold a key and never quote an exchange rate;
 * we create a payment for a USD amount, send the customer to the hosted page,
 * and wait to be told it confirmed.
 */

/**
 * Chain identifiers, in the vocabulary CoinPayPortal actually speaks.
 *
 * These are ticker codes, not chain names, and the difference is not cosmetic:
 * `/api/payments/create` does `blockchain.toUpperCase()` and matches the result
 * against this exact set, so `"bitcoin"` becomes `"BITCOIN"`, matches nothing,
 * and the request is refused with "Invalid or missing cryptocurrency type" —
 * *after* a valid API key has been accepted. The failure therefore looks like
 * a credentials problem and is not one.
 *
 * Stablecoins carry their settlement chain because the same dollar exists on
 * three of them and they are separate wallets: `USDC_SOL` and `USDC_ETH` are
 * not interchangeable, and a payment quoted against the wrong one is
 * unspendable.
 */
export type Blockchain =
  | 'BTC'
  | 'BCH'
  | 'ETH'
  | 'POL'
  | 'SOL'
  | 'DOGE'
  | 'XRP'
  | 'ADA'
  | 'BNB'
  | 'USDC_ETH'
  | 'USDC_POL'
  | 'USDC_SOL'
  | 'USDT_ETH'
  | 'USDT_POL'
  | 'USDT_SOL';

/**
 * What this deployment will offer.
 *
 * Deliberately not every chain CoinPayPortal can parse. A payment only
 * completes if a wallet exists for that currency — business, merchant-global,
 * or a linked web wallet — and a chain with none fails with "No wallet
 * configured for this business", which the customer reads as the product being
 * broken. `USDC_BASE` is a valid code on the portal and is absent here for
 * exactly that reason.
 */
export const BLOCKCHAINS: readonly Blockchain[] = [
  'BTC',
  'ETH',
  'SOL',
  'POL',
  'USDC_ETH',
  'USDC_POL',
  'USDC_SOL',
  'USDT_ETH',
  'USDT_POL',
  'USDT_SOL',
  'BCH',
  'DOGE',
  'XRP',
  'ADA',
  'BNB',
];

/**
 * Accepts a chain code case-insensitively.
 *
 * The portal upper-cases before matching, so a UI sending `usdc_sol` is not
 * wrong — it is the same request. Normalising here keeps that from being a
 * 400 that nobody can explain.
 */
export function isBlockchain(value: string): value is Blockchain {
  return (BLOCKCHAINS as readonly string[]).includes(value.toUpperCase());
}

/** The canonical form to send. */
export function normaliseBlockchain(value: string): Blockchain | undefined {
  const upper = value.toUpperCase();
  return (BLOCKCHAINS as readonly string[]).includes(upper) ? (upper as Blockchain) : undefined;
}

/** Human labels, so the picker does not read as a list of ticker symbols. */
export const BLOCKCHAIN_LABELS: Readonly<Record<Blockchain, string>> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  POL: 'Polygon',
  USDC_ETH: 'USDC on Ethereum',
  USDC_POL: 'USDC on Polygon',
  USDC_SOL: 'USDC on Solana',
  USDT_ETH: 'USDT on Ethereum',
  USDT_POL: 'USDT on Polygon',
  USDT_SOL: 'USDT on Solana',
  BCH: 'Bitcoin Cash',
  DOGE: 'Dogecoin',
  XRP: 'XRP',
  ADA: 'Cardano',
  BNB: 'BNB',
};

export interface CoinPayConfig {
  readonly apiKey: string;
  readonly businessId: string;
  readonly webhookSecret: string;
  readonly baseUrl?: string;
}

export interface CreatedPayment {
  readonly paymentId: string;
  readonly paymentUrl: string;
  readonly paymentAddress: string;
  readonly cryptoAmount: string;
  readonly expiresAt: string;
  readonly status: string;
}

/** The events we act on. CoinPayPortal sends more; the rest are informational. */
export type WebhookType =
  | 'payment.detected'
  | 'payment.confirmed'
  | 'payment.forwarded'
  | 'payment.failed'
  | 'payment.expired'
  | 'test.webhook';

export interface WebhookEvent {
  readonly id: string;
  readonly type: WebhookType;
  readonly business_id: string;
  readonly created_at: string;
  readonly data: {
    readonly payment_id: string;
    readonly amount_usd?: string;
    readonly amount_crypto?: string;
    readonly currency?: string;
    readonly status?: string;
    readonly tx_hash?: string;
    readonly metadata?: Record<string, string>;
  };
}

const DEFAULT_BASE_URL = 'https://coinpayportal.com/api';

export class CoinPayError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'CoinPayError';
    this.status = status;
  }
}

export class CoinPayClient {
  private readonly apiKey: string;
  private readonly businessId: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;
  private readonly portalUrl: string;

  constructor(config: CoinPayConfig) {
    this.apiKey = config.apiKey;
    this.businessId = config.businessId;
    this.webhookSecret = config.webhookSecret;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.portalUrl = this.baseUrl.replace(/\/api\/?$/, '');
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        ...init.headers,
      },
    });

    const body = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
      message?: string;
    };

    if (!response.ok) {
      throw new CoinPayError(
        `CoinPayPortal ${response.status}: ${body.error ?? body.message ?? response.statusText}`,
        response.status,
      );
    }

    // A 200 carrying `success: false` is a real failure mode of this API, and
    // one that reads as success to anything checking only the status code.
    if (body.success === false) {
      throw new CoinPayError(`CoinPayPortal refused: ${body.error ?? 'unknown error'}`, 502);
    }

    return body as T;
  }

  /**
   * Opens a payment and returns where to send the customer.
   *
   * `metadata` rides along and comes back on the webhook, but nothing here
   * trusts it: the organization a payment belongs to is read from our own
   * `credit_purchases` row, keyed on the payment id. Metadata is an input from
   * outside, and an outside input that decides who gets credited is a way to
   * credit somebody else's account.
   */
  async createPayment(input: {
    readonly amountUsd: number;
    readonly blockchain: Blockchain;
    readonly description: string;
    readonly metadata?: Record<string, string>;
    readonly webhookUrl?: string;
    readonly redirectUrl?: string;
  }): Promise<CreatedPayment> {
    const body = await this.request<{
      payment: {
        id: string;
        payment_address: string;
        crypto_amount: string;
        expires_at: string;
        status: string;
      };
    }>('/payments/create', {
      method: 'POST',
      body: JSON.stringify({
        business_id: this.businessId,
        amount: input.amountUsd,
        currency: 'USD',
        blockchain: input.blockchain,
        description: input.description,
        metadata: input.metadata,
        webhook_url: input.webhookUrl,
        redirect_url: input.redirectUrl,
      }),
    });

    return {
      paymentId: body.payment.id,
      paymentUrl: `${this.portalUrl}/pay/${body.payment.id}`,
      paymentAddress: body.payment.payment_address,
      cryptoAmount: body.payment.crypto_amount,
      expiresAt: body.payment.expires_at,
      status: body.payment.status,
    };
  }

  /** The authoritative status, for when a webhook was missed. */
  async getPayment(paymentId: string): Promise<{ status: string; amountUsd?: number }> {
    const body = await this.request<{ payment: { status: string; amount?: number } }>(
      `/payments/${encodeURIComponent(paymentId)}`,
    );

    return {
      status: body.payment.status,
      ...(body.payment.amount === undefined ? {} : { amountUsd: body.payment.amount }),
    };
  }

  /**
   * Whether this request really came from CoinPayPortal.
   *
   * Header format is `t=<unix seconds>,v1=<hex hmac>`, signing `${t}.${body}`.
   * The timestamp is inside the signed payload, which is what stops an
   * attacker replaying yesterday's genuine "payment confirmed" with a fresh
   * `t` — changing it invalidates the MAC.
   *
   * Takes the **raw** body. Re-serialising parsed JSON reorders keys and
   * changes whitespace, and the signature is over bytes.
   */
  async verifyWebhook(
    rawBody: string,
    signature: string,
    toleranceSeconds = 300,
  ): Promise<boolean> {
    const parts = new Map<string, string>();

    for (const segment of signature.split(',')) {
      const index = segment.indexOf('=');
      if (index > 0) parts.set(segment.slice(0, index).trim(), segment.slice(index + 1).trim());
    }

    const timestamp = parts.get('t');
    const presented = parts.get('v1');
    if (!timestamp || !presented) return false;

    const age = Math.abs(Math.floor(Date.now() / 1000) - Number.parseInt(timestamp, 10));
    if (!Number.isFinite(age) || age > toleranceSeconds) return false;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(this.webhookSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );

    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${timestamp}.${rawBody}`),
    );

    const expected = [...new Uint8Array(mac)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');

    return timingSafeEqualHex(expected, presented.toLowerCase());
  }
}

/**
 * Constant-time comparison of two hex strings.
 *
 * Length is compared first and leaks, which is fine — both sides are a fixed
 * 64 characters, so the length carries no secret. The content comparison must
 * not short-circuit, or the time it takes reveals how many leading bytes a
 * guess got right, and a forged signature can be found one byte at a time.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return diff === 0;
}
