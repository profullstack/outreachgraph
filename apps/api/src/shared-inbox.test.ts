/**
 * The bug that made us look like a bot.
 *
 * Every rate limit is keyed on `person_id`, which is the correct key for "how
 * often do we contact this human" and the wrong one for "how much mail does
 * this mailbox get". A prospect with no personal address falls back to their
 * company's shared inbox, so N prospects at one company are N separate people
 * — each comfortably inside its own weekly limit — and one `support@` mailbox
 * receives N messages.
 *
 * Production: 24 outbound emails reached 6 distinct addresses, and
 * `support@canny.io` alone received 14 of them. Nothing was ever contacted
 * twice by its own key, which is why no existing gate saw it.
 *
 * These tests are written against the delivered address rather than the
 * person, because that is the thing the recipient experiences.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { now, queryOne, type Client } from '@outreachgraph/db';
import type { Mailer, Message, SendResult } from '@outreachgraph/email';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

const SHARED_INBOX = 'support@acme.com';

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

function recordingMailer(): { sent: Message[]; mailer: Mailer } {
  const sent: Message[] = [];
  return {
    sent,
    mailer: {
      send: async (message): Promise<SendResult> => {
        sent.push(message);
        return { id: `msg_${sent.length}` };
      },
    },
  };
}

async function harness(label: string, mailer: Mailer): Promise<{ app: Hono<AppEnv>; db: Client }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  return {
    app: createApp({ db: seeded.db, authenticate: async () => ACTOR, mailer }),
    db: seeded.db,
  };
}

/**
 * Gives the seeded company a shared inbox and turns Jane's card into an email
 * one. Deliberately no personal address: falling back to the company mailbox
 * is the whole subject.
 */
async function giveCompanySharedInbox(db: Client): Promise<void> {
  await db.execute({
    sql: 'UPDATE companies SET contact_email = ? WHERE id = ?',
    args: [SHARED_INBOX, SEED.companyId],
  });
  await db.execute({
    sql: `UPDATE recommendations SET action = 'send_email', network = 'email' WHERE id = ?`,
    args: [SEED.recommendationId],
  });
}

