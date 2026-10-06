/**
 * Refining the signal feed, in the browser.
 *
 * Filters apply to the posts already loaded: the feed is a page at a time, and
 * re-querying the server on every tick of a checkbox would cost a round trip
 * to answer a question the browser can answer from memory. "Load more" widens
 * what is loaded; export takes exactly what the filters show.
 *
 * Pure, so every rule here is tested without rendering anything.
 */
import type { SignalRow } from './types';

export type SortKey = 'relevance' | 'newest' | 'network';
export type RelevanceTier = 'any' | 'possible' | 'relevant' | 'very';
export type Tone = 'any' | 'positive' | 'neutral' | 'negative';

export interface SignalFilters {
  sort: SortKey;
  minTier: RelevanceTier;
  tone: Tone;
  /** Networks to show. Empty means every network. */
  networks: readonly string[];
}

export const DEFAULT_FILTERS: SignalFilters = {
  sort: 'relevance',
  minTier: 'any',
  tone: 'any',
  networks: [],
};

/**
 * The relevance floor for each tier. "Very relevant" is the 0.8 the feed has
 * always labelled "High intent", so the two words never disagree.
 */
export const TIER_FLOOR: Record<RelevanceTier, number> = {
  any: 0,
  possible: 0.4,
  relevant: 0.6,
  very: 0.8,
};

export const TIER_LABEL: Record<RelevanceTier, string> = {
  any: 'Any match',
  possible: 'Possible+',
  relevant: 'Relevant+',
  very: 'Very relevant',
};

export const SORT_LABEL: Record<SortKey, string> = {
  relevance: 'Most relevant',
  newest: 'Newest first',
  network: 'By network',
};

export const TONE_LABEL: Record<Tone, string> = {
  any: 'Any tone',
  positive: 'Positive',
  neutral: 'Neutral',
  negative: 'Negative',
};

/** What a post's tier reads as, for a badge. */
export function tierOf(relevance: number): Exclude<RelevanceTier, 'any'> | null {
  if (relevance >= TIER_FLOOR.very) return 'very';
  if (relevance >= TIER_FLOOR.relevant) return 'relevant';
  if (relevance >= TIER_FLOOR.possible) return 'possible';
  return null;
}

const when = (s: SignalRow): number => Date.parse(s.source_timestamp ?? s.observed_at ?? '') || 0;

/** The networks present in what is loaded, in a stable order, with counts. */
export function networksIn(
  signals: readonly SignalRow[],
): Array<{ network: string; count: number }> {
  const counts = new Map<string, number>();
  for (const s of signals) counts.set(s.network, (counts.get(s.network) ?? 0) + 1);
  return [...counts.entries()]
    .map(([network, count]) => ({ network, count }))
    .sort((a, b) => a.network.localeCompare(b.network));
}

/** Filter, then sort. Ties fall back to newest, then id, so the order never jitters. */
export function applyFilters(signals: readonly SignalRow[], f: SignalFilters): SignalRow[] {
  const floor = TIER_FLOOR[f.minTier];
  const networks = new Set(f.networks);
  const out = signals.filter(
    (s) =>
      s.relevance >= floor &&
      (f.tone === 'any' || (s.sentiment ?? 'neutral') === f.tone) &&
      (networks.size === 0 || networks.has(s.network)),
  );
  const newest = (a: SignalRow, b: SignalRow) => when(b) - when(a) || b.id.localeCompare(a.id);
  out.sort((a, b) => {
    if (f.sort === 'relevance') return b.relevance - a.relevance || newest(a, b);
    if (f.sort === 'network')
      return a.network.localeCompare(b.network) || b.relevance - a.relevance || newest(a, b);
    return newest(a, b);
  });
  return out;
}

const cell = (value: unknown): string => {
  const s = value == null ? '' : String(value);
  // Quote anything a spreadsheet would split or misread, and neuter a leading
  // =, +, - or @ so an exported post cannot become a formula.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The filtered posts as CSV, ready for a spreadsheet or a CRM import. */
export function toCsv(signals: readonly SignalRow[]): string {
  const head = [
    'network',
    'name',
    'summary',
    'relevance',
    'tone',
    'type',
    'posted_at',
    'url',
    'person_id',
  ];
  const rows = signals.map((s) => [
    s.network,
    s.display_name ?? '',
    s.summary,
    s.relevance.toFixed(2),
    s.sentiment ?? 'neutral',
    s.signal_type,
    s.source_timestamp ?? s.observed_at ?? '',
    s.source_url ?? '',
    s.person_id ?? '',
  ]);
  return `${[head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
