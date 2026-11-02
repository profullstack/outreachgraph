/**
 * The outreach send path end to end through @profullstack/email-queue.
 *
 * Needs a real Redis: `EMAIL_QUEUE_TEST_REDIS_URL=redis://127.0.0.1:6379 bun test`.
 * Without it the suite is skipped (the gates it proves need BullMQ and Redis).
 * The audit store is in memory; nodemailer is replaced by a recorder, so no
 * mail leaves the machine.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { listUnsubscribeHeaders } from '@profullstack/email-queue';
import { MailerError } from './mailer';
import { MemoryEmailAuditStore } from './memory-audit-store';
import { OutreachEmailQueue, type OutreachEmailQueueConfig } from './queue';
import { SmtpMailer } from './smtp';

const REDIS_URL = process.env.EMAIL_QUEUE_TEST_REDIS_URL;
const ADDRESS = 'Profullstack, Inc., 123 Test St, San Jose, CA 95113';
const KEY = randomBytes(32).toString('base64');

const mailbox = (username: string) => ({
  host: 'smtp.forwardemail.net',
  port: 465,
  secure: true,
  username,
  password: `pw-${randomUUID()}`,
  fromEmail: username,
});

interface Recorder {
  readonly sent: Record<string, unknown>[];
  fail?: () => never;
}

/** One nodemailer stand-in per mailbox, keyed by the login it was built for. */
function recorders() {
  const byUser = new Map<string, Recorder>();
  const get = (user: string): Recorder => {
    let r = byUser.get(user);
    if (!r) {
      r = { sent: [] };
      byUser.set(user, r);
    }
    return r;
  };
  const createTransport = (config: Record<string, unknown>) => {
    const user = String((config.auth as { user: string }).user);
    return {
      sendMail: async (mail: Record<string, unknown>) => {
        const r = get(user);
        r.fail?.();
        r.sent.push(mail);
        return { messageId: `<${randomUUID()}@profullstack.com>`, accepted: [mail.to] };
      },
      verify: async () => true,
      close: () => {},
    };
  };
  return { get, createTransport };
}

