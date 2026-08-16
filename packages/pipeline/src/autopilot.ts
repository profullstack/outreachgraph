/**
 * Unattended sending (PRD §7.6 `trusted_automation`, §16, §27).
 *
 * Everything upstream of this already worked: a URL became a company, people,
 * signals, a score, a recommendation and a drafted message. Then it stopped,
 * because the only way a message could leave the product was a human copying
 * it into their own mail client. `POST /actions/:id/execute` did not send
 * anything — it recorded that a send had happened elsewhere.
 *
 * This is the executor. It is the only place outreach is put on the wire, and
 * it holds to the two rules that make that safe:
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

import { newId, type ActionKind, type Network, type ProspectStatus } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { evaluatePolicy, isExecutable } from '@outreachgraph/policy';
import type { Mailer } from '@outreachgraph/email';
import { emitEvent } from './events';
import { recordStatus } from './stages';

export interface AutopilotDeps {
  readonly db: Client;
  /** Omit and nothing sends — the queue still runs and still reports why. */
  readonly mailer?: Mailer;
  /** Reply-to for outbound mail. Falls back to the workspace owner. */
  readonly replyTo?: string;
  /**
   * Which transport `mailer` is.
   *
   * Recorded on every send. Two very different things can be true — "sent from
   * your own mail server" and "sent from ours on your behalf" — and the
   * difference determines whose domain reputation is at stake and where a reply
   * lands, so it must never be something a customer has to infer.
   */
  readonly via?: 'workspace' | 'platform';
  /** The address recipients will see. Recorded alongside `via`. */
  readonly fromAddress?: string;
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

  const settings = await loadSettings(db, workspaceId);
  const cap = settings.autopilot_daily_cap;

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

    // Skips are reported, not swallowed.
    //
    // "No address published for this person" and "still requires human
    // approval" are the two reasons a campaign sits at a stage looking broken,
    // and neither is an error anywhere else in the system — so if they are not
    // surfaced here they are not surfaced at all.
    const note = async (reason: string): Promise<void> => {
      skipped.push({
        recommendationId: row.recommendation_id,
        personName: row.display_name,
        reason,
      });

      await emitEvent(db, {
        workspaceId,
        campaignId: row.campaign_id,
        personId: row.person_id,
        phase: 'send',
        level: 'warn',
        message: `Held back ${row.display_name}: ${reason}`,
        detail: { reason, recommendationId: row.recommendation_id },
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
      await note(`giving up after ${row.failed_attempts} failed sends`);
      continue;
    }

    // A recommendation with no draft has nothing to send. This is not an
    // error: the composer is allowed to produce nothing rather than invent a
    // claim it cannot ground, and that outcome must stay a silent no-send.
    if (!row.body || !row.body.trim()) {
      await note('no drafted message');
      continue;
    }

    // The quality gates already ran when the draft was written. A draft that
    // failed one is never shown to a human, so it must never be sent by a
    // machine either.
    if (hasFailingCheck(row.checks_json)) {
      await note('the draft did not pass its quality checks');
      continue;
    }

    const recipient = pickRecipient(row);
    if (!recipient) {
      await note('no address published for this person or their company');
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
      hasConnectedAccount: deps.mailer !== undefined,
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
      await note(
        decision.decision === 'allow_with_approval'
          ? 'this action still requires human approval'
          : decision.reason,
      );
      continue;
    }

    if (!deps.mailer) {
      await note('no mailer is configured, so nothing can be sent');
      continue;
    }

    // --------------------------------------------------------------- send
    const actionId = newId('action');
    const stamp = now();
    const subject = row.subject?.trim() || defaultSubject(row);

    await db.execute({
      sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
            mode, status, body, created_at)
            VALUES (?, ?, ?, ?, 'send_email', 'email', 'customer_managed', 'queued', ?, ?)`,
      args: [actionId, workspaceId, row.recommendation_id, row.person_id, row.body, stamp],
    });

    const replyTo = deps.replyTo ?? settings.reply_to_email ?? undefined;

    try {
      const result = await deps.mailer.send({
        to: recipient.address,
        subject,
        text: row.body,
        ...(replyTo ? { replyTo } : {}),
      });

      const executedAt = now();

      await db.execute({
        sql: `UPDATE actions SET status = 'completed', external_id = ?, executed_at = ?
               WHERE id = ?`,
        args: [result.id ?? null, executedAt, actionId],
      });

      await db.execute({
        sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, action_id,
              network, direction, state, body, occurred_at, recorded_at)
              VALUES (?, ?, ?, ?, ?, 'email', 'outbound', 'contacted', ?, ?, ?)`,
        args: [
          newId('interaction'),
          workspaceId,
          row.person_id,
          row.campaign_id,
          actionId,
          row.body,
          executedAt,
          executedAt,
        ],
      });

      await db.execute({
        sql: `UPDATE recommendations SET status = 'executed' WHERE id = ?`,
        args: [row.recommendation_id],
      });

      await db.execute({
        sql: `UPDATE campaign_people SET interaction_state = 'contacted', last_actioned_at = ?
               WHERE campaign_id = ? AND person_id = ?`,
        args: [executedAt, row.campaign_id, row.person_id],
      });

      await recordStatus(db, {
        workspaceId,
        campaignId: row.campaign_id,
        personId: row.person_id,
        status: 'executed' satisfies ProspectStatus,
        reason: `autopilot emailed ${recipient.address}`,
        at: executedAt,
      });

      await audit(db, workspaceId, actionId, {
        eventType: 'action.executed',
        detail: {
          mode: 'autopilot',
          to: recipient.address,
          sharedInbox: recipient.shared,
          policyVersion: decision.policyVersion,
          via: deps.via ?? 'platform',
        },
      });

      await emitEvent(db, {
        workspaceId,
        campaignId: row.campaign_id,
        personId: row.person_id,
        phase: 'send',
        level: 'success',
        message:
          `Emailed ${row.display_name}` +
          `${row.company_name ? ` at ${row.company_name}` : ''} — ${recipient.address}`,
        detail: {
          to: recipient.address,
          subject,
          sharedInbox: recipient.shared,
          via: deps.via ?? 'platform',
          ...(deps.fromAddress ? { from: deps.fromAddress } : {}),
        },
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
      await db.execute({
        sql: `UPDATE actions SET status = 'failed', error = ? WHERE id = ?`,
        args: [message.slice(0, 500), actionId],
      });

      await audit(db, workspaceId, actionId, {
        eventType: 'action.send_failed',
        detail: { to: recipient.address, error: message.slice(0, 500) },
      });

      // The most important line this whole system produces. A send that fails
      // silently is indistinguishable from one that never had a reason to
      // happen, and telling those apart used to require reading container logs.
      await emitEvent(db, {
        workspaceId,
        campaignId: row.campaign_id,
        personId: row.person_id,
        phase: 'send',
        level: 'error',
        message: `Could not email ${row.display_name}: ${message.slice(0, 200)}`,
        detail: {
          to: recipient.address,
          error: message.slice(0, 500),
          attempt: row.failed_attempts + 1,
          via: deps.via ?? 'platform',
        },
      });
    }
  }

  return { sent, skipped, failed };
}

