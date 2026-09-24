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

import { newId, replySubject, type ProspectStatus } from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
import type { Mailer } from '@outreachgraph/email';
import { recordStatus } from './stages';
import { issueOpenPixel, trackLinksInBody } from './engagement';
import { issueUnsubscribeToken, unsubscribeUrl } from './unsubscribe';
import { emitWebhookEvent } from './webhooks';

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
  /** Whether links in outbound bodies are rewritten to tracked ones. */
  readonly track_links: boolean;
  /** Origin tracked links point at. NULL falls back to the service's APP_URL. */
  readonly tracking_origin: string | null;
  /** Whether outbound mail carries an HTML part with an open pixel. */
  readonly track_opens: boolean;
}

export async function loadOutreachSettings(
  db: Client,
  workspaceId: string,
): Promise<OutreachSettings> {
  const row = await queryOne<{
    autopilot_daily_cap: number;
    reply_to_email: string | null;
    track_links: number | null;
    tracking_origin: string | null;
    track_opens: number | null;
  }>(
    db,
    `SELECT autopilot_daily_cap, reply_to_email, track_links, tracking_origin, track_opens
       FROM workspace_settings WHERE workspace_id = ?`,
    [workspaceId],
  );

  // Defaults match the migration, so a workspace with no settings row behaves
  // exactly like one that has accepted the defaults.
  return {
    autopilot_daily_cap: row?.autopilot_daily_cap ?? 25,
    reply_to_email: row?.reply_to_email ?? null,
    track_links: (row?.track_links ?? 0) === 1,
    tracking_origin: row?.tracking_origin ?? null,
    track_opens: (row?.track_opens ?? 0) === 1,
  };
}

export interface OutgoingEmailInput {
  readonly workspaceId: string;
  readonly personId: string;
  readonly campaignId: string;
  readonly actionId: string;
  /** The approved wording, already through every gate. */
  readonly body: string;
  /** The address the message is going to, for the opt-out token. */
  readonly recipient: string;
  readonly settings: OutreachSettings;
  /** The service's own origin, used when the workspace has not set one. */
  readonly appUrl?: string | undefined;
}

export interface OutgoingEmail {
  readonly text: string;
  /** Present only when open tracking is on and a pixel could be issued. */
  readonly html?: string;
  readonly headers?: Record<string, string>;
  readonly trackedLinks: number;
  readonly openTracked: boolean;
}

/**
 * Everything between the approved body and what goes on the wire.
 *
 * Link tracking, the opt-out and the open pixel, in that order and in one
 * place. Autopilot used to build its own message and skipped the opt-out
 * entirely — every autopilot send went out with no unsubscribe link and no
 * `List-Unsubscribe` header, which is the one thing CAN-SPAM and Gmail's bulk
 * sender rules both insist on. Two send paths with two copies of this logic
 * had already drifted once; there is now one copy.
 *
 * Runs after the §14.2 gates, so what the checks read and what the reviewer
 * signed off on is `body`; only link destinations, the footer and the HTML
 * twin differ on the wire.
 */
