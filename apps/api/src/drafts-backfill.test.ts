/**
 * Filling in the drafts a queue is missing, without paying for the ones it is
 * not missing.
 *
 * The approvals page looked like a wall of cards with nothing written on them,
 * and the obvious reading — "drafting is broken" — was wrong. Production had
 * 77 recommendations without a draft, of which 75 were `refresh_research`:
 * internal actions that have no message by definition and never will. Only 2
 * were genuinely undrafted emails.
 *
 * So the expensive mistake here is not failing to draft. It is drafting
 * everything: an unfiltered backfill spends a model call per research card to
 * produce nothing, and reports each one as a refusal.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { now, type Client } from '@outreachgraph/db';
import type { GenerateInput, GenerateResult, TextModel } from '@outreachgraph/ai';
import { createApp } from './app';
import type { RequestActor } from './context';
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

/** Counts calls, so "did not draft it" is a measurable claim rather than a hope. */
function countingModel(): { calls: GenerateInput[]; model: TextModel } {
  const calls: GenerateInput[] = [];
  return {
    calls,
    model: {
      generate: async (input): Promise<GenerateResult> => {
        calls.push(input);
        return {
          text: 'A short grounded note.',
          model: 'test',
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          refused: false,
        };
      },
    },
  };
}

/** A recommendation with no draft, of whichever kind the caller asks for. */
async function addUndrafted(
  db: Client,
  id: string,
  action: string,
  network: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action,
          network, priority, reason, trigger_signal_id, policy_status, policy_version,
          expected_goal, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 80, 'Queued.', ?, 'allow_with_approval', '2026-08-11',
          'start_conversation', 'pending', ?)`,
    args: [
      id,
      SEED.workspaceId,
      SEED.campaignId,
      SEED.personId,
      action,
      network,
      SEED.signalId,
      now(),
    ],
  });
}

describe('backfilling missing drafts', () => {
  test('ignores internal research cards, which have no message to write', async () => {
    const seeded = await seedDatabase('backfill-skips-research');
    active = seeded;
    const { calls, model } = countingModel();
    const app = createApp({ db: seeded.db, authenticate: async () => ACTOR, model });

    for (let i = 0; i < 5; i += 1) {
      await addUndrafted(seeded.db, `rec_research_${i}`, 'refresh_research', 'website');
    }

    const response = await app.request('/api/v1/recommendations/drafts/backfill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 25 }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { considered: number; written: number };

    // Five cards the page shows as blank, and not one model call for them.
    expect(payload.considered).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('writes the outbound ones that really are missing a draft', async () => {
    const seeded = await seedDatabase('backfill-writes-email');
    active = seeded;
    const { calls, model } = countingModel();
    const app = createApp({ db: seeded.db, authenticate: async () => ACTOR, model });

    await addUndrafted(seeded.db, 'rec_email_1', 'send_email', 'email');
    await addUndrafted(seeded.db, 'rec_research_1', 'refresh_research', 'website');

    const response = await app.request('/api/v1/recommendations/drafts/backfill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 25 }),
    });

    const payload = (await response.json()) as { considered: number; written: number };
    expect(payload.considered).toBe(1);
    expect(calls.length).toBeGreaterThan(0);
  });

  test('respects the limit, because every card is a model call', async () => {
    const seeded = await seedDatabase('backfill-limit');
    active = seeded;
    const { model } = countingModel();
    const app = createApp({ db: seeded.db, authenticate: async () => ACTOR, model });

    for (let i = 0; i < 6; i += 1) {
      await addUndrafted(seeded.db, `rec_email_${i}`, 'send_email', 'email');
    }

    const response = await app.request('/api/v1/recommendations/drafts/backfill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 2 }),
    });

    const payload = (await response.json()) as { considered: number };
    expect(payload.considered).toBe(2);
  });
});
