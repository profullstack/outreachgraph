import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import type { Mailer, Message, SendResult } from '@outreachgraph/email';
import type { GenerateResult, TextModel } from '@outreachgraph/ai';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { runAutopilot } from './autopilot';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

/** Collects what would have been sent, instead of sending it. */
function recordingMailer(): { sent: Message[]; mailer: Mailer } {
  const sent: Message[] = [];
  return {
    sent,
    mailer: {
      send: async (message): Promise<SendResult> => {
        sent.push(message);
        return { id: 'resend_1' };
      },
    },
  };
}

function failingMailer(): Mailer {
  return {
    send: async (): Promise<SendResult> => {
      throw new Error('sending domain is not verified');
    },
  };
}

/**
 * Puts the fixture into the state autopilot acts on: a trusted-automation
 * campaign with a pending `email/send_email` recommendation, a draft, and an
 * address to send it to.
 */
async function makeSendable(
  db: Client,
  options: { personEmail?: string; companyEmail?: string; autopilot?: boolean } = {},
): Promise<void> {
  const stamp = now();

  await db.execute({
    sql: `UPDATE campaigns SET approval_mode = ? WHERE id = ?`,
    args: [
      options.autopilot === false ? 'draft_and_approve' : 'trusted_automation',
      SEED.campaignId,
    ],
  });

  await db.execute({
    sql: `UPDATE recommendations SET action = 'send_email', network = 'email' WHERE id = ?`,
    args: [SEED.recommendationId],
  });

  if (options.personEmail) {
    await db.execute({
      sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
            confidence, source_type, verified_by, first_seen_at)
            VALUES ('sid_jane_email', ?, 'email', ?, ?, 0.88, 'public_web', '[]', ?)`,
      args: [SEED.personId, options.personEmail, options.personEmail, stamp],
    });
  }

  if (options.companyEmail) {
    await db.execute({
      sql: `UPDATE companies SET contact_email = ? WHERE id = ?`,
      args: [options.companyEmail, SEED.companyId],
    });
  }
}

describe('runAutopilot', () => {
  test('sends a drafted message and records the whole trail', async () => {
    seeded = await seedDatabase('autopilot-send');
    const { db } = seeded;
    await makeSendable(db, { personEmail: 'jane@acme.com' });

    const { sent, mailer } = recordingMailer();
    const result = await runAutopilot({ db, mailer, replyTo: 'me@mine.com' }, SEED.workspaceId);

    expect(result.sent).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('jane@acme.com');
    // The one thing the human does is reply, so replies must reach them.
    expect(sent[0]?.replyTo).toBe('me@mine.com');
    expect(sent[0]?.text).toContain('cross-border settlement');

    const action = await queryOne<{ status: string; external_id: string | null; mode: string }>(
      db,
      `SELECT status, external_id, mode FROM actions WHERE workspace_id = ?`,
      [SEED.workspaceId],
    );
    expect(action?.status).toBe('completed');
    expect(action?.external_id).toBe('resend_1');

    const recommendation = await queryOne<{ status: string }>(
      db,
      `SELECT status FROM recommendations WHERE id = ?`,
      [SEED.recommendationId],
    );
    expect(recommendation?.status).toBe('executed');

    const interaction = await queryOne<{ direction: string; state: string }>(
      db,
      `SELECT direction, state FROM interactions WHERE workspace_id = ?`,
      [SEED.workspaceId],
    );
    expect(interaction?.direction).toBe('outbound');

    // The funnel has to see this, or the chart says nobody was ever contacted.
    const stage = await queryOne<{ stage: string }>(
      db,
      `SELECT stage FROM lead_stage_events WHERE person_id = ? ORDER BY occurred_at DESC LIMIT 1`,
      [SEED.personId],
    );
    expect(stage?.stage).toBe('contacted');

    const audit = await queryOne<{ event_type: string }>(
      db,
      `SELECT event_type FROM audit_events WHERE workspace_id = ? AND actor_id = 'autopilot'`,
      [SEED.workspaceId],
    );
    expect(audit?.event_type).toBe('action.executed');
  });

  test('a campaign not on autopilot is never sent for', async () => {
    seeded = await seedDatabase('autopilot-off');
    const { db } = seeded;
    await makeSendable(db, { personEmail: 'jane@acme.com', autopilot: false });

    const { sent, mailer } = recordingMailer();
    const result = await runAutopilot({ db, mailer }, SEED.workspaceId);

    expect(sent).toHaveLength(0);
    expect(result.sent).toHaveLength(0);
  });

  test('falls back to the company inbox and marks it shared', async () => {
    seeded = await seedDatabase('autopilot-shared');
    const { db } = seeded;
    await makeSendable(db, { companyEmail: 'info@acme.com' });

    const { sent, mailer } = recordingMailer();
    const result = await runAutopilot({ db, mailer }, SEED.workspaceId);

    expect(sent[0]?.to).toBe('info@acme.com');
    expect(result.sent[0]?.toSharedInbox).toBe(true);
  });

  test('a person with no address anywhere is skipped, not guessed at', async () => {
    seeded = await seedDatabase('autopilot-noaddress');
    const { db } = seeded;
    await makeSendable(db);

    const { sent, mailer } = recordingMailer();
    const result = await runAutopilot({ db, mailer }, SEED.workspaceId);

    expect(sent).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain('no address');
  });

  test('a suppressed person is not written to even with a pending recommendation', async () => {
    seeded = await seedDatabase('autopilot-suppressed');
    const { db } = seeded;
    await makeSendable(db, { personEmail: 'jane@acme.com' });

    // The stored policy snapshot still says the send was fine. Live state is
    // what decides, which is the whole point of re-checking here.
    await db.execute({
      sql: `UPDATE people SET status = 'suppressed' WHERE id = ?`,
      args: [SEED.personId],
    });

    const { sent, mailer } = recordingMailer();
    const result = await runAutopilot({ db, mailer }, SEED.workspaceId);

    expect(sent).toHaveLength(0);
    expect(result.sent).toHaveLength(0);
  });

  test('the daily cap stops sending', async () => {
    seeded = await seedDatabase('autopilot-cap');
    const { db } = seeded;
    await makeSendable(db, { personEmail: 'jane@acme.com' });

    const stamp = now();
    await db.execute({
      sql: `INSERT INTO workspace_settings (workspace_id, autopilot_daily_cap, created_at, updated_at)
            VALUES (?, 0, ?, ?)`,
      args: [SEED.workspaceId, stamp, stamp],
    });

    const { sent, mailer } = recordingMailer();
    await runAutopilot({ db, mailer }, SEED.workspaceId);

    expect(sent).toHaveLength(0);
  });

  test('a draft that failed its quality checks is never machine-sent', async () => {
    seeded = await seedDatabase('autopilot-checks');
    const { db } = seeded;
    await makeSendable(db, { personEmail: 'jane@acme.com' });

    await db.execute({
      sql: `UPDATE drafts SET checks_json = ? WHERE id = ?`,
      args: [JSON.stringify([{ name: 'grounding', passed: false }]), SEED.draftId],
    });

    const { sent, mailer } = recordingMailer();
    const result = await runAutopilot({ db, mailer }, SEED.workspaceId);

    expect(sent).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain('quality');
  });

  test('a failed send keeps the lead for the next tick', async () => {
    seeded = await seedDatabase('autopilot-failure');
    const { db } = seeded;
    await makeSendable(db, { personEmail: 'jane@acme.com' });

    const result = await runAutopilot({ db, mailer: failingMailer() }, SEED.workspaceId);

    expect(result.failed).toBe(1);
    expect(result.sent).toHaveLength(0);

    const action = await queryOne<{ status: string; error: string | null }>(
      db,
      `SELECT status, error FROM actions WHERE workspace_id = ?`,
      [SEED.workspaceId],
    );
    expect(action?.status).toBe('failed');
    expect(action?.error).toContain('not verified');

    // Still pending, so the retry actually happens.
    const recommendation = await queryOne<{ status: string }>(
      db,
      `SELECT status FROM recommendations WHERE id = ?`,
      [SEED.recommendationId],
    );
    expect(recommendation?.status).toBe('pending');
  });

  test('a permanently failing send is eventually given up on', async () => {
    seeded = await seedDatabase('autopilot-giveup');
    const { db } = seeded;
    await makeSendable(db, { personEmail: 'jane@acme.com' });

    const mailer = failingMailer();

    // An invalid API key fails identically every time. Retrying it forever
    // means a row and a provider request per tick, indefinitely.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await runAutopilot({ db, mailer }, SEED.workspaceId);
    }

    const rows = await queryAll<{ id: string }>(
      db,
      `SELECT id FROM actions WHERE workspace_id = ? AND status = 'failed'`,
      [SEED.workspaceId],
    );
    expect(rows.length).toBe(3);

    const last = await runAutopilot({ db, mailer }, SEED.workspaceId);
    expect(last.skipped[0]?.reason).toContain('giving up');
  });

  test('with no mailer nothing is sent and the reason is reported', async () => {
    seeded = await seedDatabase('autopilot-nomailer');
    const { db } = seeded;
    await makeSendable(db, { personEmail: 'jane@acme.com' });

    const result = await runAutopilot({ db }, SEED.workspaceId);

    expect(result.sent).toHaveLength(0);
    // The policy engine catches this before the send does, and says it better:
    // no mailer means no connected email account, which downgrades the action
    // to manual rather than merely failing to deliver it.
    expect(result.skipped[0]?.reason).toContain('No connected email account');
  });

  test('the same recommendation is not sent twice', async () => {
    seeded = await seedDatabase('autopilot-once');
    const { db } = seeded;
    await makeSendable(db, { personEmail: 'jane@acme.com' });

    const { sent, mailer } = recordingMailer();
    await runAutopilot({ db, mailer }, SEED.workspaceId);
    await runAutopilot({ db, mailer }, SEED.workspaceId);

    expect(sent).toHaveLength(1);
  });
});

describe('sending as the customer rather than as us', () => {
  test('records which transport carried the message', async () => {
    seeded = await seedDatabase('autopilot-via');
    const { db } = seeded;
    await makeSendable(db, { personEmail: 'jane@acme.com' });

    const { mailer } = recordingMailer();
    await runAutopilot({ db, mailer }, SEED.workspaceId);

    const event = await queryOne<{ detail_json: string }>(
      db,
      `SELECT detail_json FROM workflow_events WHERE phase = 'send' AND level = 'success'`,
    );

    // "Sent from your own mail server" and "sent from ours on your behalf" are
    // materially different claims — whose domain reputation is spent, and where
    // a reply lands — so which one happened is never left to inference. This
    // workspace has connected no mailbox, so the platform sender carried it and
    // the event must say so rather than leaving it blank.
    const detail = JSON.parse(event?.detail_json ?? '{}');
    expect(detail.via).toBe('platform');
  });

  test('uses the account’s reply-to so answers reach the customer', async () => {
    seeded = await seedDatabase('autopilot-replyto');
    const { db } = seeded;
    await makeSendable(db, { personEmail: 'jane@acme.com' });

    const { sent, mailer } = recordingMailer();
    await runAutopilot({ db, mailer, replyTo: 'anthony@customer.com' }, SEED.workspaceId);

    expect(sent[0]?.replyTo).toBe('anthony@customer.com');
  });

  test('a lead held back explains itself in the live feed', async () => {
    seeded = await seedDatabase('autopilot-skip-event');
    const { db } = seeded;
    // No address anywhere: the most common reason a campaign looks stuck.
    await makeSendable(db);

    const { mailer } = recordingMailer();
    const result = await runAutopilot({ db, mailer }, SEED.workspaceId);

    expect(result.sent).toHaveLength(0);

    const event = await queryOne<{ message: string; level: string }>(
      db,
      `SELECT message, level FROM workflow_events WHERE phase = 'send'`,
    );

    expect(event?.level).toBe('warn');
    expect(event?.message).toContain('no address published');
  });

  test('a failed send says why, rather than vanishing', async () => {
    seeded = await seedDatabase('autopilot-fail-event');
    const { db } = seeded;
    await makeSendable(db, { personEmail: 'jane@acme.com' });

    await runAutopilot({ db, mailer: failingMailer() }, SEED.workspaceId);

    const event = await queryOne<{ message: string; level: string }>(
      db,
      `SELECT message, level FROM workflow_events WHERE phase = 'send' AND level = 'error'`,
    );

    expect(event?.level).toBe('error');
    expect(event?.message).toContain('sending domain is not verified');
  });
});

/**
 * A lead whose draft was never written.
 *
 * Drafting happened once, when the recommendation was created, and nothing
 * retried it — so a composer that was briefly unavailable left the lead
 * permanently undraftable. The send sweep then found it every tick and logged
 * "no drafted message": one prospect in production collected 98 identical
 * warnings while nothing attempted the thing being warned about.
 */
describe('a recommendation with no draft', () => {
  function countingModel(text: string): { calls: () => number; model: TextModel } {
    const state = { calls: 0 };
    return {
      calls: () => state.calls,
      model: {
        generate: async (): Promise<GenerateResult> => {
          state.calls += 1;
          return {
            text,
            model: 'test',
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            refused: false,
          };
        },
      },
    };
  }

  async function withoutDraft(db: Client): Promise<void> {
    await db.execute({
      sql: 'DELETE FROM drafts WHERE recommendation_id = ?',
      args: [SEED.recommendationId],
    });
  }

  test('is written and sent rather than warned about forever', async () => {
    seeded = await seedDatabase('autopilot-drafts-missing');
    const { db } = seeded;
    await makeSendable(db, { personEmail: 'jane@acme.com' });
    await withoutDraft(db);

    const { sent, mailer } = recordingMailer();
    const composer = countingModel('We ran into a similar cross-border settlement issue.');

    const result = await runAutopilot({ db, mailer, model: composer.model }, SEED.workspaceId);

    expect(composer.calls()).toBeGreaterThan(0);
    expect(result.sent).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  test('is still only reported when there is no composer at all', async () => {
    seeded = await seedDatabase('autopilot-drafts-no-model');
    const { db } = seeded;
    await makeSendable(db, { personEmail: 'jane@acme.com' });
    await withoutDraft(db);

    const { sent, mailer } = recordingMailer();
    const result = await runAutopilot({ db, mailer }, SEED.workspaceId);

    // Unchanged behaviour without a model: reported, skipped, never invented.
    expect(sent).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain('no drafted message');
  });
});
