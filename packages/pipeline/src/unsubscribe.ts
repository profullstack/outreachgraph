/**
 * Opt-out: the way a recipient stops the mail themselves.
 *
 * Suppression already existed, but only the sender could reach it. A prospect
 * who wanted out had no route that did not involve replying and hoping someone
 * read it — which is the definition of the thing anti-spam law exists to
 * prevent, and which the sending provider's terms require a header for.
 *
 * Two rules shape what follows:
 *
 *   - **A shared inbox unsubscribes everybody.** When `support@` says stop, it
 *     is not speaking for one of the fourteen colleagues we resolved to that
 *     address; it is speaking for the mailbox. Suppressing only the person the
 *     token was issued for would mail the other thirteen next week, which is
 *     the same complaint arriving thirteen more times.
 *   - **Acting on it is idempotent.** One-click unsubscribe (RFC 8058) means a
 *     mail client may POST the URL without a human ever seeing it, and some
 *     scanners fetch every link in a message. A second call must confirm
 *     rather than fail.
 */

import { newId } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { emitWebhookEvent } from './webhooks';

export interface IssueUnsubscribeInput {
  readonly workspaceId: string;
  readonly personId: string;
  readonly campaignId?: string;
  readonly contactAddress: string;
}

/** The public URL a recipient clicks. */
export function unsubscribeUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/u/${token}`;
}

/**
 * Mints the token for one outgoing message.
 *
 * One per send rather than one per person: the token records which message it
 * came from, so an opt-out can be traced to the mail that prompted it.
 */
export async function issueUnsubscribeToken(
  db: Client,
  input: IssueUnsubscribeInput,
): Promise<string> {
  const token = newId('unsubscribe');

  await db.execute({
    sql: `INSERT INTO unsubscribe_tokens
            (token, workspace_id, person_id, campaign_id, contact_address, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      token,
      input.workspaceId,
      input.personId,
      input.campaignId ?? null,
      input.contactAddress.trim().toLowerCase(),
      now(),
    ],
  });

  return token;
}

export interface UnsubscribeResult {
  readonly address: string;
  /** How many people were suppressed. More than one means a shared mailbox. */
  readonly peopleSuppressed: number;
  /** True when this token had already been used. */
  readonly alreadyDone: boolean;
}

/**
 * Honours an opt-out.
 *
 * Returns undefined for a token that does not exist, which the caller renders
 * as "this link is not valid" rather than as a failure — a stale link from an
 * old message is an ordinary thing to receive.
 */
export async function applyUnsubscribe(
  db: Client,
  token: string,
): Promise<UnsubscribeResult | undefined> {
  const row = await queryOne<{
    workspace_id: string;
    person_id: string;
    contact_address: string;
    used_at: string | null;
  }>(
    db,
    `SELECT workspace_id, person_id, contact_address, used_at
       FROM unsubscribe_tokens WHERE token = ?`,
    [token],
  );

  if (!row) return undefined;

  if (row.used_at) {
    return { address: row.contact_address, peopleSuppressed: 0, alreadyDone: true };
  }

  const suppressed = await suppressAddress(db, {
    workspaceId: row.workspace_id,
    personId: row.person_id,
    address: row.contact_address,
    source: 'unsubscribe',
  });

  await db.execute({
    sql: 'UPDATE unsubscribe_tokens SET used_at = ? WHERE token = ?',
    args: [now(), token],
  });

  return {
    address: row.contact_address,
    peopleSuppressed: suppressed.peopleSuppressed,
    alreadyDone: false,
  };
}

export interface SuppressAddressInput {
  readonly workspaceId: string;
  /** The person the request came from or was issued for. */
  readonly personId: string;
  /** The mailbox that asked. Everyone reachable only there is suppressed with them. */
  readonly address: string;
  /** Where the request came from, for the audit trail: a link, or a reply. */
  readonly source: 'unsubscribe' | 'reply_unsubscribe';
}

/**
 * Honours a request to stop, from wherever it arrived.
 *
 * Shared by the one-click link and by a reply that says "take me off your
 * list" — two routes to the same instruction, and a second implementation of
 * "who else shares this inbox" or "cancel what is queued" would drift from
 * this one on the first change to either.
 */
export async function suppressAddress(
  db: Client,
  input: SuppressAddressInput,
): Promise<{ readonly peopleSuppressed: number; readonly suppressionId: string }> {
  const address = input.address.trim().toLowerCase();

  // Everyone this workspace would reach at that mailbox — the person the
  // request came from, plus anyone else whose only published address is the
  // same company inbox.
  //
  // Skipped for an empty address: `lower(trim(contact_email)) = ''` would
  // match every company that stored a blank, and suppress strangers.
  const sharers = !address
    ? []
    : await queryAll<{ id: string }>(
        db,
        `SELECT DISTINCT p.id
       FROM people p
       JOIN companies co ON co.id = p.current_company_id
      WHERE lower(trim(co.contact_email)) = ?
        AND NOT EXISTS (
              SELECT 1 FROM social_identities si
               WHERE si.person_id = p.id AND si.network = 'email'
                 AND si.handle IS NOT NULL AND trim(si.handle) <> ''
            )`,
        [address],
      );

  const personIds = new Set<string>([input.personId, ...sharers.map((s) => s.id)]);
  const suppressionId = newId('suppression');
  const stamp = now();

  await db.batch([
    {
      sql: `INSERT INTO suppression_entries (id, reason, scope, workspace_id, source, created_at)
            VALUES (?, 'customer_request', 'workspace', ?, ?, ?)`,
      args: [suppressionId, input.workspaceId, input.source, stamp],
    },
    ...[...personIds].map((personId) => ({
      sql: `INSERT OR IGNORE INTO suppression_keys (match_key, suppression_id, scope, workspace_id)
            VALUES (?, ?, 'workspace', ?)`,
      args: [`person:${personId}`, suppressionId, input.workspaceId],
    })),
    // Cancel what is already queued for them. Suppression stops the next
    // decision; it does not reach back into a card that has already been
    // approved and is waiting for the sender to pick it up.
    ...[...personIds].map((personId) => ({
      sql: `UPDATE recommendations SET status = 'skipped'
             WHERE workspace_id = ? AND person_id = ? AND status IN ('pending', 'approved')`,
      args: [input.workspaceId, personId],
    })),
  ]);

  // One event per person, because a receiver keys on the person: a CRM
  // marking contacts as opted out needs each of them, not the mailbox.
  for (const personId of personIds) {
    await emitWebhookEvent(db, input.workspaceId, 'person.suppressed', {
      personId,
      reason: 'customer_request',
      source: input.source,
      suppressionId,
    });
  }

  return { peopleSuppressed: personIds.size, suppressionId };
}
