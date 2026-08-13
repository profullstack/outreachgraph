import { afterEach, describe, expect, test } from 'bun:test';
import type { GroundingContext } from '@outreachgraph/ai';
import { now } from '@outreachgraph/db';
import type { PolicyRequest } from '@outreachgraph/policy';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { FixtureVideoRenderer, RenderFailedError, type VideoRenderer } from './renderer';
import { renderVideoForDraft, VIDEO_CAPABILITY_FLAG } from './render';

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

const GROUNDING: GroundingContext = {
  evidence: ['Does anyone have a good alternative to our current cross-border payouts provider?'],
  facts: ['Jane Smith', 'Acme'],
  offering: ['Settlement in 40 markets'],
};

const BASE_POLICY: Omit<PolicyRequest, 'network' | 'action'> = {
  approvalMode: 'draft_and_approve',
  hasConnectedAccount: true,
  personSuppressed: false,
  personBelievedMinor: false,
  personDeleted: false,
  identityConfidence: 0.97,
  minIdentityConfidence: 0.85,
  actionsToday: 0,
  maxActionsPerDay: 50,
  actionsToThisProspectThisWeek: 0,
  maxActionsPerProspectPerWeek: 3,
  featureFlags: { [VIDEO_CAPABILITY_FLAG]: true },
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    policy: BASE_POLICY,
    grounding: GROUNDING,
    ...overrides,
  } as Parameters<typeof renderVideoForDraft>[3];
}

/** Seeds the database and puts the draft in the state a render expects. */
async function fixture(label: string, options: { approved?: boolean; body?: string } = {}) {
  active = await seedDatabase(`video-${label}`);
  const { db } = active;

  await db.execute({
    sql: 'UPDATE drafts SET body = ? WHERE id = ?',
    args: [
      options.body ??
        'I saw you asked about cross-border payouts. We settle in 40 markets. Worth a look?',
      SEED.draftId,
    ],
  });

  if (options.approved !== false) {
    await db.execute({
      sql: `INSERT INTO approvals (id, workspace_id, recommendation_id, decision, decided_by, decided_at)
            VALUES ('apr_test', ?, ?, 'approved', ?, ?)`,
      args: [SEED.workspaceId, SEED.recommendationId, SEED.userId, now()],
    });
  }

  return active;
}

describe('rendering a video for an approved draft', () => {
  test('renders, stores the asset and marks it ready', async () => {
    const { db } = await fixture('happy');
    const renderer = new FixtureVideoRenderer();

    const result = await renderVideoForDraft(db, renderer, SEED.draftId, context());

    expect(result.ok).toBe(true);
    expect(result.videoAssetId).toMatch(/^vid_/);
    expect(result.assetUrl).toContain('.mp4');
    expect(renderer.calls).toHaveLength(1);

    const row = await db.execute({
      sql: 'SELECT status, asset_url, renderer, grounded_signal_ids, policy_version FROM video_assets WHERE id = ?',
      args: [result.videoAssetId!],
    });

    expect(row.rows[0]?.status).toBe('ready');
    expect(row.rows[0]?.renderer).toBe('fixture');
    expect(JSON.parse(String(row.rows[0]?.grounded_signal_ids))).toEqual([SEED.signalId]);
    expect(row.rows[0]?.policy_version).toBeTruthy();
  });

  test('stores the script segment by segment', async () => {
    const { db } = await fixture('script');
    const result = await renderVideoForDraft(
      db,
      new FixtureVideoRenderer(),
      SEED.draftId,
      context(),
    );

    const row = await db.execute({
      sql: 'SELECT script_json FROM video_assets WHERE id = ?',
      args: [result.videoAssetId!],
    });

    const script = JSON.parse(String(row.rows[0]?.script_json));
    expect(script.segments.map((s: { kind: string }) => s.kind)).toEqual([
      'hook',
      'context',
      'ask',
    ]);
    expect(script.segments[0].groundedSignalIds).toEqual([SEED.signalId]);
  });

  test('is idempotent — a second call does not re-render', async () => {
    const { db } = await fixture('idempotent');
    const renderer = new FixtureVideoRenderer();

    const first = await renderVideoForDraft(db, renderer, SEED.draftId, context());
    const second = await renderVideoForDraft(db, renderer, SEED.draftId, context());

    expect(second.ok).toBe(true);
    expect(second.videoAssetId).toBe(first.videoAssetId!);
    expect(renderer.calls).toHaveLength(1);
  });

  test('produces a stable url for the same script', async () => {
    const a = new FixtureVideoRenderer();
    const { db } = await fixture('stable');
    const first = await renderVideoForDraft(db, a, SEED.draftId, context());

    active?.cleanup();
    const second = await fixture('stable-2');
    const b = new FixtureVideoRenderer();
    const again = await renderVideoForDraft(second.db, b, SEED.draftId, context());

    expect(again.assetUrl).toBe(first.assetUrl!);
  });
});

