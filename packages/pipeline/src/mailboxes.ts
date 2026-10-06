/**
 * The Mailboxes page: every sending address, how healthy it is, and how to add
 * another with nothing but the address and its password.
 *
 * Built on the sender pool rather than beside it. A mailbox *is* an email
 * account in the pool; this adds what a person looking down a list of them
 * needs and the pool never had to know — the address and provider, whether
 * replies are read and when they last were, bounce risk, a health score, and
 * the DNS records that decide whether the mail lands at all.
 */

import {
  mailboxDomain,
  mailboxHealth,
  providerForDomain,
  providerFromMx,
  type BounceRisk,
  type MailboxProvider,
} from '@outreachgraph/domain';
import { now, queryAll, type Client } from '@outreachgraph/db';
import { SMTP_PRESETS } from '@outreachgraph/email';
import {
  checkSendingDomain,
  lookupMailboxSettings,
  type MailboxDnsDeps,
  type SendingDomainReport,
  type ServerSettings,
} from '@outreachgraph/providers';
import { listSenders, type SenderView } from './sender-pool';
import { warmupStats, type WarmupStats } from './warmup-network';

/** Bounce risk and health are judged over this many days of sending. */
const HEALTH_WINDOW_DAYS = 30;

export interface MailboxView extends SenderView {
  readonly fromEmail: string | null;
  readonly fromName: string | null;
  readonly domain: string | null;
  readonly provider: MailboxProvider;
  readonly providerLabel: string;
  readonly smtpHost: string | null;
  readonly imapHost: string | null;
  /** An IMAP host is configured, so replies and bounces can be read. */
  readonly readsReplies: boolean;
  readonly repliesCheckedAt: string | null;
  /** The last check's error, cleared by the next one that works. */
  readonly repliesError: string | null;
  readonly sends30d: number;
  readonly bounces30d: number;
  readonly bounceRisk: BounceRisk;
  readonly healthScore: number;
  readonly healthIssues: readonly string[];
  /** The warm-up network: whether it is on, its filter tag, and how its mail lands. */
  readonly warmupNetwork: WarmupStats | null;
}

export interface MailboxesSummary {
  readonly mailboxes: number;
  readonly active: number;
  readonly sentToday: number;
  readonly capacityToday: number;
  readonly warming: number;
  /** Mailboxes whose replies nobody is reading. */
  readonly notReadingReplies: number;
}

interface ExtraRow {
  readonly id: string;
  readonly config_json: string | null;
  readonly replies_checked_at: string | null;
  readonly replies_error: string | null;
  readonly health_reset_at: string | null;
}

