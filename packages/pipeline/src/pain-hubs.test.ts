/**
 * Pain phrases on buyer-lead monitors, and campaign hubs.
 *
 * What has to hold: a pain phrase matches literally and with words in
 * between, never across sentences; it is searched before the keywords, a
 * match records it, reads as a problem post, gets a bonus over the model's
 * score unless the model ruled it out, and lists before any keyword match;
 * phrases are drafted by the model and merged with a person's. Hubs need two
 * leads behind them, weigh replies double, skip Bluesky's default follow and
 * the lead itself, list X/LinkedIn leads to watch by hand, and the ranking is
 * stored and read back.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { StubModel } from '@outreachgraph/ai';
import type { Client } from '@outreachgraph/db';
import type { FeedPost, FeedSource } from '@outreachgraph/providers';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import {
  createLeadMonitor,
  generatePainPhrases,
  listCommunityLeads,
  matchPainPhrase,
  scanLeadMonitor,
  PAIN_BONUS,
} from './community-leads';
import { computeCampaignHubs, getCampaignHubs, rankHubs } from './campaign-hubs';

setDefaultTimeout(30_000);

let seeded: SeededDatabase | undefined;
afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});
async function db(label: string): Promise<Client> {
  seeded = await seedDatabase(label);
  return seeded.db;
}

const NOW = new Date('2026-10-28T15:00:00Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

describe('pain phrases', () => {
  test('match literally, with words in between, not across sentences', () => {
    const phrases = ["can't find communities", 'nobody sees my posts'];
    expect(matchPainPhrase('İ cant find enough communities', phrases)).toBe(
      "can't find communities",
    );
    expect(matchPainPhrase('I can’t seem to find any active communities', phrases)).toBe(
      "can't find communities",
    );
    expect(matchPainPhrase('Honestly nobody sees my posts.', phrases)).toBe('nobody sees my posts');
    expect(
      matchPainPhrase("I can't sleep. Find me in the communities tab.", phrases),
    ).toBeUndefined();
  });

  test('searched first; a match outranks a newer keyword match and gets the bonus', async () => {
    const client = await db('pain-scan');
    const monitor = await createLeadMonitor({ db: client }, SEED.workspaceId, {
      name: 'myna',
      url: 'https://mynaposter.com',
      keywords: ['social media scheduler'],
      painPhrases: ["Can't find communities", 'SaaS growth tips', 'nobody sees my posts'],
      subreddits: ['micro_saas'],
      sources: ['reddit'],
      minIntent: 50,
    });
    expect(monitor.painPhrases).toEqual(["can't find communities", 'nobody sees my posts']);
    const terms: string[][] = [];
    const posts: FeedPost[] = [
      {
        network: 'reddit',
        externalId: 'p1',
        authorHandle: 'BoysenberryNo5650',
        url: 'https://www.reddit.com/r/micro_saas/comments/p1/',
        title: 'I cant find enough communities',
        text: 'Launched 2 days ago, got only 2 users. Can anyone help?',
        postedAt: ago(6),
        container: 'r/micro_saas',
      },
      {
        network: 'reddit',
        externalId: 'k1',
        authorHandle: 'buyer',
        url: 'https://www.reddit.com/r/micro_saas/comments/k1/',
        title: 'Best social media scheduler for a small team?',
        text: 'Best social media scheduler for a small team? Budget is small.',
        postedAt: ago(1),
        container: 'r/micro_saas',
      },
    ];
    const source: FeedSource = {
      network: 'reddit',
      slug: 'reddit',
      displayName: 'reddit',
      async search(input) {
        terms.push([...input.terms]);
        return posts;
      },
    };
    const model = new StubModel(
      JSON.stringify({
        results: [
          { id: '0', intent: 70, reason: 'asking for a scheduler' },
          { id: '1', intent: 70, reason: 'launched, no audience' },
        ],
      }),
    );
    await scanLeadMonitor(
      { db: client, model, sources: () => [source], now: NOW },
      SEED.workspaceId,
      monitor.id,
    );
    expect(terms[0]?.slice(0, 2)).toEqual(["can't find communities", 'nobody sees my posts']);
    const leads = await listCommunityLeads(client, SEED.workspaceId, { monitorId: monitor.id });
    expect(leads.map((l) => l.externalId)).toEqual(['p1', 'k1']);
    expect(leads[0]?.painPhrase).toBe("can't find communities");
    expect(leads[0]?.intent).toBe(70 + PAIN_BONUS);
    expect(leads[1]?.painPhrase).toBeUndefined();
    expect(leads[1]?.intent).toBe(70);
  });

  test('drafted by the model and merged with what a person kept', async () => {
    const client = await db('pain-generate');
    const monitor = await createLeadMonitor({ db: client }, SEED.workspaceId, {
      name: 'myna',
      keywords: ['posting'],
      painPhrases: ['nobody sees my posts'],
    });
    const model = new StubModel(
      JSON.stringify({ phrases: ['no one replies to my posts', 'best SaaS tool', 'myna is slow'] }),
    );
    const next = await generatePainPhrases({ db: client, model }, SEED.workspaceId, monitor.id);
    expect(next?.painPhrases).toEqual(['nobody sees my posts', 'no one replies to my posts']);
  });
});

/** Answers the Bluesky AppView for three leads. */
function bsky(calls: string[]): typeof fetch {
  const follows: Record<string, string[]> = {
    'a.bsky.social': [
      'hub.bsky.social',
      'bsky.app',
      'handle.invalid',
      'solo.bsky.social',
      'b.bsky.social',
    ],
    'b.bsky.social': ['hub.bsky.social', 'bsky.app', 'handle.invalid', 'replied.bsky.social'],
    'c.bsky.social': ['other.bsky.social'],
  };
  const replies: Record<string, string[]> = {
    'a.bsky.social': ['replied.bsky.social', 'a.bsky.social'],
    'b.bsky.social': [],
    'c.bsky.social': ['replied.bsky.social'],
  };
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const actor = url.searchParams.get('actor') ?? '';
    const body = url.pathname.endsWith('getFollows')
      ? {
          follows: (follows[actor] ?? []).map((handle) => ({
            handle,
            displayName: handle.split('.')[0],
          })),
        }
      : {
          feed: (replies[actor] ?? []).map((handle) => ({
            reply: { parent: { author: { handle } } },
          })),
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

async function addLead(client: Client, id: string, network: string, handle: string) {
  const stamp = NOW.toISOString();
  await client.execute({
    sql: `INSERT INTO people (id, display_name, identity_confidence, status, outreach_eligible, believed_minor, created_at, updated_at)
          VALUES (?, ?, 0.9, 'active', 1, 0, ?, ?)`,
    args: [id, handle, stamp, stamp],
  });
  await client.execute({
    sql: `INSERT INTO campaign_people (campaign_id, person_id, workspace_id, status, interaction_state, discovered_at, updated_at)
          VALUES (?, ?, ?, 'recommended', 'never_contacted', ?, ?)`,
    args: [SEED.campaignId, id, SEED.workspaceId, stamp, stamp],
  });
  await client.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, confidence, source_type, verified_by, first_seen_at)
          VALUES (?, ?, ?, ?, 0.9, 'official_api', '[]', ?)`,
    args: [`sid_${id}`, id, network, handle, stamp],
  });
}

describe('campaign hubs', () => {
  test('rankHubs: two leads behind each, replies weigh double', () => {
    const hubs = rankHubs(
      [
        { network: 'bluesky', handle: 'one', followers: new Set(['p1']), repliers: new Set() },
        {
          network: 'bluesky',
          handle: 'two',
          followers: new Set(['p1', 'p2']),
          repliers: new Set(),
        },
        {
          network: 'bluesky',
          handle: 'talk',
          followers: new Set(['p1']),
          repliers: new Set(['p2']),
        },
      ],
      { minLeads: 2, readCount: 3, limit: 10 },
    );
    expect(hubs.map((h) => [h.handle, h.score])).toEqual([
      ['talk', 3],
      ['two', 2],
    ]);
    expect(hubs[1]?.why).toBe('followed by 2 of 3 leads');
  });

  test('computed from the leads, stored, read back; X leads are watched by hand', async () => {
    const client = await db('hubs-compute');
    await addLead(client, 'per_a', 'bluesky', 'a.bsky.social');
    await addLead(client, 'per_b', 'bluesky', 'b.bsky.social');
    await addLead(client, 'per_c', 'bluesky', 'c.bsky.social');
    const calls: string[] = [];
    const before = await getCampaignHubs(client, SEED.workspaceId, SEED.campaignId);
    expect(before.computedAt).toBeNull();

    const result = await computeCampaignHubs(client, SEED.workspaceId, SEED.campaignId, {
      fetchImpl: bsky(calls),
      gapMs: 0,
    });
    expect(result.read).toBe(3);
    // Jane from the seed is on X: listed, never read.
    expect(result.handles).toBe(4);
    const ids = result.hubs.map((h) => `${h.network}:${h.handle}`);
    expect(ids).toEqual(['bluesky:replied.bsky.social', 'bluesky:hub.bsky.social', 'x:janesmith']);
    expect(result.hubs[0]).toMatchObject({ followedBy: 1, repliedBy: 2, score: 5 });
    expect(result.hubs[2]).toMatchObject({ leadHub: true, url: 'https://x.com/janesmith' });
    expect(calls.some((p) => p.includes('x.com'))).toBe(false);

    const stored = await getCampaignHubs(client, SEED.workspaceId, SEED.campaignId);
    expect(stored.hubs.map((h) => h.handle)).toEqual(result.hubs.map((h) => h.handle));
    expect(stored.computedAt).toBe(result.computedAt);
    await expect(getCampaignHubs(client, 'wsp_other', SEED.campaignId)).rejects.toThrow(
      'no such campaign',
    );
  });
});
