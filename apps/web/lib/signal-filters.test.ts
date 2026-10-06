import { describe, expect, test } from 'bun:test';
import { DEFAULT_FILTERS, applyFilters, networksIn, tierOf, toCsv } from './signal-filters';
import type { SignalRow } from './types';

const sig = (over: Partial<SignalRow>): SignalRow => ({
  id: 'sig_1',
  person_id: null,
  display_name: 'Ada',
  network: 'reddit',
  signal_type: 'recommendation_request',
  summary: 'Anyone recommend an invoicing tool?',
  source_url: 'https://reddit.com/r/x/1',
  source_timestamp: '2026-10-06T10:00:00Z',
  relevance: 0.5,
  sentiment: 'neutral',
  ...over,
});

const feed = [
  sig({
    id: 'a',
    relevance: 0.9,
    network: 'reddit',
    sentiment: 'negative',
    source_timestamp: '2026-10-01T00:00:00Z',
  }),
  sig({
    id: 'b',
    relevance: 0.65,
    network: 'bluesky',
    sentiment: 'positive',
    source_timestamp: '2026-10-05T00:00:00Z',
  }),
  sig({
    id: 'c',
    relevance: 0.45,
    network: 'hackernews',
    sentiment: 'neutral',
    source_timestamp: '2026-10-06T00:00:00Z',
  }),
  sig({
    id: 'd',
    relevance: 0.2,
    network: 'reddit',
    sentiment: 'neutral',
    source_timestamp: '2026-10-04T00:00:00Z',
  }),
];

const ids = (rows: SignalRow[]) => rows.map((r) => r.id);

describe('refine results', () => {
  test('defaults show everything, most relevant first', () => {
    expect(ids(applyFilters(feed, DEFAULT_FILTERS))).toEqual(['a', 'b', 'c', 'd']);
  });

  test('sort newest first, or by network then relevance', () => {
    expect(ids(applyFilters(feed, { ...DEFAULT_FILTERS, sort: 'newest' }))).toEqual([
      'c',
      'b',
      'd',
      'a',
    ]);
    expect(ids(applyFilters(feed, { ...DEFAULT_FILTERS, sort: 'network' }))).toEqual([
      'b',
      'c',
      'a',
      'd',
    ]);
  });

  test('the relevance floor is a tier', () => {
    expect(ids(applyFilters(feed, { ...DEFAULT_FILTERS, minTier: 'possible' }))).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(ids(applyFilters(feed, { ...DEFAULT_FILTERS, minTier: 'relevant' }))).toEqual([
      'a',
      'b',
    ]);
    expect(ids(applyFilters(feed, { ...DEFAULT_FILTERS, minTier: 'very' }))).toEqual(['a']);
    expect(tierOf(0.8)).toBe('very');
    expect(tierOf(0.39)).toBeNull();
  });

  test('tone and networks narrow it; no networks ticked means all', () => {
    expect(ids(applyFilters(feed, { ...DEFAULT_FILTERS, tone: 'negative' }))).toEqual(['a']);
    expect(ids(applyFilters(feed, { ...DEFAULT_FILTERS, networks: ['reddit'] }))).toEqual([
      'a',
      'd',
    ]);
    expect(
      ids(applyFilters(feed, { ...DEFAULT_FILTERS, networks: ['reddit'], minTier: 'relevant' })),
    ).toEqual(['a']);
    expect(
      ids(
        applyFilters([sig({ id: 'x', sentiment: undefined })], {
          ...DEFAULT_FILTERS,
          tone: 'neutral',
        }),
      ),
    ).toEqual(['x']);
  });

  test('networks are counted from what is loaded', () => {
    expect(networksIn(feed)).toEqual([
      { network: 'bluesky', count: 1 },
      { network: 'hackernews', count: 1 },
      { network: 'reddit', count: 2 },
    ]);
  });

  test('export quotes what a spreadsheet would split and defuses formulas', () => {
    const csv = toCsv([
      sig({ summary: 'Need a tool, "cheap", for\ninvoices', display_name: '=HYPERLINK("x")' }),
    ]);
    const [head, row] = csv.trim().split('\r\n');
    expect(head).toBe('network,name,summary,relevance,tone,type,posted_at,url,person_id');
    expect(
      row.startsWith(
        'reddit,"\'=HYPERLINK(""x"")","Need a tool, ""cheap"", for\ninvoices",0.50,neutral',
      ),
    ).toBe(true);
  });
});
