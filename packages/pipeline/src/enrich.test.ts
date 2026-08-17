/**
 * The wall this exists to get past.
 *
 * Production holds 213 prospects and no personal address for any of them, so
 * every message resolves to a company `support@`. The address limits then
 * correctly refuse it, and the queue reads as broken. Crawling deeper was
 * tried and found nothing — every address published on `/team` and `/about`
 * across eight of these companies was a role mailbox.
 *
 * So the tests that matter here are about two things: that one confirmed
 * address teaches the shape for a colleague, and that nothing derived can
 * reach an inbox without a human first saying yes.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import {
  candidatesForPerson,
  confirmCandidate,
  knownPatternsForDomain,
  proposeAddresses,
  rejectCandidate,
} from './enrich';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

async function harness(label: string): Promise<Client> {
  seeded = await seedDatabase(label);
  return seeded.db;
}

/** A colleague at Acme with a name and no address, which is the production shape. */
async function addColleague(db: Client, id: string, displayName: string): Promise<string> {
  const stamp = now();

  await db.batch([
    {
      sql: `INSERT INTO people (id, display_name, current_company_id, current_title,
            location, identity_confidence, status, outreach_eligible, believed_minor,
            created_at, updated_at)
            VALUES (?, ?, ?, 'Director', 'Remote', 0.95, 'active', 1, 0, ?, ?)`,
      args: [id, displayName, SEED.companyId, stamp, stamp],
    },
    {
      sql: `INSERT INTO campaign_people (campaign_id, person_id, workspace_id, status,
            interaction_state, discovered_at, updated_at)
            VALUES (?, ?, ?, 'recommended', 'never_contacted', ?, ?)`,
      args: [SEED.campaignId, id, SEED.workspaceId, stamp, stamp],
    },
  ]);

  return id;
}

describe('proposing addresses', () => {
  test('offers candidates for a prospect with no way to be reached', async () => {
    const db = await harness('enrich-proposes');
    const result = await proposeAddresses(db, SEED.workspaceId);

    expect(result.proposed).toBeGreaterThan(0);

    const candidates = await candidatesForPerson(db, SEED.workspaceId, SEED.personId);
    expect(candidates.map((c) => c.address)).toContain('jane@acme.com');
  });

  test('nothing proposed is sendable — the sender reads identities, not proposals', async () => {
    // The safety property in one assertion. Proposing must never create a way
    // to reach anybody; only a human confirming does that.
    const db = await harness('enrich-not-sendable');
    await proposeAddresses(db, SEED.workspaceId);

    const identity = await queryOne<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM social_identities WHERE network = 'email'`,
    );
    expect(Number(identity?.n)).toBe(0);
  });

  test('with nothing confirmed at the domain, every candidate is a guess', async () => {
    const db = await harness('enrich-all-guesses');
    await proposeAddresses(db, SEED.workspaceId);

    for (const candidate of await candidatesForPerson(db, SEED.workspaceId, SEED.personId)) {
      expect(candidate.derived).toBe(0);
      expect(candidate.confidence).toBeLessThan(0.5);
      expect(candidate.basis).toContain('No confirmed address');
    }
  });

  test('passes over a role account, which has no first name to build on', async () => {
    const db = await harness('enrich-skips-role');
    await addColleague(db, 'per_webmaster', 'webmaster');

    const result = await proposeAddresses(db, SEED.workspaceId);

    expect(result.skipped).toBeGreaterThan(0);
    expect(await candidatesForPerson(db, SEED.workspaceId, 'per_webmaster')).toHaveLength(0);
  });

  test('ignores anyone who already has a personal address', async () => {
    const db = await harness('enrich-skips-reachable');
    await db.execute({
      sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
            confidence, source_type, verified_by, first_seen_at)
            VALUES ('sid_has', ?, 'email', 'jane@acme.com', 'jane@acme.com', 0.9,
            'public_web', '[]', ?)`,
      args: [SEED.personId, now()],
    });

    await proposeAddresses(db, SEED.workspaceId);
    expect(await candidatesForPerson(db, SEED.workspaceId, SEED.personId)).toHaveLength(0);
  });

  test('records the split name, which production never stored', async () => {
    const db = await harness('enrich-splits-name');
    const id = await addColleague(db, 'per_tuan', 'Tuan-Anh Tran');

    await proposeAddresses(db, SEED.workspaceId);

    const person = await queryOne<{ first_name: string; last_name: string }>(
      db,
      'SELECT first_name, last_name FROM people WHERE id = ?',
      [id],
    );
    expect(person?.first_name).toBe('tuan-anh');
    expect(person?.last_name).toBe('tran');
  });
});

