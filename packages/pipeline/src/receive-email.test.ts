/**
 * Reading replies, and — more importantly — not inventing them.
 *
 * The two failure modes here are not symmetric. Missing a reply means we mail
 * someone who already answered: embarrassing, and fixed by recording it late.
 * Inventing one means we stop contacting a prospect for good on the strength
 * of an out-of-office, which is silent, and nobody ever goes looking for the
 * outreach that did not happen.
 *
 * So most of these tests are about what must *not* be recorded.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import type { IncomingMessage, MailReader } from '@outreachgraph/email';
import { newId } from '@outreachgraph/domain';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { receiveReplies } from './receive-email';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

function reader(messages: readonly IncomingMessage[]): MailReader {
  return { fetchSince: async () => [...messages] };
}

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    fromAddress: 'jane@acme.com',
    subject: 'Re: cross-border settlement',
    messageId: '<reply-1@acme.com>',
    receivedAt: new Date('2026-08-16T10:00:00.000Z'),
    ...overrides,
  };
}

/** Records that we wrote to `address`, which is the only link a reply has. */
async function sentTo(db: Client, address: string, shared = false): Promise<void> {
  await db.execute({
    sql: `INSERT INTO interactions (id, workspace_id, person_id, network, direction, state,
          contact_address, shared_inbox, occurred_at, recorded_at)
          VALUES (?, ?, ?, 'email', 'outbound', 'contacted', ?, ?, ?, ?)`,
    args: [
      newId('interaction'),
      SEED.workspaceId,
      SEED.personId,
      address,
      shared ? 1 : 0,
      now(),
      now(),
    ],
  });
}

