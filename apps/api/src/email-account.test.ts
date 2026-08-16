/**
 * The connect-then-verify flow.
 *
 * The property under test throughout is the one the product depends on:
 * saving a mail server never makes it usable, only a passing test does, and
 * anything that invalidates the test takes the account back out of service.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { queryOne } from '@outreachgraph/db';
import { resolveWorkspaceSender } from '@outreachgraph/pipeline';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';
import {
  deleteEmailAccount,
  EmailAccountError,
  loadEmailAccountView,
  saveEmailAccount,
} from './email-account';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const VALID = {
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  username: 'sales@example.com',
  password: 'hunter2',
  fromEmail: 'sales@example.com',
  fromName: 'Anthony',
};

describe('saveEmailAccount', () => {
  test('stores the configuration as unverified', async () => {
    seeded = await seedDatabase('email-save');
    await saveEmailAccount(seeded.db, SEED.workspaceId, VALID);

    const view = await loadEmailAccountView(seeded.db, SEED.workspaceId);
    expect(view.configured).toBe(true);
    expect(view.status).toBe('unverified');
    expect(view.host).toBe('smtp.example.com');
  });

  test('never returns the password', async () => {
    seeded = await seedDatabase('email-secret');
    await saveEmailAccount(seeded.db, SEED.workspaceId, VALID);

    const view = await loadEmailAccountView(seeded.db, SEED.workspaceId);
    expect(view.hasPassword).toBe(true);
    expect(JSON.stringify(view)).not.toContain('hunter2');
  });

  test('encrypts the password at rest', async () => {
    seeded = await seedDatabase('email-encrypt');
    await saveEmailAccount(seeded.db, SEED.workspaceId, VALID);

    const row = await queryOne<{ secret_encrypted: string }>(
      seeded.db,
      `SELECT secret_encrypted FROM email_accounts WHERE workspace_id = ?`,
      [SEED.workspaceId],
    );

    // A database dump must not also be a mail-server credential dump.
    expect(row?.secret_encrypted).not.toContain('hunter2');
    expect(row?.secret_encrypted).toStartWith('v1.');
  });

  test('keeps the stored password when the form leaves it blank', async () => {
    // The form cannot show a password back, so it posts blank unless retyped.
    // Treating that as "clear it" would silently break sending every time
    // someone corrected a port number.
    seeded = await seedDatabase('email-keep');
    await saveEmailAccount(seeded.db, SEED.workspaceId, VALID);

    const first = await queryOne<{ secret_encrypted: string }>(
      seeded.db,
      `SELECT secret_encrypted FROM email_accounts WHERE workspace_id = ?`,
      [SEED.workspaceId],
    );

    await saveEmailAccount(seeded.db, SEED.workspaceId, {
      ...VALID,
      password: undefined,
      port: 465,
    });

    const second = await queryOne<{ secret_encrypted: string; port: number }>(
      seeded.db,
      `SELECT secret_encrypted, port FROM email_accounts WHERE workspace_id = ?`,
      [SEED.workspaceId],
    );

    expect(second?.secret_encrypted).toBe(first?.secret_encrypted ?? '');
    expect(second?.port).toBe(465);
  });

  test('an edit drops a previously verified account back to unverified', async () => {
    seeded = await seedDatabase('email-reverify');
    await saveEmailAccount(seeded.db, SEED.workspaceId, VALID);
    await seeded.db.execute(
      `UPDATE email_accounts SET status = 'verified', verified_at = '2026-01-01T00:00:00.000Z'`,
    );

    // Keeping a badge earned by a different server is exactly the state the
    // whole flow exists to prevent.
    await saveEmailAccount(seeded.db, SEED.workspaceId, { ...VALID, host: 'smtp.other.com' });

    const view = await loadEmailAccountView(seeded.db, SEED.workspaceId);
    expect(view.status).toBe('unverified');
    expect(view.verifiedAt).toBeUndefined();
  });

  test('rejects a configuration that cannot work', async () => {
    seeded = await seedDatabase('email-invalid');
    const { db } = seeded;

    await expect(saveEmailAccount(db, SEED.workspaceId, { ...VALID, host: '' })).rejects.toThrow(
      EmailAccountError,
    );
    await expect(saveEmailAccount(db, SEED.workspaceId, { ...VALID, port: 0 })).rejects.toThrow(
      EmailAccountError,
    );
    await expect(
      saveEmailAccount(db, SEED.workspaceId, { ...VALID, fromEmail: 'not-an-address' }),
    ).rejects.toThrow(EmailAccountError);
  });

  test('accepts a host pasted with its scheme still attached', async () => {
    seeded = await seedDatabase('email-scheme');
    await saveEmailAccount(seeded.db, SEED.workspaceId, {
      ...VALID,
      host: 'https://smtp.example.com/',
    });

    expect((await loadEmailAccountView(seeded.db, SEED.workspaceId)).host).toBe('smtp.example.com');
  });
});

describe('resolveWorkspaceSender', () => {
  test('refuses an account that has not been verified', async () => {
    seeded = await seedDatabase('sender-unverified');
    await saveEmailAccount(seeded.db, SEED.workspaceId, VALID);

    // This is the gate. A saved-but-untested account is full of typos, and
    // finding that out by sending a hundred messages is the failure the test
    // button exists to prevent.
    expect(await resolveWorkspaceSender(seeded.db, SEED.workspaceId)).toBeUndefined();
  });

  test('builds a mailer once the account is verified', async () => {
    seeded = await seedDatabase('sender-verified');
    await saveEmailAccount(seeded.db, SEED.workspaceId, { ...VALID, replyTo: 'me@example.com' });
    await seeded.db.execute(`UPDATE email_accounts SET status = 'verified'`);

    const sender = await resolveWorkspaceSender(seeded.db, SEED.workspaceId);
    expect(sender?.from).toBe('sales@example.com');
    expect(sender?.replyTo).toBe('me@example.com');
  });

  test('refuses when the stored password can no longer be decrypted', async () => {
    // The rotate-API_TOKEN case. It must be "re-enter your password", not a
    // crash on every worker tick, and definitely not sending with an empty one.
    seeded = await seedDatabase('sender-rotated');
    await saveEmailAccount(seeded.db, SEED.workspaceId, VALID);
    await seeded.db.execute(
      `UPDATE email_accounts SET status = 'verified', secret_encrypted = 'v1.aaaa.bbbb.cccc'`,
    );

    expect(await resolveWorkspaceSender(seeded.db, SEED.workspaceId)).toBeUndefined();
  });

  test('returns nothing for a workspace that connected no server', async () => {
    seeded = await seedDatabase('sender-none');
    expect(await resolveWorkspaceSender(seeded.db, SEED.workspaceId)).toBeUndefined();
  });
});

describe('deleteEmailAccount', () => {
  test('disconnects the server', async () => {
    seeded = await seedDatabase('email-delete');
    await saveEmailAccount(seeded.db, SEED.workspaceId, VALID);

    expect(await deleteEmailAccount(seeded.db, SEED.workspaceId)).toBe(true);
    expect((await loadEmailAccountView(seeded.db, SEED.workspaceId)).configured).toBe(false);
    expect(await deleteEmailAccount(seeded.db, SEED.workspaceId)).toBe(false);
  });
});
