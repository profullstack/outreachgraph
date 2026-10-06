/**
 * The warm-up network: opted-in mailboxes write to each other, and each
 * recipient rescues, reads, files and sometimes answers what it gets.
 *
 * The network spans workspaces, the way Instantly's and Swokei's do: a
 * workspace with one mailbox has no one to warm up with on its own. A member
 * learns another member's address only by receiving its mail, and the mail
 * says nothing about either workspace.
 *
 * Two passes, both run from the worker tick:
 *
 *   - `runWarmupSends`: each member sends its next message when one is due
 *     (`warmupSendDue`), to the peer it has written to least today.
 *   - `runWarmupInbox`: each member's inbox and spam folder are swept for
 *     warm-up mail; each message is recorded with where it landed, and some
 *     are answered in the same thread.
 *
 * None of it touches outreach: warm-up mail is not an action, never counts
 * against a mailbox's outreach cap, and the reply poller skips it by header.
 */

import {
  composeWarmup,
  composeWarmupReply,
  newId,
  newWarmupTag,
  pickWarmupPeer,
  warmupNetworkDay,
  warmupNetworkTarget,
  warmupSendDue,
  warmupShouldReply,
  WARMUP_HEADER,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  ImapWarmupSweeper,
  SmtpMailer,
  type ImapCredentials,
  type Mailer,
  type SmtpCredentials,
  type WarmupSweeper,
} from '@outreachgraph/email';
import { loadEmailCredentials, loadImapCredentials } from './email-account';

/** How far back the sweeper looks. Mail older than this is left alone. */
const SWEEP_LOOKBACK_MS = 3 * 86_400_000;

export interface WarmupDeps {
  readonly encryptionKey: Buffer | undefined;
  readonly at?: Date;
  readonly random?: () => number;
  /** Injected by tests so no socket is opened. */
  readonly mailerFor?: (credentials: SmtpCredentials) => Mailer & { close?(): void };
  readonly sweeperFor?: (credentials: ImapCredentials) => WarmupSweeper;
}

interface MemberRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly handle: string | null;
  readonly config_json: string | null;
  readonly warmup_tag: string | null;
  readonly warmup_network_started_at: string | null;
}

interface Member {
  readonly id: string;
  readonly workspaceId: string;
  readonly email: string;
  readonly name: string | null;
  readonly tag: string;
  readonly startedAt: string;
}

/** Active mailboxes in the network that can be read (a member must receive). */
async function members(db: Client): Promise<Member[]> {
  const rows = await queryAll<MemberRow>(
    db,
    `SELECT id, workspace_id, handle, config_json, warmup_tag, warmup_network_started_at
       FROM integration_accounts
      WHERE network = 'email' AND status = 'active' AND warmup_network = 1
      ORDER BY id`,
    [],
  );
  return rows.flatMap((row) => {
    const config = parse(row.config_json);
    const email = (config.fromEmail as string | undefined) ?? row.handle;
    if (!email || !config.imapHost || !row.warmup_tag) return [];
    return [
      {
        id: row.id,
        workspaceId: row.workspace_id,
        email,
        name: typeof config.fromName === 'string' ? config.fromName : null,
        tag: row.warmup_tag,
        startedAt: row.warmup_network_started_at ?? now(),
      },
    ];
  });
}

/**
 * Switches a mailbox in or out of the network. Joining gives it a filter tag
 * (kept if it ever had one, so a filter the owner made keeps working) and
 * restarts the volume ramp.
 */
export async function setWarmupNetwork(
  db: Client,
  accountId: string,
  enabled: boolean,
  random: () => number = Math.random,
): Promise<void> {
  if (!enabled) {
    await db.execute({
      sql: `UPDATE integration_accounts SET warmup_network = 0 WHERE id = ?`,
      args: [accountId],
    });
    return;
  }
  const existing = await queryOne<{ warmup_tag: string | null; warmup_network: number }>(
    db,
    `SELECT warmup_tag, warmup_network FROM integration_accounts WHERE id = ?`,
    [accountId],
  );
  if (!existing) return;
  if (Number(existing.warmup_network) === 1) return;
  await db.execute({
    sql: `UPDATE integration_accounts
             SET warmup_network = 1,
                 warmup_tag = COALESCE(warmup_tag, ?),
                 warmup_network_started_at = ?
           WHERE id = ?`,
    args: [newWarmupTag(random), now(), accountId],
  });
}

