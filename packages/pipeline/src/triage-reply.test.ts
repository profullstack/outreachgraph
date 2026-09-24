/**
 * Triage: what a reply's label is allowed to cause.
 *
 * The expensive mistakes are all in one direction — a message sent that
 * nobody read, or a tombstone written because a model misread a sentence — so
 * most of these tests prove something does *not* happen: the autonomous path
 * is refused one broken condition at a time, a model's "stop" is only a card,
 * and a run with no model at all still labels by rule and stops there.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { newId } from '@outreachgraph/domain';
import { StubModel } from '@outreachgraph/ai';
import type { Mailer, Message } from '@outreachgraph/email';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { triageReply } from './triage-reply';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const QUESTION =
  'How fast does settlement happen for cross-border payouts? We are comparing providers.';
const ANSWER =
  'Hi Jane, thanks for asking. Cross-border payouts settle quickly with ExamplePay, and I can walk you through how settlement works for your payouts when you are comparing providers.';

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

/** One message out to Jane, one reply back. Returns the reply's id. */
async function thread(db: Client, body = QUESTION): Promise<string> {
  const stamp = now();
  const inboundId = newId('interaction');

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
            VALUES (?, ?, ?, ?, 'email', 'outbound', 'contacted',
            'Hi Jane, saw your note about cross-border settlement taking days.', 'jane@acme.com',
            '2026-09-20T10:00:00.000Z', ?)`,
      args: [newId('interaction'), SEED.workspaceId, SEED.personId, SEED.campaignId, stamp],
    },
    {
      sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network, direction,
            state, body, subject, contact_address, external_id, references_header,
            occurred_at, recorded_at)
            VALUES (?, ?, ?, ?, 'email', 'inbound', 'responded', ?, 'Re: Cross-border payouts',
            'jane@acme.com', '<jane-1@acme.com>', '<ours-1@examplepay.com>',
            '2026-09-21T09:00:00.000Z', ?)`,
      args: [inboundId, SEED.workspaceId, SEED.personId, SEED.campaignId, body, stamp],
    },
  ]);

  return inboundId;
}

async function autonomous(db: Client, threshold = 0.85): Promise<void> {
  await db.execute({
    sql: `UPDATE campaigns SET approval_mode = 'trusted_automation', auto_reply_mode = 'autonomous',
          auto_reply_threshold = ? WHERE id = ?`,
    args: [threshold, SEED.campaignId],
  });
}

function model(label: string, confidence: number, answer = ANSWER): StubModel {
  return new StubModel([
    JSON.stringify({ label, confidence, reason: `they wrote "${QUESTION.slice(0, 20)}"` }),
    answer,
  ]);
}

async function replyCards(db: Client) {
  return queryAll<{ id: string; status: string; action: string; expected_goal: string }>(
    db,
    `SELECT id, status, action, expected_goal FROM recommendations
      WHERE reply_to_interaction_id IS NOT NULL`,
  );
}

describe('stop requests', () => {
  test('a rule-matched request suppresses and cancels what was queued', async () => {
    seeded = await seedDatabase('triage-unsub-rule');
    const id = await thread(seeded.db, 'Please remove me from your list.');

    const result = await triageReply(
      { db: seeded.db },
      { workspaceId: SEED.workspaceId, interactionId: id },
    );

    expect(result.outcome).toBe('suppressed');
    expect(result.label?.source).toBe('rule');

    const key = await queryOne<{ source: string }>(
      seeded.db,
      `SELECT se.source FROM suppression_keys sk
         JOIN suppression_entries se ON se.id = sk.suppression_id
        WHERE sk.match_key = ?`,
      [`person:${SEED.personId}`],
    );
    expect(key?.source).toBe('reply_unsubscribe');

    const seededCard = await queryOne<{ status: string }>(
      seeded.db,
      'SELECT status FROM recommendations WHERE id = ?',
      [SEED.recommendationId],
    );
    expect(seededCard?.status).toBe('skipped');
  });

  test("a model's stop is a card for a human, never a tombstone", async () => {
    seeded = await seedDatabase('triage-unsub-model');
    const id = await thread(seeded.db, 'This is not relevant to us any more, thanks.');

    const result = await triageReply(
      { db: seeded.db, model: new StubModel('{"label":"unsubscribe_request","confidence":0.97}') },
      { workspaceId: SEED.workspaceId, interactionId: id },
    );

    expect(result.outcome).toBe('held_for_review');
    const suppressed = await queryOne<{ n: number }>(
      seeded.db,
      'SELECT count(*) AS n FROM suppression_keys',
    );
    expect(Number(suppressed?.n)).toBe(0);

    const cards = await replyCards(seeded.db);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.action).toBe('manual_review');
  });
});

