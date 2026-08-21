/**
 * Opt-out, end to end.
 *
 * The product sent cold email with no unsubscribe header and no opt-out link
 * of any kind — the only route out of a campaign was asking a human to add you
 * to the suppression list. These tests cover the two things that make the new
 * one real rather than decorative: that clicking it actually stops the mail,
 * and that a shared inbox opting out covers everyone we would write to there.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { issueUnsubscribeToken } from '@outreachgraph/pipeline';
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
  const app = createApp({ db: seeded.db, authenticate: async () => ACTOR });
  return { app, seeded };
}

async function tokenFor(seeded: SeededDatabase, address: string): Promise<string> {
  return issueUnsubscribeToken(seeded.db, {
    workspaceId: SEED.workspaceId,
    personId: SEED.personId,
    contactAddress: address,
  });
}

async function isSuppressed(seeded: SeededDatabase, personId: string): Promise<boolean> {
  const row = await seeded.db.execute({
    sql: `SELECT count(*) AS n FROM suppression_keys WHERE match_key = ?`,
    args: [`person:${personId}`],
  });

  return Number(row.rows[0]?.n ?? 0) > 0;
}

describe('unsubscribe', () => {
  test('a click suppresses the person and says so', async () => {
    const { app, seeded } = await harness('unsub-click');
    const token = await tokenFor(seeded, 'someone@example.com');

    const response = await app.request(`/u/${token}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('someone@example.com');
    expect(await isSuppressed(seeded, SEED.personId)).toBe(true);
  });

  test('needs no authentication', async () => {
    // The person clicking is the recipient of a cold email. They have no
    // account here and never will.
    const seeded = await seedDatabase('unsub-anon');
    active = seeded;
    const app = createApp({ db: seeded.db, authenticate: async () => undefined });
    const token = await tokenFor(seeded, 'anon@example.com');

    expect((await app.request(`/u/${token}`)).status).toBe(200);
  });

  test('one-click POST acts and returns 200', async () => {
    // RFC 8058: a mail client POSTs this with no human involved.
    const { app, seeded } = await harness('unsub-oneclick');
    const token = await tokenFor(seeded, 'oneclick@example.com');

    const response = await app.request(`/u/${token}`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await isSuppressed(seeded, SEED.personId)).toBe(true);
  });

  test('clicking twice confirms rather than failing', async () => {
    // Scanners fetch every link in a message, so a second call is normal.
    const { app, seeded } = await harness('unsub-twice');
    const token = await tokenFor(seeded, 'twice@example.com');

    await app.request(`/u/${token}`);
    const second = await app.request(`/u/${token}`);

    expect(second.status).toBe(200);
    expect(await second.text()).toContain('already unsubscribed');
  });

  test('an unknown token is a 404, not a crash', async () => {
    const { app } = await harness('unsub-unknown');

    expect((await app.request('/u/uns_nope')).status).toBe(404);
  });

  test('a shared inbox unsubscribes every colleague behind it', async () => {
    // The whole point. support@ speaks for the mailbox, not for the one
    // person whose token happened to be clicked.
    const { app, seeded } = await harness('unsub-shared');
    const stamp = new Date().toISOString();

    await seeded.db.execute({
      sql: `INSERT INTO companies (id, name, contact_email, created_at, updated_at)
            VALUES ('cmp_shared', 'Shared Co', 'support@shared.example', ?, ?)`,
      args: [stamp, stamp],
    });

    for (const suffix of ['a', 'b', 'c']) {
      await seeded.db.execute({
        sql: `INSERT INTO people (id, display_name, status, identity_confidence,
              current_company_id, created_at, updated_at)
              VALUES (?, ?, 'qualified', 0.95, 'cmp_shared', ?, ?)`,
        args: [`per_share_${suffix}`, `Colleague ${suffix}`, stamp, stamp],
      });
    }

    const token = await issueUnsubscribeToken(seeded.db, {
      workspaceId: SEED.workspaceId,
      personId: 'per_share_a',
      contactAddress: 'support@shared.example',
    });

    const response = await app.request(`/u/${token}`);

    expect(response.status).toBe(200);
    expect(await isSuppressed(seeded, 'per_share_a')).toBe(true);
    expect(await isSuppressed(seeded, 'per_share_b')).toBe(true);
    expect(await isSuppressed(seeded, 'per_share_c')).toBe(true);
  });

  test('cancels whatever was already queued for them', async () => {
    const { app, seeded } = await harness('unsub-cancels');
    const token = await tokenFor(seeded, 'queued@example.com');

    await app.request(`/u/${token}`);

    const rec = await seeded.db.execute({
      sql: 'SELECT status FROM recommendations WHERE id = ?',
      args: [SEED.recommendationId],
    });

    expect(rec.rows[0]?.status).toBe('skipped');
  });

  test('escapes the address rather than rendering it as markup', async () => {
    // The address came off a crawled page, so it is attacker-influenced and
    // it is echoed straight back to whoever clicked.
    const { app, seeded } = await harness('unsub-escape');
    const token = await tokenFor(seeded, '<script>alert(1)</script>@x.example');

    const body = await (await app.request(`/u/${token}`)).text();

    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });
});