// ------------------------------------------------------------------ sending

export interface WarmupSendResult {
  readonly sent: number;
  readonly failed: number;
  /** Members with no peer to write to: the network needs a second mailbox. */
  readonly alone: number;
}

export async function runWarmupSends(db: Client, deps: WarmupDeps): Promise<WarmupSendResult> {
  const at = deps.at ?? new Date();
  const random = deps.random ?? Math.random;
  const network = await members(db);
  let sent = 0;
  let failed = 0;
  let alone = 0;
  if (!deps.encryptionKey || network.length === 0) return { sent, failed, alone };

  const dayStart = startOfDay(at);

  for (const member of network) {
    const today = await queryOne<{ n: number; last: string | null }>(
      db,
      `SELECT COUNT(*) AS n, MAX(sent_at) AS last FROM warmup_messages
        WHERE sender_account_id = ? AND sent_at >= ?`,
      [member.id, dayStart],
    );
    const target = warmupNetworkTarget(warmupNetworkDay(member.startedAt, at));
    if (
      !warmupSendDue({
        sentToday: Number(today?.n ?? 0),
        target,
        lastSentAt: today?.last ?? null,
        at,
        random: random(),
      })
    ) {
      continue;
    }

    const counts = await queryAll<{ id: string; n: number }>(
      db,
      `SELECT recipient_account_id AS id, COUNT(*) AS n FROM warmup_messages
        WHERE sender_account_id = ? AND sent_at >= ? GROUP BY recipient_account_id`,
      [member.id, dayStart],
    );
    const byPeer = new Map(counts.map((row) => [row.id, Number(row.n)]));
    const peer = pickWarmupPeer(
      member,
      network.map((m) => ({ id: m.id, email: m.email, sentToPeerToday: byPeer.get(m.id) ?? 0 })),
      random(),
    );
    if (!peer) {
      alone += 1;
      continue;
    }
    const recipient = network.find((m) => m.id === peer.id)!;

    const content = composeWarmup({
      recipientName: recipient.name,
      senderName: member.name,
      recipientTag: recipient.tag,
      random,
    });
    const token = newId('warmupToken');
    const ok = await deliver(db, deps, member, recipient, {
      ...content,
      token,
      threadToken: token,
      depth: 0,
      kind: 'send',
      at,
    });
    if (ok) sent += 1;
    else failed += 1;
  }

  return { sent, failed, alone };
}

