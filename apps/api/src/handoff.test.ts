/**
 * Hand-off cards: approving what the product may not do itself.
 *
 * Production's queue held 200 cards that "approve all" could not approve: 175
 * LinkedIn engagement cards ("Automated engagement is prohibited") and 25 X
 * replies with no account connected. `manual_only` was refused exactly like
 * `deny`. These tests pin the difference: a manual-only card becomes a hand-off
 * a human can finish, while every real "no" is still a no.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { describeHandoff, isHandoffDecision, isPostUrlFor, profileUrlFromHandle } from './handoff';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

const LINKEDIN_REC = 'rec_li_comment';
const POST_URL = 'https://www.linkedin.com/posts/janesmith_payouts-activity-1';

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

async function harness(label: string): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  const app = createApp({ db: seeded.db, authenticate: async () => ACTOR });
  return { app, seeded };
}

async function send(app: Hono<AppEnv>, method: string, path: string, body: unknown = {}) {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * A LinkedIn comment card on Jane, triggered by a LinkedIn post, with a draft.
 *
 * Replaces the seeded X card rather than sitting beside it, because the
 * default weekly limit is one action per prospect: approving both would have
 * the second refused by the first, which is a different test.
 */
async function linkedinCard(
  seeded: SeededDatabase,
  options: { draft?: boolean } = {},
): Promise<void> {
  const stamp = new Date().toISOString();

  await seeded.db.batch([
    { sql: `DELETE FROM recommendations WHERE id = ?`, args: [SEED.recommendationId] },
    {
      sql: `INSERT INTO social_identities (id, person_id, network, handle, profile_url,
            confidence, source_type, verified_by, first_seen_at)
            VALUES ('sid_jane_li', ?, 'linkedin', 'janesmith',
            'https://www.linkedin.com/in/janesmith', 0.95, 'public_web', '[]', ?)`,
      args: [SEED.personId, stamp],
    },
    {
      sql: `INSERT INTO signals (id, workspace_id, person_id, network, signal_type, summary,
            evidence, source_url, source_timestamp, observed_at, confidence, relevance, sentiment)
            VALUES ('sig_li', ?, ?, 'linkedin', 'recommendation_request', 'Asked about payouts',
            '[]', ?, ?, ?, 0.9, 0.9, 0)`,
      args: [SEED.workspaceId, SEED.personId, POST_URL, stamp, stamp],
    },
    {
      sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action,
            network, priority, reason, trigger_signal_id, policy_status, policy_version,
            expected_goal, status, created_at)
            VALUES (?, ?, ?, ?, 'comment', 'linkedin', 90, 'Asked for payout alternatives',
            'sig_li', 'manual_only', '2026-08-11', 'start_conversation', 'pending', ?)`,
      args: [LINKEDIN_REC, SEED.workspaceId, SEED.campaignId, SEED.personId, stamp],
    },
  ]);

  if (options.draft !== false) {
    await seeded.db.execute({
      sql: `INSERT INTO drafts (id, workspace_id, recommendation_id, body, grounded_signal_ids,
            checks_json, created_at, updated_at)
            VALUES ('drf_li', ?, ?, 'We hit the same payout problem last year.', '["sig_li"]',
            '[]', ?, ?)`,
      args: [SEED.workspaceId, LINKEDIN_REC, stamp, stamp],
    });
  }
}

interface ApproveBody {
  approved: boolean;
  actionId: string;
  policy: { decision: string };
  handoff?: {
    actionId: string;
    text: string;
    openUrl?: string;
    steps: string[];
    network: string;
    action: string;
    personName: string;
  };
}

describe('approving a manual-only card', () => {
  test('becomes a hand-off with the text, the post and the steps', async () => {
    const { app, seeded } = await harness('handoff-linkedin');
    await linkedinCard(seeded);

    const response = await send(app, 'POST', `/recommendations/${LINKEDIN_REC}/approve`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as ApproveBody;
    expect(body.approved).toBe(true);
    expect(body.policy.decision).toBe('manual_only');
    expect(body.handoff).toMatchObject({
      actionId: body.actionId,
      text: 'We hit the same payout problem last year.',
      openUrl: POST_URL,
      network: 'linkedin',
      action: 'comment',
      personName: 'Jane Smith',
    });
    expect(body.handoff?.steps.length).toBeGreaterThanOrEqual(2);
    expect(body.handoff?.steps.length).toBeLessThanOrEqual(4);
    expect(body.handoff?.steps.at(-1)).toBe('Press Mark done.');

    const action = await seeded.db.execute({
      sql: 'SELECT mode, status, body FROM actions WHERE id = ?',
      args: [body.actionId],
    });
    expect(action.rows[0]?.mode).toBe('manual');
    expect(action.rows[0]?.status).toBe('queued');
  });

  test('a card raised from a crawled page opens the profile, not the page', async () => {
    const { app, seeded } = await harness('handoff-website-trigger');
    await linkedinCard(seeded);
    // What the site crawl writes: the page the person was named on.
    await seeded.db.execute({
      sql: `UPDATE signals SET network = 'website', source_url = 'https://vercel.com'
            WHERE id = 'sig_li'`,
      args: [],
    });

    const response = await send(app, 'POST', `/recommendations/${LINKEDIN_REC}/approve`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as ApproveBody;
    expect(body.handoff?.openUrl).toBe('https://www.linkedin.com/in/janesmith');
    expect(body.handoff?.steps).toContain('Find a recent post of theirs worth answering.');
  });

  test('an X reply with no connected account is a hand-off too', async () => {
    const { app, seeded } = await harness('handoff-x-no-account');
    await seeded.db.execute('DELETE FROM integration_accounts');

    const response = await send(app, 'POST', `/recommendations/${SEED.recommendationId}/approve`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as ApproveBody;
    expect(body.handoff?.network).toBe('x');
    // No `profile_url` on the seeded identity: the Open button falls back to
    // the signal the card was raised from.
    expect(body.handoff?.openUrl).toBeDefined();
  });

  test('a suppressed person is still refused, not handed off', async () => {
    const { app, seeded } = await harness('handoff-suppressed');
    await linkedinCard(seeded);
    await seeded.db.execute({
      sql: `UPDATE people SET status = 'suppressed' WHERE id = ?`,
      args: [SEED.personId],
    });

    const response = await send(app, 'POST', `/recommendations/${LINKEDIN_REC}/approve`);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; details: { gate: string } } };
    expect(body.error.code).toBe('policy_denied');
    expect(body.error.details.gate).toBe('person_ineligible');

    const actions = await seeded.db.execute('SELECT count(*) AS n FROM actions');
    expect(Number(actions.rows[0]?.n)).toBe(0);
  });

  // Exempt by the owner's decision on 2026-09-24: the daily limit paces what
  // the product does on its own, and a hand-off is paced by the person.
  test('a full day does not hold a hand-off', async () => {
    const { app, seeded } = await harness('handoff-daily-exempt');
    await linkedinCard(seeded);
    await seeded.db.execute({
      sql: `UPDATE campaigns SET budget_json = ? WHERE id = ?`,
      args: [JSON.stringify({ maxActionsPerDay: 0 }), SEED.campaignId],
    });

    const response = await send(app, 'POST', `/recommendations/${LINKEDIN_REC}/approve`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ApproveBody;
    expect(body.handoff?.network).toBe('linkedin');
  });

  test('the per-prospect limit still holds a hand-off', async () => {
    const { app, seeded } = await harness('handoff-prospect-limit');
    await linkedinCard(seeded);
    await seeded.db.execute({
      sql: `UPDATE campaigns SET budget_json = ? WHERE id = ?`,
      args: [JSON.stringify({ maxActionsPerProspectPerWeek: 0 }), SEED.campaignId],
    });

    const response = await send(app, 'POST', `/recommendations/${LINKEDIN_REC}/approve`);
    expect(response.status).toBe(409);
  });
});

describe('the hand-off list', () => {
  test('lists the pending card, marks it done, and then it is gone', async () => {
    const { app, seeded } = await harness('handoff-list-done');
    await linkedinCard(seeded);

    const approved = (await (
      await send(app, 'POST', `/recommendations/${LINKEDIN_REC}/approve`)
    ).json()) as ApproveBody;

    const listed = (await (await send(app, 'GET', '/handoffs')).json()) as {
      handoffs: { actionId: string; openUrl?: string; text: string }[];
    };
    expect(listed.handoffs).toHaveLength(1);
    expect(listed.handoffs[0]?.actionId).toBe(approved.actionId);
    expect(listed.handoffs[0]?.openUrl).toBe(POST_URL);

    const done = await send(app, 'POST', `/actions/${approved.actionId}/execute`, {
      mode: 'manual',
      externalUrl: `${POST_URL}#comment-1`,
    });
    expect(done.status).toBe(200);

    const action = await seeded.db.execute({
      sql: 'SELECT status, external_url FROM actions WHERE id = ?',
      args: [approved.actionId],
    });
    expect(action.rows[0]?.status).toBe('completed');
    expect(action.rows[0]?.external_url).toBe(`${POST_URL}#comment-1`);

    const after = (await (await send(app, 'GET', '/handoffs')).json()) as { handoffs: unknown[] };
    expect(after.handoffs).toHaveLength(0);
  });

  test('a card approved without a draft still lists, with empty text', async () => {
    const { app, seeded } = await harness('handoff-no-draft');
    await linkedinCard(seeded, { draft: false });

    const response = await send(app, 'POST', `/recommendations/${LINKEDIN_REC}/approve`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ApproveBody;
    expect(body.handoff?.text).toBe('');
    expect(body.handoff?.steps[1]).toContain('Write');
  });

  test('skipping cancels the action so it stops counting against the prospect', async () => {
    const { app, seeded } = await harness('handoff-skip');
    await linkedinCard(seeded);

    const approved = (await (
      await send(app, 'POST', `/recommendations/${LINKEDIN_REC}/approve`)
    ).json()) as ApproveBody;

    const skipped = await send(app, 'POST', `/handoffs/${approved.actionId}/skip`);
    expect(skipped.status).toBe(200);

    const rows = await seeded.db.execute({
      sql: `SELECT a.status AS action_status, r.status AS rec_status
              FROM actions a JOIN recommendations r ON r.id = a.recommendation_id
             WHERE a.id = ?`,
      args: [approved.actionId],
    });
    expect(rows.rows[0]?.action_status).toBe('cancelled');
    expect(rows.rows[0]?.rec_status).toBe('skipped');

    const listed = (await (await send(app, 'GET', '/handoffs')).json()) as { handoffs: unknown[] };
    expect(listed.handoffs).toHaveLength(0);
  });

  test('research auto-approved as manual never shows up as a hand-off', async () => {
    const { app, seeded } = await harness('handoff-not-research');
    await seeded.db.execute({
      sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
            mode, status, created_at)
            VALUES ('act_research', ?, ?, ?, 'refresh_research', 'website', 'manual', 'queued', ?)`,
      args: [SEED.workspaceId, SEED.recommendationId, SEED.personId, new Date().toISOString()],
    });

    const listed = (await (await send(app, 'GET', '/handoffs')).json()) as { handoffs: unknown[] };
    expect(listed.handoffs).toHaveLength(0);
  });
});

describe('approve-all', () => {
  test('counts hand-offs separately from approvals and holds', async () => {
    const { app, seeded } = await harness('handoff-bulk');
    await linkedinCard(seeded);

    const preview = (await (
      await send(app, 'POST', '/recommendations/approve-all', { dryRun: true })
    ).json()) as { approved: number; handoffs: number; held: number };
    expect(preview).toMatchObject({ approved: 0, handoffs: 1, held: 0 });

    const run = (await (await send(app, 'POST', '/recommendations/approve-all')).json()) as {
      approved: number;
      handoffs: number;
      held: number;
    };
    expect(run).toMatchObject({ approved: 0, handoffs: 1, held: 0 });

    const actions = await seeded.db.execute(
      `SELECT count(*) AS n FROM actions WHERE mode = 'manual' AND status = 'queued'`,
    );
    expect(Number(actions.rows[0]?.n)).toBe(1);
  });

  test('a suppressed manual-only card is still held', async () => {
    const { app, seeded } = await harness('handoff-bulk-suppressed');
    await linkedinCard(seeded);
    await seeded.db.execute({
      sql: `UPDATE people SET status = 'suppressed' WHERE id = ?`,
      args: [SEED.personId],
    });

    const run = (await (await send(app, 'POST', '/recommendations/approve-all')).json()) as {
      handoffs: number;
      held: number;
      holds: { gate: string }[];
    };
    expect(run.handoffs).toBe(0);
    expect(run.held).toBe(1);
    expect(run.holds[0]?.gate).toBe('person_ineligible');
  });
});

describe('describing a hand-off', () => {
  const base = {
    actionId: 'act_1',
    recommendationId: 'rec_1',
    personId: 'per_1',
    personName: 'Jane',
    network: 'linkedin',
    reason: 'why',
    createdAt: '2026-09-24T00:00:00.000Z',
    handle: null,
  };

  test('a follow opens the profile even when a post triggered it', () => {
    const card = describeHandoff({
      ...base,
      action: 'follow',
      text: null,
      signalUrl: POST_URL,
      profileUrl: 'https://www.linkedin.com/in/jane',
    });
    expect(card.openUrl).toBe('https://www.linkedin.com/in/jane');
    expect(card.openLabel).toBe('Open the profile');
  });

  test('a reply with no post falls back to the profile built from the handle', () => {
    const card = describeHandoff({
      ...base,
      network: 'x',
      action: 'reply',
      text: 'hi',
      signalUrl: null,
      profileUrl: null,
      handle: '@jane',
    });
    expect(card.openUrl).toBe('https://x.com/jane');
  });

  /**
   * The bug this section exists for: a person found by the site crawl carries
   * a `website` signal whose URL is the page they were named on, and every
   * card raised from one sent the reviewer to a company homepage labelled
   * "Open the post". Nobody can leave a LinkedIn comment on vercel.com.
   */
  describe('a trigger signal from another network', () => {
    const crawled = {
      ...base,
      action: 'comment',
      text: 'We hit the same payout problem.',
      signalUrl: 'https://vercel.com',
      signalNetwork: 'website',
    };

    test('opens the profile, never the crawled page', () => {
      const card = describeHandoff({
        ...crawled,
        profileUrl: 'https://www.linkedin.com/in/jane',
      });
      expect(card.openUrl).toBe('https://www.linkedin.com/in/jane');
      expect(card.openLabel).toBe('Open the profile');
    });

    test('says to find a post, rather than to paste into a profile', () => {
      const card = describeHandoff({
        ...crawled,
        profileUrl: 'https://www.linkedin.com/in/jane',
      });
      expect(card.steps).toContain('Find a recent post of theirs worth answering.');
    });

    test('offers no link at all when the network is unknown for the person', () => {
      const card = describeHandoff({ ...crawled, profileUrl: null });
      expect(card.openUrl).toBeUndefined();
    });

    test('a post on the action network is still the post', () => {
      const card = describeHandoff({
        ...crawled,
        signalUrl: POST_URL,
        signalNetwork: 'linkedin',
        profileUrl: 'https://www.linkedin.com/in/jane',
      });
      expect(card.openUrl).toBe(POST_URL);
      expect(card.openLabel).toBe('Open the post');
    });

    // Signals predating the `network` column, and any row that recorded it
    // loosely, are judged by the host instead.
    test('a post is recognised by its host when the signal names no network', () => {
      expect(isPostUrlFor('linkedin', POST_URL)).toBe(true);
      expect(isPostUrlFor('x', 'https://twitter.com/jane/status/1')).toBe(true);
      expect(isPostUrlFor('linkedin', 'https://vercel.com')).toBe(false);
      expect(isPostUrlFor('linkedin', 'https://linkedin.com.evil.test/posts/1')).toBe(false);
      expect(isPostUrlFor('linkedin', 'not a url')).toBe(false);
    });

    // Federated networks have no host list; only the signal's own network
    // can say a URL is theirs.
    test('a mastodon post counts only on the signal network', () => {
      expect(isPostUrlFor('mastodon', 'https://fosstodon.org/@jane/1', 'mastodon')).toBe(true);
      expect(isPostUrlFor('mastodon', 'https://fosstodon.org/@jane/1', 'website')).toBe(false);
    });
  });

  test('an email opens the mail app with the words in it', () => {
    const card = describeHandoff({
      ...base,
      network: 'email',
      action: 'send_email',
      text: 'Hello there',
      signalUrl: null,
      profileUrl: null,
      email: 'jane@acme.com',
      subject: 'Payouts',
    });
    expect(card.openUrl).toBe('mailto:jane@acme.com?subject=Payouts&body=Hello%20there');
  });

  test('only the two capability gates are hand-offs', () => {
    expect(isHandoffDecision({ decision: 'manual_only', gate: 'capability_mode' })).toBe(true);
    expect(isHandoffDecision({ decision: 'manual_only', gate: 'no_connected_account' })).toBe(true);
    expect(isHandoffDecision({ decision: 'deny', gate: 'capability_mode' })).toBe(false);
    expect(isHandoffDecision({ decision: 'manual_only', gate: 'person_ineligible' })).toBe(false);
  });

  test('mastodon handles resolve to their instance', () => {
    expect(profileUrlFromHandle('mastodon', '@jane@hachyderm.io')).toBe(
      'https://hachyderm.io/@jane',
    );
  });
});