describe.skipIf(!REDIS_URL)('outreach email queue (Redis)', () => {
  let queue: OutreachEmailQueue;
  let audit: MemoryEmailAuditStore;
  let rec: ReturnType<typeof recorders>;
  let tenant: string;

  const build = (overrides: Partial<OutreachEmailQueueConfig> = {}) =>
    new OutreachEmailQueue({
      redisUrl: REDIS_URL!,
      encryptionKey: KEY,
      auditStore: audit,
      postalAddress: ADDRESS,
      maxRecipientDomainPer24Hours: 1000,
      pollMs: 25,
      waitTimeoutMs: 15_000,
      createTransport: rec.createTransport,
      ...overrides,
    });

  // Each test gets fresh mailbox passwords and recipients, but the mailbox
  // identities are the real two, so breakers left by one test are cleared.
  beforeEach(async () => {
    audit = new MemoryEmailAuditStore();
    rec = recorders();
    tenant = `ws_${randomUUID().slice(0, 8)}`;
    queue = build();
    // FLUSHALL is only ever sent to a throwaway local Redis.
    const host = new URL(REDIS_URL!).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') {
      throw new Error('EMAIL_QUEUE_TEST_REDIS_URL must point at a local throwaway Redis');
    }
    const { Redis } = await import('ioredis');
    const redis = new Redis(REDIS_URL!);
    await redis.flushall();
    await redis.quit();
  });
  afterEach(async () => {
    await queue.close();
  });
  afterAll(async () => {
    await queue?.close();
  });

  const knox = () => mailbox('knox@profullstack.com');
  const cha0s = () => mailbox('cha0spunk@profullstack.com');

  const cold = (to: string, key: string) => ({
    to,
    subject: 'Quick question',
    text: 'Hello there.\n\n--\nUnsubscribe: https://outreachgraph.com/u/tok',
    headers: listUnsubscribeHeaders('https://outreachgraph.com/u/tok'),
    idempotencyKey: key,
    tenantId: tenant,
    kind: 'marketing' as const,
  });

  test('a queued send uses the stable key: replaying it does not send again', async () => {
    const creds = knox();
    const mailer = new SmtpMailer(creds, { queue, createTransport: rec.createTransport });
    const key = `outreach:${tenant}:per_1:rec_1`;

    const first = await mailer.send(cold('jane@acme.test', key));
    const second = await mailer.send(cold('jane@acme.test', key));

    expect(first.id).toBeDefined();
    expect(second.id).toBe(first.id!);
    expect(rec.get(creds.username).sent).toHaveLength(1);

    // The postal address was added to the body on the way out.
    const sent = rec.get(creds.username).sent[0]!;
    expect(String(sent.text)).toContain('123 Test St');
    expect(sent.headers).toMatchObject({ 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });

    // A fresh mailer object (a restart, a later tick) replays the same receipt.
    const again = await new SmtpMailer(creds, { queue, createTransport: rec.createTransport }).send(
      cold('jane@acme.test', key),
    );
    expect(again.id).toBe(first.id!);
    expect(rec.get(creds.username).sent).toHaveLength(1);
  });

  test('a suppressed recipient is refused and nothing is sent', async () => {
    const creds = knox();
    await queue.suppress('Bob@Acme.test', 'unsubscribe', 'test');

    const error = await new SmtpMailer(creds, { queue, createTransport: rec.createTransport })
      .send(cold('bob@acme.test', `outreach:${tenant}:per_2:rec_2`))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MailerError);
    expect((error as MailerError).code).toBe('RECIPIENT_SUPPRESSED');
    expect(rec.get(creds.username).sent).toHaveLength(0);
  });

  test('SENDER_PAUSED stops the mailbox and never moves the message to the other one', async () => {
    const creds = knox();
    rec.get(creds.username).fail = () => {
      throw Object.assign(new Error('Invalid login: 535 5.7.8 Authentication failed'), {
        code: 'EAUTH',
        responseCode: 535,
        response: '535 5.7.8 Authentication failed',
      });
    };
    const mailer = new SmtpMailer(creds, { queue, createTransport: rec.createTransport });

    // The provider block trips the breaker on the first message...
    const first = (await mailer
      .send(cold('one@acme.test', `outreach:${tenant}:per_3:rec_3`))
      .catch((e: unknown) => e)) as MailerError;
    expect(first.code).toBe('SENDER_PAUSED');

    // ...and every later submission from that mailbox is refused up front.
    const second = (await mailer
      .send(cold('two@acme.test', `outreach:${tenant}:per_4:rec_4`))
      .catch((e: unknown) => e)) as MailerError;
    expect(second).toBeInstanceOf(MailerError);
    expect(second.code).toBe('SENDER_PAUSED');

    // The other mailbox was never asked to carry either message.
    expect(rec.get('cha0spunk@profullstack.com').sent).toHaveLength(0);
    expect(rec.get(creds.username).sent).toHaveLength(0);

    // And the pause is per mailbox: cha0spunk's own prospects are unaffected.
    const other = await new SmtpMailer(cha0s(), {
      queue,
      createTransport: rec.createTransport,
    }).send(cold('three@other.test', `outreach:${tenant}:per_5:rec_5`));
    expect(other.id).toBeDefined();
  });

  test('marketing without a configured postal address is refused', async () => {
    await queue.close();
    queue = build({ postalAddress: undefined });
    const creds = knox();

    const error = (await new SmtpMailer(creds, { queue, createTransport: rec.createTransport })
      .send(cold('jane@acme.test', `outreach:${tenant}:per_6:rec_6`))
      .catch((e: unknown) => e)) as MailerError;

    expect(error).toBeInstanceOf(MailerError);
    expect(error.code).toBe('BULK_POSTAL_ADDRESS_NOT_CONFIGURED');
    expect(rec.get(creds.username).sent).toHaveLength(0);
  });

  test('marketing without a one-click List-Unsubscribe header is refused', async () => {
    const creds = knox();
    const { headers: _drop, ...noHeaders } = cold(
      'jane@acme.test',
      `outreach:${tenant}:per_7:rec_7`,
    );
    const error = (await new SmtpMailer(creds, { queue, createTransport: rec.createTransport })
      .send(noHeaders)
      .catch((e: unknown) => e)) as MailerError;
    expect(error.code).toBe('BULK_LIST_UNSUBSCRIBE_MISSING');
    expect(rec.get(creds.username).sent).toHaveLength(0);
  });

  test('a one-click unsubscribe suppresses the address for every later send', async () => {
    const result = await queue.unsubscribeOneClick(
      'tok_1',
      'List-Unsubscribe=One-Click',
      async () => 'carol@acme.test',
    );
    expect(result.ok).toBe(true);
    expect(await audit.getSuppression('carol@acme.test')).toMatchObject({ reason: 'unsubscribe' });

    const error = (await new SmtpMailer(knox(), { queue, createTransport: rec.createTransport })
      .send(cold('carol@acme.test', `outreach:${tenant}:per_8:rec_8`))
      .catch((e: unknown) => e)) as MailerError;
    expect(error.code).toBe('RECIPIENT_SUPPRESSED');
  });

  test('an IMAP unsubscribe (mailto) suppresses its sender', async () => {
    expect((await queue.unsubscribeMailto('Dan <dan@acme.test>', 'unsubscribe')).ok).toBe(true);
    expect(await audit.getSuppression('dan@acme.test')).toBeDefined();
  });

  test('the recipient-domain cap holds cold mail to one company', async () => {
    await queue.close();
    queue = build({ maxRecipientDomainPer24Hours: 1 });
    const mailer = new SmtpMailer(knox(), { queue, createTransport: rec.createTransport });
    await mailer.send(cold('a@capped.test', `outreach:${tenant}:per_9:rec_9`));
    const error = (await mailer
      .send(cold('b@capped.test', `outreach:${tenant}:per_10:rec_10`))
      .catch((e: unknown) => e)) as MailerError;
    expect(error.code).toBe('QUOTA_EXHAUSTED');
  });
});
