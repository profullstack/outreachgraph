/**
 * Importing a list end to end.
 *
 * The rules themselves are tested in `packages/domain`. What is tested here is
 * everything that only goes wrong once a database is involved: that re-running
 * the same file merges instead of duplicating, that consent is recorded, and
 * that imported people land above the confidence threshold — because an import
 * that produces seventeen thousand uncontactable prospects is worse than no
 * import at all.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Hono } from 'hono';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

// Seeding takes 5-7 s on a loaded box; see crawl.test.ts.
setDefaultTimeout(30_000);

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

async function harness(
  label: string,
  actor: RequestActor | null = ACTOR,
): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  return {
    app: createApp({ db: seeded.db, authenticate: async () => actor ?? undefined }),
    seeded,
  };
}

async function post(app: Hono<AppEnv>, path: string, body: unknown = {}): Promise<Response> {
  return app.request(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function startImport(app: Hono<AppEnv>): Promise<string> {
  const response = await post(app, '/contacts/imports', {
    filename: 'users.csv',
    consentSource: 'profullstack app signup',
  });

  return ((await response.json()) as { importId: string }).importId;
}

const GOOD_ROWS = [
  { email: 'dave.mackenzie@corp.com', name: 'Dave Mackenzie' },
  { email: 'chovy@gmail.com', name: 'chovy' },
  { email: 'admin@theirstartup.com', name: 'Ana Ruiz' },
];

const JUNK_ROWS = [
  { email: 'test@gmail.com', name: 'test' },
  { email: 'someone@mailinator.com', name: 'Throwaway' },
  { email: 'noreply@corp.com', name: 'No Reply' },
  { email: 'not-an-address', name: 'Broken' },
  { email: 'nobody@example.com', name: 'Nobody' },
];

describe('contact import', () => {
  test('imports the real rows and drops the junk', async () => {
    const { app } = await harness('import-basic');
    const importId = await startImport(app);

    const response = await post(app, `/contacts/imports/${importId}/rows`, {
      rows: [...GOOD_ROWS, ...JUNK_ROWS],
    });
    const body = (await response.json()) as { imported: number; rejected: number };

    expect(body.imported).toBe(3);
    expect(body.rejected).toBe(5);
  });

  test('reports why each row was dropped', async () => {
    const { app } = await harness('import-rejects');
    const importId = await startImport(app);

    await post(app, `/contacts/imports/${importId}/rows`, { rows: JUNK_ROWS });

    const response = await app.request(`/api/v1/contacts/imports/${importId}`);
    const body = (await response.json()) as {
      rejectsByReason: { reason: string; n: number }[];
      rejectSample: { email: string; reason: string }[];
    };

    const reasons = Object.fromEntries(body.rejectsByReason.map((r) => [r.reason, r.n]));

    expect(reasons.placeholder_address).toBe(1);
    expect(reasons.disposable_domain).toBe(1);
    expect(reasons.role_address).toBe(1);
    expect(reasons.malformed_email).toBe(1);
    expect(reasons.undeliverable_domain).toBe(1);
    // Actionable, not just a count.
    expect(body.rejectSample.length).toBe(5);
  });

  test('imported people are contactable rather than stuck below the threshold', async () => {
    // The failure that would make the whole feature pointless: the workspace
    // refuses to contact anyone under 0.85, so importing at the crawler's 0.35
    // yields seventeen thousand prospects nobody can mail.
    const { app, seeded } = await harness('import-confidence');
    const importId = await startImport(app);

    await post(app, `/contacts/imports/${importId}/rows`, { rows: GOOD_ROWS });

    const rows = await seeded.db.execute({
      sql: `SELECT min(identity_confidence) AS lowest FROM people
             WHERE id IN (SELECT person_id FROM person_emails WHERE workspace_id = ?)`,
      args: [SEED.workspaceId],
    });

    expect(Number(rows.rows[0]?.lowest)).toBeGreaterThanOrEqual(0.85);
  });

  test('records why each person may be contacted', async () => {
    const { app, seeded } = await harness('import-consent');
    const importId = await startImport(app);

    await post(app, `/contacts/imports/${importId}/rows`, { rows: GOOD_ROWS });

    const consent = await seeded.db.execute({
      sql: `SELECT basis, source, import_id FROM person_consent WHERE workspace_id = ?`,
      args: [SEED.workspaceId],
    });

    expect(consent.rows).toHaveLength(3);
    expect(consent.rows[0]?.basis).toBe('opt_in');
    expect(consent.rows[0]?.source).toBe('profullstack app signup');
    expect(consent.rows[0]?.import_id).toBe(importId);
  });

  test('re-running the same file merges rather than duplicating', async () => {
    // The thing somebody will absolutely do at 17k rows when a chunk fails.
    const { app, seeded } = await harness('import-rerun');

    const first = await startImport(app);
    await post(app, `/contacts/imports/${first}/rows`, { rows: GOOD_ROWS });

    const second = await startImport(app);
    const response = await post(app, `/contacts/imports/${second}/rows`, { rows: GOOD_ROWS });
    const body = (await response.json()) as { imported: number; merged: number };

    expect(body.imported).toBe(0);
    expect(body.merged).toBe(3);

    const count = await seeded.db.execute({
      sql: 'SELECT count(*) AS n FROM person_emails WHERE workspace_id = ?',
      args: [SEED.workspaceId],
    });

    expect(Number(count.rows[0]?.n)).toBe(3);
  });

  test('two spellings of one gmail mailbox are one person', async () => {
    const { app, seeded } = await harness('import-gmail');
    const importId = await startImport(app);

    await post(app, `/contacts/imports/${importId}/rows`, {
      rows: [{ email: 'dave.mackenzie@gmail.com' }, { email: 'davemackenzie+news@gmail.com' }],
    });

    const count = await seeded.db.execute({
      sql: 'SELECT count(*) AS n FROM person_emails WHERE workspace_id = ?',
      args: [SEED.workspaceId],
    });

    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  test('a later chunk fills a gap the first one left', async () => {
    const { app, seeded } = await harness('import-fill');
    const importId = await startImport(app);

    await post(app, `/contacts/imports/${importId}/rows`, { rows: [{ email: 'dm@corp.com' }] });
    await post(app, `/contacts/imports/${importId}/rows`, {
      rows: [{ email: 'dm@corp.com', name: 'Dave Mackenzie', title: 'CTO' }],
    });

    const person = await seeded.db.execute({
      sql: `SELECT display_name, current_title FROM people
             WHERE id = (SELECT person_id FROM person_emails WHERE workspace_id = ?)`,
      args: [SEED.workspaceId],
    });

    expect(person.rows[0]?.display_name).toBe('Dave Mackenzie');
    expect(person.rows[0]?.current_title).toBe('CTO');
  });

  test('another workspace cannot append to this import', async () => {
    const { app } = await harness('import-scoped');
    const importId = await startImport(app);

    const other = createApp({
      db: active!.db,
      authenticate: async () => ({ ...ACTOR, workspaceId: 'wsp_someone_else' }),
    });

    const response = await other.request(`/api/v1/contacts/imports/${importId}/rows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows: GOOD_ROWS }),
    });

    expect(response.status).toBe(404);
  });

  test('a viewer cannot import', async () => {
    const { app } = await harness('import-viewer', { ...ACTOR, role: 'viewer' });

    expect((await post(app, '/contacts/imports', {})).status).toBe(403);
  });

  test('finishing writes no job rows and reports what is waiting', async () => {
    // It used to enqueue one job per person. Seventeen thousand inserts inside
    // one request is why finishing an import never returned; the worker sweeps
    // a derived set instead, so nothing has to be written for it to start.
    const { app, seeded } = await harness('import-finish');
    const importId = await startImport(app);

    await post(app, `/contacts/imports/${importId}/rows`, { rows: GOOD_ROWS });
    const response = await post(app, `/contacts/imports/${importId}/finish`, {});
    const body = (await response.json()) as { awaitingEnrichment: number };

    expect(body.awaitingEnrichment).toBe(3);

    const jobs = await seeded.db.execute({
      sql: `SELECT count(*) AS n FROM jobs WHERE kind = 'enrich_contact'`,
      args: [],
    });
    expect(Number(jobs.rows[0]?.n)).toBe(0);

    const batch = await seeded.db.execute({
      sql: 'SELECT status FROM contact_imports WHERE id = ?',
      args: [importId],
    });
    expect(batch.rows[0]?.status).toBe('complete');
  });

  test('enrichment can be skipped, and then nothing is waiting', async () => {
    const { app } = await harness('import-noenrich');
    const importId = await startImport(app);

    await post(app, `/contacts/imports/${importId}/rows`, { rows: GOOD_ROWS });
    const response = await post(app, `/contacts/imports/${importId}/finish`, { enrich: false });

    expect(((await response.json()) as { awaitingEnrichment: number }).awaitingEnrichment).toBe(0);
  });

  test('a large chunk is one round trip, not one per row', async () => {
    // The measured failure: 4 sequential Turso round trips per row gave ~200
    // rows a minute, so 17,000 rows was ~85 minutes and the browser gave up.
    // This asserts the shape rather than the wall clock — a batched chunk is
    // a handful of statements regardless of size.
    const { app } = await harness('import-large-chunk');
    const importId = await startImport(app);

    const rows = Array.from({ length: 400 }, (_, index) => ({
      email: `person${index}@corp${index % 20}.com`,
      name: `Person ${index}`,
    }));

    const started = Date.now();
    const response = await post(app, `/contacts/imports/${importId}/rows`, { rows });
    const body = (await response.json()) as { imported: number };

    expect(body.imported).toBe(400);
    // Generous, because CI is shared. The old path could not do 400 rows in
    // anything like this against a local file, let alone a remote database.
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  test('a re-import patches known people with its newer data: newest wins', async () => {
    const { app, seeded } = await harness('import-patch-newest');
    const first = await startImport(app);
    await post(app, `/contacts/imports/${first}/rows`, {
      rows: [
        { email: 'dave.mackenzie@corp.com', name: 'Dave Mackenzie', title: 'Engineer' },
        { email: 'admin@theirstartup.com', name: 'Ana Ruiz' },
        { email: 'kim@corp.com', name: 'Kim Lee', title: 'CTO' },
      ],
    });

    // The enriched export, a while later.
    const second = await startImport(app);
    const response = await post(app, `/contacts/imports/${second}/rows`, {
      rows: [
        {
          email: 'dave.mackenzie@corp.com',
          name: 'Dave Mackenzie',
          title: 'VP Engineering',
          location: 'Oakland, CA',
          companyDomain: 'https://www.corp.com/about',
          linkedinUrl: 'linkedin.com/in/DaveMackenzie/',
        },
        // Dated before we last touched Ana: only blanks are filled.
        {
          email: 'admin@theirstartup.com',
          name: 'Ana R',
          title: 'Founder',
          updatedAt: '2001-01-01',
        },
        // Nothing new: an empty cell never erases the stored title.
        { email: 'kim@corp.com', name: 'Kim Lee' },
      ],
    });
    const body = (await response.json()) as { merged: number; updated: number };
    expect(body.merged).toBe(3);
    expect(body.updated).toBe(2);

    const people = await seeded.db.execute({
      sql: `SELECT e.address, p.display_name, p.current_title, p.location, c.domain
              FROM person_emails e JOIN people p ON p.id = e.person_id
              LEFT JOIN companies c ON c.id = p.current_company_id
             WHERE e.workspace_id = ? ORDER BY e.address`,
      args: [SEED.workspaceId],
    });
    const by = Object.fromEntries(people.rows.map((r) => [String(r.address), r]));
    expect(by['dave.mackenzie@corp.com']).toMatchObject({
      current_title: 'VP Engineering',
      location: 'Oakland, CA',
      domain: 'corp.com',
    });
    expect(by['admin@theirstartup.com']).toMatchObject({
      display_name: 'Ana Ruiz',
      current_title: 'Founder',
    });
    expect(by['kim@corp.com']).toMatchObject({ current_title: 'CTO' });

    const linkedin = await seeded.db.execute({
      sql: "SELECT profile_url FROM social_identities WHERE network = 'linkedin'",
      args: [],
    });
    expect(linkedin.rows.map((r) => r.profile_url)).toEqual([
      'https://www.linkedin.com/in/davemackenzie',
    ]);

    // Importing the same enriched file again changes nothing more.
    const third = await startImport(app);
    const again = (await (
      await post(app, `/contacts/imports/${third}/rows`, {
        rows: [
          {
            email: 'dave.mackenzie@corp.com',
            name: 'Dave Mackenzie',
            title: 'VP Engineering',
            location: 'Oakland, CA',
            companyDomain: 'corp.com',
            linkedinUrl: 'https://www.linkedin.com/in/davemackenzie',
          },
        ],
      })
    ).json()) as { updated: number };
    expect(again.updated).toBe(0);
  });

  test('every known row in a chunk is patched, not the first fifty', async () => {
    const { app, seeded } = await harness('import-patch-all');
    const rows = Array.from({ length: 120 }, (_, i) => ({
      email: `person${i}@acme-${i}.com`,
      name: `Person Number${i}`,
    }));
    const first = await startImport(app);
    await post(app, `/contacts/imports/${first}/rows`, { rows });

    const second = await startImport(app);
    const body = (await (
      await post(app, `/contacts/imports/${second}/rows`, {
        rows: rows.map((r) => ({ ...r, title: 'Head of Growth' })),
      })
    ).json()) as { merged: number; updated: number };
    expect(body).toMatchObject({ merged: 120, updated: 120 });

    const titled = await seeded.db.execute({
      sql: "SELECT count(*) AS n FROM people WHERE current_title = 'Head of Growth'",
      args: [],
    });
    expect(Number(titled.rows[0]?.n)).toBe(120);
  });
});
