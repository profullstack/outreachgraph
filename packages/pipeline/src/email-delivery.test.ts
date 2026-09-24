import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryOne, type Client } from '@outreachgraph/db';
import type { Mailer, Message, SendResult } from '@outreachgraph/email';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { runEmailDelivery } from './email-delivery';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const JOB = {
  workspaceId: SEED.workspaceId,
  payload: { actionId: 'act_wait', actor: { actorKind: 'user', actorId: SEED.userId } },
};

function recording(): { sent: Message[]; mailer: Mailer } {
  const sent: Message[] = [];
  return {
    sent,
    mailer: {
      send: async (message): Promise<SendResult> => {
        sent.push(message);
        return { id: 'msg' };
      },
    },
  };
}

/** An approved email that waited for a mailbox with room. */
async function waitingEmail(db: Client): Promise<void> {
  const stamp = now();
  await db.execute(
    `UPDATE recommendations SET action = 'send_email', network = 'email', status = 'approved'`,
  );
  await db.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
          confidence, source_type, verified_by, first_seen_at)
          VALUES ('sid_jane_email', ?, 'email', 'jane@acme.com', 'jane@acme.com', 0.9,
          'public_web', '[]', ?)`,
    args: [SEED.personId, stamp],
  });
  await db.execute({
    sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
          mode, status, created_at) VALUES ('act_wait', ?, ?, ?, 'send_email', 'email',
          'customer_managed', 'queued', ?)`,
    args: [SEED.workspaceId, SEED.recommendationId, SEED.personId, stamp],
  });
}

describe('runEmailDelivery', () => {
  test('sends a waiting email once something can carry it', async () => {
    seeded = await seedDatabase('email-delivery-send');
    const { db } = seeded;
    await waitingEmail(db);
    const { sent, mailer } = recording();

    const result = await runEmailDelivery({ db, mailer }, JOB);
    expect(result).toMatchObject({ sent: true, to: 'jane@acme.com' });
    expect(sent).toHaveLength(1);
  });

  test('does not send an opener to someone who wrote back while it waited', async () => {
    seeded = await seedDatabase('email-delivery-replied');
    const { db } = seeded;
    await waitingEmail(db);
    await db.execute({
      sql: `INSERT INTO interactions (id, workspace_id, person_id, network, direction, state,
            occurred_at, recorded_at)
            VALUES ('int_reply', ?, ?, 'email', 'inbound', 'responded', ?, ?)`,
      args: [SEED.workspaceId, SEED.personId, now(), now()],
    });
    const { sent, mailer } = recording();

    const result = await runEmailDelivery({ db, mailer }, JOB);
    expect(result.sent).toBe(false);
    expect(sent).toHaveLength(0);
    const action = await queryOne<{ status: string }>(
      db,
      `SELECT status FROM actions WHERE id = 'act_wait'`,
      [],
    );
    expect(action?.status).toBe('cancelled');
  });

  test('a card dismissed while it waited is left alone', async () => {
    seeded = await seedDatabase('email-delivery-dismissed');
    const { db } = seeded;
    await waitingEmail(db);
    await db.execute(`UPDATE recommendations SET status = 'skipped'`);
    const { sent, mailer } = recording();

    expect(await runEmailDelivery({ db, mailer }, JOB)).toEqual({
      sent: false,
      reason: 'card is no longer approved',
    });
    expect(sent).toHaveLength(0);
  });
});
