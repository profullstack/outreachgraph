/**
 * The unified inbox, end to end against a real database.
 *
 * What these check is the reading of the thread — which conversations wait on
 * us, which label each reply carries, that a robot's message never counts as
 * either side talking — and that a reply sent from here goes through the one
 * approval path and out of the mailer, threaded, answering the card already
 * drafted rather than beside it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import type { Mailer, Message } from '@outreachgraph/email';
import { newId } from '@outreachgraph/domain';
import { now, queryAll, queryOne } from '@outreachgraph/db';
import { createApp, type AppOptions } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
  credential: 'session',
};

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

function stubMailer(): { mailer: Mailer; sent: Message[] } {
  const sent: Message[] = [];
  return {
    sent,
    mailer: {
      async send(message) {
        sent.push(message);
        return { id: `msg_${sent.length}` };
      },
    },
  };
}

async function harness(
  label: string,
  extra: Partial<AppOptions> = {},
): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  const app = createApp({ db: seeded.db, authenticate: async () => ACTOR, ...extra });
  return { app, seeded };
}

const get = (app: Hono<AppEnv>, path: string) => app.request(`/api/v1${path}`);
const send = (app: Hono<AppEnv>, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** One message out, then whatever came back. Returns the inbound id, if any. */
async function conversation(
  seeded: SeededDatabase,
  back: 'reply' | 'ooo' | 'nothing' = 'reply',
): Promise<string | undefined> {
  const { db } = seeded;
  const stamp = now();

  await db.batch([
    {
      sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
            confidence, source_type, verified_by, first_seen_at)
            VALUES ('sid_jane_email', ?, 'email', 'jane@acme.com', NULL, 0.97, 'crawl', '[]', ?)`,
      args: [SEED.personId, stamp],
    },
    {
      sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network, direction,
            state, body, contact_address, occurred_at, recorded_at)
            VALUES (?, ?, ?, ?, 'email', 'outbound', 'contacted', 'Hi Jane, about payouts',
            'jane@acme.com', '2026-09-20T10:00:00.000Z', ?)`,
      args: [newId('interaction'), SEED.workspaceId, SEED.personId, SEED.campaignId, stamp],
    },
  ]);

  if (back === 'nothing') return undefined;

  const id = newId('interaction');
  await db.execute({
    sql:
      back === 'reply'
        ? `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network, direction,
            state, body, subject, contact_address, external_id, reply_label, reply_confidence,
            reply_label_source, occurred_at, recorded_at)
            VALUES (?, ?, ?, ?, 'email', 'inbound', 'responded', 'Sure, what does it cost?',
            'Re: Payouts', 'jane@acme.com', '<jane-1@acme.com>', 'question', 0.93, 'model',
            '2026-09-21T09:00:00.000Z', ?)`
        : `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network, direction,
            state, body, subject, contact_address, external_id, reply_label, reply_confidence,
            reply_label_source, occurred_at, recorded_at)
            VALUES (?, ?, ?, ?, 'email', 'automated', 'auto_replied', 'Back Monday',
            'Automatic reply: Payouts', 'jane@acme.com', '<ooo-1@acme.com>', 'out_of_office', 1,
            'rule', '2026-09-21T09:00:00.000Z', ?)`,
    args: [id, SEED.workspaceId, SEED.personId, SEED.campaignId, stamp],
  });
  return id;
}

