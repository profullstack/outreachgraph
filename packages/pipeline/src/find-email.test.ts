/**
 * Finding an address for someone held on a LinkedIn card.
 *
 * The production shape: a person reachable on LinkedIn only, holding a
 * `manual_only` card, with a company we know the domain of. DNS and SMTP are
 * fakes throughout — the question here is what the job does with each answer,
 * not whether a real server gives it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryAll, type Client } from '@outreachgraph/db';
import type { MxRecord, SmtpProber, SmtpProbeResult } from '@outreachgraph/providers';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { findEmail, scoreCandidate, PROMOTE_THRESHOLD } from './find-email';
import {
  enqueueFindEmail,
  findEmailDedupeKey,
  sweepFindEmail,
  workspacesAwaitingEmailSearch,
} from './find-email-queue';
import { regenerateFor } from './pipeline';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

async function setup(label: string): Promise<Client> {
  seeded = await seedDatabase(label);
  return seeded.db;
}

const PERSON = 'per_priya';

const hasMx = async (): Promise<readonly MxRecord[]> => [{ exchange: 'mx.acme.com', priority: 10 }];
const noMx = async (): Promise<readonly MxRecord[]> => [];

/** A prober that answers every RCPT from a function. */
function prober(answer: (address: string) => number): SmtpProber {
  return {
    async probe(_host, addresses): Promise<SmtpProbeResult> {
      return { reachable: true, codes: new Map(addresses.map((a) => [a, answer(a)])) };
    },
  };
}

/** Port 25 blocked, as on Railway. */
const blocked: SmtpProber = {
  async probe(): Promise<SmtpProbeResult> {
    return { reachable: false, reason: 'connect_failed' };
  },
};

/** A LinkedIn-only person at Acme, holding a held LinkedIn card. */
async function linkedInOnly(
  db: Client,
  options: { id?: string; name?: string; card?: boolean } = {},
): Promise<string> {
  const id = options.id ?? PERSON;
  const stamp = now();

  await db.batch([
    {
      sql: `INSERT INTO people (id, display_name, current_company_id, identity_confidence,
            status, outreach_eligible, believed_minor, created_at, updated_at)
            VALUES (?, ?, ?, 0.95, 'active', 1, 0, ?, ?)`,
      args: [id, options.name ?? 'Priya Raman', SEED.companyId, stamp, stamp],
    },
    {
      sql: `INSERT INTO campaign_people (campaign_id, person_id, workspace_id, status,
            interaction_state, discovered_at, updated_at)
            VALUES (?, ?, ?, 'recommended', 'never_contacted', ?, ?)`,
      args: [SEED.campaignId, id, SEED.workspaceId, stamp, stamp],
    },
    {
      sql: `INSERT INTO social_identities (id, person_id, network, handle, profile_url,
            confidence, source_type, verified_by, first_seen_at)
            VALUES (?, ?, 'linkedin', ?, ?, 0.9, 'public_web', '[]', ?)`,
      args: [`sid_li_${id}`, id, id, `https://www.linkedin.com/in/${id}`, stamp],
    },
    {
      sql: `INSERT INTO signals (id, workspace_id, person_id, network, signal_type, subtype,
            summary, evidence, source_url, source_timestamp, observed_at, confidence,
            relevance, sentiment)
            VALUES (?, ?, ?, 'website', 'content_topic', 'site_role',
            'Named on the company website.', 'Head of Platform', 'https://acme.com/team',
            ?, ?, 0.9, 0.6, 'neutral')`,
      args: [`sig_${id}`, SEED.workspaceId, id, stamp, stamp],
    },
  ]);

  if (options.card !== false) {
    await db.execute({
      sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action,
            network, priority, reason, policy_status, policy_version, expected_goal,
            status, created_at)
            VALUES (?, ?, ?, ?, 'send_dm', 'linkedin', 60, 'Named on the team page.',
            'manual_only', '2026-08-11', 'start_conversation', 'pending', ?)`,
      args: [`rec_li_${id}`, SEED.workspaceId, SEED.campaignId, id, stamp],
    });
  }

  return id;
}

/** A colleague whose address we already hold, which teaches Acme's shape. */
async function colleague(db: Client, name: string, address: string, source = 'import') {
  const id = `per_${address.split('@')[0]?.replace(/\W/g, '')}`;
  const stamp = now();
  await db.batch([
    {
      sql: `INSERT INTO people (id, display_name, current_company_id, identity_confidence,
            status, outreach_eligible, believed_minor, created_at, updated_at)
            VALUES (?, ?, ?, 0.95, 'active', 1, 0, ?, ?)`,
      args: [id, name, SEED.companyId, stamp, stamp],
    },
    {
      sql: `INSERT INTO person_emails (id, workspace_id, person_id, address, dedupe_key, source,
            verified, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      args: [`pem_${id}`, SEED.workspaceId, id, address, address, source, stamp],
    },
  ]);
  return id;
}

