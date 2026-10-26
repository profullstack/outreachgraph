/**
 * At most N people per company in a campaign.
 *
 * A team-page crawl names everyone: the Engineering Contracts campaign held
 * 201 people from linear.app, 103 from todoist.com and 80 from buffer.com
 * (2026-10-26), which is a list of colleagues, not of buyers, and the address
 * search and the composer spent their budgets on all of them. A campaign
 * whose budget sets `maxPeoplePerCompany` keeps the best-ranked few at each
 * company (`engineeringBuyerRank`: CTO and engineering leadership first) and
 * excludes the rest: their membership says `excluded` with the reason, and
 * any card still waiting for them is skipped, never deleted.
 *
 * Someone already written to always keeps their place, ahead of rank, so the
 * cap never strands a conversation that has started.
 */

import { engineeringBuyerRank } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';

export const COMPANY_CAP_REASON = 'company cap';

/** The campaign's per-company cap, or undefined when it has none. */
export async function campaignCompanyCap(
  db: Client,
  campaignId: string,
): Promise<number | undefined> {
  const row = await queryOne<{ budget_json: string | null }>(
    db,
    'SELECT budget_json FROM campaigns WHERE id = ?',
    [campaignId],
  );
  try {
    const value = (JSON.parse(row?.budget_json || '{}') as Record<string, unknown>)
      .maxPeoplePerCompany;
    return typeof value === 'number' && value >= 1 ? Math.floor(value) : undefined;
  } catch {
    return undefined;
  }
}

export interface CompanyCapResult {
  readonly companies: number;
  readonly kept: number;
  readonly excluded: number;
  readonly cardsSkipped: number;
}

/**
 * Applies the cap to every company in the campaign, or to one domain.
 * Idempotent: a second pass over the same members changes nothing.
 */
export async function enforceCompanyCap(
  db: Client,
  input: {
    readonly campaignId: string;
    readonly maxPerCompany: number;
    /** Only this company's members, after a crawl of it. */
    readonly domain?: string | undefined;
  },
): Promise<CompanyCapResult> {
  const members = await queryAll<{
    person_id: string;
    company_id: string;
    title: string | null;
    status: string;
    reason: string | null;
    contacted: number;
    has_address: number;
  }>(
    db,
    `SELECT cp.person_id, p.current_company_id AS company_id, p.current_title AS title, cp.status, cp.status_reason AS reason,
            (SELECT COUNT(*) FROM actions a JOIN recommendations r ON r.id = a.recommendation_id
              WHERE r.campaign_id = cp.campaign_id AND a.person_id = cp.person_id
                AND a.status IN ('completed', 'queued')) AS contacted,
            (CASE WHEN EXISTS (SELECT 1 FROM person_emails pe WHERE pe.person_id = cp.person_id)
                    OR EXISTS (SELECT 1 FROM social_identities si
                                WHERE si.person_id = cp.person_id AND si.network = 'email')
                  THEN 1 ELSE 0 END) AS has_address
       FROM campaign_people cp
       JOIN people p ON p.id = cp.person_id
       ${input.domain ? 'JOIN companies co ON co.id = p.current_company_id' : ''}
      WHERE cp.campaign_id = ? AND p.current_company_id IS NOT NULL
        AND cp.status != 'suppressed'
        ${input.domain ? 'AND co.domain = ?' : ''}`,
    input.domain ? [input.campaignId, input.domain] : [input.campaignId],
  );

  const byCompany = new Map<string, typeof members>();
  for (const member of members) {
    const list = byCompany.get(member.company_id) ?? [];
    list.push(member);
    byCompany.set(member.company_id, list);
  }

  let kept = 0;
  let excluded = 0;
  let cardsSkipped = 0;
  const stamp = now();
  for (const list of byCompany.values()) {
    const ranked = [...list].sort(
      (a, b) =>
        Number(b.contacted > 0) - Number(a.contacted > 0) ||
        engineeringBuyerRank(a.title) - engineeringBuyerRank(b.title) ||
        Number(b.has_address) - Number(a.has_address) ||
        a.person_id.localeCompare(b.person_id),
    );
    for (const [index, member] of ranked.entries()) {
      const keep = index < input.maxPerCompany || member.contacted > 0;
      if (keep) {
        kept += 1;
        // Back in when a better-ranked colleague left (suppressed, deleted).
        if (member.status === 'unqualified' && member.reason === COMPANY_CAP_REASON) {
          await db.execute({
            sql: `UPDATE campaign_people SET status = 'qualified', status_reason = NULL, updated_at = ?
                   WHERE campaign_id = ? AND person_id = ? AND status = 'unqualified'
                     AND status_reason = ?`,
            args: [stamp, input.campaignId, member.person_id, COMPANY_CAP_REASON],
          });
        }
        continue;
      }
      excluded += 1;
      if (member.status !== 'unqualified') {
        await db.execute({
          sql: `UPDATE campaign_people SET status = 'unqualified', status_reason = ?, updated_at = ?
                 WHERE campaign_id = ? AND person_id = ?`,
          args: [COMPANY_CAP_REASON, stamp, input.campaignId, member.person_id],
        });
      }
      const skipped = await db.execute({
        sql: `UPDATE recommendations SET status = 'skipped'
               WHERE campaign_id = ? AND person_id = ? AND status = 'pending'`,
        args: [input.campaignId, member.person_id],
      });
      cardsSkipped += skipped.rowsAffected;
    }
  }

  return { companies: byCompany.size, kept, excluded, cardsSkipped };
}

/** Whether a person is held out of a campaign by its company cap. */
export async function excludedByCompanyCap(
  db: Client,
  campaignId: string,
  personId: string,
): Promise<boolean> {
  const row = await queryOne<{ status: string; status_reason: string | null }>(
    db,
    'SELECT status, status_reason FROM campaign_people WHERE campaign_id = ? AND person_id = ?',
    [campaignId, personId],
  );
  return row?.status === 'unqualified' && row.status_reason === COMPANY_CAP_REASON;
}
