/**
 * Connecting a mail server, and proving it works before anything is sent
 * through it.
 *
 * The order here is the whole point. A saved account is `unverified` and
 * `runAutopilot` refuses it; only a successful test — a real connection, a real
 * authentication, and a real message delivered to the owner's own inbox —
 * promotes it to `verified`. Any subsequent edit drops it back. That makes
 * "tested and verified to work" a property the system enforces rather than a
 * step someone is trusted to have done, and it means the first outreach message
 * a customer sends is never also the first time their SMTP settings are
 * exercised.
 */

import { newId } from '@outreachgraph/domain';
import { now, type Client } from '@outreachgraph/db';
import {
  SmtpMailer,
  canStoreSecrets,
  decryptSecret,
  encryptSecret,
  verifySmtp,
  type SmtpConfig,
} from '@outreachgraph/email';
import {
  emitEvent,
  loadEmailAccount,
  loadNotifySettings,
  notifyAddress,
} from '@outreachgraph/pipeline';

export class EmailAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailAccountError';
  }
}

export interface EmailAccountView {
  readonly configured: boolean;
  readonly provider?: string;
  readonly host?: string;
  readonly port?: number;
  readonly secure?: boolean;
  readonly username?: string;
  readonly fromEmail?: string;
  readonly fromName?: string;
  readonly replyTo?: string;
  readonly status?: string;
  readonly verifiedAt?: string;
  readonly lastTestAt?: string;
  readonly lastError?: string;
  /** True when a password is stored. The password itself never leaves here. */
  readonly hasPassword?: boolean;
  readonly allowInvalidCertificate?: boolean;
  readonly allowInsecureAuth?: boolean;
  /** False when the deployment cannot encrypt secrets, so saving is refused. */
  readonly canStore: boolean;
}

export async function loadEmailAccountView(
  db: Client,
  workspaceId: string,
): Promise<EmailAccountView> {
  const account = await loadEmailAccount(db, workspaceId);
  if (!account) return { configured: false, canStore: canStoreSecrets() };

  return {
    configured: true,
    provider: account.provider,
    ...(account.host ? { host: account.host } : {}),
    ...(account.port ? { port: account.port } : {}),
    secure: account.secure === 1,
    ...(account.username ? { username: account.username } : {}),
    fromEmail: account.from_email,
    ...(account.from_name ? { fromName: account.from_name } : {}),
    ...(account.reply_to ? { replyTo: account.reply_to } : {}),
    status: account.status,
    ...(account.verified_at ? { verifiedAt: account.verified_at } : {}),
    ...(account.last_test_at ? { lastTestAt: account.last_test_at } : {}),
    ...(account.last_error ? { lastError: account.last_error } : {}),
    hasPassword: Boolean(account.secret_encrypted),
    allowInvalidCertificate: account.allow_invalid_cert === 1,
    allowInsecureAuth: account.allow_insecure === 1,
    canStore: canStoreSecrets(),
  };
}

export interface EmailAccountInput {
  readonly host: string;
  readonly port: number;
  readonly secure?: boolean;
  readonly username?: string;
  /**
   * Omitted on an edit that is not changing the password.
   *
   * The form cannot show the stored password back, so "leave it blank to keep
   * it" is the only workable behaviour — the alternative is making people
   * retype a password every time they fix a typo in the port.
   */
  readonly password?: string;
  readonly fromEmail: string;
  readonly fromName?: string;
  readonly replyTo?: string;
  /** Accept a certificate signed by a private CA. Off unless asked for. */
  readonly allowInvalidCertificate?: boolean;
  /** Permit authentication with no TLS, for a relay on loopback. */
  readonly allowInsecureAuth?: boolean;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Saves the configuration, unverified.
 *
 * Nothing is tested here on purpose: saving must work even when the server is
 * temporarily unreachable, or a transient outage would prevent someone
 * correcting the very setting that is wrong.
 */
export async function saveEmailAccount(
  db: Client,
  workspaceId: string,
  input: EmailAccountInput,
): Promise<void> {
  if (!canStoreSecrets()) {
    throw new EmailAccountError(
      'this deployment cannot store credentials securely: set CREDENTIAL_KEY first',
    );
  }

  const host = input.host
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!host || !/^[a-z0-9.-]+$/i.test(host)) {
    throw new EmailAccountError('enter the mail server hostname, for example smtp.example.com');
  }

  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new EmailAccountError('the port must be a number, usually 587 or 465');
  }

  if (!looksLikeEmail(input.fromEmail)) {
    throw new EmailAccountError('enter the address messages should come from');
  }

  if (input.replyTo && !looksLikeEmail(input.replyTo)) {
    throw new EmailAccountError('the reply-to address does not look like an email address');
  }

  const existing = await loadEmailAccount(db, workspaceId);

  // Keep the stored password when the form did not supply a new one.
  const secret = input.password
    ? encryptSecret(input.password)
    : (existing?.secret_encrypted ?? null);

  const stamp = now();

  await db.execute({
    sql: `INSERT INTO email_accounts (id, workspace_id, provider, host, port, secure, username,
            secret_encrypted, from_email, from_name, reply_to, allow_invalid_cert,
            allow_insecure, status, created_at, updated_at)
          VALUES (?, ?, 'smtp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE SET
            provider = 'smtp',
            host = excluded.host,
            port = excluded.port,
            secure = excluded.secure,
            username = excluded.username,
            secret_encrypted = excluded.secret_encrypted,
            from_email = excluded.from_email,
            from_name = excluded.from_name,
            reply_to = excluded.reply_to,
            allow_invalid_cert = excluded.allow_invalid_cert,
            allow_insecure = excluded.allow_insecure,
            -- Any change invalidates the previous test. Editing the host and
            -- keeping a 'verified' badge earned by a different server is
            -- exactly the state this whole flow exists to prevent.
            status = 'unverified',
            verified_at = NULL,
            last_error = NULL,
            updated_at = excluded.updated_at`,
    args: [
      existing?.id ?? newId('emailAccount'),
      workspaceId,
      host,
      input.port,
      input.secure ? 1 : 0,
      input.username?.trim() || null,
      secret,
      input.fromEmail.trim(),
      input.fromName?.trim() || null,
      input.replyTo?.trim() || null,
      input.allowInvalidCertificate ? 1 : 0,
      input.allowInsecureAuth ? 1 : 0,
      stamp,
      stamp,
    ],
  });

  await emitEvent(db, {
    workspaceId,
    phase: 'system',
    message: `Mail server settings saved for ${host} — not yet verified`,
    detail: { host, port: input.port },
  });
}