async function inboundCount(db: Client): Promise<number> {
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM interactions WHERE workspace_id = ? AND direction = 'inbound'`,
    [SEED.workspaceId],
  );
  return Number(row?.n ?? 0);
}

describe('recording a reply', () => {
  test('writes an inbound interaction against the person we wrote to', async () => {
    seeded = await seedDatabase('receive-records');
    await sentTo(seeded.db, 'jane@acme.com');

    const result = await receiveReplies({
      db: seeded.db,
      workspaceId: SEED.workspaceId,
      reader: reader([message()]),
    });

    expect(result.recorded).toBe(1);

    const row = await queryOne<{ person_id: string; contact_address: string; state: string }>(
      seeded.db,
      `SELECT person_id, contact_address, state FROM interactions
        WHERE workspace_id = ? AND direction = 'inbound'`,
      [SEED.workspaceId],
    );
    expect(row?.person_id).toBe(SEED.personId);
    expect(row?.contact_address).toBe('jane@acme.com');
    expect(row?.state).toBe('responded');
  });

  test('moves the prospect along the funnel', async () => {
    seeded = await seedDatabase('receive-funnel');
    await sentTo(seeded.db, 'jane@acme.com');

    await receiveReplies({
      db: seeded.db,
      workspaceId: SEED.workspaceId,
      reader: reader([message()]),
    });

    const row = await queryOne<{ interaction_state: string }>(
      seeded.db,
      'SELECT interaction_state FROM campaign_people WHERE person_id = ?',
      [SEED.personId],
    );
    // A prospect who answered, still sitting in `contacted`, is the one row a
    // human most wants to see move.
    expect(row?.interaction_state).toBe('responded');
  });

  test('the reply reaches the funnel, not just the interaction row', async () => {
    seeded = await seedDatabase('receive-stage-event');
    await sentTo(seeded.db, 'jane@acme.com');

    await receiveReplies({
      db: seeded.db,
      workspaceId: SEED.workspaceId,
      reader: reader([message()]),
    });

    // The funnel is built from `campaign_people.status` and the stage log, so
    // writing only `interaction_state` would record the reply everywhere
    // except the chart that exists to show replies.
    const membership = await queryOne<{ status: string }>(
      seeded.db,
      'SELECT status FROM campaign_people WHERE person_id = ?',
      [SEED.personId],
    );
    expect(membership?.status).toBe('responded');

    const event = await queryOne<{ to_status: string; stage: string }>(
      seeded.db,
      `SELECT to_status, stage FROM lead_stage_events
        WHERE person_id = ? ORDER BY occurred_at DESC LIMIT 1`,
      [SEED.personId],
    );
    expect(event?.to_status).toBe('responded');
    expect(event?.stage).toBe('replied');
  });

  test('does not record the same message twice across polls', async () => {
    seeded = await seedDatabase('receive-dedupe');
    await sentTo(seeded.db, 'jane@acme.com');

    const messages = [message()];
    const first = await receiveReplies({
      db: seeded.db,
      workspaceId: SEED.workspaceId,
      reader: reader(messages),
    });
    const second = await receiveReplies({
      db: seeded.db,
      workspaceId: SEED.workspaceId,
      reader: reader(messages),
    });

    expect(first.recorded).toBe(1);
    expect(second.recorded).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(await inboundCount(seeded.db)).toBe(1);
  });
});

describe('what must never count as a reply', () => {
  const cases: { label: string; automated: IncomingMessage['automated'] }[] = [
    { label: 'an out-of-office', automated: 'auto_reply' },
    { label: 'a bounce', automated: 'bounce' },
    { label: 'bulk mail', automated: 'bulk' },
  ];

  for (const { label, automated } of cases) {
    test(`${label} is counted and skipped, not recorded`, async () => {
      seeded = await seedDatabase(`receive-skip-${automated}`);
      await sentTo(seeded.db, 'jane@acme.com');

      const result = await receiveReplies({
        db: seeded.db,
        workspaceId: SEED.workspaceId,
        reader: reader([message({ automated })]),
      });

      expect(result.recorded).toBe(0);
      expect(result.automated[automated as string]).toBe(1);
      // The gate reads inbound rows, so writing one here would permanently
      // stop outreach to this prospect because a robot answered.
      expect(await inboundCount(seeded.db)).toBe(0);
    });
  }

  test('mail from an address we never wrote to is left alone', async () => {
    seeded = await seedDatabase('receive-unmatched');
    await sentTo(seeded.db, 'jane@acme.com');

    const result = await receiveReplies({
      db: seeded.db,
      workspaceId: SEED.workspaceId,
      reader: reader([message({ fromAddress: 'newsletter@somewhere.com' })]),
    });

    expect(result.unmatched).toBe(1);
    expect(await inboundCount(seeded.db)).toBe(0);
  });

  test('one unplaceable message does not abandon the reply behind it', async () => {
    seeded = await seedDatabase('receive-continues');
    await sentTo(seeded.db, 'jane@acme.com');

    const result = await receiveReplies({
      db: seeded.db,
      workspaceId: SEED.workspaceId,
      reader: reader([
        message({ fromAddress: 'newsletter@somewhere.com', messageId: '<n1@x>' }),
        message({ automated: 'bounce', messageId: '<n2@x>' }),
        message({ messageId: '<real@acme.com>' }),
      ]),
    });

    expect(result.fetched).toBe(3);
    expect(result.recorded).toBe(1);
  });
});

describe('a shared company inbox', () => {
  test('records the reply against that address, protecting everyone at it', async () => {
    seeded = await seedDatabase('receive-shared');
    await sentTo(seeded.db, 'support@acme.com', true);

    const result = await receiveReplies({
      db: seeded.db,
      workspaceId: SEED.workspaceId,
      reader: reader([message({ fromAddress: 'support@acme.com' })]),
    });

    expect(result.recorded).toBe(1);

    // Attribution to one colleague is a guess; the address is the fact. The
    // policy gate matches on the address too, so the whole mailbox is covered.
    const rows = await queryAll<{ contact_address: string; shared_inbox: number }>(
      seeded.db,
      `SELECT contact_address, shared_inbox FROM interactions
        WHERE workspace_id = ? AND direction = 'inbound'`,
      [SEED.workspaceId],
    );
    expect(rows[0]?.contact_address).toBe('support@acme.com');
    expect(rows[0]?.shared_inbox).toBe(1);
  });
});