export async function listMailboxes(
  db: Client,
  workspaceId: string,
  at: Date = new Date(),
): Promise<{ mailboxes: MailboxView[]; summary: MailboxesSummary }> {
  const senders = (await listSenders(db, workspaceId, at)).filter((s) => s.network === 'email');
  if (senders.length === 0) {
    return {
      mailboxes: [],
      summary: {
        mailboxes: 0,
        active: 0,
        sentToday: 0,
        capacityToday: 0,
        warming: 0,
        notReadingReplies: 0,
      },
    };
  }

  const ids = senders.map((sender) => sender.id);
  const marks = ids.map(() => '?').join(', ');
  const [extras, sends, bounces] = await Promise.all([
    queryAll<ExtraRow>(
      db,
      `SELECT id, config_json, replies_checked_at, replies_error, health_reset_at
         FROM integration_accounts WHERE id IN (${marks})`,
      ids,
    ),
    queryAll<{ id: string; n: number }>(
      db,
      `SELECT sender_account_id AS id, COUNT(*) AS n FROM actions
        WHERE sender_account_id IN (${marks}) AND status = 'completed'
          AND COALESCE(executed_at, created_at) >= ?
        GROUP BY sender_account_id`,
      [...ids, windowStart(at)],
    ),
    queryAll<{ id: string; n: number }>(
      db,
      `SELECT account_id AS id, COUNT(*) AS n FROM sender_events
        WHERE account_id IN (${marks}) AND kind = 'bounce' AND occurred_at >= ?
        GROUP BY account_id`,
      [...ids, windowStart(at)],
    ),
  ]);

  const extraById = new Map(extras.map((row) => [row.id, row]));
  const sendsById = new Map(sends.map((row) => [row.id, Number(row.n)]));
  const bouncesById = new Map(bounces.map((row) => [row.id, Number(row.n)]));

  const warm = await warmupStats(db, ids, at);
  const mailboxes = senders.map((sender) =>
    toMailbox(
      sender,
      extraById.get(sender.id),
      sendsById.get(sender.id) ?? 0,
      bouncesById.get(sender.id) ?? 0,
      warm.get(sender.id) ?? null,
    ),
  );

  return {
    mailboxes,
    summary: {
      mailboxes: mailboxes.length,
      active: mailboxes.filter((m) => m.status === 'active').length,
      sentToday: mailboxes.reduce((sum, m) => sum + m.sentToday, 0),
      capacityToday: mailboxes.reduce((sum, m) => sum + m.effectiveCapToday, 0),
      warming: mailboxes.filter((m) => m.warmup.enabled && !m.warmup.complete).length,
      notReadingReplies: mailboxes.filter((m) => !m.readsReplies || m.repliesError).length,
    },
  };
}

function toMailbox(
  sender: SenderView,
  extra: ExtraRow | undefined,
  sends: number,
  bounces: number,
  warm: WarmupStats | null,
): MailboxView {
  const config = parseConfig(extra?.config_json ?? null);
  const fromEmail = config.fromEmail ?? sender.handle;
  const preset = SMTP_PRESETS.find((p) => p.host && p.host === config.host);
  const provider = (preset?.id ?? 'custom') as MailboxProvider;
  const readsReplies = Boolean(config.imapHost);
  const progress =
    sender.warmup.complete || sender.warmup.rampCapToday === null || sender.configuredCap <= 0
      ? 1
      : sender.warmup.rampCapToday / sender.configuredCap;

  const health = mailboxHealth({
    status: sender.status,
    sends,
    bounces,
    readsReplies,
    replyCheckFailed: Boolean(extra?.replies_error),
    warmupProgress: progress,
  });

  return {
    ...sender,
    fromEmail: fromEmail ?? null,
    fromName: config.fromName ?? null,
    domain: fromEmail ? (mailboxDomain(fromEmail) ?? null) : null,
    provider,
    providerLabel: preset && preset.id !== 'custom' ? preset.label : 'IMAP / SMTP',
    smtpHost: config.host ?? null,
    imapHost: config.imapHost ?? null,
    readsReplies,
    repliesCheckedAt: extra?.replies_checked_at ?? null,
    repliesError: extra?.replies_error ?? null,
    sends30d: sends,
    bounces30d: bounces,
    bounceRisk: health.bounceRisk,
    healthScore: health.score,
    healthIssues: health.issues,
    warmupNetwork: warm,
  };
}

/**
 * Records the outcome of reading one mailbox's inbox. A success clears the
 * previous error; a failure keeps the time of the last attempt so "last
 * checked" never claims a read that did not happen.
 */
