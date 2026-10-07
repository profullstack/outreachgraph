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
  checkBlacklists,
  checkSendingDomain,
  lookupMailboxSettings,
  type BlacklistDeps,
  type BlacklistReport,
  type MailboxDnsDeps,
  type SendingDomainReport,
  type ServerSettings,
} from '@outreachgraph/providers';
import { emitEvent } from './events';
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
  /** Blocklists naming this mailbox at the last daily check; empty when clean. */
  readonly blacklistedOn: readonly string[];
  readonly blacklistCheckedAt: string | null;
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
      // Since the last resume too, as the stop rule counts them: a mailbox a
      // human cleared does not keep the bounces that stopped it.
      `SELECT e.account_id AS id, COUNT(*) AS n FROM sender_events e
         JOIN integration_accounts ia ON ia.id = e.account_id
        WHERE e.account_id IN (${marks}) AND e.kind = 'bounce' AND e.occurred_at >= ?
          AND e.occurred_at > COALESCE(ia.health_reset_at, '')
        GROUP BY e.account_id`,
      [...ids, windowStart(at)],
    ),
  ]);

  const extraById = new Map(extras.map((row) => [row.id, row]));
  const sendsById = new Map(sends.map((row) => [row.id, Number(row.n)]));
  const bouncesById = new Map(bounces.map((row) => [row.id, Number(row.n)]));

  const checks = await queryAll<{ account_id: string; listed_on: string; checked_at: string }>(
    db,
    `SELECT account_id, listed_on, checked_at FROM mailbox_blacklist_checks
      WHERE account_id IN (${marks})`,
    ids,
  );
  const checkById = new Map(checks.map((row) => [row.account_id, row]));

  const warm = await warmupStats(db, ids, at);
  const mailboxes = senders.map((sender) =>
    toMailbox(
      sender,
      extraById.get(sender.id),
      sendsById.get(sender.id) ?? 0,
      bouncesById.get(sender.id) ?? 0,
      warm.get(sender.id) ?? null,
      checkById.get(sender.id),
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
  check?: { listed_on: string; checked_at: string },
): MailboxView {
  const blacklistedOn = parseList(check?.listed_on);
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
    blacklistedOn,
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
    blacklistedOn,
    blacklistCheckedAt: check?.checked_at ?? null,
  };
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
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
  const [report, blacklist] = await Promise.all([
    checkSendingDomain(
      mailbox.domain,
      mailbox.provider === 'custom' ? {} : { provider: mailbox.provider },
      deps,
    ),
    checkBlacklists(
      {
        domain: mailbox.domain,
        smtpHost: mailbox.smtpHost,
        ...(mailbox.provider === 'custom' ? {} : { provider: mailbox.provider }),
      },
      deps,
    ),
  ]);
  await recordBlacklistCheck(db, workspaceId, accountId, blacklist);
  const check = blacklistCheck(blacklist);
  return {
    ...report,
    blacklist: check,
    status: check.status === 'fail' ? 'fail' : report.status,
  };
}

/** The blocklist answer in the same shape as the other DNS checks. */
export function blacklistCheck(report: BlacklistReport): {
  status: 'pass' | 'warn' | 'fail';
  value?: string;
  detail: string;
} {
  if (report.listedOn.length > 0) {
    return {
      status: 'fail',
      value: report.listedOn.join(', '),
      detail: `Listed on ${report.listedOn.join(', ')}. Mail is likely to be rejected or filtered; request delisting from each list, then stop and clean the list that caused it.`,
    };
  }
  const unknown = report.results.filter((r) => r.verdict === 'unknown').map((r) => r.list);
  if (unknown.length === report.results.length) {
    return {
      status: 'warn',
      detail: 'No blocklist would answer from this server, so this could not be checked.',
    };
  }
  return {
    status: 'pass',
    detail: `Not on ${report.results
      .filter((r) => r.verdict === 'clean')
      .map((r) => r.list)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(', ')}.`,
  };
}

export async function recordBlacklistCheck(
  db: Client,
  workspaceId: string,
  accountId: string,
  report: BlacklistReport,
): Promise<{ newlyListed: readonly string[] }> {
  const previous = await queryAll<{ listed_on: string }>(
    db,
    'SELECT listed_on FROM mailbox_blacklist_checks WHERE account_id = ?',
    [accountId],
  );
  const before = new Set(parseList(previous[0]?.listed_on));
  await db.execute({
    sql: `INSERT INTO mailbox_blacklist_checks (account_id, workspace_id, listed_on, results_json,
          checked_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (account_id) DO UPDATE SET listed_on = excluded.listed_on,
            results_json = excluded.results_json, checked_at = excluded.checked_at`,
    args: [
      accountId,
      workspaceId,
      JSON.stringify(report.listedOn),
      JSON.stringify(report.results),
      report.checkedAt,
    ],
  });
  return { newlyListed: report.listedOn.filter((list) => !before.has(list)) };
}

/** Daily: every active mailbox not checked in the last day, a few per run. */
export async function sweepBlacklists(
  db: Client,
  workspaceId: string,
  options: { readonly at?: Date; readonly deps?: BlacklistDeps; readonly limit?: number } = {},
): Promise<{ checked: number; listed: number }> {
  const at = options.at ?? new Date();
  const dayAgo = new Date(at.getTime() - 86_400_000).toISOString();
  const { mailboxes } = await listMailboxes(db, workspaceId, at);
  const due = mailboxes
    .filter((m) => m.status === 'active' && m.domain)
    .filter((m) => !m.blacklistCheckedAt || m.blacklistCheckedAt < dayAgo)
    .slice(0, options.limit ?? 5);

  let listed = 0;
  for (const mailbox of due) {
    const report = await checkBlacklists(
      {
        domain: mailbox.domain as string,
        smtpHost: mailbox.smtpHost,
        ...(mailbox.provider === 'custom' ? {} : { provider: mailbox.provider }),
      },
      options.deps ?? {},
    );
    const { newlyListed } = await recordBlacklistCheck(db, workspaceId, mailbox.id, report);
    if (report.listedOn.length > 0) listed += 1;
    if (newlyListed.length > 0) {
      await emitEvent(db, {
        workspaceId,
        phase: 'send',
        level: 'error',
        message:
          `${mailbox.fromEmail ?? mailbox.domain} is listed on ${newlyListed.join(', ')}. ` +
          'Mail from it is likely to be rejected; request delisting and clean the list that caused it.',
        detail: { accountId: mailbox.id, listedOn: report.listedOn },
      });
    }
  }
  return { checked: due.length, listed };
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
