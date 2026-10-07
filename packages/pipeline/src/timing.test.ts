import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryAll, type Client } from '@outreachgraph/db';
import type { Mailer, Message, SendResult } from '@outreachgraph/email';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { HoldLedger, runAutopilot } from './autopilot';
import { bumpQuietThreads } from './triage-reply';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

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

async function makeSendable(db: Client): Promise<void> {
  await db.execute({
    sql: `UPDATE campaigns SET approval_mode = 'trusted_automation' WHERE id = ?`,
    args: [SEED.campaignId],
  });
  await db.execute({
    sql: `UPDATE recommendations SET action = 'send_email', network = 'email' WHERE id = ?`,
    args: [SEED.recommendationId],
  });
  await db.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
          confidence, source_type, verified_by, first_seen_at)
          VALUES ('sid_jane_email', ?, 'email', 'jane@acme.com', 'jane@acme.com', 0.9,
                  'public_web', '[]', ?)`,
    args: [SEED.personId, now()],
  });
}

describe('business hours', () => {
  // Jane is in the San Francisco Bay Area.
  test('holds a cold message outside the recipient’s working day', async () => {
    seeded = await seedDatabase('hours-closed');
    const { db } = seeded;
    await makeSendable(db);

    const { sent, mailer } = recordingMailer();
    // Wednesday 05:00 in San Francisco.
    const result = await runAutopilot(
      {
        db,
        mailer,
        businessHours: true,
        now: new Date('2026-10-07T12:00:00Z'),
        holdLedger: new HoldLedger(),
      },
      SEED.workspaceId,
    );

    expect(sent).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain('America/Los_Angeles');
  });

  test('sends inside it', async () => {
    seeded = await seedDatabase('hours-open');
    const { db } = seeded;
    await makeSendable(db);

    const { sent, mailer } = recordingMailer();
    // Wednesday 10:00 in San Francisco.
    await runAutopilot(
      {
        db,
        mailer,
        businessHours: true,
        now: new Date('2026-10-07T17:00:00Z'),
        holdLedger: new HoldLedger(),
      },
      SEED.workspaceId,
    );

    expect(sent).toHaveLength(1);
  });
});

describe('quiet-thread bump', () => {
  /** They said yes on day 0, we answered on day 1, then nothing. */
  async function quietThread(db: Client, repliedAt: Date): Promise<void> {
    const answeredAt = new Date(repliedAt.getTime() + 86_400_000);
    await db.batch([
      {
        sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network,
              direction, state, body, contact_address, reply_label, reply_confidence,
              reply_label_source, occurred_at, recorded_at)
              VALUES ('int_in', ?, ?, ?, 'email', 'inbound', 'responded',
                      'Sounds interesting, tell me more', 'jane@acme.com', 'interested', 0.95,
                      'rule', ?, ?)`,
        args: [
          SEED.workspaceId,
          SEED.personId,
          SEED.campaignId,
          repliedAt.toISOString(),
          repliedAt.toISOString(),
        ],
      },
      {
        sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network,
              direction, state, body, contact_address, occurred_at, recorded_at)
              VALUES ('int_out', ?, ?, ?, 'email', 'outbound', 'sent',
                      'Happy to. Here is how it works.', 'jane@acme.com', ?, ?)`,
        args: [
          SEED.workspaceId,
          SEED.personId,
          SEED.campaignId,
          answeredAt.toISOString(),
          answeredAt.toISOString(),
        ],
      },
    ]);
  }

  // Wednesday 10:00 in San Francisco.
  const at = new Date('2026-10-07T17:00:00Z');

  test('a thread quiet for 7 days gets exactly one follow-up card', async () => {
    seeded = await seedDatabase('bump-once');
    const { db } = seeded;
    await quietThread(db, new Date(at.getTime() - 10 * 86_400_000));

    const first = await bumpQuietThreads({ db, now: at }, SEED.workspaceId);
    expect(first).toMatchObject({ considered: 1, carded: 1, sent: 0 });

    const cards = await queryAll<{ reason: string; guidance: string }>(
      db,
      `SELECT reason, guidance FROM recommendations WHERE reply_to_interaction_id = 'int_in'`,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.reason).toContain('Gone quiet for 9 days');

    // Never a second one.
    const again = await bumpQuietThreads({ db, now: at }, SEED.workspaceId);
    expect(again.considered).toBe(0);
  });

  test('not before 7 days, and never on a thread older than 30', async () => {
    seeded = await seedDatabase('bump-window');
    const { db } = seeded;

    await quietThread(db, new Date(at.getTime() - 4 * 86_400_000));
    expect((await bumpQuietThreads({ db, now: at }, SEED.workspaceId)).considered).toBe(0);

    await db.execute({ sql: `DELETE FROM interactions`, args: [] });
    await quietThread(db, new Date(at.getTime() - 45 * 86_400_000));
    expect((await bumpQuietThreads({ db, now: at }, SEED.workspaceId)).considered).toBe(0);
  });
});
