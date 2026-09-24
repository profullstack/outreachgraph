/**
 * The unified inbox: every conversation in the workspace, in one place.
 *
 * AutoGTM already had an inbox, scoped to one campaign and to email, shaped
 * for an agent. This is the workspace's own: every person anyone here has
 * exchanged a message with, across campaigns and networks, newest first, with
 * the label triage gave each reply and the drafted answer waiting on it.
 *
 * Three things it is careful about:
 *
 *   - **What counts as "needs a reply".** The last *human* message decides it.
 *     An absence notice or a bounce (`direction = 'automated'`) sits in the
 *     thread so the reader knows why nobody answered, but it never makes a
 *     conversation look like it is waiting on us — nor, the other way round,
 *     like it was answered. Click records are not messages and are left out.
 *   - **What "the original outbound" is.** The first thing we sent, flagged,
 *     because "what did they say yes to?" is the first question anyone asks
 *     of a reply.
 *   - **One way to send.** A reply written here goes through the API's own
 *     approval path — the policy recheck, the audit row, the email sender —
 *     injected rather than reimplemented, exactly as AutoGTM's does. If a
 *     drafted answer is already waiting on this message, sending here approves
 *     that card with the edited text rather than leaving a stale twin behind.
 *
 * Social replies are listed the moment anything records them: nothing in this
 * module is email-specific except sending, which is the one channel whose
 * replies we can both read and answer today.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  isReplyLabel,
  newId,
  REPLY_LABELS,
  replySubject,
  type ReplyLabel,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { POLICY_VERSION } from '@outreachgraph/policy';
import { ApiError, canApprove, type AppEnv, type RequestActor } from './context';
import * as repo from './repository';

export interface InboxApproveResult {
  readonly ok: boolean;
  readonly actionId?: string;
  readonly reason?: string;
  readonly decision?: string;
  readonly gate?: string | undefined;
  readonly delivery?: { sent: boolean; to?: string; reason?: string };
}

export interface InboxDeps {
  /** The API's approval path, with the reviewer's edited text. */
  readonly approve: (
    db: Client,
    actor: RequestActor,
    recommendation: repo.RecommendationRow,
    editedBody: string | undefined,
  ) => Promise<InboxApproveResult>;
  readonly requireVerifiedEmail: (db: Client, actor: RequestActor) => Promise<void>;
}

export const INBOX_FILTERS = ['need_reply', 'replied', 'sent', 'all'] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

const replyBody = z.object({
  text: z.string().trim().min(1).max(10_000),
  subject: z.string().trim().min(1).max(300).optional(),
});

interface ConversationRow {
  person_id: string;
  display_name: string;
  current_title: string | null;
  avatar_url: string | null;
  company_name: string | null;
  inbound: number;
  outbound: number;
  automated: number;
  last_at: string;
  networks: string | null;
  last_human_direction: string | null;
  last_body: string | null;
  last_direction: string;
  last_label: string | null;
  last_label_confidence: number | null;
  suppressed: number;
  pending_reply_id: string | null;
}

/** Where a conversation stands, from the last message a human wrote. */
export function conversationStatus(row: {
  readonly inbound: number;
  readonly last_human_direction: string | null;
}): 'need_reply' | 'replied' | 'sent' {
  if (Number(row.inbound) === 0) return 'sent';
  return row.last_human_direction === 'inbound' ? 'need_reply' : 'replied';
}