export async function prepareOutgoingEmail(
  db: Client,
  input: OutgoingEmailInput,
): Promise<OutgoingEmail> {
  const { settings } = input;
  const origin = settings.tracking_origin ?? input.appUrl ?? undefined;

  const outgoing =
    settings.track_links && origin
      ? await trackLinksInBody(db, {
          workspaceId: input.workspaceId,
          personId: input.personId,
          campaignId: input.campaignId,
          actionId: input.actionId,
          body: input.body,
          origin,
        })
      : { body: input.body, tracked: 0 };

  // Opt-out. Issued per message so a click can be traced to the mail that
  // prompted it, and skipped only when we have no origin to point it at — a
  // link to nowhere is worse than the header being absent, because a client
  // will render the button and it will fail.
  const optOutUrl = origin
    ? unsubscribeUrl(
        origin,
        await issueUnsubscribeToken(db, {
          workspaceId: input.workspaceId,
          personId: input.personId,
          campaignId: input.campaignId,
          contactAddress: input.recipient,
        }),
      )
    : undefined;

  // Both the header and a line a human can see. The header is what providers
  // and mail clients read; the visible line is what someone reading on a
  // phone actually finds, and CAN-SPAM asks for the second one.
  const text = optOutUrl
    ? `${outgoing.body}\n\n--\nDon't want these? Unsubscribe: ${optOutUrl}`
    : outgoing.body;

  const headers = optOutUrl
    ? {
        'List-Unsubscribe': `<${optOutUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }
    : undefined;

  const pixel =
    settings.track_opens && origin
      ? await issueOpenPixel(db, {
          workspaceId: input.workspaceId,
          personId: input.personId,
          campaignId: input.campaignId,
          actionId: input.actionId,
          origin,
        })
      : undefined;

  return {
    text,
    ...(pixel ? { html: htmlTwin(text, pixel) } : {}),
    ...(headers ? { headers } : {}),
    trackedLinks: outgoing.tracked,
    openTracked: pixel !== undefined,
  };
}

/**
 * The HTML half of a tracked message: the plain text, escaped, plus one image.
 *
 * No template, no styling, no logo. The message is meant to read as though a
 * person typed it, and the HTML part is what most clients display once it
 * exists — so it has to look like the plain text did, not like a newsletter.
 */
export function htmlTwin(text: string, pixelUrl: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => `<p>${linkify(escapeHtml(block)).replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  const pixel = `<img src="${escapeHtml(pixelUrl)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`;

  return `<!doctype html><html><body>\n${paragraphs}\n${pixel}\n</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Makes URLs in already-escaped text clickable.
 *
 * Plain-text clients linkify on their own; an HTML part is taken literally, so
 * without this every link in a tracked message would stop working the moment
 * the recipient's client preferred the HTML half. Trailing sentence
 * punctuation is left outside the link, as a reader would expect.
 */
function linkify(escaped: string): string {
  return escaped.replace(/https?:\/\/[^\s<]+/g, (match) => {
    const url = match.replace(/[.,;:!?)\]]+$/, '');
    const rest = match.slice(url.length);
    return `<a href="${url}">${url}</a>${rest}`;
  });
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
  /**
   * This send answers a message they wrote.
   *
   * An answer is not a new touch: it must not drag a prospect who replied
   * back to `contacted`/`executed` in the funnel, which is what the cold-send
   * bookkeeping below would otherwise do to the one row a human most wants to
   * see move forward.
   */
  readonly answering?: boolean;
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

  // `contact_address` is the mailbox this actually reached, which is not
  // always a fact about the person: with no personal address it is their
  // company's shared inbox. The rate limits count this column, so a send that
  // does not write it is a send the next policy check cannot see.
  await db.execute({
    sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, action_id,
          network, direction, state, body, contact_address, shared_inbox, occurred_at, recorded_at)
          VALUES (?, ?, ?, ?, ?, 'email', 'outbound', ?, ?, ?, ?, ?, ?)`,
    args: [
      newId('interaction'),
      record.workspaceId,
      record.personId,
      record.campaignId,
      record.actionId,
      record.answering ? 'answered' : 'contacted',
      record.body,
      record.to.trim().toLowerCase(),
      record.sharedInbox ? 1 : 0,
      at,
      at,
    ],
  });

  await db.execute({
    sql: `UPDATE recommendations SET status = 'executed' WHERE id = ?`,
    args: [record.recommendationId],
  });

  if (record.answering) {
    await db.execute({
      sql: `UPDATE campaign_people SET last_actioned_at = ? WHERE campaign_id = ? AND person_id = ?`,
      args: [at, record.campaignId, record.personId],
    });
  } else {
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
  }

  await auditAction(db, record.workspaceId, record.actionId, record.actor, {
    eventType: 'action.executed',
    detail: {
      mode: 'email',
      to: record.to,
      sharedInbox: record.sharedInbox,
      ...(record.answering ? { answering: true } : {}),
      ...(record.policyVersion ? { policyVersion: record.policyVersion } : {}),
    },
  });

  await emitWebhookEvent(db, record.workspaceId, 'action.sent', {
    actionId: record.actionId,
    recommendationId: record.recommendationId,
    personId: record.personId,
    campaignId: record.campaignId,
    network: 'email',
    to: record.to,
    sharedInbox: record.sharedInbox,
    sentAt: at,
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

export async function auditAction(
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
  /**
   * Origin tracked links resolve from, when the workspace has opted in.
   *
   * Absent means no tracking, whatever the setting says — a rewritten link
   * with no origin to point at would send the prospect nowhere, and a dead
   * link in an outbound message is worse than an unmeasured one.
   */
  readonly appUrl?: string | undefined;
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
  readonly reply_to_interaction_id: string | null;
}

/** The inbound message a reply answers, and what threading it needs. */
interface AnsweredMessage {
  readonly contact_address: string | null;
  readonly shared_inbox: number;
  readonly external_id: string | null;
  readonly subject: string | null;
  readonly references_header: string | null;
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
            r.campaign_id, r.reply_to_interaction_id,
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

  // An answer goes back to the mailbox that wrote, in the same thread. The
  // address is theirs by definition — they used it — and it may not be the
  // one we would pick for a cold message: a prospect we reached at a shared
  // inbox who answers from their own address should be answered there.
  const answered = row.reply_to_interaction_id
    ? await queryOne<AnsweredMessage>(
        db,
        `SELECT contact_address, shared_inbox, external_id, subject, references_header
           FROM interactions WHERE id = ? AND workspace_id = ?`,
        [row.reply_to_interaction_id, input.workspaceId],
      )
    : undefined;

  const recipient = answered?.contact_address
    ? { address: answered.contact_address, shared: answered.shared_inbox === 1 }
    : pickEmailRecipient(row);
  if (!recipient) {
    return { sent: false, reason: 'no address published for this person or their company' };
  }

  const settings = await loadOutreachSettings(db, input.workspaceId);
  const replyTo = deps.replyTo ?? settings.reply_to_email ?? undefined;
  const subject =
    row.draft_subject?.trim() ||
    (answered ? replySubject(answered.subject) : defaultEmailSubject(row.company_name));

  // RFC 5322 threading: In-Reply-To names the message answered, References
  // carries the chain. Without them a client files the answer as a new
  // conversation, and the prospect has to go looking for what they asked.
  const threading: Record<string, string> = answered?.external_id
    ? {
        'In-Reply-To': answered.external_id,
        References: [answered.references_header, answered.external_id]
          .filter((part): part is string => Boolean(part?.trim()))
          .join(' '),
      }
    : {};

  // Link tracking, the opt-out and the pixel happen here and nowhere earlier:
  // `body` has already passed the §14.2 grounding gates, and rewriting before
  // them would mean the checks ran against words we do not send.
  const outgoing = await prepareOutgoingEmail(db, {
    workspaceId: input.workspaceId,
    personId: row.person_id,
    campaignId: row.campaign_id,
    actionId: row.action_id,
    body,
    recipient: recipient.address,
    settings,
    appUrl: deps.appUrl,
  });

  // Threading headers for a reply sit beside the opt-out headers, never
  // instead of them: an answer to somebody is still a message they can stop.
  const allHeaders = { ...(outgoing.headers ?? {}), ...threading };
  const headers = Object.keys(allHeaders).length > 0 ? allHeaders : undefined;

  try {
    const result = await deps.mailer.send({
      to: recipient.address,
      subject,
      text: outgoing.text,
      ...(outgoing.html ? { html: outgoing.html } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(headers ? { headers } : {}),
    });

    await recordEmailSent(db, {
      workspaceId: input.workspaceId,
      campaignId: row.campaign_id,
      personId: row.person_id,
      actionId: row.action_id,
      recommendationId: row.recommendation_id,
      to: recipient.address,
      sharedInbox: recipient.shared,
      // The approved wording, not the rewritten one. `tracked_links` already
      // records where each link was pointed, and a reviewer reading back what
      // was sent wants the sentence they signed off on rather than a body full
      // of opaque redirect tokens.
      body,
      externalId: result.id,
      actor: input.actor,
      ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
      ...(answered ? { answering: true } : {}),
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