async function deliver(
  db: Client,
  deps: WarmupDeps,
  from: Member,
  to: Member,
  message: {
    readonly subject: string;
    readonly text: string;
    readonly token: string;
    readonly threadToken: string;
    readonly depth: number;
    readonly kind: 'send' | 'reply';
    readonly at: Date;
    readonly inReplyTo?: string | undefined;
  },
): Promise<boolean> {
  const credentials = await loadEmailCredentials(db, from.workspaceId, deps.encryptionKey, from.id);
  if (!credentials) return false;
  const mailer = deps.mailerFor?.(credentials) ?? new SmtpMailer(credentials);

  try {
    const result = await mailer.send({
      to: to.email,
      subject: message.subject,
      text: message.text,
      headers: {
        [WARMUP_HEADER]: message.token,
        ...(message.inReplyTo
          ? { 'In-Reply-To': message.inReplyTo, References: message.inReplyTo }
          : {}),
      },
    });
    await db.execute({
      sql: `INSERT INTO warmup_messages (id, sender_account_id, recipient_account_id, kind, token,
              thread_token, depth, message_id, subject, sent_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId('warmupMessage'),
        from.id,
        to.id,
        message.kind,
        message.token,
        message.threadToken,
        message.depth,
        result.id ?? null,
        message.subject,
        message.at.toISOString(),
      ],
    });
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`warm-up send ${from.id} -> ${to.id} failed: ${detail.slice(0, 300)}`);
    // Recorded like a send, so the pacing that spaces sends hours apart also
    // spaces the retries: a provider that refuses the mailbox is not asked
    // again every minute. `kind = 'failed'` keeps it out of every count shown
    // as sent, and its text is what the Mailboxes page shows as the error.
    await db
      .execute({
        sql: `INSERT INTO warmup_messages (id, sender_account_id, recipient_account_id, kind,
                token, thread_token, depth, subject, sent_at)
              VALUES (?, ?, ?, 'failed', ?, ?, ?, ?, ?)`,
        args: [
          newId('warmupMessage'),
          from.id,
          to.id,
          message.token,
          message.threadToken,
          message.depth,
          detail.slice(0, 500),
          message.at.toISOString(),
        ],
      })
      .catch(() => undefined);
    return false;
  } finally {
    if (mailer instanceof SmtpMailer) mailer.close();
    else mailer.close?.();
  }
}

// ------------------------------------------------------------------ receiving

export interface WarmupInboxResult {
  readonly seen: number;
  readonly rescued: number;
  readonly replied: number;
  readonly failed: number;
}

interface SentRow {
  readonly id: string;
  readonly sender_account_id: string;
  readonly thread_token: string;
  readonly depth: number;
  readonly message_id: string | null;
  readonly subject: string;
  readonly seen_at: string | null;
}

export async function runWarmupInbox(db: Client, deps: WarmupDeps): Promise<WarmupInboxResult> {
  const at = deps.at ?? new Date();
  const random = deps.random ?? Math.random;
  let seen = 0;
  let rescued = 0;
  let replied = 0;
  let failed = 0;
  if (!deps.encryptionKey) return { seen, rescued, replied, failed };

  const network = await members(db);
  const dayStart = startOfDay(at);

  for (const member of network) {
    const credentials = await loadImapCredentials(
      db,
      member.workspaceId,
      deps.encryptionKey,
      member.id,
    );
    if (!credentials) continue;

    let swept;
    try {
      const sweeper = deps.sweeperFor?.(credentials) ?? new ImapWarmupSweeper(credentials);
      swept = await sweeper.sweep(new Date(at.getTime() - SWEEP_LOOKBACK_MS));
    } catch (error) {
      failed += 1;
      console.error(`warm-up sweep ${member.id} failed`, error);
      continue;
    }

    for (const found of swept) {
      const row = await queryOne<SentRow>(
        db,
        `SELECT id, sender_account_id, thread_token, depth, message_id, subject, seen_at
           FROM warmup_messages WHERE token = ? AND recipient_account_id = ?`,
        [found.token, member.id],
      );
      if (!row || row.seen_at) continue;

      await db.execute({
        sql: `UPDATE warmup_messages SET seen_at = ?, landed = ? WHERE id = ?`,
        args: [at.toISOString(), found.landed, row.id],
      });
      seen += 1;
      if (found.landed === 'spam') rescued += 1;

      if (!warmupShouldReply(Number(row.depth), random())) continue;
      const sender = network.find((m) => m.id === row.sender_account_id);
      if (!sender) continue;

      // Replies count against the replier's day like any other warm-up send.
      const today = await queryOne<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM warmup_messages WHERE sender_account_id = ? AND sent_at >= ?`,
        [member.id, dayStart],
      );
      const target = warmupNetworkTarget(warmupNetworkDay(member.startedAt, at));
      if (Number(today?.n ?? 0) >= target) continue;

      const content = composeWarmupReply({
        subject: row.subject,
        senderName: member.name,
        recipientTag: sender.tag,
        random,
      });
      const ok = await deliver(db, deps, member, sender, {
        ...content,
        token: newId('warmupToken'),
        threadToken: row.thread_token,
        depth: Number(row.depth) + 1,
        kind: 'reply',
        at,
        inReplyTo: found.messageId ?? row.message_id ?? undefined,
      });
      if (ok) {
        replied += 1;
        await db.execute({
          sql: `UPDATE warmup_messages SET replied_at = ? WHERE id = ?`,
          args: [at.toISOString(), row.id],
        });
      } else {
        failed += 1;
      }
    }
  }

  return { seen, rescued, replied, failed };
}

