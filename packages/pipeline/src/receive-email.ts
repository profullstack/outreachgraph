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
 * So auto-replies, bounces and bulk mail are identified and never counted as
 * a reply, and a message that cannot be matched to anyone we wrote to is left
 * alone rather than guessed at.
 *
 * "Never counted" used to mean "never written down", which kept the gate
 * honest and left the inbox blind: a bounce was the one thing that explained
 * why a prospect never answered, and it vanished. Absence notices and bounces
 * that belong to a thread are now recorded as `direction = 'automated'` — a
 * direction no reply-counting reader looks at, so the policy gate, the funnel
 * and every cadence's stop-on-reply see exactly what they saw before. Bulk mail
 * is still dropped; a newsletter is nobody's conversation.
 *
 * A human reply is recorded with its words now, not only its subject, and a
 * `triage_reply` job is queued for it: labelling, a possible suppression, and
 * a drafted answer all happen there, off the polling path.
 */

import { classifyReplyByRules, newId, type ReplyClassification } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import type { MailReader, IncomingMessage } from '@outreachgraph/email';
import { enqueue } from './queue';
import { recordStatus } from './stages';

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
  /** Absence notices and bounces written to a thread, never counted as replies. */
  readonly automatedRecorded: number;
  /** Replies queued for triage (labelling and a drafted answer). */
  readonly triageQueued: number;
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
  let automatedRecorded = 0;
  let triageQueued = 0;

  for (const message of messages) {
    if (message.automated === 'bulk') {
      automated.bulk = (automated.bulk ?? 0) + 1;
      continue;
    }

    // The deterministic pass runs here, on the polling path, because its
    // answer decides whether this is a reply at all. The headers settle most
    // robots; the subject and body settle the ones that forgot to set them —
    // an out-of-office recorded as a reply stops outreach for good.
    const ruled = classifyReplyByRules({
      subject: message.subject,
      body: message.bodyText,
      automated: message.automated,
    });

    const machine =
      message.automated === 'auto_reply' || message.automated === 'bounce'
        ? message.automated
        : ruled?.label === 'bounce'
          ? 'bounce'
          : ruled?.label === 'out_of_office'
            ? 'auto_reply'
            : undefined;

    if (machine) {
      automated[machine] = (automated[machine] ?? 0) + 1;

      // A bounce comes from the mailer daemon, which we never wrote to; the
      // report names who it was about, and that is the thread it belongs to.
      const person = await matchSender(
        input.db,
        input.workspaceId,
        machine === 'bounce' && message.failedRecipient
          ? message.failedRecipient
          : message.fromAddress,
      );
      if (!person) continue;

      const label: ReplyClassification =
        ruled ??
        ({
          label: machine === 'bounce' ? 'bounce' : 'out_of_office',
          confidence: 1,
          source: 'rule',
          reason: 'the mail headers identify it',
        } satisfies ReplyClassification);

      const written = await recordAutomated(input.db, input.workspaceId, person, message, label);
      if (written) automatedRecorded += 1;
      continue;
    }

    const person = await matchSender(input.db, input.workspaceId, message.fromAddress);
    if (!person) {
      unmatched += 1;
      continue;
    }

    const interactionId = await recordReply(input.db, input.workspaceId, person, message, ruled);
    if (!interactionId) {
      duplicates += 1;
      continue;
    }

    recorded += 1;
    const queued = await queueTriage(input.db, input.workspaceId, interactionId);
    if (queued) triageQueued += 1;
  }

  return {
    fetched: messages.length,
    recorded,
    automated,
    unmatched,
    duplicates,
    automatedRecorded,
    triageQueued,
  };
}

/**
 * Queues the labelling and answering of one recorded reply.
 *
 * Keyed on the interaction so a retried poll, or the manual "they replied"
 * route recording the same message, cannot triage it twice.
 */
export async function queueTriage(
  db: Client,
  workspaceId: string,
  interactionId: string,
): Promise<boolean> {
  const result = await enqueue(db, {
    workspaceId,
    kind: 'triage_reply',
    payload: { interactionId },
    dedupeKey: `triage_reply_${interactionId}`,
  });
  return result.queued;
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
  fromAddress: string,
): Promise<MatchedSender | undefined> {
  const row = await queryOne<{
    person_id: string;
    campaign_id: string | null;
    contact_address: string;
    shared_inbox: number;
  }>(
    db,
    `SELECT person_id, campaign_id, contact_address, shared_inbox FROM interactions
      WHERE workspace_id = ? AND direction = 'outbound' AND contact_address = ?
   ORDER BY occurred_at DESC LIMIT 1`,
    [workspaceId, fromAddress.trim().toLowerCase()],
  );

  if (!row) return undefined;

  return {
    personId: row.person_id,
    campaignId: row.campaign_id,
    address: row.contact_address,
    shared: row.shared_inbox === 1,
  };
}

