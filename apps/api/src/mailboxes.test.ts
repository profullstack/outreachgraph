/**
 * The Mailboxes page over HTTP: the list with health and reply status, and
 * detecting an address's servers.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { now, queryAll, type Client } from '@outreachgraph/db';
import { recordReplyCheck, sweepBlacklists } from '@outreachgraph/pipeline';
import { generateSecretKey, parseSecretKey } from '@outreachgraph/secrets';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const OWNER: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

const KEY = parseSecretKey(generateSecretKey());

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

async function harness(label: string): Promise<{ app: Hono<AppEnv>; db: Client }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  const app = createApp({
    db: seeded.db,
    authenticate: async () => OWNER,
    encryptionKey: KEY,
  });
  return { app, db: seeded.db };
}

async function call(app: Hono<AppEnv>, method: string, path: string, body?: unknown) {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface MailboxJson {
  id: string;
  fromEmail: string;
  domain: string;
  provider: string;
  readsReplies: boolean;
  repliesError: string | null;
  repliesCheckedAt: string | null;
  healthScore: number;
  healthIssues: string[];
  bounceRisk: string;
}

describe('GET /mailboxes', () => {
  test('is empty, with presets, before anything is connected', async () => {
    const { app } = await harness('mailboxes-empty');
    const response = await call(app, 'GET', '/mailboxes');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      mailboxes: unknown[];
      summary: { mailboxes: number };
      canConnect: boolean;
      presets: { id: string }[];
    };
    expect(body.mailboxes).toEqual([]);
    expect(body.summary.mailboxes).toBe(0);
    expect(body.canConnect).toBe(true);
    expect(body.presets.map((p) => p.id)).toContain('forwardemail');
  });

  test('shows provider, reply reading and health per mailbox', async () => {
    const { app, db } = await harness('mailboxes-list');

    expect(
      (
        await call(app, 'PUT', '/integrations/email', {
          host: 'smtp.forwardemail.net',
          port: 465,
          secure: true,
          username: 'ana@acme.test',
          password: 'pw',
          fromEmail: 'ana@acme.test',
          imapHost: 'imap.forwardemail.net',
          skipVerification: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(app, 'PUT', '/integrations/email', {
          host: 'smtp.example.test',
          port: 587,
          secure: false,
          username: 'bo@acme.test',
          password: 'pw',
          fromEmail: 'bo@acme.test',
          skipVerification: true,
        })
      ).status,
    ).toBe(200);

    let body = (await (await call(app, 'GET', '/mailboxes')).json()) as {
      mailboxes: MailboxJson[];
      summary: { mailboxes: number; notReadingReplies: number };
    };
    expect(body.summary.mailboxes).toBe(2);

    const ana = body.mailboxes.find((m) => m.fromEmail === 'ana@acme.test')!;
    const bo = body.mailboxes.find((m) => m.fromEmail === 'bo@acme.test')!;
    expect(ana.provider).toBe('forwardemail');
    expect(ana.domain).toBe('acme.test');
    expect(ana.readsReplies).toBe(true);
    expect(bo.provider).toBe('custom');
    expect(bo.readsReplies).toBe(false);
    expect(bo.healthIssues.join(' ')).toContain('IMAP');
    expect(bo.healthScore).toBeLessThan(ana.healthScore);
    expect(body.summary.notReadingReplies).toBe(1);

    await recordReplyCheck(db, ana.id, 'Command failed: AUTHENTICATIONFAILED');
    body = (await (await call(app, 'GET', '/mailboxes')).json()) as typeof body;
    const failed = body.mailboxes.find((m) => m.id === ana.id)!;
    expect(failed.repliesError).toContain('AUTHENTICATIONFAILED');
    expect(failed.repliesCheckedAt! <= now()).toBe(true);
    expect(body.summary.notReadingReplies).toBe(2);

    await recordReplyCheck(db, ana.id);
    body = (await (await call(app, 'GET', '/mailboxes')).json()) as typeof body;
    expect(body.mailboxes.find((m) => m.id === ana.id)!.repliesError).toBeNull();
  });

  test('the daily blocklist sweep records a listing, alerts once, and drops health', async () => {
    const { app, db } = await harness('mailboxes-blocklist');
    await call(app, 'PUT', '/integrations/email', {
      host: 'mail.acme.test',
      port: 587,
      secure: false,
      username: 'cy@acme.test',
      password: 'pw',
      fromEmail: 'cy@acme.test',
      imapHost: 'mail.acme.test',
      skipVerification: true,
    });

    const resolve4 = async (name: string): Promise<string[]> => {
      if (name === 'acme.test.dbl.spamhaus.org') return ['127.0.1.2'];
      throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    };
    const before = (
      (await (await call(app, 'GET', '/mailboxes')).json()) as { mailboxes: MailboxJson[] }
    ).mailboxes[0]!;

    const swept = await sweepBlacklists(db, SEED.workspaceId, { deps: { resolve4 } });
    expect(swept).toEqual({ checked: 1, listed: 1 });

    const after = (
      (await (await call(app, 'GET', '/mailboxes')).json()) as {
        mailboxes: Array<MailboxJson & { blacklistedOn: string[] }>;
      }
    ).mailboxes[0]!;
    expect(after.blacklistedOn).toEqual(['Spamhaus DBL']);
    expect(after.healthIssues[0]).toContain('Spamhaus DBL');
    expect(after.healthScore).toBeLessThan(before.healthScore);

    // Checked today: the next sweep leaves it alone, so no second alert.
    expect(await sweepBlacklists(db, SEED.workspaceId, { deps: { resolve4 } })).toEqual({
      checked: 0,
      listed: 0,
    });
    const alerts = await queryAll<{ message: string }>(
      db,
      `SELECT message FROM workflow_events WHERE message LIKE '%is listed on%'`,
    );
    expect(alerts).toHaveLength(1);
  });

  test('404s the DNS report for a mailbox in another workspace', async () => {
    const { app } = await harness('mailboxes-dns-404');
    expect((await call(app, 'GET', '/mailboxes/ita_nope/dns')).status).toBe(404);
  });
});

describe('POST /mailboxes/detect', () => {
  test('knows a consumer domain without any lookup', async () => {
    const { app } = await harness('mailboxes-detect');
    const response = await call(app, 'POST', '/mailboxes/detect', { email: 'Ana@gmail.com' });
    expect(response.status).toBe(200);
    const { detected } = (await response.json()) as {
      detected: {
        provider: string;
        smtp: { host: string };
        imap: { host: string };
        source: string;
      };
    };
    expect(detected.provider).toBe('gmail');
    expect(detected.source).toBe('known');
    expect(detected.smtp.host).toBe('smtp.gmail.com');
    expect(detected.imap.host).toBe('imap.gmail.com');
  });

  test('rejects something that is not an address', async () => {
    const { app } = await harness('mailboxes-detect-bad');
    expect((await call(app, 'POST', '/mailboxes/detect', { email: 'nope' })).status).toBe(400);
  });
});
