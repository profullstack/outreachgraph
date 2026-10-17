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
import { defaultLeadSources, type LeadCandidate, type LeadSourceDefinition } from './sources';

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
          WHERE lead_source IS NOT NULL GROUP BY lead_source`,
      )
    ).map((r) => [r.lead_source, Number(r.n)]),
  );
  const companies = await queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM companies`);
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

export interface PickLeadsFilter {
  readonly sources?: readonly string[];
  readonly industry?: string;
  readonly country?: string;
  readonly limit: number;
}

export interface PickedLead {
  readonly id: string;
  readonly domain: string;
  readonly name: string;
  readonly source: string;
}

/**
 * Imported companies a campaign has not crawled yet, best-known first
 * (ranked rows by rank, then the oldest imports), filtered by source,
 * industry (substring, case-insensitive) and country. This is the selective
 * half of "import cheaply, enrich selectively": the caller queues a crawl for
 * each, and only those cost a model call.
 */
export async function pickImportedLeads(
  db: Client,
  workspaceId: string,
  campaignId: string,
  filter: PickLeadsFilter,
): Promise<PickedLead[]> {
  const where: string[] = ['co.lead_source IS NOT NULL', 'co.domain IS NOT NULL'];
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
  args.push(workspaceId, `crawl:${campaignId}:`);
  const limit = Math.max(1, Math.min(500, Math.floor(filter.limit)));
  const rows = await queryAll<{ id: string; domain: string; name: string; lead_source: string }>(
    db,
    `SELECT co.id, co.domain, co.name, co.lead_source FROM companies co
      WHERE ${where.join(' AND ')}
        AND NOT EXISTS (SELECT 1 FROM jobs j
                         WHERE j.workspace_id = ? AND j.dedupe_key = CAST(? AS TEXT) || co.domain)
        AND NOT EXISTS (SELECT 1 FROM people p WHERE p.current_company_id = co.id)
      ORDER BY CASE WHEN co.lead_rank IS NULL THEN 1 ELSE 0 END, co.lead_rank,
               COALESCE(co.employee_count, 0) DESC, co.created_at, co.id
      LIMIT ${limit}`,
    args,
  );
  return rows.map((r) => ({
    id: r.id,
    domain: r.domain,
    name: r.name,
    source: r.lead_source,
  }));
}
