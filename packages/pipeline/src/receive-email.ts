/**
 * Noticing that somebody replied (PRD §27).
 *
 * The product could always send and never read, which is not a small gap: the
 * policy engine refuses to write to a contact who has answered, and until
 * something records the answer that gate has no input. Every reply was
 * invisible, the funnel's `replied` count was structurally zero, and the queue
 * kept offering prospects who were already mid-conversation.
 *
 * This is the reading half. It is deliberately conservative, because the two
 * ways it can be wrong are not symmetric:
 *
 *   - Missing a reply means we mail someone who answered. Embarrassing, and
 *     recoverable by recording it late.
 *   - Inventing one means we permanently stop contacting a prospect on the
 *     strength of an out-of-office. Silent, and nobody goes looking for the
 *     outreach that never happened.
 *
 * So auto-replies, bounces and bulk mail are identified and skipped rather
 * than counted, and a message that cannot be matched to anyone we wrote to is
 * left alone rather than guessed at.
 */

import { newId } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import type { MailReader, IncomingMessage } from '@outreachgraph/email';

export interface ReceiveRepliesInput {
  readonly db: Client;
  readonly workspaceId: string;
  readonly reader: MailReader;
  /** How far back to ask the mailbox for. Defaults to a week. */
  readonly since?: Date;
  /** Messages to take from one poll. */
  readonly limit?: number;
}

export interface ReceiveRepliesResult {
  readonly fetched: number;
  /** Written as inbound interactions. */
  readonly recorded: number;
  /** Recognised as machine-generated, by reason. */
  readonly automated: Readonly<Record<string, number>>;
  /** From an address we have never written to, so not ours to record. */
  readonly unmatched: number;
  /** Already recorded by an earlier poll. */
  readonly duplicates: number;
}

const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_LIMIT = 200;

/**
 * Polls one workspace's mailbox and records the replies it finds.
 *
 * Returns a report rather than throwing on a message it cannot place: one
 * unmatched sender is not a failed poll, and a tick that aborts on the first
 * newsletter would never reach the reply behind it.
 */
export async function receiveReplies(input: ReceiveRepliesInput): Promise<ReceiveRepliesResult> {
  const since = input.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const messages = await input.reader.fetchSince(since, input.limit ?? DEFAULT_LIMIT);

  const automated: Record<string, number> = {};
  let recorded = 0;
  let unmatched = 0;
  let duplicates = 0;

  for (const message of messages) {
    if (message.automated) {
      automated[message.automated] = (automated[message.automated] ?? 0) + 1;
      continue;
    }

    const person = await matchSender(input.db, input.workspaceId, message);
    if (!person) {
      unmatched += 1;
      continue;
    }

    const written = await recordReply(input.db, input.workspaceId, person, message);
    if (written) recorded += 1;
    else duplicates += 1;
  }

  return { fetched: messages.length, recorded, automated, unmatched, duplicates };
}

/**
 * Which prospect a reply belongs to.
 *
 * Matched on the address we delivered to, which is the only link we actually
 * have — we did not send a per-recipient token, and threading headers are
 * rewritten often enough by mailing software to be a weak second.
 *
 * A shared company inbox matches several people at once, and rather than
 * guess which colleague typed the reply this picks the one most recently
 * written to. That is a guess about attribution, not about the fact: the fact
 * is that this mailbox answered, and because `conversationOpen` also matches
 * on the address, recording it against any one of them protects all of them.
 * Attribution can be corrected by a human; a missed reply cannot.
 */
async function matchSender(
  db: Client,
  workspaceId: string,
  message: IncomingMessage,
): Promise<{ personId: string; address: string; shared: boolean } | undefined> {
  const row = await queryOne<{ person_id: string; contact_address: string; shared_inbox: number }>(
    db,
    `SELECT person_id, contact_address, shared_inbox FROM interactions
      WHERE workspace_id = ? AND direction = 'outbound' AND contact_address = ?
   ORDER BY occurred_at DESC LIMIT 1`,
    [workspaceId, message.fromAddress],
  );

  if (!row) return undefined;

  return {
    personId: row.person_id,
    address: row.contact_address,
    shared: row.shared_inbox === 1,
  };
}

/** Returns false when this message was already recorded by an earlier poll. */
async function recordReply(
  db: Client,
  workspaceId: string,
  person: { personId: string; address: string; shared: boolean },
  message: IncomingMessage,
): Promise<boolean> {
  if (message.messageId) {
    const existing = await queryOne<{ id: string }>(
      db,
      'SELECT id FROM interactions WHERE workspace_id = ? AND external_id = ?',
      [workspaceId, message.messageId],
    );
    if (existing) return false;
  }

  const stamp = now();

  await db.execute({
    sql: `INSERT INTO interactions (id, workspace_id, person_id, network, direction, state,
          body, contact_address, shared_inbox, external_id, occurred_at, recorded_at)
          VALUES (?, ?, ?, 'email', 'inbound', 'responded', ?, ?, ?, ?, ?, ?)`,
    args: [
      newId('interaction'),
      workspaceId,
      person.personId,
      message.subject ?? null,
      person.address,
      person.shared ? 1 : 0,
      message.messageId ?? null,
      message.receivedAt.toISOString(),
      stamp,
    ],
  });

  // The funnel reads this, and a prospect who answered sitting in `contacted`
  // is the one row a human most wants to see move.
  await db.execute({
    sql: `UPDATE campaign_people SET interaction_state = 'responded', updated_at = ?
           WHERE workspace_id = ? AND person_id = ?`,
    args: [stamp, workspaceId, person.personId],
  });

  return true;
}

/** Every workspace with a mailbox we can read. */
export async function workspacesWithReadableMailbox(db: Client): Promise<string[]> {
  const rows = await queryAll<{ workspace_id: string }>(
    db,
    `SELECT ia.workspace_id FROM integration_accounts ia
       JOIN integrations i ON i.id = ia.integration_id
      WHERE ia.network = 'email' AND ia.status = 'active'
        AND i.config_json LIKE '%"imapHost"%'`,
    [],
  );

  return rows.map((row) => row.workspace_id);
}
