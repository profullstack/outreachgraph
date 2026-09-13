/**
 * People handed over by a social client, and the OpenProfile read that
 * follows.
 *
 * What has to hold: a handle opens one person, once, at the handle-only
 * confidence; the bio is a signal so a card can trigger; the same handle sent
 * again is the same person with no second signal and no second job; junk is
 * rejected by name and never fails the batch. Then the job: it reads the
 * network's profile and the linked site, a rel=me back from the site raises
 * the person past the floor and keeps the site's accounts as identities, the
 * Markdown is stored, and the person is re-decided.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { intakeSocialPeople, normaliseSocialInput } from './social-intake';
import { runOpenProfileJob } from './openprofile';
import type { QueuedJob } from './queue';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

async function db(label: string): Promise<Client> {
  seeded = await seedDatabase(label);
  return seeded.db;
}

const ADA = {
  network: 'bluesky',
  handle: '@ada.example',
  displayName: 'Ada',
  bio: 'Engines and poetry. https://ada.example',
  avatarUrl: 'https://cdn.bsky.app/ada.jpg',
  via: 'following',
};

describe('normaliseSocialInput', () => {
  test('drops the @, keeps a Fediverse host, derives the profile URL, refuses junk', () => {
    expect(normaliseSocialInput({ network: 'Bluesky', handle: '@ada.example' })).toEqual({
      network: 'bluesky',
      handle: 'ada.example',
      profileUrl: 'https://bsky.app/profile/ada.example',
    });
    expect(normaliseSocialInput({ network: 'mastodon', handle: 'ada@hachyderm.io' })).toEqual({
      network: 'mastodon',
      handle: 'ada@hachyderm.io',
      profileUrl: 'https://hachyderm.io/@ada',
    });
    expect(normaliseSocialInput({ network: 'tiktok', handle: 'ada' })).toEqual({
      reason: 'unknown network tiktok',
    });
    expect(normaliseSocialInput({ network: 'x', handle: 'not a handle' })).toEqual({
      reason: 'not a handle',
    });
    expect(
      normaliseSocialInput({ network: 'x', handle: 'ada', profileUrl: 'javascript:alert(1)' }),
    ).toEqual({
      network: 'x',
      handle: 'ada',
      profileUrl: undefined,
    });
  });
});

describe('intakeSocialPeople', () => {
  test('opens a person once, in the campaign, with a bio signal and one openprofile job', async () => {
    const client = await db('intake-once');
    const input = {
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      source: 'myna',
      people: [ADA],
    };

    const first = await intakeSocialPeople({ db: client }, input);
    expect(first).toMatchObject({ created: 1, existing: 0, queued: 1, rejected: [] });
    const [person] = first.people;
    expect(person).toMatchObject({
      network: 'bluesky',
      handle: 'ada.example',
      created: true,
      queued: true,
    });

    const row = await queryOne<{
      display_name: string;
      identity_confidence: number;
      avatar_url: string;
      avatar_source: string;
    }>(
      client,
      'SELECT display_name, identity_confidence, avatar_url, avatar_source FROM people WHERE id = ?',
      [person!.id],
    );
    expect(row).toEqual({
      display_name: 'Ada',
      identity_confidence: 0.35,
      avatar_url: 'https://cdn.bsky.app/ada.jpg',
      avatar_source: 'myna',
    });

    const identity = await queryOne<{ handle: string; profile_url: string; confidence: number }>(
      client,
      'SELECT handle, profile_url, confidence FROM social_identities WHERE person_id = ? AND network = ?',
      [person!.id, 'bluesky'],
    );
    expect(identity).toEqual({
      handle: 'ada.example',
      profile_url: 'https://bsky.app/profile/ada.example',
      confidence: 0.35,
    });

    const membership = await queryOne<{ status: string }>(
      client,
      'SELECT status FROM campaign_people WHERE campaign_id = ? AND person_id = ?',
      [SEED.campaignId, person!.id],
    );
    expect(membership?.status).toBe('discovered');

    const signals = await queryAll<{ signal_type: string; subtype: string; summary: string }>(
      client,
      'SELECT signal_type, subtype, summary FROM signals WHERE person_id = ?',
      [person!.id],
    );
    expect(signals).toEqual([
      {
        signal_type: 'content_topic',
        subtype: 'social_bio',
        summary: 'ada.example: Engines and poetry. https://ada.example',
      },
    ]);

    const jobs = await queryAll<{ kind: string; payload_json: string; dedupe_key: string }>(
      client,
      'SELECT kind, payload_json, dedupe_key FROM jobs WHERE workspace_id = ? AND kind = ?',
      [SEED.workspaceId, 'openprofile'],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.dedupe_key).toBe(`openprofile:${person!.id}`);
    expect(JSON.parse(jobs[0]!.payload_json)).toMatchObject({
      personId: person!.id,
      campaignId: SEED.campaignId,
      profileUrl: 'https://bsky.app/profile/ada.example',
      via: 'following',
    });

    // The same handle again, differently cased: the same person, nothing doubled.
    const second = await intakeSocialPeople(
      { db: client },
      { ...input, people: [{ ...ADA, handle: 'Ada.Example' }] },
    );
    expect(second).toMatchObject({ created: 0, existing: 1, queued: 0 });
    expect(second.people[0]!.id).toBe(person!.id);
    expect(
      await queryAll(client, 'SELECT id FROM signals WHERE person_id = ?', [person!.id]),
    ).toHaveLength(1);
    expect(
      await queryAll(client, 'SELECT id FROM jobs WHERE kind = ?', ['openprofile']),
    ).toHaveLength(1);
  });

  test('junk is rejected by name and the rest of the batch still lands', async () => {
    const client = await db('intake-reject');
    const result = await intakeSocialPeople(
      { db: client },
      {
        workspaceId: SEED.workspaceId,
        campaignId: SEED.campaignId,
        source: 'myna',
        people: [
          { network: 'tiktok', handle: 'x' },
          { network: 'x', handle: '' },
          { network: 'mastodon', handle: 'bob@mastodon.social' },
        ],
      },
    );
    expect(result.rejected).toEqual([
      { handle: 'x', reason: 'unknown network tiktok' },
      { handle: '', reason: 'not a handle' },
    ]);
    expect(result.created).toBe(1);
    expect(result.people[0]).toMatchObject({ network: 'mastodon', handle: 'bob@mastodon.social' });
  });
});

const SITE_HTML = `<!doctype html><html><head><title>Ada Lovelace</title>
<meta property="og:title" content="Ada Lovelace"><meta property="og:description" content="Writes about machines that do not exist yet.">
<meta property="og:image" content="https://ada.example/ada.png">
<link rel="me" href="https://github.com/ada"></head>
<body><a rel="me" href="https://bsky.app/profile/ada.example">Bluesky</a><a rel="me" href="mailto:ada@example.com">mail</a></body></html>`;

function stubFetch(pages: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const found = pages[url];
    return found ? found() : new Response('', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('runOpenProfileJob', () => {
  test('reads the profile and the site, keeps what they corroborate, writes the file, re-decides', async () => {
    const client = await db('openprofile-job');
    const intake = await intakeSocialPeople(
      { db: client },
      { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId, source: 'myna', people: [ADA] },
    );
    const personId = intake.people[0]!.id;
    const job = await queryOne<{ id: string; payload_json: string }>(
      client,
      'SELECT id, payload_json FROM jobs WHERE kind = ?',
      ['openprofile'],
    );

    const fetchImpl = stubFetch({
      'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=ada.example': () =>
        new Response(
          JSON.stringify({
            did: 'did:plc:ada',
            handle: 'ada.example',
            displayName: 'Ada Lovelace',
            description: 'Engines and poetry. https://ada.example',
            avatar: 'https://cdn.bsky.app/ada.jpg',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      'https://ada.example/': () =>
        new Response(SITE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
      'https://ada.example': () =>
        new Response(SITE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
    });

    const queued: QueuedJob = {
      id: job!.id,
      workspaceId: SEED.workspaceId,
      kind: 'openprofile',
      payload: JSON.parse(job!.payload_json),
      attempts: 0,
      maxAttempts: 5,
    };
    const result = await runOpenProfileJob({ db: client, fetchImpl }, queued);
    expect(result).toMatchObject({ personId, outcome: 'ok', corroborated: true });
    expect(result.identities).toBeGreaterThanOrEqual(2);

    const stored = await queryOne<{
      markdown: string;
      sources_json: string;
      published_url: string | null;
    }>(
      client,
      'SELECT markdown, sources_json, published_url FROM openprofiles WHERE person_id = ?',
      [personId],
    );
    expect(stored?.published_url).toBeNull();
    expect(JSON.parse(stored!.sources_json)).toEqual([
      'https://bsky.app/profile/ada.example',
      'https://ada.example/',
    ]);
    expect(stored!.markdown).toContain('# Ada Lovelace');
    expect(stored!.markdown).toContain('- **Web**: https://ada.example');
    expect(stored!.markdown).toContain('- **Email**: ada@example.com');
    expect(stored!.markdown).toContain('- [Bluesky](https://bsky.app/profile/ada.example)');
    expect(stored!.markdown).toContain('- [GitHub](https://github.com/ada)');

    const person = await queryOne<{ display_name: string; identity_confidence: number }>(
      client,
      'SELECT display_name, identity_confidence FROM people WHERE id = ?',
      [personId],
    );
    expect(person).toEqual({ display_name: 'Ada', identity_confidence: 0.9 });

    const identities = await queryAll<{
      network: string;
      handle: string;
      confidence: number;
      platform_user_id: string | null;
    }>(
      client,
      'SELECT network, handle, confidence, platform_user_id FROM social_identities WHERE person_id = ? ORDER BY network, handle',
      [personId],
    );
    expect(identities).toEqual([
      {
        network: 'bluesky',
        handle: 'ada.example',
        confidence: 0.9,
        platform_user_id: 'did:plc:ada',
      },
      { network: 'email', handle: 'ada@example.com', confidence: 0.9, platform_user_id: null },
      { network: 'github', handle: 'ada', confidence: 0.9, platform_user_id: null },
    ]);

    // A card exists for them now: the bio signal was the trigger.
    const cards = await queryAll<{ action: string; status: string }>(
      client,
      'SELECT action, status FROM recommendations WHERE person_id = ?',
      [personId],
    );
    expect(cards.length).toBeGreaterThanOrEqual(1);
    expect(result.recommendationId).toBeDefined();
  });

  test('a site that does not link back leaves the person at the profile-seen confidence', async () => {
    const client = await db('openprofile-uncorroborated');
    const intake = await intakeSocialPeople(
      { db: client },
      {
        workspaceId: SEED.workspaceId,
        campaignId: SEED.campaignId,
        source: 'myna',
        people: [{ network: 'bluesky', handle: 'bob.example', bio: 'See https://bob.example' }],
      },
    );
    const personId = intake.people[0]!.id;
    const fetchImpl = stubFetch({
      'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=bob.example': () =>
        new Response(
          JSON.stringify({
            did: 'did:plc:bob',
            handle: 'bob.example',
            displayName: 'Bob',
            description: 'See https://bob.example',
          }),
          { status: 200 },
        ),
      'https://bob.example/': () =>
        new Response(
          '<html><head><title>Bob</title></head><body><a href="https://github.com/someone-else">gh</a></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
    });
    const result = await runOpenProfileJob(
      { db: client, fetchImpl, regenerate: false },
      {
        id: 'job_x',
        workspaceId: SEED.workspaceId,
        kind: 'openprofile',
        payload: { personId, campaignId: SEED.campaignId },
        attempts: 0,
        maxAttempts: 5,
      },
    );
    expect(result).toMatchObject({
      outcome: 'ok',
      corroborated: false,
      recommendationId: undefined,
    });

    const person = await queryOne<{ identity_confidence: number }>(
      client,
      'SELECT identity_confidence FROM people WHERE id = ?',
      [personId],
    );
    expect(person?.identity_confidence).toBe(0.5);
    const github = await queryOne<{ confidence: number }>(
      client,
      'SELECT confidence FROM social_identities WHERE person_id = ? AND network = ?',
      [personId, 'github'],
    );
    expect(github?.confidence).toBe(0.6);
    const stored = await queryOne<{ markdown: string }>(
      client,
      'SELECT markdown FROM openprofiles WHERE person_id = ?',
      [personId],
    );
    expect(stored!.markdown).toContain('## Links\n\n- [GitHub](https://github.com/someone-else)');
  });

  test('a profile nobody answers for is reported, not thrown', async () => {
    const client = await db('openprofile-unreadable');
    const intake = await intakeSocialPeople(
      { db: client },
      {
        workspaceId: SEED.workspaceId,
        campaignId: SEED.campaignId,
        source: 'myna',
        people: [{ network: 'bluesky', handle: 'gone.example' }],
      },
    );
    const result = await runOpenProfileJob(
      { db: client, fetchImpl: stubFetch({}) },
      {
        id: 'job_y',
        workspaceId: SEED.workspaceId,
        kind: 'openprofile',
        payload: { personId: intake.people[0]!.id },
        attempts: 0,
        maxAttempts: 5,
      },
    );
    expect(result.outcome).toBe('unreadable');
    expect(
      await queryOne(client, 'SELECT person_id FROM openprofiles WHERE person_id = ?', [
        intake.people[0]!.id,
      ]),
    ).toBeUndefined();
  });
});
