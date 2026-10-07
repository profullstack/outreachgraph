import { afterEach, describe, expect, test } from 'bun:test';
import { now, type Client } from '@outreachgraph/db';
import type { Mailer, Message, SendResult } from '@outreachgraph/email';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { HoldLedger, runAutopilot } from './autopilot';
import { campaignAccounts, companyHeldBy } from './account-expansion';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

function recordingMailer(): { sent: Message[]; mailer: Mailer } {
  const sent: Message[] = [];
  return {
    sent,
    mailer: {
      send: async (message): Promise<SendResult> => {
        sent.push(message);
        return { id: 'resend_1' };
      },
    },
  };
}

/** Jane (VP Engineering, a budget holder) on autopilot at low priority. */
async function janeSendable(db: Client): Promise<void> {
  await db.execute({
    sql: `UPDATE campaigns SET approval_mode = 'trusted_automation' WHERE id = ?`,
    args: [SEED.campaignId],
  });
  await db.execute({
    sql: `UPDATE recommendations SET action = 'send_email', network = 'email', priority = 10
           WHERE id = ?`,
    args: [SEED.recommendationId],
  });
  await addEmail(db, SEED.personId, 'jane@acme.com');
}

async function addEmail(db: Client, personId: string, address: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
          confidence, source_type, verified_by, first_seen_at)
          VALUES (?, ?, 'email', ?, ?, 0.95, 'public_web', '[]', ?)`,
    args: [`sid_${personId}`, personId, address, address, now()],
  });
}

/** A colleague at Acme with their own address and a higher-priority card. */
async function colleague(db: Client, name: string, title: string): Promise<string> {
  const stamp = now();
  const personId = `per_${name.toLowerCase()}`;
  await db.execute({
    sql: `INSERT INTO people (id, display_name, current_company_id, current_title, status,
          believed_minor, outreach_eligible, identity_confidence, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', 0, 1, 0.95, ?, ?)`,
    args: [personId, name, SEED.companyId, title, stamp, stamp],
  });
  await db.execute({
    sql: `INSERT INTO campaign_people (campaign_id, person_id, workspace_id, status,
          interaction_state, discovered_at, updated_at)
          VALUES (?, ?, ?, 'recommended', 'never_contacted', ?, ?)`,
    args: [SEED.campaignId, personId, SEED.workspaceId, stamp, stamp],
  });
  const recommendationId = `rec_${name.toLowerCase()}`;
  await db.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
          priority, reason, policy_status, policy_version, status, created_at)
          VALUES (?, ?, ?, ?, 'send_email', 'email', 90, 'same company',
                  'allow', '2026-01-01', 'pending', ?)`,
    args: [recommendationId, SEED.workspaceId, SEED.campaignId, personId, stamp],
  });
  await db.execute({
    sql: `INSERT INTO drafts (id, workspace_id, recommendation_id, subject, body, checks_json,
          created_at, updated_at)
          VALUES (?, ?, ?, 'Hello', 'A grounded message.', '[]', ?, ?)`,
    args: [`drf_${name.toLowerCase()}`, SEED.workspaceId, recommendationId, stamp, stamp],
  });
  await addEmail(db, personId, `${name.toLowerCase()}@acme.com`);
  return personId;
}

describe('account expansion', () => {
  test('the budget holder opens the company even behind a higher-priority card', async () => {
    seeded = await seedDatabase('expand-order');
    const { db } = seeded;
    await janeSendable(db);
    await colleague(db, 'Sam', 'Software Engineer');

    const { sent, mailer } = recordingMailer();
    await runAutopilot({ db, mailer, holdLedger: new HoldLedger() }, SEED.workspaceId);

    expect(sent.map((message) => message.to)).toEqual(['jane@acme.com']);
  });

  test('then pain feeler, blocker and champion, one per window', async () => {
    seeded = await seedDatabase('expand-sequence');
    const { db } = seeded;
    await janeSendable(db);
    await colleague(db, 'Cara', 'Engineering Manager');
    await colleague(db, 'Lee', 'General Counsel');
    await colleague(db, 'Sam', 'Software Engineer');

    const { sent, mailer } = recordingMailer();
    const ledger = new HoldLedger();
    for (let week = 0; week < 4; week += 1) {
      const at = new Date(Date.now() + week * 22 * 86_400_000);
      await runAutopilot({ db, mailer, now: at, holdLedger: ledger }, SEED.workspaceId);
    }

    expect(sent.map((message) => message.to)).toEqual([
      'jane@acme.com',
      'sam@acme.com',
      'lee@acme.com',
      'cara@acme.com',
    ]);
  });

  test('a reply releases the company instead of holding it', async () => {
    seeded = await seedDatabase('expand-reply');
    const { db } = seeded;
    await janeSendable(db);
    const sam = await colleague(db, 'Sam', 'Software Engineer');

    const { mailer } = recordingMailer();
    await runAutopilot({ db, mailer, holdLedger: new HoldLedger() }, SEED.workspaceId);

    const at = new Date();
    expect(
      await companyHeldBy(db, {
        workspaceId: SEED.workspaceId,
        companyId: SEED.companyId,
        personId: sam,
        at,
      }),
    ).toBeDefined();

    const stamp = now();
    await db.execute({
      sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network, direction,
            state, occurred_at, recorded_at)
            VALUES ('int_reply', ?, ?, ?, 'email', 'inbound', 'responded', ?, ?)`,
      args: [SEED.workspaceId, SEED.personId, SEED.campaignId, stamp, stamp],
    });

    expect(
      await companyHeldBy(db, {
        workspaceId: SEED.workspaceId,
        companyId: SEED.companyId,
        personId: sam,
        at,
      }),
    ).toBeUndefined();
  });

  test('reports each company: who was reached, who is next, which personas are missing', async () => {
    seeded = await seedDatabase('expand-report');
    const { db } = seeded;
    await janeSendable(db);
    await colleague(db, 'Sam', 'Software Engineer');

    const { mailer } = recordingMailer();
    await runAutopilot({ db, mailer, holdLedger: new HoldLedger() }, SEED.workspaceId);

    const [account] = await campaignAccounts(db, {
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
    });
    expect(account?.contacts.map((contact) => [contact.persona, contact.state])).toEqual([
      ['budget_holder', 'contacted'],
      ['pain_feeler', 'next'],
    ]);
    expect(account?.missing).toEqual(['blocker', 'champion']);
  });
});
