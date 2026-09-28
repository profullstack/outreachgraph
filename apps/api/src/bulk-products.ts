/**
 * Starting many products at once, one per website.
 *
 * Setup describes one product at a time: read its site, draft the offering,
 * the buyer and the voice, confirm, save. That is right for a workspace that
 * sells one thing and far too slow for one that sells fifty — a portfolio
 * owner pasting their whole list would sit through fifty rounds of the same
 * form, each waiting half a minute on a model.
 *
 * So the list goes in once and each site becomes a job. The job does what the
 * setup screen does, minus the human confirmation in the middle, and then does
 * the step setup leaves for later: it gives the product's campaign a market to
 * search and queues the search. Every product comes out the other end with a
 * campaign that is already looking for buyers.
 *
 * Skipping the confirmation is the trade. The draft is the model's reading of
 * a marketing page and is saved as-is; the product page is where it gets
 * corrected, and nothing is sent without approval unless the caller also
 * asked for autopilot.
 */

import { draftProfile, type ProfileDraft, type TextModel } from '@outreachgraph/ai';
import { workspaceProfileSchema } from '@outreachgraph/contracts';
import { newId, toHostname } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { emitEvent, enqueue, type QueuedJob } from '@outreachgraph/pipeline';
import { SiteProvider } from '@outreachgraph/providers';
import { saveWorkspaceProfile } from './workspace-profile';

/** Sites accepted in one submission. Enough for a portfolio, not a scrape. */
export const MAX_BULK_DOMAINS = 100;

export interface ParsedDomains {
  /** Hostnames, lower-cased, `www.` dropped, first occurrence order. */
  readonly domains: readonly string[];
  /** What the person typed that is not a website, verbatim. */
  readonly invalid: readonly string[];
}

/**
 * Reads a pasted list: one per line, or separated by commas or spaces.
 *
 * Accepts an array too, for API callers that already split it. Duplicates are
 * dropped here rather than left to the queue's dedupe, so the count the person
 * sees back is the number of products they will actually get.
 */
export function parseDomainList(input: unknown): ParsedDomains {
  const parts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value !== 'string') return;
    for (const part of value.split(/[\s,;]+/)) if (part.trim()) parts.push(part.trim());
  };

  if (Array.isArray(input)) input.forEach(collect);
  else collect(input);

  const seen = new Set<string>();
  const domains: string[] = [];
  const invalid: string[] = [];

  for (const part of parts) {
    // Every entry is declared to be a site, so any real-looking TLD will do.
    const host = toHostname(part, { anyTld: true });
    if (!host) {
      invalid.push(part);
      continue;
    }
    if (seen.has(host)) continue;
    seen.add(host);
    domains.push(host);
  }

  return { domains, invalid };
}

/** The hostname an offering was set up from, or undefined when it has none. */
function hostOf(url: string | null): string | undefined {
  return url ? toHostname(url, { anyTld: true }) : undefined;
}

export interface ExistingProduct {
  readonly domain: string;
  readonly offeringId: string;
  readonly name: string;
}

/**
 * Products this workspace already sells, keyed by the site they came from.
 *
 * Matched on hostname, not the stored string: setup saves whatever URL the
 * crawler landed on, so `https://www.acme.com/` has to match `acme.com`.
 */
async function existingProducts(
  db: Client,
  workspaceId: string,
): Promise<Map<string, ExistingProduct>> {
  const rows = await queryAll<{ id: string; name: string; url: string | null }>(
    db,
    `SELECT o.id, o.name, o.url FROM offerings o
      WHERE o.workspace_id = ? AND o.url IS NOT NULL
        AND EXISTS (SELECT 1 FROM campaigns c
                     WHERE c.offering_id = o.id AND c.status != 'archived')
      ORDER BY o.created_at ASC`,
    [workspaceId],
  );

  const byHost = new Map<string, ExistingProduct>();
  for (const row of rows) {
    const host = hostOf(row.url);
    if (host && !byHost.has(host)) {
      byHost.set(host, { domain: host, offeringId: row.id, name: row.name });
    }
  }
  return byHost;
}

