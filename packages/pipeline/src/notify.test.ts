import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryAll, type Client } from '@outreachgraph/db';
import type { Mailer, Message, SendResult } from '@outreachgraph/email';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { notifyAddress, loadNotifySettings, sendDailyDigest, sendLeadAlerts } from './notify';
import { HoldLedger } from './autopilot';
import { recordDiscovered } from './stages';

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
        return {};
      },
    },
  };
}

const APP_URL = 'https://outreachgraph.com';

/** Noon UTC, so a digest due at 13:00 is not yet due and one at 09:00 is. */
function at(hour: number): Date {
  const date = new Date();
  date.setUTCHours(hour, 0, 0, 0);
  return date;
}

async function setDigestHour(db: Client, hour: number): Promise<void> {
  const stamp = now();
  await db.execute({
    sql: `INSERT INTO workspace_settings (workspace_id, digest_hour_utc, created_at, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE SET digest_hour_utc = excluded.digest_hour_utc`,
    args: [SEED.workspaceId, hour, stamp, stamp],
  });
}

describe('notifyAddress', () => {
  test('falls back to the verified owner when none is configured', async () => {
    seeded = await seedDatabase('notify-owner');
    const { db } = seeded;

    const settings = await loadNotifySettings(db, SEED.workspaceId);
    expect(await notifyAddress(db, SEED.workspaceId, settings)).toBe('test@example.com');
  });

  test('an unverified owner is not written to', async () => {
    seeded = await seedDatabase('notify-unverified');
    const { db } = seeded;

    await db.execute({
      sql: `UPDATE users SET email_verified_at = NULL WHERE id = ?`,
      args: [SEED.userId],
    });

    const settings = await loadNotifySettings(db, SEED.workspaceId);
    expect(await notifyAddress(db, SEED.workspaceId, settings)).toBeUndefined();
  });
});

describe('sendLeadAlerts', () => {
  test('mails one alert for a qualified lead', async () => {
    seeded = await seedDatabase('alerts-send');
    const { db } = seeded;

    const { sent, mailer } = recordingMailer();
    const count = await sendLeadAlerts({ db, mailer, appUrl: APP_URL }, SEED.workspaceId);

    expect(count).toBe(1);
    expect(sent[0]?.to).toBe('test@example.com');
    expect(sent[0]?.subject).toContain('Jane Smith');
    // The alert has to carry why, or it is an interruption with no payload.
    expect(sent[0]?.text).toContain('cross-border');
  });

  test('the same person is never alerted twice', async () => {
    seeded = await seedDatabase('alerts-once');
    const { db } = seeded;

    const { sent, mailer } = recordingMailer();
    await sendLeadAlerts({ db, mailer, appUrl: APP_URL }, SEED.workspaceId);
    await sendLeadAlerts({ db, mailer, appUrl: APP_URL }, SEED.workspaceId);

    expect(sent).toHaveLength(1);
  });

  test('a lead below the score floor is not worth interrupting for', async () => {
    seeded = await seedDatabase('alerts-floor');
    const { db } = seeded;

    const stamp = now();
    await db.execute({
      sql: `INSERT INTO workspace_settings (workspace_id, alert_min_opportunity, created_at, updated_at)
            VALUES (?, 99, ?, ?)`,
      args: [SEED.workspaceId, stamp, stamp],
    });

    const { sent, mailer } = recordingMailer();
    await sendLeadAlerts({ db, mailer, appUrl: APP_URL }, SEED.workspaceId);

    expect(sent).toHaveLength(0);
  });

  test('alerts switched off send nothing', async () => {
    seeded = await seedDatabase('alerts-off');
    const { db } = seeded;

    const stamp = now();
    await db.execute({
      sql: `INSERT INTO workspace_settings (workspace_id, instant_alerts, created_at, updated_at)
            VALUES (?, 0, ?, ?)`,
      args: [SEED.workspaceId, stamp, stamp],
    });

    const { sent, mailer } = recordingMailer();
    await sendLeadAlerts({ db, mailer, appUrl: APP_URL }, SEED.workspaceId);

    expect(sent).toHaveLength(0);
  });

  test('a failed send is retried rather than swallowed', async () => {
    seeded = await seedDatabase('alerts-retry');
    const { db } = seeded;

    const failing: Mailer = {
      send: async () => {
        throw new Error('provider down');
      },
    };

    await sendLeadAlerts({ db, mailer: failing, appUrl: APP_URL }, SEED.workspaceId);

    // The claim must have been released, or this lead is never alerted again.
    const claims = await queryAll<{ id: string }>(
      db,
      `SELECT id FROM notifications WHERE workspace_id = ? AND kind = 'lead_alert'`,
      [SEED.workspaceId],
    );
    expect(claims).toHaveLength(0);

    const { sent, mailer } = recordingMailer();
    await sendLeadAlerts({ db, mailer, appUrl: APP_URL }, SEED.workspaceId);
    expect(sent).toHaveLength(1);
  });
});