describe('copilot', () => {
  test('is the default: a drafted answer waits on a card, nothing is sent', async () => {
    seeded = await seedDatabase('triage-copilot');
    const id = await thread(seeded.db);
    const { mailer, sent } = stubMailer();

    const result = await triageReply(
      { db: seeded.db, model: model('question', 0.95), mailer },
      { workspaceId: SEED.workspaceId, interactionId: id },
    );

    expect(result.outcome).toBe('copilot');
    expect(sent).toHaveLength(0);

    const cards = await replyCards(seeded.db);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      status: 'pending',
      action: 'send_email',
      expected_goal: 'continue_conversation',
    });

    const draft = await queryOne<{ subject: string; body: string }>(
      seeded.db,
      'SELECT subject, body FROM drafts WHERE recommendation_id = ?',
      [cards[0]!.id],
    );
    expect(draft?.subject).toBe('Re: Cross-border payouts');
    expect(draft?.body).toBe(ANSWER);

    const label = await queryOne<{ reply_label: string; reply_label_source: string }>(
      seeded.db,
      'SELECT reply_label, reply_label_source FROM interactions WHERE id = ?',
      [id],
    );
    expect(label).toEqual({ reply_label: 'question', reply_label_source: 'model' });
  });

  test('is idempotent: a retried job does not card the same message twice', async () => {
    seeded = await seedDatabase('triage-idempotent');
    const id = await thread(seeded.db);
    const deps = { db: seeded.db, model: model('question', 0.95) };

    await triageReply(deps, { workspaceId: SEED.workspaceId, interactionId: id });
    await triageReply(deps, { workspaceId: SEED.workspaceId, interactionId: id });

    expect(await replyCards(seeded.db)).toHaveLength(1);
  });

  test('a not-interested reply gets no answer', async () => {
    seeded = await seedDatabase('triage-not-interested');
    const id = await thread(seeded.db, 'Not for us, thanks.');

    const result = await triageReply(
      { db: seeded.db, model: model('not_interested', 0.9) },
      { workspaceId: SEED.workspaceId, interactionId: id },
    );

    expect(result.outcome).toBe('labelled');
    expect(await replyCards(seeded.db)).toHaveLength(0);
  });

  test('off drafts nothing', async () => {
    seeded = await seedDatabase('triage-off');
    const id = await thread(seeded.db);
    await seeded.db.execute({
      sql: `UPDATE campaigns SET auto_reply_mode = 'off' WHERE id = ?`,
      args: [SEED.campaignId],
    });

    const result = await triageReply(
      { db: seeded.db, model: model('question', 0.95) },
      { workspaceId: SEED.workspaceId, interactionId: id },
    );

    expect(result.outcome).toBe('labelled');
    expect(await replyCards(seeded.db)).toHaveLength(0);
  });
});

