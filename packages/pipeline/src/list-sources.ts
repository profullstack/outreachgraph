/**
 * Signal lists from the news, weekly per product (rules in
 * `@outreachgraph/domain` `list-sources.ts`).
 *
 * For every product with the planner on: one Google News search for funding,
 * one for appointments, one web search for conference speaker and sponsor
 * pages, each at most once a week, all inside a per-workspace daily search
 * cap that survives a restart. Each headline that parses names a company; its
 * domain is found, the headline becomes a company-level signal (the evidence
 * a draft may quote), and the company's site is crawled into the product's
 * signals campaign, where the ordinary pipeline finds the people, verifies,
 * paces and drafts. An event page is crawled as it is.
 */

import {
  LIST_SOURCE_DAILY_SEARCHES,
  LIST_SOURCE_EVERY_DAYS,
  LIST_SOURCE_KINDS,
  LIST_SOURCE_MAX_ITEMS,
  isEventPeoplePage,
  listSourceQuery,
  marketTerms,
  newId,
  parseFundingHeadline,
  parseLeadershipHeadline,
  type ListSourceKind,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { SearchOutOfCredits, type NewsSearcher, type WebSearcher } from '@outreachgraph/providers';
import { crawlDedupeKey } from './auto-approve';
import { emitEvent } from './events';
import { findCompanyDomain } from './job-posts';
import { enqueue } from './queue';

export interface ListSourceDeps {
  readonly db: Client;
  readonly searcher: WebSearcher & NewsSearcher;
  readonly now?: Date;
}

export interface ListSourceScan {
  readonly offeringId: string;
  readonly kind: ListSourceKind;
  readonly items: number;
  readonly error?: string;
}

const USAGE_PROVIDER = 'list_sources';

/** `YYYY-Www`-ish key: the number of whole `LIST_SOURCE_EVERY_DAYS` periods since the epoch. */
function period(at: Date): string {
  return `p${Math.floor(at.getTime() / (LIST_SOURCE_EVERY_DAYS * 86_400_000))}`;
}

async function usedToday(db: Client, workspaceId: string, at: Date): Promise<number> {
  const row = await queryOne<{ lookups: number }>(
    db,
    'SELECT lookups FROM enrichment_usage WHERE workspace_id = ? AND day = ? AND provider = ?',
    [workspaceId, at.toISOString().slice(0, 10), USAGE_PROVIDER],
  );
  return Number(row?.lookups ?? 0);
}

async function countSearch(db: Client, workspaceId: string, at: Date): Promise<void> {
  await db.execute({
    sql: `INSERT INTO enrichment_usage (workspace_id, day, provider, lookups) VALUES (?, ?, ?, 1)
          ON CONFLICT (workspace_id, day, provider) DO UPDATE
            SET lookups = enrichment_usage.lookups + 1`,
    args: [workspaceId, at.toISOString().slice(0, 10), USAGE_PROVIDER],
  });
}

/** Runs every scan that is due for the workspace, within today's search budget. */
export async function scanListSources(
  deps: ListSourceDeps,
  workspaceId: string,
): Promise<ListSourceScan[]> {
  const { db } = deps;
  const at = deps.now ?? new Date();
  const key = period(at);

  const offerings = await queryAll<{ id: string; name: string; category: string }>(
    db,
    `SELECT o.id, o.name, o.category FROM offerings o
      WHERE o.workspace_id = ? AND COALESCE(o.planner_enabled, 1) = 1
        AND EXISTS (SELECT 1 FROM campaigns c WHERE c.offering_id = o.id
                     AND c.status != 'archived' AND (c.seed_kind IS NULL OR c.seed_kind NOT IN ('planner', 'signals')))
      ORDER BY o.created_at`,
    [workspaceId],
  );

  const scans: ListSourceScan[] = [];
  let budget = LIST_SOURCE_DAILY_SEARCHES - (await usedToday(db, workspaceId, at));

  outer: for (const offering of offerings) {
    const terms = marketTerms({ category: offering.category, name: offering.name });
    if (!terms) continue;
    for (const kind of LIST_SOURCE_KINDS) {
      if (budget <= 0) break outer;
      const ran = await queryOne<{ ran_at: string }>(
        db,
        'SELECT ran_at FROM list_source_runs WHERE offering_id = ? AND kind = ? AND period = ?',
        [offering.id, kind, key],
      );
      if (ran) continue;

      const spend = async (): Promise<boolean> => {
        if (budget <= 0) return false;
        budget -= 1;
        await countSearch(db, workspaceId, at);
        return true;
      };

      let items = 0;
      let error: string | undefined;
      try {
        items = await scanOne(deps, { workspaceId, offering, kind, terms, at, spend });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        if (caught instanceof SearchOutOfCredits) {
          scans.push({ offeringId: offering.id, kind, items, error });
          await recordRun(db, {
            workspaceId,
            offeringId: offering.id,
            kind,
            key,
            items,
            error,
            at,
          });
          break outer;
        }
      }
      await recordRun(db, {
        workspaceId,
        offeringId: offering.id,
        kind,
        key,
        items,
        ...(error ? { error } : {}),
        at,
      });
      scans.push({ offeringId: offering.id, kind, items, ...(error ? { error } : {}) });
    }
  }
  return scans;
}

async function scanOne(
  deps: ListSourceDeps,
  input: {
    readonly workspaceId: string;
    readonly offering: { id: string; name: string };
    readonly kind: ListSourceKind;
    readonly terms: string;
    readonly at: Date;
    readonly spend: () => Promise<boolean>;
  },
): Promise<number> {
  const { db, searcher } = deps;
  const { workspaceId, offering, kind, terms, at } = input;
  if (!(await input.spend())) return 0;
  const query = listSourceQuery(kind, terms, at.getUTCFullYear());

  const found: Array<{
    url: string;
    title: string;
    snippet?: string;
    company?: string;
    person?: string;
    role?: string;
    summary?: string;
  }> = [];

  if (kind === 'event') {
    for (const result of await searcher.search(query, { num: 20 })) {
      if (result.link && isEventPeoplePage(result.link)) {
        found.push({ url: result.link, title: result.title ?? result.link });
      }
    }
  } else {
    const news = await searcher.searchNews(query, {
      num: 30,
      period: kind === 'funding' ? 'last_week' : 'last_month',
    });
    for (const item of news) {
      if (kind === 'funding') {
        const parsed = parseFundingHeadline(item.title);
        if (!parsed) continue;
        found.push({
          url: item.link,
          title: item.title,
          ...(item.snippet ? { snippet: item.snippet } : {}),
          company: parsed.company,
          summary: `${parsed.company} raised ${[parsed.amount, parsed.round].filter(Boolean).join(' ') || 'new funding'}`,
        });
      } else {
        const parsed = parseLeadershipHeadline(item.title);
        if (!parsed) continue;
        found.push({
          url: item.link,
          title: item.title,
          ...(item.snippet ? { snippet: item.snippet } : {}),
          company: parsed.company,
          person: parsed.person,
          role: parsed.title,
          summary: `${parsed.company} named ${parsed.person} ${parsed.title}`,
        });
      }
    }
  }

  let taken = 0;
  let campaignId: string | undefined;
  for (const item of found) {
    if (taken >= LIST_SOURCE_MAX_ITEMS) break;
    const seen = await queryOne<{ id: string }>(
      db,
      'SELECT id FROM list_source_items WHERE offering_id = ? AND url = ?',
      [offering.id, item.url],
    );
    if (seen) continue;

    // The company behind a headline, by its own site. Each lookup is a paid
    // search, so it comes out of the same budget.
    let domain: string | undefined;
    if (item.company) {
      const sameCompany = await queryOne<{ domain: string | null }>(
        db,
        `SELECT domain FROM list_source_items WHERE workspace_id = ? AND company = ?
           AND domain IS NOT NULL LIMIT 1`,
        [workspaceId, item.company],
      );
      domain = sameCompany?.domain ?? undefined;
      if (!domain) {
        if (!(await input.spend())) break;
        domain = await findCompanyDomain(searcher, item.company);
      }
      if (!domain) continue;
    }

    campaignId ??= await signalsCampaign(db, workspaceId, offering);
    if (!campaignId) return taken;

    if (domain && item.summary) {
      const companyId = await upsertCompany(db, item.company ?? domain, domain);
      await db.execute({
        sql: `INSERT INTO signals (id, workspace_id, person_id, company_id, network, signal_type,
              subtype, summary, evidence, source_url, source_timestamp, observed_at, confidence,
              relevance, sentiment)
              VALUES (?, ?, NULL, ?, 'website', ?, ?, ?, ?, ?, ?, ?, 0.85, 0.8, 'positive')`,
        args: [
          newId('signal'),
          workspaceId,
          companyId,
          kind === 'funding' ? 'funding' : 'role_change',
          kind === 'funding' ? 'raised' : 'new_leader',
          item.summary,
          [item.title, item.snippet].filter(Boolean).join('. ').slice(0, 1000),
          item.url,
          at.toISOString(),
          at.toISOString(),
        ],
      });
    }

    await enqueue(db, {
      workspaceId,
      kind: 'crawl_site',
      payload: { url: domain ? `https://${domain}` : item.url, campaignId },
      dedupeKey: crawlDedupeKey(domain ? `https://${domain}` : item.url),
    });

    await db.execute({
      sql: `INSERT INTO list_source_items (id, workspace_id, offering_id, kind, url, title, company,
            domain, person, role, campaign_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (offering_id, url) DO NOTHING`,
      args: [
        newId('listSourceItem'),
        workspaceId,
        offering.id,
        kind,
        item.url,
        item.title.slice(0, 300),
        item.company ?? null,
        domain ?? null,
        item.person ?? null,
        item.role ?? null,
        campaignId,
        at.toISOString(),
      ],
    });
    taken += 1;
  }

  if (taken > 0) {
    await emitEvent(db, {
      workspaceId,
      ...(campaignId ? { campaignId } : {}),
      phase: 'discover',
      level: 'success',
      message: `${kindLabel(kind)}: ${taken} new ${taken === 1 ? 'company' : 'companies'} for ${offering.name}`,
      detail: { offeringId: offering.id, kind },
    });
  }
  return taken;
}

function kindLabel(kind: ListSourceKind): string {
  if (kind === 'funding') return 'Newly funded';
  if (kind === 'leadership') return 'New leaders';
  return 'Conference speakers and sponsors';
}

async function upsertCompany(db: Client, name: string, domain: string): Promise<string> {
  const existing = await queryOne<{ id: string }>(db, 'SELECT id FROM companies WHERE domain = ?', [
    domain,
  ]);
  if (existing) return existing.id;
  const id = newId('company');
  const stamp = now();
  await db.execute({
    sql: `INSERT INTO companies (id, name, domain, technologies, created_at, updated_at)
          VALUES (?, ?, ?, '[]', ?, ?)`,
    args: [id, name, domain, stamp, stamp],
  });
  return id;
}

/**
 * The product's signals campaign, created on first use in the same approval
 * mode, voice and limits as the product's busiest campaign — a product on
 * autopilot gets these leads on autopilot, one that approves everything gets
 * cards.
 */
async function signalsCampaign(
  db: Client,
  workspaceId: string,
  offering: { id: string; name: string },
): Promise<string | undefined> {
  const existing = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM campaigns WHERE offering_id = ? AND seed_kind = 'signals' AND status != 'archived'
      ORDER BY created_at LIMIT 1`,
    [offering.id],
  );
  if (existing) return existing.id;

  const source = await queryOne<{
    approval_mode: string;
    auto_reply_mode: string | null;
    voice_profile_id: string | null;
    budget_json: string;
  }>(
    db,
    `SELECT c.approval_mode, c.auto_reply_mode, c.voice_profile_id, c.budget_json
       FROM campaigns c
      WHERE c.offering_id = ? AND c.status != 'archived'
        AND (c.seed_kind IS NULL OR c.seed_kind NOT IN ('planner', 'signals'))
      ORDER BY (SELECT COUNT(*) FROM interactions i
                 WHERE i.campaign_id = c.id AND i.direction = 'outbound') DESC, c.created_at
      LIMIT 1`,
    [offering.id],
  );
  if (!source) return undefined;

  const id = newId('campaign');
  const stamp = now();
  await db.execute({
    sql: `INSERT INTO campaigns (id, workspace_id, name, offering_id, voice_profile_id, brief,
          networks, approval_mode, budget_json, status, created_at, updated_at, started_at,
          auto_reply_mode, seed_kind, seed_value)
          VALUES (?, ?, ?, ?, ?, ?, '["email"]', ?, ?, 'active', ?, ?, ?, ?, 'signals', 'news')`,
    args: [
      id,
      workspaceId,
      `${offering.name} · Funding, new leaders and events`,
      offering.id,
      source.voice_profile_id,
      'Companies that just raised, just appointed a decision-maker, or are on a conference speaker or sponsor list in this market. Lead with the news when the evidence supports it.',
      source.approval_mode,
      source.budget_json,
      stamp,
      stamp,
      stamp,
      source.auto_reply_mode ?? 'copilot',
    ],
  });
  return id;
}

async function recordRun(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly offeringId: string;
    readonly kind: ListSourceKind;
    readonly key: string;
    readonly items: number;
    readonly error?: string;
    readonly at: Date;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO list_source_runs (offering_id, kind, period, workspace_id, items, error, ran_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (offering_id, kind, period) DO NOTHING`,
    args: [
      input.offeringId,
      input.kind,
      input.key,
      input.workspaceId,
      input.items,
      input.error?.slice(0, 300) ?? null,
      input.at.toISOString(),
    ],
  });
}

