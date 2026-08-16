/**
 * Putting an approved message on the wire (PRD §16, §27).
 *
 * Autopilot was the first thing that could send outreach, and for a while it
 * was the only one — which left the product's *default* path dead. A campaign
 * on `draft_and_approve` produced a card, a human read the evidence, pressed
 * Approve, and got told to go and send it themselves. The two paths disagreed
 * about something they had no business disagreeing about: whether the product
 * could put an email on the wire at all.
 *
 * So the mechanics live here, once, and both callers use them. Autopilot keeps
 * its own loop, cap and retry policy; the API keeps its own policy re-check and
 * approval record. What they share is everything between "this send is allowed"
 * and "the graph knows it happened":
 *
 *   - which address to use, and whether it belongs to a person or an inbox,
 *   - the subject when the composer did not write one,
 *   - the bookkeeping a completed send implies — the action, the interaction,
 *     the recommendation, the funnel row and the audit trail, which are five
 *     writes that are wrong to do four of.
 *
 * Nothing here decides whether a send is permitted. That is the policy engine's
 * job, and both callers have already asked it by the time they get here.
 */

import { newId, type ProspectStatus } from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
import type { Mailer } from '@outreachgraph/email';
import { recordStatus } from './stages';

export interface EmailRecipient {
  readonly address: string;
  /** True when this is a company inbox, not the person's own address. */
  readonly shared: boolean;
}

/**
 * The best address for this person.
 *
 * Their own if the site published one. Otherwise the company's shared inbox,
 * flagged as shared so nothing downstream pretends a named human is reading
 * it. Neither means no send rather than a guess — inventing
 * `firstname@company.com` is how a sending domain gets burned.
 */
export function pickEmailRecipient(row: {
  readonly person_email: string | null;
  readonly company_contact_email: string | null;
}): EmailRecipient | undefined {
  if (row.person_email) return { address: row.person_email, shared: false };
  if (row.company_contact_email) return { address: row.company_contact_email, shared: true };
  return undefined;
}

/** A subject the composer did not supply. Kept plain and specific. */
export function defaultEmailSubject(companyName: string | null | undefined): string {
  return companyName ? `Quick question about ${companyName}` : 'Quick question';
}

export interface OutreachSettings {
  readonly autopilot_daily_cap: number;
  readonly reply_to_email: string | null;
}

export async function loadOutreachSettings(
  db: Client,
  workspaceId: string,
): Promise<OutreachSettings> {
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

export interface SentEmailRecord {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly personId: string;
  readonly actionId: string;
  readonly recommendationId: string;
  readonly to: string;
  readonly sharedInbox: boolean;
  readonly body: string;
  readonly externalId?: string | undefined;
  readonly actor: AuditActor;
  readonly policyVersion?: string;
  readonly at?: string;
}

/**
 * Everything a completed send implies, in one place.
 *
 * These writes are what makes a sent message visible to the rest of the
 * product: the funnel counts it, the approval queue stops offering it, and the
 * next policy check sees it as an action against the rate limit. Doing some of
 * them is worse than doing none — a message that went out but left the
 * recommendation pending gets sent again on the next tick.
 */
export async function recordEmailSent(db: Client, record: SentEmailRecord): Promise<void> {
  const at = record.at ?? now();

  await db.execute({
    sql: `UPDATE actions SET status = 'completed', external_id = ?, executed_at = ?
           WHERE id = ?`,
    args: [record.externalId ?? null, at, record.actionId],
  });

  await db.execute({
    sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, action_id,
          network, direction, state, body, occurred_at, recorded_at)
          VALUES (?, ?, ?, ?, ?, 'email', 'outbound', 'contacted', ?, ?, ?)`,
    args: [
      newId('interaction'),
      record.workspaceId,
      record.personId,
      record.campaignId,
      record.actionId,
      record.body,
      at,
      at,
    ],
  });

  await db.execute({
    sql: `UPDATE recommendations SET status = 'executed' WHERE id = ?`,
    args: [record.recommendationId],
  });

  await db.execute({
    sql: `UPDATE campaign_people SET interaction_state = 'contacted', last_actioned_at = ?
           WHERE campaign_id = ? AND person_id = ?`,
    args: [at, record.campaignId, record.personId],
  });

  await recordStatus(db, {
    workspaceId: record.workspaceId,
    campaignId: record.campaignId,
    personId: record.personId,
    status: 'executed' satisfies ProspectStatus,
    reason: `${record.actor.actorId} emailed ${record.to}`,
    at,
  });

  await auditAction(db, record.workspaceId, record.actionId, record.actor, {
    eventType: 'action.executed',
    detail: {
      mode: 'email',
      to: record.to,
      sharedInbox: record.sharedInbox,
      ...(record.policyVersion ? { policyVersion: record.policyVersion } : {}),
    },
  });
}

/**
 * A send that the provider rejected.
 *
 * The action carries the reason and the recommendation is left where it was,
 * so a rate limit or a blip is retried rather than silently costing a lead.
 */
export async function recordEmailFailure(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly actionId: string;
    readonly to: string;
    readonly error: string;
    readonly actor: AuditActor;
  },
): Promise<void> {
  const detail = input.error.slice(0, 500);

  await db.execute({
    sql: `UPDATE actions SET status = 'failed', error = ? WHERE id = ?`,
    args: [detail, input.actionId],
  });

  await auditAction(db, input.workspaceId, input.actionId, input.actor, {
    eventType: 'action.send_failed',
    detail: { to: input.to, error: detail },
  });
}

export interface AuditActor {
  readonly actorKind: 'system' | 'user';
  readonly actorId: string;
}

export const AUTOPILOT_ACTOR: AuditActor = { actorKind: 'system', actorId: 'autopilot' };

async function auditAction(
  db: Client,
  workspaceId: string,
  actionId: string,
  actor: AuditActor,
  entry: { eventType: string; detail: Record<string, unknown> },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO audit_events (id, workspace_id, actor_kind, actor_id, event_type,
          entity_kind, entity_id, detail_json, occurred_at)
          VALUES (?, ?, ?, ?, ?, 'action', ?, ?, ?)`,
    args: [
      newId('auditEvent'),
      workspaceId,
      actor.actorKind,
      actor.actorId,
      entry.eventType,
      actionId,
      JSON.stringify(entry.detail),
      now(),
    ],
  });
}