describe('with no model (the fixture path)', () => {
  test('rules still run; an unplaceable reply is left unclassified and uncarded', async () => {
    seeded = await seedDatabase('triage-no-model');
    const id = await thread(seeded.db);

    const result = await triageReply(
      { db: seeded.db },
      { workspaceId: SEED.workspaceId, interactionId: id },
    );

    expect(result.label).toMatchObject({ label: 'other', source: 'unclassified', confidence: 0 });
    expect(await replyCards(seeded.db)).toHaveLength(0);
  });
});

describe('autonomous', () => {
  test('sends, threaded, when every condition holds', async () => {
    seeded = await seedDatabase('triage-autonomous');
    const id = await thread(seeded.db);
    await autonomous(seeded.db);
    const { mailer, sent } = stubMailer();

    const result = await triageReply(
      { db: seeded.db, model: model('question', 0.95), mailer },
      { workspaceId: SEED.workspaceId, interactionId: id },
    );

    expect(result.outcome).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('jane@acme.com');
    expect(sent[0]?.subject).toBe('Re: Cross-border payouts');
    expect(sent[0]?.headers?.['In-Reply-To']).toBe('<jane-1@acme.com>');
    expect(sent[0]?.headers?.References).toBe('<ours-1@examplepay.com> <jane-1@acme.com>');

    // An answer does not drag them back to "contacted" in the funnel.
    const outbound = await queryOne<{ state: string }>(
      seeded.db,
      `SELECT state FROM interactions WHERE direction = 'outbound' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(outbound?.state).toBe('answered');

    const approval = await queryOne<{ decided_by: string }>(
      seeded.db,
      'SELECT decided_by FROM approvals WHERE recommendation_id = ?',
      [result.recommendationId!],
    );
    expect(approval?.decided_by).toBe('usr_auto_approve');
  });

  const breaks: [string, (db: Client) => Promise<void>, StubModel][] = [
    ['confidence below the threshold', async () => undefined, model('question', 0.7)],
    ['a referral', async () => undefined, model('referral', 0.99)],
    [
      'the campaign is not on trusted automation',
      async (db) => {
        await db.execute({
          sql: `UPDATE campaigns SET approval_mode = 'draft_and_approve' WHERE id = ?`,
          args: [SEED.campaignId],
        });
      },
      model('interested', 0.99),
    ],
    [
      'the kill switch is off',
      async (db) => {
        await db.execute({
          sql: `INSERT INTO feature_flags (workspace_id, key, enabled, updated_at)
                VALUES (?, 'automation.email.auto_reply', 0, ?)`,
          args: [SEED.workspaceId, now()],
        });
      },
      model('question', 0.99),
    ],
    [
      'the draft invents a number',
      async () => undefined,
      model('question', 0.99, 'Hi Jane, settlement takes 4 minutes and costs 0.2% per transfer.'),
    ],
    [
      'the person is suppressed',
      async (db) => {
        await db.batch([
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
      },
      model('question', 0.99),
    ],
  ];

  for (const [label, setup, stub] of breaks) {
    test(`falls back to a card when ${label}`, async () => {
      seeded = await seedDatabase(`triage-auto-${label.replace(/\W+/g, '-')}`);
      const id = await thread(seeded.db);
      await autonomous(seeded.db);
      await setup(seeded.db);
      const { mailer, sent } = stubMailer();

      const result = await triageReply(
        { db: seeded.db, model: stub, mailer },
        { workspaceId: SEED.workspaceId, interactionId: id },
      );

      expect(result.outcome).toBe('copilot');
      expect(sent).toHaveLength(0);
    });
  }

  test('no sender means a card, not a silent drop', async () => {
    seeded = await seedDatabase('triage-auto-no-mailer');
    const id = await thread(seeded.db);
    await autonomous(seeded.db);

    const result = await triageReply(
      { db: seeded.db, model: model('question', 0.95) },
      { workspaceId: SEED.workspaceId, interactionId: id },
    );

    expect(result.outcome).toBe('copilot');
    const cards = await replyCards(seeded.db);
    expect(cards[0]?.status).toBe('pending');
  });
});
