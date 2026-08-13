/**
 * Personalised video as a rendition of an approved draft (PRD §14, §15).
 *
 * A video is never an independent generation. It is derived from a draft that
 * has already passed the §14.2 grounding gates and been approved by a human,
 * which is what keeps "every personalised claim is grounded in stored
 * evidence" true for a medium where a reviewer cannot skim the claims as
 * easily as they can in text.
 *
 * This module names what a video is. Whether one may be rendered is decided by
 * `@outreachgraph/policy` plus the per-capability opt-in, and the rendering
 * itself lives in `@outreachgraph/media`.
 */

/**
 * The parts of a personalised video, in order.
 *
 * The split is not cosmetic: only `hook` may reference the prospect's own
 * activity, so the grounding requirement applies to a bounded, checkable span
 * rather than to a whole free-form monologue.
 */
export const VIDEO_SEGMENT_KINDS = ['hook', 'context', 'ask'] as const;
export type VideoSegmentKind = (typeof VIDEO_SEGMENT_KINDS)[number];

export interface VideoSegment {
  readonly kind: VideoSegmentKind;
  /** What is actually spoken. Plain prose — no direction, no stage notes. */
  readonly text: string;
  /**
   * Signals whose stored evidence supports this segment. Empty is legal for
   * `context` and `ask`, which say nothing about the prospect, and illegal for
   * `hook`, which does.
   */
  readonly groundedSignalIds: readonly string[];
}

export interface VideoScript {
  readonly segments: readonly VideoSegment[];
  /** Every grounding signal used anywhere in the script, de-duplicated. */
  readonly groundedSignalIds: readonly string[];
  readonly wordCount: number;
  /** Estimated spoken duration in seconds, at a conservative speaking rate. */
  readonly estimatedSeconds: number;
}

/**
 * Why a script could not be built. Mirrors the draft path: a missing video is
 * a working state, and the reviewer still has the text draft to send.
 */
export const VIDEO_SCRIPT_REFUSALS = [
  'no_draft_body',
  'no_grounded_evidence',
  'hook_not_grounded',
  'too_long',
  'unsupported_claims',
] as const;

export type VideoScriptRefusal = (typeof VIDEO_SCRIPT_REFUSALS)[number];

/** Lifecycle of a stored video asset. */
export const VIDEO_ASSET_STATUSES = ['pending', 'rendering', 'ready', 'failed'] as const;
export type VideoAssetStatus = (typeof VIDEO_ASSET_STATUSES)[number];

export interface VideoAsset {
  readonly id: string;
  readonly workspaceId: string;
  readonly draftId: string;
  readonly recommendationId: string;
  readonly status: VideoAssetStatus;
  readonly script: VideoScript;
  readonly groundedSignalIds: readonly string[];
  /** Where the rendered file lives. Absent until the render succeeds. */
  readonly assetUrl?: string;
  readonly durationSeconds?: number;
  readonly renderer: string;
  readonly policyVersion: string;
  readonly error?: string;
}

/**
 * Speaking rate used to estimate duration, in words per minute.
 *
 * Deliberately slow. Over-estimating length makes the duration cap bite early,
 * which is the safe direction: a clip that runs long is worse than one that
 * gets rejected before it costs anything to render.
 */
export const WORDS_PER_MINUTE = 130;

/** Hard ceiling for an outreach clip. Past this, nobody watches (PRD §14.1). */
export const MAX_VIDEO_SECONDS = 45;

/**
 * Estimates spoken duration for a body of text.
 *
 * @param text - The words that will be spoken
 * @returns Duration in whole seconds, rounded up
 */
export function estimateSpokenSeconds(text: string): number {
  const words = countWords(text);
  if (words === 0) return 0;
  return Math.ceil((words / WORDS_PER_MINUTE) * 60);
}

/**
 * Counts words the way a narrator would read them.
 *
 * @param text - Text to count
 * @returns Number of whitespace-delimited tokens containing a word character
 */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}
