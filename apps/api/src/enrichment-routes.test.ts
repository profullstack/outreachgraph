/**
 * The routes that let a human answer the question the machine cannot.
 *
 * Confirming an address is the only path from a derived guess to something the
 * sender will use, so these tests care about exactly two things: that the
 * confirmation actually makes the prospect reachable, and that nothing short
 * of a confirmation does.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { queryOne } from '@outreachgraph/db';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

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

async function post(app: Hono<AppEnv>, path: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('proposing addresses over the API', () => {
  test('offers candidates and reports what it learned', async () => {
    const { app } = await harness('routes-propose');

    const response = await post(app, '/api/v1/enrichment/propose', {});
    expect(response.status).toBe(200);

    const body = (await response.json()) as { proposed: number; domainsLearned: string[] };
    expect(body.proposed).toBeGreaterThan(0);
    // Nothing confirmed yet, so nothing has been learned from anywhere.
    expect(body.domainsLearned).toEqual([]);
  });

  test('the prospect page carries the candidates', async () => {
    const { app } = await harness('routes-detail');
    await post(app, '/api/v1/enrichment/propose', {});

    const response = await app.request(`/api/v1/people/${SEED.personId}`);
    const body = (await response.json()) as { emailCandidates: { address: string }[] };

    expect(body.emailCandidates.map((c) => c.address)).toContain('jane@acme.com');
  });
});

describe('deciding over the API', () => {
  test('confirming makes the prospect personally reachable', async () => {
    const { app, seeded } = await harness('routes-confirm');
    await post(app, '/api/v1/enrichment/propose', {});

    const response = await post(app, `/api/v1/people/${SEED.personId}/email-candidates/confirm`, {
      address: 'jane@acme.com',
    });
    expect(response.status).toBe(200);

    // `pickEmailRecipient` reads this table, so this row is the whole point.
    const identity = await queryOne<{ handle: string }>(
      seeded.db,
      `SELECT handle FROM social_identities WHERE person_id = ? AND network = 'email'`,
      [SEED.personId],
    );
    expect(identity?.handle).toBe('jane@acme.com');
  });

  test('an address the operator knows is accepted, and teaches the company', async () => {
    const { app, seeded } = await harness('routes-supplied');
    const stamp = new Date().toISOString();

    // A colleague with a name and no address: the production shape, seventeen
    // times over behind one shared inbox.
    await seeded.db.batch([
      {
        sql: `INSERT INTO people (id, display_name, current_company_id, current_title, location,
              identity_confidence, status, outreach_eligible, believed_minor, created_at, updated_at)
              VALUES ('per_wes', 'Wes Todd', ?, 'Director', 'Remote', 0.95, 'active', 1, 0, ?, ?)`,
        args: [SEED.companyId, stamp, stamp],
      },
      {
        sql: `INSERT INTO campaign_people (campaign_id, person_id, workspace_id, status,
              interaction_state, discovered_at, updated_at)
              VALUES (?, 'per_wes', ?, 'recommended', 'never_contacted', ?, ?)`,
        args: [SEED.campaignId, SEED.workspaceId, stamp, stamp],
      },
    ]);

    // Never proposed — `f.last` is not in the top few shapes — and accepted
    // anyway, because the operator knowing it is better evidence than any
    // derivation this module could offer.
    const response = await post(app, `/api/v1/people/${SEED.personId}/email-candidates/confirm`, {
      address: 'j.smith@acme.com',
    });
    expect(response.status).toBe(200);

    const again = await post(app, '/api/v1/enrichment/propose', {});
    const body = (await again.json()) as { domainsLearned: string[] };
    expect(body.domainsLearned).toContain('acme.com');

    // The colleague arrives as a derivation rather than a guess. That is the
    // loop: one answer from the operator, and the rest of the company follows.
    const detail = await app.request('/api/v1/people/per_wes');
    const wes = (await detail.json()) as {
      emailCandidates: { address: string; derived: number }[];
    };

    expect(wes.emailCandidates[0]?.address).toBe('w.todd@acme.com');
    expect(wes.emailCandidates[0]?.derived).toBe(1);
  });

  test('refuses something that is not an address', async () => {
    const { app } = await harness('routes-garbage');
    const response = await post(app, `/api/v1/people/${SEED.personId}/email-candidates/confirm`, {
      address: 'Jane Smith',
    });
    expect(response.status).toBe(400);
  });

  test('rejecting keeps the address out of later proposals', async () => {
    const { app } = await harness('routes-reject');
    await post(app, '/api/v1/enrichment/propose', {});

    const rejected = await post(app, `/api/v1/people/${SEED.personId}/email-candidates/reject`, {
      address: 'jane@acme.com',
    });
    expect(rejected.status).toBe(200);

    await post(app, '/api/v1/enrichment/propose', {});

    const detail = await app.request(`/api/v1/people/${SEED.personId}`);
    const body = (await detail.json()) as { emailCandidates: { address: string }[] };
    expect(body.emailCandidates.map((c) => c.address)).not.toContain('jane@acme.com');
  });

  test('a 404 for a person who does not exist', async () => {
    const { app } = await harness('routes-missing-person');
    const response = await post(app, '/api/v1/people/per_nope/email-candidates/confirm', {
      address: 'someone@acme.com',
    });
    expect(response.status).toBe(404);
  });
});