export function inboxRoutes(deps: InboxDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    const filter = (c.req.query('filter') ?? 'all') as InboxFilter;
    if (!INBOX_FILTERS.includes(filter)) {
      throw ApiError.badRequest(`filter must be one of ${INBOX_FILTERS.join(', ')}`);
    }

    const label = c.req.query('label');
    if (label !== undefined && !isReplyLabel(label)) {
      throw ApiError.badRequest(`label must be one of ${REPLY_LABELS.join(', ')}`);
    }

    const limit = clampPage(c.req.query('limit'));
    const before = c.req.query('before');

    const rows = await listConversations(db, actor.workspaceId, {
      filter,
      ...(label ? { label: label as ReplyLabel } : {}),
      limit,
      ...(before ? { before } : {}),
    });

    const conversations = rows.map((row) => ({
      person_id: row.person_id,
      name: row.display_name,
      title: row.current_title,
      company: row.company_name,
      avatar_url: row.avatar_url,
      networks: (row.networks ?? '').split(',').filter(Boolean),
      status: conversationStatus(row),
      suppressed: Number(row.suppressed) > 0,
      messages: {
        inbound: Number(row.inbound),
        outbound: Number(row.outbound),
        automated: Number(row.automated),
      },
      last_message_at: row.last_at,
      last_message_from:
        row.last_direction === 'inbound'
          ? 'them'
          : row.last_direction === 'automated'
            ? 'automated'
            : 'us',
      last_message_preview: row.last_body ? row.last_body.replace(/\s+/g, ' ').slice(0, 200) : null,
      label: isReplyLabel(row.last_label)
        ? { label: row.last_label, confidence: row.last_label_confidence }
        : null,
      pending_reply_id: row.pending_reply_id,
    }));

    const last = conversations[conversations.length - 1];
    return c.json({
      filter,
      ...(label ? { label } : {}),
      conversations,
      ...(conversations.length === limit && last ? { next_before: last.last_message_at } : {}),
    });
  });

  r.get('/:personId', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const thread = await loadThread(db, actor.workspaceId, c.req.param('personId'));
    if (!thread) throw ApiError.notFound('conversation');
    return c.json(thread);
  });

  /**
   * Sends a reply a human wrote (or approved as edited).
   *
   * Answers the latest inbound message when there is one, which is what makes
   * it thread and go back to the address that wrote. With no inbound message
   * it is an ordinary follow-up and the policy engine treats it as one —
   * including refusing it when the cold-outreach limits say so.
   */
  r.post('/:personId/reply', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    if (!canApprove(actor)) throw ApiError.forbidden('replying to a conversation');
    await deps.requireVerifiedEmail(db, actor);

    const personId = c.req.param('personId');
    const person = await repo.getPerson(db, personId);
    if (!person || !(await hasConversation(db, actor.workspaceId, personId))) {
      throw ApiError.notFound('conversation');
    }

    const body = await parse(c.req.raw, replyBody);

    const inbound = await queryOne<{
      id: string;
      campaign_id: string | null;
      subject: string | null;
    }>(
      db,
      `SELECT id, campaign_id, subject FROM interactions
        WHERE workspace_id = ? AND person_id = ? AND direction = 'inbound'
          AND network = 'email' AND state != 'clicked'
        ORDER BY occurred_at DESC LIMIT 1`,
      [actor.workspaceId, personId],
    );

    // A drafted answer already waiting on this message is the card to send:
    // approving it with the edited words keeps one card per message, instead
    // of sending here and leaving the draft in the queue to be sent again.
    const waiting = inbound
      ? await queryOne<{ id: string }>(
          db,
          `SELECT id FROM recommendations
            WHERE workspace_id = ? AND reply_to_interaction_id = ? AND status = 'pending'
              AND action = 'send_email'
            LIMIT 1`,
          [actor.workspaceId, inbound.id],
        )
      : undefined;

    let recommendationId = waiting?.id;
    let subject: string;

    if (recommendationId) {
      const draft = await queryOne<{ subject: string | null }>(
        db,
        'SELECT subject FROM drafts WHERE recommendation_id = ? LIMIT 1',
        [recommendationId],
      );
      subject = body.subject ?? draft?.subject ?? replySubject(inbound?.subject);
      await upsertDraft(db, actor.workspaceId, recommendationId, subject, body.text);
    } else {
      const campaignId =
        inbound?.campaign_id ?? (await latestCampaign(db, actor.workspaceId, personId));
      if (!campaignId) throw ApiError.badRequest('this person is in no campaign to reply from');

      subject =
        body.subject ??
        replySubject(inbound?.subject ?? (await lastSentSubject(db, actor.workspaceId, personId)));

      recommendationId = newId('recommendation');
      await db.execute({
        sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action,
              network, priority, reason, trigger_signal_id, policy_status, policy_version,
              expected_goal, status, created_at, reply_to_interaction_id)
              VALUES (?, ?, ?, ?, 'send_email', 'email', 100, 'Reply written in the inbox', NULL,
              'allow_with_approval', ?, 'continue_conversation', 'pending', ?, ?)`,
        args: [
          recommendationId,
          actor.workspaceId,
          campaignId,
          personId,
          POLICY_VERSION,
          now(),
          inbound?.id ?? null,
        ],
      });
      await upsertDraft(db, actor.workspaceId, recommendationId, subject, body.text);
    }

    const recommendation = await repo.getRecommendation(db, actor.workspaceId, recommendationId);
    if (!recommendation) throw new Error('reply recommendation vanished');

    const outcome = await deps.approve(db, actor, recommendation, body.text);

    if (!outcome.ok) {
      // A card created just now is retired; one that was already waiting stays
      // where the reviewer can find it.
      if (!waiting) {
        await db.execute({
          sql: `UPDATE recommendations SET status = 'skipped' WHERE id = ?`,
          args: [recommendationId],
        });
      }
      throw ApiError.policyDenied(outcome.reason ?? 'refused by policy', {
        decision: outcome.decision,
        gate: outcome.gate,
      });
    }

    if (outcome.delivery && !outcome.delivery.sent) {
      return c.json(
        {
          sent: false,
          person_id: personId,
          recommendation_id: recommendationId,
          action_id: outcome.actionId,
          reason: outcome.delivery.reason,
        },
        502,
      );
    }

    return c.json({
      sent: outcome.delivery?.sent === true,
      person_id: personId,
      recommendation_id: recommendationId,
      action_id: outcome.actionId,
      subject,
      ...(outcome.delivery?.to ? { to: outcome.delivery.to } : {}),
      ...(outcome.delivery
        ? {}
        : { note: 'recorded for a human to send: this deployment cannot put email on the wire' }),
    });
  });

  return r;
}

// ------------------------------------------------------------------ queries

async function listConversations(
  db: Client,
  workspaceId: string,
  options: {
    readonly filter: InboxFilter;
    readonly label?: ReplyLabel;
    readonly limit: number;
    readonly before?: string;
  },
): Promise<ConversationRow[]> {
  const conditions: string[] = [`p.status != 'deleted'`];
  const args: (string | number)[] = [];

  if (options.filter === 'need_reply') {
    conditions.push(`t.inbound > 0 AND t.last_human_direction = 'inbound'`);
  } else if (options.filter === 'replied') {
    conditions.push(`t.inbound > 0 AND t.last_human_direction = 'outbound'`);
  } else if (options.filter === 'sent') {
    conditions.push('t.inbound = 0');
  }
  if (options.label) {
    conditions.push('t.last_label = ?');
    args.push(options.label);
  }
  if (options.before) {
    conditions.push('t.last_at < ?');
    args.push(options.before);
  }

  return queryAll<ConversationRow>(
    db,
    `WITH agg AS (
       SELECT i.person_id,
              SUM(CASE WHEN i.direction = 'inbound' THEN 1 ELSE 0 END) AS inbound,
              SUM(CASE WHEN i.direction = 'outbound' THEN 1 ELSE 0 END) AS outbound,
              SUM(CASE WHEN i.direction = 'automated' THEN 1 ELSE 0 END) AS automated,
              MAX(i.occurred_at) AS last_at,
              GROUP_CONCAT(DISTINCT i.network) AS networks
         FROM interactions i
        WHERE i.workspace_id = ? AND i.state != 'clicked'
        GROUP BY i.person_id
     ),
     t AS (
       SELECT agg.*,
              (SELECT x.direction FROM interactions x
                WHERE x.workspace_id = ? AND x.person_id = agg.person_id
                  AND x.direction IN ('inbound', 'outbound') AND x.state != 'clicked'
                ORDER BY x.occurred_at DESC LIMIT 1) AS last_human_direction,
              (SELECT x.reply_label FROM interactions x
                WHERE x.workspace_id = ? AND x.person_id = agg.person_id
                  AND x.direction IN ('inbound', 'automated') AND x.state != 'clicked'
                ORDER BY x.occurred_at DESC LIMIT 1) AS last_label,
              (SELECT x.reply_confidence FROM interactions x
                WHERE x.workspace_id = ? AND x.person_id = agg.person_id
                  AND x.direction IN ('inbound', 'automated') AND x.state != 'clicked'
                ORDER BY x.occurred_at DESC LIMIT 1) AS last_label_confidence
         FROM agg
     )
     SELECT t.person_id, t.inbound, t.outbound, t.automated, t.last_at, t.networks,
            t.last_human_direction, t.last_label, t.last_label_confidence,
            p.display_name, p.current_title, p.avatar_url, co.name AS company_name,
            (SELECT x.body FROM interactions x
              WHERE x.workspace_id = ? AND x.person_id = t.person_id AND x.state != 'clicked'
              ORDER BY x.occurred_at DESC LIMIT 1) AS last_body,
            (SELECT x.direction FROM interactions x
              WHERE x.workspace_id = ? AND x.person_id = t.person_id AND x.state != 'clicked'
              ORDER BY x.occurred_at DESC LIMIT 1) AS last_direction,
            (SELECT COUNT(*) FROM suppression_keys sk
              WHERE sk.match_key = 'person:' || t.person_id
                AND (sk.scope = 'global' OR sk.workspace_id = ?)) AS suppressed,
            (SELECT r.id FROM recommendations r
              WHERE r.workspace_id = ? AND r.person_id = t.person_id AND r.status = 'pending'
                AND r.reply_to_interaction_id IS NOT NULL
              ORDER BY r.created_at DESC LIMIT 1) AS pending_reply_id
       FROM t
       JOIN people p ON p.id = t.person_id
       LEFT JOIN companies co ON co.id = p.current_company_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.last_at DESC
      LIMIT ?`,
    [
      workspaceId,
      workspaceId,
      workspaceId,
      workspaceId,
      workspaceId,
      workspaceId,
      workspaceId,
      workspaceId,
      ...args,
      options.limit,
    ],
  );
}

/** One conversation, oldest message first, with the answer waiting on it. */
export async function loadThread(db: Client, workspaceId: string, personId: string) {
  const person = await queryOne<{
    id: string;
    display_name: string;
    current_title: string | null;
    avatar_url: string | null;
    company_name: string | null;
    status: string;
  }>(
    db,
    `SELECT p.id, p.display_name, p.current_title, p.avatar_url, p.status,
            co.name AS company_name
       FROM people p LEFT JOIN companies co ON co.id = p.current_company_id
      WHERE p.id = ?`,
    [personId],
  );
  if (!person || person.status === 'deleted') return undefined;

  const messages = await queryAll<{
    id: string;
    direction: string;
    network: string;
    state: string;
    body: string | null;
    subject: string | null;
    draft_subject: string | null;
    contact_address: string | null;
    campaign_id: string | null;
    reply_label: string | null;
    reply_confidence: number | null;
    reply_label_source: string | null;
    reply_label_reason: string | null;
    occurred_at: string;
  }>(
    db,
    `SELECT i.id, i.direction, i.network, i.state, i.body, i.subject, i.contact_address,
            i.campaign_id, i.reply_label, i.reply_confidence, i.reply_label_source,
            i.reply_label_reason, i.occurred_at,
            (SELECT d.subject FROM actions a
               JOIN drafts d ON d.recommendation_id = a.recommendation_id
              WHERE a.id = i.action_id LIMIT 1) AS draft_subject
       FROM interactions i
      WHERE i.workspace_id = ? AND i.person_id = ? AND i.state != 'clicked'
      ORDER BY i.occurred_at ASC`,
    [workspaceId, personId],
  );
  if (messages.length === 0) return undefined;

  const firstOutbound = messages.find((m) => m.direction === 'outbound')?.id;

  const pending = await queryOne<{
    id: string;
    action: string;
    reason: string;
    reply_to_interaction_id: string;
    subject: string | null;
    body: string | null;
    checks_json: string | null;
    created_at: string;
  }>(
    db,
    `SELECT r.id, r.action, r.reason, r.reply_to_interaction_id, r.created_at,
            d.subject, d.body, d.checks_json
       FROM recommendations r
       LEFT JOIN drafts d ON d.recommendation_id = r.id
      WHERE r.workspace_id = ? AND r.person_id = ? AND r.status = 'pending'
        AND r.reply_to_interaction_id IS NOT NULL
      ORDER BY r.created_at DESC LIMIT 1`,
    [workspaceId, personId],
  );

  const suppressed = await queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM suppression_keys
      WHERE match_key = ? AND (scope = 'global' OR workspace_id = ?)`,
    [`person:${personId}`, workspaceId],
  );

  const status = conversationStatus({
    inbound: messages.filter((m) => m.direction === 'inbound').length,
    last_human_direction:
      [...messages].reverse().find((m) => m.direction === 'inbound' || m.direction === 'outbound')
        ?.direction ?? null,
  });

  return {
    person: {
      id: person.id,
      name: person.display_name,
      title: person.current_title,
      company: person.company_name,
      avatar_url: person.avatar_url,
    },
    status,
    suppressed: Number(suppressed?.n ?? 0) > 0,
    messages: messages.map((m) => ({
      id: m.id,
      from: m.direction === 'inbound' ? 'them' : m.direction === 'automated' ? 'automated' : 'us',
      network: m.network,
      state: m.state,
      subject: m.subject ?? m.draft_subject,
      body: m.body,
      address: m.contact_address,
      campaign_id: m.campaign_id,
      at: m.occurred_at,
      original: m.id === firstOutbound,
      label: isReplyLabel(m.reply_label)
        ? {
            label: m.reply_label,
            confidence: m.reply_confidence,
            source: m.reply_label_source,
            reason: m.reply_label_reason,
          }
        : null,
    })),
    pending_reply: pending
      ? {
          recommendation_id: pending.id,
          action: pending.action,
          reason: pending.reason,
          answers: pending.reply_to_interaction_id,
          subject: pending.subject,
          body: pending.body,
          checks: safeArray(pending.checks_json),
          created_at: pending.created_at,
        }
      : null,
  };
}

async function hasConversation(db: Client, workspaceId: string, personId: string) {
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM interactions WHERE workspace_id = ? AND person_id = ?`,
    [workspaceId, personId],
  );
  return Number(row?.n ?? 0) > 0;
}

async function latestCampaign(
  db: Client,
  workspaceId: string,
  personId: string,
): Promise<string | undefined> {
  const row = await queryOne<{ campaign_id: string }>(
    db,
    `SELECT campaign_id FROM interactions
      WHERE workspace_id = ? AND person_id = ? AND campaign_id IS NOT NULL
      ORDER BY occurred_at DESC LIMIT 1`,
    [workspaceId, personId],
  );
  if (row) return row.campaign_id;

  const member = await queryOne<{ campaign_id: string }>(
    db,
    `SELECT campaign_id FROM campaign_people WHERE workspace_id = ? AND person_id = ?
      ORDER BY updated_at DESC LIMIT 1`,
    [workspaceId, personId],
  );
  return member?.campaign_id;
}

async function lastSentSubject(
  db: Client,
  workspaceId: string,
  personId: string,
): Promise<string | undefined> {
  const row = await queryOne<{ subject: string | null }>(
    db,
    `SELECT d.subject FROM interactions i
       JOIN actions a ON a.id = i.action_id
       JOIN drafts d ON d.recommendation_id = a.recommendation_id
      WHERE i.workspace_id = ? AND i.person_id = ? AND i.direction = 'outbound'
      ORDER BY i.occurred_at DESC LIMIT 1`,
    [workspaceId, personId],
  );
  return row?.subject ?? undefined;
}

async function upsertDraft(
  db: Client,
  workspaceId: string,
  recommendationId: string,
  subject: string,
  body: string,
): Promise<void> {
  const stamp = now();
  const existing = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM drafts WHERE recommendation_id = ? LIMIT 1',
    [recommendationId],
  );

  if (existing) {
    await db.execute({
      sql: `UPDATE drafts SET subject = ?, body = ?, edited_by_user = 1, updated_at = ? WHERE id = ?`,
      args: [subject, body, stamp, existing.id],
    });
    return;
  }

  const draftId = newId('draft');
  await db.batch([
    {
      sql: `INSERT INTO drafts (id, workspace_id, recommendation_id, subject, body,
            grounded_signal_ids, checks_json, edited_by_user, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, '[]', '[]', 1, ?, ?)`,
      args: [draftId, workspaceId, recommendationId, subject, body, stamp, stamp],
    },
    {
      sql: 'UPDATE recommendations SET draft_id = ? WHERE id = ?',
      args: [draftId, recommendationId],
    },
  ]);
}

async function parse<T extends z.ZodTypeAny>(request: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  try {
    const text = await request.text();
    raw = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    throw ApiError.badRequest('request body must be valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.badRequest('request body failed validation', parsed.error.flatten());
  }
  return parsed.data;
}

function clampPage(raw: string | undefined): number {
  const value = Number.parseInt(raw ?? String(PAGE_DEFAULT), 10);
  if (!Number.isFinite(value)) return PAGE_DEFAULT;
  return Math.min(PAGE_MAX, Math.max(1, value));
}

function safeArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