/** A second prospect at the same company, with their own card and no address. */
async function addColleague(
  db: Client,
  suffix: string,
): Promise<{ personId: string; recommendationId: string }> {
  const stamp = now();
  const personId = `per_${suffix}`;
  const recommendationId = `rec_${suffix}`;

  await db.batch([
    {
      sql: `INSERT INTO people (id, display_name, first_name, last_name, current_company_id,
            current_title, location, identity_confidence, status, outreach_eligible,
            believed_minor, created_at, updated_at)
            VALUES (?, ?, ?, 'Colleague', ?, 'Director', 'Remote', 0.97, 'active', 1, 0, ?, ?)`,
      args: [personId, `${suffix} Colleague`, suffix, SEED.companyId, stamp, stamp],
    },
    {
      sql: `INSERT INTO campaign_people (campaign_id, person_id, workspace_id, status,
            interaction_state, discovered_at, updated_at)
            VALUES (?, ?, ?, 'recommended', 'never_contacted', ?, ?)`,
      args: [SEED.campaignId, personId, SEED.workspaceId, stamp, stamp],
    },
    {
      sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action,
            network, priority, reason, trigger_signal_id, policy_status, policy_version,
            expected_goal, status, created_at)
            VALUES (?, ?, ?, ?, 'send_email', 'email', 90, 'Colleague at the same company.',
            ?, 'allow_with_approval', '2026-08-11', 'start_conversation', 'pending', ?)`,
      args: [recommendationId, SEED.workspaceId, SEED.campaignId, personId, SEED.signalId, stamp],
    },
    {
      sql: `INSERT INTO drafts (id, workspace_id, recommendation_id, body, grounded_signal_ids,
            checks_json, created_at, updated_at)
            VALUES (?, ?, ?, 'We ran into a similar cross-border settlement issue...', ?, '[]', ?, ?)`,
      args: [
        `drf_${suffix}`,
        SEED.workspaceId,
        recommendationId,
        JSON.stringify([SEED.signalId]),
        stamp,
        stamp,
      ],
    },
  ]);

  return { personId, recommendationId };
}

async function approve(app: Hono<AppEnv>, recommendationId: string): Promise<Response> {
  return await app.request(`/api/v1/recommendations/${recommendationId}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

describe('a shared company inbox', () => {
  test('records the address a message was actually delivered to', async () => {
    const { mailer } = recordingMailer();
    const { app, db } = await harness('shared-records-address', mailer);
    await giveCompanySharedInbox(db);

    await approve(app, SEED.recommendationId);

    const interaction = await queryOne<{ contact_address: string; shared_inbox: number }>(
      db,
      `SELECT contact_address, shared_inbox FROM interactions
        WHERE workspace_id = ? AND direction = 'outbound'`,
      [SEED.workspaceId],
    );

    // Without this column the next policy check cannot see the send at all.
    expect(interaction?.contact_address).toBe(SHARED_INBOX);
    expect(interaction?.shared_inbox).toBe(1);
  });

  test('refuses a second colleague whose mail lands in the same inbox', async () => {
    const { sent, mailer } = recordingMailer();
    const { app, db } = await harness('shared-blocks-second', mailer);
    await giveCompanySharedInbox(db);
    const colleague = await addColleague(db, 'bob');

    const first = await approve(app, SEED.recommendationId);
    expect(first.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(SHARED_INBOX);

    // Bob has never been contacted, is inside every per-person limit, and
    // would still have put a second message in the same human's inbox.
    const second = await approve(app, colleague.recommendationId);
    expect(second.status).toBe(409);

    // Both address gates fire here — the inbox is over its weekly count *and*
    // inside the cooldown — and the engine reports the last one to restrict.
    // Which of the two is named matters less than that the refusal is about
    // the address rather than about Bob, who is a stranger to us.
    const payload = (await second.json()) as {
      error?: { message?: string; details?: { gate?: string } };
    };
    expect(['rate_limit_address', 'cooldown']).toContain(payload.error?.details?.gate ?? '');
    expect(payload.error?.message).toMatch(/address|inbox/i);

    expect(sent).toHaveLength(1);
  });

  test('names the shared inbox when the count is what stops it', async () => {
    const { sent, mailer } = recordingMailer();
    const { app, db } = await harness('shared-names-inbox', mailer);
    await giveCompanySharedInbox(db);
    const colleague = await addColleague(db, 'erin');

    await approve(app, SEED.recommendationId);

    // Push the send outside the 72h cooldown so only the weekly count is left
    // to refuse it, and the operator-facing reason is the one under test.
    await db.execute({
      sql: `UPDATE interactions SET occurred_at = ? WHERE workspace_id = ? AND direction = 'outbound'`,
      args: [new Date(Date.now() - 96 * 3_600_000).toISOString(), SEED.workspaceId],
    });

    const second = await approve(app, colleague.recommendationId);
    expect(second.status).toBe(409);

    const payload = (await second.json()) as {
      error?: { message?: string; details?: { gate?: string } };
    };
    expect(payload.error?.details?.gate).toBe('rate_limit_address');
    expect(payload.error?.message).toContain('shares a company inbox');
    expect(sent).toHaveLength(1);
  });

  test('a colleague with their own address is unaffected', async () => {
    const { sent, mailer } = recordingMailer();
    const { app, db } = await harness('shared-allows-personal', mailer);
    await giveCompanySharedInbox(db);
    const colleague = await addColleague(db, 'carol');

    await db.execute({
      sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
            confidence, source_type, verified_by, first_seen_at)
            VALUES ('sid_carol_email', ?, 'email', 'carol@acme.com', 'carol@acme.com',
            0.9, 'public_web', '[]', ?)`,
      args: [colleague.personId, now()],
    });

    await approve(app, SEED.recommendationId);
    const second = await approve(app, colleague.recommendationId);

    // A personal mailbox is a different human reading it, so the shared-inbox
    // limit has nothing to say about it.
    expect(second.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.to).toBe('carol@acme.com');
  });
});

/**
 * The complaint the address limits produced once they worked.
 *
 * `ready` meant "an outbound action with a draft" and nothing more, so a queue
 * whose cards all sat behind one shared inbox on cooldown showed every one of
 * them as approvable. Clicking any of them answered "this address was last
 * contacted 12h ago", which reads as a broken queue when the prospect on the
 * card has never been written to. The queue now says it first.
 */
describe('the queue, before anything is clicked', () => {
  async function queue(app: Hono<AppEnv>): Promise<{
    recommendations: { id: string; hold?: Record<string, unknown> }[];
    counts: { held?: number; approvable?: number; buckets: Record<string, number> };
  }> {
    const response = await app.request('/api/v1/recommendations?filter=all&limit=200');
    expect(response.status).toBe(200);
    return (await response.json()) as never;
  }

  test('marks the colleague behind a used inbox as held, and names it', async () => {
    const { mailer } = recordingMailer();
    const { app, db } = await harness('queue-marks-held', mailer);
    await giveCompanySharedInbox(db);
    const colleague = await addColleague(db, 'frank');

    // Before anything is sent, nothing is held: the inbox is untouched.
    const before = await queue(app);
    expect(before.recommendations.every((card) => card.hold === undefined)).toBe(true);
    expect(before.counts.held).toBe(0);

    await approve(app, SEED.recommendationId);

    const after = await queue(app);
    const card = after.recommendations.find((row) => row.id === colleague.recommendationId);

    expect(card?.hold).toBeDefined();
    // The address is the whole explanation: Frank is a stranger to us, and
    // only the mailbox he shares makes the refusal make sense.
    expect(card?.hold?.address).toBe(SHARED_INBOX);
    expect(card?.hold?.shared).toBe(true);
  });

  test('the hold says exactly what approving would have said', async () => {
    const { mailer } = recordingMailer();
    const { app, db } = await harness('queue-hold-matches', mailer);
    await giveCompanySharedInbox(db);
    const colleague = await addColleague(db, 'gina');

    await approve(app, SEED.recommendationId);

    const listed = await queue(app);
    const hold = listed.recommendations.find((row) => row.id === colleague.recommendationId)?.hold;

    const refused = await approve(app, colleague.recommendationId);
    expect(refused.status).toBe(409);
    const payload = (await refused.json()) as {
      error?: { message?: string; details?: { gate?: string } };
    };

    // A preview that disagrees with the refusal is worse than no preview:
    // it teaches the reviewer to distrust the badge.
    expect(hold?.reason).toBe(payload.error?.message);
    expect(hold?.gate).toBe(payload.error?.details?.gate);
  });

  test('counts how many ready cards can actually be sent', async () => {
    const { mailer } = recordingMailer();
    const { app, db } = await harness('queue-counts-held', mailer);
    await giveCompanySharedInbox(db);
    await addColleague(db, 'hana');
    await addColleague(db, 'iris');

    await approve(app, SEED.recommendationId);

    const listed = await queue(app);

    // Jane's card is gone — approved. Both colleagues are drafted and both are
    // behind the one inbox she used, so the tab must not claim two are ready.
    expect(listed.counts.buckets.ready).toBe(2);
    expect(listed.counts.held).toBe(2);
    expect(listed.counts.approvable).toBe(0);
  });

  test('a prospect with their own address is never held', async () => {
    const { mailer } = recordingMailer();
    const { app, db } = await harness('queue-personal-not-held', mailer);
    await giveCompanySharedInbox(db);
    const colleague = await addColleague(db, 'jack');

    await db.execute({
      sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
            confidence, source_type, verified_by, first_seen_at)
            VALUES ('sid_jack_email', ?, 'email', 'jack@acme.com', 'jack@acme.com',
            0.9, 'public_web', '[]', ?)`,
      args: [colleague.personId, now()],
    });

    await approve(app, SEED.recommendationId);

    const listed = await queue(app);
    const card = listed.recommendations.find((row) => row.id === colleague.recommendationId);

    expect(card?.hold).toBeUndefined();
    expect(listed.counts.approvable).toBe(1);
  });
});

describe('a contact who has replied', () => {
  test('is not written to again', async () => {
    const { sent, mailer } = recordingMailer();
    const { app, db } = await harness('reply-blocks', mailer);
    await giveCompanySharedInbox(db);

    // The reply arrives against Jane, who has not yet been mailed.
    const recorded = await app.request(`/api/v1/people/${SEED.personId}/replied`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Thanks — already sorted, please stop.' }),
    });
    expect(recorded.status).toBe(200);

    const response = await approve(app, SEED.recommendationId);
    expect(response.status).toBe(409);

    const payload = (await response.json()) as { error?: { details?: { gate?: string } } };
    expect(payload.error?.details?.gate).toBe('conversation_open');
    expect(sent).toHaveLength(0);
  });

  test('a reply from a shared inbox also protects their colleagues', async () => {
    const { sent, mailer } = recordingMailer();
    const { app, db } = await harness('reply-blocks-colleagues', mailer);
    await giveCompanySharedInbox(db);
    const colleague = await addColleague(db, 'dave');

    await app.request(`/api/v1/people/${SEED.personId}/replied`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Not interested.' }),
    });

    // Someone at that mailbox has answered on behalf of everyone written to
    // there; carrying on down the staff list is the same mistake in disguise.
    const response = await approve(app, colleague.recommendationId);
    expect(response.status).toBe(409);
    expect(sent).toHaveLength(0);
  });
});