async function personEmails(db: Client, personId: string) {
  return queryAll<{ address: string; source: string; verified: number }>(
    db,
    'SELECT address, source, verified FROM person_emails WHERE person_id = ?',
    [personId],
  );
}

async function candidates(db: Client, personId: string) {
  return queryAll<{
    address: string;
    status: string;
    confidence: number;
    derived: number;
    decided_by: string | null;
    evidence_json: string | null;
  }>(
    db,
    `SELECT address, status, confidence, derived, decided_by, evidence_json
       FROM email_candidates WHERE person_id = ? ORDER BY confidence DESC`,
    [personId],
  );
}

async function pendingCards(db: Client, personId: string) {
  return queryAll<{ network: string; action: string; policy_status: string }>(
    db,
    `SELECT network, action, policy_status FROM recommendations
      WHERE person_id = ? AND status = 'pending'`,
    [personId],
  );
}

describe('find_email', () => {
  test('a pattern learned from a colleague is promoted even with port 25 blocked', async () => {
    const db = await setup('find-email-derived');
    await linkedInOnly(db);
    await colleague(db, 'Bob Jones', 'bob.jones@acme.com');

    const result = await findEmail(
      { db, resolveMx: hasMx, smtp: blocked, emailSendingEnabled: true },
      { workspaceId: SEED.workspaceId, personId: PERSON },
    );

    expect(result.outcome).toBe('promoted');
    expect(result.address).toBe('priya.raman@acme.com');
    expect(result.smtp).toBe('unavailable (connect_failed)');
    expect(result.confidence).toBeGreaterThanOrEqual(PROMOTE_THRESHOLD);

    // Sendable, but marked as the product's inference and not verified.
    expect(await personEmails(db, PERSON)).toEqual([
      { address: 'priya.raman@acme.com', source: 'pattern', verified: 0 },
    ]);

    const rows = await candidates(db, PERSON);
    const promoted = rows.find((row) => row.address === 'priya.raman@acme.com');
    expect(promoted?.status).toBe('confirmed');
    expect(promoted?.decided_by).toBe('find_email');
    expect(promoted?.derived).toBe(1);
    expect(JSON.parse(promoted?.evidence_json ?? '{}')).toMatchObject({
      mx: ['mx.acme.com'],
      smtp: 'unavailable',
      learnedFrom: 1,
    });

    // The held LinkedIn card is replaced by an email one on the same run.
    expect(result.recommendationIds).toHaveLength(1);
    const cards = await pendingCards(db, PERSON);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.network).toBe('email');
    expect(cards[0]?.policy_status).not.toBe('manual_only');
  });

  test('a guess the mail server confirms on a strict domain is promoted as verified', async () => {
    const db = await setup('find-email-smtp');
    await linkedInOnly(db);

    const result = await findEmail(
      {
        db,
        resolveMx: hasMx,
        smtp: prober((address) => (address === 'praman@acme.com' ? 250 : 550)),
      },
      { workspaceId: SEED.workspaceId, personId: PERSON },
    );

    expect(result.outcome).toBe('promoted');
    expect(result.address).toBe('praman@acme.com');
    expect(await personEmails(db, PERSON)).toEqual([
      { address: 'praman@acme.com', source: 'pattern', verified: 1 },
    ]);

    // Refused mailboxes are recorded as rejected, so nobody reviews them.
    const rows = await candidates(db, PERSON);
    const refused = rows.filter((row) => row.address !== 'praman@acme.com');
    expect(refused.length).toBeGreaterThan(0);
    for (const row of refused) {
      expect(row.status).toBe('rejected');
      expect(row.confidence).toBe(0);
    }
  });

  test('a bare guess with nobody to ask stays a proposal', async () => {
    const db = await setup('find-email-guess');
    await linkedInOnly(db);

    const result = await findEmail(
      { db, resolveMx: hasMx, smtp: blocked },
      { workspaceId: SEED.workspaceId, personId: PERSON },
    );

    expect(result.outcome).toBe('below_threshold');
    expect(await personEmails(db, PERSON)).toEqual([]);

    const rows = await candidates(db, PERSON);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.status).toBe('proposed');
      expect(row.confidence).toBeLessThan(PROMOTE_THRESHOLD);
    }

    // The held card is untouched: nothing new to decide on.
    expect((await pendingCards(db, PERSON))[0]?.network).toBe('linkedin');
  });

  test('a catch-all domain discounts the answer: guesses stay proposals', async () => {
    const db = await setup('find-email-catchall');
    await linkedInOnly(db);

    const result = await findEmail(
      { db, resolveMx: hasMx, smtp: prober(() => 250) },
      { workspaceId: SEED.workspaceId, personId: PERSON },
    );

    expect(result.outcome).toBe('below_threshold');
    const rows = await candidates(db, PERSON);
    expect(JSON.parse(rows[0]?.evidence_json ?? '{}').catchAll).toBe(true);
  });

  test('a catch-all domain with a learned pattern still promotes, lower', async () => {
    const db = await setup('find-email-catchall-derived');
    await linkedInOnly(db);
    await colleague(db, 'Bob Jones', 'bob.jones@acme.com');

    const result = await findEmail(
      { db, resolveMx: hasMx, smtp: prober(() => 250) },
      { workspaceId: SEED.workspaceId, personId: PERSON },
    );

    expect(result.outcome).toBe('promoted');
    expect(result.confidence).toBeLessThan(0.8);
    expect((await personEmails(db, PERSON))[0]?.verified).toBe(0);
  });

  test('no MX: nothing is recorded, nothing promoted', async () => {
    const db = await setup('find-email-nomx');
    await linkedInOnly(db);
    await colleague(db, 'Bob Jones', 'bob.jones@acme.com');

    const result = await findEmail(
      { db, resolveMx: noMx },
      { workspaceId: SEED.workspaceId, personId: PERSON },
    );

    expect(result.outcome).toBe('no_mx');
    expect(await candidates(db, PERSON)).toEqual([]);
    expect(await personEmails(db, PERSON)).toEqual([]);
  });

  test('a suppressed company domain is never searched', async () => {
    const db = await setup('find-email-suppressed');
    await linkedInOnly(db);
    await db.batch([
      {
        sql: `INSERT INTO suppression_entries (id, workspace_id, scope, reason, source, created_at)
              VALUES ('sup_acme', ?, 'workspace', 'asked', 'suppress_list', ?)`,
        args: [SEED.workspaceId, now()],
      },
      {
        sql: `INSERT INTO suppression_keys (match_key, suppression_id, scope, workspace_id)
              VALUES ('domain:acme.com', 'sup_acme', 'workspace', ?)`,
        args: [SEED.workspaceId],
      },
    ]);

    let asked = false;
    const result = await findEmail(
      {
        db,
        resolveMx: async () => {
          asked = true;
          return [];
        },
      },
      { workspaceId: SEED.workspaceId, personId: PERSON },
    );

    expect(result.outcome).toBe('suppressed');
    expect(asked).toBe(false);
  });

  test('a role account has no name to build an address from', async () => {
    const db = await setup('find-email-role');
    await linkedInOnly(db, { name: 'webmaster' });

    const result = await findEmail(
      { db, resolveMx: hasMx },
      { workspaceId: SEED.workspaceId, personId: PERSON },
    );
    expect(result.outcome).toBe('no_name');
  });

  test("an address that is already a colleague's is never promoted", async () => {
    const db = await setup('find-email-collision');
    await linkedInOnly(db);
    // Another Priya R. already holds praman@ — the only address the server
    // would accept for our Priya.
    await colleague(db, 'Pat Raman', 'praman@acme.com');

    const result = await findEmail(
      { db, resolveMx: hasMx, smtp: prober((a) => (a === 'praman@acme.com' ? 250 : 550)) },
      { workspaceId: SEED.workspaceId, personId: PERSON },
    );

    expect(result.outcome).toBe('below_threshold');
    expect(await personEmails(db, PERSON)).toEqual([]);
  });

  test('an address a human rejected stays rejected', async () => {
    const db = await setup('find-email-human-reject');
    await linkedInOnly(db);
    await colleague(db, 'Bob Jones', 'bob.jones@acme.com');
    await db.execute({
      sql: `INSERT INTO email_candidates (id, workspace_id, person_id, address, pattern, derived,
            confidence, status, basis, created_at, updated_at, decided_by, decided_at)
            VALUES ('emc_no', ?, ?, 'priya.raman@acme.com', 'first.last', 1, 0.9, 'rejected',
            'no', ?, ?, 'usr_test', ?)`,
      args: [SEED.workspaceId, PERSON, now(), now(), now()],
    });

    const result = await findEmail(
      { db, resolveMx: hasMx, smtp: blocked },
      { workspaceId: SEED.workspaceId, personId: PERSON },
    );

    expect(result.outcome).toBe('below_threshold');
    const row = (await candidates(db, PERSON)).find((r) => r.address === 'priya.raman@acme.com');
    expect(row?.status).toBe('rejected');
    expect(row?.decided_by).toBe('usr_test');
  });

  test('a transient DNS failure throws so the queue retries', async () => {
    const db = await setup('find-email-dns');
    await linkedInOnly(db);

    await expect(
      findEmail(
        {
          db,
          resolveMx: async () => {
            throw new Error('SERVFAIL');
          },
        },
        { workspaceId: SEED.workspaceId, personId: PERSON },
      ),
    ).rejects.toThrow('SERVFAIL');
  });

  test('a freemail personal domain is never guessed at', async () => {
    const db = await setup('find-email-freemail');
    await linkedInOnly(db);
    await db.execute({
      sql: `UPDATE people SET current_company_id = NULL WHERE id = ?`,
      args: [PERSON],
    });
    await db.execute({
      sql: `INSERT INTO field_provenance (id, entity_kind, entity_id, field, value, source_type,
            provider, license_class, confidence, observed_at, created_at)
            VALUES ('fp_pd', 'person', ?, 'personalDomain', 'gmail.com', 'official_api',
            'github', 'public', 1.0, ?, ?)`,
      args: [PERSON, now(), now()],
    });

    const result = await findEmail(
      { db, resolveMx: hasMx },
      { workspaceId: SEED.workspaceId, personId: PERSON },
    );
    expect(result.outcome).toBe('no_domain');
  });
});

