import { redirect } from 'next/navigation';
import { CreditPacks } from '../../../components/credit-packs';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchBilling,
  type BillingView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Billing · OutreachGraph' };

/**
 * The plan, what is left of it, and how to buy more.
 *
 * Its own page rather than a section of Settings, because it is the answer to
 * a question the product previously had no answer to at all: the approval
 * queue could refuse every card with "the campaign budget is exhausted" and
 * offer nowhere to go about it. A refusal with no remedy reads as a bug.
 */
export default async function BillingPage() {
  let billing: BillingView | undefined;
  let offline = false;

  try {
    billing = await fetchBilling();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Billing</h1>
        <p className="text-ink-muted text-sm">
          What your plan covers, and what to do when it runs out.
        </p>
      </header>

      {offline || !billing ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : (
        <CreditPacks initial={billing} />
      )}
    </div>
  );
}
