import { afterEach, describe, expect, test } from 'bun:test';
import { queryOne, type Client } from '@outreachgraph/db';
import { generateSecretKey, parseSecretKey } from '@outreachgraph/secrets';
import type { Mailer, Message, SendResult } from '@outreachgraph/email';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import {
  connectEmailAccount,
  disconnectEmailAccount,
  emailAccountSummary,
  loadEmailCredentials,
  mailerForWorkspace,
  EmailAccountError,
  type EmailAccountInput,
} from './email-account';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const KEY = parseSecretKey(generateSecretKey());

const ACCOUNT: EmailAccountInput = {
  host: 'smtp.fastmail.com',
  port: 465,
  secure: true,
  username: 'user@company.com',
  password: 'app-password-1234',
  fromEmail: 'user@company.com',
  fromName: 'Jane at Company',
};

/** Stands in for a real SMTP server that accepts the credentials. */
function accepting(): { calls: number; mailerFor: () => { verify(): Promise<void> } } {
  const state = { calls: 0, mailerFor: () => ({ verify: async () => void (state.calls += 1) }) };
  return state;
}

function rejecting(message: string): () => { verify(): Promise<void> } {
  return () => ({
    verify: async () => {
      throw new Error(message);
    },
  });
}

async function connect(db: Client, overrides: Partial<EmailAccountInput> = {}) {
  return connectEmailAccount(db, {
    workspaceId: SEED.workspaceId,
    account: { ...ACCOUNT, ...overrides },
    encryptionKey: KEY,
    mailerFor: accepting().mailerFor,
  });
}

