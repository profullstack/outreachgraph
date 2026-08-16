/**
 * Telling the customer what happened while nobody was watching.
 *
 * Autopilot moves the interface out of the app and into the inbox. If the
 * product finds a lead, writes to them and gets a reply, and the only place
 * any of that is visible is a dashboard nobody opened, then from the outside
 * it is indistinguishable from a product that does nothing — which is exactly
 * the state this work set out to fix.
 *
 * Two channels, deliberately different in character:
 *
 *   - **Lead alerts** interrupt. One per person, the moment they qualify, and
 *     never twice for the same person.
 *   - **The daily digest** summarises. Once per UTC day, whether or not
 *     anything happened, because silence is the failure mode being avoided.
 *
 * Both are idempotent through the `notifications` table's unique index rather
 * than through careful bookkeeping here: a retried job, an overlapping tick or
 * a crash mid-loop cannot produce a second copy.
 */

import { newId } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  dailyDigestEmail,
  leadAlertEmail,
  type DailyDigest,
  type DigestLead,
  type LeadAlert,
  type Mailer,
} from '@outreachgraph/email';

export interface NotifyDeps {
  readonly db: Client;
  readonly mailer?: Mailer;
  /** Absolute base for links in the mail. */
  readonly appUrl: string;
  readonly now?: Date;
}

export interface NotifySettings {
  readonly notify_email: string | null;
  readonly instant_alerts: number;
  readonly daily_digest: number;
  readonly digest_hour_utc: number;
  readonly alert_min_opportunity: number;
  readonly last_digest_sent_on: string | null;
}

const DEFAULTS: NotifySettings = {
  notify_email: null,
  instant_alerts: 1,
  daily_digest: 1,
  digest_hour_utc: 13,
  alert_min_opportunity: 60,
  last_digest_sent_on: null,
};

export async function loadNotifySettings(db: Client, workspaceId: string): Promise<NotifySettings> {
  const row = await queryOne<NotifySettings>(
    db,
    `SELECT notify_email, instant_alerts, daily_digest, digest_hour_utc,
            alert_min_opportunity, last_digest_sent_on
       FROM workspace_settings WHERE workspace_id = ?`,
    [workspaceId],
  );
  return row ?? DEFAULTS;
}

/**
 * Where this workspace's mail goes.
 *
 * An explicit `notify_email` wins; otherwise the owner's address, resolved at
 * send time rather than copied into settings so that changing a login address
 * cannot leave notifications going somewhere stale.
 *
 * Unverified addresses are refused. An account that never confirmed its
 * mailbox has not proven it owns it, and a digest is still mail we would be
 * sending to a stranger.
 */
export async function notifyAddress(
  db: Client,
  workspaceId: string,
  settings: NotifySettings,
): Promise<string | undefined> {
  if (settings.notify_email) return settings.notify_email;

  const owner = await queryOne<{ email: string }>(
    db,
    `SELECT u.email
       FROM workspaces w
       JOIN organization_members m ON m.organization_id = w.organization_id
       JOIN users u ON u.id = m.user_id
      WHERE w.id = ?
        AND u.status = 'active'
        AND u.email_verified_at IS NOT NULL
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               m.created_at ASC
      LIMIT 1`,
    [workspaceId],
  );

  return owner?.email;
}

/**
 * Records that a notification was sent, and reports whether this call is the
 * one that gets to send it.
 *
 * The insert is the lock. Returning false means another tick already claimed
 * this notification, so the caller must not send.
 */
async function claim(
  db: Client,
  workspaceId: string,
  kind: string,
  subjectKey: string,
  toEmail: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: `INSERT INTO notifications (id, workspace_id, kind, subject_key, to_email, sent_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, kind, subject_key) DO NOTHING`,
    args: [newId('notification'), workspaceId, kind, subjectKey, toEmail, now()],
  });

  return result.rowsAffected > 0;
}

/** Undoes a claim whose send then failed, so the next tick may retry it. */
async function release(
  db: Client,
  workspaceId: string,
  kind: string,
  subjectKey: string,
  error: string,
): Promise<void> {
  await db.execute({
    sql: `DELETE FROM notifications WHERE workspace_id = ? AND kind = ? AND subject_key = ?`,
    args: [workspaceId, kind, subjectKey],
  });
  console.log(`notification ${kind}/${subjectKey} failed, will retry: ${error}`);
}

