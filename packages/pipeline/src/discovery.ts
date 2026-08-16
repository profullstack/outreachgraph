/**
 * The `discover_domains` job: a phrase becomes a queue of company sites.
 *
 * This is the front half of the keyword path. It runs as a job rather than in
 * the request that created the campaign because it is a model call followed by
 * up to fifty enqueues, and a signup form that hangs for thirty seconds while
 * that happens is a signup form people abandon.
 *
 * Nothing it produces is trusted. Every domain the model names is enqueued as
 * an ordinary `crawl_site` job and has to survive being fetched like any other
 * URL — a company that does not exist has no site to read, and drops out with
 * the same "could not be reached" as a typo would.
 */

import type { TextModel } from '@outreachgraph/ai';
import { discoverCompanies } from '@outreachgraph/ai';
import { now, queryOne, type Client } from '@outreachgraph/db';
import { enqueue } from './queue';
import type { QueuedJob } from './queue';

export interface DiscoveryJobDeps {
  readonly db: Client;
  /** Omit and discovery cannot run; the job fails loudly rather than silently. */
  readonly model?: TextModel;
  /** Cap on sites queued per discovery run. */
  readonly limit?: number;
}

export interface DiscoveryJobResult {
  readonly keyword: string;
  readonly campaignId: string;
  readonly found: number;
  readonly queued: number;
  readonly campaignName?: string;
}

/**
 * Expands one keyword into crawl jobs.
 *
 * A run that names nobody throws. Unlike a crawled page that legitimately
 * describes no people, "the model returned nothing" is a transient condition —
 * a capped key, a refusal, a bad parse — and the backoff exists so it can be
 * tried again once whatever was wrong is fixed. Silently completing would
 * reproduce the original bug this whole change is about: a campaign that
 * reports success and does nothing.
 */
export async function runDiscoveryJob(
  deps: DiscoveryJobDeps,
  job: QueuedJob,
): Promise<DiscoveryJobResult> {
  const { keyword, campaignId } = job.payload as { keyword?: string; campaignId?: string };

  if (!keyword) throw new Error('discover_domains needs a keyword');
  if (!campaignId) throw new Error('discover_domains needs a campaignId');

  if (!deps.model) {
    throw new Error('no model is configured, so a keyword cannot be expanded into companies');
  }

  // The offering grounds the search: "companies that would buy what you sell"
  // is a much better query than the keyword alone, and the workspace usually
  // already told us during setup.
  const offering = await queryOne<{ name: string; description: string | null }>(
    deps.db,
    `SELECT name, description FROM offerings WHERE workspace_id = ? ORDER BY created_at LIMIT 1`,
    [job.workspaceId],
  );

  const summary = offering
    ? [offering.name, offering.description].filter(Boolean).join(' — ')
    : undefined;

  const result = await discoverCompanies(deps.model, keyword, {
    limit: deps.limit ?? 25,
    ...(summary ? { offeringSummary: summary } : {}),
  });

  if (!result.ok) {
    throw new Error(`could not expand "${keyword}": ${result.reason ?? 'no reason given'}`);
  }

  let queued = 0;

  for (const company of result.companies) {
    const enqueued = await enqueue(deps.db, {
      workspaceId: job.workspaceId,
      kind: 'crawl_site',
      payload: { url: `https://${company.domain}`, campaignId },
      // The same domain surfacing in two campaigns is worth crawling twice —
      // it is scored per campaign — but the same domain twice in one discovery
      // run is not.
      dedupeKey: `crawl:${campaignId}:${company.domain}`,
      // Batched under the discovery job's own id so the intake screen can
      // report "12 of 25 sites read" against the thing the user actually
      // submitted, rather than against nothing.
      batchId: job.id,
    });

    if (enqueued.queued) queued += 1;
  }

  // The model's own name for the market is better than the raw phrase, and the
  // brief explains the campaign to whoever opens it later. Only filled in
  // where the campaign has not already been named by a human.
  if (result.campaignName || result.brief) {
    await deps.db.execute({
      sql: `UPDATE campaigns
               SET name = COALESCE(NULLIF(name, ''), ?),
                   brief = COALESCE(brief, ?),
                   updated_at = ?
             WHERE id = ? AND name = ?`,
      args: [result.campaignName ?? keyword, result.brief ?? null, now(), campaignId, keyword],
    });
  }

  return {
    keyword,
    campaignId,
    found: result.companies.length,
    queued,
    ...(result.campaignName ? { campaignName: result.campaignName } : {}),
  };
}
