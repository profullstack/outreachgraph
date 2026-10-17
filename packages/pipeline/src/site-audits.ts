/**
 * seo.rank audits of every lead's company homepage.
 *
 * Two intakes feed one store:
 *
 *   - **Hooks.** Every path that records a new company queues an `seo_audit`
 *     job for it (`queueSiteAudit`, `queueSiteAudits` for bulk imports), so a
 *     new lead is audited within a minute or two.
 *   - **The sweep.** Each round, whatever budget the jobs left is spent on the
 *     stalest companies: never audited first (newest first, so a company some
 *     path forgot to hook is still picked up at once), then the oldest audit.
 *     A good audit is due again after 30 days.
 *
 * Both run in `runSiteAuditRound`, beside the worker tick and never inside the
 * main serial drain: thousands of audits must not hold up a crawl or a send.
 *
 * Failures are sorted by whose they are (see `@outreachgraph/providers`
 * seorank): the site refusing is an answer, stored and retried in a week;
 * seo.rank being out of capacity holds the whole round without charging
 * anyone an attempt; anything else backs off exponentially and is dead after
 * `MAX_ATTEMPTS`, then tried again a month later because sites come back.
 */

import {
  SeoRankRefused,
  SeoRankUnavailable,
  type SeoRankAudit,
  type SeoRankAuditor,
  type SeoRankFix,
} from '@outreachgraph/providers';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { newId } from '@outreachgraph/domain';
import {
  claimNext,
  completeJob,
  enqueue,
  failJob,
  type EnqueueResult,
  type QueuedJob,
} from './queue';

const DAY_MS = 86_400_000;

/** A good audit is due again after this long. */
export const REAUDIT_AFTER_DAYS = 30;
/** The site refused (unreachable, not HTML): look again after this long. */
const REFUSED_RETRY_DAYS = 7;
/** Consecutive transient failures before a company's audit is dead for a month. */
export const MAX_ATTEMPTS = 5;
/** First transient retry waits an hour, doubling. */
const ERROR_BACKOFF_MS = 3_600_000;
/** A hooked job skips a company audited this recently, unless forced. */
const FRESH_MS = 6 * 3_600_000;

/**
 * Domains that are someone else's platform, not the lead's own site. Auditing
 * gmail.com's homepage says nothing about the person behind a gmail address.
 */
const PLATFORM_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'substack.com',
  'medium.com',
  'github.com',
  'gitlab.com',
  'linkedin.com',
  'x.com',
  'twitter.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'notion.site',
  'wordpress.com',
  'blogspot.com',
]);

/** The host an audit is keyed on: lower case, no `www.`, no port, or undefined when it is not a site. */
export function auditDomain(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let host = raw.trim().toLowerCase();
  if (!host) return undefined;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(host) ? host : `https://${host}`).hostname;
  } catch {
    return undefined;
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!host.includes('.') || PLATFORM_DOMAINS.has(host)) return undefined;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return undefined;
  return host;
}

export const siteUrl = (domain: string): string => `https://${domain}/`;
export const auditDedupeKey = (domain: string): string => `seo_audit:${domain}`;

export interface SiteAuditTarget {
  readonly companyId: string;
  readonly domain: string;
}

/**
 * Queues an audit of one company's homepage. Called wherever a company is
 * first recorded. Skips platform domains; a duplicate is not an error.
 */
export async function queueSiteAudit(
  db: Client,
  input: {
    workspaceId: string;
    companyId: string;
    domain: string | null | undefined;
    force?: boolean;
  },
): Promise<EnqueueResult> {
  const domain = auditDomain(input.domain);
  if (!domain) return { queued: false };
  return enqueue(db, {
    workspaceId: input.workspaceId,
    kind: 'seo_audit',
    payload: { companyId: input.companyId, ...(input.force ? { force: true } : {}) },
    dedupeKey: auditDedupeKey(domain),
    maxAttempts: 6,
  });
}

