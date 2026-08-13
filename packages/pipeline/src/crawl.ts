/**
 * The `crawl_site` job: one company URL to approval cards.
 *
 * This lives in the package rather than in the server's tick because it is the
 * seam where four separately-tested pieces meet — the queue, the crawler, the
 * fan-out and the chain — and a seam nothing can call is a seam nothing can
 * test. The server now supplies its dependencies and calls this.
 */

import { queryOne, type Client } from '@outreachgraph/db';
import type { PersonEnrichmentProvider, SiteProvider } from '@outreachgraph/providers';
import type { TextModel } from '@outreachgraph/ai';
import { runPipelineForCandidate } from './pipeline';
import type { QueuedJob } from './queue';

export interface CrawlJobDeps {
  readonly db: Client;
  readonly site: SiteProvider;
  /** Consulted per person once a candidate exists. */
  readonly providers: readonly PersonEnrichmentProvider[];
  readonly model?: TextModel;
}

export interface CrawlJobResult {
  readonly url: string;
  readonly outcome: string;
  readonly companyName?: string;
  readonly peopleFound: number;
  readonly peopleQueued: number;
  readonly usedSignals: readonly string[];
}

/**
 * Runs one crawl job.
 *
 * A page that names nobody is a completed job, not a failed one: homepages
 * routinely describe a company without naming a person, and retrying that four
 * more times would spend the crawl budget re-reading a page whose answer will
 * not change. The same holds for a refusal — robots, a 404, a PDF — which is
 * the site's answer rather than a transient fault.
 *
 * A genuine fault (no campaign to file people under, a database error) still
 * throws, because those are worth retrying and worth seeing in `last_error`.
 */
export async function runCrawlJob(deps: CrawlJobDeps, job: QueuedJob): Promise<CrawlJobResult> {
  const { url } = job.payload as { url?: string };
  if (!url) throw new Error('crawl_site needs a url');

  const result = await deps.site.crawl(url);

  if (result.outcome !== 'ok') {
    return { url, outcome: result.outcome, peopleFound: 0, peopleQueued: 0, usedSignals: [] };
  }

  // A page that names nobody is finished; a page nobody was able to read is
  // not. Both arrive here as `people: []`, and calling the second one done is
  // how an expired model key turned into "the URL box does nothing" — every
  // batch reporting success, every prospect list staying empty, and no error
  // anywhere to explain it. Throwing puts the reason in `last_error`, where
  // the batch view already shows it, and lets the backoff retry once the key
  // works again.
  if (result.people.length === 0 && result.extractionUnavailable) {
    throw new Error(`could not read people from ${url}: ${result.extractionUnavailable}`);
  }

  const campaign = await queryOne<{ id: string }>(
    deps.db,
    `SELECT id FROM campaigns WHERE workspace_id = ? ORDER BY created_at LIMIT 1`,
    [job.workspaceId],
  );

  if (!campaign) throw new Error(`workspace ${job.workspaceId} has no campaign`);

  let queued = 0;
  for (const candidate of result.people) {
    await runPipelineForCandidate(
      {
        db: deps.db,
        workspaceId: job.workspaceId,
        campaignId: campaign.id,
        providers: deps.providers,
        ...(deps.model ? { model: deps.model } : {}),
      },
      candidate,
      {
        capabilities: deps.site.capabilities(),
        // No anchor network: nobody named on a company page is *proven* to be
        // that person, so every identity found there is a claim the resolver
        // has to weigh rather than a fact.
      },
    );
    queued += 1;
  }

  return {
    url,
    outcome: 'ok',
    ...(result.company.name ? { companyName: result.company.name } : {}),
    peopleFound: result.people.length,
    peopleQueued: queued,
    usedSignals: result.usedSignals,
  };
}
