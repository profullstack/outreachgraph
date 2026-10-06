/**
 * Filling in a lead's name, title and LinkedIn: only blanks, only on
 * evidence, and never paying twice for the same search.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  SearchOutOfCredits,
  type PersonEnricher,
  type WebResult,
  type WebSearcher,
} from '@outreachgraph/providers';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import {
  enrichLeads,
  enrichmentStatus,
  lookupsToday,
  resetEnrichmentPauses,
} from './lead-enrichment';

let seeded: SeededDatabase | undefined;

beforeEach(() => resetEnrichmentPauses());
afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const T = 60_000;

/** A lead who arrived as a bare address, in the seeded campaign. */
async function addLead(db: Client, id: string, email: string, companyDomain?: string) {
  const stamp = now();
  const companyId = companyDomain ? `co_${id}` : null;
  await db.batch([
    ...(companyDomain
      ? [
          {
            sql: `INSERT INTO companies (id, name, domain, technologies, created_at, updated_at)
                  VALUES (?, ?, ?, '[]', ?, ?)`,
            args: [companyId, companyDomain, companyDomain, stamp, stamp],
          },
        ]
      : []),
    {
      sql: `INSERT INTO people (id, display_name, current_company_id, identity_confidence, status,
            outreach_eligible, created_at, updated_at)
            VALUES (?, ?, ?, 0.9, 'active', 1, ?, ?)`,
      args: [id, email.split('@')[0]!, companyId, stamp, stamp],
    },
    {
      sql: `INSERT INTO person_emails (id, workspace_id, person_id, address, dedupe_key, source,
            verified, created_at) VALUES (?, ?, ?, ?, ?, 'import', 1, ?)`,
      args: [`pe_${id}`, SEED.workspaceId, id, email, email, stamp],
    },
    {
      sql: `INSERT INTO campaign_people (campaign_id, person_id, workspace_id, status,
            interaction_state, discovered_at, updated_at)
            VALUES (?, ?, ?, 'discovered', 'never_contacted', ?, ?)`,
      args: [SEED.campaignId, id, SEED.workspaceId, stamp, stamp],
    },
  ]);
}

function searcher(answers: Record<string, WebResult[]>): {
  asked: string[];
  searcher: WebSearcher;
} {
  const asked: string[] = [];
  return {
    asked,
    searcher: {
      async search(query) {
        asked.push(query);
        return answers[query] ?? [];
      },
    },
  };
}

