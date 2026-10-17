/**
 * The lead importers' clock: which source runs, how much it may add, and
 * where it resumes.
 *
 * A sweep, not a job: the companies table is shared by every workspace, so
 * the importers belong to no workspace and have nothing to put in a job's
 * `workspace_id`. Each source has a row in `lead_sources` carrying its cursor,
 * daily cap, today's count and next run; the server calls `sweepLeadSources`
 * beside its tick, and every due source reads one batch, stores what is new
 * (deduped on the domain by the unique index) and books the next run. A
 * source that reaches its cap waits for the next UTC day; one that reaches the
 * end of its list waits `restartAfterDays` and reads from the top for what is
 * new. A failure is recorded and retried later, never thrown at the tick.
 *
 * No model and no paid API is called anywhere on this path. Rows land with
 * `lead_source` set and nothing else happens to them until a campaign picks
 * some (`pickImportedLeads`) and the ordinary crawl reads them.
 */

import { newId } from '@outreachgraph/domain';
import { queryAll, queryOne, type Client, type InValue } from '@outreachgraph/db';
import {
  defaultLeadSources,
  MAJESTIC_SKIP_TOP,
  type LeadCandidate,
  type LeadSourceDefinition,
} from './sources';
import { leadDomain } from './domains';

/** Companies all sources together may add in one UTC day. */
export const DEFAULT_DAILY_TOTAL = 15_000;

const INSERT_CHUNK = 100;
const FAILURE_BACKOFF_MS = 30 * 60_000;

export interface LeadSourceRow {
  readonly id: string;
  readonly enabled: number;
  readonly daily_cap: number;
  readonly cursor: string | null;
  readonly day: string | null;
  readonly added_today: number;
  readonly seen_total: number;
  readonly added_total: number;
  readonly runs: number;
  readonly last_run_at: string | null;
  readonly last_added: number | null;
  readonly last_error: string | null;
  readonly next_run_at: string | null;
  readonly exhausted_at: string | null;
}

export interface LeadSweepDeps {
  readonly db: Client;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly sources?: readonly LeadSourceDefinition[];
  /** Cap across every source for one UTC day. */
  readonly dailyTotal?: number;
  /** Run only this source. */
  readonly only?: string;
  /** Run even when not due (still within the caps). */
  readonly force?: boolean;
}

export interface LeadRunResult {
  readonly source: string;
  readonly seen: number;
  readonly candidates: number;
  readonly added: number;
  readonly done: boolean;
  readonly error?: string;
  readonly skipped?: 'disabled' | 'not_due' | 'cap_reached';
}

function iso(date: Date): string {
  return date.toISOString();
}

function nextUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

/** One row per source, created with the source's default cap the first time it is seen. */
export async function ensureLeadSources(
  db: Client,
  sources: readonly LeadSourceDefinition[],
  stamp: string,
): Promise<void> {
  await db.batch(
    sources.map((s) => ({
      sql: `INSERT INTO lead_sources (id, enabled, daily_cap, added_today, seen_total, added_total,
              runs, created_at, updated_at)
            VALUES (?, 1, ?, 0, 0, 0, 0, ?, ?) ON CONFLICT DO NOTHING`,
      args: [s.id, s.dailyCap, stamp, stamp],
    })),
  );
}

/**
 * Stores candidates as companies, first come first kept: a domain already in
 * the table (from the crawler, an import or another source) is left alone.
 *
 * @returns how many rows were new
 */
export async function storeLeadCandidates(
  db: Client,
  sourceId: string,
  candidates: readonly LeadCandidate[],
  stamp: string,
): Promise<number> {
  const unique = new Map<string, LeadCandidate>();
  for (const c of candidates) if (!unique.has(c.domain)) unique.set(c.domain, c);
  const rows = [...unique.values()];
  let added = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const args: InValue[] = [];
    const values = chunk.map((c) => {
      args.push(
        newId('company'),
        c.name.slice(0, 200) || c.domain,
        c.domain,
        c.employees ?? null,
        c.industry?.slice(0, 120) ?? null,
        c.country ?? null,
        sourceId,
        c.ref?.slice(0, 120) ?? null,
        c.rank ?? null,
        stamp,
        stamp,
      );
      return `(?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`;
    });
    // No conflict target: the domain index is partial, and a bare DO NOTHING
    // reads the same on SQLite and Postgres.
    const result = await db.execute({
      sql: `INSERT INTO companies (id, name, domain, employee_count, industry, country,
              technologies, lead_source, lead_ref, lead_rank, created_at, updated_at)
            VALUES ${values.join(', ')} ON CONFLICT DO NOTHING`,
      args,
    });
    added += Number(result.rowsAffected ?? 0);
  }
  return added;
}

