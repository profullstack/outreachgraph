/**
 * Watching the workspace's own audience.
 *
 * What has to hold: an engagement opens the person who made it and records it
 * as a signal carrying the post's own words; the same engagement read again is
 * not a second signal, because a poll re-reads its window every time it runs;
 * a like does not raise identity confidence, so outbound stays gated; a rule
 * on `audience_engagement` enrols the person, which is the only route from a
 * signal to a plan; and a refusal the network will keep making stops the watch
 * instead of spending quota on it forever.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import { newId } from '@outreachgraph/domain';
import type {
  AudienceEngagement,
  AudienceReadInput,
  AudienceReadResult,
  AudienceReader,
} from '@outreachgraph/providers';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import {
  dueAudienceWatches,
  listAudienceWatches,
  recordEngagements,
  runAudienceWatch,
  saveAudienceWatch,
  sweepAudienceWatches,
  workspacesWithAudienceWatches,
  type AudienceWatch,
} from './audience';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

async function db(label: string): Promise<Client> {
  seeded = await seedDatabase(label);
  return seeded.db;
}

const WATCH = {
  workspaceId: SEED.workspaceId,
  campaignId: SEED.campaignId,
  network: 'bluesky',
  account: 'acme.bsky.social',
  mode: 'poll',
  kinds: ['follow', 'like', 'repost', 'reply'],
  pollMinutes: 30,
  lookbackPosts: 10,
  perRunCap: 100,
  enabled: true,
} as const;

const LIKE: AudienceEngagement = {
  kind: 'like',
  actor: {
    handle: 'dana.bsky.social',
    platformUserId: 'did:plc:dana',
    displayName: 'Dana',
    bio: 'CTO at a payments company',
  },
  subjectId: 'at://did:plc:acme/app.bsky.feed.post/abc',
  subjectUrl: 'https://bsky.app/profile/acme.bsky.social/post/abc',
  subjectText: 'We shipped deterministic policy checks today.',
};

/** A reader that answers with whatever the test hands it, and counts calls. */
function readerOf(result: AudienceReadResult, calls: AudienceReadInput[] = []): AudienceReader {
  return {
    network: 'bluesky',
    async read(input) {
      calls.push(input);
      return result;
    },
  };
}

function deps(client: Client, reader: AudienceReader | undefined, at?: Date) {
  return {
    db: client,
    ...(at ? { now: at } : {}),
    resolveReader: async () => reader,
  };
}

describe('saving and listing watches', () => {
  test('a second save of the same account edits it rather than duplicating it', async () => {
    const client = await db('audience-save');

    const first = await saveAudienceWatch(client, WATCH);
    const second = await saveAudienceWatch(client, { ...WATCH, kinds: ['reply'], pollMinutes: 60 });

    expect(second.id).toBe(first.id);
    expect(second.kinds).toEqual(['reply']);
    expect(second.pollMinutes).toBe(60);
    expect(await listAudienceWatches(client, SEED.workspaceId)).toHaveLength(1);
  });

  test('due only once the interval has elapsed, and never while disabled', async () => {
    const client = await db('audience-due');
    const watch = await saveAudienceWatch(client, WATCH);

    expect(await dueAudienceWatches(client, SEED.workspaceId)).toHaveLength(1);
    expect(await workspacesWithAudienceWatches(client)).toEqual([SEED.workspaceId]);

    await runAudienceWatch(deps(client, readerOf({ ok: true, engagements: [] })), watch);

    expect(await dueAudienceWatches(client, SEED.workspaceId)).toHaveLength(0);
    expect(
      await dueAudienceWatches(client, SEED.workspaceId, new Date(Date.now() + 31 * 60_000)),
    ).toHaveLength(1);

    await saveAudienceWatch(client, { ...WATCH, enabled: false });
    expect(
      await dueAudienceWatches(client, SEED.workspaceId, new Date(Date.now() + 31 * 60_000)),
    ).toHaveLength(0);
  });
});

