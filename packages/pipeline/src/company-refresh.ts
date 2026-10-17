/**
 * Re-reading the companies we already know, stalest first.
 *
 * A company is read once, when a crawl first finds it. Nothing returned to it:
 * a team page that hired, a title that changed, a new published inbox, none
 * of it reached the product. `reseed.ts` re-reads a campaign's *seed*; this
 * re-reads its *companies*, a few at a time on a slow clock, so the whole
 * book turns over roughly monthly without a spike.
 *
 * It queues ordinary `crawl_site` jobs (the crawler already follows the
 * team/about/contact links and the pipeline already recognises people it has
 * read before), under the `crawl:<host>` dedupe key the other intakes use,
 * filed under the campaign the company's people most recently belong to.
 * Nothing here calls a paid API: a crawl costs one cheap extraction call
 * (the chain's first model), and the paid lookups (ValueSERP, PDL) are not
 * re-run for anyone.
 *
 * It backs off when the queue is busy, so a user's own crawls always come
 * first: a workspace with more than `maxPending` crawls outstanding gets none.
 */

import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { enqueue } from './queue';

export interface CompanyRefreshOptions {
  /** Crawls to queue this run. */
  readonly limit: number;
  /** A company is stale once it has not been read for this long. */
  readonly staleDays?: number;
  /** Skip a workspace with at least this many crawls pending or running. */
  readonly maxPending?: number;
  readonly now?: Date;
}

export interface CompanyRefreshResult {
  readonly considered: number;
  readonly queued: number;
  readonly busyWorkspaces: number;
}

export async function refreshStaleCompanies(
  db: Client,
  options: CompanyRefreshOptions,
): Promise<CompanyRefreshResult> {
  const at = options.now ?? new Date();
  const cutoff = new Date(at.getTime() - (options.staleDays ?? 30) * 86_400_000).toISOString();
  const maxPending = options.maxPending ?? 25;
  if (options.limit <= 0) return { considered: 0, queued: 0, busyWorkspaces: 0 };

  // The stalest companies that some active campaign still holds people at.
  const stale = await queryAll<{ id: string; domain: string }>(
    db,
    `SELECT c.id, c.domain
       FROM companies c
      WHERE c.domain IS NOT NULL AND c.domain <> ''
        AND COALESCE(c.refreshed_at, c.updated_at) < ?
        AND EXISTS (SELECT 1 FROM people p
                      JOIN campaign_people cp ON cp.person_id = p.id
                      JOIN campaigns k ON k.id = cp.campaign_id
                     WHERE p.current_company_id = c.id AND k.status IN ('active', 'running'))
      ORDER BY COALESCE(c.refreshed_at, c.updated_at) ASC
      LIMIT ?`,
    [cutoff, options.limit * 2],
  );

  // Filed under the campaign that most recently touched one of its people.
  const rows: { id: string; domain: string; campaign_id?: string; workspace_id?: string }[] = [];
  for (const company of stale) {
    const link = await queryOne<{ campaign_id: string; workspace_id: string }>(
      db,
      `SELECT cp.campaign_id, k.workspace_id
         FROM people p
         JOIN campaign_people cp ON cp.person_id = p.id
         JOIN campaigns k ON k.id = cp.campaign_id
         JOIN workspaces w ON w.id = k.workspace_id
        WHERE p.current_company_id = ? AND k.status IN ('active', 'running')
          AND w.status = 'active'
        ORDER BY cp.updated_at DESC
        LIMIT 1`,
      [company.id],
    );
    rows.push({ ...company, ...(link ?? {}) });
  }

  const busy = new Map<string, boolean>();
  const isBusy = async (workspaceId: string) => {
    const known = busy.get(workspaceId);
    if (known !== undefined) return known;
    const row = await queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM jobs
        WHERE workspace_id = ? AND kind = 'crawl_site' AND status IN ('pending', 'running')`,
      [workspaceId],
    );
    const value = Number(row?.n ?? 0) >= maxPending;
    busy.set(workspaceId, value);
    return value;
  };

  let queued = 0;
  for (const row of rows) {
    if (queued >= options.limit) break;
    if (!row.campaign_id || !row.workspace_id) continue;
    if (await isBusy(row.workspace_id)) continue;
    const host = String(row.domain)
      .toLowerCase()
      .replace(/^www\./, '');
    const result = await enqueue(db, {
      workspaceId: row.workspace_id,
      kind: 'crawl_site',
      payload: { url: `https://${host}/`, campaignId: row.campaign_id, refresh: true },
      dedupeKey: `crawl:${host}`,
    });
    // Stamped either way: a dedupe hit means a crawl is already outstanding,
    // and the crawl itself stamps it again when it reads the company.
    await db.execute({
      sql: 'UPDATE companies SET refreshed_at = ? WHERE id = ?',
      args: [now(), row.id],
    });
    if (result.queued) queued += 1;
  }

  return {
    considered: rows.length,
    queued,
    busyWorkspaces: [...busy.values()].filter(Boolean).length,
  };
}
