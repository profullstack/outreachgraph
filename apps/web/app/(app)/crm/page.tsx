import { redirect } from 'next/navigation';
import { CrmBoard } from '../../../components/crm-board';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchCrmSummary,
  fetchDeals,
  fetchOwnBookingPage,
  type CrmSummaryView,
  type DealView,
  type OwnBookingPageView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'CRM · OutreachGraph' };

/**
 * Deals, call notes, reminders and the booking page (PRD §39). The same data
 * agents reach through `og crm`, `og cal` and the MCP CRM tools.
 */
export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<{ deal?: string }>;
}) {
  const { deal } = await searchParams;
  let summary: CrmSummaryView | undefined;
  let deals: DealView[] = [];
  let page: OwnBookingPageView | undefined;
  let offline = false;

  try {
    [summary, { deals }, page] = await Promise.all([
      fetchCrmSummary(),
      fetchDeals(),
      fetchOwnBookingPage(),
    ]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">CRM</h1>
        <p className="text-ink-muted text-sm">
          Where each relationship stands, what was said, and what is next.
        </p>
      </header>
      {offline || !summary || !page ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : (
        <CrmBoard
          initialSummary={summary}
          initialDeals={deals}
          initialPage={page.page}
          initialPageUrl={page.url}
          {...(deal ? { initialDealId: deal } : {})}
        />
      )}
    </div>
  );
}
