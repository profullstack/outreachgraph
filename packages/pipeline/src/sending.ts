/**
 * Which mailer a workspace sends outreach through.
 *
 * There are now two, and they are not interchangeable:
 *
 *   - The **platform mailer** (Resend, from the container's environment) sends
 *     account mail — verification links, lead alerts, the digest. Those really
 *     are from OutreachGraph and should say so.
 *   - The **workspace mailer** (the customer's own SMTP server) sends outreach.
 *     Those are from the customer, and the whole point of connecting a server
 *     is that they no longer go out under our domain.
 *
 * The rule this module enforces is that outreach only ever uses a *verified*
 * account. Not merely a configured one: a row that was saved but never
 * successfully tested is a row full of typos, and discovering that by sending a
 * hundred messages into a rejection loop is exactly the failure the test button
 * exists to prevent. An unverified account behaves as no account at all, which
 * the policy engine already understands — `hasConnectedAccount: false` makes
 * `email/send_email` manual-only, so the work still reaches the human.
 */

import { queryOne, type Client } from '@outreachgraph/db';
import { SmtpMailer, decryptSecret, type Mailer } from '@outreachgraph/email';

export interface EmailAccountRow {
  readonly id: string;
  readonly provider: string;
  readonly host: string | null;
  readonly port: number | null;
  readonly secure: number;
  readonly username: string | null;
  readonly secret_encrypted: string | null;
  readonly allow_invalid_cert: number;
  readonly allow_insecure: number;
  readonly from_email: string;
  readonly from_name: string | null;
  readonly reply_to: string | null;
  readonly status: string;
  readonly verified_at: string | null;
  readonly last_test_at: string | null;
  readonly last_error: string | null;
}

export interface WorkspaceSender {
  readonly mailer: Mailer;
  /** The address outreach will appear to come from. */
  readonly from: string;
  /** Where replies go, when the account names somewhere specific. */
  readonly replyTo?: string;
}

export async function loadEmailAccount(
  db: Client,
  workspaceId: string,
): Promise<EmailAccountRow | undefined> {
  return (
    (await queryOne<EmailAccountRow>(db, `SELECT * FROM email_accounts WHERE workspace_id = ?`, [
      workspaceId,
    ])) ?? undefined
  );
}

/**
 * Builds the outreach mailer for one workspace, or nothing.
 *
 * Nothing is a normal, expected answer — most workspaces have not connected a
 * server — and every caller is written to keep working without it. Returning
 * `undefined` rather than falling back to the platform mailer is deliberate:
 * silently sending a customer's outreach from our domain is the behaviour this
 * whole feature exists to remove, and it is worse than not sending, because it
 * is invisible.
 */
export async function resolveWorkspaceSender(
  db: Client,
  workspaceId: string,
): Promise<WorkspaceSender | undefined> {
  const account = await loadEmailAccount(db, workspaceId);
  if (!account || account.status !== 'verified') return undefined;
  if (account.provider !== 'smtp' || !account.host || !account.port) return undefined;

  // A password that no longer decrypts means the root secret was rotated. The
  // account keeps its `verified` status — it was verified, and the credentials
  // may well still be correct — but nothing sends until someone re-enters it.
  const password = account.secret_encrypted ? decryptSecret(account.secret_encrypted) : undefined;
  if (account.secret_encrypted && !password) return undefined;

  const mailer = new SmtpMailer({
    host: account.host,
    port: account.port,
    secure: account.secure === 1,
    ...(account.username ? { username: account.username } : {}),
    ...(password ? { password } : {}),
    from: account.from_email,
    ...(account.from_name ? { fromName: account.from_name } : {}),
    ...(account.allow_invalid_cert === 1 ? { allowInvalidCertificate: true } : {}),
    ...(account.allow_insecure === 1 ? { allowInsecureAuth: true } : {}),
  });

  return {
    mailer,
    from: account.from_email,
    ...(account.reply_to ? { replyTo: account.reply_to } : {}),
  };
}
