import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryOne } from '@outreachgraph/db';
import { draftIntroCard } from '@outreachgraph/domain';
import type { Mailer, Message } from '@outreachgraph/email';
import { createApp } from './app';
import type { RequestActor } from './context';
import { draftIntroCards, previewMatchCount, sendIntroDigests } from './intro-drafts';
import { seedDatabase, type SeededDatabase } from './test-seed';

process.env.CROSS_PROMO = 'bundled';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

class RecordingMailer implements Mailer {
  readonly sent: Message[] = [];
  async send(message: Message) {
    this.sent.push(message);
    return {};
  }
}

/** A member with their own org, workspace and one product. */
async function member(
  db: SeededDatabase['db'],
  key: string,
  product: { name: string; category: string; value: string; pain: string },
): Promise<RequestActor> {
  const stamp = now();
  const actor: RequestActor = {
    userId: `usr_${key}`,
    workspaceId: `wsp_${key}`,
    organizationId: `org_${key}`,
    role: 'owner',
  };
  await db.batch([
    {
      sql: `INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      args: [actor.organizationId, key, key, stamp, stamp],
    },
    {
      sql: `INSERT INTO users (id, email, name, email_verified_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [actor.userId, `${key}@example.com`, key, stamp, stamp, stamp],
    },
    {
      sql: `INSERT INTO organization_members (organization_id, user_id, role, created_at)
            VALUES (?, ?, 'owner', ?)`,
      args: [actor.organizationId, actor.userId, stamp],
    },
    {
      sql: `INSERT INTO workspaces (id, organization_id, name, slug, min_outreach_confidence,
            created_at, updated_at) VALUES (?, ?, ?, ?, 0.85, ?, ?)`,
      args: [actor.workspaceId, actor.organizationId, key, key, stamp, stamp],
    },
    {
      sql: `INSERT INTO offerings (id, workspace_id, name, category, description,
              value_propositions, likely_pains, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        `off_${key}`,
        actor.workspaceId,
        product.name,
        product.category,
        product.value,
        JSON.stringify([product.value]),
        JSON.stringify([product.pain]),
        stamp,
        stamp,
      ],
    },
  ]);
  return actor;
}

describe('draftIntroCard', () => {
  test('writes a card from name, role and products', () => {
    const card = draftIntroCard({
      firstName: 'Ada',
      lastName: 'Lovelace',
      jobTitle: 'Founder',
      companyDomain: 'www.engine.dev',
      offerings: [
        {
          name: 'Engine',
          category: 'payments',
          valuePropositions: ['Crypto checkout with no chargebacks. Also more.'],
          likelyPains: ['Card processors drop high-risk merchants.'],
        },
      ],
    });
    expect(card.displayName).toBe('Ada Lovelace');
    expect(card.headline).toBe('Founder at engine.dev');
    expect(card.canOffer).toBe('Engine: Crypto checkout with no chargebacks.');
    expect(card.lookingFor).toContain('Customers and partners for Engine.');
    expect(card.lookingFor).toContain('Card processors drop high-risk merchants.');
    expect(card.topics).toEqual(['payments']);
  });

  test('a member with no products gets nothing to offer', () => {
    expect(draftIntroCard({ email: 'x@y.z', offerings: [] }).canOffer).toBe('');
  });
});

describe('auto-drafted intros', () => {
  test('drafts stay closed, count matches without revealing them, and an edit makes the card yours', async () => {
    seeded = await seedDatabase('intro-drafts');
    const db = seeded.db;
    const ada = await member(db, 'ada', {
      name: 'CryptoPay',
      category: 'payments',
      value: 'Crypto payments checkout for online merchants.',
      pain: 'Merchants losing payments to card processor bans.',
    });
    await member(db, 'bob', {
      name: 'ShopKit',
      category: 'payments',
      value: 'Online merchants storefront with crypto payments checkout.',
      pain: 'Merchants need crypto payments checkout for their store.',
    });

    expect(await draftIntroCards(db)).toBeGreaterThanOrEqual(2);
    // Unchanged facts write nothing the second time.
    expect(await draftIntroCards(db)).toBe(0);

    const card = await queryOne<{ is_open: number | bigint; auto_drafted: number | bigint }>(
      db,
      "SELECT is_open, auto_drafted FROM intro_cards WHERE user_id = 'usr_ada'",
    );
    expect(Number(card?.is_open)).toBe(0);
    expect(Number(card?.auto_drafted)).toBe(1);
    expect(await previewMatchCount(db, 'usr_ada')).toBeGreaterThanOrEqual(1);

    let current: RequestActor = ada;
    const mailer = new RecordingMailer();
    const app = createApp({ db, mailer, authenticate: async () => current });
    const call = async (method: string, path: string, body?: unknown, actor = ada) => {
      current = actor;
      const res = await app.request(`/api/v1/intros${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };

    const got = await call('GET', '/card');
    expect(got.body.drafted).toBe(true);
    expect(got.body.previewMatches).toBeGreaterThanOrEqual(1);
    expect(got.body.card.open).toBe(false);
    // Closed: the pool is not readable.
    expect((await call('GET', '/matches')).status).not.toBe(200);

    // One click opens the drafted card as written.
    const opened = await call('PUT', '/card', { open: true });
    expect(opened.status).toBe(200);
    expect(opened.body.card.open).toBe(true);
    expect(opened.body.drafted).toBe(true);

    // Editing text makes it the member's own; the sweep leaves it alone.
    const edited = await call('PUT', '/card', { headline: 'My own words' });
    expect(edited.body.drafted).toBe(false);
    await draftIntroCards(db);
    expect((await call('GET', '/card')).body.card.headline).toBe('My own words');

    // Mail toggle.
    expect((await call('PUT', '/mail', { on: false })).body.mailOff).toBe(true);
  });

  test('the weekly email: count for a closed card, once a week, never naming drafts', async () => {
    seeded = await seedDatabase('intro-digest');
    const db = seeded.db;
    await member(db, 'ada', {
      name: 'CryptoPay',
      category: 'payments',
      value: 'Crypto payments checkout for online merchants.',
      pain: 'Merchants losing payments to card processor bans.',
    });
    await member(db, 'bob', {
      name: 'ShopKit',
      category: 'payments',
      value: 'Online merchants storefront with crypto payments checkout.',
      pain: 'Merchants need crypto payments checkout for their store.',
    });
    await draftIntroCards(db);

    const mailer = new RecordingMailer();
    const at = new Date('2026-11-20T12:00:00.000Z');
    const sent = await sendIntroDigests(db, { mailer, appUrl: 'https://og.test', now: at });
    expect(sent).toBeGreaterThanOrEqual(1);
    const toAda = mailer.sent.find((m) => m.to === 'ada@example.com');
    expect(toAda?.subject).toMatch(/^\d+ members? (looks|look) like a fit for you$/);
    expect(toAda?.text).toContain('https://og.test/intros');
    expect(toAda?.text).not.toContain('ShopKit');
    expect(toAda?.text).not.toContain('bob');

    // A week has not passed: nothing again.
    expect(await sendIntroDigests(db, { mailer, now: at })).toBe(0);
  });

  test('with no mailbox nothing is marked sent, so it goes out once one exists', async () => {
    seeded = await seedDatabase('intro-digest-held');
    const db = seeded.db;
    await member(db, 'ada', {
      name: 'CryptoPay',
      category: 'payments',
      value: 'Crypto payments checkout for online merchants.',
      pain: 'Merchants losing payments to card processor bans.',
    });
    await member(db, 'bob', {
      name: 'ShopKit',
      category: 'payments',
      value: 'Online merchants storefront with crypto payments checkout.',
      pain: 'Merchants need crypto payments checkout for their store.',
    });
    await draftIntroCards(db);
    const at = new Date('2026-11-20T12:00:00.000Z');
    expect(await sendIntroDigests(db, { now: at })).toBe(0);
    const mailed = await queryOne<{ n: number | bigint }>(
      db,
      'SELECT COUNT(*) AS n FROM intro_cards WHERE match_mailed_at IS NOT NULL',
    );
    expect(Number(mailed?.n)).toBe(0);
    const mailer = new RecordingMailer();
    expect(await sendIntroDigests(db, { mailer, now: at })).toBeGreaterThanOrEqual(1);
  });
});