describe('enrichLeads', () => {
  test(
    'names from the address, title and profile from the search, company page as fallback',
    async () => {
      seeded = await seedDatabase('enrich-leads');
      const { db } = seeded;
      await addLead(db, 'per_scott', 'scott.perry@northwind.io', 'northwind.io');
      await addLead(db, 'per_kim', 'kim.ode@globex.dev', 'globex.dev');

      const { asked, searcher: fake } = searcher({
        'site:linkedin.com/in "Scott Perry" northwind': [
          {
            title: 'Scott Perry - VP Sales - Northwind | LinkedIn',
            link: 'https://www.linkedin.com/in/scott-perry-9',
          },
        ],
        'site:linkedin.com/company "globex.dev"': [
          { title: 'Globex | LinkedIn', link: 'https://www.linkedin.com/company/globex/' },
        ],
      });

      const result = await enrichLeads(
        { db, searcher: fake, concurrency: 1 },
        { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
      );

      expect(result).toMatchObject({ names: 2, titles: 1, profiles: 1, companies: 1 });

      const scott = await queryOne<{
        first_name: string;
        last_name: string;
        display_name: string;
        current_title: string;
        linkedin_looked_up_at: string | null;
      }>(
        db,
        `SELECT first_name, last_name, display_name, current_title, linkedin_looked_up_at
           FROM people WHERE id = 'per_scott'`,
      );
      expect(scott).toMatchObject({
        first_name: 'Scott',
        last_name: 'Perry',
        display_name: 'Scott Perry',
        current_title: 'VP Sales',
      });
      expect(scott?.linkedin_looked_up_at).toBeTruthy();

      const profile = await queryOne<{ profile_url: string; confidence: number }>(
        db,
        `SELECT profile_url, confidence FROM social_identities
          WHERE person_id = 'per_scott' AND network = 'linkedin'`,
      );
      expect(profile?.profile_url).toBe('https://www.linkedin.com/in/scott-perry-9');
      expect(profile!.confidence).toBeLessThan(0.85);

      const globex = await queryOne<{ linkedin_url: string }>(
        db,
        `SELECT linkedin_url FROM companies WHERE id = 'co_per_kim'`,
      );
      expect(globex?.linkedin_url).toBe('https://www.linkedin.com/company/globex');

      // Rerun after forgetting who was looked up: every answer comes from the cache.
      await db.execute({ sql: 'UPDATE people SET linkedin_looked_up_at = NULL', args: [] });
      await db.execute({ sql: 'UPDATE companies SET linkedin_url = NULL', args: [] });
      const before = asked.length;
      const again = await enrichLeads(
        { db, searcher: fake, concurrency: 1 },
        { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
      );
      expect(asked.length).toBe(before);
      expect(again.searches).toBe(0);
      expect(again.cached).toBeGreaterThan(0);
      expect(await lookupsToday(db, SEED.workspaceId, 'valueserp')).toBe(before);
    },
    T,
  );

  test(
    'stops at the cap and on a 402, leaving the unanswered for the next run',
    async () => {
      seeded = await seedDatabase('enrich-caps');
      const { db } = seeded;
      for (const name of ['ann.lee', 'bo.chan', 'cy.diaz']) {
        await addLead(db, `per_${name.replace('.', '_')}`, `${name}@initech.co`);
      }

      const capped = await enrichLeads(
        { db, searcher: searcher({}).searcher, concurrency: 1 },
        { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId, maxSearches: 1 },
      );
      expect(capped.searches).toBe(1);
      expect(capped.stopped).toContain('cap');
      // At most the one person whose question was answered is stamped; the
      // rest wait for the next run rather than being marked as misses.
      const stamped = await queryAll<{ id: string }>(
        db,
        'SELECT id FROM people WHERE linkedin_looked_up_at IS NOT NULL',
      );
      expect(stamped.length).toBeLessThanOrEqual(1);

      const broke: WebSearcher = {
        async search() {
          throw new SearchOutOfCredits('ValueSERP');
        },
      };
      const stopped = await enrichLeads(
        { db, searcher: broke, concurrency: 1 },
        { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
      );
      expect(stopped.stopped).toContain('402');
      // The names still came from the addresses for free.
      const named = await queryOne<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM people
          WHERE first_name IS NOT NULL AND id IN ('per_ann_lee', 'per_bo_chan', 'per_cy_diaz')`,
      );
      expect(Number(named?.n)).toBe(3);
    },
    T,
  );

  test(
    'People Data Labs first, within its daily cap, and the status says what is missing',
    async () => {
      seeded = await seedDatabase('enrich-pdl');
      const { db } = seeded;
      await addLead(db, 'per_x', 'xq@hooli.xyz', 'hooli.xyz');

      const asked: string[] = [];
      const pdl: PersonEnricher = {
        name: 'pdl',
        async enrichByEmail(email) {
          asked.push(email);
          return {
            firstName: 'Xavier',
            lastName: 'Quinn',
            title: 'Head of Data',
            linkedinUrl: 'https://www.linkedin.com/in/xquinn',
          };
        },
      };
      const { asked: searched, searcher: fake } = searcher({});

      const status0 = await enrichmentStatus(
        { db, pdl, searcher: fake },
        { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
      );
      expect(status0.missing_title).toBe(1);

      const result = await enrichLeads(
        { db, pdl, searcher: fake, pdlPerDay: 1, concurrency: 1 },
        { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
      );
      expect(asked).toEqual(['xq@hooli.xyz']);
      expect(result).toMatchObject({ pdlMatches: 1, titles: 1, profiles: 1 });
      // Title and profile were found, so no search was spent on Xavier (the
      // seeded Jane still has no profile, and is searched for).
      expect(searched.filter((q) => /Xavier|hooli/.test(q))).toEqual([]);

      const status = await enrichmentStatus(
        { db, pdl, searcher: fake, pdlPerDay: 1 },
        { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
      );
      expect(status.missing_title).toBe(0);
      expect(status.today.pdl_lookups).toBe(1);
      expect(status.providers).toEqual({ address: true, valueserp: true, pdl: true });
    },
    T,
  );
});
