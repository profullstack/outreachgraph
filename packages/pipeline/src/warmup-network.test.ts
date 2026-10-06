import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, type Client } from '@outreachgraph/db';
import type { Message, SweptWarmup } from '@outreachgraph/email';
import { generateSecretKey, parseSecretKey } from '@outreachgraph/secrets';
import { seedDatabase, type SeededDatabase, SEED } from '../../../apps/api/src/test-seed';
import { connectEmailAccount } from './email-account';
import { listMailboxes } from './mailboxes';
import { receiveReplies } from './receive-email';
import { runWarmupInbox, runWarmupSends, setWarmupNetwork } from './warmup-network';

let seeded: SeededDatabase | undefined;
afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const KEY = parseSecretKey(generateSecretKey());
const AT = new Date('2026-10-06T12:00:00.000Z');

async function mailbox(db: Client, email: string, name: string): Promise<string> {
  const summary = await connectEmailAccount(db, {
    workspaceId: SEED.workspaceId,
    account: {
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      username: email,
      password: 'pw',
      fromEmail: email,
      fromName: name,
      imapHost: 'imap.example.test',
    },
    encryptionKey: KEY,
    verify: false,
  });
  return summary.accountId!;
}

/** Records every send, and hands back a stable Message-ID per send. */
function outbox() {
  const sent: Array<Message & { from: string }> = [];
  return {
    sent,
    mailerFor: (credentials: { fromEmail: string }) => ({
      send: async (message: Message) => {
        sent.push({ ...message, from: credentials.fromEmail });
        return { id: `<m${sent.length}@test>` };
      },
    }),
  };
}

describe('warm-up network', () => {
  test('two members write to each other, sweep, rescue from spam and answer', async () => {
    seeded = await seedDatabase('warmup-network');
    const { db } = seeded;
    const ana = await mailbox(db, 'ana@acme.test', 'Ana Lopez');
    const bo = await mailbox(db, 'bo@other.test', 'Bo Chan');
    await setWarmupNetwork(db, ana, true, () => 0.1);
    await setWarmupNetwork(db, bo, true, () => 0.9);

    const box = outbox();
    const first = await runWarmupSends(db, {
      encryptionKey: KEY,
      at: AT,
      random: () => 0.5,
      mailerFor: box.mailerFor,
    });
    expect(first).toEqual({ sent: 2, failed: 0, alone: 0 });

    const toBo = box.sent.find((m) => m.from === 'ana@acme.test')!;
    expect(toBo.to).toBe('bo@other.test');
    expect(toBo.headers?.['X-OG-Warmup']).toMatch(/^wut_/);
    const tags = await queryAll<{ id: string; warmup_tag: string }>(
      db,
      `SELECT id, warmup_tag FROM integration_accounts WHERE id IN (?, ?)`,
      [ana, bo],
    );
    const boTag = tags.find((t) => t.id === bo)!.warmup_tag;
    // The RECIPIENT's tag closes the message, so Bo can filter on it.
    expect(toBo.text.trim().split('\n').at(-1)).toBe(boTag);

    // Paced: a second run a minute later sends nothing.
    const again = await runWarmupSends(db, {
      encryptionKey: KEY,
      at: new Date(AT.getTime() + 60_000),
      random: () => 0.5,
      mailerFor: box.mailerFor,
    });
    expect(again.sent).toBe(0);

    // Bo's copy landed in spam; Ana's in the inbox. Both answer (random 0).
    const swept = (token: string, landed: SweptWarmup['landed']): SweptWarmup[] => [
      { token, landed, messageId: '<orig@test>', subject: 'x' },
    ];
    const toAna = box.sent.find((m) => m.from === 'bo@other.test')!;
    const inbox = await runWarmupInbox(db, {
      encryptionKey: KEY,
      at: new Date(AT.getTime() + 3_600_000),
      random: () => 0,
      mailerFor: box.mailerFor,
      sweeperFor: (credentials) => ({
        sweep: async () =>
          credentials.username === 'bo@other.test'
            ? swept(toBo.headers!['X-OG-Warmup']!, 'spam')
            : swept(toAna.headers!['X-OG-Warmup']!, 'inbox'),
      }),
    });
    expect(inbox).toEqual({ seen: 2, rescued: 1, replied: 2, failed: 0 });

    const reply = box.sent.at(-1)!;
    expect(reply.subject.startsWith('Re: ')).toBe(true);
    expect(reply.headers?.['In-Reply-To']).toBe('<orig@test>');

    const { mailboxes } = await listMailboxes(
      db,
      SEED.workspaceId,
      new Date(AT.getTime() + 3_600_000),
    );
    const boView = mailboxes.find((m) => m.id === bo)!;
    expect(boView.warmupNetwork).toMatchObject({
      network: true,
      tag: boTag,
      received14d: 1,
      spam14d: 1,
      inbox14d: 0,
      peers: 1,
    });
  });

  test('a lone member has nobody to write to', async () => {
    seeded = await seedDatabase('warmup-alone');
    const { db } = seeded;
    const ana = await mailbox(db, 'ana@acme.test', 'Ana');
    await setWarmupNetwork(db, ana, true);
    const box = outbox();
    const result = await runWarmupSends(db, {
      encryptionKey: KEY,
      at: AT,
      mailerFor: box.mailerFor,
    });
    expect(result).toEqual({ sent: 0, failed: 0, alone: 1 });
    expect(box.sent).toHaveLength(0);
  });

  test('the reply poller never treats warm-up mail as a reply', async () => {
    seeded = await seedDatabase('warmup-not-a-reply');
    const result = await receiveReplies({
      db: seeded.db,
      workspaceId: SEED.workspaceId,
      reader: {
        fetchSince: async () => [
          {
            fromAddress: 'bo@other.test',
            subject: 'Checking in',
            receivedAt: AT,
            warmup: 'wut_abc',
          },
        ],
      },
    });
    expect(result.recorded).toBe(0);
    expect(result.automated.warmup).toBe(1);
  });
});
