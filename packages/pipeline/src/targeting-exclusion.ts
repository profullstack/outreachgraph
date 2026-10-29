/**
 * A campaign's exclusions as a hard gate, not a score.
 *
 * `scoreIcpFit` already says `excluded` when a title or industry contains an
 * exclusion, but the pipeline only used that as a number: the person was still
 * marked qualified and carded, and every later re-decision (an address found,
 * a re-crawl) brought them back. The CoinPay telehealth campaign (2026-10-29)
 * excluded "nurse", "physician" and "lcsw", and still queued email cards for
 * nurse practitioners and therapists after they had been set aside by hand.
 *
 * Here an excluded member is set aside with the reason, any card still waiting
 * for them is skipped (never deleted), and no new card is written. Someone
 * already written to keeps their place, as with the company cap, so a
 * conversation that has started is never stranded.
 */

import { EMPTY_FILTERS } from '@outreachgraph/domain';
import { queryOne, type Client } from '@outreachgraph/db';
import { scoreIcpFit } from '@outreachgraph/scoring';
import { recordStatus } from './stages';

/**
 * Why the campaign's exclusions rule this person out, or undefined when they
 * do not (or the campaign has none). Same matching as the ICP score.
 */
export async function targetingExclusion(
  db: Client,
  campaignId: string,
  personId: string,
): Promise<string | undefined> {
  const filters = await queryOne<{ exclusions: string | null }>(
    db,
    'SELECT exclusions FROM campaign_filters WHERE campaign_id = ?',
    [campaignId],
  );
  const exclusions = parseArray(filters?.exclusions);
  if (exclusions.length === 0) return undefined;

  const person = await queryOne<{ title: string | null; industry: string | null }>(
    db,
    `SELECT p.current_title AS title, c.industry AS industry
       FROM people p LEFT JOIN companies c ON c.id = p.current_company_id
      WHERE p.id = ?`,
    [personId],
  );
  if (!person) return undefined;

  const fit = scoreIcpFit(
    {
      ...(person.title ? { title: person.title } : {}),
      ...(person.industry ? { industry: person.industry } : {}),
    },
    { ...EMPTY_FILTERS, exclusions },
  );
  return fit.excluded ? fit.missed[0] : undefined;
}

/**
 * Sets an excluded member aside. Returns the reason when it did, so the caller
 * writes no card; undefined when the person may be carded.
 */
export async function setAsideIfExcluded(
  db: Client,
  workspaceId: string,
  campaignId: string,
  personId: string,
): Promise<string | undefined> {
  const reason = await targetingExclusion(db, campaignId, personId);
  if (!reason) return undefined;

  const contacted = await queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM actions a JOIN recommendations r ON r.id = a.recommendation_id
      WHERE r.campaign_id = ? AND a.person_id = ? AND a.status IN ('completed', 'queued')`,
    [campaignId, personId],
  );
  if (Number(contacted?.n ?? 0) > 0) return undefined;

  await db.execute({
    sql: `UPDATE recommendations SET status = 'skipped'
           WHERE campaign_id = ? AND person_id = ? AND status = 'pending'`,
    args: [campaignId, personId],
  });
  await recordStatus(db, {
    workspaceId,
    campaignId,
    personId,
    status: 'unqualified',
    reason,
  });
  return reason;
}

function parseArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter((s) => s.trim() !== '') : [];
  } catch {
    return [];
  }
}
