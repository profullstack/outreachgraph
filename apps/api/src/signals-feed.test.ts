/**
 * The signal feed pages with a cursor, so "Load more" in Refine results walks
 * the whole feed: no post skipped and none repeated, even when several share a
 * timestamp, and the last page says there is nothing after it.
 */
import { afterEach, expect, test } from 'bun:test';
import { createApp } from './app';
import type { RequestActor } from './context';
import { parseSignalCursor } from './repository';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

let active: SeededDatabase | undefined;
afterEach(() => {
  active?.cleanup();
  active = undefined;
});

test('load more walks every signal once, ties included, and ends', async () => {
  const seeded = await seedDatabase('signals-feed');
  active = seeded;
  await seeded.db.execute({
    sql: 'DELETE FROM signals WHERE workspace_id = ?',
    args: [SEED.workspaceId],
  });
  // Seven posts, three of them stamped the same second.
  const stamps = [
    '2026-10-06T10:00:00Z',
    '2026-10-06T09:00:00Z',
    '2026-10-06T09:00:00Z',
    '2026-10-06T09:00:00Z',
    '2026-10-05T00:00:00Z',
    '2026-10-04T00:00:00Z',
    '2026-10-03T00:00:00Z',
  ];
  await seeded.db.batch(
    stamps.map((stamp, i) => ({
      sql: `INSERT INTO signals (id, workspace_id, network, signal_type, summary, evidence, source_timestamp, observed_at, confidence, relevance, sentiment)
            VALUES (?, ?, ?, 'recommendation_request', ?, '[]', ?, ?, 0.5, ?, ?)`,
      args: [
        `sig_${i}`,
        SEED.workspaceId,
        i % 2 ? 'reddit' : 'bluesky',
        `post ${i}`,
        stamp,
        stamp,
        0.1 * (i + 1),
        i === 0 ? 'negative' : 'neutral',
      ],
    })),
  );
  const app = createApp({ db: seeded.db, authenticate: async () => ACTOR });

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const res = await app.request(
      `/api/v1/signals?limit=3${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signals: Array<{ id: string; sentiment: string }>;
      next_cursor: string | null;
    };
    seen.push(...body.signals.map((s) => s.id));
    cursor = body.next_cursor;
    if (!cursor) break;
  }
  expect(seen).toHaveLength(7);
  expect(new Set(seen).size).toBe(7);
  expect(seen[0]).toBe('sig_0');
  expect(seen.at(-1)).toBe('sig_6');
});

test('a malformed cursor reads as none', () => {
  expect(parseSignalCursor('2026-10-06T09:00:00Z|sig_2')).toEqual({
    at: '2026-10-06T09:00:00Z',
    id: 'sig_2',
  });
  expect(parseSignalCursor('nonsense')).toBeNull();
  expect(parseSignalCursor('|x')).toBeNull();
  expect(parseSignalCursor('x|')).toBeNull();
  expect(parseSignalCursor(undefined)).toBeNull();
});
