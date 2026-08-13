/**
 * Building a spoken script from an approved draft (PRD §14).
 *
 * Deterministic on purpose. The draft has already been through the §14.2
 * gates; re-generating prose from a model here would put an ungrounded claim
 * into a medium where a reviewer is far less likely to catch it than in text.
 * So the script is assembled from the draft's own sentences, and then run back
 * through the same grounding check as a second, independent gate.
 */

import { findUnsupportedClaims, type GroundingContext } from '@outreachgraph/ai';
import {
  countWords,
  estimateSpokenSeconds,
  MAX_VIDEO_SECONDS,
  type VideoScript,
  type VideoScriptRefusal,
  type VideoSegment,
} from '@outreachgraph/domain';

export interface BuildScriptInput {
  /** The approved draft body. Already grounded and human-reviewed. */
  readonly draftBody: string;
  /** Signals whose evidence grounds the draft, carried over verbatim. */
  readonly groundedSignalIds: readonly string[];
  /** The same grounding context the draft was checked against. */
  readonly grounding: GroundingContext;
  /** First name, used only if it already appears in the draft. */
  readonly firstName?: string;
  /** Overrides the 45s ceiling downward only; a longer cap is ignored. */
  readonly maxSeconds?: number;
}

export type BuildScriptResult =
  | { readonly ok: true; readonly script: VideoScript }
  | {
      readonly ok: false;
      readonly reason: VideoScriptRefusal;
      readonly unsupported?: readonly string[];
    };

/**
 * Splits a draft body into hook, context and ask, and validates the result.
 *
 * @param input - The approved draft and its grounding
 * @returns The script, or the reason one could not be built
 */
export function buildVideoScript(input: BuildScriptInput): BuildScriptResult {
  const body = input.draftBody.trim();
  if (!body) return { ok: false, reason: 'no_draft_body' };

  // A clip that says something about the prospect needs evidence behind it.
  // Without any, there is nothing to personalise and no reason to render.
  if (input.groundedSignalIds.length === 0) {
    return { ok: false, reason: 'no_grounded_evidence' };
  }

  const sentences = splitSentences(body);
  if (sentences.length === 0) return { ok: false, reason: 'no_draft_body' };

  const { hook, context, ask } = partition(sentences);

  // The hook is the only span allowed to reference the prospect's activity, so
  // it is the only one that must carry grounding.
  if (!hook) return { ok: false, reason: 'hook_not_grounded' };

  const hookCheck = findUnsupportedClaims(hook, input.grounding);
  if (hookCheck.unsupported.length > 0) {
    return { ok: false, reason: 'hook_not_grounded', unsupported: hookCheck.unsupported };
  }

  // The whole script gets the same treatment: a figure invented in the closing
  // line is no more acceptable than one invented in the opening one.
  const wholeCheck = findUnsupportedClaims(body, input.grounding);
  if (wholeCheck.unsupported.length > 0) {
    return { ok: false, reason: 'unsupported_claims', unsupported: wholeCheck.unsupported };
  }

  const segments: VideoSegment[] = [
    { kind: 'hook', text: hook, groundedSignalIds: [...input.groundedSignalIds] },
  ];
  if (context) segments.push({ kind: 'context', text: context, groundedSignalIds: [] });
  if (ask) segments.push({ kind: 'ask', text: ask, groundedSignalIds: [] });

  const spoken = segments.map((segment) => segment.text).join(' ');
  const estimatedSeconds = estimateSpokenSeconds(spoken);
  const cap = Math.min(input.maxSeconds ?? MAX_VIDEO_SECONDS, MAX_VIDEO_SECONDS);

  if (estimatedSeconds > cap) return { ok: false, reason: 'too_long' };

  return {
    ok: true,
    script: {
      segments,
      groundedSignalIds: [...new Set(input.groundedSignalIds)],
      wordCount: countWords(spoken),
      estimatedSeconds,
    },
  };
}

/**
 * Splits prose into sentences.
 *
 * Deliberately simple: it breaks on terminal punctuation followed by
 * whitespace, and leaves everything else alone. A draft is a handful of short
 * sentences written for a human, not arbitrary text.
 *
 * @param body - Prose to split
 * @returns Trimmed, non-empty sentences
 */
export function splitSentences(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Assigns sentences to the three segments.
 *
 * The first sentence is the hook, the last is the ask when there are at least
 * three, and everything between is context. With two sentences there is no
 * context; with one, the hook carries the whole clip.
 *
 * @param sentences - Sentences in order
 * @returns The three spans, any of which except the hook may be undefined
 */
function partition(sentences: readonly string[]): {
  hook: string | undefined;
  context: string | undefined;
  ask: string | undefined;
} {
  const [first, ...rest] = sentences;
  if (!first) return { hook: undefined, context: undefined, ask: undefined };
  if (rest.length === 0) return { hook: first, context: undefined, ask: undefined };
  if (rest.length === 1) return { hook: first, context: undefined, ask: rest[0] };

  const ask = rest[rest.length - 1];
  const context = rest.slice(0, -1).join(' ');

  return { hook: first, context, ask };
}
