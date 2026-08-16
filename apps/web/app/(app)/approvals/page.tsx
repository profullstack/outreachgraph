import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ApprovalCard } from '../../../components/approval-card';
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
 * The queue, narrowed to what can actually be acted on.
 *
 * It used to be one undifferentiated list, which made it unusable in practice:
 * production held 73 `refresh_research` cards — internal actions that have no
 * message by definition and never will — against a single email waiting for a
 * decision. Each of the 73 renders as a card with nothing written on it, so
 * the queue read as "the composer is broken" when it was really "you are
 * looking at the wrong 73 rows".
 *
 * `ready` is therefore the default rather than `all`: the page opens on the
 * things a human can approve, and the rest stay one click away.
 */
const TABS: readonly { id: ApprovalFilter; label: string; blurb: string }[] = [
  { id: 'ready', label: 'Ready', blurb: 'A message is written and waiting for your decision.' },
  {
    id: 'needs_draft',
    label: 'Needs a draft',
    blurb: 'Outreach with no message written yet. Nothing here can be sent.',
  },
  {
    id: 'research',
    label: 'Research',
    blurb: 'Internal work the prospect never sees. These never have a message.',
  },
  { id: 'all', label: 'All', blurb: 'Everything pending, in priority order.' },
];

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
    queue = await fetchApprovals(filter);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    // A missing API in local development should show what to do, not a stack
    // trace — the PWA is often run before the API is up.
    if (error instanceof ApiUnavailableError) return <ApiDown />;
    throw error;
  }

  const { recommendations: cards, counts } = queue;
  const active = TABS.find((tab) => tab.id === filter) ?? TABS[0];

  return (
    <div className="pt-4">
      <header className="mb-3">
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="text-ink-muted text-sm">{active?.blurb}</p>
      </header>

      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Filter the queue">
        {TABS.map((tab) => {
          const selected = tab.id === filter;
          return (
            <Link
              key={tab.id}
              href={`/approvals?filter=${tab.id}`}
              aria-current={selected ? 'page' : undefined}
              className={
                selected
                  ? 'border-accent text-ink bg-surface-raised rounded-full border px-3 py-1.5 text-sm'
                  : 'border-border text-ink-muted rounded-full border px-3 py-1.5 text-sm'
              }
            >
              {tab.label}
              {/* The count is the point of the tabs: it is what tells you the
                  queue is 73 research cards rather than 73 broken drafts. */}
              <span className="text-ink-muted ml-1.5 text-xs">{counts[tab.id] ?? 0}</span>
            </Link>
          );
        })}
      </nav>

      {cards.length === 0 ? (
        <EmptyState filter={filter} counts={counts} />
      ) : (
        <div className="flex flex-col gap-3">
          {cards.map((card) => (
            <ApprovalCard key={card.id} card={card} />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({
  filter,
  counts,
}: {
  filter: ApprovalFilter;
  counts: Record<ApprovalFilter, number>;
}) {
  // "Nothing here" is unhelpful when the queue is full of something else, so
  // an empty tab says where the work actually is.
  const elsewhere = TABS.filter((tab) => tab.id !== filter && (counts[tab.id] ?? 0) > 0);

  return (
    <div className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
      <p>Nothing in this view.</p>
      {elsewhere.length > 0 ? (
        <p className="mt-2">
          {elsewhere.map((tab, index) => (
            <span key={tab.id}>
              {index > 0 ? ' · ' : ''}
              <Link href={`/approvals?filter=${tab.id}`} className="text-accent underline">
                {counts[tab.id]} {tab.label.toLowerCase()}
              </Link>
            </span>
          ))}
        </p>
      ) : (
        <p className="mt-1">New recommendations appear as fresh signals arrive.</p>
      )}
    </div>
  );
}

function ApiDown() {
  return (
    <div className="border-border text-ink-muted mt-4 rounded-2xl border border-dashed p-8 text-center text-sm">
      <p className="text-ink font-medium">The API is not reachable.</p>
    </div>
  );
}