/**
 * The bulk form, for imports that record thousands of companies in one
 * request: one batch, `ON CONFLICT DO NOTHING` against the dedupe index, so it
 * costs one round trip rather than one per company.
 */
export async function queueSiteAudits(
  db: Client,
  workspaceId: string,
  targets: readonly { companyId: string; domain: string | null | undefined }[],
): Promise<number> {
  const stamp = now();
  const seen = new Set<string>();
  const rows: { sql: string; args: (string | number)[] }[] = [];
  for (const t of targets) {
    const domain = auditDomain(t.domain);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    rows.push({
      sql: `INSERT INTO jobs (id, workspace_id, kind, payload_json, status, attempts, max_attempts,
              run_after, dedupe_key, created_at, updated_at)
            VALUES (?, ?, 'seo_audit', ?, 'pending', 0, 6, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      args: [
        newId('job'),
        workspaceId,
        JSON.stringify({ companyId: t.companyId }),
        stamp,
        auditDedupeKey(domain),
        stamp,
        stamp,
      ],
    });
  }
  for (let i = 0; i < rows.length; i += 500) await db.batch(rows.slice(i, i + 500));
  return rows.length;
}

// ------------------------------------------------------------------ storage

export interface StoredSiteAudit {
  readonly companyId: string;
  readonly url: string;
  readonly finalUrl: string | null;
  readonly status: 'ok' | 'failed' | 'error' | 'dead';
  readonly score: number | null;
  readonly grade: string | null;
  readonly httpStatus: number | null;
  readonly summary: { pass: number; warn: number; fail: number } | null;
  readonly fixes: readonly SeoRankFix[];
  readonly error: string | null;
  readonly attempts: number;
  readonly checkedAt: string | null;
  readonly attemptedAt: string | null;
  readonly nextAuditAt: string;
  /** Where a human can see the full audit. */
  readonly reportUrl: string;
}

interface SiteAuditRow {
  company_id: string;
  url: string;
  final_url: string | null;
  status: string;
  score: number | null;
  grade: string | null;
  http_status: number | null;
  summary_json: string | null;
  fixes_json: string;
  error: string | null;
  attempts: number;
  checked_at: string | null;
  attempted_at: string | null;
  next_audit_at: string;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toStored(row: SiteAuditRow): StoredSiteAudit {
  return {
    companyId: row.company_id,
    url: row.url,
    finalUrl: row.final_url,
    status: row.status as StoredSiteAudit['status'],
    score: row.score == null ? null : Number(row.score),
    grade: row.grade,
    httpStatus: row.http_status == null ? null : Number(row.http_status),
    summary: parseJson(row.summary_json, null),
    fixes: parseJson<SeoRankFix[]>(row.fixes_json, []),
    error: row.error,
    attempts: Number(row.attempts),
    checkedAt: row.checked_at,
    attemptedAt: row.attempted_at,
    nextAuditAt: row.next_audit_at,
    reportUrl: `https://seo.rank/audit?url=${encodeURIComponent(row.url)}`,
  };
}

export async function siteAuditFor(
  db: Client,
  companyId: string,
): Promise<StoredSiteAudit | undefined> {
  const row = await queryOne<SiteAuditRow>(db, 'SELECT * FROM site_audits WHERE company_id = ?', [
    companyId,
  ]);
  return row ? toStored(row) : undefined;
}

const plus = (at: Date, ms: number) => new Date(at.getTime() + ms).toISOString();

async function upsert(
  db: Client,
  companyId: string,
  url: string,
  fields: {
    status: StoredSiteAudit['status'];
    finalUrl?: string | null;
    score?: number | null;
    grade?: string | null;
    httpStatus?: number | null;
    summary?: unknown;
    fixes?: readonly SeoRankFix[];
    error?: string | null;
    attempts: number;
    checkedAt?: string | null;
    nextAuditAt: string;
  },
  at: Date,
): Promise<void> {
  const stamp = at.toISOString();
  // A transient error keeps the last good result on screen: only the status,
  // error and schedule move. An answer from seo.rank replaces everything.
  const keepResult = fields.status === 'error' || fields.status === 'dead';
  await db.execute({
    sql: `INSERT INTO site_audits (company_id, url, final_url, status, score, grade, http_status,
            summary_json, fixes_json, error, attempts, checked_at, attempted_at, next_audit_at,
            created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (company_id) DO UPDATE SET
            url = excluded.url, status = excluded.status, error = excluded.error,
            attempts = excluded.attempts, attempted_at = excluded.attempted_at,
            next_audit_at = excluded.next_audit_at, updated_at = excluded.updated_at
            ${
              keepResult
                ? ''
                : `, final_url = excluded.final_url, score = excluded.score, grade = excluded.grade,
                   http_status = excluded.http_status, summary_json = excluded.summary_json,
                   fixes_json = excluded.fixes_json, checked_at = excluded.checked_at`
            }`,
    args: [
      companyId,
      url,
      fields.finalUrl ?? null,
      fields.status,
      fields.score ?? null,
      fields.grade ?? null,
      fields.httpStatus ?? null,
      fields.summary === undefined ? null : JSON.stringify(fields.summary),
      JSON.stringify(fields.fixes ?? []),
      fields.error ?? null,
      fields.attempts,
      fields.checkedAt ?? null,
      stamp,
      fields.nextAuditAt,
      stamp,
      stamp,
    ],
  });
}

export type AuditOutcome = 'ok' | 'failed' | 'skipped';

/**
 * Audits one company and stores the answer.
 *
 * Returns `ok` or `failed` (the site's answer, stored). Throws
 * `SeoRankUnavailable` untouched (nothing recorded: not this company's
 * fault), and rethrows any other error after recording it with backoff, so a
 * job's own retry sees it too.
 */
export async function auditCompanySite(
  db: Client,
  auditor: SeoRankAuditor,
  target: SiteAuditTarget,
  at: Date = new Date(),
): Promise<AuditOutcome> {
  const url = siteUrl(target.domain);
  let audit: SeoRankAudit;
  try {
    audit = await auditor.audit(url);
  } catch (error) {
    if (error instanceof SeoRankUnavailable) throw error;
    if (error instanceof SeoRankRefused) {
      await upsert(
        db,
        target.companyId,
        url,
        {
          status: 'failed',
          error: error.message.slice(0, 500),
          attempts: 0,
          checkedAt: at.toISOString(),
          nextAuditAt: plus(at, REFUSED_RETRY_DAYS * DAY_MS),
        },
        at,
      );
      return 'failed';
    }
    const prior = await queryOne<{ attempts: number }>(
      db,
      'SELECT attempts FROM site_audits WHERE company_id = ?',
      [target.companyId],
    );
    const attempts = Number(prior?.attempts ?? 0) + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    await upsert(
      db,
      target.companyId,
      url,
      {
        status: dead ? 'dead' : 'error',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        attempts,
        nextAuditAt: dead
          ? plus(at, REAUDIT_AFTER_DAYS * DAY_MS)
          : plus(at, ERROR_BACKOFF_MS * 2 ** (attempts - 1)),
      },
      at,
    );
    throw error;
  }

  await upsert(
    db,
    target.companyId,
    url,
    {
      status: 'ok',
      finalUrl: audit.finalUrl || null,
      score: audit.score,
      grade: audit.grade,
      httpStatus: audit.status,
      summary: audit.summary,
      fixes: audit.fixes,
      error: null,
      attempts: 0,
      checkedAt: audit.checkedAt || at.toISOString(),
      nextAuditAt: plus(at, REAUDIT_AFTER_DAYS * DAY_MS),
    },
    at,
  );
  return 'ok';
}

/** The `seo_audit` job: one company, unless it was audited in the last few hours. */
export async function runSiteAuditJob(
  db: Client,
  auditor: SeoRankAuditor,
  job: QueuedJob,
  at: Date = new Date(),
): Promise<AuditOutcome> {
  const { companyId, force } = job.payload as { companyId?: string; force?: boolean };
  if (!companyId) throw new Error('seo_audit needs companyId');
  const company = await queryOne<{ domain: string | null }>(
    db,
    'SELECT domain FROM companies WHERE id = ?',
    [companyId],
  );
  const domain = auditDomain(company?.domain);
  if (!domain) return 'skipped';
  if (!force) {
    const last = await queryOne<{ checked_at: string | null; status: string }>(
      db,
      'SELECT checked_at, status FROM site_audits WHERE company_id = ?',
      [companyId],
    );
    if (
      last?.checked_at &&
      last.status === 'ok' &&
      at.getTime() - Date.parse(last.checked_at) < FRESH_MS
    )
      return 'skipped';
  }
  return auditCompanySite(db, auditor, { companyId, domain }, at);
}

// -------------------------------------------------------------------- sweep

/**
 * The companies most in need of an audit, best first: never audited (newest
 * company first), then the oldest audit that is due. Only lead companies, the
 * ones somebody works at: bulk-imported directory rows (lead_source, up to
 * 15,000 a day) are not leads until a crawl finds people there, and are then
 * picked up here. Platform domains and companies with an audit job already
 * outstanding are left out.
 */
export async function staleSiteAuditTargets(
  db: Client,
  limit: number,
  at: Date = new Date(),
): Promise<SiteAuditTarget[]> {
  if (limit <= 0) return [];
  // Over-fetch a little: platform domains are filtered here, not in SQL.
  const rows = await queryAll<{ id: string; domain: string }>(
    db,
    `SELECT c.id, c.domain
       FROM companies c
       LEFT JOIN site_audits a ON a.company_id = c.id
      WHERE c.domain IS NOT NULL AND c.domain <> ''
        AND EXISTS (SELECT 1 FROM people p WHERE p.current_company_id = c.id)
        AND (a.company_id IS NULL OR a.next_audit_at <= ?)
        AND NOT EXISTS (
              SELECT 1 FROM jobs j
               WHERE j.kind = 'seo_audit' AND j.status IN ('pending', 'running')
                 AND j.dedupe_key = 'seo_audit:' || lower(c.domain))
      ORDER BY CASE WHEN a.company_id IS NULL THEN 0 ELSE 1 END,
               COALESCE(a.checked_at, ''), c.created_at DESC
      LIMIT ?`,
    [at.toISOString(), limit + 20],
  );
  const out: SiteAuditTarget[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const domain = auditDomain(row.domain);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push({ companyId: String(row.id), domain });
    if (out.length >= limit) break;
  }
  return out;
}

export interface SiteAuditRoundOptions {
  /** Audits this round may spend, jobs and sweep together. */
  readonly budget: number;
  /** Audits in flight at once. Keep at or under seo.rank's keyed gate. */
  readonly concurrency?: number;
  readonly now?: Date;
}

export interface SiteAuditRoundSummary {
  readonly jobs: number;
  readonly swept: number;
  readonly ok: number;
  readonly failed: number;
  readonly errors: number;
  readonly skipped: number;
  /** seo.rank said "not now"; the round stopped early. */
  readonly held: boolean;
}

async function pool<T>(
  items: AsyncIterable<T> | Iterable<T>,
  size: number,
  run: (item: T) => Promise<void>,
) {
  const iterator =
    Symbol.asyncIterator in Object(items)
      ? (items as AsyncIterable<T>)[Symbol.asyncIterator]()
      : (items as Iterable<T>)[Symbol.iterator]();
  const next = async () => iterator.next() as Promise<IteratorResult<T>>;
  const worker = async () => {
    for (let r = await next(); !r.done; r = await next()) await run(r.value);
  };
  await Promise.all(Array.from({ length: Math.max(1, size) }, worker));
}

/**
 * One round: hooked jobs first, then the sweep with whatever budget is left.
 * Never throws for an audit's failure; one bad site costs one site.
 */
export async function runSiteAuditRound(
  db: Client,
  auditor: SeoRankAuditor,
  options: SiteAuditRoundOptions,
): Promise<SiteAuditRoundSummary> {
  const at = options.now ?? new Date();
  const concurrency = Math.max(1, options.concurrency ?? 3);
  let budget = Math.max(0, options.budget);
  let held = false;
  let jobs = 0;
  let swept = 0;
  let ok = 0;
  let failed = 0;
  let errors = 0;
  let skipped = 0;
  const tally = (outcome: AuditOutcome) => {
    if (outcome === 'ok') ok += 1;
    else if (outcome === 'failed') failed += 1;
    else skipped += 1;
  };
  const isOutage = (error: unknown) => error instanceof SeoRankUnavailable;

  // Jobs, claimed one at a time by each worker so a hold stops new claims.
  const claims: AsyncIterable<QueuedJob> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (held || budget <= 0) return { done: true, value: undefined };
        const job = await claimNext(db, undefined, { kinds: ['seo_audit'] });
        if (!job) return { done: true, value: undefined };
        budget -= 1;
        return { done: false, value: job };
      },
    }),
  };
  await pool(claims, concurrency, async (job) => {
    jobs += 1;
    try {
      const outcome = await runSiteAuditJob(db, auditor, job, at);
      await completeJob(db, job.id);
      // A skipped job did not spend an audit.
      if (outcome === 'skipped') budget += 1;
      tally(outcome);
    } catch (error) {
      const result = await failJob(db, job, error, isOutage);
      if (result === 'deferred') held = true;
      else errors += 1;
    }
  });

  if (!held && budget > 0) {
    const targets = await staleSiteAuditTargets(db, budget, at);
    await pool(targets, concurrency, async (target) => {
      if (held) return;
      swept += 1;
      try {
        tally(await auditCompanySite(db, auditor, target, at));
      } catch (error) {
        if (isOutage(error)) held = true;
        else errors += 1;
      }
    });
  }

  return { jobs, swept, ok, failed, errors, skipped, held };
}

