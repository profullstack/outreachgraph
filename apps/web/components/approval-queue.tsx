'use client';

import { useCallback, useState } from 'react';
import { channelForNetwork, isNetwork, type Channel } from '@outreachgraph/domain';
import { ApprovalCard } from './approval-card';
import type { ApprovalBucket, ApprovalCard as Card } from '../lib/types';

export type ApprovalFilter = 'all' | ApprovalBucket;
export type ChannelFilter = 'all' | Channel;

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
 * The second axis: what acting on the card would actually mean.
 *
 * The stage tabs answer "is this ready", which is not the question a reviewer
 * with limited time is asking. Email is the only channel that sends by itself,
 * so "show me only the email ones" is the difference between clearing the
 * queue and scrolling past cards that were only ever going to be a link to
 * open somewhere else. Social is here for the same reason in reverse — it is
 * the batch you work through by hand, in a sitting, in another tab.
 */
const CHANNEL_TABS: readonly { id: ChannelFilter; label: string; blurb: string }[] = [
  { id: 'all', label: 'Any channel', blurb: '' },
  { id: 'email', label: 'Email', blurb: 'Sends from here once approved.' },
  { id: 'social', label: 'Social', blurb: 'You act on these yourself, in the network’s own app.' },
  { id: 'web', label: 'Website', blurb: 'Reading and research on a site. Nobody is contacted.' },
];

/**
 * A card's channel, from the network the action would happen on.
 *
 * Unlike `bucket` this is not computed in SQL, because it does not need to be:
 * `network` is already on every row and the mapping is a pure function of it,
 * so the browser can reclassify without asking the server. The counts still
 * come from the API — they describe every pending row, not the page that was
 * fetched — and both sides call the same `channelForNetwork`, so a badge can
 * never disagree with the list under it.
 */
function channelOf(card: Card): ChannelFilter | undefined {
  return isNetwork(card.network) ? channelForNetwork(card.network) : undefined;
}

/**
 * Switching tabs is not navigation.
 *
 * The tabs used to be links to `/approvals?filter=…`, so every click was a
 * fresh request: the page blanked, the queue was fetched again, and the scroll
 * position went back to the top — to look at the same rows the browser already
 * had. The page now loads the whole pending queue once and the tabs pick from
 * it in memory, which is instant and keeps you where you were.
 *
 * The URL still tracks both tabs, via `replaceState` rather than a navigation,
 * so `/approvals?filter=research&channel=email` still deep-links and a reload
 * lands back on the view you were reading. `replaceState` and not `pushState`:
 * a filter is a view of one page, so Back should leave the queue, not walk you
 * through the tabs you happened to click on the way in.
 */