describe('GET /inbox', () => {
  test('a reply waits on us, carrying its label', async () => {
    const { app, seeded } = await harness('inbox-list');
    await conversation(seeded);

    const body = await json<{
      conversations: { person_id: string; status: string; label: { label: string } }[];
    }>(await get(app, '/inbox?filter=need_reply'));

    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]).toMatchObject({
      person_id: SEED.personId,
      status: 'need_reply',
      label: { label: 'question' },
    });

    const replied = await json<{ conversations: unknown[] }>(
      await get(app, '/inbox?filter=replied'),
    );
    expect(replied.conversations).toHaveLength(0);
  });

  test('an out-of-office is neither a reply nor waiting on us', async () => {
    const { app, seeded } = await harness('inbox-ooo');
    await conversation(seeded, 'ooo');

    const waiting = await json<{ conversations: unknown[] }>(
      await get(app, '/inbox?filter=need_reply'),
    );
    expect(waiting.conversations).toHaveLength(0);

    const all = await json<{
      conversations: { status: string; last_message_from: string; label: { label: string } }[];
    }>(await get(app, '/inbox'));
    expect(all.conversations[0]).toMatchObject({
      status: 'sent',
      last_message_from: 'automated',
      label: { label: 'out_of_office' },
    });
  });

  test('filters by label, and refuses ones that do not exist', async () => {
    const { app, seeded } = await harness('inbox-label-filter');
    await conversation(seeded);

    const questions = await json<{ conversations: unknown[] }>(
      await get(app, '/inbox?label=question'),
    );
    expect(questions.conversations).toHaveLength(1);

    const interested = await json<{ conversations: unknown[] }>(
      await get(app, '/inbox?label=interested'),
    );
    expect(interested.conversations).toHaveLength(0);

    expect((await get(app, '/inbox?label=keen')).status).toBe(400);
    expect((await get(app, '/inbox?filter=spam')).status).toBe(400);
  });
});

describe('GET /inbox/:personId', () => {
  test('the thread, oldest first, with the original outbound marked', async () => {
    const { app, seeded } = await harness('inbox-thread');
    await conversation(seeded);

    const thread = await json<{
      status: string;
      messages: { from: string; original: boolean; label: { label: string } | null }[];
    }>(await get(app, `/inbox/${SEED.personId}`));

    expect(thread.status).toBe('need_reply');
    expect(thread.messages.map((m) => m.from)).toEqual(['us', 'them']);
    expect(thread.messages[0]?.original).toBe(true);
    expect(thread.messages[1]?.label?.label).toBe('question');
  });

  test('a person with no messages is not a conversation', async () => {
    const { app } = await harness('inbox-thread-none');
    expect((await get(app, `/inbox/${SEED.personId}`)).status).toBe(404);
  });
});