interface AlertRow {
  readonly person_id: string;
  readonly display_name: string;
  readonly current_title: string | null;
  readonly company_name: string | null;
  readonly company_domain: string | null;
  readonly opportunity: number | null;
  readonly reason: string | null;
  readonly draft_subject: string | null;
  readonly draft_body: string | null;
  readonly sent_to: string | null;
}

/**
 * Sends one alert per newly-qualified lead.
 *
 * "Qualified" means the pipeline got far enough to recommend an action — a
 * person with a score but no recommendation is still being worked out, and
 * interrupting someone about them would be noise. The opportunity floor then
 * keeps the interruption worth having.
 */
export async function sendLeadAlerts(deps: NotifyDeps, workspaceId: string): Promise<number> {
  const settings = await loadNotifySettings(deps.db, workspaceId);
  if (settings.instant_alerts !== 1) return 0;

  const to = await notifyAddress(deps.db, workspaceId, settings);
  if (!to || !deps.mailer) return 0;

  const rows = await queryAll<AlertRow>(
    deps.db,
    `SELECT p.id AS person_id, p.display_name, p.current_title,
            co.name AS company_name, co.domain AS company_domain,
            s.opportunity, r.reason,
            d.subject AS draft_subject, d.body AS draft_body,
            (SELECT a.id FROM actions a
              WHERE a.recommendation_id = r.id AND a.status = 'completed'
              LIMIT 1) AS sent_to
       FROM recommendations r
       JOIN people p ON p.id = r.person_id
       LEFT JOIN companies co ON co.id = p.current_company_id
       LEFT JOIN scores s ON s.person_id = r.person_id AND s.campaign_id = r.campaign_id
       LEFT JOIN drafts d ON d.recommendation_id = r.id
      WHERE r.workspace_id = ?
        AND p.status = 'active'
        AND COALESCE(s.opportunity, 0) >= ?
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.workspace_id = r.workspace_id
             AND n.kind = 'lead_alert'
             AND n.subject_key = p.id
        )
      ORDER BY COALESCE(s.opportunity, 0) DESC
      LIMIT 25`,
    [workspaceId, settings.alert_min_opportunity],
  );

  let count = 0;

  for (const row of rows) {
    if (!(await claim(deps.db, workspaceId, 'lead_alert', row.person_id, to))) continue;

    // Read separately rather than joined above: the alert wants the address
    // that was written to, and the join that finds *whether* one was sent is
    // already doing enough work.
    const delivered = await queryOne<{ detail_json: string }>(
      deps.db,
      `SELECT detail_json FROM audit_events
        WHERE workspace_id = ? AND entity_kind = 'action' AND event_type = 'action.executed'
          AND entity_id = ?
        ORDER BY occurred_at DESC LIMIT 1`,
      [workspaceId, row.sent_to ?? ''],
    );

    const sentTo = delivered ? readTo(delivered.detail_json) : undefined;

    const evidence = await queryAll<{ summary: string }>(
      deps.db,
      `SELECT summary FROM signals WHERE workspace_id = ? AND person_id = ?
        ORDER BY observed_at DESC LIMIT 4`,
      [workspaceId, row.person_id],
    );

    const alert: LeadAlert = {
      personName: row.display_name,
      personId: row.person_id,
      ...(row.current_title ? { title: row.current_title } : {}),
      ...(row.company_name ? { companyName: row.company_name } : {}),
      ...(row.company_domain ? { companyDomain: row.company_domain } : {}),
      ...(row.opportunity !== null ? { opportunity: Math.round(row.opportunity) } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      ...(evidence.length ? { evidence: evidence.map((e) => e.summary) } : {}),
      ...(sentTo ? { sentTo } : {}),
      ...(row.draft_subject ? { draftSubject: row.draft_subject } : {}),
      ...(row.draft_body ? { draftBody: row.draft_body } : {}),
    };

    try {
      await deps.mailer.send(leadAlertEmail(to, alert, deps.appUrl));
      count += 1;
    } catch (error) {
      await release(
        deps.db,
        workspaceId,
        'lead_alert',
        row.person_id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return count;
}

function readTo(detailJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(detailJson);
    if (parsed && typeof parsed === 'object') {
      const to = (parsed as { to?: unknown }).to;
      if (typeof to === 'string') return to;
    }
  } catch {
    // A malformed audit detail is not worth failing an alert over.
  }
  return undefined;
}

/**
 * Sends the day's summary, once, if it is due.
 *
 * Due means: the configured hour has passed in UTC and no digest has gone out
 * for today's date yet. A workspace that turns the digest on at 23:00 gets its
 * first one the next day rather than an instant backfill.
 */
export async function sendDailyDigest(deps: NotifyDeps, workspaceId: string): Promise<boolean> {
  const at = deps.now ?? new Date();
  const today = at.toISOString().slice(0, 10);

  const settings = await loadNotifySettings(deps.db, workspaceId);
  if (settings.daily_digest !== 1) return false;
  if (at.getUTCHours() < settings.digest_hour_utc) return false;
  if (settings.last_digest_sent_on === today) return false;

  const to = await notifyAddress(deps.db, workspaceId, settings);
  if (!to || !deps.mailer) return false;

  if (!(await claim(deps.db, workspaceId, 'daily_digest', today, to))) return false;

  const since = `${today}T00:00:00.000Z`;

  const [crawled, found, sent, awaiting, leads] = await Promise.all([
    countOne(
      deps.db,
      `SELECT COUNT(*) AS n FROM jobs
        WHERE workspace_id = ? AND kind = 'crawl_site' AND status = 'done'
          AND finished_at >= ?`,
      [workspaceId, since],
    ),
    countOne(
      deps.db,
      `SELECT COUNT(DISTINCT person_id) AS n FROM lead_stage_events
        WHERE workspace_id = ? AND to_status = 'discovered' AND occurred_at >= ?`,
      [workspaceId, since],
    ),
    countOne(
      deps.db,
      `SELECT COUNT(*) AS n FROM actions
        WHERE workspace_id = ? AND status = 'completed' AND executed_at >= ?`,
      [workspaceId, since],
    ),
    countOne(
      deps.db,
      `SELECT COUNT(*) AS n FROM recommendations
        WHERE workspace_id = ? AND status = 'pending'`,
      [workspaceId],
    ),
    queryAll<{
      person_id: string;
      display_name: string;
      current_title: string | null;
      company_name: string | null;
      opportunity: number | null;
      sent_today: number;
    }>(
      deps.db,
      `SELECT p.id AS person_id, p.display_name, p.current_title,
              co.name AS company_name, s.opportunity,
              (SELECT COUNT(*) FROM actions a
                WHERE a.person_id = p.id AND a.workspace_id = e.workspace_id
                  AND a.status = 'completed' AND a.executed_at >= ?) AS sent_today
         FROM (SELECT DISTINCT person_id, workspace_id, campaign_id
                 FROM lead_stage_events
                WHERE workspace_id = ? AND occurred_at >= ?) e
         JOIN people p ON p.id = e.person_id
         LEFT JOIN companies co ON co.id = p.current_company_id
         LEFT JOIN scores s ON s.person_id = e.person_id AND s.campaign_id = e.campaign_id
        WHERE p.status = 'active'
        ORDER BY COALESCE(s.opportunity, 0) DESC
        LIMIT 15`,
      [since, workspaceId, since],
    ),
  ]);

  const digestLeads: DigestLead[] = leads.map((lead) => ({
    personName: lead.display_name,
    personId: lead.person_id,
    ...(lead.current_title ? { title: lead.current_title } : {}),
    ...(lead.company_name ? { companyName: lead.company_name } : {}),
    ...(lead.opportunity !== null ? { opportunity: Math.round(lead.opportunity) } : {}),
    ...(lead.sent_today > 0 ? { sentTo: 'sent' } : {}),
  }));

  const digest: DailyDigest = {
    date: today,
    sitesCrawled: crawled,
    peopleFound: found,
    messagesSent: sent,
    awaitingApproval: awaiting,
    leads: digestLeads,
  };

  try {
    await deps.mailer.send(dailyDigestEmail(to, digest, deps.appUrl));
  } catch (error) {
    await release(
      deps.db,
      workspaceId,
      'daily_digest',
      today,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }

  await deps.db.execute({
    sql: `INSERT INTO workspace_settings (workspace_id, last_digest_sent_on, created_at, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE
            SET last_digest_sent_on = excluded.last_digest_sent_on,
                updated_at = excluded.updated_at`,
    args: [workspaceId, today, now(), now()],
  });

  return true;
}

async function countOne(db: Client, sql: string, args: unknown[]): Promise<number> {
  const row = await queryOne<{ n: number }>(db, sql, args as never);
  return row?.n ?? 0;
}
