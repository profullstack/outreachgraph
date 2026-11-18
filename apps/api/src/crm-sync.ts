/**
 * The CRM learns from outreach (PRD §39).
 *
 * A deal is a relationship someone has actually touched, so the sync reads
 * what outreach did, not what it might do: the 20k-row prospect pipeline
 * (discovered, researched, awaiting approval) stays out. What comes in:
 *
 *   - a sent message (`interactions`, outbound, any network) makes or finds
 *     the person's deal at `contacted` and logs the message;
 *   - a human reply moves it to `replied` (or `lost` when triage labelled it
 *     not interested or an unsubscribe request);
 *   - a bounce marks a deal that never got past `contacted` as `lost`; an
 *     out-of-office or a link click is logged without moving the stage;
 *   - a suppression (`lead_stage_events` lost/suppressed) marks a
 *     contacted deal `lost`.
 *
 * Stages only move forward, and a deal someone closed (won or lost) is never
 * moved. Every copied entry carries a `source_ref`, unique per workspace, so
 * the sync is safe to re-run every tick and after a crash.
 *
 * Enrichment as it goes: a deal is filled from the person and company rows
 * (name, company, address) where it has nothing, and a deal made by hand or by
 * a booking is linked to the workspace's known person by email address.
 */

import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { isClosedStage, isCrmStage, type CrmStage } from '@outreachgraph/domain';
import { createDeal, writeActivity } from './crm';

const RANK: Record<CrmStage, number> = {
  lead: 0,
  contacted: 1,
  replied: 2,
  meeting: 3,
  proposal: 4,
  won: 5,
  lost: -1,
};

const NEGATIVE_LABELS = new Set(['not_interested', 'unsubscribe_request']);

/** Where a deal should go given what happened, or null to leave it. */
export function nextStageFor(current: CrmStage, event: CrmEvent): CrmStage | null {
  if (current === 'won') return null;
  if (event.kind === 'lost') {
    if (event.strong) return current === 'lost' ? null : 'lost';
    return current === 'lead' || current === 'contacted' ? 'lost' : null;
  }
  if (current === 'lost') return null;
  return RANK[event.stage] > RANK[current] ? event.stage : null;
}

export type CrmEvent =
  | { readonly kind: 'advance'; readonly stage: CrmStage }
  /** `strong`: the person said so (not interested), not just a bounce. */
  | { readonly kind: 'lost'; readonly strong: boolean };

interface InteractionRow {
  id: string;
  person_id: string;
  network: string;
  direction: string;
  state: string;
  subject: string | null;
  body: string | null;
  occurred_at: string;
  contact_address: string | null;
  reply_label: string | null;
  display_name: string | null;
  company_name: string | null;
  company_domain: string | null;
}

interface DealLite {
  id: string;
  stage: string;
  contact_name: string | null;
  contact_email: string | null;
  company: string | null;
  person_id: string | null;
}

