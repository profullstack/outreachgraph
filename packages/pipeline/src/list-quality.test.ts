import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryOne, type Client } from '@outreachgraph/db';
import type { Mailer, Message, SendResult } from '@outreachgraph/email';
import type { SmtpProber, VerifierDeps } from '@outreachgraph/providers';
import {
  bounceGateTripped,
  catchAllAllowed,
  statusFromEvidence,
  verificationFresh,
} from '@outreachgraph/domain';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { HoldLedger, runAutopilot } from './autopilot';
import {
  campaignBounceState,
  listHealthReport,
  markAddressBounced,
  readVerification,
  recordVerification,
} from './list-quality';

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

async function makeSendable(db: Client, personEmail = 'jane@acme.com'): Promise<void> {
  await db.execute({
    sql: `UPDATE campaigns SET approval_mode = 'trusted_automation' WHERE id = ?`,
    args: [SEED.campaignId],
  });
  await db.execute({
    sql: `UPDATE recommendations SET action = 'send_email', network = 'email' WHERE id = ?`,
    args: [SEED.recommendationId],
  });
  await db.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
          confidence, source_type, verified_by, first_seen_at)
          VALUES ('sid_jane_email', ?, 'email', ?, ?, 0.88, 'public_web', '[]', ?)`,
    args: [SEED.personId, personEmail, personEmail, now()],
  });
}

/** Writes a campaign history of `sends` messages, `bounces` of which bounced. */
async function history(db: Client, sends: number, bounces: number): Promise<void> {
  const stamp = new Date(Date.now() - 3_600_000).toISOString();
  for (let i = 0; i < sends; i += 1) {
    await db.execute({
      sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network, direction,
            state, contact_address, occurred_at, recorded_at)
            VALUES (?, ?, ?, ?, 'email', 'outbound', 'sent', ?, ?, ?)`,
      args: [
        `int_s${i}`,
        SEED.workspaceId,
        SEED.personId,
        SEED.campaignId,
        `p${i}@x.com`,
        stamp,
        stamp,
      ],
    });
  }
  for (let i = 0; i < bounces; i += 1) {
    await db.execute({
      sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network, direction,
            state, contact_address, occurred_at, recorded_at)
            VALUES (?, ?, ?, ?, 'email', 'automated', 'bounced', ?, ?, ?)`,
      args: [
        `int_b${i}`,
        SEED.workspaceId,
        SEED.personId,
        SEED.campaignId,
        `p${i}@x.com`,
        stamp,
        stamp,
      ],
    });
  }
}

/** A resolver and prober that answer from a table instead of the network. */
function fakeVerifier(answers: {
  mx?: readonly string[];
  code?: number;
  catchAll?: boolean;
  unreachable?: boolean;
}): VerifierDeps & { asked: string[] } {
  const asked: string[] = [];
  const smtp: SmtpProber = {
    probe: async (_host, addresses) => {
      asked.push(...addresses.slice(1));
      if (answers.unreachable) return { reachable: false, reason: 'connect_failed' };
      const codes = new Map<string, number>();
      codes.set(addresses[0] as string, answers.catchAll ? 250 : 550);
      for (const address of addresses.slice(1)) codes.set(address, answers.code ?? 250);
      return { reachable: true, codes };
    },
  };
  return {
    asked,
    resolveMx: async () =>
      (answers.mx ?? ['mx.acme.com']).map((exchange) => ({ exchange, priority: 10 })),
    smtp,
    randomLocalPart: () => 'nobody-here',
  };
}

describe('list quality rules', () => {
  test('a check older than 90 days, or older than a pause, is stale', () => {
    const at = new Date('2026-10-07T00:00:00Z');
    expect(verificationFresh('2026-09-01T00:00:00Z', at)).toBe(true);
    expect(verificationFresh('2026-06-01T00:00:00Z', at)).toBe(false);
    expect(
      verificationFresh('2026-10-01T00:00:00Z', at, { notBefore: '2026-10-05T00:00:00Z' }),
    ).toBe(false);
  });

  test('the gate needs 50 sends and more than 2%', () => {
    expect(bounceGateTripped({ sends: 10, bounces: 5 })).toBe(false);
    expect(bounceGateTripped({ sends: 100, bounces: 2 })).toBe(false);
    expect(bounceGateTripped({ sends: 100, bounces: 3 })).toBe(true);
    expect(catchAllAllowed({ sends: 100, bounces: 1 })).toBe(true);
    expect(catchAllAllowed({ sends: 100, bounces: 2 })).toBe(false);
  });

  test('evidence maps to a status', () => {
    expect(statusFromEvidence({ mx: [], smtp: 'skipped', verdict: 'unknown' }).status).toBe(
      'invalid',
    );
    expect(statusFromEvidence({ mx: ['a'], smtp: 'unavailable', verdict: 'unknown' }).status).toBe(
      'unverified',
    );
    expect(
      statusFromEvidence({ mx: ['a'], smtp: 'probed', catchAll: true, verdict: 'unknown' }).status,
    ).toBe('catch_all');
    expect(statusFromEvidence({ mx: ['a'], smtp: 'probed', verdict: 'rejected' }).status).toBe(
      'invalid',
    );
    expect(statusFromEvidence({ mx: ['a'], smtp: 'probed', verdict: 'accepted' }).status).toBe(
      'valid',
    );
  });
});

describe('autopilot list quality', () => {
  test('verifies an address before its first message and caches the verdict', async () => {
    seeded = await seedDatabase('lq-verify');
    const { db } = seeded;
    await makeSendable(db);
    const verifier = fakeVerifier({ code: 250 });

    const { sent, mailer } = recordingMailer();
    await runAutopilot({ db, mailer, verifier, holdLedger: new HoldLedger() }, SEED.workspaceId);

    expect(sent).toHaveLength(1);
    expect(verifier.asked).toEqual(['jane@acme.com']);
    expect((await readVerification(db, 'JANE@acme.com'))?.status).toBe('valid');
  });

  test('a refused address is held and never sent', async () => {
    seeded = await seedDatabase('lq-refused');
    const { db } = seeded;
    await makeSendable(db);

    const { sent, mailer } = recordingMailer();
    const result = await runAutopilot(
      { db, mailer, verifier: fakeVerifier({ code: 550 }), holdLedger: new HoldLedger() },
      SEED.workspaceId,
    );

    expect(sent).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain('failed verification');
  });

  test('a blocked port 25 still sends on MX alone', async () => {
    seeded = await seedDatabase('lq-blocked');
    const { db } = seeded;
    await makeSendable(db);

    const { sent, mailer } = recordingMailer();
    await runAutopilot(
      { db, mailer, verifier: fakeVerifier({ unreachable: true }), holdLedger: new HoldLedger() },
      SEED.workspaceId,
    );

    expect(sent).toHaveLength(1);
    expect((await readVerification(db, 'jane@acme.com'))?.status).toBe('unverified');
  });

  test('a bounced address is never written to again, and its cadences stop', async () => {
    seeded = await seedDatabase('lq-bounced');
    const { db } = seeded;
    await makeSendable(db);

    await markAddressBounced(db, {
      workspaceId: SEED.workspaceId,
      address: 'jane@acme.com',
      personId: SEED.personId,
      detail: 'Undelivered Mail Returned to Sender',
    });

    const { sent, mailer } = recordingMailer();
    const result = await runAutopilot(
      { db, mailer, holdLedger: new HoldLedger() },
      SEED.workspaceId,
    );

    expect(sent).toHaveLength(0);
    // The bounced address is not offered at all, so there is nothing to write to.
    expect(result.skipped[0]?.reason).toContain('no address');
  });

  test('over 2% bounced: the campaign pauses, re-verifies, and resumes on a fresh window', async () => {
    seeded = await seedDatabase('lq-gate');
    const { db } = seeded;
    await makeSendable(db);
    await history(db, 60, 3);

    const verifier = fakeVerifier({ code: 250 });
    const ledger = new HoldLedger();
    const { sent, mailer } = recordingMailer();

    // A pass with no budget for checks: the campaign trips, nothing sends, and
    // because the queue is not re-checked yet it stays paused.
    let result = await runAutopilot(
      { db, mailer, verifier, maxVerificationsPerRun: 0, holdLedger: ledger },
      SEED.workspaceId,
    );
    expect(sent).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain('campaign paused');
    expect((await campaignBounceState(db, SEED.campaignId)).pausedAt).not.toBeNull();

    // A pass that re-checks the whole queue resumes it, still without sending.
    result = await runAutopilot({ db, mailer, verifier, holdLedger: ledger }, SEED.workspaceId);
    expect(sent).toHaveLength(0);
    const state = await campaignBounceState(db, SEED.campaignId);
    expect(state.pausedAt).toBeNull();
    expect(state.window.sends).toBe(0);

    // And the next one sends.
    await runAutopilot({ db, mailer, verifier, holdLedger: ledger }, SEED.workspaceId);
    expect(sent).toHaveLength(1);

    const event = await queryOne<{ message: string }>(
      db,
      `SELECT message FROM workflow_events WHERE campaign_id = ? AND message LIKE 'Resumed%'`,
      [SEED.campaignId],
    );
    expect(event?.message).toContain('re-verified');
  });

  test('an accept-all address waits while the campaign bounces above 1%', async () => {
    seeded = await seedDatabase('lq-catchall');
    const { db } = seeded;
    await makeSendable(db);
    await history(db, 100, 2);
    await recordVerification(db, 'jane@acme.com', { status: 'catch_all', reason: 'accepts all' });

    const { sent, mailer } = recordingMailer();
    const result = await runAutopilot(
      { db, mailer, holdLedger: new HoldLedger() },
      SEED.workspaceId,
    );

    expect(sent).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain('accept-all');

    const report = await listHealthReport(db, SEED.campaignId);
    expect(report.sends).toBe(100);
    expect(report.bounces).toBe(2);
  });
});