interface MatchedSender {
  readonly personId: string;
  /** The campaign that last wrote to them, which is the one whose rules answer. */
  readonly campaignId: string | null;
  readonly address: string;
  readonly shared: boolean;
}

/** Whether this message was already recorded by an earlier poll. */
async function alreadyRecorded(
  db: Client,
  workspaceId: string,
  message: IncomingMessage,
): Promise<boolean> {
  if (!message.messageId) return false;
  const existing = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM interactions WHERE workspace_id = ? AND external_id = ?',
    [workspaceId, message.messageId],
  );
  return existing !== undefined;
}

/**
 * Writes an absence notice or a bounce to the thread it belongs to.
 *
 * `direction = 'automated'`, and nothing else: no funnel move, no
 * `interaction_state`, no triage. Those are the three things a real reply
 * does, and a robot must do none of them.
 */
async function recordAutomated(
  db: Client,
  workspaceId: string,
  person: MatchedSender,
  message: IncomingMessage,
  label: ReplyClassification,
): Promise<boolean> {
  if (await alreadyRecorded(db, workspaceId, message)) return false;

  const stamp = now();
  await db.execute({
    sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network, direction,
          state, body, subject, contact_address, shared_inbox, external_id, reply_label,
          reply_confidence, reply_label_source, reply_label_reason, labelled_at,
          occurred_at, recorded_at)
          VALUES (?, ?, ?, ?, 'email', 'automated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId('interaction'),
      workspaceId,
      person.personId,
      person.campaignId,
      label.label === 'bounce' ? 'bounced' : 'auto_replied',
      message.bodyText?.slice(0, 20_000) ?? message.subject ?? null,
      message.subject ?? null,
      person.address,
      person.shared ? 1 : 0,
      message.messageId ?? null,
      label.label,
      label.confidence,
      label.source,
      label.reason,
      stamp,
      message.receivedAt.toISOString(),
      stamp,
    ],
  });
  return true;
}

/** Returns the new interaction's id, or undefined when an earlier poll recorded it. */
async function recordReply(
  db: Client,
  workspaceId: string,
  person: MatchedSender,
  message: IncomingMessage,
  ruled: ReplyClassification | undefined,
): Promise<string | undefined> {
  if (await alreadyRecorded(db, workspaceId, message)) return undefined;

  const stamp = now();
  const interactionId = newId('interaction');

  // The words when the reader fetched them, the subject when it did not —
  // which is what this column held before bodies were read at all.
  await db.execute({
    sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network, direction,
          state, body, subject, references_header, contact_address, shared_inbox, external_id,
          reply_label, reply_confidence, reply_label_source, reply_label_reason, labelled_at,
          occurred_at, recorded_at)
          VALUES (?, ?, ?, ?, 'email', 'inbound', 'responded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      interactionId,
      workspaceId,
      person.personId,
      person.campaignId,
      message.bodyText?.slice(0, 20_000) ?? message.subject ?? null,
      message.subject ?? null,
      message.references ?? null,
      person.address,
      person.shared ? 1 : 0,
      message.messageId ?? null,
      ruled?.label ?? null,
      ruled?.confidence ?? null,
      ruled?.source ?? null,
      ruled?.reason ?? null,
      ruled ? stamp : null,
      message.receivedAt.toISOString(),
      stamp,
    ],
  });

  await db.execute({
    sql: `UPDATE campaign_people SET interaction_state = 'responded', updated_at = ?
           WHERE workspace_id = ? AND person_id = ?`,
    args: [stamp, workspaceId, person.personId],
  });

  // `interaction_state` alone is not enough. The funnel is built from
  // `campaign_people.status` and the `lead_stage_events` log, so setting only
  // the former would record the reply everywhere except the chart that exists
  // to show replies — the prospect would sit in "Contacted" having answered.
  //
  // Per campaign, because a person can be in more than one and the reply is
  // news for every campaign that wrote to them.
  const memberships = await queryAll<{ campaign_id: string }>(
    db,
    'SELECT campaign_id FROM campaign_people WHERE workspace_id = ? AND person_id = ?',
    [workspaceId, person.personId],
  );

  for (const membership of memberships) {
    await recordStatus(db, {
      workspaceId,
      campaignId: membership.campaign_id,
      personId: person.personId,
      status: 'responded',
      reason: 'They replied by email.',
      at: stamp,
    });
  }

  return interactionId;
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
