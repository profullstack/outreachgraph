import { afterEach, describe, expect, test } from 'bun:test';
import type { Mailer, Message, SendResult } from '@outreachgraph/email';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { EMAIL_DAILY_CEILING, mailerForSend } from './email-account';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const platform: Mailer = {
  async send(_message: Message): Promise<SendResult> {
    return { messageId: 'm' } as SendResult;
  },
} as Mailer;

async function sentToday(count: number, at: Date): Promise<void> {
  const stamp = at.toISOString();
  await seeded!.db.execute({
    sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
          INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
                               mode, status, created_at, executed_at)
          SELECT 'act_c' || i, ?, ?, ?, 'send_email', 'email', 'customer_managed',
                 'completed', ?, ? FROM n`,
    args: [count, SEED.workspaceId, SEED.recommendationId, SEED.personId, stamp, stamp],
  });
}

describe('the workspace email ceiling', () => {
  test('is a thousand a day', () => {
    expect(EMAIL_DAILY_CEILING).toBe(1_000);
  });

  test('sends below the ceiling', async () => {
    seeded = await seedDatabase('email-ceiling-below');
    const at = new Date('2026-10-26T15:00:00.000Z');
    await sentToday(EMAIL_DAILY_CEILING - 1, at);

    const mailbox = await mailerForSend(seeded.db, SEED.workspaceId, {
      encryptionKey: undefined,
      fallback: platform,
      at,
    });
    expect(mailbox.kind).toBe('ready');
  });

  test('defers to the next UTC day once a thousand have gone out', async () => {
    seeded = await seedDatabase('email-ceiling-at');
    const at = new Date('2026-10-26T15:00:00.000Z');
    await sentToday(EMAIL_DAILY_CEILING, at);

    const mailbox = await mailerForSend(seeded.db, SEED.workspaceId, {
      encryptionKey: undefined,
      fallback: platform,
      at,
    });
    expect(mailbox.kind).toBe('deferred');
    if (mailbox.kind !== 'deferred') return;
    expect(mailbox.code).toBe('workspace_ceiling');
    expect(mailbox.retryAt).toBe('2026-10-27T00:00:00.000Z');
  });
});