describe('sendDailyDigest', () => {
  test('sends once the configured hour has passed', async () => {
    seeded = await seedDatabase('digest-send');
    const { db } = seeded;
    await setDigestHour(db, 9);

    const { sent, mailer } = recordingMailer();
    const done = await sendDailyDigest(
      { db, mailer, appUrl: APP_URL, now: at(12) },
      SEED.workspaceId,
    );

    expect(done).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('test@example.com');
  });

  test('does not send before its hour', async () => {
    seeded = await seedDatabase('digest-early');
    const { db } = seeded;
    await setDigestHour(db, 20);

    const { sent, mailer } = recordingMailer();
    const done = await sendDailyDigest(
      { db, mailer, appUrl: APP_URL, now: at(9) },
      SEED.workspaceId,
    );

    expect(done).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test('sends at most once a day', async () => {
    seeded = await seedDatabase('digest-once');
    const { db } = seeded;
    await setDigestHour(db, 9);

    const { sent, mailer } = recordingMailer();
    const deps = { db, mailer, appUrl: APP_URL, now: at(12) };

    await sendDailyDigest(deps, SEED.workspaceId);
    await sendDailyDigest(deps, SEED.workspaceId);

    expect(sent).toHaveLength(1);
  });

  test('a quiet day still gets a digest, and says so', async () => {
    seeded = await seedDatabase('digest-quiet');
    const { db } = seeded;
    await setDigestHour(db, 0);

    // No stage events and no sends today: silence here would be
    // indistinguishable from the product being broken.
    const { sent, mailer } = recordingMailer();
    await sendDailyDigest({ db, mailer, appUrl: APP_URL, now: at(12) }, SEED.workspaceId);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain('Nothing new');
  });

  test('the digest switched off sends nothing', async () => {
    seeded = await seedDatabase('digest-off');
    const { db } = seeded;

    const stamp = now();
    await db.execute({
      sql: `INSERT INTO workspace_settings (workspace_id, daily_digest, digest_hour_utc,
            created_at, updated_at) VALUES (?, 0, 0, ?, ?)`,
      args: [SEED.workspaceId, stamp, stamp],
    });

    const { sent, mailer } = recordingMailer();
    await sendDailyDigest({ db, mailer, appUrl: APP_URL, now: at(12) }, SEED.workspaceId);

    expect(sent).toHaveLength(0);
  });
});

describe('what the digest says about the queue', () => {
  test('splits the queue into what autopilot will send and what needs a human', async () => {
    seeded = await seedDatabase('digest-queue');
    const { db } = seeded;
    await setDigestHour(db, 9);

    // One email card autopilot owns, on a campaign that opted in.
    await db.execute({
      sql: `UPDATE campaigns SET approval_mode = 'trusted_automation' WHERE id = ?`,
      args: [SEED.campaignId],
    });
    await db.execute({
      sql: `UPDATE recommendations SET action = 'send_email', network = 'email' WHERE id = ?`,
      args: [SEED.recommendationId],
    });

    // One LinkedIn card only a person can act on.
    await db.execute({
      sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
            priority, reason, policy_status, policy_version, status, created_at)
            VALUES ('rec_li', ?, ?, ?, 'reply', 'linkedin', 10, 'they posted',
                    'manual_only', '2026-01-01', 'pending', ?)`,
      args: [SEED.workspaceId, SEED.campaignId, SEED.personId, now()],
    });

    // Autopilot remembers holding the email card.
    const ledger = new HoldLedger();
    ledger.observe(
      SEED.workspaceId,
      SEED.recommendationId,
      'This prospect shares a company inbox that has already had 2 message(s) this week; the limit is 2.',
    );

    // Jane has a picture and surfaced today.
    await db.execute({
      sql: `UPDATE people SET avatar_url = 'https://pics.example/jane.jpg' WHERE id = ?`,
      args: [SEED.personId],
    });
    await recordDiscovered(db, {
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      personId: SEED.personId,
    });

    const { sent, mailer } = recordingMailer();
    await sendDailyDigest(
      { db, mailer, appUrl: APP_URL, now: at(12), holdLedger: ledger },
      SEED.workspaceId,
    );

    const mail = sent[0];
    expect(mail?.text).toContain('Autopilot queue:   1 (1 held by a limit)');
    expect(mail?.text).toContain('Needs you:         1 (LinkedIn 1)');
    expect(mail?.text).not.toContain('Awaiting approval');
    expect(mail?.text).toContain(
      "1 held in the autopilot queue: the company inbox already had this week's messages.",
    );
    expect(mail?.html).toContain('<img src="https://pics.example/jane.jpg"');
  });

  test('a workspace with nothing on autopilot still gets the plain count', async () => {
    seeded = await seedDatabase('digest-plain');
    const { db } = seeded;
    await setDigestHour(db, 9);

    const { sent, mailer } = recordingMailer();
    await sendDailyDigest(
      { db, mailer, appUrl: APP_URL, now: at(12), holdLedger: new HoldLedger() },
      SEED.workspaceId,
    );

    // The seed's one pending card is a reply on a manual network.
    expect(sent[0]?.text).toContain('Needs you:         1');
    expect(sent[0]?.text).not.toContain('Autopilot queue');
  });
});