describe('POST /inbox/:personId/reply', () => {
  test('sends through policy, threaded, to the address that wrote', async () => {
    const { mailer, sent } = stubMailer();
    const { app, seeded } = await harness('inbox-send', { mailer });
    await conversation(seeded);

    const response = await send(app, 'POST', `/inbox/${SEED.personId}/reply`, {
      text: 'It depends on volume. Could we talk Thursday?',
    });
    expect(response.status).toBe(200);
    const body = await json<{ sent: boolean; subject: string; to: string }>(response);
    expect(body).toMatchObject({ sent: true, subject: 'Re: Payouts', to: 'jane@acme.com' });

    expect(sent[0]?.headers?.['In-Reply-To']).toBe('<jane-1@acme.com>');

    const thread = await json<{ status: string }>(await get(app, `/inbox/${SEED.personId}`));
    expect(thread.status).toBe('replied');
  });

  test('sends the drafted card with the edited words, not a second one beside it', async () => {
    const { mailer } = stubMailer();
    const { app, seeded } = await harness('inbox-send-card', { mailer });
    const inboundId = await conversation(seeded);
    const stamp = now();

    await seeded.db.batch([
      {
        sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
              priority, reason, policy_status, policy_version, expected_goal, status, created_at,
              reply_to_interaction_id)
              VALUES ('rec_card', ?, ?, ?, 'send_email', 'email', 100, 'They replied',
              'allow_with_approval', 'x', 'continue_conversation', 'pending', ?, ?)`,
        args: [SEED.workspaceId, SEED.campaignId, SEED.personId, stamp, inboundId!],
      },
      {
        sql: `INSERT INTO drafts (id, workspace_id, recommendation_id, subject, body,
              grounded_signal_ids, checks_json, created_at, updated_at)
              VALUES ('drf_card', ?, 'rec_card', 'Re: Payouts', 'drafted words', '[]', '[]', ?, ?)`,
        args: [SEED.workspaceId, stamp, stamp],
      },
    ]);

    const before = await json<{ pending_reply: { recommendation_id: string } }>(
      await get(app, `/inbox/${SEED.personId}`),
    );
    expect(before.pending_reply.recommendation_id).toBe('rec_card');

    const response = await send(app, 'POST', `/inbox/${SEED.personId}/reply`, {
      text: 'edited words',
    });
    expect(response.status).toBe(200);
    expect((await json<{ recommendation_id: string }>(response)).recommendation_id).toBe(
      'rec_card',
    );

    const cards = await queryAll<{ id: string; status: string }>(
      seeded.db,
      `SELECT id, status FROM recommendations WHERE reply_to_interaction_id = ?`,
      [inboundId!],
    );
    expect(cards).toEqual([{ id: 'rec_card', status: 'executed' }]);

    const action = await queryOne<{ body: string }>(
      seeded.db,
      `SELECT body FROM actions WHERE recommendation_id = 'rec_card'`,
    );
    expect(action?.body).toBe('edited words');
  });

  test('a suppressed person is refused, and the attempt is not left as a card', async () => {
    const { mailer, sent } = stubMailer();
    const { app, seeded } = await harness('inbox-send-suppressed', { mailer });
    await conversation(seeded);
    await seeded.db.batch([
      {
        sql: `INSERT INTO suppression_entries (id, reason, scope, workspace_id, source, created_at)
              VALUES ('sup_1', 'do_not_contact', 'workspace', ?, 'test', ?)`,
        args: [SEED.workspaceId, now()],
      },
      {
        sql: `INSERT INTO suppression_keys (match_key, suppression_id, scope, workspace_id)
              VALUES (?, 'sup_1', 'workspace', ?)`,
        args: [`person:${SEED.personId}`, SEED.workspaceId],
      },
    ]);

    const response = await send(app, 'POST', `/inbox/${SEED.personId}/reply`, { text: 'Hi' });
    expect(response.status).toBe(409);
    expect(sent).toHaveLength(0);
  });
});

describe('campaign auto-reply setting', () => {
  test('is copilot at 0.85 by default, and can be changed', async () => {
    const { app } = await harness('inbox-setting');

    const before = await json<{
      campaign: { auto_reply_mode: string; auto_reply_threshold: number };
    }>(await get(app, `/campaigns/${SEED.campaignId}`));
    expect(before.campaign.auto_reply_mode).toBe('copilot');
    expect(before.campaign.auto_reply_threshold).toBe(0.85);

    const response = await send(app, 'PATCH', `/campaigns/${SEED.campaignId}`, {
      autoReply: { mode: 'autonomous', threshold: 0.9 },
    });
    expect(response.status).toBe(200);
    expect((await json<{ autoReply: unknown }>(response)).autoReply).toEqual({
      mode: 'autonomous',
      threshold: 0.9,
    });
  });

  test('refuses a threshold under the floor and an unknown mode', async () => {
    const { app } = await harness('inbox-setting-bad');
    for (const autoReply of [{ threshold: 0.2 }, { mode: 'yolo' }, {}]) {
      const response = await send(app, 'PATCH', `/campaigns/${SEED.campaignId}`, { autoReply });
      expect(response.status).toBe(400);
    }
  });
});

describe('recording a reply by hand', () => {
  test('queues triage when the words are given', async () => {
    const { app, seeded } = await harness('inbox-manual-triage');

    const response = await send(app, 'POST', `/people/${SEED.personId}/replied`, {
      body: 'Yes please, send details.',
    });
    expect(response.status).toBe(200);

    const job = await queryOne<{ n: number }>(
      seeded.db,
      `SELECT count(*) AS n FROM jobs WHERE kind = 'triage_reply'`,
    );
    expect(Number(job?.n)).toBe(1);
  });
});