// -------------------------------------------------------------------- stats

export interface SiteAuditStats {
  /** Lead companies: a domain and at least one person. */
  readonly companies: number;
  readonly audited: number;
  readonly failed: number;
  readonly erroring: number;
  readonly dead: number;
  readonly neverAudited: number;
  readonly auditedLast24h: number;
  readonly pendingJobs: number;
  readonly averageScore: number | null;
}

export async function siteAuditStats(db: Client, at: Date = new Date()): Promise<SiteAuditStats> {
  const since = plus(at, -DAY_MS);
  const row = await queryOne<Record<string, number | null>>(
    db,
    `SELECT
        (SELECT COUNT(*) FROM companies c WHERE c.domain IS NOT NULL AND c.domain <> ''
            AND EXISTS (SELECT 1 FROM people p WHERE p.current_company_id = c.id)) AS companies,
        (SELECT COUNT(*) FROM site_audits WHERE status = 'ok') AS audited,
        (SELECT COUNT(*) FROM site_audits WHERE status = 'failed') AS failed,
        (SELECT COUNT(*) FROM site_audits WHERE status = 'error') AS erroring,
        (SELECT COUNT(*) FROM site_audits WHERE status = 'dead') AS dead,
        (SELECT COUNT(*) FROM site_audits WHERE attempted_at >= ?) AS recent,
        (SELECT COUNT(*) FROM jobs WHERE kind = 'seo_audit' AND status IN ('pending', 'running')) AS pending,
        (SELECT AVG(score) FROM site_audits WHERE status = 'ok') AS avg_score`,
    [since],
  );
  const n = (k: string) => Number(row?.[k] ?? 0);
  const total = n('audited') + n('failed') + n('erroring') + n('dead');
  return {
    companies: n('companies'),
    audited: n('audited'),
    failed: n('failed'),
    erroring: n('erroring'),
    dead: n('dead'),
    neverAudited: Math.max(0, n('companies') - total),
    auditedLast24h: n('recent'),
    pendingJobs: n('pending'),
    averageScore: row?.avg_score == null ? null : Math.round(Number(row.avg_score)),
  };
}