describe('connectEmailAccount', () => {
  test('stores the mailbox and makes the workspace count as connected', async () => {
    seeded = await seedDatabase('email-account-connect');
    const { db } = seeded;

    const summary = await connect(db);
    expect(summary.connected).toBe(true);
    expect(summary.fromEmail).toBe('user@company.com');

    // The whole point: `hasConnectedAccount` reads this table, and until now
    // nothing could write to it, so email was permanently `manual_only`.
    const account = await queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM integration_accounts
        WHERE workspace_id = ? AND network = 'email' AND status = 'active'`,
      [SEED.workspaceId],
    );
    expect(account?.n).toBe(1);
  });

  test('the password is encrypted in the column, not stored as typed', async () => {
    seeded = await seedDatabase('email-account-encrypted');
    const { db } = seeded;

    await connect(db);

    const row = await queryOne<{ access_token_enc: string }>(
      db,
      `SELECT access_token_enc FROM integration_accounts WHERE workspace_id = ?`,
      [SEED.workspaceId],
    );

    expect(row?.access_token_enc).toBeTruthy();
    expect(row?.access_token_enc).not.toContain('app-password-1234');
  });

  test('verifies the credentials before storing them', async () => {
    seeded = await seedDatabase('email-account-verify');
    const { db } = seeded;

    const server = accepting();
    await connectEmailAccount(db, {
      workspaceId: SEED.workspaceId,
      account: ACCOUNT,
      encryptionKey: KEY,
      mailerFor: server.mailerFor,
    });

    expect(server.calls).toBe(1);
  });

  test('a rejected password is not stored at all', async () => {
    seeded = await seedDatabase('email-account-rejected');
    const { db } = seeded;

    // Storing first and verifying later produces a workspace that looks
    // connected, passes the policy gate, and fails on its first real prospect.
    await expect(
      connectEmailAccount(db, {
        workspaceId: SEED.workspaceId,
        account: ACCOUNT,
        encryptionKey: KEY,
        mailerFor: rejecting('535 Username and Password not accepted'),
      }),
    ).rejects.toThrow(EmailAccountError);

    const row = await queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM integration_accounts WHERE workspace_id = ? AND network = 'email'`,
      [SEED.workspaceId],
    );
    expect(row?.n).toBe(0);
  });

  test("keeps the mail server's own words, which are the actionable part", async () => {
    seeded = await seedDatabase('email-account-reason');
    const { db } = seeded;

    const thrown = await connectEmailAccount(db, {
      workspaceId: SEED.workspaceId,
      account: ACCOUNT,
      encryptionKey: KEY,
      mailerFor: rejecting('535 Username and Password not accepted'),
    })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(EmailAccountError);
    const error = thrown as EmailAccountError;
    expect(error.code).toBe('verification_failed');
    expect(error.message).toContain('535');
  });

  test('refuses to store anything when no encryption key is configured', async () => {
    seeded = await seedDatabase('email-account-nokey');
    const { db } = seeded;

    const thrown = await connectEmailAccount(db, {
      workspaceId: SEED.workspaceId,
      account: ACCOUNT,
      encryptionKey: undefined,
      mailerFor: accepting().mailerFor,
    })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(EmailAccountError);
    expect((thrown as EmailAccountError).code).toBe('not_configured');
  });

  test('reconnecting replaces the credential rather than leaving the old one', async () => {
    seeded = await seedDatabase('email-account-reconnect');
    const { db } = seeded;

    await connect(db);
    await connect(db, { password: 'a-new-app-password', fromEmail: 'sales@company.com' });

    const rows = await queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM integration_accounts WHERE workspace_id = ? AND network = 'email'`,
      [SEED.workspaceId],
    );
    expect(rows?.n).toBe(1);

    const credentials = await loadEmailCredentials(db, SEED.workspaceId, KEY);
    expect(credentials?.password).toBe('a-new-app-password');
    expect(credentials?.fromEmail).toBe('sales@company.com');
  });
});

describe('emailAccountSummary', () => {
  test('never includes the password', async () => {
    seeded = await seedDatabase('email-account-summary');
    const { db } = seeded;

    await connect(db);
    const summary = await emailAccountSummary(db, SEED.workspaceId);

    expect(JSON.stringify(summary)).not.toContain('app-password-1234');
    expect(summary.host).toBe('smtp.fastmail.com');
    expect(summary.connected).toBe(true);
  });

  test('reports not connected for a workspace with no mailbox', async () => {
    seeded = await seedDatabase('email-account-none');
    const summary = await emailAccountSummary(seeded.db, SEED.workspaceId);
    expect(summary).toEqual({ connected: false });
  });
});

describe('loadEmailCredentials', () => {
  test('decrypts what was stored', async () => {
    seeded = await seedDatabase('email-account-load');
    const { db } = seeded;

    await connect(db);
    const credentials = await loadEmailCredentials(db, SEED.workspaceId, KEY);

    expect(credentials?.host).toBe('smtp.fastmail.com');
    expect(credentials?.port).toBe(465);
    expect(credentials?.secure).toBe(true);
    expect(credentials?.password).toBe('app-password-1234');
  });

  test('a changed encryption key reads as disconnected rather than throwing', async () => {
    seeded = await seedDatabase('email-account-wrongkey');
    const { db } = seeded;

    await connect(db);

    // Rotating the key must not take down every send in the workspace. The
    // honest outcome is "reconnect your mailbox".
    const other = parseSecretKey(generateSecretKey());
    expect(await loadEmailCredentials(db, SEED.workspaceId, other)).toBeUndefined();
  });

  test('no key configured reads as disconnected', async () => {
    seeded = await seedDatabase('email-account-nokey-load');
    const { db } = seeded;

    await connect(db);
    expect(await loadEmailCredentials(db, SEED.workspaceId, undefined)).toBeUndefined();
  });
});

describe('mailerForWorkspace', () => {
  const platform: Mailer = {
    send: async (_message: Message): Promise<SendResult> => ({ id: 'platform_1' }),
  };

  test("prefers the workspace's own mailbox", async () => {
    seeded = await seedDatabase('email-account-mailer-own');
    const { db } = seeded;

    await connect(db);
    const sender = await mailerForWorkspace(db, SEED.workspaceId, {
      encryptionKey: KEY,
      fallback: platform,
    });

    expect(sender?.ownMailbox).toBe(true);
  });

  test('falls back to the platform sender when none is connected', async () => {
    seeded = await seedDatabase('email-account-mailer-fallback');
    const sender = await mailerForWorkspace(seeded.db, SEED.workspaceId, {
      encryptionKey: KEY,
      fallback: platform,
    });

    expect(sender?.ownMailbox).toBe(false);
    expect(sender?.mailer).toBe(platform);
  });

  test('is undefined when there is neither', async () => {
    seeded = await seedDatabase('email-account-mailer-none');
    const sender = await mailerForWorkspace(seeded.db, SEED.workspaceId, {
      encryptionKey: KEY,
      fallback: undefined,
    });

    expect(sender).toBeUndefined();
  });

  test('carries the reply-to the customer configured', async () => {
    seeded = await seedDatabase('email-account-mailer-replyto');
    const { db } = seeded;

    await connect(db, { replyTo: 'inbox@company.com' });
    const sender = await mailerForWorkspace(db, SEED.workspaceId, {
      encryptionKey: KEY,
      fallback: platform,
    });

    expect(sender?.replyTo).toBe('inbox@company.com');
  });
});

describe('disconnectEmailAccount', () => {
  test('removes the credential and the configuration', async () => {
    seeded = await seedDatabase('email-account-disconnect');
    const { db } = seeded;

    await connect(db);
    expect(await disconnectEmailAccount(db, SEED.workspaceId)).toBe(true);

    const summary = await emailAccountSummary(db, SEED.workspaceId);
    expect(summary.connected).toBe(false);

    // Keeping the ciphertext after the customer asked us to forget it serves
    // nobody.
    const row = await queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM integration_accounts WHERE workspace_id = ? AND network = 'email'`,
      [SEED.workspaceId],
    );
    expect(row?.n).toBe(0);
  });

  test('is a no-op when nothing is connected', async () => {
    seeded = await seedDatabase('email-account-disconnect-none');
    expect(await disconnectEmailAccount(seeded.db, SEED.workspaceId)).toBe(false);
  });
});