describe('recording an engagement', () => {
  test('opens the person, keeps the post as evidence, and leaves them gated', async () => {
    const client = await db('audience-record');
    const watch = await saveAudienceWatch(client, WATCH);

    const result = await runAudienceWatch(
      deps(client, readerOf({ ok: true, engagements: [LIKE] })),
      watch,
    );

    expect(result.outcome).toBe('ok');
    expect(result.recorded).toBe(1);
    expect(result.peopleCreated).toBe(1);

    const signal = await queryOne<{
      person_id: string;
      summary: string;
      evidence: string;
      source_url: string;
      relevance: number;
      subtype: string;
    }>(
      client,
      `SELECT person_id, summary, evidence, source_url, relevance, subtype
         FROM signals WHERE signal_type = 'audience_engagement'`,
    );

    expect(signal?.subtype).toBe('like');
    expect(signal?.summary).toContain('@dana.bsky.social liked');
    // The post's own words, so a draft has something it may quote.
    expect(signal?.evidence).toBe('We shipped deterministic policy checks today.');
    expect(signal?.source_url).toBe(LIKE.subjectUrl);

    // A handle that clicked a heart is still a handle: identity confidence is
    // untouched, so the policy engine keeps refusing outbound until somebody
    // works out who they are.
    const person = await queryOne<{ identity_confidence: number }>(
      client,
      `SELECT identity_confidence FROM people WHERE id = ?`,
      [signal?.person_id ?? ''],
    );
    expect(person?.identity_confidence).toBeLessThan(0.5);

    // And they are in the campaign the watch names.
    const membership = await queryOne<{ status: string }>(
      client,
      `SELECT status FROM campaign_people WHERE campaign_id = ? AND person_id = ?`,
      [SEED.campaignId, signal?.person_id ?? ''],
    );
    expect(membership?.status).toBe('discovered');
  });

  test('the same engagement read again is not a second signal', async () => {
    const client = await db('audience-idempotent');
    const watch = await saveAudienceWatch(client, WATCH);

    const first = await runAudienceWatch(
      deps(client, readerOf({ ok: true, engagements: [LIKE] })),
      watch,
    );
    const second = await runAudienceWatch(
      deps(client, readerOf({ ok: true, engagements: [LIKE] })),
      watch,
    );

    expect(first.recorded).toBe(1);
    // Read again — a poll sees its whole window every time — and recorded once.
    expect(second.read).toBe(1);
    expect(second.recorded).toBe(0);

    const signals = await queryAll(
      client,
      `SELECT id FROM signals WHERE signal_type = 'audience_engagement'`,
    );
    expect(signals).toHaveLength(1);
  });

  test('a repost of the same post by the same person is a different act', async () => {
    const client = await db('audience-kinds');
    const watch = await saveAudienceWatch(client, WATCH);

    const result = await runAudienceWatch(
      deps(client, readerOf({ ok: true, engagements: [LIKE, { ...LIKE, kind: 'repost' }] })),
      watch,
    );

    expect(result.recorded).toBe(2);
    // One person, two signals: they liked it and then reposted it.
    const people = await queryAll(client, `SELECT id FROM social_identities WHERE handle = ?`, [
      'dana.bsky.social',
    ]);
    expect(people).toHaveLength(1);
  });

  test('a kind the watch does not read is skipped', async () => {
    const client = await db('audience-kind-filter');
    const watch = await saveAudienceWatch(client, { ...WATCH, kinds: ['reply'] });

    const result = await runAudienceWatch(
      deps(client, readerOf({ ok: true, engagements: [LIKE] })),
      watch,
    );

    expect(result.recorded).toBe(0);
  });

  test('a hand-off records identically, keeping its own source', async () => {
    const client = await db('audience-handoff');
    const watch = await saveAudienceWatch(client, {
      ...WATCH,
      network: 'linkedin',
      account: 'acme-co',
      mode: 'handoff',
    });

    const result = await recordEngagements(
      { db: client },
      {
        watch: watch as AudienceWatch,
        engagements: [{ ...LIKE, actor: { handle: 'dana-lee' }, subjectId: 'urn:li:activity:1' }],
        source: 'handoff:web',
      },
    );

    expect(result.recorded).toBe(1);
    const row = await queryOne<{ source: string; network: string }>(
      client,
      `SELECT source, network FROM audience_engagements`,
    );
    expect(row?.source).toBe('handoff:web');
    expect(row?.network).toBe('linkedin');
  });
});

