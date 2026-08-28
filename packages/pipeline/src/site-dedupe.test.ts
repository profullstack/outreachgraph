/**
 * A person read off a company site is one person, however often we read it.
 *
 * Production reached 422 rows for a single founder and 77,816 rows for 21,219
 * distinct names, because `storeSiteIdentity` wrote `host:name-slug` on every
 * crawl and `upsertPerson` never searched for it. Each duplicate then proposed
 * a fresh `refresh_research` card, which auto-approval turned back into the
 * crawl that produced it — 1,113 requests against 46 sites in one day.
 *
 * These cover the two halves that have to agree: the key itself, and a second
 * pass over the same page landing on the same person.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { PersonCandidate, ProviderCapabilities } from '@outreachgraph/providers';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { runPipelineForCandidate, siteIdentityKey } from './pipeline';

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

const CAPABILITIES: ProviderCapabilities = {
  slug: 'site',
  displayName: 'Company site',
  networks: ['website'],
  canSearch: false,
  canEnrich: true,
  licenseClass: 'public_web',
  sourceType: 'public_web',
  costPerEnrichmentUsd: 0,
};

/** Exactly what a team page yields: a name, a title, and nothing else. */
const CANDIDATE: PersonCandidate = {
  fullName: 'Jordan Blake',
  firstName: 'Jordan',
  lastName: 'Blake',
  title: 'Founder',
  companyName: 'ShortsFast',
  companyDomain: 'shortsfast.com',
  identities: [],
  observedAt: new Date().toISOString(),
};

const ORIGIN = {
  capabilities: CAPABILITIES,
  sourceUrl: 'https://shortsfast.com/team',
};

describe('siteIdentityKey', () => {
  test('is stable across www, scheme, case and path', () => {
    const key = siteIdentityKey('https://shortsfast.com/team', 'Jordan Blake');

    expect(key).toBe('shortsfast.com:jordan-blake');
    expect(siteIdentityKey('http://www.ShortsFast.com/about', 'jordan blake')).toBe(key);
  });

  test('separates two different people on one site', () => {
    expect(siteIdentityKey('https://shortsfast.com/team', 'Jordan Blake')).not.toBe(
      siteIdentityKey('https://shortsfast.com/team', 'Brad Hutchison'),
    );
  });

  test('separates one name across two sites', () => {
    expect(siteIdentityKey('https://shortsfast.com/team', 'Jordan Blake')).not.toBe(
      siteIdentityKey('https://oracore.ai/team', 'Jordan Blake'),
    );
  });

  test('declines to key what it cannot identify', () => {
    // No key rather than a blank one: an empty key would match every person
    // who also failed to produce one.
    expect(siteIdentityKey(undefined, 'Jordan Blake')).toBeUndefined();
    expect(siteIdentityKey('not a url', 'Jordan Blake')).toBeUndefined();
    expect(siteIdentityKey('https://shortsfast.com/team', '!!!')).toBeUndefined();
  });
});

describe('re-crawling a company site', () => {
  test('resolves to the same person instead of inserting a second', async () => {
    active = await seedDatabase('site-dedupe-repeat');
    const { db } = active;

    const opts = {
      db,
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      providers: [],
    };

    const first = await runPipelineForCandidate(opts, CANDIDATE, ORIGIN);
    const second = await runPipelineForCandidate(opts, CANDIDATE, ORIGIN);

    expect(first.personId).toBeDefined();
    expect(second.personId).toBe(first.personId!);

    const rows = await db.execute({
      sql: 'SELECT count(*) AS n FROM people WHERE display_name = ?',
      args: ['Jordan Blake'],
    });
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  test('still separates two people named on the same page', async () => {
    active = await seedDatabase('site-dedupe-distinct');
    const { db } = active;

    const opts = {
      db,
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      providers: [],
    };

    const jordan = await runPipelineForCandidate(opts, CANDIDATE, ORIGIN);
    const brad = await runPipelineForCandidate(
      opts,
      { ...CANDIDATE, fullName: 'Brad Hutchison', firstName: 'Brad', lastName: 'Hutchison' },
      ORIGIN,
    );

    expect(brad.personId).not.toBe(jordan.personId);
  });

  test('a deeper page on the same site is still the same person', async () => {
    active = await seedDatabase('site-dedupe-deeper');
    const { db } = active;

    const opts = {
      db,
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      providers: [],
    };

    const team = await runPipelineForCandidate(opts, CANDIDATE, ORIGIN);
    const about = await runPipelineForCandidate(opts, CANDIDATE, {
      ...ORIGIN,
      sourceUrl: 'https://www.shortsfast.com/about-us',
    });

    expect(about.personId).toBe(team.personId!);
  });
});
