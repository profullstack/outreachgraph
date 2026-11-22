/**
 * The checkout page for prospect credits (@profullstack/checkout).
 *
 * One page at `/checkout`, prefilled from its link, that posts a plain form
 * here. This file decides nothing about money: the packs and their prices are
 * `CREDIT_PACKS`, and the payment is opened by `startCreditPurchase`, the same
 * function the JSON route (`POST /billing/checkout`) calls, with the same
 * arguments. The row it writes is still what the webhook credits.
 *
 * Who is paying comes from the session (`resolveActor`), never from the link
 * or the form.
 */

import { createCheckout, type Checkout, type Order } from '@profullstack/checkout';
import { CREDIT_PACKS, creditPackById, type CreditPack } from '@outreachgraph/domain';
import { queryOne, type Client } from '@outreachgraph/db';
import { creditsFor } from '@outreachgraph/pipeline';
import type { CoinPayClient } from '@outreachgraph/payments';
import { BillingError, startCreditPurchase } from './billing';
import type { RequestActor } from './context';

/** The page (served by the Next app) and where its form posts. */
export const CHECKOUT_PAGE = '/checkout';
export const CHECKOUT_FORM_ACTION = '/api/v1/billing/checkout/form';

/** The same sentences the JSON route and the billing screen already use. */
const OWNER_OR_ADMIN = 'Only an owner or admin can buy credits.';
const UNCONFIGURED = 'This deployment cannot take payments.';
const NOT_FOR_SALE =
  'This deployment has no payment credentials configured, so credits are not for sale here.';
/** What `startCreditPurchase` says when the user row has no email. */
export const NO_RECEIPT_EMAIL = 'Your account has no email to send the receipt to.';

export const CHECKOUT_ERRORS = {
  owner_or_admin: OWNER_OR_ADMIN,
  payments_unconfigured: UNCONFIGURED,
  no_receipt_email: NO_RECEIPT_EMAIL,
} as const;

/** An error the page shows by code; the text is fixed above, never the request's. */
function coded(code: keyof typeof CHECKOUT_ERRORS): Error & { code: string } {
  return Object.assign(new Error(CHECKOUT_ERRORS[code]), { code });
}

/**
 * The packs as checkout options: the id and the price are the pack's own, and
 * the line under the price is the per-prospect rate the billing screen shows.
 */
export function creditPackOptions(packs: readonly CreditPack[] = CREDIT_PACKS) {
  return packs.map((pack) => ({
    id: pack.id,
    name: pack.name,
    price: pack.priceUsd,
    gets: `$${(pack.priceUsd / pack.credits).toFixed(3)} a prospect`,
  }));
}

export interface CreditCheckoutDeps {
  readonly db: Client;
  /** Absent when the deployment has no CoinPay credentials. */
  readonly coinpay: CoinPayClient | undefined;
  readonly appUrl: string;
  readonly apiUrl?: string;
  readonly resolveActor: (request: Request) => Promise<RequestActor | undefined>;
  /** Called after a purchase is opened, for the audit trail. */
  readonly started?: (
    actor: RequestActor,
    result: Awaited<ReturnType<typeof startCreditPurchase>>,
  ) => Promise<void>;
}

/**
 * Opens the payment for a priced order by calling `startCreditPurchase`.
 *
 * The amount is never taken from the order: the pack decides it. The order's
 * total is only compared against it, and a difference refuses the purchase
 * before anything is opened.
 */
export function creditCheckoutPay(deps: CreditCheckoutDeps) {
  return async (order: Order): Promise<{ url: string; id: string }> => {
    const actor = order.account.actor as RequestActor | undefined;
    if (!actor) throw new Error('checkout order carries no signed-in actor');

    if (actor.role !== 'owner' && actor.role !== 'admin') throw coded('owner_or_admin');
    if (!deps.coinpay) throw coded('payments_unconfigured');

    const pack = creditPackById(order.option.id);
    if (!pack) throw new Error(`No such credit pack: ${order.option.id}`);

    if (order.quantity !== 1 || order.totalCents !== Math.round(pack.priceUsd * 100)) {
      throw new Error(
        `checkout total ${order.totalCents} x${order.quantity} does not match ${pack.id} at $${pack.priceUsd}`,
      );
    }

    let result: Awaited<ReturnType<typeof startCreditPurchase>>;
    try {
      result = await startCreditPurchase(deps.db, deps.coinpay, {
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        packId: pack.id,
        appUrl: deps.appUrl,
        ...(deps.apiUrl ? { apiUrl: deps.apiUrl } : {}),
      });
    } catch (error) {
      if (error instanceof BillingError && error.message === NO_RECEIPT_EMAIL) {
        throw coded('no_receipt_email');
      }
      throw error;
    }

    await deps.started?.(actor, result);

    return { url: result.paymentUrl, id: result.sessionId };
  };
}

export function createCreditCheckout(deps: CreditCheckoutDeps): Checkout {
  return createCheckout({
    site: 'OutreachGraph',
    title: 'Buy prospect credits',
    subtitle: 'Credits cover prospects beyond your monthly allowance. They never expire.',
    optionsLabel: 'Pack',
    action: CHECKOUT_FORM_ACTION,
    page: CHECKOUT_PAGE,
    options: creditPackOptions(),
    processor:
      'Prices are in US dollars. Pay with any major coin or PayPal on the CoinPay checkout page.',
    requireAccount: true,
    signIn: '/login',
    siteUrl: deps.appUrl,
    errors: CHECKOUT_ERRORS,
    account: async (request) => {
      if (!request) return null;
      const actor = await deps.resolveActor(request);
      // No email here: the receipt address is read from the user row by
      // `startCreditPurchase`, exactly as the JSON route has it.
      return actor ? { id: actor.userId, email: '', actor } : null;
    },
    pay: creditCheckoutPay(deps),
    // A refusal the page explains by its code is not a failure worth a log line.
    onError: (error) => {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && Object.hasOwn(CHECKOUT_ERRORS, code)) return;
      console.error('credit checkout failed', error instanceof Error ? error.message : error);
    },
  });
}

/**
 * The page's view for a signed-in person: their selection from the link, who
 * they are buying as, their balance, and whether they can buy at all.
 */
export async function creditCheckoutView(
  checkout: Checkout,
  deps: Pick<CreditCheckoutDeps, 'db' | 'coinpay'>,
  actor: RequestActor,
  query: Record<string, string>,
): Promise<Record<string, unknown>> {
  const [user, credits] = await Promise.all([
    queryOne<{ email: string | null }>(deps.db, 'SELECT email FROM users WHERE id = ?', [
      actor.userId,
    ]),
    creditsFor(deps.db, actor.organizationId),
  ]);

  const closed = !deps.coinpay
    ? NOT_FOR_SALE
    : actor.role !== 'owner' && actor.role !== 'admin'
      ? OWNER_OR_ADMIN
      : '';

  return checkout.view({
    query,
    account: { email: user?.email?.trim() ?? '' },
    notes: [`Credits: ${credits.remaining.toLocaleString('en-US')}`],
    closed,
  });
}