describe('refusing to render', () => {
  test('refuses an unknown draft', async () => {
    const { db } = await fixture('unknown');
    const result = await renderVideoForDraft(
      db,
      new FixtureVideoRenderer(),
      'drf_missing',
      context(),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_draft');
  });

  test('refuses a draft nobody approved', async () => {
    const { db } = await fixture('unapproved', { approved: false });
    const renderer = new FixtureVideoRenderer();

    const result = await renderVideoForDraft(db, renderer, SEED.draftId, context());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_approved');
    expect(renderer.calls).toHaveLength(0);
  });

  test('refuses when the reviewer rejected it', async () => {
    const { db } = await fixture('rejected', { approved: false });
    await db.execute({
      sql: `INSERT INTO approvals (id, workspace_id, recommendation_id, decision, decided_by, decided_at)
            VALUES ('apr_no', ?, ?, 'rejected', ?, ?)`,
      args: [SEED.workspaceId, SEED.recommendationId, SEED.userId, now()],
    });

    const result = await renderVideoForDraft(
      db,
      new FixtureVideoRenderer(),
      SEED.draftId,
      context(),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_approved');
  });

  test('refuses when the capability flag is absent', async () => {
    const { db } = await fixture('no-flag');
    const result = await renderVideoForDraft(
      db,
      new FixtureVideoRenderer(),
      SEED.draftId,
      context({ policy: { ...BASE_POLICY, featureFlags: {} } }),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('capability_disabled');
  });

  test('refuses when the capability flag is explicitly off', async () => {
    const { db } = await fixture('flag-off');
    const result = await renderVideoForDraft(
      db,
      new FixtureVideoRenderer(),
      SEED.draftId,
      context({ policy: { ...BASE_POLICY, featureFlags: { [VIDEO_CAPABILITY_FLAG]: false } } }),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('capability_disabled');
  });

  test('re-checks policy at render time and refuses a suppressed person', async () => {
    const { db } = await fixture('suppressed');
    const renderer = new FixtureVideoRenderer();

    const result = await renderVideoForDraft(
      db,
      renderer,
      SEED.draftId,
      context({ policy: { ...BASE_POLICY, personSuppressed: true } }),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('policy_denied');
    expect(renderer.calls).toHaveLength(0);
  });

  test('refuses a draft whose body cannot be grounded', async () => {
    const { db } = await fixture('ungrounded', {
      body: 'I saw you lost 82% of volume. Worth a look?',
    });

    const result = await renderVideoForDraft(
      db,
      new FixtureVideoRenderer(),
      SEED.draftId,
      context(),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('hook_not_grounded');
    expect(result.unsupported).toContain('82%');
  });

  test('records a failed render instead of losing it', async () => {
    const { db } = await fixture('failure');
    const failing: VideoRenderer = {
      name: 'exploding',
      render: async () => {
        throw new RenderFailedError('exploding', 'upstream 500');
      },
    };

    const result = await renderVideoForDraft(db, failing, SEED.draftId, context());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('render_failed');

    const row = await db.execute({
      sql: 'SELECT status, error FROM video_assets WHERE id = ?',
      args: [result.videoAssetId!],
    });

    expect(row.rows[0]?.status).toBe('failed');
    expect(String(row.rows[0]?.error)).toContain('upstream 500');
  });
});