interface Recipient {
  readonly address: string;
  /** True when this is a company inbox, not the person's own address. */
  readonly shared: boolean;
}

/**
 * The best address for this person.
 *
 * Their own if the site published one. Otherwise the company's shared inbox,
 * flagged as shared so nothing downstream pretends a named human is reading
 * it. A campaign with neither is skipped rather than guessed at — inventing
 * `firstname@company.com` is how a sending domain gets burned.
 */
function pickRecipient(row: Candidate): Recipient | undefined {
  if (row.person_email) return { address: row.person_email, shared: false };
  if (row.company_contact_email) return { address: row.company_contact_email, shared: true };
  return undefined;
}

/** A subject the composer did not supply. Kept plain and specific. */
function defaultSubject(row: Candidate): string {
  return row.company_name ? `Quick question about ${row.company_name}` : 'Quick question';
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

interface Settings {
  readonly autopilot_daily_cap: number;
  readonly reply_to_email: string | null;
}

async function loadSettings(db: Client, workspaceId: string): Promise<Settings> {
  const row = await queryOne<{ autopilot_daily_cap: number; reply_to_email: string | null }>(
    db,
    `SELECT autopilot_daily_cap, reply_to_email FROM workspace_settings WHERE workspace_id = ?`,
    [workspaceId],
  );

  // Defaults match the migration, so a workspace with no settings row behaves
  // exactly like one that has accepted the defaults.
  return {
    autopilot_daily_cap: row?.autopilot_daily_cap ?? 25,
    reply_to_email: row?.reply_to_email ?? null,
  };
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

async function audit(
  db: Client,
  workspaceId: string,
  actionId: string,
  entry: { eventType: string; detail: Record<string, unknown> },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO audit_events (id, workspace_id, actor_kind, actor_id, event_type,
          entity_kind, entity_id, detail_json, occurred_at)
          VALUES (?, ?, 'system', 'autopilot', ?, 'action', ?, ?, ?)`,
    args: [
      newId('auditEvent'),
      workspaceId,
      entry.eventType,
      actionId,
      JSON.stringify(entry.detail),
      now(),
    ],
  });
}