async function readRows(db: Client): Promise<Map<string, LeadSourceRow>> {
  const rows = await queryAll<LeadSourceRow>(db, `SELECT * FROM lead_sources`);
  return new Map(rows.map((r) => [r.id, r]));
}

/** Runs every due source once. Never throws for a source's failure. */
export async function sweepLeadSources(deps: LeadSweepDeps): Promise<LeadRunResult[]> {
  const db = deps.db;
  const clock = deps.now ?? (() => new Date());
  const doFetch = deps.fetch ?? fetch;
  const sources = (deps.sources ?? defaultLeadSources()).filter(
    (s) => !deps.only || s.id === deps.only,
  );
  const dailyTotal = Math.max(0, deps.dailyTotal ?? DEFAULT_DAILY_TOTAL);

  const start = clock();
  await ensureLeadSources(db, sources, iso(start));
  const rows = await readRows(db);
  const today = iso(start).slice(0, 10);
  let addedToday = 0;
  for (const r of rows.values()) if (r.day === today) addedToday += Number(r.added_today);

  const results: LeadRunResult[] = [];
  for (const source of sources) {
    const row = rows.get(source.id);
    if (!row) continue;
    const now = clock();
    const stamp = iso(now);
    if (!Number(row.enabled)) {
      results.push({
        source: source.id,
        seen: 0,
        candidates: 0,
        added: 0,
        done: false,
        skipped: 'disabled',
      });
      continue;
    }
    if (!deps.force && row.next_run_at && row.next_run_at > stamp) {
      results.push({
        source: source.id,
        seen: 0,
        candidates: 0,
        added: 0,
        done: false,
        skipped: 'not_due',
      });
      continue;
    }
    const sameDay = row.day === today;
    const usedToday = sameDay ? Number(row.added_today) : 0;
    const room = Math.min(Number(row.daily_cap) - usedToday, dailyTotal - addedToday);
    if (room <= 0) {
      await db.execute({
        sql: `UPDATE lead_sources SET day = ?, added_today = ?, next_run_at = ?, updated_at = ?
               WHERE id = ?`,
        args: [today, usedToday, iso(nextUtcMidnight(now)), stamp, source.id],
      });
      results.push({
        source: source.id,
        seen: 0,
        candidates: 0,
        added: 0,
        done: false,
        skipped: 'cap_reached',
      });
      continue;
    }

    try {
      const batch = await source.read({
        cursor: row.cursor,
        max: Math.min(room, source.batchSize),
        fetch: doFetch,
      });
      // Within the room only: a source may hand back more than it was asked.
      const kept = batch.candidates.slice(0, room);
      const added = await storeLeadCandidates(db, source.id, kept, stamp);
      addedToday += added;
      const finished = clock();
      const capped = usedToday + added >= Number(row.daily_cap);
      const next = batch.done
        ? new Date(finished.getTime() + source.restartAfterDays * 86_400_000)
        : capped
          ? nextUtcMidnight(finished)
          : new Date(finished.getTime() + source.everyMinutes * 60_000);
      await db.execute({
        sql: `UPDATE lead_sources
                 SET cursor = ?, day = ?, added_today = ?, seen_total = seen_total + ?,
                     added_total = added_total + ?, runs = runs + 1, last_run_at = ?,
                     last_added = ?, last_error = NULL, next_run_at = ?, exhausted_at = ?,
                     updated_at = ?
               WHERE id = ?`,
        args: [
          batch.cursor,
          today,
          usedToday + added,
          batch.seen,
          added,
          stamp,
          added,
          iso(next),
          batch.done ? iso(finished) : null,
          iso(finished),
          source.id,
        ],
      });
      results.push({
        source: source.id,
        seen: batch.seen,
        candidates: batch.candidates.length,
        added,
        done: batch.done,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const backoff = Math.max(FAILURE_BACKOFF_MS, source.everyMinutes * 60_000);
      await db.execute({
        sql: `UPDATE lead_sources SET day = ?, added_today = ?, runs = runs + 1, last_run_at = ?,
                     last_error = ?, next_run_at = ?, updated_at = ?
               WHERE id = ?`,
        args: [
          today,
          usedToday,
          stamp,
          message.slice(0, 500),
          iso(new Date(now.getTime() + backoff)),
          stamp,
          source.id,
        ],
      });
      results.push({
        source: source.id,
        seen: 0,
        candidates: 0,
        added: 0,
        done: false,
        error: message,
      });
    }
  }
  return results;
}

export interface LeadSourceStatus {
  readonly id: string;
  readonly label: string;
  readonly homepage: string;
  readonly license: string;
  readonly enabled: boolean;
  readonly dailyCap: number;
  readonly addedToday: number;
  readonly companies: number;
  readonly addedTotal: number;
  readonly seenTotal: number;
  readonly runs: number;
  readonly lastRunAt: string | null;
  readonly lastAdded: number | null;
  readonly lastError: string | null;
  readonly nextRunAt: string | null;
  readonly exhaustedAt: string | null;
  readonly everyMinutes: number;
}

export interface LeadBaseStatus {
  readonly totals: {
    readonly companies: number;
    readonly imported: number;
    readonly people: number;
    readonly peopleWithEmail: number;
    readonly addedToday: number;
    readonly dailyTotal: number;
  };
  readonly sources: readonly LeadSourceStatus[];
}

/**
 * Where the lead base stands: per-source rows stored (counted from the
 * companies table, so a source's number is what is actually there), today's
 * count against the cap, last and next run.
 */
export async function leadBaseStatus(
  db: Client,
  options: {
    readonly sources?: readonly LeadSourceDefinition[];
    readonly dailyTotal?: number;
    readonly now?: Date;
  } = {},
): Promise<LeadBaseStatus> {
  const sources = options.sources ?? defaultLeadSources();
  const today = (options.now ?? new Date()).toISOString().slice(0, 10);
  const rows = await readRows(db);
  const counts = new Map(
    (
      await queryAll<{ lead_source: string; n: number }>(
        db,
        `SELECT lead_source, COUNT(*) AS n FROM companies
          WHERE lead_source IS NOT NULL AND excluded_at IS NULL GROUP BY lead_source`,
      )
    ).map((r) => [r.lead_source, Number(r.n)]),
  );
  const companies = await queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM companies WHERE excluded_at IS NULL`,
  );
  const people = await queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM people WHERE status = 'active'`,
  );
  const withEmail = await queryOne<{ n: number }>(
    db,
    `SELECT COUNT(DISTINCT person_id) AS n FROM person_emails`,
  );
  let imported = 0;
  for (const n of counts.values()) imported += n;
  let addedToday = 0;
  const list = sources.map((s): LeadSourceStatus => {
    const row = rows.get(s.id);
    const todayCount = row && row.day === today ? Number(row.added_today) : 0;
    addedToday += todayCount;
    return {
      id: s.id,
      label: s.label,
      homepage: s.homepage,
      license: s.license,
      enabled: row ? Boolean(Number(row.enabled)) : true,
      dailyCap: row ? Number(row.daily_cap) : s.dailyCap,
      addedToday: todayCount,
      companies: counts.get(s.id) ?? 0,
      addedTotal: row ? Number(row.added_total) : 0,
      seenTotal: row ? Number(row.seen_total) : 0,
      runs: row ? Number(row.runs) : 0,
      lastRunAt: row?.last_run_at ?? null,
      lastAdded:
        row?.last_added === null || row?.last_added === undefined ? null : Number(row.last_added),
      lastError: row?.last_error ?? null,
      nextRunAt: row?.next_run_at ?? null,
      exhaustedAt: row?.exhausted_at ?? null,
      everyMinutes: s.everyMinutes,
    };
  });
  return {
    totals: {
      companies: Number(companies?.n ?? 0),
      imported,
      people: Number(people?.n ?? 0),
      peopleWithEmail: Number(withEmail?.n ?? 0),
      addedToday,
      dailyTotal: options.dailyTotal ?? DEFAULT_DAILY_TOTAL,
    },
    sources: list,
  };
}

/**
 * Turns a source on or off, or changes its daily cap. Returns false for an
 * unknown source.
 */
export async function updateLeadSource(
  db: Client,
  id: string,
  patch: { readonly enabled?: boolean; readonly dailyCap?: number; readonly runNow?: boolean },
  options: { readonly sources?: readonly LeadSourceDefinition[]; readonly now?: Date } = {},
): Promise<boolean> {
  const sources = options.sources ?? defaultLeadSources();
  if (!sources.some((s) => s.id === id)) return false;
  const stamp = (options.now ?? new Date()).toISOString();
  await ensureLeadSources(db, sources, stamp);
  if (patch.enabled !== undefined) {
    await db.execute({
      sql: `UPDATE lead_sources SET enabled = ?, updated_at = ? WHERE id = ?`,
      args: [patch.enabled ? 1 : 0, stamp, id],
    });
  }
  if (patch.dailyCap !== undefined) {
    const cap = Math.max(0, Math.min(200_000, Math.round(patch.dailyCap)));
    await db.execute({
      sql: `UPDATE lead_sources SET daily_cap = ?, updated_at = ? WHERE id = ?`,
      args: [cap, stamp, id],
    });
  }
  if (patch.runNow) {
    await db.execute({
      sql: `UPDATE lead_sources SET next_run_at = NULL, updated_at = ? WHERE id = ?`,
      args: [stamp, id],
    });
  }
  return true;
}

/** Under this an audited, reachable homepage counts as weak SEO. */
export const WEAK_SEO_SCORE = 70;

export interface PickLeadsFilter {
  readonly sources?: readonly string[];
  readonly industry?: string;
  readonly country?: string;
  /** Only companies whose audited homepage scored at most this. */
  readonly maxScore?: number;
  /**
   * `weak_seo` (default): audited and reachable with a score under 70 first,
   * most issues then lowest score first; then not yet audited; then the
   * rest by rank. `rank`: the importer's rank only. Either way a company
   * whose site could not be audited (unreachable, refused) is never picked.
   */
  readonly sort?: 'weak_seo' | 'rank';
  readonly limit: number;
}

export interface PickedLead {
  readonly id: string;
  readonly domain: string;
  readonly name: string;
  readonly source: string;
  readonly score: number | null;
  readonly grade: string | null;
  /** Warnings plus failures in the audit. */
  readonly issues: number | null;
}

/**
 * Imported companies a campaign has not crawled yet, filtered by source,
 * industry (substring, case-insensitive), country and SEO score, ordered by
 * `sort`. This is the selective half of "import cheaply, enrich
 * selectively": the caller queues a crawl for each, and only those cost a
 * model call, so the default spends it on sites with the most to fix.
 * Without a campaign it is a preview: nothing about jobs is checked.
 */
export async function pickImportedLeads(
  db: Client,
  workspaceId: string,
  campaignId: string | undefined,
  filter: PickLeadsFilter,
): Promise<PickedLead[]> {
  const where: string[] = [
    'co.lead_source IS NOT NULL',
    'co.domain IS NOT NULL',
    'co.excluded_at IS NULL',
    // Reachable sites only: a homepage seo.rank could not read is not worth a crawl.
    "(sa.status IS NULL OR sa.status IN ('ok', 'error'))",
  ];
  const args: InValue[] = [];
  if (filter.sources?.length) {
    where.push(`co.lead_source IN (${filter.sources.map(() => '?').join(', ')})`);
    args.push(...filter.sources);
  }
  if (filter.industry?.trim()) {
    where.push(`lower(co.industry) LIKE ?`);
    args.push(`%${filter.industry.trim().toLowerCase()}%`);
  }
  if (filter.country?.trim()) {
    where.push(`co.country = ?`);
    args.push(filter.country.trim().toUpperCase());
  }
  if (filter.maxScore !== undefined && Number.isFinite(filter.maxScore)) {
    where.push(`sa.status = 'ok' AND sa.score <= ?`);
    args.push(Math.floor(filter.maxScore));
  }
  if (campaignId) {
    where.push(`NOT EXISTS (SELECT 1 FROM jobs j
                         WHERE j.workspace_id = ? AND j.dedupe_key = CAST(? AS TEXT) || co.domain)`);
    args.push(workspaceId, `crawl:${campaignId}:`);
  }
  const rankOrder = `CASE WHEN co.lead_rank IS NULL THEN 1 ELSE 0 END, co.lead_rank,
               COALESCE(co.employee_count, 0) DESC, co.created_at, co.id`;
  const order =
    filter.sort === 'rank'
      ? rankOrder
      : `CASE WHEN sa.status = 'ok' AND sa.score < ${WEAK_SEO_SCORE} THEN 0
                    WHEN sa.status IS NULL THEN 1 ELSE 2 END,
               COALESCE(sa.issues, -1) DESC, COALESCE(sa.score, 101), ${rankOrder}`;
  const limit = Math.max(1, Math.min(500, Math.floor(filter.limit)));
  // Over-fetch: rows today's rules would not import are dropped below. Most
  // are retired (`excluded_at`), but one a campaign already crawled keeps its
  // row untouched, and must still not be picked to be paid for again.
  const fetchLimit = Math.min(1000, limit * 2 + 20);
  const rows = await queryAll<{
    id: string;
    domain: string;
    name: string;
    lead_source: string;
    lead_rank: number | null;
    score: number | null;
    grade: string | null;
    issues: number | null;
  }>(
    db,
    `SELECT co.id, co.domain, co.name, co.lead_source, co.lead_rank, sa.score, sa.grade, sa.issues
       FROM companies co
       LEFT JOIN site_audits sa ON sa.company_id = co.id
      WHERE ${where.join(' AND ')}
        AND NOT EXISTS (SELECT 1 FROM people p WHERE p.current_company_id = co.id)
      ORDER BY ${order}
      LIMIT ${fetchLimit}`,
    args,
  );
  const keep = rows
    .filter(
      (r) =>
        !exclusionReason({ domain: r.domain, lead_source: r.lead_source, lead_rank: r.lead_rank }),
    )
    .slice(0, limit);
  return keep.map((r) => ({
    id: r.id,
    domain: r.domain,
    name: r.name,
    source: r.lead_source,
    score: r.score == null ? null : Number(r.score),
    grade: r.grade ?? null,
    issues: r.issues == null ? null : Number(r.issues),
  }));
}

export interface RetireResult {
  readonly checked: number;
  readonly retired: number;
  readonly byReason: Readonly<Record<string, number>>;
  /** Would have been retired but somebody has worked with them. */
  readonly kept: number;
}

/**
 * Why an imported company is not a lead under today's rules, or null:
 * `platform` when the importer's filter now drops its domain (megacorps,
 * platforms, infrastructure), `majestic_top_rank` for a Majestic row ranked
 * in the skipped top.
 */
export function exclusionReason(row: {
  domain: string;
  lead_source: string | null;
  lead_rank: number | null;
}): string | null {
  // nichedb sources drop hosted-platform roots too (see nichedbSource).
  const dropPlatformRoots = row.lead_source?.startsWith('nichedb-') ?? false;
  if (!leadDomain(row.domain, { dropPlatformRoots })) return 'platform';
  if (
    row.lead_source === 'majestic-million' &&
    row.lead_rank != null &&
    Number(row.lead_rank) <= MAJESTIC_SKIP_TOP
  )
    return 'majestic_top_rank';
  return null;
}

/**
 * Retires imported companies today's rules would not import: marks them
 * `excluded_at`/`excluded_reason` rather than deleting, so the domain stays
 * taken and a re-import cannot bring them back. Never touches a company
 * anyone has worked with: people at it, a signal about it, or a crawl of it.
 * Idempotent and cheap (one read of the imported rows); the server runs it
 * once per boot before the first import sweep.
 */
export async function retireExcludedImports(
  db: Client,
  at: Date = new Date(),
): Promise<RetireResult> {
  const rows = await queryAll<{
    id: string;
    domain: string;
    lead_source: string | null;
    lead_rank: number | null;
  }>(
    db,
    `SELECT id, domain, lead_source, lead_rank FROM companies
      WHERE lead_source IS NOT NULL AND excluded_at IS NULL AND domain IS NOT NULL`,
  );
  const byReason: Record<string, number> = {};
  let retired = 0;
  let kept = 0;
  const stamp = at.toISOString();
  for (const row of rows) {
    const reason = exclusionReason(row);
    if (!reason) continue;
    const used = await queryOne<{ n: number }>(
      db,
      `SELECT
          (SELECT COUNT(*) FROM people WHERE current_company_id = ?)
        + (SELECT COUNT(*) FROM signals WHERE company_id = ?)
        + (SELECT COUNT(*) FROM jobs WHERE kind = 'crawl_site'
              AND (dedupe_key = ? OR dedupe_key LIKE ?)) AS n`,
      [row.id, row.id, `crawl:${row.domain}`, `crawl:%:${row.domain}`],
    );
    if (Number(used?.n ?? 0) > 0) {
      kept += 1;
      continue;
    }
    await db.execute({
      sql: `UPDATE companies SET excluded_at = ?, excluded_reason = ? WHERE id = ? AND excluded_at IS NULL`,
      args: [stamp, reason, row.id],
    });
    retired += 1;
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  return { checked: rows.length, retired, byReason, kept };
}
