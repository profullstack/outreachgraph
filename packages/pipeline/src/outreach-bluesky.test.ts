/**
 * Posting a public reply, and refusing to post the wrong one.
 *
 * The failure that matters here is not a crash. It is a reply that lands under
 * the wrong conversation, in public, under a customer's own account — so the
 * tests about *not* posting outnumber the ones about posting.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { newId } from '@outreachgraph/domain';
import { BlueskyAgent } from '@outreachgraph/providers';
import { now, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { deliverBlueskyAction } from './outreach-bluesky';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const ACTOR = { actorKind: 'user' as const, actorId: SEED.userId };
const POST_URL = 'https://bsky.app/profile/jane.bsky.social/post/3kabc';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface AgentOptions {
  readonly postExists?: boolean;
  readonly createStatus?: number;
}

async function loggedInAgent(options: AgentOptions = {}) {
  const posted: Array<Record<string, unknown>> = [];

  const agent = new BlueskyAgent({
    fetchImpl: async (input, init) => {
      const url = String(input);

      if (url.includes('createSession')) {
        return json(200, { did: 'did:plc:me', handle: 'me.bsky.social', accessJwt: 'jwt' });
      }
      if (url.includes('getPosts')) {
        return json(200, {
          posts:
            options.postExists === false
              ? []
              : [{ uri: 'at://did:plc:jane/app.bsky.feed.post/3kabc', cid: 'cid-1' }],
        });
      }
      if (url.includes('createRecord')) {
        if (options.createStatus && options.createStatus !== 200) {
          return new Response('nope', { status: options.createStatus });
        }
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json(200, { uri: 'at://did:plc:me/app.bsky.feed.post/new1', cid: 'cid-new' });
      }
      return json(404, {});
    },
  });

  await agent.login('me.bsky.social', 'pw');
  return { agent, posted };
}

/**
 * An approved Bluesky action with a drafted body, plus the identity and the
 * signal that give it somewhere to land.
 */
