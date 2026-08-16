import { redirect } from 'next/navigation';
import { ApprovalQueue as Queue } from '../../../components/approval-queue';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchApprovals,
  type ApprovalFilter,
  type ApprovalQueue,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Approvals · OutreachGraph' };

/**
 * The whole pending queue, in one request.
 *
 * The tabs used to be four separate URLs, one fetch each, and switching
 * between them reloaded the page to show rows the browser already had. The
 * page now asks for `all` and the tabs filter it in the client, so the only
 * cost of looking at another tab is a re-render.
 *
 * `limit` is the API's own ceiling. Fetching per-tab could show 50 of each;
 * fetching once has to cover all four, and production's queue is ~75 rows.
 * Past 200 the counts still tell the truth and the page says it is showing a
 * subset.
 */
const QUEUE_LIMIT = 200;

function isFilter(value: string | undefined): value is ApprovalFilter {
  return value === 'all' || value === 'ready' || value === 'needs_draft' || value === 'research';
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: requested } = await searchParams;
  const filter: ApprovalFilter = isFilter(requested) ? requested : 'ready';

  let queue: ApprovalQueue;

  try {
    queue = await fetchApprovals('all', QUEUE_LIMIT);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    // A missing API in local development should show what to do, not a stack
    // trace — the PWA is often run before the API is up.
    if (error instanceof ApiUnavailableError) return <ApiDown />;
    throw error;
  }

  return <Queue cards={queue.recommendations} counts={queue.counts} initialFilter={filter} />;
}

function ApiDown() {
  return (
    <div className="border-border text-ink-muted mt-4 rounded-2xl border border-dashed p-8 text-center text-sm">
      <p className="text-ink font-medium">The API is not reachable.</p>
    </div>
  );
}
