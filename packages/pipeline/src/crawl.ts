/**
 * The `crawl_site` job: one company URL to approval cards.
 *
 * This lives in the package rather than in the server's tick because it is the
 * seam where four separately-tested pieces meet — the queue, the crawler, the
 * fan-out and the chain — and a seam nothing can call is a seam nothing can
 * test. The server now supplies its dependencies and calls this.
 */

import { newId } from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
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
  /** True when a mailer is configured; see `PipelineOptions.emailSendingEnabled`. */
  readonly emailSendingEnabled?: boolean;
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
  const { url, campaignId } = job.payload as { url?: string; campaignId?: string };
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

  // The campaign this crawl belongs to, not merely the workspace's oldest one.
  //
  // Filing every crawl under `ORDER BY created_at LIMIT 1` meant that a
  // workspace running two campaigns scored both of their prospects against the
  // first campaign's offering, and the second campaign stayed permanently
  // empty. The payload carries the right answer whenever the intake created
  // one; the fallback is only for jobs queued before this existed.
  const campaign = campaignId
    ? await queryOne<{ id: string }>(
        deps.db,
        `SELECT id FROM campaigns WHERE id = ? AND workspace_id = ?`,
        [campaignId, job.workspaceId],
      )
    : await queryOne<{ id: string }>(
        deps.db,
        `SELECT id FROM campaigns WHERE workspace_id = ? ORDER BY created_at LIMIT 1`,
        [job.workspaceId],
      );

  if (!campaign) throw new Error(`workspace ${job.workspaceId} has no campaign`);

  // The company and its shared inbox, recorded whether or not anyone was named.
  //
  // Three things were wrong here before, and each on its own was enough to
  // make the keyword path produce nothing at all:
  //
  //   - The domain was read only from the extracted company, which is often
  //     absent even when the crawl plainly succeeded. The host actually
  //     fetched is always known, so it is the better source.
  //   - The row was only ever written by the person chain, so a site that
  //     names nobody stored nothing — no company, no address — despite having
  //     published a perfectly good `info@`.
  //   - **This ran after the fan-out.** The recommendation engine asks whether
  //     a person is reachable while that person is being processed, so an
  //     inbox recorded afterwards was invisible to every lead on the page. Six
  //     real practices had their address stored and still produced zero
  //     recommendations. It has to happen first.
  //
  // `COALESCE` keeps the first address found rather than letting a later crawl
  // of a deeper page overwrite the homepage's, which is usually the one the
  // company actually wants used.
  const domain = result.company.domain ?? hostOf(result.finalUrl);

  if (domain && (result.contactEmail || result.company.name)) {
    const stamp = now();
    const existing = await queryOne<{ id: string }>(
      deps.db,
      `SELECT id FROM companies WHERE domain = ?`,
      [domain],
    );

    if (existing) {
      await deps.db.execute({
        sql: `UPDATE companies SET contact_email = COALESCE(contact_email, ?), updated_at = ?
               WHERE id = ?`,
        args: [result.contactEmail ?? null, stamp, existing.id],
      });
    } else {
      await deps.db.execute({
        sql: `INSERT INTO companies (id, name, domain, technologies, contact_email,
              created_at, updated_at)
              VALUES (?, ?, ?, '[]', ?, ?, ?)`,
        args: [
          newId('company'),
          result.company.name ?? domain,
          domain,
          result.contactEmail ?? null,
          stamp,
          stamp,
        ],
      });
    }
  }

  let queued = 0;
  for (const candidate of result.people) {
    await runPipelineForCandidate(
      {
        db: deps.db,
        workspaceId: job.workspaceId,
        campaignId: campaign.id,
        providers: deps.providers,
        ...(deps.model ? { model: deps.model } : {}),
        ...(deps.emailSendingEnabled ? { emailSendingEnabled: true } : {}),
      },
      candidate,
      {
        capabilities: deps.site.capabilities(),
        // The page they were named on. Becomes the grounding evidence for
        // anything written to them, and without it the recommendation engine
        // has no trigger and proposes nothing at all.
        sourceUrl: result.finalUrl,
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

/** The host actually fetched, which is known even when extraction found little. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return undefined;
  }
}
