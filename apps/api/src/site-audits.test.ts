import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Hono } from 'hono';
import { queryAll } from '@outreachgraph/db';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

setDefaultTimeout(30_000);

let active: SeededDatabase | undefined;
afterEach(() => {
  active?.cleanup();
  active = undefined;
});

async function harness(label: string): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  return { app: createApp({ db: seeded.db, authenticate: async () => ACTOR }), seeded };
}

async function storeAudit(seeded: SeededDatabase) {
  const stamp = new Date().toISOString();
  await seeded.db.execute({
    sql: `INSERT INTO site_audits (company_id, url, final_url, status, score, grade, http_status,
            summary_json, fixes_json, attempts, checked_at, attempted_at, next_audit_at,
            created_at, updated_at)
          VALUES (?, 'https://acme.com/', 'https://acme.com/', 'ok', 72, 'C', 200,
            '{"pass":18,"warn":4,"fail":3}',
            '[{"id":"description","label":"Meta description","priority":"high","fix":"Add one."}]',
            0, ?, ?, ?, ?, ?)`,
    args: [SEED.companyId, stamp, stamp, stamp, stamp, stamp],
  });
}

describe('site audits API', () => {
  test('the person carries their company audit, and so does its own route', async () => {
    const { app, seeded } = await harness('api-site-audit-read');
    await storeAudit(seeded);

    const person = (await (await app.request(`/api/v1/people/${SEED.personId}`)).json()) as {
      siteAudit: { company: { domain: string }; auditable: boolean; audit: { score: number } };
    };
    expect(person.siteAudit.company.domain).toBe('acme.com');
    expect(person.siteAudit.auditable).toBe(true);
    expect(person.siteAudit.audit.score).toBe(72);

    const own = await app.request(`/api/v1/people/${SEED.personId}/site-audit`);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({
      audit: { grade: 'C', fixes: [{ id: 'description' }], reportUrl: expect.any(String) },
    });
  });

  test('a person with no company audit yet reads as not audited', async () => {
    const { app } = await harness('api-site-audit-none');
    const body = (await (
      await app.request(`/api/v1/people/${SEED.personId}/site-audit`)
    ).json()) as {
      audit: unknown;
    };
    expect(body.audit).toBeNull();
  });

  test('POST queues one forced audit; a second while it is outstanding is reported', async () => {
    const { app, seeded } = await harness('api-site-audit-refresh');
    const first = await app.request(`/api/v1/people/${SEED.personId}/site-audit`, {
      method: 'POST',
    });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ queued: true });
    const second = await app.request(`/api/v1/people/${SEED.personId}/site-audit`, {
      method: 'POST',
    });
    expect(await second.json()).toMatchObject({ queued: false, alreadyQueued: true });
    const jobs = await queryAll<{ payload_json: string; workspace_id: string }>(
      seeded.db,
      `SELECT payload_json, workspace_id FROM jobs WHERE kind = 'seo_audit'`,
    );
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0]!.payload_json)).toEqual({ companyId: SEED.companyId, force: true });
  });

  test('stats count the companies, audits and queue', async () => {
    const { app, seeded } = await harness('api-site-audit-stats');
    await storeAudit(seeded);
    const stats = await (await app.request('/api/v1/site-audits/stats')).json();
    expect(stats).toMatchObject({ companies: 1, audited: 1, neverAudited: 0, averageScore: 72 });
  });

  test('an import that records a new company queues its audit', async () => {
    const { app, seeded } = await harness('api-site-audit-import-hook');
    const post = (path: string, body: unknown) =>
      app.request(`/api/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const started = (await (
      await post('/contacts/imports', { filename: 'leads.csv', consentSource: 'test' })
    ).json()) as { importId: string };
    await post(`/contacts/imports/${started.importId}/rows`, {
      rows: [
        { email: 'kim@corp.com', name: 'Kim Lee', companyDomain: 'https://www.corp.com/' },
        { email: 'sam.doe@gmail.com', name: 'Sam Doe', companyDomain: 'gmail.com' },
      ],
    });
    const jobs = await queryAll<{ dedupe_key: string }>(
      seeded.db,
      `SELECT dedupe_key FROM jobs WHERE kind = 'seo_audit'`,
    );
    expect(jobs.map((j) => j.dedupe_key)).toEqual(['seo_audit:corp.com']);
  });
});