describe('scoreCandidate', () => {
  const guess = {
    address: 'a@x.test',
    pattern: 'first' as const,
    derived: false,
    confidence: 0.35,
  };
  const derived = { ...guess, derived: true, confidence: 0.9 };

  test('no bare guess can clear the promotion floor without the server', () => {
    expect(scoreCandidate(guess, 'unknown', { smtp: 'unavailable' })).toBeLessThan(
      PROMOTE_THRESHOLD,
    );
    expect(scoreCandidate(guess, 'unknown', { smtp: 'probed', catchAll: true })).toBeLessThan(
      PROMOTE_THRESHOLD,
    );
  });

  test('a learned pattern clears it; a refusal is final', () => {
    expect(scoreCandidate(derived, 'unknown', { smtp: 'unavailable' })).toBeGreaterThanOrEqual(
      PROMOTE_THRESHOLD,
    );
    expect(scoreCandidate(derived, 'rejected', { smtp: 'probed' })).toBe(0);
    expect(scoreCandidate(guess, 'accepted', { smtp: 'probed', catchAll: false })).toBe(0.95);
  });
});

describe('queueing find_email', () => {
  async function jobs(db: Client) {
    return queryAll<{ dedupe_key: string; status: string }>(
      db,
      `SELECT dedupe_key, status FROM jobs WHERE kind = 'find_email'`,
    );
  }

  test('the sweep queues each held, emailless person once', async () => {
    const db = await setup('find-email-sweep');
    await linkedInOnly(db);
    await linkedInOnly(db, { id: 'per_other', name: 'Omar Haddad' });
    // Someone with an address already is not the sweep's business.
    const bob = await colleague(db, 'Bob Jones', 'bob.jones@acme.com');
    await db.execute({
      sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action,
            network, priority, reason, policy_status, policy_version, expected_goal,
            status, created_at)
            VALUES ('rec_bob', ?, ?, ?, 'send_dm', 'linkedin', 60, 'x', 'manual_only',
            '2026-08-11', 'start_conversation', 'pending', ?)`,
      args: [SEED.workspaceId, SEED.campaignId, bob, now()],
    });

    expect(await workspacesAwaitingEmailSearch(db)).toEqual([SEED.workspaceId]);

    expect((await sweepFindEmail(db, { workspaceId: SEED.workspaceId })).queued).toBe(2);
    // Already queued: the second sweep finds nobody new.
    expect((await sweepFindEmail(db, { workspaceId: SEED.workspaceId })).queued).toBe(0);

    const keys = (await jobs(db)).map((job) => job.dedupe_key).sort();
    expect(keys).toEqual([findEmailDedupeKey('per_other'), findEmailDedupeKey(PERSON)].sort());
  });

  test('a recent search is not repeated', async () => {
    const db = await setup('find-email-recent');
    await linkedInOnly(db);
    await findEmail({ db, resolveMx: noMx }, { workspaceId: SEED.workspaceId, personId: PERSON });

    expect(await workspacesAwaitingEmailSearch(db)).toEqual([]);
    expect(await enqueueFindEmail(db, { workspaceId: SEED.workspaceId, personId: PERSON })).toBe(
      false,
    );

    // After the retry window it is due again.
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(
      await enqueueFindEmail(db, { workspaceId: SEED.workspaceId, personId: PERSON, now: later }),
    ).toBe(true);
  });

  test('deciding a held card for an emailless person queues a search', async () => {
    const db = await setup('find-email-on-decide');
    await linkedInOnly(db, { card: false });

    const id = await regenerateFor(
      {
        db,
        workspaceId: SEED.workspaceId,
        campaignId: SEED.campaignId,
        providers: [],
        emailSendingEnabled: true,
      },
      PERSON,
    );

    expect(id).toBeDefined();
    const cards = await pendingCards(db, PERSON);
    expect(cards[0]?.policy_status).toBe('manual_only');
    expect(await jobs(db)).toEqual([{ dedupe_key: findEmailDedupeKey(PERSON), status: 'pending' }]);
  });
});