export async function recordReplyCheck(
  db: Client,
  accountId: string,
  error?: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE integration_accounts SET replies_checked_at = ?, replies_error = ? WHERE id = ?`,
    args: [now(), error ? error.slice(0, 500) : null, accountId],
  });
}

// ------------------------------------------------------------------ detection

export interface DetectedMailbox {
  readonly email: string;
  readonly domain: string;
  readonly provider: MailboxProvider;
  readonly providerLabel: string;
  readonly smtp: ServerSettings;
  readonly imap: ServerSettings | null;
  /** How the settings were found, weakest last. */
  readonly source: 'known' | 'mx' | 'autoconfig' | 'guess';
  /** What to do for this provider, e.g. "use an app password". */
  readonly note: string | null;
  readonly mx: readonly string[];
}

export class MailboxDetectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailboxDetectError';
  }
}

/**
 * Works out a mailbox's servers from its address, the way a mail client does:
 * a known consumer domain, then where the domain's MX points, then Mozilla's
 * ISPDB, then the `smtp.`/`imap.` convention. The guess is labelled as one so
 * the form can open its advanced settings rather than pretend to be sure.
 */
export async function detectMailbox(
  email: string,
  deps: MailboxDnsDeps = {},
): Promise<DetectedMailbox> {
  const domain = mailboxDomain(email);
  if (!domain) throw new MailboxDetectError('That is not an email address.');

  const known = providerForDomain(domain);
  const lookup = known ? undefined : await lookupMailboxSettings(domain, deps);
  const fromMx = lookup ? providerFromMx(lookup.mx) : undefined;
  const provider = known ?? fromMx;
  const mx = lookup?.mx ?? [];

  if (provider) {
    const preset = SMTP_PRESETS.find((p) => p.id === provider);
    if (preset) {
      return {
        email,
        domain,
        provider,
        providerLabel: preset.label,
        smtp: { host: preset.host, port: preset.port, secure: preset.secure },
        imap: preset.imapHost
          ? {
              host: preset.imapHost,
              port: preset.imapPort ?? 993,
              secure: preset.imapSecure ?? true,
            }
          : null,
        source: known ? 'known' : 'mx',
        note: preset.note ?? null,
        mx,
      };
    }
  }

  const auto = lookup?.autoconfig;
  if (auto?.smtp) {
    return {
      email,
      domain,
      provider: 'custom',
      providerLabel: 'IMAP / SMTP',
      smtp: auto.smtp,
      imap: auto.imap ?? null,
      source: 'autoconfig',
      note: null,
      mx,
    };
  }

  return {
    email,
    domain,
    provider: 'custom',
    providerLabel: 'IMAP / SMTP',
    smtp: { host: `smtp.${domain}`, port: 465, secure: true },
    imap: { host: `imap.${domain}`, port: 993, secure: true },
    source: 'guess',
    note: 'We could not look these servers up, so they are a guess. Check them against your provider’s settings page.',
    mx,
  };
}

/** The DNS report for one mailbox's sending domain. */
export async function mailboxDns(
  db: Client,
  workspaceId: string,
  accountId: string,
  deps: MailboxDnsDeps = {},
): Promise<SendingDomainReport | undefined> {
  const { mailboxes } = await listMailboxes(db, workspaceId);
  const mailbox = mailboxes.find((m) => m.id === accountId);
  if (!mailbox?.domain) return undefined;
  return checkSendingDomain(
    mailbox.domain,
    mailbox.provider === 'custom' ? {} : { provider: mailbox.provider },
    deps,
  );
}

// ------------------------------------------------------------------ plumbing

function windowStart(at: Date): string {
  return new Date(at.getTime() - HEALTH_WINDOW_DAYS * 86_400_000).toISOString();
}

interface ParsedConfig {
  readonly host?: string;
  readonly fromEmail?: string;
  readonly fromName?: string;
  readonly imapHost?: string;
}

function parseConfig(raw: string | null): ParsedConfig {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return {};
    const config = value as Record<string, unknown>;
    const text = (key: string): string | undefined =>
      typeof config[key] === 'string' && config[key] ? (config[key] as string) : undefined;
    return {
      ...(text('host') ? { host: text('host')! } : {}),
      ...(text('fromEmail') ? { fromEmail: text('fromEmail')! } : {}),
      ...(text('fromName') ? { fromName: text('fromName')! } : {}),
      ...(text('imapHost') ? { imapHost: text('imapHost')! } : {}),
    };
  } catch {
    return {};
  }
}
