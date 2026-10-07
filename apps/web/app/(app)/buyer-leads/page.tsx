import { redirect } from 'next/navigation';
import { BuyerLeadsBoard } from '../../../components/buyer-leads-board';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchBuyerLeads,
  fetchProducts,
  type BuyerLeadsView,
} from '../../../lib/api';
import type { ProductSummaryView } from '../../../lib/types';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Buyer leads · OutreachGraph' };

/**
 * People in public communities who look ready to buy what you sell.
 *
 * Monitors search Reddit, Hacker News and Bluesky for a brand's keywords and
 * score every post for buyer intent. Each lead is a quoted excerpt, a link and
 * a reason; a reply can be drafted for it, and a human posts it. Nothing here
 * posts to a community.
 */
export default async function BuyerLeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; lead?: string }>;
}) {
  const params = await searchParams;
  const status = ['new', 'replied', 'dismissed'].includes(params.status ?? '')
    ? params.status
    : undefined;
  let view: BuyerLeadsView | undefined;
  let products: ProductSummaryView[] = [];
  try {
    [view, products] = await Promise.all([
      fetchBuyerLeads(status ? `?status=${status}` : ''),
      fetchProducts().catch(() => []),
    ]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (!(error instanceof ApiUnavailableError)) throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Buyer leads</h1>
        <p className="text-ink-muted text-sm">
          People on Reddit, Hacker News and Bluesky looking for what you sell. Draft a reply, then
          post it yourself.
        </p>
      </header>

      {view ? (
        <BuyerLeadsBoard
          initial={view}
          products={products.filter((p) => p.configured)}
          status={status ?? 'new'}
          focus={params.lead}
        />
      ) : (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      )}
    </div>
  );
}
