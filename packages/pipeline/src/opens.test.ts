/**
 * Open tracking, and the outgoing message both send paths now share.
 *
 * The open pixel is the weakest measurement the product takes, so the tests
 * that matter are the ones that prove it stays weak: it is off unless asked
 * for, a prefetch is not an open, and an open never becomes an interaction
 * that scoring or the policy engine would read.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { issueOpenPixel, recordEmailOpen } from './engagement';
import { htmlTwin, prepareOutgoingEmail, type OutreachSettings } from './outreach-email';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const ORIGIN = 'https://app.test';

const SETTINGS: OutreachSettings = {
  autopilot_daily_cap: 25,
  reply_to_email: null,
  track_links: false,
  tracking_origin: null,
  track_opens: false,
};

async function actionRow(db: SeededDatabase['db']): Promise<string> {
  const rec = await queryOne<{ id: string }>(db, 'SELECT id FROM recommendations LIMIT 1');
  const id = 'act_opens_test';
  await db.execute({
    sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
          mode, status, created_at)
          VALUES (?, ?, ?, ?, 'send_email', 'email', 'customer_managed', 'queued', ?)`,
    args: [id, SEED.workspaceId, rec!.id, SEED.personId, new Date().toISOString()],
  });
  return id;
}

describe('recordEmailOpen', () => {
  test('records a believed open without writing an interaction', async () => {
    seeded = await seedDatabase('opens-believed');
    const { db } = seeded;

    const url = await issueOpenPixel(db, {
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      origin: ORIGIN,
    });
    expect(url).toMatch(/^https:\/\/app\.test\/o\/opx_[a-z0-9]+\.gif$/);

    const token = url!.split('/o/')[1]!.replace('.gif', '');
    const pixel = await queryOne<{ created_at: string }>(
      db,
      'SELECT created_at FROM open_pixels WHERE id = ?',
      [token],
    );

    const open = await recordEmailOpen(db, {
      token,
      userAgent: 'Mozilla/5.0',
      at: new Date(new Date(pixel!.created_at).getTime() + 5 * 60_000),
    });

    expect(open?.automated).toBeUndefined();
    expect(open?.personId).toBe(SEED.personId);

    const interactions = await queryAll(
      db,
      "SELECT id FROM interactions WHERE direction = 'inbound' AND person_id = ?",
      [SEED.personId],
    );
    expect(interactions).toHaveLength(0);
  });

  test('marks a fetch in the first seconds as a prefetch', async () => {
    seeded = await seedDatabase('opens-prefetch');
    const { db } = seeded;

    const url = await issueOpenPixel(db, {
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      origin: ORIGIN,
    });
    const token = url!.split('/o/')[1]!.replace('.gif', '');

    const open = await recordEmailOpen(db, { token, userAgent: 'Mozilla/5.0' });
    expect(open?.automated).toBe('prefetch');

    const rows = await queryAll<{ automated: string | null }>(
      db,
      'SELECT automated FROM email_opens',
    );
    expect(rows).toEqual([{ automated: 'prefetch' }]);
  });

  test('returns nothing for an unknown token', async () => {
    seeded = await seedDatabase('opens-unknown');
    expect(await recordEmailOpen(seeded.db, { token: 'opx_nope' })).toBeUndefined();
  });
});

describe('prepareOutgoingEmail', () => {
  test('sends plain text only while open tracking is off', async () => {
    seeded = await seedDatabase('outgoing-plain');
    const { db } = seeded;

    const out = await prepareOutgoingEmail(db, {
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      campaignId: SEED.campaignId,
      actionId: await actionRow(db),
      body: 'Hello there.',
      recipient: 'someone@example.com',
      settings: SETTINGS,
      appUrl: ORIGIN,
    });

    expect(out.html).toBeUndefined();
    expect(out.openTracked).toBe(false);
    expect(await queryAll(db, 'SELECT id FROM open_pixels')).toHaveLength(0);
  });

  test('always carries an opt-out when there is an origin to point it at', async () => {
    seeded = await seedDatabase('outgoing-optout');
    const { db } = seeded;

    const out = await prepareOutgoingEmail(db, {
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      campaignId: SEED.campaignId,
      actionId: await actionRow(db),
      body: 'Hello there.',
      recipient: 'someone@example.com',
      settings: SETTINGS,
      appUrl: ORIGIN,
    });

    expect(out.text).toContain('Unsubscribe: https://app.test/');
    expect(out.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/app\.test\//);
    expect(out.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  test('adds an HTML twin with one pixel when opens are on', async () => {
    seeded = await seedDatabase('outgoing-pixel');
    const { db } = seeded;
    const actionId = await actionRow(db);

    const out = await prepareOutgoingEmail(db, {
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      campaignId: SEED.campaignId,
      actionId,
      body: 'Hello there.\n\nSee https://example.com/docs.',
      recipient: 'someone@example.com',
      settings: { ...SETTINGS, track_opens: true },
      appUrl: ORIGIN,
    });

    expect(out.openTracked).toBe(true);
    expect(out.html).toContain('<img src="https://app.test/o/opx_');
    expect(out.html).toContain('<a href="https://example.com/docs">https://example.com/docs</a>.');

    const pixels = await queryAll<{ action_id: string }>(db, 'SELECT action_id FROM open_pixels');
    expect(pixels).toEqual([{ action_id: actionId }]);
  });
});

describe('htmlTwin', () => {
  test('escapes the body and keeps its paragraphs', () => {
    const html = htmlTwin('Hi <Sam> & co,\nline two\n\nNext para', 'https://app.test/o/x.gif');

    expect(html).toContain('<p>Hi &lt;Sam&gt; &amp; co,<br>line two</p>');
    expect(html).toContain('<p>Next para</p>');
    expect(html).not.toContain('<Sam>');
  });
});