export interface BulkProductsResult {
  /** Groups the jobs; `GET /batches/:id` reports each site's progress. */
  readonly batchId: string;
  readonly queued: readonly string[];
  /** Already a product here, so left alone rather than duplicated. */
  readonly existing: readonly ExistingProduct[];
  readonly invalid: readonly string[];
}

export class BulkProductsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkProductsError';
  }
}

/**
 * Queues one setup job per new site.
 *
 * Returns immediately. Each job is a crawl plus two model calls, so fifty of
 * them take the worker minutes; the caller watches the batch instead.
 */
export async function queueBulkProducts(
  db: Client,
  workspaceId: string,
  input: unknown,
  options: { autopilot?: boolean } = {},
): Promise<BulkProductsResult> {
  const parsed = parseDomainList(input);

  if (parsed.domains.length === 0) {
    throw new BulkProductsError(
      parsed.invalid.length > 0
        ? `none of those look like websites: ${parsed.invalid.slice(0, 5).join(', ')}`
        : 'enter at least one website',
    );
  }
  if (parsed.domains.length > MAX_BULK_DOMAINS) {
    throw new BulkProductsError(
      `that is ${parsed.domains.length} sites; send at most ${MAX_BULK_DOMAINS} at a time`,
    );
  }

  const known = await existingProducts(db, workspaceId);
  const batchId = newId('job');
  const queued: string[] = [];
  const existing: ExistingProduct[] = [];

  for (const domain of parsed.domains) {
    const product = known.get(domain);
    if (product) {
      existing.push(product);
      continue;
    }

    const result = await enqueue(db, {
      workspaceId,
      kind: 'bootstrap_product',
      // `url` is what the batch view reports each row by.
      payload: { url: `https://${domain}`, domain, autopilot: options.autopilot === true },
      batchId,
      // Partial dedupe: blocks a double submit while the first is outstanding,
      // not a deliberate re-run after it finished.
      dedupeKey: `bootstrap:${domain}`,
    });
    if (result.queued) queued.push(domain);
  }

  return { batchId, queued, existing, invalid: parsed.invalid };
}

/**
 * The market a product's campaign searches, written from its buyer profile.
 *
 * Discovery takes a description of a market ("Series A fintechs hiring
 * platform engineers") and names real companies in it. The drafted ICP is
 * exactly that information in list form, so it is joined back into a phrase
 * rather than asking the model a third time.
 */