// ------------------------------------------------------------------ stats

export interface WarmupStats {
  readonly network: boolean;
  readonly tag: string | null;
  readonly day: number | null;
  readonly targetToday: number | null;
  readonly sentToday: number;
  readonly received14d: number;
  readonly inbox14d: number;
  readonly spam14d: number;
  readonly replied14d: number;
  /** Network members this mailbox could write to, itself excluded. */
  readonly peers: number;
  /** The last warm-up send's error, when it failed after the last success. */
  readonly lastError: string | null;
}

export async function warmupStats(
  db: Client,
  accountIds: readonly string[],
  at: Date = new Date(),
): Promise<Map<string, WarmupStats>> {
  const out = new Map<string, WarmupStats>();
  if (accountIds.length === 0) return out;
  const marks = accountIds.map(() => '?').join(', ');
  const since = new Date(at.getTime() - 14 * 86_400_000).toISOString();

  const [accounts, sent, received, total, latest] = await Promise.all([
    queryAll<{
      id: string;
      warmup_network: number;
      warmup_tag: string | null;
      warmup_network_started_at: string | null;
    }>(
      db,
      `SELECT id, warmup_network, warmup_tag, warmup_network_started_at
         FROM integration_accounts WHERE id IN (${marks})`,
      [...accountIds],
    ),
    queryAll<{ id: string; n: number }>(
      db,
      `SELECT sender_account_id AS id, COUNT(*) AS n FROM warmup_messages
        WHERE sender_account_id IN (${marks}) AND sent_at >= ? AND kind <> 'failed'
        GROUP BY sender_account_id`,
      [...accountIds, startOfDay(at)],
    ),
    queryAll<{ id: string; landed: string | null; n: number; replied: number }>(
      db,
      `SELECT recipient_account_id AS id, landed, COUNT(*) AS n,
              SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied
         FROM warmup_messages
        WHERE recipient_account_id IN (${marks}) AND sent_at >= ? AND kind <> 'failed'
        GROUP BY recipient_account_id, landed`,
      [...accountIds, since],
    ),
    queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM integration_accounts
        WHERE network = 'email' AND status = 'active' AND warmup_network = 1`,
      [],
    ),
    // Each mailbox's most recent warm-up send, success or failure.
    queryAll<{ id: string; kind: string; subject: string }>(
      db,
      `SELECT w.sender_account_id AS id, w.kind, w.subject FROM warmup_messages w
        WHERE w.sender_account_id IN (${marks})
          AND w.sent_at = (SELECT MAX(x.sent_at) FROM warmup_messages x
                            WHERE x.sender_account_id = w.sender_account_id)`,
      [...accountIds],
    ),
  ]);

  const sentById = new Map(sent.map((row) => [row.id, Number(row.n)]));
  const members = Number(total?.n ?? 0);

  for (const account of accounts) {
    const rows = received.filter((row) => row.id === account.id);
    const count = (landed: string | null) =>
      rows.filter((row) => row.landed === landed).reduce((sum, row) => sum + Number(row.n), 0);
    const network = Number(account.warmup_network) === 1;
    const day =
      network && account.warmup_network_started_at
        ? warmupNetworkDay(account.warmup_network_started_at, at)
        : null;
    out.set(account.id, {
      network,
      tag: account.warmup_tag,
      day,
      targetToday: day === null ? null : warmupNetworkTarget(day),
      sentToday: sentById.get(account.id) ?? 0,
      // Seen by the sweeper, wherever it landed; mail still in flight is not counted.
      received14d: count('inbox') + count('spam'),
      inbox14d: count('inbox'),
      spam14d: count('spam'),
      replied14d: rows.reduce((sum, row) => sum + Number(row.replied ?? 0), 0),
      peers: Math.max(0, members - (network ? 1 : 0)),
      lastError: (() => {
        const last = latest.find((row) => row.id === account.id);
        return last?.kind === 'failed' ? last.subject : null;
      })(),
    });
  }
  return out;
}

// ------------------------------------------------------------------ plumbing

function startOfDay(at: Date): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())).toISOString();
}

function parse(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