describe('learning a company from one confirmed address', () => {
  test('reads the shape back off a confirmed identity', async () => {
    const db = await harness('enrich-learns-shape');
    await proposeAddresses(db, SEED.workspaceId);
    await confirmCandidate(db, {
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      address: 'j.smith@acme.com',
      actorId: SEED.userId,
    });

    expect(await knownPatternsForDomain(db, SEED.workspaceId, 'acme.com')).toContain('f.last');
  });

  test('a colleague stops being a guess once one address is confirmed', async () => {
    // This is the whole point of the module: 17 people behind one shared inbox
    // become 17 derivations as soon as one of them is right.
    const db = await harness('enrich-teaches-colleague');
    const colleague = await addColleague(db, 'per_wes', 'Wes Todd');

    await proposeAddresses(db, SEED.workspaceId);
    await confirmCandidate(db, {
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      address: 'j.smith@acme.com',
      actorId: SEED.userId,
    });

    const second = await proposeAddresses(db, SEED.workspaceId);
    expect(second.domainsLearned).toContain('acme.com');

    const [best] = await candidatesForPerson(db, SEED.workspaceId, colleague);
    expect(best?.address).toBe('w.todd@acme.com');
    expect(best?.derived).toBe(1);
    expect(best?.basis).toContain('learned from');
  });

  test('a role mailbox teaches nothing, however many are confirmed', async () => {
    // `support@acme.com` fits no name-based shape, which is exactly why the
    // product ended up with 24 sends to 6 addresses and no pattern to show.
    const db = await harness('enrich-role-teaches-nothing');
    await db.execute({
      sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
            confidence, source_type, verified_by, first_seen_at)
            VALUES ('sid_role', ?, 'email', 'support@acme.com', 'support@acme.com', 0.9,
            'public_web', '[]', ?)`,
      args: [SEED.personId, now()],
    });

    expect(await knownPatternsForDomain(db, SEED.workspaceId, 'acme.com')).toEqual([]);
  });
});

describe('deciding on a candidate', () => {
  test('confirming is what makes a prospect personally reachable', async () => {
    const db = await harness('enrich-confirm-writes-identity');
    await proposeAddresses(db, SEED.workspaceId);

    const result = await confirmCandidate(db, {
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      address: 'jane@acme.com',
      actorId: SEED.userId,
    });
    expect(result.confirmed).toBe(true);

    // The sender resolves recipients from this table, so this row is the
    // difference between reaching Jane and reaching her company's front desk.
    const identity = await queryOne<{ handle: string; source_type: string }>(
      db,
      `SELECT handle, source_type FROM social_identities
        WHERE person_id = ? AND network = 'email'`,
      [SEED.personId],
    );
    expect(identity?.handle).toBe('jane@acme.com');
    // The operator is the evidence — that is what grounds the claim.
    expect(identity?.source_type).toBe('human');
  });

  test('confirming one retires the rest, which are now moot', async () => {
    const db = await harness('enrich-confirm-retires');
    await proposeAddresses(db, SEED.workspaceId);
    await confirmCandidate(db, {
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      address: 'jane@acme.com',
      actorId: SEED.userId,
    });

    const left = await candidatesForPerson(db, SEED.workspaceId, SEED.personId);
    expect(left).toHaveLength(1);
    expect(left[0]?.status).toBe('confirmed');
  });

  test('a rejected address is never proposed again', async () => {
    const db = await harness('enrich-reject-sticks');
    await proposeAddresses(db, SEED.workspaceId);

    expect(
      await rejectCandidate(db, {
        workspaceId: SEED.workspaceId,
        personId: SEED.personId,
        address: 'jane@acme.com',
        actorId: SEED.userId,
      }),
    ).toBe(true);

    // Re-running the stage is the normal way to use it, so a decision that
    // did not survive it would be worthless.
    await proposeAddresses(db, SEED.workspaceId);

    const addresses = (await candidatesForPerson(db, SEED.workspaceId, SEED.personId)).map(
      (c) => c.address,
    );
    expect(addresses).not.toContain('jane@acme.com');
  });

  test('re-running refreshes an undecided proposal rather than duplicating it', async () => {
    const db = await harness('enrich-idempotent');
    await proposeAddresses(db, SEED.workspaceId);
    await proposeAddresses(db, SEED.workspaceId);

    const rows = await queryAll<{ address: string }>(
      db,
      `SELECT address FROM email_candidates WHERE person_id = ?`,
      [SEED.personId],
    );
    expect(new Set(rows.map((r) => r.address)).size).toBe(rows.length);
  });

  test('accepts an address the operator simply knows', async () => {
    // The highest-value input in the whole module. Refusing it because nothing
    // derived it first would throw away the one confirmation that teaches the
    // domain's shape to every colleague.
    const db = await harness('enrich-confirm-supplied');
    const result = await confirmCandidate(db, {
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      address: 'j.smith@acme.com',
      actorId: SEED.userId,
    });

    expect(result.confirmed).toBe(true);
    expect(await knownPatternsForDomain(db, SEED.workspaceId, 'acme.com')).toContain('f.last');
  });

  test('refuses something that is not an address at all', async () => {
    const db = await harness('enrich-confirm-garbage');
    const result = await confirmCandidate(db, {
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      address: 'Jane Smith',
      actorId: SEED.userId,
    });
    expect(result.confirmed).toBe(false);
  });
});
