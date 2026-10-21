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
import { CoinPayClient, readWebhookEvent } from '@outreachgraph/payments';

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
 * Opens a hosted CoinPay checkout session and records our side of it.
 *
 * The buyer picks the coin (or PayPal) on CoinPay's page, so no chain is chosen
 * here. The row is keyed by the session id (`cs_…`), which CoinPay echoes on
 * every webhook as `data.checkout_session_id`; the organization credited is
 * read from this row, never from the webhook's metadata.
 */
export async function startCreditPurchase(
  db: Client,
  coinpay: CoinPayClient,
  input: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly userId: string;
    readonly packId: string;
    /** Ignored: kept so older clients that still send a chain are not refused. */
    readonly blockchain?: string;
    /** The buyer's email; looked up from the user row when absent. */
    readonly email?: string;
    readonly appUrl: string;
    readonly apiUrl?: string;
  },
): Promise<{
  readonly purchaseId: string;
  readonly paymentUrl: string;
  readonly sessionId: string;
  readonly pack: CreditPack;
}> {
  const pack = creditPackById(input.packId);
  if (!pack) throw new BillingError(`No such credit pack: ${input.packId}`);

  let email = input.email?.trim();
  if (!email) {
    const user = await queryOne<{ email: string }>(db, 'SELECT email FROM users WHERE id = ?', [
      input.userId,
    ]);
    email = user?.email?.trim();
  }
  if (!email) throw new BillingError('Your account has no email to send the receipt to.');

  const purchaseId = newId('creditPurchase');

  const session = await coinpay.createCheckoutSession({
    amountUsd: pack.priceUsd,
    description: `OutreachGraph: ${pack.name}`,
    customerEmail: email,
    accountId: input.userId,
    // Read on the way back only to cross-check and to make a support ticket
    // legible. The organization credited comes from the row below.
    metadata: {
      purchase_id: purchaseId,
      organization_id: input.organizationId,
      workspace_id: input.workspaceId,
      user_id: input.userId,
      pack_id: pack.id,
    },
    // Back to the page they left from, which is where the new balance and the
    // purchase's status are shown.
    successUrl: `${input.appUrl}/billing?purchase=${purchaseId}`,
    cancelUrl: `${input.appUrl}/billing`,
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
      // The buyer chooses on CoinPay's page; the session decides nothing here.
      'ANY',
      session.sessionId,
      session.url,
      stamp,
      stamp,
    ],
  });

  return { purchaseId, paymentUrl: session.url, sessionId: session.sessionId, pack };
}

/**
 * Applies a CoinPayPortal webhook.
 *
 * `payment.confirmed` and `payment.forwarded` move money into credits (CoinPay
 * re-sends a failed `forwarded` but gives up on `confirmed`, so both must
 * count). `payment.detected` means visible but not yet buried under enough
 * blocks, and crediting on it would hand out prospects for a payment that can
 * still be reorganised out of existence.
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

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    throw new BillingError('Webhook body is not JSON', 400);
  }

  const event = readWebhookEvent(payload);

  if (event.type === 'test.webhook') {
    return { handled: true, credited: false, detail: 'test webhook acknowledged' };
  }

  if (event.refs.length === 0) throw new BillingError('Webhook carried no payment id', 400);

  // Keyed by the checkout session id for hosted checkout, by the payment id for
  // purchases opened before it. Either way the row decides who is credited.
  let purchase:
    | {
        id: string;
        organization_id: string;
        credits: number;
        status: string;
        pack_id: string;
        payment_id: string;
      }
    | undefined;
  for (const ref of event.refs) {
    purchase =
      (await queryOne<{
        id: string;
        organization_id: string;
        credits: number;
        status: string;
        pack_id: string;
        payment_id: string;
      }>(
        db,
        `SELECT id, organization_id, credits, status, pack_id, payment_id
           FROM credit_purchases WHERE payment_id = ?`,
        [ref],
      )) ?? undefined;
    if (purchase) break;
  }

  // A payment we never opened. Answered rather than raised: it is either
  // another product on the same CoinPayPortal business, or noise, and neither
  // is served by us retrying.
  if (!purchase) {
    return { handled: false, credited: false, detail: `unknown payment ${event.refs.join(',')}` };
  }

  if (!event.paid) {
    if (purchase.status !== 'confirmed') {
      await db.execute({
        sql: `UPDATE credit_purchases SET status = ?, updated_at = ? WHERE id = ?`,
        args: [webhookStatus(event.type, event.status), now(), purchase.id],
      });
    }

    return { handled: true, credited: false, detail: `recorded ${event.type || event.status}` };
  }

  // `grantCredits` collides on the purchase's own key if this payment has
  // already been applied (confirmed then forwarded, or a redelivery), so a
  // duplicate is a no-op rather than free credits.
  const credited = await grantCredits(db, {
    organizationId: purchase.organization_id,
    credits: purchase.credits,
    paymentId: purchase.payment_id,
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

function webhookStatus(type: string, status: string): string {
  const s = status || type.replace(/^payment\./, '');
  if (s === 'detected') return 'detected';
  if (s === 'failed') return 'failed';
  if (s === 'expired') return 'expired';
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
