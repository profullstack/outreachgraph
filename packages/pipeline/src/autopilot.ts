/**
 * Unattended sending (PRD §7.6 `trusted_automation`, §16, §27).
 *
 * Everything upstream of this already worked: a URL became a company, people,
 * signals, a score, a recommendation and a drafted message. Then it stopped,
 * because the only way a message could leave the product was a human copying
 * it into their own mail client. `POST /actions/:id/execute` did not send
 * anything — it recorded that a send had happened elsewhere.
 *
 * This is the unattended executor. It is no longer the only way outreach
 * reaches the wire: approving a card in the queue now sends too, through the
 * same `outreach-email` mechanics, because a product that drafts a message and
 * then tells a human to go and paste it somewhere has not finished the job.
 * What is still unique here is the *lack* of a human — and that is what these
 * two rules exist for:
 *
 *   - **Policy is re-checked here, from live state.** The decision stored on
 *     the recommendation is a snapshot from generation time and is never
 *     trusted. Suppression, deletion, rate limits and identity confidence are
 *     all re-read; a campaign switched off autopilot ten seconds ago does not
 *     send.
 *   - **Autopilot is opt-in per campaign and gated per capability.** The
 *     policy engine only skips approval for `trusted_automation` *and* a
 *     capability the matrix marks `official_api` or `customer_managed`. Email
 *     is customer-managed. Nothing else currently qualifies, which is why this
 *     sends email and nothing else.
 *
 * A failed send is recorded on the action and the recommendation is left where
 * it was, so the next tick retries rather than silently dropping a lead.
 */

import { newId, type ActionKind, type Network } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { evaluatePolicy, isExecutable } from '@outreachgraph/policy';
import type { Mailer } from '@outreachgraph/email';
import { mailerForWorkspace } from './email-account';
import {
  defaultEmailSubject,
  loadOutreachSettings,
  pickEmailRecipient,
  recordEmailFailure,
  recordEmailSent,
  AUTOPILOT_ACTOR,
} from './outreach-email';

export interface AutopilotDeps {
  readonly db: Client;
  /**
   * The platform sender, used by any workspace that has not connected its own
   * mailbox. Omit it and a workspace without a mailbox sends nothing — the
   * queue still runs and still reports why.
   */
  readonly mailer?: Mailer;
  /**
   * Unlocks a workspace's stored SMTP password. Without it, connected
   * mailboxes are unreadable and every workspace falls back to `mailer`.
   */
  readonly encryptionKey?: Buffer | undefined;
  /** Reply-to for outbound mail. Falls back to the workspace owner. */
  readonly replyTo?: string;
  readonly now?: Date;
}

export interface SentOutreach {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly personId: string;
  readonly personName: string;
  readonly recommendationId: string;
  readonly actionId: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly companyName?: string;
  /** True when the address is a shared company inbox rather than the person's. */
  readonly toSharedInbox: boolean;
}

export interface SkippedOutreach {
  readonly recommendationId: string;
  readonly personName: string;
  readonly reason: string;
}

export interface AutopilotResult {
  readonly sent: readonly SentOutreach[];
  readonly skipped: readonly SkippedOutreach[];
  readonly failed: number;
}

interface Candidate {
  readonly recommendation_id: string;
  readonly campaign_id: string;
  readonly person_id: string;
  readonly action: string;
  readonly network: string;
  readonly approval_mode: string;
  readonly budget_json: string;
  readonly display_name: string;
  readonly person_status: string;
  readonly believed_minor: number;
  readonly outreach_eligible: number;
  readonly identity_confidence: number;
  readonly min_outreach_confidence: number;
  readonly draft_id: string | null;
  readonly subject: string | null;
  readonly body: string | null;
  readonly checks_json: string | null;
  readonly company_name: string | null;
  readonly company_contact_email: string | null;
  readonly person_email: string | null;
  readonly failed_attempts: number;
}

/** Attempts before a recommendation is left alone for a human to look at. */
const MAX_SEND_ATTEMPTS = 3;

/**
 * Sends everything due for one workspace.
 *
 * Ordered by priority so a daily cap spends itself on the best leads rather
 * than on whichever rows the planner happened to return first.
 */
