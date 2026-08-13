/**
 * Rendering a personalised video for an approved draft (PRD §14, §15, §16).
 *
 * Three things make this safe to run, and all three are enforced here rather
 * than assumed upstream:
 *
 *   1. The draft must already be approved by a human. Video is not a channel
 *      where `trusted_automation` alone is sufficient — it is additionally
 *      gated by an explicit per-capability opt-in.
 *   2. Policy is re-evaluated now, against current flags and rules. The
 *      snapshot on the recommendation is never trusted (PRD §37).
 *   3. The script is derived from the approved body, so nothing the reviewer
 *      did not read can end up being spoken.
 */

import { newId, type ActionKind, type Network, type VideoScript } from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
import { evaluatePolicy, POLICY_VERSION, type PolicyRequest } from '@outreachgraph/policy';
import type { GroundingContext } from '@outreachgraph/ai';

import { buildVideoScript } from './script';
import { RenderFailedError, type RenderOptions, type VideoRenderer } from './renderer';

/**
 * Feature-flag key for the video capability.
 *
 * Separate from the network capability flags because this gates a *format*,
 * not a channel: it applies on top of whatever the underlying action already
 * permits, and never widens it.
 */
export const VIDEO_CAPABILITY_FLAG = 'capability.personalized_video';

export const RENDER_REFUSALS = [
  'no_draft',
  'not_approved',
  'capability_disabled',
  'policy_denied',
  'no_recommendation',
  'render_failed',
] as const;

export type RenderRefusal = (typeof RENDER_REFUSALS)[number];

export interface RenderContext {
  /** Everything the policy engine needs, minus network and action. */
  readonly policy: Omit<PolicyRequest, 'network' | 'action'>;
  /** The grounding context the draft was originally checked against. */
  readonly grounding: GroundingContext;
  readonly renderOptions?: RenderOptions;
  readonly maxSeconds?: number;
}

export interface RenderResult {
  readonly ok: boolean;
  readonly videoAssetId?: string;
  readonly assetUrl?: string;
  readonly script?: VideoScript;
  readonly reason?: RenderRefusal | string;
  readonly unsupported?: readonly string[];
  /** The policy decision that was made now, not the one on the recommendation. */
  readonly policyDecision?: string;
}

interface DraftRow {
  id: string;
  workspace_id: string;
  recommendation_id: string;
  body: string;
  grounded_signal_ids: string;
}

interface RecommendationRow {
  id: string;
  action: string;
  network: string;
  status: string;
}

/**
 * Renders a video for one approved draft.
 *
 * Idempotent: a draft that already has a video is returned as-is rather than
 * re-rendered, because rendering is billable and a retried worker run must not
 * produce a second clip.
 *
 * @param db - Database client
 * @param renderer - The renderer to use
 * @param draftId - Draft to render for
 * @param context - Policy state, grounding and render options
 * @returns The stored asset, or the reason nothing was rendered
 */
export async function renderVideoForDraft(
  db: Client,
  renderer: VideoRenderer,
  draftId: string,
  context: RenderContext,
): Promise<RenderResult> {
  const existing = await queryOne<{ id: string; asset_url: string | null; status: string }>(
    db,
    'SELECT id, asset_url, status FROM video_assets WHERE draft_id = ? LIMIT 1',
    [draftId],
  );
  if (existing) {
    return {
      ok: existing.status === 'ready',
      videoAssetId: existing.id,
      ...(existing.asset_url ? { assetUrl: existing.asset_url } : {}),
      ...(existing.status === 'ready' ? {} : { reason: existing.status }),
    };
  }

  const draft = await queryOne<DraftRow>(
    db,
    `SELECT id, workspace_id, recommendation_id, body, grounded_signal_ids
       FROM drafts WHERE id = ?`,
    [draftId],
  );
  if (!draft) return { ok: false, reason: 'no_draft' };

  const recommendation = await queryOne<RecommendationRow>(
    db,
    'SELECT id, action, network, status FROM recommendations WHERE id = ?',
    [draft.recommendation_id],
  );
  if (!recommendation) return { ok: false, reason: 'no_recommendation' };

  // 1. A human must have approved this specific message. Video amplifies a
  // bad draft rather than softening it, so there is no automated path here.
  const approval = await queryOne<{ decision: string }>(
    db,
    `SELECT decision FROM approvals
      WHERE recommendation_id = ? ORDER BY decided_at DESC LIMIT 1`,
    [recommendation.id],
  );
  if (approval?.decision !== 'approved') return { ok: false, reason: 'not_approved' };

  // 2. The capability is opt-in, on top of whatever the channel already allows.
  // A missing flag means disabled here — the inverse of the network flags,
  // because this one costs money and puts a synthetic likeness in front of
  // someone who did not ask for it.
  if (context.policy.featureFlags?.[VIDEO_CAPABILITY_FLAG] !== true) {
    return { ok: false, reason: 'capability_disabled' };
  }

  // 3. Re-run policy now. Flags and platform rules change between the moment a
  // recommendation is generated and the moment anything is sent.
  const decision = evaluatePolicy({
    ...context.policy,
    network: recommendation.network as Network,
    action: recommendation.action as ActionKind,
  });
  if (decision.decision === 'deny') {
    return { ok: false, reason: 'policy_denied', policyDecision: decision.decision };
  }

  const script = buildVideoScript({
    draftBody: draft.body,
    groundedSignalIds: parseIds(draft.grounded_signal_ids),
    grounding: context.grounding,
    ...(context.maxSeconds === undefined ? {} : { maxSeconds: context.maxSeconds }),
  });

  if (!script.ok) {
    return {
      ok: false,
      reason: script.reason,
      ...(script.unsupported ? { unsupported: script.unsupported } : {}),
      policyDecision: decision.decision,
    };
  }

  const videoAssetId = newId('videoAsset');
  const stamp = now();

  // Recorded before the render starts, so a crash mid-render leaves a row that
  // says so rather than no trace at all.
  await db.execute({
    sql: `INSERT INTO video_assets (id, workspace_id, draft_id, recommendation_id, status,
          script_json, grounded_signal_ids, renderer, policy_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'rendering', ?, ?, ?, ?, ?, ?)`,
    args: [
      videoAssetId,
      draft.workspace_id,
      draft.id,
      recommendation.id,
      JSON.stringify(script.script),
      JSON.stringify(script.script.groundedSignalIds),
      renderer.name,
      POLICY_VERSION,
      stamp,
      stamp,
    ],
  });

  try {
    const rendered = await renderer.render(script.script, context.renderOptions);

    await db.execute({
      sql: `UPDATE video_assets
               SET status = 'ready', asset_url = ?, duration_seconds = ?, updated_at = ?
             WHERE id = ?`,
      args: [rendered.assetUrl, rendered.durationSeconds, now(), videoAssetId],
    });

    return {
      ok: true,
      videoAssetId,
      assetUrl: rendered.assetUrl,
      script: script.script,
      policyDecision: decision.decision,
    };
  } catch (error) {
    const message = error instanceof RenderFailedError ? error.message : String(error);

    await db.execute({
      sql: `UPDATE video_assets SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
      args: [message.slice(0, 500), now(), videoAssetId],
    });

    return { ok: false, videoAssetId, reason: 'render_failed', policyDecision: decision.decision };
  }
}

/**
 * Parses a stored JSON array of ids.
 *
 * @param raw - JSON text from the database
 * @returns The ids, or an empty array when the column is malformed
 */
function parseIds(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
