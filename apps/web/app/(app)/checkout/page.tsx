import '@profullstack/checkout/checkout.css';
import { Checkout } from '@profullstack/checkout/react';
import { redirect } from 'next/navigation';
import { ApiUnavailableError, NotAuthenticatedError, fetchCheckoutView } from '../../../lib/api';
import { checkoutSearch, checkoutSignInHref } from '../../../lib/checkout-link';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Buy prospect credits · OutreachGraph', robots: { index: false } };

type Query = Record<string, string | string[] | undefined>;

/**
 * Buying prospect credits: one page, the pack from the link already selected,
 * one button to the CoinPay payment page.
 *
 * The page only renders. The packs, their prices, who is signed in and the
 * payment itself all live in the API, which builds this view and takes the
 * form's post (`/api/v1/billing/checkout/form`). It is a plain form, so it
 * works before, or without, any script.
 */
export default async function CheckoutPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;

  let view: Record<string, unknown> | undefined;

  try {
    view = await fetchCheckoutView(checkoutSearch(query));
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect(checkoutSignInHref(query));
    if (!(error instanceof ApiUnavailableError)) throw error;
  }

  return (
    <div className="pt-4">
      {view ? (
        <Checkout view={view} />
      ) : (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      )}

      <p className="text-ink-muted mt-6 text-center text-sm">
        <a href="/billing" className="underline">
          Back to billing
        </a>
      </p>
    </div>
  );
}