export interface DeliverEmailDeps {
  readonly db: Client;
  readonly mailer: Mailer;
  /** Reply-to override. Falls back to the workspace's configured address. */
  readonly replyTo?: string | undefined;
}

export interface DeliverEmailInput {
  readonly workspaceId: string;
  readonly actionId: string;
  readonly actor: AuditActor;
  readonly policyVersion?: string;
}

export type DeliverEmailResult =
  | {
      readonly sent: true;
      readonly to: string;
      readonly sharedInbox: boolean;
      readonly subject: string;
      readonly externalId?: string | undefined;
    }
  | { readonly sent: false; readonly reason: string };

interface DeliverableAction {
  readonly action_id: string;
  readonly action_status: string;
  readonly action_body: string | null;
  readonly network: string;
  readonly kind: string;
  readonly person_id: string;
  readonly recommendation_id: string;
  readonly campaign_id: string;
  readonly display_name: string;
  readonly draft_subject: string | null;
  readonly draft_body: string | null;
  readonly company_name: string | null;
  readonly company_contact_email: string | null;
  readonly person_email: string | null;
}

/**
 * Sends the message an approved action carries.
 *
 * Returns rather than throws for the cases that are answers rather than
 * faults — no address published, nothing drafted, already sent. Each one is a
 * fact the reviewer needs to read, and turning them all into a 500 would tell
 * them only that "it failed". A provider rejection is recorded on the action
 * and returned the same way, so the caller can report it and the row stays
 * retryable.
 */
export async function deliverEmailAction(
  deps: DeliverEmailDeps,
  input: DeliverEmailInput,
): Promise<DeliverEmailResult> {
  const { db } = deps;

  const row = await queryOne<DeliverableAction>(
    db,
    `SELECT a.id AS action_id, a.status AS action_status, a.body AS action_body,
            a.network, a.kind, a.person_id, a.recommendation_id,
            r.campaign_id,
            p.display_name,
            d.subject AS draft_subject, d.body AS draft_body,
            co.name AS company_name, co.contact_email AS company_contact_email,
            (SELECT si.handle FROM social_identities si
              WHERE si.person_id = p.id AND si.network = 'email'
              ORDER BY si.confidence DESC LIMIT 1) AS person_email
       FROM actions a
       JOIN recommendations r ON r.id = a.recommendation_id
       JOIN people p ON p.id = a.person_id
       LEFT JOIN drafts d ON d.recommendation_id = a.recommendation_id
       LEFT JOIN companies co ON co.id = p.current_company_id
      WHERE a.id = ? AND a.workspace_id = ?`,
    [input.actionId, input.workspaceId],
  );

  if (!row) return { sent: false, reason: 'action not found' };
  if (row.network !== 'email') return { sent: false, reason: 'this action is not an email' };
  if (row.action_status === 'completed') return { sent: false, reason: 'already sent' };

  // The action body is the approved wording — the edit the reviewer made, if
  // they made one. Falling back to the draft covers an action recorded before
  // a draft existed.
  const body = (row.action_body ?? row.draft_body ?? '').trim();
  if (!body) return { sent: false, reason: 'there is no message to send' };

  const recipient = pickEmailRecipient(row);
  if (!recipient) {
    return { sent: false, reason: 'no address published for this person or their company' };
  }

  const settings = await loadOutreachSettings(db, input.workspaceId);
  const replyTo = deps.replyTo ?? settings.reply_to_email ?? undefined;
  const subject = row.draft_subject?.trim() || defaultEmailSubject(row.company_name);

  try {
    const result = await deps.mailer.send({
      to: recipient.address,
      subject,
      text: body,
      ...(replyTo ? { replyTo } : {}),
    });

    await recordEmailSent(db, {
      workspaceId: input.workspaceId,
      campaignId: row.campaign_id,
      personId: row.person_id,
      actionId: row.action_id,
      recommendationId: row.recommendation_id,
      to: recipient.address,
      sharedInbox: recipient.shared,
      body,
      externalId: result.id,
      actor: input.actor,
      ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
    });

    return {
      sent: true,
      to: recipient.address,
      sharedInbox: recipient.shared,
      subject,
      externalId: result.id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await recordEmailFailure(db, {
      workspaceId: input.workspaceId,
      actionId: row.action_id,
      to: recipient.address,
      error: message,
      actor: input.actor,
    });

    return { sent: false, reason: message.slice(0, 500) };
  }
}
