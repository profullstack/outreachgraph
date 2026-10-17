import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  SeoRankRefused,
  SeoRankUnavailable,
  SiteProvider,
  type FetchLike,
  type SeoRankAudit,
  type SeoRankAuditor,
} from '@outreachgraph/providers';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { runCrawlJob } from './crawl';
import { claimNext, drainQueue, enqueue } from './queue';
import {
  auditCompanySite,
  auditDomain,
  MAX_ATTEMPTS,
  queueSiteAudit,
  queueSiteAudits,
  runSiteAuditJob,
  runSiteAuditRound,
  siteAuditFor,
  siteAuditStats,
  staleSiteAuditTargets,
} from './site-audits';

setDefaultTimeout(30_000);

let seeded: SeededDatabase | undefined;
afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

async function setup(label: string): Promise<Client> {
  seeded = await seedDatabase(label);
  return seeded.db;
}

const AT = new Date('2026-10-17T12:00:00.000Z');
const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(AT.getTime() + offsetMs).toISOString();

/** A lead company: a domain and one person who works there (unless `withPerson` is false). */
async function addCompany(
  db: Client,
  id: string,
  domain: string,
  createdAt = iso(-DAY),
  withPerson = true,
) {
  await db.execute({
    sql: `INSERT INTO companies (id, name, domain, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    args: [id, id, domain, createdAt, createdAt],
  });
  if (!withPerson) return;
  await db.execute({
    sql: `INSERT INTO people (id, display_name, current_company_id, identity_confidence, status,
            outreach_eligible, believed_minor, created_at, updated_at)
          VALUES (?, ?, ?, 0.9, 'active', 1, 0, ?, ?)`,
    args: [`per_${id}`, id, id, createdAt, createdAt],
  });
}

function audit(url: string, score = 64): SeoRankAudit {
  return {
    url,
    finalUrl: url,
    status: 200,
    score,
    grade: 'D',
    summary: { pass: 15, warn: 5, fail: 4 },
    fixes: [
      {
        id: 'description',
        label: 'Meta description',
        priority: 'high',
        fix: 'Add a meta description.',
      },
      { id: 'h1', label: 'One H1', priority: 'medium', fix: 'Use exactly one H1.' },
    ],
    checkedAt: AT.toISOString(),
  };
}

/** An auditor that answers from a script: a function per URL, or the default. */
function fakeAuditor(
  script: Record<string, () => SeoRankAudit | Promise<SeoRankAudit>> = {},
): SeoRankAuditor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async audit(url: string) {
      calls.push(url);
      const step = script[url];
      return step ? step() : audit(url);
    },
  };
}

describe('auditDomain', () => {
  test('normalises a host and refuses platforms and bare names', () => {
    expect(auditDomain('WWW.Acme.com')).toBe('acme.com');
    expect(auditDomain('https://www.acme.com/about?x=1')).toBe('acme.com');
    expect(auditDomain('gmail.com')).toBeUndefined();
    expect(auditDomain('substack.com')).toBeUndefined();
    expect(auditDomain('localhost')).toBeUndefined();
    expect(auditDomain('10.0.0.1')).toBeUndefined();
    expect(auditDomain(null)).toBeUndefined();
  });
});

describe('hooks', () => {
  test('one job per domain while one is outstanding, single or bulk', async () => {
    const db = await setup('site-audit-queue');
    await addCompany(db, 'co_b', 'beta.test');
    const first = await queueSiteAudit(db, {
      workspaceId: SEED.workspaceId,
      companyId: SEED.companyId,
      domain: 'acme.com',
    });
    const again = await queueSiteAudit(db, {
      workspaceId: SEED.workspaceId,
      companyId: SEED.companyId,
      domain: 'www.acme.com',
    });
    expect(first.queued).toBe(true);
    expect(again.queued).toBe(false);
    expect(
      (
        await queueSiteAudit(db, {
          workspaceId: SEED.workspaceId,
          companyId: 'x',
          domain: 'gmail.com',
        })
      ).queued,
    ).toBe(false);

    await queueSiteAudits(db, SEED.workspaceId, [
      { companyId: SEED.companyId, domain: 'acme.com' },
      { companyId: 'co_b', domain: 'beta.test' },
      { companyId: 'co_b', domain: 'beta.test' },
      { companyId: 'co_g', domain: 'gmail.com' },
    ]);
    const jobs = await queryAll<{ dedupe_key: string }>(
      db,
      `SELECT dedupe_key FROM jobs WHERE kind = 'seo_audit' ORDER BY dedupe_key`,
    );
    expect(jobs.map((j) => j.dedupe_key)).toEqual(['seo_audit:acme.com', 'seo_audit:beta.test']);
  });

  test('a crawl that records a new company queues its audit', async () => {
    const db = await setup('site-audit-crawl-hook');
    const html = `<!doctype html><html><head><title>Family Shop</title>
      <meta property="og:site_name" content="Family Shop" />
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Family Shop"}</script>
      </head><body><footer><a href="mailto:hello@familyshop.example">hello@familyshop.example</a></footer></body></html>`;
    const fetchImpl: FetchLike = async (input) =>
      input.toString().endsWith('/robots.txt')
        ? new Response('User-agent: *\nAllow: /', { headers: { 'content-type': 'text/plain' } })
        : new Response(html, { headers: { 'content-type': 'text/html' } });
    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'crawl_site',
      payload: { url: 'https://familyshop.example' },
    });
    const site = new SiteProvider({ fetchImpl });
    await drainQueue(
      db,
      async (job) => {
        await runCrawlJob({ db, site, providers: [], emailSendingEnabled: true }, job);
      },
      { excludeKinds: ['seo_audit'] },
    );
    const company = await queryOne<{ id: string; refreshed_at: string | null }>(
      db,
      `SELECT id, refreshed_at FROM companies WHERE domain = 'familyshop.example'`,
    );
    expect(company?.refreshed_at).toBeTruthy();
    const job = await queryOne<{ payload_json: string; status: string }>(
      db,
      `SELECT payload_json, status FROM jobs WHERE kind = 'seo_audit'`,
    );
    // Left pending: the main drain never claims an audit.
    expect(job?.status).toBe('pending');
    expect(JSON.parse(job!.payload_json)).toEqual({ companyId: company!.id });
  });
});

describe('storage', () => {
  test('a good audit is stored and due again in 30 days', async () => {
    const db = await setup('site-audit-ok');
    const outcome = await auditCompanySite(
      db,
      fakeAuditor(),
      { companyId: SEED.companyId, domain: 'acme.com' },
      AT,
    );
    expect(outcome).toBe('ok');
    const stored = await siteAuditFor(db, SEED.companyId);
    expect(stored).toMatchObject({
      status: 'ok',
      score: 64,
      grade: 'D',
      url: 'https://acme.com/',
      attempts: 0,
      checkedAt: AT.toISOString(),
      nextAuditAt: iso(30 * DAY),
    });
    expect(stored?.fixes[0]?.id).toBe('description');
    expect(stored?.reportUrl).toBe('https://seo.rank/audit?url=https%3A%2F%2Facme.com%2F');
  });

  test('the site refusing is stored as failed and retried in a week', async () => {
    const db = await setup('site-audit-refused');
    const auditor = fakeAuditor({
      'https://acme.com/': () => {
        throw new SeoRankRefused('That address does not resolve.', 400);
      },
    });
    expect(
      await auditCompanySite(db, auditor, { companyId: SEED.companyId, domain: 'acme.com' }, AT),
    ).toBe('failed');
    expect(await siteAuditFor(db, SEED.companyId)).toMatchObject({
      status: 'failed',
      error: 'That address does not resolve.',
      nextAuditAt: iso(7 * DAY),
    });
  });

  test('transient errors back off, keep the last good result, and die after MAX_ATTEMPTS', async () => {
    const db = await setup('site-audit-transient');
    const target = { companyId: SEED.companyId, domain: 'acme.com' };
    await auditCompanySite(db, fakeAuditor(), target, AT);
    const broken = fakeAuditor({
      'https://acme.com/': () => {
        throw new Error('seo.rank answered 502');
      },
    });
    await expect(auditCompanySite(db, broken, target, AT)).rejects.toThrow('502');
    let stored = await siteAuditFor(db, SEED.companyId);
    expect(stored).toMatchObject({
      status: 'error',
      attempts: 1,
      score: 64,
      nextAuditAt: iso(3_600_000),
    });
    for (let i = 2; i <= MAX_ATTEMPTS; i += 1) {
      await auditCompanySite(db, broken, target, AT).catch(() => undefined);
    }
    stored = await siteAuditFor(db, SEED.companyId);
    expect(stored).toMatchObject({
      status: 'dead',
      attempts: MAX_ATTEMPTS,
      nextAuditAt: iso(30 * DAY),
    });
    // Any answer resets it.
    await auditCompanySite(db, fakeAuditor(), target, AT);
    expect(await siteAuditFor(db, SEED.companyId)).toMatchObject({ status: 'ok', attempts: 0 });
  });

  test('seo.rank being unavailable records nothing and is rethrown', async () => {
    const db = await setup('site-audit-unavailable');
    const auditor = fakeAuditor({
      'https://acme.com/': () => {
        throw new SeoRankUnavailable('cap', 429, 600);
      },
    });
    await expect(
      auditCompanySite(db, auditor, { companyId: SEED.companyId, domain: 'acme.com' }, AT),
    ).rejects.toBeInstanceOf(SeoRankUnavailable);
    expect(await siteAuditFor(db, SEED.companyId)).toBeUndefined();
  });
});

describe('the sweep', () => {
  test('lead companies first (never audited, then oldest due), then imported ones; not-due, queued and platforms left out', async () => {
    const db = await setup('site-audit-order');
    // acme.com (seed) is never audited and oldest-created among the new.
    await db.execute({
      sql: 'UPDATE companies SET created_at = ? WHERE id = ?',
      args: [iso(-2 * DAY), SEED.companyId],
    });
    await addCompany(db, 'co_new', 'new.test', iso(-1000));
    await addCompany(db, 'co_old_audit', 'old.test');
    await addCompany(db, 'co_mid_audit', 'mid.test');
    await addCompany(db, 'co_not_due', 'notdue.test');
    await addCompany(db, 'co_queued', 'queued.test', iso(-500));
    await addCompany(db, 'co_gmail', 'gmail.com', iso(-100));
    // A bulk-imported directory row nobody works at: audited too, after the leads.
    await addCompany(db, 'co_directory', 'directory.test', iso(-50), false);
    const auditor = fakeAuditor();
    await auditCompanySite(
      db,
      auditor,
      { companyId: 'co_old_audit', domain: 'old.test' },
      new Date(AT.getTime() - 40 * DAY),
    );
    await auditCompanySite(
      db,
      auditor,
      { companyId: 'co_mid_audit', domain: 'mid.test' },
      new Date(AT.getTime() - 35 * DAY),
    );
    await auditCompanySite(
      db,
      auditor,
      { companyId: 'co_not_due', domain: 'notdue.test' },
      new Date(AT.getTime() - 5 * DAY),
    );
    // checkedAt comes from the audit body; make it match the run date.
    await db.execute({ sql: `UPDATE site_audits SET checked_at = attempted_at`, args: [] });
    await queueSiteAudit(db, {
      workspaceId: SEED.workspaceId,
      companyId: 'co_queued',
      domain: 'queued.test',
    });

    const targets = await staleSiteAuditTargets(db, 10, AT);
    // Lead companies first, then the imported directory row nobody works at yet.
    expect(targets.map((t) => t.domain)).toEqual([
      'new.test',
      'acme.com',
      'old.test',
      'mid.test',
      'directory.test',
    ]);
    expect((await staleSiteAuditTargets(db, 1, AT)).map((t) => t.domain)).toEqual(['new.test']);
  });

  test('a round runs hooked jobs first, then sweeps within the budget', async () => {
    const db = await setup('site-audit-round');
    await addCompany(db, 'co_b', 'beta.test');
    await addCompany(db, 'co_c', 'gamma.test');
    await queueSiteAudit(db, {
      workspaceId: SEED.workspaceId,
      companyId: 'co_c',
      domain: 'gamma.test',
    });
    const auditor = fakeAuditor();
    const r = await runSiteAuditRound(db, auditor, { budget: 2, concurrency: 1, now: AT });
    expect(r).toMatchObject({ jobs: 1, swept: 1, ok: 2, held: false });
    expect(auditor.calls[0]).toBe('https://gamma.test/');
    expect(
      (await queryOne<{ status: string }>(db, `SELECT status FROM jobs WHERE kind = 'seo_audit'`))
        ?.status,
    ).toBe('done');
    const stats = await siteAuditStats(db, AT);
    expect(stats).toMatchObject({
      companies: 3,
      audited: 2,
      neverAudited: 1,
      auditedLast24h: 2,
      pendingJobs: 0,
    });
  });

  test('seo.rank saying "not now" holds the round and refunds the job', async () => {
    const db = await setup('site-audit-held');
    await queueSiteAudit(db, {
      workspaceId: SEED.workspaceId,
      companyId: SEED.companyId,
      domain: 'acme.com',
    });
    const auditor = fakeAuditor({
      'https://acme.com/': () => {
        throw new SeoRankUnavailable('Busy', 503, 10);
      },
    });
    const r = await runSiteAuditRound(db, auditor, { budget: 5, concurrency: 2, now: AT });
    expect(r.held).toBe(true);
    expect(r.swept).toBe(0);
    const job = await queryOne<{ status: string; attempts: number }>(
      db,
      `SELECT status, attempts FROM jobs WHERE kind = 'seo_audit'`,
    );
    expect(job).toMatchObject({ status: 'pending', attempts: 0 });
  });

  test('a transient failure retries the job with backoff and dead-letters it after max attempts', async () => {
    const db = await setup('site-audit-job-retry');
    await queueSiteAudit(db, {
      workspaceId: SEED.workspaceId,
      companyId: SEED.companyId,
      domain: 'acme.com',
    });
    const auditor = fakeAuditor({
      'https://acme.com/': () => {
        throw new Error('seo.rank answered 500');
      },
    });
    const r = await runSiteAuditRound(db, auditor, { budget: 1, concurrency: 1, now: AT });
    expect(r.errors).toBe(1);
    const job = await queryOne<{ status: string; run_after: string; last_error: string }>(
      db,
      `SELECT status, run_after, last_error FROM jobs WHERE kind = 'seo_audit'`,
    );
    expect(job?.status).toBe('pending');
    expect(Date.parse(job!.run_after)).toBeGreaterThan(Date.now());
    expect(job?.last_error).toContain('500');
    // Exhaust it: max_attempts is 6.
    await db.execute({
      sql: `UPDATE jobs SET attempts = 5, run_after = ? WHERE kind = 'seo_audit'`,
      args: [iso(-DAY)],
    });
    await runSiteAuditRound(db, auditor, { budget: 1, concurrency: 1, now: AT });
    expect(
      (await queryOne<{ status: string }>(db, `SELECT status FROM jobs WHERE kind = 'seo_audit'`))
        ?.status,
    ).toBe('failed');
  });

  test('a hooked job skips a company audited in the last few hours unless forced', async () => {
    const db = await setup('site-audit-fresh');
    const auditor = fakeAuditor();
    await auditCompanySite(db, auditor, { companyId: SEED.companyId, domain: 'acme.com' }, AT);
    await queueSiteAudit(db, {
      workspaceId: SEED.workspaceId,
      companyId: SEED.companyId,
      domain: 'acme.com',
    });
    const job = await claimNext(db, undefined, { kinds: ['seo_audit'] });
    expect(await runSiteAuditJob(db, auditor, job!, new Date(AT.getTime() + 3_600_000))).toBe(
      'skipped',
    );
    expect(
      await runSiteAuditJob(
        db,
        auditor,
        { ...job!, payload: { ...job!.payload, force: true } },
        AT,
      ),
    ).toBe('ok');
  });

  test('the main drain never claims an audit', async () => {
    const db = await setup('site-audit-main-drain');
    await queueSiteAudit(db, {
      workspaceId: SEED.workspaceId,
      companyId: SEED.companyId,
      domain: 'acme.com',
    });
    await enqueue(db, { workspaceId: SEED.workspaceId, kind: 'rescore_prospect', payload: {} });
    const seen: string[] = [];
    await drainQueue(db, async (job) => void seen.push(job.kind), { excludeKinds: ['seo_audit'] });
    expect(seen).toEqual(['rescore_prospect']);
  });
});