export async function runAutopilot(
  deps: AutopilotDeps,
  workspaceId: string,
): Promise<AutopilotResult> {
  const { db } = deps;
  const at = deps.now ?? new Date();

  const sent: SentOutreach[] = [];
  const skipped: SkippedOutreach[] = [];
  let failed = 0;

  const settings = await loadOutreachSettings(db, workspaceId);
  const cap = settings.autopilot_daily_cap;

  // The workspace's own mailbox when it has connected one, the platform sender
  // otherwise. Resolved once per run rather than per message so a workspace
  // with a hundred queued leads opens one SMTP connection, not a hundred.
  const sender = await mailerForWorkspace(db, workspaceId, {
    encryptionKey: deps.encryptionKey,
    fallback: deps.mailer,
  });

  let today = await countActionsToday(db, workspaceId, at);
  if (today >= cap) {
    return { sent, skipped, failed };
  }

  const candidates = await queryAll<Candidate>(
    db,
    `SELECT r.id AS recommendation_id, r.campaign_id, r.person_id, r.action, r.network,
            c.approval_mode, c.budget_json,
            p.display_name, p.status AS person_status, p.believed_minor,
            p.outreach_eligible, p.identity_confidence,
            w.min_outreach_confidence,
            d.id AS draft_id, d.subject, d.body, d.checks_json,
            co.name AS company_name, co.contact_email AS company_contact_email,
            (SELECT si.handle FROM social_identities si
              WHERE si.person_id = p.id AND si.network = 'email'
              ORDER BY si.confidence DESC LIMIT 1) AS person_email,
            (SELECT COUNT(*) FROM actions a
              WHERE a.recommendation_id = r.id AND a.status = 'failed') AS failed_attempts
       FROM recommendations r
       JOIN campaigns c ON c.id = r.campaign_id
       JOIN people p ON p.id = r.person_id
       JOIN workspaces w ON w.id = r.workspace_id
       LEFT JOIN drafts d ON d.recommendation_id = r.id
       LEFT JOIN companies co ON co.id = p.current_company_id
      WHERE r.workspace_id = ?
        AND r.status = 'pending'
        AND c.approval_mode = 'trusted_automation'
        AND c.status != 'archived'
        AND r.action = 'send_email'
        AND r.network = 'email'
        AND p.status = 'active'
      ORDER BY r.priority DESC, r.created_at ASC
      LIMIT ?`,
    [workspaceId, Math.max(cap - today, 0)],
  );

  for (const row of candidates) {
    if (today >= cap) break;

    const note = (reason: string): void => {
      skipped.push({
        recommendationId: row.recommendation_id,
        personName: row.display_name,
        reason,
      });
    };

    // Give up after enough failed attempts.
    //
    // A failed send leaves the recommendation pending so the next tick retries,
    // which is right for a rate limit or a blip and wrong for anything
    // permanent. An invalid API key produced three attempts per recommendation
    // within a minute of testing and would have produced thousands a day —
    // each one a row, and each one a request to a provider that has already
    // said no. The lead stays pending for a human rather than being deleted.
    if (row.failed_attempts >= MAX_SEND_ATTEMPTS) {
      note(`giving up after ${row.failed_attempts} failed sends`);
      continue;
    }

    // A recommendation with no draft has nothing to send. This is not an
    // error: the composer is allowed to produce nothing rather than invent a
    // claim it cannot ground, and that outcome must stay a silent no-send.
    if (!row.body || !row.body.trim()) {
      note('no drafted message');
      continue;
    }

    // The quality gates already ran when the draft was written. A draft that
    // failed one is never shown to a human, so it must never be sent by a
    // machine either.
    if (hasFailingCheck(row.checks_json)) {
      note('the draft did not pass its quality checks');
      continue;
    }

    const recipient = pickEmailRecipient(row);
    if (!recipient) {
      note('no address published for this person or their company');
      continue;
    }

    // ------------------------------------------------------------- policy
    //
    // Re-evaluated from live rows, never from the stored snapshot.
    const counts = await actionCounts(db, workspaceId, row.person_id, at);
    const budget = safeJson(row.budget_json);

    const decision = evaluatePolicy({
      network: row.network as Network,
      action: row.action as ActionKind,
      approvalMode: row.approval_mode as 'trusted_automation',
      hasConnectedAccount: sender !== undefined,
      personSuppressed: row.person_status === 'suppressed' || row.outreach_eligible === 0,
      personBelievedMinor: row.believed_minor === 1,
      personDeleted: row.person_status === 'deleted',
      identityConfidence: row.identity_confidence,
      minIdentityConfidence: row.min_outreach_confidence,
      actionsToday: today,
      maxActionsPerDay: Math.min(numberOr(budget.maxActionsPerDay, 50), cap),
      actionsToThisProspectThisWeek: counts.thisProspect,
      maxActionsPerProspectPerWeek: numberOr(budget.maxActionsPerProspectPerWeek, 1),
      ...(counts.hoursSinceLast !== undefined
        ? { hoursSinceLastActionToProspect: counts.hoursSinceLast }
        : {}),
    });

    // `approved: false` is the whole point. Autopilot holds no approval, so
    // only a decision of plain `allow` gets through — `allow_with_approval`
    // means a human still has to look at it, and reaching here with that would
    // mean the capability matrix no longer marks email customer-managed.
    // Sending anyway would be exactly what the approval default prevents.
    if (!isExecutable(decision.decision, false)) {
      note(
        decision.decision === 'allow_with_approval'
          ? 'this action still requires human approval'
          : decision.reason,
      );
      continue;
    }

    if (!sender) {
      note('no mailbox is connected, so nothing can be sent');
      continue;
    }

    // --------------------------------------------------------------- send
    const actionId = newId('action');
    const stamp = now();
    const subject = row.subject?.trim() || defaultEmailSubject(row.company_name);

    await db.execute({
      sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
            mode, status, body, created_at)
            VALUES (?, ?, ?, ?, 'send_email', 'email', 'customer_managed', 'queued', ?, ?)`,
      args: [actionId, workspaceId, row.recommendation_id, row.person_id, row.body, stamp],
    });

    // The workspace's own reply-to wins over the platform default, because a
    // customer who connected their own mailbox meant replies to reach it.
    const replyTo = deps.replyTo ?? sender.replyTo ?? settings.reply_to_email ?? undefined;

    try {
      const result = await sender.mailer.send({
        to: recipient.address,
        subject,
        text: row.body,
        ...(replyTo ? { replyTo } : {}),
      });

      await recordEmailSent(db, {
        workspaceId,
        campaignId: row.campaign_id,
        personId: row.person_id,
        actionId,
        recommendationId: row.recommendation_id,
        to: recipient.address,
        sharedInbox: recipient.shared,
        body: row.body,
        externalId: result.id,
        actor: AUTOPILOT_ACTOR,
        policyVersion: decision.policyVersion,
      });

      sent.push({
        workspaceId,
        campaignId: row.campaign_id,
        personId: row.person_id,
        personName: row.display_name,
        recommendationId: row.recommendation_id,
        actionId,
        to: recipient.address,
        subject,
        body: row.body,
        ...(row.company_name ? { companyName: row.company_name } : {}),
        toSharedInbox: recipient.shared,
      });

      today += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed += 1;

      // Left as `failed` with the reason attached, and the recommendation left
      // pending. A bounced domain or a rate-limited provider is worth another
      // attempt on a later tick; losing the lead over it is not.
      await recordEmailFailure(db, {
        workspaceId,
        actionId,
        to: recipient.address,
        error: message,
        actor: AUTOPILOT_ACTOR,
      });
    }
  }

  return { sent, skipped, failed };
}

/** True when any recorded quality gate failed. Unparseable checks fail closed. */
function hasFailingCheck(checksJson: string | null): boolean {
  if (!checksJson) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(checksJson);
  } catch {
    return true;
  }

  if (!Array.isArray(parsed)) return false;
  return parsed.some((check) => {
    if (!check || typeof check !== 'object') return false;
    const entry = check as { passed?: unknown; ok?: unknown };
    if (entry.passed === false) return true;
    return entry.ok === false;
  });
}

function dayStart(at: Date): string {
  return `${at.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

async function countActionsToday(db: Client, workspaceId: string, at: Date): Promise<number> {
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM actions
      WHERE workspace_id = ? AND created_at >= ? AND status != 'failed'`,
    [workspaceId, dayStart(at)],
  );
  return row?.n ?? 0;
}

async function actionCounts(
  db: Client,
  workspaceId: string,
  personId: string,
  at: Date,
): Promise<{ thisProspect: number; hoursSinceLast?: number }> {
  const weekAgo = new Date(at.getTime() - 7 * 24 * 3_600_000).toISOString();

  const row = await queryOne<{ n: number; last_at: string | null }>(
    db,
    `SELECT COUNT(*) AS n, MAX(created_at) AS last_at FROM actions
      WHERE workspace_id = ? AND person_id = ? AND created_at >= ? AND status != 'failed'`,
    [workspaceId, personId, weekAgo],
  );

  const thisProspect = row?.n ?? 0;
  if (!row?.last_at) return { thisProspect };

  const stamp = Date.parse(row.last_at);
  if (Number.isNaN(stamp)) return { thisProspect };

  return { thisProspect, hoursSinceLast: (at.getTime() - stamp) / 3_600_000 };
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