export function ApprovalQueue({
  cards,
  counts,
  initialFilter,
  initialChannel,
  /**
   * The page's guidance panel, passed in as a slot.
   *
   * It belongs under this heading rather than above it, and the heading lives
   * here because the tab blurb writes it. A server component handed to a
   * client one as a prop renders on the server as normal, which is what keeps
   * the panel off the client bundle.
   */
  guide,
}: {
  cards: Card[];
  counts: {
    buckets: Record<ApprovalFilter, number>;
    channels: Record<ChannelFilter, number>;
  };
  initialFilter: ApprovalFilter;
  initialChannel: ChannelFilter;
  guide?: React.ReactNode;
}) {
  const [filter, setFilter] = useState<ApprovalFilter>(initialFilter);
  const [channel, setChannel] = useState<ChannelFilter>(initialChannel);

  // Guarded because this also runs during the server render pass.
  const track = useCallback((key: 'filter' | 'channel', value: string) => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set(key, value);
    window.history.replaceState(null, '', url);
  }, []);

  const select = useCallback(
    (next: ApprovalFilter) => {
      setFilter(next);
      track('filter', next);
    },
    [track],
  );

  const selectChannel = useCallback(
    (next: ChannelFilter) => {
      setChannel(next);
      track('channel', next);
    },
    [track],
  );

  const visible = cards.filter(
    (card) =>
      (filter === 'all' || card.bucket === filter) &&
      (channel === 'all' || channelOf(card) === channel),
  );
  const active = TABS.find((tab) => tab.id === filter) ?? TABS[0];
  const activeChannel = CHANNEL_TABS.find((tab) => tab.id === channel);

  // The counts come from a query over every pending row, while the cards are
  // one page of them. Saying so is better than a tab that quietly shows 200 of
  // 340 and reads as if that were the whole queue.
  //
  // Only meaningful on one axis at a time: the API counts stages and channels
  // separately, so there is no honest total for "ready email" without a third
  // query. When both are narrowed the list is the only claim made.
  const total = channel === 'all' ? (counts.buckets[filter] ?? 0) : (counts.channels[channel] ?? 0);
  const truncated = (filter === 'all' || channel === 'all') && total > visible.length;

  return (
    <div className="pt-4">
      <header className="mb-3">
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="text-ink-muted text-sm">
          {active?.blurb}
          {activeChannel?.blurb ? ` ${activeChannel.blurb}` : ''}
        </p>
      </header>

      {guide}

      <nav className="mb-2 flex flex-wrap gap-2" aria-label="Filter the queue by stage">
        {TABS.map((tab) => (
          <FilterChip
            key={tab.id}
            label={tab.label}
            count={counts.buckets[tab.id] ?? 0}
            selected={tab.id === filter}
            onSelect={() => select(tab.id)}
          />
        ))}
      </nav>

      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Filter the queue by channel">
        {CHANNEL_TABS.map((tab) => (
          <FilterChip
            key={tab.id}
            label={tab.label}
            count={counts.channels[tab.id] ?? 0}
            selected={tab.id === channel}
            onSelect={() => selectChannel(tab.id)}
          />
        ))}
      </nav>

      {visible.length === 0 ? (
        <EmptyState
          filter={filter}
          channel={channel}
          counts={counts}
          onSelect={select}
          onSelectChannel={selectChannel}
        />
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

function FilterChip({
  label,
  count,
  selected,
  onSelect,
}: {
  label: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={
        selected
          ? 'border-accent text-ink bg-surface-raised rounded-full border px-3 py-1.5 text-sm'
          : 'border-border text-ink-muted rounded-full border px-3 py-1.5 text-sm'
      }
    >
      {label}
      {/* The count is the point of the tabs: it is what tells you the queue is
          73 research cards rather than 73 broken drafts, and that the reason
          no email is waiting is that none exists rather than that it is
          hidden behind the wrong tab. */}
      <span className="text-ink-muted ml-1.5 text-xs">{count}</span>
    </button>
  );
}

function EmptyState({
  filter,
  channel,
  counts,
  onSelect,
  onSelectChannel,
}: {
  filter: ApprovalFilter;
  channel: ChannelFilter;
  counts: {
    buckets: Record<ApprovalFilter, number>;
    channels: Record<ChannelFilter, number>;
  };
  onSelect: (filter: ApprovalFilter) => void;
  onSelectChannel: (channel: ChannelFilter) => void;
}) {
  // "Nothing here" is unhelpful when the queue is full of something else, so
  // an empty view says where the work actually is — on either axis, because
  // with two filters the reason a view is empty is as often the channel as
  // the stage.
  const elsewhere = TABS.filter((tab) => tab.id !== filter && (counts.buckets[tab.id] ?? 0) > 0);
  const otherChannels = CHANNEL_TABS.filter(
    (tab) => tab.id !== channel && (counts.channels[tab.id] ?? 0) > 0,
  );

  const narrowed = filter !== 'all' || channel !== 'all';

  return (
    <div className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
      <p>Nothing in this view.</p>

      {elsewhere.length > 0 || otherChannels.length > 0 ? (
        <>
          <p className="mt-2">
            {elsewhere.map((tab, index) => (
              <span key={tab.id}>
                {index > 0 ? ' · ' : ''}
                <button
                  type="button"
                  onClick={() => onSelect(tab.id)}
                  className="text-accent underline"
                >
                  {counts.buckets[tab.id]} {tab.label.toLowerCase()}
                </button>
              </span>
            ))}
          </p>
          <p className="mt-1">
            {otherChannels.map((tab, index) => (
              <span key={tab.id}>
                {index > 0 ? ' · ' : ''}
                <button
                  type="button"
                  onClick={() => onSelectChannel(tab.id)}
                  className="text-accent underline"
                >
                  {counts.channels[tab.id]} {tab.label.toLowerCase()}
                </button>
              </span>
            ))}
          </p>
        </>
      ) : narrowed ? (
        <p className="mt-1">The queue is empty on every tab, not just this one.</p>
      ) : (
        <p className="mt-1">New recommendations appear as fresh signals arrive.</p>
      )}
    </div>
  );
}