export interface ListSourceItemView {
  readonly offeringId: string;
  readonly kind: string;
  readonly title: string;
  readonly url: string;
  readonly company: string | null;
  readonly domain: string | null;
  readonly person: string | null;
  readonly role: string | null;
  readonly campaignId: string | null;
  readonly createdAt: string;
}

/** What the list sources found recently, newest first. */
export async function recentListSourceItems(
  db: Client,
  workspaceId: string,
  options: { readonly kind?: string; readonly limit?: number } = {},
): Promise<ListSourceItemView[]> {
  const rows = await queryAll<{
    offering_id: string;
    kind: string;
    title: string;
    url: string;
    company: string | null;
    domain: string | null;
    person: string | null;
    role: string | null;
    campaign_id: string | null;
    created_at: string;
  }>(
    db,
    `SELECT offering_id, kind, title, url, company, domain, person, role, campaign_id, created_at
       FROM list_source_items WHERE workspace_id = ? ${options.kind ? 'AND kind = ?' : ''}
      ORDER BY created_at DESC LIMIT ?`,
    [workspaceId, ...(options.kind ? [options.kind] : []), options.limit ?? 100],
  );
  return rows.map((row) => ({
    offeringId: row.offering_id,
    kind: row.kind,
    title: row.title,
    url: row.url,
    company: row.company,
    domain: row.domain,
    person: row.person,
    role: row.role,
    campaignId: row.campaign_id,
    createdAt: row.created_at,
  }));
}