async function seedAction(
  db: Client,
  options: { readonly withSignal?: boolean; readonly withIdentity?: boolean } = {},
): Promise<string> {
  const recommendationId = newId('recommendation');
  const actionId = newId('action');
  const signalId = newId('signal');

  if (options.withIdentity !== false) {
    await db.execute({
      sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
            profile_url, confidence, source_type, first_seen_at)
            VALUES (?, ?, 'bluesky', 'jane.bsky.social', 'did:plc:jane',
            'https://bsky.app/profile/jane.bsky.social', 0.99, 'official_api', ?)`,
      args: [newId('socialIdentity'), SEED.personId, now()],
    });
  }

  if (options.withSignal !== false) {
    await db.execute({
      sql: `INSERT INTO signals (id, workspace_id, person_id, network, signal_type, summary,
            source_url, confidence, relevance, observed_at)
            VALUES (?, ?, ?, 'bluesky', 'pain_point', 'complained about fees', ?, 0.9, 0.9, ?)`,
      args: [signalId, SEED.workspaceId, SEED.personId, POST_URL, now()],
    });
  }

  await db.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
          priority, reason, trigger_signal_id, policy_status, policy_version, expected_goal,
          status, created_at)
          VALUES (?, ?, ?, ?, 'reply', 'bluesky', 80, 'they asked', ?, 'allow_with_approval',
          'test', 'start_conversation', 'approved', ?)`,
    args: [
      recommendationId,
      SEED.workspaceId,
      SEED.campaignId,
      SEED.personId,
      options.withSignal === false ? null : signalId,
      now(),
    ],
  });

  await db.execute({
    sql: `INSERT INTO drafts (id, workspace_id, recommendation_id, body, created_at, updated_at)
          VALUES (?, ?, ?, 'Saw your post about fees — we solve exactly this: https://a.dev', ?, ?)`,
    args: [newId('draft'), SEED.workspaceId, recommendationId, now(), now()],
  });

  await db.execute({
    sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
          mode, status, created_at)
          VALUES (?, ?, ?, ?, 'reply', 'bluesky', 'official_api', 'queued', ?)`,
    args: [actionId, SEED.workspaceId, recommendationId, SEED.personId, now()],
  });

  return actionId;
}

describe('deliverBlueskyAction', () => {
  test('replies to the post the signal came from', async () => {
    seeded = await seedDatabase('bsky-reply');
    const { db } = seeded;
    const actionId = await seedAction(db);
    const { agent, posted } = await loggedInAgent();

    const result = await deliverBlueskyAction(
      { db, agent },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );

    expect(result.sent).toBe(true);

    // The parent is the signal's post, not whatever they wrote most recently.
    const record = posted[0]?.record as { reply: { parent: { uri: string } }; facets: unknown[] };
    expect(record.reply.parent.uri).toBe('at://did:plc:jane/app.bsky.feed.post/3kabc');
    expect(record.facets).toHaveLength(1);
  });

  test('does the same bookkeeping an email send does', async () => {
    seeded = await seedDatabase('bsky-bookkeeping');
    const { db } = seeded;
    const actionId = await seedAction(db);
    const { agent } = await loggedInAgent();

    await deliverBlueskyAction(
      { db, agent },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );

    const action = await queryOne<{ status: string; external_url: string | null }>(
      db,
      'SELECT status, external_url FROM actions WHERE id = ?',
      [actionId],
    );
    expect(action?.status).toBe('completed');
    expect(action?.external_url).toContain('bsky.app');

    const interaction = await queryOne<{ network: string; state: string }>(
      db,
      `SELECT network, state FROM interactions WHERE action_id = ?`,
      [actionId],
    );
    expect(interaction?.network).toBe('bluesky');
    expect(interaction?.state).toBe('contacted');

    // The funnel counts it exactly as it counts an email.
    const stage = await queryOne<{ to_status: string }>(
      db,
      `SELECT to_status FROM lead_stage_events WHERE person_id = ? ORDER BY occurred_at DESC LIMIT 1`,
      [SEED.personId],
    );
    expect(stage?.to_status).toBe('executed');
  });

  test('refuses when there is no triggering signal', async () => {
    // Replying to a person with no post in view would put a stranger under an
    // unrelated conversation.
    seeded = await seedDatabase('bsky-nosignal');
    const { db } = seeded;
    const actionId = await seedAction(db, { withSignal: false });
    const { agent, posted } = await loggedInAgent();

    const result = await deliverBlueskyAction(
      { db, agent },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );

    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toContain('no post to reply to');
    expect(posted).toHaveLength(0);
  });

  test('refuses when the post has been deleted', async () => {
    seeded = await seedDatabase('bsky-gone');
    const { db } = seeded;
    const actionId = await seedAction(db);
    const { agent, posted } = await loggedInAgent({ postExists: false });

    const result = await deliverBlueskyAction(
      { db, agent },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );

    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toContain('no longer available');
    expect(posted).toHaveLength(0);
  });

  test('records a rejection on the action and leaves it retryable', async () => {
    seeded = await seedDatabase('bsky-rejected');
    const { db } = seeded;
    const actionId = await seedAction(db);
    const { agent } = await loggedInAgent({ createStatus: 429 });

    const result = await deliverBlueskyAction(
      { db, agent },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );

    expect(result.sent).toBe(false);

    const action = await queryOne<{ status: string; error: string | null }>(
      db,
      'SELECT status, error FROM actions WHERE id = ?',
      [actionId],
    );
    expect(action?.status).toBe('failed');
    expect(action?.error).toContain('429');
  });

  test('will not send the same action twice', async () => {
    seeded = await seedDatabase('bsky-twice');
    const { db } = seeded;
    const actionId = await seedAction(db);
    const { agent, posted } = await loggedInAgent();

    await deliverBlueskyAction(
      { db, agent },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );
    const second = await deliverBlueskyAction(
      { db, agent },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );

    expect(second.sent).toBe(false);
    if (!second.sent) expect(second.reason).toBe('already sent');
    expect(posted).toHaveLength(1);
  });

  test('refuses an action belonging to another workspace', async () => {
    seeded = await seedDatabase('bsky-crossws');
    const { db } = seeded;
    const actionId = await seedAction(db);
    const { agent } = await loggedInAgent();

    const result = await deliverBlueskyAction(
      { db, agent },
      { workspaceId: 'wsp_someone_else', actionId, actor: ACTOR },
    );

    expect(result.sent).toBe(false);
  });
});
