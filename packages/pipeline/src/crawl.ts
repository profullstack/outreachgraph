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
import {
  competitorMatches,
  type CandidateIdentity,
  type DetectedTechnology,
  type PersonCandidate,
  type PersonEnrichmentProvider,
  type SiteProvider,
} from '@outreachgraph/providers';
import type { TextModel } from '@outreachgraph/ai';
import { emitEvent } from './events';
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
  /** True when the page named nobody and its published inbox became the lead. */
  readonly inboxLead?: boolean;
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

  await emitEvent(deps.db, {
    workspaceId: job.workspaceId,
    ...(campaignId ? { campaignId } : {}),
    phase: 'crawl',
    message: `Reading ${displayUrl(url)}`,
    detail: { url },
  });

  const result = await deps.site.crawl(url);

  if (result.outcome !== 'ok') {
    // A refusal is the site's answer, not a fault — but it is the single most
    // common reason a campaign looks like it did nothing, so it is reported at
    // `warn` rather than swallowed.
    await emitEvent(deps.db, {
      workspaceId: job.workspaceId,
      ...(campaignId ? { campaignId } : {}),
      phase: 'crawl',
      level: 'warn',
      message: `${displayUrl(url)} could not be read (${result.outcome})`,
      detail: { url, outcome: result.outcome },
    });

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

  // A page worth recording an inbox from is worth recording its profiles from,
  // so the company row is written whenever the page named the company at all —
  // the socials are frequently the only contact route a site publishes.
  const worthRecording =
    result.contactEmail || result.company.name || result.company.identities.length > 0;

  if (domain && worthRecording) {
    const stamp = now();
    const existing = await queryOne<{ id: string }>(
      deps.db,
      `SELECT id FROM companies WHERE domain = ?`,
      [domain],
    );

    let companyId: string;

    // What the site runs, merged with what earlier crawls found, so a deeper
    // page never erases the homepage's chat widget.
    const detected = (result.technologies ?? []).map((tech) => tech.name);

    if (existing) {
      companyId = existing.id;
      const prior = await queryOne<{ technologies: string | null }>(
        deps.db,
        'SELECT technologies FROM companies WHERE id = ?',
        [existing.id],
      );
      const merged = [...new Set([...parseNames(prior?.technologies), ...detected])];
      await deps.db.execute({
        sql: `UPDATE companies SET contact_email = COALESCE(contact_email, ?), technologies = ?,
              updated_at = ? WHERE id = ?`,
        args: [result.contactEmail ?? null, JSON.stringify(merged), stamp, existing.id],
      });
    } else {
      companyId = newId('company');
      await deps.db.execute({
        sql: `INSERT INTO companies (id, name, domain, technologies, contact_email,
              created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          companyId,
          result.company.name ?? domain,
          domain,
          JSON.stringify(detected),
          result.contactEmail ?? null,
          stamp,
          stamp,
        ],
      });
    }

    await recordCompanyIdentities(deps.db, companyId, result, stamp);
    await recordCompetitorSignals(deps.db, {
      workspaceId: job.workspaceId,
      campaignId: campaign.id,
      companyId,
      companyName: result.company.name ?? domain,
      url: result.finalUrl,
      technologies: result.technologies ?? [],
      at: stamp,
    });
  }

  // A page that names nobody but publishes an inbox is still a way in.
  //
  // This was the one shape that produced nothing at all. The company row and
  // its `support@` were written above, correctly, and then sat there: a
  // recommendation only ever hangs off a person, so a family-run store whose
  // site says "we" throughout ended as a company with an address and an empty
  // queue. The inbox is queued as a lead of its own kind: the same chain,
  // policy, approval and shared-inbox limits as a named person, with the
  // composer told it is writing to a team and the enrichment sweeps told to
  // leave it alone. It is only ever done when the page named nobody; a named
  // person is always the better lead and already reaches that inbox.
  const inboxLead = result.people.length === 0 && Boolean(result.contactEmail) && Boolean(domain);

  await emitEvent(deps.db, {
    workspaceId: job.workspaceId,
    campaignId: campaign.id,
    phase: 'crawl',
    level: result.people.length > 0 || result.contactEmail ? 'success' : 'warn',
    message: describeCrawl(
      result.company.name ?? domain ?? url,
      result.people.length,
      result.contactEmail,
      inboxLead,
    ),
    detail: {
      url,
      ...(result.company.name ? { company: result.company.name } : {}),
      people: result.people.length,
      contactEmail: result.contactEmail ?? null,
      signals: result.usedSignals,
    },
  });

  let queued = 0;
  let inboxLeadQueued = false;

  if (inboxLead && result.contactEmail && domain) {
    const inboxCandidate: PersonCandidate = {
      kind: 'company_inbox',
      fullName: result.company.name ?? domain,
      companyName: result.company.name ?? domain,
      companyDomain: domain,
      identities: [],
      observedAt: now(),
    };

    const outcome = await runPipelineForCandidate(
      {
        db: deps.db,
        workspaceId: job.workspaceId,
        campaignId: campaign.id,
        providers: deps.providers,
        ...(deps.model ? { model: deps.model } : {}),
        ...(deps.emailSendingEnabled ? { emailSendingEnabled: true } : {}),
      },
      inboxCandidate,
      {
        capabilities: deps.site.capabilities(),
        sourceUrl: result.finalUrl,
        inbox: {
          address: result.contactEmail,
          ...(result.company.description ? { description: result.company.description } : {}),
        },
      },
    );

    inboxLeadQueued = outcome.stage !== 'stopped';
  }

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
    ...(inboxLeadQueued ? { inboxLead: true } : {}),
    usedSignals: result.usedSignals,
  };
}

/**
 * Stores the social profiles the page published about the company.
 *
 * The extractor has always returned these and nothing ever read them, so every
 * crawl so far parsed a footer full of profile links and kept none of them.
 * They are stored against the *company*, never against the people found on the
 * same page: a company's `@handle` is the company's, and copying it onto an
 * employee's row would be a merge with no evidence behind it (PRD §14.1).
 *
 * `website` is skipped — the company already has a domain, and a self-link is
 * not a second way to reach anyone.
 *
 * Failures here are logged rather than thrown. A profile link is a bonus on
 * top of the crawl; losing one is not worth failing a job that found people
 * and an inbox, and the unique index means the common failure is a duplicate
 * this is trying to ignore anyway.
 */
async function recordCompanyIdentities(
  db: Client,
  companyId: string,
  result: {
    readonly finalUrl: string;
    readonly company: { readonly identities: readonly CandidateIdentity[] };
  },
  stamp: string,
): Promise<void> {
  for (const identity of result.company.identities) {
    if (identity.network === 'website' || !identity.handle) continue;

    try {
      await db.execute({
        // The conflict target is the unique index, so a re-crawl refreshes when
        // it was last seen rather than appending the same link again.
        sql: `INSERT INTO company_identities (id, company_id, network, handle, profile_url,
              confidence, source_url, first_seen_at, last_seen_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(company_id, network, handle) DO UPDATE SET
                last_seen_at = excluded.last_seen_at,
                profile_url = COALESCE(company_identities.profile_url, excluded.profile_url),
                confidence = max(company_identities.confidence, excluded.confidence)`,
        args: [
          newId('companyIdentity'),
          companyId,
          identity.network,
          identity.handle,
          identity.profileUrl ?? null,
          identity.providerConfidence ?? 0.6,
          result.finalUrl,
          stamp,
          stamp,
        ],
      });
    } catch (error) {
      console.warn(
        `could not record ${identity.network} identity for ${companyId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/** The host, for a progress line nobody wants to read a full URL in. */
function displayUrl(url: string): string {
  return hostOf(url) ?? url;
}

/**
 * What the crawl found, in one line.
 *
 * "Nobody named, but info@ is published" and "nothing at all" look the same in
 * a count and mean completely different things for whether outreach can happen,
 * so they are worded differently here.
 */
function describeCrawl(
  subject: string,
  people: number,
  contactEmail?: string,
  inboxLead = false,
): string {
  if (people > 0) {
    return `${subject}: found ${people} ${people === 1 ? 'person' : 'people'}`;
  }
  if (!contactEmail) return `${subject}: no people and no contact address on the page`;
  return inboxLead
    ? `${subject}: nobody named, so ${contactEmail} is the lead`
    : `${subject}: nobody named, but ${contactEmail} is published`;
}

/** The host actually fetched, which is known even when extraction found little. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return undefined;
  }
}

function parseNames(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * A company whose site runs a competitor the product names is a switcher
 * prospect (Hunter's Technology filter). Recorded as a company-level
 * `technology_adoption` signal whose evidence is the marker on the page, so
 * the composer may say "your site runs X" and nothing it cannot back.
 * One signal per company and competitor.
 */
export async function recordCompetitorSignals(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly campaignId: string;
    readonly companyId: string;
    readonly companyName: string;
    readonly url: string;
    readonly technologies: readonly DetectedTechnology[];
    readonly at: string;
  },
): Promise<number> {
  if (input.technologies.length === 0) return 0;
  const offering = await queryOne<{ competitors: string | null }>(
    db,
    `SELECT o.competitors FROM campaigns c JOIN offerings o ON o.id = c.offering_id WHERE c.id = ?`,
    [input.campaignId],
  );
  const matches = competitorMatches(input.technologies, parseNames(offering?.competitors));
  let written = 0;
  for (const tech of matches) {
    const summary = `${input.companyName}'s site runs ${tech.name}`;
    const exists = await queryOne<{ id: string }>(
      db,
      `SELECT id FROM signals WHERE workspace_id = ? AND company_id = ?
        AND signal_type = 'technology_adoption' AND summary = ?`,
      [input.workspaceId, input.companyId, summary],
    );
    if (exists) continue;
    await db.execute({
      sql: `INSERT INTO signals (id, workspace_id, person_id, company_id, network, signal_type,
            subtype, summary, evidence, source_url, source_timestamp, observed_at, confidence,
            relevance, sentiment)
            VALUES (?, ?, NULL, ?, 'website', 'technology_adoption', 'competitor', ?, ?, ?, ?, ?,
                    0.9, 0.8, 'neutral')`,
      args: [
        newId('signal'),
        input.workspaceId,
        input.companyId,
        summary,
        `The page at ${input.url} loads ${tech.evidence}`,
        input.url,
        input.at,
        input.at,
      ],
    });
    written += 1;
  }
  return written;
}
