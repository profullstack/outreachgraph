'use client';

import { useMemo, useState } from 'react';
import { relativeTime } from '../lib/format';
import {
  DEFAULT_FILTERS,
  SORT_LABEL,
  TIER_LABEL,
  TONE_LABEL,
  applyFilters,
  networksIn,
  tierOf,
  toCsv,
  type RelevanceTier,
  type SignalFilters,
  type SortKey,
  type Tone,
} from '../lib/signal-filters';
import type { SignalRow } from '../lib/types';

const TIER_BADGE: Record<string, string> = {
  very: 'High intent',
  relevant: 'Relevant',
  possible: 'Possible',
};

const NETWORK_LABEL: Record<string, string> = {
  bluesky: 'Bluesky',
  github: 'GitHub',
  hackernews: 'Hacker News',
  hn: 'Hacker News',
  lobsters: 'Lobsters',
  reddit: 'Reddit',
  stackoverflow: 'Stack Overflow',
  mastodon: 'Mastodon',
  rss: 'RSS',
  x: 'X',
  linkedin: 'LinkedIn',
};

const label = (network: string) => NETWORK_LABEL[network] ?? network;

/**
 * The signal feed with Refine results: sort, a relevance floor, tone and
 * networks, applied to what is loaded. Load more widens it; Export takes what
 * the filters show.
 */
export function SignalFeed({
  initial,
  initialCursor,
}: {
  initial: SignalRow[];
  initialCursor: string | null;
}) {
  const [signals, setSignals] = useState<SignalRow[]>(initial);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [filters, setFilters] = useState<SignalFilters>(DEFAULT_FILTERS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = useMemo(() => applyFilters(signals, filters), [signals, filters]);
  const networks = useMemo(() => networksIn(signals), [signals]);
  const set = (patch: Partial<SignalFilters>) => setFilters((f) => ({ ...f, ...patch }));

  const toggleNetwork = (network: string) =>
    set({
      networks: filters.networks.includes(network)
        ? filters.networks.filter((n) => n !== network)
        : [...filters.networks, network],
    });

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/signals?limit=100&before=${encodeURIComponent(cursor)}`,
        {
          credentials: 'same-origin',
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { signals: SignalRow[]; next_cursor?: string | null };
      setSignals((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...body.signals.filter((s) => !seen.has(s.id))];
      });
      setCursor(body.next_cursor ?? null);
    } catch (e) {
      setError(`Could not load more: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  function exportCsv() {
    const blob = new Blob([toCsv(shown)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `signals-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-label="Refine results"
        className="border-border bg-surface-raised rounded-2xl border p-4"
      >
        <h2 className="text-sm font-semibold">Refine results</h2>
        <p className="text-ink-muted mt-1 text-xs">
          Filters apply to posts already loaded in your browser. Use Load more to widen the list,
          then export.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink-muted">Sort</span>
            <select
              value={filters.sort}
              onChange={(e) => set({ sort: e.target.value as SortKey })}
              className="border-border bg-surface rounded-xl border px-3 py-2 text-sm"
            >
              {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink-muted">Min relevance</span>
            <select
              value={filters.minTier}
              onChange={(e) => set({ minTier: e.target.value as RelevanceTier })}
              className="border-border bg-surface rounded-xl border px-3 py-2 text-sm"
            >
              {(Object.keys(TIER_LABEL) as RelevanceTier[]).map((k) => (
                <option key={k} value={k}>
                  {TIER_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink-muted">Tone</span>
            <select
              value={filters.tone}
              onChange={(e) => set({ tone: e.target.value as Tone })}
              className="border-border bg-surface rounded-xl border px-3 py-2 text-sm"
            >
              {(Object.keys(TONE_LABEL) as Tone[]).map((k) => (
                <option key={k} value={k}>
                  {TONE_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {networks.length ? (
          <fieldset className="mt-3">
            <legend className="text-ink-muted text-xs">Networks</legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {networks.map(({ network, count }) => (
                <label key={network} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={filters.networks.length === 0 || filters.networks.includes(network)}
                    onChange={() =>
                      // From "all" (nothing ticked), unticking one means "all but this one".
                      filters.networks.length === 0
                        ? set({
                            networks: networks.map((n) => n.network).filter((n) => n !== network),
                          })
                        : toggleNetwork(network)
                    }
                  />
                  {label(network)} <span className="text-ink-muted text-xs">{count}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-ink-muted text-xs">
            Showing {shown.length} of {signals.length} loaded{cursor ? '' : ' (all loaded)'}
          </span>
          <button
            type="button"
            onClick={() => setFilters(DEFAULT_FILTERS)}
            className="border-border ml-auto rounded-xl border px-3 py-1.5 text-xs"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={shown.length === 0}
            className="bg-ink text-surface rounded-xl px-3 py-1.5 text-xs disabled:opacity-50"
          >
            Export CSV
          </button>
        </div>
      </section>

      {shown.length === 0 ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          {signals.length === 0
            ? 'No signals collected yet.'
            : 'Nothing loaded matches these filters.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((signal) => {
            const tier = tierOf(signal.relevance);
            return (
              <li
                key={signal.id}
                className="border-border bg-surface-raised rounded-2xl border p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {tier ? (
                    <span
                      className={`text-[11px] font-semibold tracking-wide uppercase ${tier === 'very' ? 'text-hot' : 'text-ink-muted'}`}
                    >
                      {TIER_BADGE[tier]}
                    </span>
                  ) : null}
                  <span className="text-ink-muted text-xs">{label(signal.network)}</span>
                  {signal.sentiment && signal.sentiment !== 'neutral' ? (
                    <span className="text-ink-muted text-xs">· {signal.sentiment}</span>
                  ) : null}
                  <span className="text-ink-muted text-xs">
                    · {relativeTime(signal.source_timestamp)}
                  </span>
                </div>
                <p className="mt-1 font-medium">{signal.display_name ?? 'Unattributed'}</p>
                <p className="mt-1 text-sm">{signal.summary}</p>
                {signal.source_url ? (
                  <a
                    className="text-accent mt-2 inline-block text-xs underline"
                    href={signal.source_url}
                    rel="noreferrer"
                  >
                    View source
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {error ? <p className="text-hot text-center text-sm">{error}</p> : null}
      {cursor ? (
        <button
          type="button"
          onClick={loadMore}
          disabled={loading}
          className="border-border self-center rounded-xl border px-4 py-2 text-sm disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </div>
  );
}
