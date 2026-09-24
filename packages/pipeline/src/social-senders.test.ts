/**
 * X over OAuth 2.1, LinkedIn through a session, and the pacing in front of
 * both. No network: every HTTP call goes to a fake that records it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { newId } from '@outreachgraph/domain';
import {
  LinkedInSession,
  pkcePair,
  threadUrnFromUrl,
  tweetIdFromUrl,
  xAuthorizeUrl,
  XClient,
} from '@outreachgraph/providers';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { completeXConnect, startXConnect, xClientForWorkspace } from './x-account';
import { deliverXAction } from './outreach-x';
import { connectLinkedInSession } from './linkedin-account';
import { deliverLinkedInAction } from './outreach-linkedin';
import { PACING, scheduleSocialDelivery } from './social-delivery';

let seeded: SeededDatabase | undefined;
afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const KEY = randomBytes(32);
const ACTOR = { actorKind: 'user' as const, actorId: SEED.userId };
const OAUTH = {
  clientId: 'cid',
  clientSecret: 'secret',
  redirectUri: 'https://outreachgraph.com/api/v1/x/oauth/callback',
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function seedAction(
  db: Client,
  network: 'x' | 'linkedin',
  kind: string,
  signalUrl: string,
): Promise<string> {
  const recommendationId = newId('recommendation');
  const actionId = newId('action');
  const signalId = newId('signal');

  await db.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
          profile_url, confidence, source_type, first_seen_at)
          VALUES (?, ?, ?, 'jane', '42', 'https://example.com/jane', 0.99, 'official_api', ?)`,
    args: [newId('socialIdentity'), SEED.personId, network, now()],
  });
  await db.execute({
    sql: `INSERT INTO signals (id, workspace_id, person_id, network, signal_type, summary,
          source_url, confidence, relevance, observed_at)
          VALUES (?, ?, ?, ?, 'pain', 'complained about fees', ?, 0.9, 0.9, ?)`,
    args: [signalId, SEED.workspaceId, SEED.personId, network, signalUrl, now()],
  });
  await db.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
          priority, reason, trigger_signal_id, policy_status, policy_version, expected_goal,
          status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 80, 'they asked', ?, 'allow_with_approval', 'test',
          'start_conversation', 'approved', ?)`,
    args: [
      recommendationId,
      SEED.workspaceId,
      SEED.campaignId,
      SEED.personId,
      kind,
      network,
      signalId,
      now(),
    ],
  });
  await db.execute({
    sql: `INSERT INTO drafts (id, workspace_id, recommendation_id, body, created_at, updated_at)
          VALUES (?, ?, ?, 'We fixed exactly this, happy to share how.', ?, ?)`,
    args: [newId('draft'), SEED.workspaceId, recommendationId, now(), now()],
  });
  await db.execute({
    sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
          mode, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'official_api', 'queued', ?)`,
    args: [actionId, SEED.workspaceId, recommendationId, SEED.personId, kind, network, now()],
  });
  return actionId;
}

describe('X over OAuth 2.1', () => {
  test('PKCE uses S256 of the verifier and the authorize URL asks for a refresh token', () => {
    const { verifier, challenge } = pkcePair();
    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(challenge).toBe(expected);
    expect(verifier.length).toBeGreaterThanOrEqual(43);

    const url = new URL(xAuthorizeUrl(OAUTH, 'st', challenge));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('offline.access');
    expect(url.searchParams.get('scope')).toContain('tweet.write');
  });

  test('a started connection completes once, stores encrypted tokens, and refuses replay', async () => {
    seeded = await seedDatabase('x-connect');
    const { db } = seeded;

    const started = await startXConnect(db, {
      workspaceId: SEED.workspaceId,
      oauth: OAUTH,
      encryptionKey: KEY,
    });
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;

    const calls: string[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/2/oauth2/token')) {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get('grant_type')).toBe('authorization_code');
        expect(form.get('code_verifier')?.length).toBeGreaterThanOrEqual(43);
        return json(200, {
          access_token: 'AT1',
          refresh_token: 'RT1',
          expires_in: 7200,
          scope: 'tweet.write offline.access',
        });
      }
      if (url.endsWith('/2/users/me')) return json(200, { data: { id: '99', username: 'me' } });
      return json(404, {});
    };

    const done = await completeXConnect(db, {
      state,
      code: 'c',
      oauth: OAUTH,
      encryptionKey: KEY,
      fetchImpl,
    });
    expect(done).toEqual({ workspaceId: SEED.workspaceId, username: 'me' });

    const row = await queryOne<{ access_token_enc: string; status: string }>(
      db,
      `SELECT access_token_enc, status FROM integration_accounts WHERE network = 'x'`,
      [],
    );
    expect(row?.status).toBe('active');
    expect(row?.access_token_enc).not.toContain('AT1');

    await expect(
      completeXConnect(db, { state, code: 'c', oauth: OAUTH, encryptionKey: KEY, fetchImpl }),
    ).rejects.toThrow('not one we started');
  });

  test('an expiring token is refreshed and the rotated pair is stored', async () => {
    seeded = await seedDatabase('x-refresh');
    const { db } = seeded;

    const started = await startXConnect(db, {
      workspaceId: SEED.workspaceId,
      oauth: OAUTH,
      encryptionKey: KEY,
    });
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    let issued = 0;
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/2/oauth2/token')) {
        issued += 1;
        // The first grant is already about to expire, forcing a refresh.
        return json(200, {
          access_token: `AT${issued}`,
          refresh_token: `RT${issued}`,
          expires_in: issued === 1 ? 30 : 7200,
        });
      }
      return json(200, { data: { id: '99', username: 'me' } });
    };
    await completeXConnect(db, { state, code: 'c', oauth: OAUTH, encryptionKey: KEY, fetchImpl });

    const client = await xClientForWorkspace(db, SEED.workspaceId, {
      oauth: OAUTH,
      encryptionKey: KEY,
      fetchImpl,
    });
    expect(client).toBeDefined();
    expect(issued).toBe(2);

    const row = await queryOne<{ expires_at: string }>(
      db,
      `SELECT expires_at FROM integration_accounts WHERE network = 'x'`,
      [],
    );
    expect(Date.parse(row!.expires_at) - Date.now()).toBeGreaterThan(3_600_000);
  });

  test('a reply goes under the signal’s post and is recorded as sent', async () => {
    seeded = await seedDatabase('x-reply');
    const { db } = seeded;
    const actionId = await seedAction(db, 'x', 'reply', 'https://x.com/jane/status/1234567890');

    const bodies: unknown[] = [];
    const client = new XClient('AT', {
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/2/tweets')) {
          bodies.push(JSON.parse(String(init?.body)));
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer AT');
          return json(201, { data: { id: '555' } });
        }
        return json(200, { data: { id: '99', username: 'me' } });
      },
    });

    const result = await deliverXAction(
      { db, client },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );
    expect(result).toEqual({ sent: true, url: 'https://x.com/me/status/555' });
    expect(bodies[0]).toMatchObject({ reply: { in_reply_to_tweet_id: '1234567890' } });

    const action = await queryOne<{ status: string }>(
      db,
      'SELECT status FROM actions WHERE id = ?',
      [actionId],
    );
    expect(action?.status).toBe('completed');
  });

  test('tweet ids come out of both hostnames', () => {
    expect(tweetIdFromUrl('https://twitter.com/a/status/12')).toBe('12');
    expect(tweetIdFromUrl('https://x.com/a/status/34?s=20')).toBe('34');
    expect(tweetIdFromUrl('https://x.com/a')).toBeUndefined();
  });
});

describe('LinkedIn through a session', () => {
  test('thread URNs come out of every URL shape LinkedIn uses', () => {
    expect(
      threadUrnFromUrl('https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/'),
    ).toBe('urn:li:activity:7100000000000000001');
    expect(
      threadUrnFromUrl(
        'https://www.linkedin.com/posts/jane-doe_topic-activity-7100000000000000002-AbCd',
      ),
    ).toBe('urn:li:activity:7100000000000000002');
    expect(threadUrnFromUrl('https://www.linkedin.com/in/jane')).toBeUndefined();
  });

  test('a comment is posted to the thread with a matching CSRF pair', async () => {
    seeded = await seedDatabase('li-comment');
    const { db } = seeded;
    await connectLinkedInSession(db, {
      workspaceId: SEED.workspaceId,
      liAt: 'AQEDAtestcookievalue1234567890',
      encryptionKey: KEY,
      verify: false,
    });
    const actionId = await seedAction(
      db,
      'linkedin',
      'reply',
      'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/',
    );

    const sent: { body: unknown; headers: Headers }[] = [];
    const session = new LinkedInSession('AQEDAtestcookievalue1234567890', {
      fetchImpl: async (_input, init) => {
        sent.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
        return json(201, { data: { entityUrn: 'urn:li:comment:1' } });
      },
    });

    const result = await deliverLinkedInAction(
      { db, session },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );
    expect(result.sent).toBe(true);
    expect(sent[0]?.body).toMatchObject({ threadUrn: 'urn:li:activity:7100000000000000001' });

    const headers = sent[0]!.headers;
    const csrf = headers.get('csrf-token')!;
    expect(headers.get('cookie')).toContain(`JSESSIONID="${csrf}"`);
  });

  test('a signed-out cookie revokes the session instead of retrying', async () => {
    seeded = await seedDatabase('li-revoked');
    const { db } = seeded;
    await connectLinkedInSession(db, {
      workspaceId: SEED.workspaceId,
      liAt: 'AQEDAtestcookievalue1234567890',
      encryptionKey: KEY,
      verify: false,
    });
    const actionId = await seedAction(
      db,
      'linkedin',
      'reply',
      'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/',
    );
    const session = new LinkedInSession('x'.repeat(30), {
      fetchImpl: async () => new Response('', { status: 302 }),
    });

    const result = await deliverLinkedInAction(
      { db, session },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );
    expect(result.sent).toBe(false);

    const account = await queryOne<{ status: string }>(
      db,
      `SELECT status FROM integration_accounts WHERE network = 'linkedin'`,
      [],
    );
    expect(account?.status).toBe('revoked');
  });
});

describe('pacing', () => {
  test('approvals are spaced apart and capped per day', async () => {
    seeded = await seedDatabase('pacing');
    const { db } = seeded;
    // Real time: `enqueue` stamps run_after from the clock, not from this test.
    const start = Date.now();

    const pace = PACING.linkedin;
    const times: number[] = [];
    for (let i = 0; i < pace.perDay + 2; i += 1) {
      const scheduled = await scheduleSocialDelivery(
        db,
        {
          workspaceId: SEED.workspaceId,
          actionId: `act_${i}`,
          network: 'linkedin',
          actor: ACTOR,
        },
        start,
      );
      times.push(Date.parse(scheduled.runAt));
    }

    for (let i = 1; i < pace.perDay; i += 1) {
      const gap = times[i]! - times[i - 1]!;
      // Either spaced by the pacing gap, or pushed to the next day by the cap.
      expect(gap >= pace.minGapMs || gap > 12 * 3_600_000).toBe(true);
    }

    const perDay = new Map<string, number>();
    for (const t of times) {
      const day = new Date(t).toISOString().slice(0, 10);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    for (const count of perDay.values()) expect(count).toBeLessThanOrEqual(pace.perDay);

    const jobs = await queryAll<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM jobs WHERE kind = 'deliver_social'`,
      [],
    );
    expect(jobs[0]?.n).toBe(pace.perDay + 2);
  });
});