export function marketFromDraft(draft: ProfileDraft): string {
  const take = (values: readonly string[], n: number): string => values.slice(0, n).join(', ');

  const industries = take(draft.icp.industries, 3);
  const titles = take(draft.icp.titles, 3);
  const keywords = take(draft.icp.keywords, 4);

  const parts = [
    industries ? `${industries} companies` : `Companies that buy ${draft.offering.category}`,
    titles ? `with ${titles}` : '',
    keywords ? `interested in ${keywords}` : '',
  ].filter(Boolean);

  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export interface BootstrapDeps {
  readonly db: Client;
  readonly model?: TextModel;
  readonly site?: SiteProvider;
}

export type BootstrapOutcome = 'started' | 'already_started' | 'unreadable';

export interface BootstrapResult {
  readonly domain: string;
  readonly outcome: BootstrapOutcome;
  readonly offeringId?: string;
  readonly campaignId?: string;
  readonly market?: string;
  readonly detail?: string;
}

/**
 * Turns one site into a product whose campaign is already searching.
 *
 * Safe to retry. A failure after the product was saved — the discovery
 * enqueue, say — must not save a second copy on the next attempt, so the
 * first thing checked is whether this site is already a product, and a
 * product whose campaign has a seed is finished.
 *
 * Throws on anything a retry could fix (no model, a model outage, a site
 * that timed out). A site that refuses us or has no text completes, because
 * reading it five more times will not change the answer.
 */
export async function runBootstrapProductJob(
  deps: BootstrapDeps,
  job: QueuedJob,
): Promise<BootstrapResult> {
  const payload = job.payload as { domain?: unknown; url?: unknown; autopilot?: unknown };
  const domain =
    (typeof payload.domain === 'string' && toHostname(payload.domain, { anyTld: true })) ||
    (typeof payload.url === 'string' && toHostname(payload.url, { anyTld: true })) ||
    undefined;
  if (!domain) throw new Error('bootstrap_product needs a domain');

  const autopilot = payload.autopilot === true;

  const already = (await existingProducts(deps.db, job.workspaceId)).get(domain);
  if (already) {
    const seeded = await queryOne<{ id: string }>(
      deps.db,
      `SELECT id FROM campaigns
        WHERE workspace_id = ? AND offering_id = ? AND seed_kind IS NOT NULL
          AND seed_value IS NOT NULL AND trim(seed_value) <> ''`,
      [job.workspaceId, already.offeringId],
    );
    if (seeded) {
      return {
        domain,
        outcome: 'already_started',
        offeringId: already.offeringId,
        campaignId: seeded.id,
      };
    }
  }

  if (!deps.model) {
    throw new Error('no model is configured, so a site cannot be read into a product');
  }

  const page = await (deps.site ?? new SiteProvider()).crawl(`https://${domain}`);
  if (page.outcome !== 'ok') {
    if (page.outcome === 'robots_denied') {
      return { domain, outcome: 'unreadable', detail: 'robots.txt blocks the crawler' };
    }
    throw new Error(`could not read ${domain}: ${page.outcome}`);
  }
  if (!page.pageText?.trim()) {
    return { domain, outcome: 'unreadable', detail: 'the page had no readable text' };
  }

  const drafted = await draftProfile(deps.model, page.pageText, page.finalUrl);
  if (!drafted.ok || !drafted.draft) {
    throw new Error(`could not draft ${domain}: ${drafted.reason ?? 'no reason given'}`);
  }
  const draft = drafted.draft;

  // Through the same schema the setup form is held to, so a bulk product is
  // never something the product page then refuses to save.
  const profile = workspaceProfileSchema.safeParse({
    ...(already ? { offeringId: already.offeringId } : {}),
    // The domain as submitted, not the crawler's final URL: it is what the
    // next submission of the same list is matched against.
    url: `https://${domain}`,
    offering: draft.offering,
    icp: draft.icp,
    voice: {
      style: draft.voice.style,
      ...(draft.voice.instructions ? { instructions: draft.voice.instructions } : {}),
      maxWords: draft.voice.maxWords,
    },
  });
  if (!profile.success) {
    const first = profile.error.issues[0];
    throw new Error(
      `the draft for ${domain} did not fit the profile: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim(),
    );
  }

  const saved = await saveWorkspaceProfile(deps.db, job.workspaceId, profile.data, {
    create: !already,
  });

  const market = marketFromDraft(draft);
  const stamp = now();

  await deps.db.execute({
    sql: `UPDATE campaigns
             SET seed_kind = 'keyword', seed_value = ?, approval_mode = ?,
                 networks = CASE WHEN networks IN ('', '[]') THEN '["website","email"]'
                                 ELSE networks END,
                 status = 'active', updated_at = ?
           WHERE id = ? AND workspace_id = ?`,
    args: [
      market,
      autopilot ? 'trusted_automation' : 'draft_and_approve',
      stamp,
      saved.campaignId,
      job.workspaceId,
    ],
  });

  await enqueue(deps.db, {
    workspaceId: job.workspaceId,
    kind: 'discover_domains',
    payload: { keyword: market, campaignId: saved.campaignId },
    dedupeKey: `discover:${saved.campaignId}`,
  });

  await emitEvent(deps.db, {
    workspaceId: job.workspaceId,
    campaignId: saved.campaignId,
    phase: 'intake',
    level: 'success',
    message: `Set up “${draft.offering.name}” from ${domain} — looking for ${market}`,
    detail: { domain, market, autopilot },
  });

  return {
    domain,
    outcome: 'started',
    offeringId: saved.offeringId,
    campaignId: saved.campaignId,
    market,
  };
}
