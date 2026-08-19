/**
 * Buying credits, and being told the money arrived.
 *
 * Two halves that must not trust each other. Checkout runs inside a session
 * and knows who the customer is; the webhook arrives from the internet
 * carrying whatever it likes. The join between them is the `credit_purchases`
 * row written at checkout: the webhook looks up the payment id and credits
 * *that row's* organization, never the one named in the payload it brought
 * with it. Metadata is convenience for debugging, not authorisation.
 */

import { CREDIT_PACKS, creditPackById, newId, type CreditPack } from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
import { creditsFor, grantCredits } from '@outreachgraph/pipeline';
import { CoinPayClient, isBlockchain, type Blockchain } from '@outreachgraph/payments';

export class BillingError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'BillingError';
    this.status = status;
  }
}

export interface PurchaseRow {
  readonly id: string;
  readonly pack_id: string;
  readonly credits: number;
  readonly amount_usd: number;
  readonly blockchain: string;
  readonly payment_id: string;
  readonly payment_url: string | null;
  readonly status: string;
  readonly created_at: string;
}

/**
 * Opens a checkout and records our side of it before the customer sees a page.
 *
 * The row is written *first*, deliberately. A payment that exists at
 * CoinPayPortal with no row here is a payment whose webhook we would have to
 * refuse, and refunding crypto is a support conversation rather than an API
 * call. The opposite ordering — row first, payment second — leaves at worst an
 * abandoned `pending` row, which costs nothing and is visible.
 */
export async function startCreditPurchase(
  db: Client,
  coinpay: CoinPayClient,
  input: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly userId: string;
    readonly packId: string;
    readonly blockchain: string;
    readonly appUrl: string;
    readonly apiUrl?: string;
  },
): Promise<{
  readonly purchaseId: string;
  readonly paymentUrl: string;
  readonly pack: CreditPack;
}> {
  const pack = creditPackById(input.packId);
  if (!pack) throw new BillingError(`No such credit pack: ${input.packId}`);

  if (!isBlockchain(input.blockchain)) {
    throw new BillingError(`Unsupported blockchain: ${input.blockchain}`);
  }

  const blockchain: Blockchain = input.blockchain;
  const purchaseId = newId('creditPurchase');

  const payment = await coinpay.createPayment({
    amountUsd: pack.priceUsd,
    blockchain,
    description: `OutreachGraph — ${pack.name}`,
    // Read on the way back only to cross-check and to make a support ticket
    // legible. The organization credited comes from the row below.
    metadata: {
      purchase_id: purchaseId,
      organization_id: input.organizationId,
      pack_id: pack.id,
    },
    ...(input.apiUrl ? { webhookUrl: `${input.apiUrl}/api/v1/coinpay/callback` } : {}),
    // Back to the page they left from, which is where the new balance and the
    // purchase's status are shown.
    redirectUrl: `${input.appUrl}/billing?purchase=${purchaseId}`,
  });

  const stamp = now();

  await db.execute({
    sql: `INSERT INTO credit_purchases (id, organization_id, workspace_id, user_id, pack_id,
          credits, amount_usd, blockchain, payment_id, payment_url, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    args: [
      purchaseId,
      input.organizationId,
      input.workspaceId,
      input.userId,
      pack.id,
      pack.credits,
      pack.priceUsd,
      blockchain,
      payment.paymentId,
      payment.paymentUrl,
      stamp,
      stamp,
    ],
  });

  return { purchaseId, paymentUrl: payment.paymentUrl, pack };
}

/**
 * Applies a CoinPayPortal webhook.
 *
 * Only `payment.confirmed` moves money into credits. `payment.detected` means
 * the transaction is visible but not yet buried under enough blocks, and
 * crediting on it would hand out prospects for a payment that can still be
 * reorganised out of existence.
 *
 * Returns what happened, so the caller can answer 200 to everything it
 * understood. A webhook endpoint that returns 500 for "I have already handled
 * this" earns itself an escalating retry storm.
 */
export async function handleCoinPayWebhook(
  db: Client,
  coinpay: CoinPayClient,
  input: {
    readonly rawBody: string;
    readonly signature: string | null;
  },
): Promise<{ readonly handled: boolean; readonly credited: boolean; readonly detail: string }> {
  if (!input.signature) throw new BillingError('Missing webhook signature', 401);

  const verified = await coinpay.verifyWebhook(input.rawBody, input.signature);
  if (!verified) throw new BillingError('Bad webhook signature', 401);

  let event: { type?: string; data?: { payment_id?: string } };
  try {
    event = JSON.parse(input.rawBody);
  } catch {
    throw new BillingError('Webhook body is not JSON', 400);
  }

  const type = String(event.type ?? '');
  const paymentId = String(event.data?.payment_id ?? '');

  if (type === 'test.webhook') {
    return { handled: true, credited: false, detail: 'test webhook acknowledged' };
  }

  if (!paymentId) throw new BillingError('Webhook carried no payment id', 400);

  const purchase = await queryOne<{
    id: string;
    organization_id: string;
    credits: number;
    status: string;
    pack_id: string;
  }>(
    db,
    `SELECT id, organization_id, credits, status, pack_id
       FROM credit_purchases WHERE payment_id = ?`,
    [paymentId],
  );

  // A payment we never opened. Answered rather than raised: it is either
  // another product on the same CoinPayPortal business, or noise, and neither
  // is served by us retrying.
  if (!purchase) {
    return { handled: false, credited: false, detail: `unknown payment ${paymentId}` };
  }

  if (type !== 'payment.confirmed') {
    await db.execute({
      sql: `UPDATE credit_purchases SET status = ?, updated_at = ? WHERE id = ?`,
      args: [webhookStatus(type), now(), purchase.id],
    });

    return { handled: true, credited: false, detail: `recorded ${type}` };
  }

  // `grantCredits` collides on the payment id if this confirmation has already
  // been applied, so a duplicate delivery is a no-op rather than free credits.
  const credited = await grantCredits(db, {
    organizationId: purchase.organization_id,
    credits: purchase.credits,
    paymentId,
    reason: `CoinPayPortal ${purchase.pack_id}`,
  });

  await db.execute({
    sql: `UPDATE credit_purchases SET status = 'confirmed', updated_at = ? WHERE id = ?`,
    args: [now(), purchase.id],
  });

  return {
    handled: true,
    credited,
    detail: credited
      ? `credited ${purchase.credits} to ${purchase.organization_id}`
      : 'already credited',
  };
}

function webhookStatus(type: string): string {
  if (type === 'payment.detected') return 'detected';
  if (type === 'payment.failed') return 'failed';
  if (type === 'payment.expired') return 'expired';
  if (type === 'payment.forwarded') return 'confirmed';
  return 'pending';
}

/** Everything the billing screen needs, in one round trip. */
export async function billingOverview(
  db: Client,
  input: { readonly organizationId: string },
): Promise<{
  readonly credits: Awaited<ReturnType<typeof creditsFor>>;
  readonly packs: readonly CreditPack[];
  readonly purchases: readonly PurchaseRow[];
}> {
  const [credits, purchases] = await Promise.all([
    creditsFor(db, input.organizationId),
    db.execute({
      sql: `SELECT id, pack_id, credits, amount_usd, blockchain, payment_id, payment_url,
                   status, created_at
              FROM credit_purchases WHERE organization_id = ?
             ORDER BY created_at DESC LIMIT 25`,
      args: [input.organizationId],
    }),
  ]);

  return {
    credits,
    packs: CREDIT_PACKS,
    purchases: purchases.rows as unknown as PurchaseRow[],
  };
}
