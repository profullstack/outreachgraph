'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

export interface ProductRowView {
  readonly id: string;
  readonly name: string;
  readonly host: string | null;
  readonly leads: number;
  readonly replies: number;
  readonly waiting: number;
  readonly working: boolean;
  readonly autopilot: boolean;
  readonly status: string | null;
}

type SortKey = 'replies' | 'waiting' | 'leads' | 'name';

const SORTS: readonly { key: SortKey; label: string }[] = [
  { key: 'replies', label: 'Most replies' },
  { key: 'waiting', label: 'Most waiting' },
  { key: 'leads', label: 'Most leads' },
  { key: 'name', label: 'Name' },
];

/**
 * Every product as one line, sortable and searchable.
 *
 * Fifty-odd products as full cards was a page of scrolling with no way to find
 * the one that needs you. A row per product with the three numbers that
 * matter — replies, waiting, leads — sorted by replies, puts the working ones
 * and the ones that need attention at the top. One click opens it.
 */
export function ProductTable({ rows }: { rows: readonly ProductRowView[] }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('replies');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? rows.filter(
          (row) =>
            row.name.toLowerCase().includes(needle) || row.host?.toLowerCase().includes(needle),
        )
      : [...rows];
    return matched.sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : b[sort] - a[sort] || a.name.localeCompare(b.name),
    );
  }, [rows, query, sort]);

  return (
    <div>
      <div className="mb-3 flex gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${rows.length} products`}
          className="border-border bg-surface min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm"
        />
        <select
          value={sort}
          onChange={(event) => setSort(event.target.value as SortKey)}
          aria-label="Sort"
          className="border-border bg-surface rounded-xl border px-2 py-2 text-sm"
        >
          {SORTS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="border-border overflow-hidden rounded-2xl border">
        <div className="text-ink-muted bg-surface grid grid-cols-[1fr_3.25rem_3.25rem_3.25rem] gap-2 px-3 py-2 text-[11px] font-semibold tracking-wide uppercase">
          <span>Product</span>
          <span className="text-right">Leads</span>
          <span className="text-right">Replies</span>
          <span className="text-right">Waiting</span>
        </div>
        <ul className="divide-border divide-y">
          {visible.map((row) => (
            <li key={row.id}>
              <Link
                href={`/products/${encodeURIComponent(row.id)}`}
                className="bg-surface-raised grid grid-cols-[1fr_3.25rem_3.25rem_3.25rem] items-center gap-2 px-3 py-2.5"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span
                      title={statusTitle(row)}
                      className={`h-2 w-2 shrink-0 rounded-full ${dotColor(row)}`}
                    />
                    <span className="truncate text-sm font-medium">{row.name}</span>
                  </span>
                  <span className="text-ink-muted block truncate text-xs">
                    {row.host ?? ''}
                    {row.autopilot ? ' · autopilot' : ''}
                  </span>
                </span>
                <Num value={row.leads} />
                <Num value={row.replies} strong={row.replies > 0} />
                <Num value={row.waiting} strong={row.waiting > 0} />
              </Link>
            </li>
          ))}
        </ul>
        {visible.length === 0 ? (
          <p className="text-ink-muted p-6 text-center text-sm">Nothing matches “{query}”.</p>
        ) : null}
      </div>
    </div>
  );
}

function Num({ value, strong }: { value: number; strong?: boolean }) {
  return (
    <span
      className={`text-right text-sm tabular-nums ${strong ? 'font-semibold' : 'text-ink-muted'}`}
    >
      {value.toLocaleString()}
    </span>
  );
}

function dotColor(row: ProductRowView): string {
  if (row.status === 'paused' || row.status === 'archived') return 'bg-border';
  if (row.working) return 'bg-accent animate-pulse';
  return 'bg-good';
}

function statusTitle(row: ProductRowView): string {
  if (row.status === 'paused') return 'Paused';
  if (row.status === 'archived') return 'Archived';
  if (row.working) return 'Working';
  return 'Running';
}
