/**
 * Enriching an imported contact.
 *
 * The interesting cases are the misses and the repeats. Most addresses have no
 * published profile, and enrichment will be re-run — so "found nothing" and
 * "found the same thing again" both have to be ordinary, cheap outcomes rather
 * than errors or duplicates.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { newId } from '@outreachgraph/domain';
import { now, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { enrichContact } from './enrich-contact';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const PERSON = 'per_imported';

async function imported(db: Client, address: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO people (id, display_name, identity_confidence, status, created_at, updated_at)
          VALUES (?, ?, 0.9, 'active', ?, ?)`,
    args: [PERSON, address.split('@')[0] ?? 'someone', now(), now()],
  });

  await db.execute({
    sql: `INSERT INTO person_emails (id, workspace_id, person_id, address, dedupe_key, source,
          verified, created_at) VALUES (?, ?, ?, ?, ?, 'import', 1, ?)`,
    args: [newId('personEmail'), SEED.workspaceId, PERSON, address, address, now()],
  });
}

function respond(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

const PROFILE = {
  entry: [
    {
      displayName: 'Dave Mackenzie',
      currentLocation: 'Glasgow',
      job_title: 'Staff Engineer',
      accounts: [
        { shortname: 'github', url: 'https://github.com/dave', username: 'dave' },
        { shortname: 'mastodon', url: 'https://fosstodon.org/@dave' },
        // Not a channel this product can act through; must not become an
        // identity claiming we can reach him there.
        { shortname: 'wordpress', url: 'https://dave.wordpress.com' },
      ],
    },
  ],
};

describe('enrichContact', () => {
  test('turns published accounts into identities we can act on', async () => {
    seeded = await seedDatabase('enrich-found');
    await imported(seeded.db, 'dave@corp.com');

    const result = await enrichContact(
      seeded.db,
      { workspaceId: SEED.workspaceId, personId: PERSON },
      { fetchImpl: respond(PROFILE) },
    );

    expect(result.found).toBe(true);
    // github and mastodon, not wordpress.
    expect(result.identities).toBe(2);

    const rows = await seeded.db.execute({
      sql: 'SELECT network, handle FROM social_identities WHERE person_id = ? ORDER BY network',
      args: [PERSON],
    });

    expect(rows.rows.map((row) => row.network)).toEqual(['github', 'mastodon']);
    expect(rows.rows[0]?.handle).toBe('dave');
  });

  test('replaces a name derived from the address with the published one', async () => {
    seeded = await seedDatabase('enrich-name');
    await imported(seeded.db, 'dmack91@corp.com');

    await enrichContact(
      seeded.db,
      { workspaceId: SEED.workspaceId, personId: PERSON },
      { fetchImpl: respond(PROFILE) },
    );

    const person = await seeded.db.execute({
      sql: 'SELECT display_name, current_title, location FROM people WHERE id = ?',
      args: [PERSON],
    });

    expect(person.rows[0]?.display_name).toBe('Dave Mackenzie');
    expect(person.rows[0]?.current_title).toBe('Staff Engineer');
    expect(person.rows[0]?.location).toBe('Glasgow');
  });

  test('does not overwrite a real name the import supplied', async () => {
    seeded = await seedDatabase('enrich-keepname');
    await imported(seeded.db, 'dave@corp.com');
    await seeded.db.execute({
      sql: `UPDATE people SET display_name = 'Dave A. Mackenzie' WHERE id = ?`,
      args: [PERSON],
    });

    await enrichContact(
      seeded.db,
      { workspaceId: SEED.workspaceId, personId: PERSON },
      { fetchImpl: respond(PROFILE) },
    );

    const person = await seeded.db.execute({
      sql: 'SELECT display_name FROM people WHERE id = ?',
      args: [PERSON],
    });

    expect(person.rows[0]?.display_name).toBe('Dave A. Mackenzie');
  });

  test('re-running does not duplicate identities', async () => {
    seeded = await seedDatabase('enrich-twice');
    await imported(seeded.db, 'dave@corp.com');

    const input = { workspaceId: SEED.workspaceId, personId: PERSON };
    await enrichContact(seeded.db, input, { fetchImpl: respond(PROFILE) });
    const second = await enrichContact(seeded.db, input, { fetchImpl: respond(PROFILE) });

    expect(second.identities).toBe(0);

    const rows = await seeded.db.execute({
      sql: 'SELECT count(*) AS n FROM social_identities WHERE person_id = ?',
      args: [PERSON],
    });

    expect(Number(rows.rows[0]?.n)).toBe(2);
  });

  test('no profile is an ordinary answer', async () => {
    seeded = await seedDatabase('enrich-miss');
    await imported(seeded.db, 'dave@corp.com');

    const result = await enrichContact(
      seeded.db,
      { workspaceId: SEED.workspaceId, personId: PERSON },
      { fetchImpl: respond({}, 404) },
    );

    expect(result.found).toBe(false);
    expect(result.identities).toBe(0);
  });

  test('a company domain is reported, a mailbox provider is not', async () => {
    seeded = await seedDatabase('enrich-domain');
    await imported(seeded.db, 'dave@corp.com');

    const company = await enrichContact(
      seeded.db,
      { workspaceId: SEED.workspaceId, personId: PERSON },
      { fetchImpl: respond({}, 404) },
    );

    expect(company.companyDomain).toBe('corp.com');

    seeded.cleanup();
    seeded = await seedDatabase('enrich-domain-free');
    await imported(seeded.db, 'dave@gmail.com');

    const freemail = await enrichContact(
      seeded.db,
      { workspaceId: SEED.workspaceId, personId: PERSON },
      { fetchImpl: respond({}, 404) },
    );

    expect(freemail.companyDomain).toBeUndefined();
  });

  test('a person with no address is a miss, not a crash', async () => {
    seeded = await seedDatabase('enrich-noemail');

    const result = await enrichContact(seeded.db, {
      workspaceId: SEED.workspaceId,
      personId: 'per_nobody',
    });

    expect(result.found).toBe(false);
  });
});