function emailLike(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

function clip(text: string | null, max: number): string {
  const t = (text ?? '').replace(/\r/g, '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** What to log and how the stage should move for one interaction. */
export function describeInteraction(row: {
  network: string;
  direction: string;
  state: string;
  subject: string | null;
  body: string | null;
  reply_label: string | null;
}): { kind: string; body: string; event: CrmEvent | null } {
  const via = row.network === 'email' ? '' : ` on ${row.network}`;
  const subject = row.subject ? `“${row.subject}”` : '';
  if (row.direction === 'outbound') {
    return {
      kind: row.network === 'email' ? 'email' : 'note',
      body: [`Sent${via} ${subject}`.trim(), clip(row.body, 1500)].filter(Boolean).join('\n\n'),
      event: { kind: 'advance', stage: 'contacted' },
    };
  }
  if (row.state === 'clicked') {
    return { kind: 'note', body: `Clicked a link${via} ${subject}`.trim(), event: null };
  }
  if (row.direction === 'automated' || row.state === 'bounced' || row.state === 'auto_replied') {
    if (row.state === 'bounced' || row.reply_label === 'bounce') {
      return {
        kind: 'email',
        body: `Bounced${via}: the address did not accept the message.`,
        event: { kind: 'lost', strong: false },
      };
    }
    return {
      kind: 'email',
      body: [`Auto-reply${via} (${row.reply_label ?? 'automated'})`, clip(row.body, 500)]
        .filter(Boolean)
        .join('\n\n'),
      event: null,
    };
  }
  // A human reply.
  const label = row.reply_label ? ` · ${row.reply_label.replace(/_/g, ' ')}` : '';
  return {
    kind: 'email',
    body: [`Replied${via}${label} ${subject}`.trim(), clip(row.body, 4000)]
      .filter(Boolean)
      .join('\n\n'),
    event:
      row.reply_label && NEGATIVE_LABELS.has(row.reply_label)
        ? { kind: 'lost', strong: true }
        : { kind: 'advance', stage: 'replied' },
  };
}

async function moveStage(
  db: Client,
  workspaceId: string,
  deal: DealLite,
  event: CrmEvent,
  occurredAt: string,
): Promise<void> {
  const current = isCrmStage(deal.stage) ? deal.stage : 'lead';
  const next = nextStageFor(current, event);
  if (!next) return;
  const stamp = now();
  await db.execute({
    sql: `UPDATE crm_deals SET stage = ?, closed_at = ?, updated_at = ? WHERE id = ?`,
    args: [next, isClosedStage(next) ? stamp : null, stamp, deal.id],
  });
  await writeActivity(db, {
    workspaceId,
    dealId: deal.id,
    kind: 'stage',
    body: `${current} → ${next} (from outreach)`,
    occurredAt,
  });
  deal.stage = next;
}

const DEAL_LITE = `SELECT id, stage, contact_name, contact_email, company, person_id
  FROM crm_deals WHERE workspace_id = ? AND person_id = ?
  ORDER BY (stage IN ('won', 'lost')), updated_at DESC LIMIT 1`;

const DEAL_LITE_BY_EMAIL = `SELECT id, stage, contact_name, contact_email, company, person_id
  FROM crm_deals WHERE workspace_id = ? AND contact_email = ? AND person_id IS NULL
  ORDER BY (stage IN ('won', 'lost')), updated_at DESC LIMIT 1`;

/** Fills what the deal lacks from the person/company row. Never overwrites. */
async function enrichDeal(
  db: Client,
  deal: DealLite,
  from: { personId: string; name: string | null; email: string | null; company: string | null },
): Promise<void> {
  const patch: Record<string, string> = {};
  if (!deal.person_id) patch.person_id = from.personId;
  if (!deal.contact_name && from.name) patch.contact_name = from.name;
  if (!deal.contact_email && from.email) patch.contact_email = from.email;
  if (!deal.company && from.company) patch.company = from.company;
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  await db.execute({
    sql: `UPDATE crm_deals SET person_id = COALESCE(person_id, ?),
            contact_name = COALESCE(contact_name, ?), contact_email = COALESCE(contact_email, ?),
            company = COALESCE(company, ?), updated_at = ?
          WHERE id = ?`,
    args: [
      patch.person_id ?? null,
      patch.contact_name ?? null,
      patch.contact_email ?? null,
      patch.company ?? null,
      now(),
      deal.id,
    ],
  });
  Object.assign(deal, patch);
}

export interface CrmSyncResult {
  readonly interactions: number;
  readonly dealsCreated: number;
  readonly suppressions: number;
  readonly linked: number;
}

/**
 * Copies what outreach did into the workspace's CRM. Reads at most `limit`
 * new interactions per call, oldest first, so a backlog drains over a few
 * ticks instead of one long one.
 */
export async function syncCrmFromOutreach(
  db: Client,
  workspaceId: string,
  options: { readonly limit?: number } = {},
): Promise<CrmSyncResult> {
  const limit = options.limit ?? 2_000;
  let interactions = 0;
  let dealsCreated = 0;
  let suppressions = 0;
  let linked = 0;

  const rows = await queryAll<InteractionRow>(
    db,
    `SELECT i.id, i.person_id, i.network, i.direction, i.state, i.subject, i.body, i.occurred_at,
       i.contact_address, i.reply_label, p.display_name, c.name AS company_name,
       c.domain AS company_domain
     FROM interactions i
       JOIN people p ON p.id = i.person_id
       LEFT JOIN companies c ON c.id = p.current_company_id
       LEFT JOIN crm_activities a
         ON a.workspace_id = i.workspace_id AND a.source_ref = ('int:' || i.id)
     WHERE i.workspace_id = ? AND a.id IS NULL
     ORDER BY i.occurred_at ASC LIMIT ?`,
    [workspaceId, limit],
  );

  for (const row of rows) {
    const described = describeInteraction(row);
    const email = emailLike(row.contact_address);
    let deal =
      (await queryOne<DealLite>(db, DEAL_LITE, [workspaceId, row.person_id])) ??
      (email ? await queryOne<DealLite>(db, DEAL_LITE_BY_EMAIL, [workspaceId, email]) : undefined);

    if (!deal) {
      const created = await createDeal(
        db,
        workspaceId,
        {
          title: row.display_name || row.company_name || email || 'Unnamed contact',
          contactName: row.display_name,
          contactEmail: email,
          company: row.company_name ?? row.company_domain,
          personId: row.person_id,
          stage: described.event?.kind === 'advance' ? described.event.stage : 'contacted',
          source: 'outreach',
        },
        null,
      );
      deal = {
        id: created.id,
        stage: created.stage,
        contact_name: created.contact_name,
        contact_email: created.contact_email,
        company: created.company,
        person_id: created.person_id,
      };
      dealsCreated += 1;
    } else {
      await enrichDeal(db, deal, {
        personId: row.person_id,
        name: row.display_name,
        email,
        company: row.company_name ?? row.company_domain,
      });
    }

    const written = await writeActivity(db, {
      workspaceId,
      dealId: deal.id,
      kind: described.kind,
      body: described.body,
      occurredAt: row.occurred_at,
      sourceRef: `int:${row.id}`,
    });
    if (written && described.event) {
      await moveStage(db, workspaceId, deal, described.event, row.occurred_at);
    }
    interactions += 1;
  }

  // Suppressions: an opt-out or an undeliverable address closes a deal that
  // never got a reply. People never contacted have no deal and are skipped.
  const suppressed = await queryAll<{ id: string; person_id: string; occurred_at: string }>(
    db,
    `SELECT e.id, e.person_id, e.occurred_at
     FROM lead_stage_events e
       JOIN crm_deals d ON d.workspace_id = e.workspace_id AND d.person_id = e.person_id
       LEFT JOIN crm_activities a
         ON a.workspace_id = e.workspace_id AND a.source_ref = ('lse:' || e.id)
     WHERE e.workspace_id = ? AND e.stage = 'lost' AND a.id IS NULL
     ORDER BY e.occurred_at ASC LIMIT ?`,
    [workspaceId, limit],
  );
  for (const event of suppressed) {
    const deal = await queryOne<DealLite>(db, DEAL_LITE, [workspaceId, event.person_id]);
    if (!deal) continue;
    const written = await writeActivity(db, {
      workspaceId,
      dealId: deal.id,
      kind: 'note',
      body: 'Suppressed: opted out, or the address cannot be reached.',
      occurredAt: event.occurred_at,
      sourceRef: `lse:${event.id}`,
    });
    if (written) {
      await moveStage(db, workspaceId, deal, { kind: 'lost', strong: false }, event.occurred_at);
      suppressions += 1;
    }
  }

  // Deals made by hand or by a booking: link them to the person this
  // workspace already knows at that address, and fill name and company.
  const unlinked = await queryAll<
    DealLite & { pid: string; display_name: string | null; company_name: string | null }
  >(
    db,
    `SELECT d.id, d.stage, d.contact_name, d.contact_email, d.company, d.person_id,
       pe.person_id AS pid, p.display_name, c.name AS company_name
     FROM crm_deals d
       JOIN person_emails pe ON pe.workspace_id = d.workspace_id AND pe.address = d.contact_email
       JOIN people p ON p.id = pe.person_id
       LEFT JOIN companies c ON c.id = p.current_company_id
     WHERE d.workspace_id = ? AND d.person_id IS NULL AND d.contact_email IS NOT NULL
     LIMIT 500`,
    [workspaceId],
  );
  for (const row of unlinked) {
    await enrichDeal(db, row, {
      personId: row.pid,
      name: row.display_name,
      email: null,
      company: row.company_name,
    });
    linked += 1;
  }

  return { interactions, dealsCreated, suppressions, linked };
}

/** Workspaces with outreach the CRM has not seen yet. */
export async function workspacesNeedingCrmSync(db: Client): Promise<string[]> {
  const rows = await queryAll<{ workspace_id: string }>(
    db,
    `SELECT DISTINCT i.workspace_id
     FROM interactions i
       LEFT JOIN crm_activities a
         ON a.workspace_id = i.workspace_id AND a.source_ref = ('int:' || i.id)
     WHERE a.id IS NULL`,
  );
  return rows.map((r) => r.workspace_id);
}