describe('a rule turns an engagement into a plan', () => {
  test('a signal_received rule fires for the engagement', async () => {
    const client = await db('audience-rule');
    const watch = await saveAudienceWatch(client, WATCH);

    await client.execute({
      sql: `INSERT INTO automation_rules (id, workspace_id, name, trigger, condition_json,
                                          action, action_json, enabled, created_at, updated_at)
            VALUES (?, ?, 'warm engagers', 'signal_received', ?, 'notify', '{}', 1, ?, ?)`,
      args: [
        newId('rule'),
        SEED.workspaceId,
        JSON.stringify({ signalType: 'audience_engagement', minRelevance: 0.4 }),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    });

    await runAudienceWatch(deps(client, readerOf({ ok: true, engagements: [LIKE] })), watch);

    const runs = await queryAll<{ id: string }>(client, `SELECT id FROM rule_runs`);
    expect(runs.length).toBeGreaterThan(0);
  });
});

describe('when the network refuses', () => {
  test('a retryable refusal keeps the watch and records why', async () => {
    const client = await db('audience-retryable');
    const watch = await saveAudienceWatch(client, WATCH);

    const result = await runAudienceWatch(
      deps(client, readerOf({ ok: false, reason: 'bluesky rate limit reached', retryable: true })),
      watch,
    );

    expect(result.outcome).toBe('unreadable');
    const row = await queryOne<{ enabled: number; last_error: string }>(
      client,
      `SELECT enabled, last_error FROM audience_watches WHERE id = ?`,
      [watch.id],
    );
    expect(row?.enabled).toBe(1);
    expect(row?.last_error).toBe('bluesky rate limit reached');
  });

  test('a refusal that will not change stops the watch and says so', async () => {
    const client = await db('audience-fatal');
    const watch = await saveAudienceWatch(client, WATCH);

    const result = await runAudienceWatch(
      deps(client, readerOf({ ok: false, reason: 'needs a paid X API tier', retryable: false })),
      watch,
    );

    expect(result.outcome).toBe('disabled');

    const row = await queryOne<{ enabled: number; last_error: string }>(
      client,
      `SELECT enabled, last_error FROM audience_watches WHERE id = ?`,
      [watch.id],
    );
    expect(row?.enabled).toBe(0);
    expect(row?.last_error).toBe('needs a paid X API tier');

    // And the workspace is told, rather than the watch going quiet.
    const event = await queryOne<{ message: string }>(
      client,
      `SELECT message FROM workflow_events WHERE level = 'error' ORDER BY seq DESC LIMIT 1`,
    );
    expect(event?.message).toContain('paid X API tier');
  });

  test('re-enabling a stopped watch clears the reason it stopped', async () => {
    const client = await db('audience-reenable');
    const watch = await saveAudienceWatch(client, WATCH);
    await runAudienceWatch(
      deps(client, readerOf({ ok: false, reason: 'needs a paid X API tier', retryable: false })),
      watch,
    );

    await saveAudienceWatch(client, { ...WATCH, enabled: true });

    const row = await queryOne<{ enabled: number; last_error: string | null }>(
      client,
      `SELECT enabled, last_error FROM audience_watches WHERE id = ?`,
      [watch.id],
    );
    expect(row?.enabled).toBe(1);
    expect(row?.last_error).toBeNull();
  });

  test('no connected account is a reason, not a crash', async () => {
    const client = await db('audience-no-reader');
    const watch = await saveAudienceWatch(client, { ...WATCH, network: 'x', account: 'acme' });

    const result = await runAudienceWatch(deps(client, undefined), watch);

    expect(result.outcome).toBe('no_reader');
    expect(result.detail).toContain('no connected x account');
  });
});

describe('the sweep', () => {
  test('leaves the watches past the cap for the next tick, oldest first', async () => {
    const client = await db('audience-sweep-cap');
    for (const account of ['a.bsky.social', 'b.bsky.social', 'c.bsky.social']) {
      await saveAudienceWatch(client, { ...WATCH, account });
    }

    const read: string[] = [];
    const sweepDeps = {
      db: client,
      resolveReader: async (watch: AudienceWatch) => {
        read.push(watch.account);
        return readerOf({ ok: true, engagements: [] });
      },
    };

    // Two a tick: a watch is thirty round trips, and the queue drain and the
    // send sweep are behind this in the same minute.
    const first = await sweepAudienceWatches(sweepDeps, {
      workspaceId: SEED.workspaceId,
      limit: 2,
    });
    expect(first.ran).toBe(2);
    expect(read).toEqual(['a.bsky.social', 'b.bsky.social']);

    // The one left over is still due, and is now the longest waiting.
    const second = await sweepAudienceWatches(sweepDeps, {
      workspaceId: SEED.workspaceId,
      limit: 2,
    });
    expect(second.ran).toBe(1);
    expect(read).toEqual(['a.bsky.social', 'b.bsky.social', 'c.bsky.social']);
  });

  test('runs every due watch and survives one that throws', async () => {
    const client = await db('audience-sweep');
    await saveAudienceWatch(client, WATCH);
    await saveAudienceWatch(client, { ...WATCH, account: 'other.bsky.social' });

    const thrower: AudienceReader = {
      network: 'bluesky',
      async read() {
        throw new Error('socket hang up');
      },
    };

    const result = await sweepAudienceWatches(
      {
        db: client,
        resolveReader: async (watch) =>
          watch.account === 'acme.bsky.social'
            ? readerOf({ ok: true, engagements: [LIKE] })
            : thrower,
      },
      { workspaceId: SEED.workspaceId },
    );

    expect(result.ran).toBe(1);
    expect(result.recorded).toBe(1);

    // The one that threw was still stamped, so it is not retried immediately.
    const broken = await queryOne<{ last_error: string; last_polled_at: string }>(
      client,
      `SELECT last_error, last_polled_at FROM audience_watches WHERE account = ?`,
      ['other.bsky.social'],
    );
    expect(broken?.last_error).toBe('socket hang up');
    expect(broken?.last_polled_at).toBeTruthy();
  });
});