export interface EmailTestResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly encrypted?: boolean;
  readonly authenticated?: boolean;
  readonly greeting?: string;
  /** Where the test message went, when one was sent. */
  readonly sentTo?: string;
}

/**
 * Connects, authenticates, and sends one real message.
 *
 * Both halves matter. `verifySmtp` proves the credentials are right; it cannot
 * prove the server will accept mail *from* this sender, which is a separate and
 * very common failure — a relay that authenticates fine and then rejects
 * `MAIL FROM` for an address the account is not allowed to use. Only after a
 * message has actually been accepted for delivery is the account marked
 * verified.
 */
export async function testEmailAccount(
  db: Client,
  workspaceId: string,
  recipient: string,
): Promise<EmailTestResult> {
  const account = await loadEmailAccount(db, workspaceId);
  if (!account) throw new EmailAccountError('no mail server is configured yet');
  if (!account.host || !account.port)
    throw new EmailAccountError('the configuration is incomplete');

  if (!looksLikeEmail(recipient)) {
    throw new EmailAccountError('a test needs somewhere to send to');
  }

  const password = account.secret_encrypted ? decryptSecret(account.secret_encrypted) : undefined;

  if (account.secret_encrypted && !password) {
    const message = 'the stored password could not be read — enter it again';
    await recordTest(db, workspaceId, account.id, false, message);
    return { ok: false, error: message };
  }

  const config: SmtpConfig = {
    host: account.host,
    port: account.port,
    secure: account.secure === 1,
    ...(account.username ? { username: account.username } : {}),
    ...(password ? { password } : {}),
    from: account.from_email,
    ...(account.from_name ? { fromName: account.from_name } : {}),
    ...(account.allow_invalid_cert === 1 ? { allowInvalidCertificate: true } : {}),
    ...(account.allow_insecure === 1 ? { allowInsecureAuth: true } : {}),
  };

  const handshake = await verifySmtp(config);
  if (!handshake.ok) {
    await recordTest(db, workspaceId, account.id, false, handshake.error ?? 'the test failed');
    return { ok: false, ...(handshake.error ? { error: handshake.error } : {}) };
  }

  try {
    await new SmtpMailer(config).send({
      to: recipient,
      subject: 'OutreachGraph can send from your mail server',
      text: [
        'This is the test message.',
        '',
        `It was sent through ${account.host}:${account.port} as ${account.from_email}.`,
        'Outreach from your campaigns will now go out the same way — your domain,',
        'your envelope, and replies straight back to you.',
      ].join('\n'),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordTest(db, workspaceId, account.id, false, message);
    return { ok: false, error: message };
  }

  await recordTest(db, workspaceId, account.id, true);

  return {
    ok: true,
    sentTo: recipient,
    ...(handshake.encrypted === undefined ? {} : { encrypted: handshake.encrypted }),
    ...(handshake.authenticated === undefined ? {} : { authenticated: handshake.authenticated }),
    ...(handshake.greeting ? { greeting: handshake.greeting } : {}),
  };
}

async function recordTest(
  db: Client,
  workspaceId: string,
  accountId: string,
  ok: boolean,
  error?: string,
): Promise<void> {
  const stamp = now();

  await db.execute({
    sql: `UPDATE email_accounts
             SET status = ?, verified_at = ?, last_test_at = ?, last_error = ?, updated_at = ?
           WHERE id = ?`,
    args: [
      ok ? 'verified' : 'failed',
      ok ? stamp : null,
      stamp,
      ok ? null : (error ?? 'the test failed').slice(0, 500),
      stamp,
      accountId,
    ],
  });

  await emitEvent(db, {
    workspaceId,
    phase: 'system',
    level: ok ? 'success' : 'error',
    message: ok
      ? 'Mail server verified — outreach will now send from your own server'
      : `Mail server test failed: ${(error ?? '').slice(0, 200)}`,
    detail: ok ? {} : { error: (error ?? '').slice(0, 500) },
  });
}

export async function deleteEmailAccount(db: Client, workspaceId: string): Promise<boolean> {
  const result = await db.execute({
    sql: `DELETE FROM email_accounts WHERE workspace_id = ?`,
    args: [workspaceId],
  });

  if (result.rowsAffected > 0) {
    await emitEvent(db, {
      workspaceId,
      phase: 'system',
      level: 'warn',
      message: 'Mail server disconnected — outreach will stop until another is connected',
    });
  }

  return result.rowsAffected > 0;
}

/**
 * The address a test should default to.
 *
 * Reuses the notification resolver rather than repeating the owner lookup, so
 * the test message lands wherever alerts already land — which is the inbox the
 * person configuring this is most likely to be watching.
 */
export async function ownerAddress(db: Client, workspaceId: string): Promise<string | undefined> {
  return notifyAddress(db, workspaceId, await loadNotifySettings(db, workspaceId));
}
