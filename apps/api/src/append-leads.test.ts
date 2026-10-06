/**
 * Adding leads to a campaign that already exists, with nothing dropped
 * silently: the per-row report, the dedupe against the campaign, the project
 * and suppress lists, and screening holding the junk back from sending.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { now, queryAll, queryOne } from '@outreachgraph/db';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
  credential: 'api_key',
};

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

async function harness(label: string): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  const app = createApp({ db: seeded.db, authenticate: async () => ACTOR });
  return { app, seeded };
}

const send = (app: Hono<AppEnv>, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

interface AppendResult {
  task_id: string;
  received: number;
  added: number;
  imported: number;
  rejected: number;
  skipped: number;
  flagged: number;
  report: { row: number; email: string | null; outcome: string; reason: string; why: string }[];
  report_url: string;
}

const T = 60_000;

describe('POST /autogtm/campaigns/:id/leads', () => {
  test(
    'appends, dedupes, reports every row and holds screened leads back',
    async () => {
      const { app, seeded } = await harness('append-leads');
      const { db } = seeded;

      // A suppress list, and a second campaign in the same project with a member.
      await send(app, 'POST', '/autogtm/suppress-list/people', {
        list_name: 'Do not contact',
        emails: ['blocked@northwind.io'],
      });
      const other = await send(app, 'POST', '/autogtm/campaigns/import', {
        name: 'Earlier list',
        project_id: SEED.offeringId,
        leads: [{ email: 'old.friend@northwind.io', first_name: 'Old', last_name: 'Friend' }],
      });
      expect(other.status).toBe(201);

      const first = await send(app, 'POST', `/autogtm/campaigns/${SEED.campaignId}/leads`, {
        leads: [
          {
            email: 'ana.reyes@northwind.io',
            first_name: 'Ana',
            last_name: 'Reyes',
            company_domain: 'northwind.io',
            job_title: 'Head of Ops',
          },
          { email: 'not-an-email', first_name: 'Nope' },
          { first_name: 'No', last_name: 'Address' },
          { email: 'blocked@northwind.io' },
          { email: 'old.friend@northwind.io' },
          { email: 'hide@passmail.net', first_name: 'Jalen', last_name: 'Borer853' },
          { email: 'info@northwind.io' },
        ],
      });
      expect(first.status).toBe(201);
      const body = (await first.json()) as AppendResult;

      expect(body.received).toBe(7);
      expect(body.rejected).toBe(2);
      expect(body.skipped).toBe(2);
      // ana, the relay and the role inbox join; two of them are held.
      expect(body.added).toBe(3);
      expect(body.flagged).toBe(2);

      const byRow = new Map(body.report.map((row) => [`${row.row}:${row.outcome}`, row]));
      expect(byRow.get('2:rejected')?.reason).toBe('malformed_email');
      expect(byRow.get('3:rejected')?.reason).toBe('no_email');
      expect(byRow.get('3:rejected')?.why).toContain('"email"');
      expect(byRow.get('4:skipped')?.reason).toBe('suppressed');
      expect(byRow.get('5:skipped')?.reason).toBe('already_in_project');
      expect(byRow.get('6:flagged')?.reason).toBe('generated_name+relay_address');
      expect(byRow.get('7:flagged')?.reason).toBe('role_address');

      // Re-running the same leads adds nobody and says why for each.
      const again = (await (
        await send(app, 'POST', `/autogtm/campaigns/${SEED.campaignId}/leads`, {
          leads: [{ email: 'ana.reyes@northwind.io', job_title: 'COO' }],
        })
      ).json()) as AppendResult;
      expect(again.added).toBe(0);
      expect(again.report[0]?.reason).toBe('already_in_campaign');
      // ...but the newer data still landed on the person.
      const ana = await queryOne<{ current_title: string }>(
        db,
        `SELECT p.current_title FROM people p JOIN person_emails pe ON pe.person_id = p.id
          WHERE pe.address = 'ana.reyes@northwind.io'`,
      );
      expect(ana?.current_title).toBe('COO');

      // The full report downloads as CSV.
      const csv = await app.request(body.report_url);
      expect(csv.headers.get('content-type')).toContain('text/csv');
      const text = await csv.text();
      expect(text.split('\n')[0]).toBe('row,email,outcome,reason,why,detail');
      expect(text).toContain('blocked@northwind.io,skipped,suppressed');

      // The screened list names them, and an override clears the hold.
      const screened = (await (
        await app.request(`/api/v1/autogtm/campaigns/${SEED.campaignId}/screened`)
      ).json()) as { held: number; leads: { person_id: string; flags: string[] }[] };
      expect(screened.held).toBe(2);
      const relay = screened.leads.find((lead) => lead.flags.includes('relay_address'));
      expect(relay).toBeDefined();

      const allowed = await send(app, 'POST', `/autogtm/leads/${relay!.person_id}/screening`, {
        allow: true,
      });
      expect(allowed.status).toBe(200);
      const after = (await (
        await app.request(`/api/v1/autogtm/campaigns/${SEED.campaignId}/screened`)
      ).json()) as { held: number };
      expect(after.held).toBe(1);

      const rows = await queryAll<{ outcome: string }>(
        db,
        `SELECT outcome FROM contact_import_rejects WHERE import_id = ?`,
        [body.task_id],
      );
      expect(rows.length).toBe(6);
    },
    T,
  );

  test(
    'takes the CSV itself and names a missing email column',
    async () => {
      const { app } = await harness('append-csv');

      const missing = await send(app, 'POST', `/autogtm/campaigns/${SEED.campaignId}/leads`, {
        csv: 'Name,Company\nAda,Acme\n',
      });
      expect(missing.status).toBe(400);
      expect(await missing.text()).toContain('no email column');

      const ok = await send(app, 'POST', `/autogtm/campaigns/${SEED.campaignId}/leads`, {
        csv: 'Email,First Name,Last Name,Company Domain,Job Title\nada.l@acme.dev,Ada,L,acme.dev,CTO\n',
      });
      expect(ok.status).toBe(201);
      const body = (await ok.json()) as AppendResult;
      expect(body.added).toBe(1);
      expect(body.report).toEqual([]);
    },
    T,
  );

  test(
    'a held lead is refused at approval with the screening reason',
    async () => {
      const { app, seeded } = await harness('append-hold');
      const { db } = seeded;

      // Jane (the seeded prospect with a pending card) is screened as a role inbox.
      await db.execute({
        sql: `INSERT INTO lead_screens (workspace_id, person_id, findings, screened_at)
              VALUES (?, ?, ?, ?)`,
        args: [
          SEED.workspaceId,
          SEED.personId,
          JSON.stringify([{ flag: 'role_address', detail: 'info@ is a team inbox, not a person' }]),
          now(),
        ],
      });

      const refused = await send(
        app,
        'POST',
        `/recommendations/${SEED.recommendationId}/approve`,
        {},
      );
      expect(refused.status).toBe(409);
      expect(await refused.text()).toContain('Held by lead screening');

      await send(app, 'POST', `/autogtm/leads/${SEED.personId}/screening`, { allow: true });
      const retried = await send(
        app,
        'POST',
        `/recommendations/${SEED.recommendationId}/approve`,
        {},
      );
      expect(await retried.text()).not.toContain('Held by lead screening');
    },
    T,
  );
});
