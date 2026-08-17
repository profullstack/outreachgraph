'use client';

import { useCallback, useState } from 'react';
import { ApprovalCard } from './approval-card';
import type { ApprovalBucket, ApprovalCard as Card } from '../lib/types';

export type ApprovalFilter = 'all' | ApprovalBucket;

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

/**
 * Switching tabs is not navigation.
 *
 * The tabs used to be links to `/approvals?filter=…`, so every click was a
 * fresh request: the page blanked, the queue was fetched again, and the scroll
 * position went back to the top — to look at the same rows the browser already
 * had. The page now loads the whole pending queue once and the tabs pick from
 * it in memory, which is instant and keeps you where you were.
 *
 * The URL still tracks the tab, via `replaceState` rather than a navigation,
 * so `/approvals?filter=research` still deep-links and a reload lands back on
 * the tab you were reading. `replaceState` and not `pushState`: a filter is a
 * view of one page, so Back should leave the queue, not walk you through the
 * tabs you happened to click on the way in.
 */
export function ApprovalQueue({
  cards,
  counts,
  initialFilter,
}: {
  cards: Card[];
  counts: Record<ApprovalFilter, number>;
  initialFilter: ApprovalFilter;
}) {
  const [filter, setFilter] = useState<ApprovalFilter>(initialFilter);

  const select = useCallback((next: ApprovalFilter) => {
    setFilter(next);
    // Guarded because this also runs during the server render pass.
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('filter', next);
      window.history.replaceState(null, '', url);
    }
  }, []);

  const visible = filter === 'all' ? cards : cards.filter((card) => card.bucket === filter);
  const active = TABS.find((tab) => tab.id === filter) ?? TABS[0];

  // The counts come from a query over every pending row, while the cards are
  // one page of them. Saying so is better than a tab that quietly shows 200 of
  // 340 and reads as if that were the whole queue.
  const total = counts[filter] ?? 0;
  const truncated = total > visible.length;

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
            <button
              key={tab.id}
              type="button"
              onClick={() => select(tab.id)}
              aria-pressed={selected}
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
            </button>
          );
        })}
      </nav>

      {visible.length === 0 ? (
        <EmptyState filter={filter} counts={counts} onSelect={select} />
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((card) => (
            <ApprovalCard key={card.id} card={card} />
          ))}
          {truncated ? (
            <p className="text-ink-muted text-center text-xs">
              Showing {visible.length} of {total}. Approve or reject these and the rest follow.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function EmptyState({
  filter,
  counts,
  onSelect,
}: {
  filter: ApprovalFilter;
  counts: Record<ApprovalFilter, number>;
  onSelect: (filter: ApprovalFilter) => void;
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
              <button
                type="button"
                onClick={() => onSelect(tab.id)}
                className="text-accent underline"
              >
                {counts[tab.id]} {tab.label.toLowerCase()}
              </button>
            </span>
          ))}
        </p>
      ) : (
        <p className="mt-1">New recommendations appear as fresh signals arrive.</p>
      )}
    </div>
  );
}
