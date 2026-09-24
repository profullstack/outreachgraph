import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ApprovalQueue as Queue } from '../../../components/approval-queue';
import { HandoffCards } from '../../../components/handoff-cards';
import { PageGuide } from '../../../components/page-guide';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchApprovals,
  fetchHandoffs,
  type ApprovalFilter,
  type ApprovalQueue,
  type ChannelFilter,
  type HandoffView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Approvals · OutreachGraph' };

/**
 * The whole pending queue, in one request.
 *
 * The tabs used to be four separate URLs, one fetch each, and switching
 * between them reloaded the page to show rows the browser already had. The
 * page now asks for `all` on both axes and the tabs filter it in the client,
 * so the only cost of looking at another tab is a re-render.
 *
 * `limit` is the API's own ceiling. Fetching per-tab could show 50 of each;
 * fetching once has to cover all of them, and production's queue is ~75 rows.
 * Past 200 the counts still tell the truth and the page says it is showing a
 * subset.
 */
const QUEUE_LIMIT = 200;

function isFilter(value: string | undefined): value is ApprovalFilter {
  return value === 'all' || value === 'ready' || value === 'needs_draft' || value === 'research';
}

function isChannelFilter(value: string | undefined): value is ChannelFilter {
  return value === 'all' || value === 'email' || value === 'social' || value === 'web';
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; channel?: string; tab?: string }>;
}) {
  const { filter: requested, channel: requestedChannel, tab } = await searchParams;
  const filter: ApprovalFilter = isFilter(requested) ? requested : 'ready';
  const channel: ChannelFilter = isChannelFilter(requestedChannel) ? requestedChannel : 'all';

  let queue: ApprovalQueue;
  let handoffs: HandoffView[];

  try {
    [queue, handoffs] = await Promise.all([
      fetchApprovals('all', QUEUE_LIMIT, 'all'),
      // A failure here must not take the queue down with it: hand-offs are
      // the second thing on this page, not the first.
      fetchHandoffs(QUEUE_LIMIT).catch((error: unknown) => {
        if (error instanceof NotAuthenticatedError) throw error;
        return [] as HandoffView[];
      }),
    ]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    // A missing API in local development should show what to do, not a stack
    // trace — the PWA is often run before the API is up.
    if (error instanceof ApiUnavailableError) return <ApiDown />;
    throw error;
  }

  if (tab === 'handoffs') {
    return (
      <div className="pt-4">
        <header className="mb-3">
          <h1 className="text-xl font-semibold">Hand-offs</h1>
          <p className="text-ink-muted text-sm">
            Approved, but the product may not do these for you. Copy, open, paste, Mark done.
          </p>
          <Link href="/approvals" className="text-accent text-sm underline">
            Back to the queue ({queue.counts.buckets.all ?? 0})
          </Link>
        </header>
        <HandoffCards handoffs={handoffs} />
      </div>
    );
  }

  return (
    <Queue
      cards={queue.recommendations}
      counts={queue.counts}
      initialFilter={filter}
      initialChannel={channel}
      // Handed in as a slot so it lands under the heading the queue owns.
      // `approve` is suppressed: the queue it would link to is this page.
      guide={
        <>
          <PageGuide page="approvals" suppress={['approve']} />
          <HandoffBanner count={handoffs.length} />
        </>
      }
    />
  );
}

/**
 * Approved hand-offs are no longer in the queue, so without this they would
 * be approved and then invisible: the one outcome worse than being held.
 */
function HandoffBanner({ count }: { count: number }) {
  if (count === 0) return null;

  return (
    <Link
      href="/approvals?tab=handoffs"
      className="border-accent bg-surface-raised mb-3 flex items-center justify-between gap-3 rounded-xl border p-3 text-sm"
    >
      <span>
        <span className="font-medium">
          {count.toLocaleString()} hand-off{count === 1 ? '' : 's'} need you.
        </span>{' '}
        <span className="text-ink-muted">About thirty seconds each.</span>
      </span>
      <span className="text-accent shrink-0 font-medium">Open</span>
    </Link>
  );
}

function ApiDown() {
  return (
    <div className="border-border text-ink-muted mt-4 rounded-2xl border border-dashed p-8 text-center text-sm">
      <p className="text-ink font-medium">The API is not reachable.</p>
    </div>
  );
}
