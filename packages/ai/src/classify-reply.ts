/**
 * Labelling the replies no rule could place.
 *
 * `classifyReplyByRules` in `@outreachgraph/domain` runs first and settles the
 * machine-written mail (absences, bounces) and the explicit "take me off your
 * list". What is left is a person writing in their own words, and telling
 * "sounds good, send details" from "not for us, thanks" is reading, which is
 * what a model is for.
 *
 * What a model's label may do is limited elsewhere, not here: it can propose
 * a drafted answer and, for `interested`/`question` above a threshold on a
 * campaign that opted in, feed `decideAutoReply` — a deterministic rule that
 * still has the last word. It can never suppress anyone; a model that says
 * `unsubscribe_request` gets a card for a human. So this function's job is
 * only to be honest: a label from the fixed list, a confidence, a reason, and
 * `other` at zero confidence when the output cannot be read.
 */

import {
  isReplyLabel,
  newReplyText,
  type ReplyClassification,
  type ReplyLabel,
} from '@outreachgraph/domain';
import type { TextModel } from './model';

export interface ClassifyReplyInput {
  readonly subject?: string | undefined;
  readonly body: string;
  /** What we last sent them, so "yes" can be read as a yes to something. */
  readonly ourLastMessage?: string | undefined;
}

const DESCRIPTIONS: Readonly<Record<ReplyLabel, string>> = {
  interested: 'wants to continue: asks for details, pricing, a call, a demo, or says yes',
  not_interested: 'declines, says no thanks, not a fit, already has a solution',
  question: 'asks a question that needs an answer before they can decide',
  out_of_office: 'an automatic absence or out-of-office notice',
  unsubscribe_request: 'asks not to be contacted again',
  referral: 'points to someone else as the right person to talk to',
  bounce: 'a delivery failure notice',
  other: 'none of the above, or unclear',
};

const SYSTEM = [
  'You label replies to a business email.',
  'Answer with one JSON object and nothing else:',
  '{"label": "<label>", "confidence": <0 to 1>, "reason": "<one short sentence quoting their words>"}',
  '',
  'Labels:',
  ...Object.entries(DESCRIPTIONS).map(([label, meaning]) => `- ${label}: ${meaning}`),
  '',
  'Confidence is how sure you are that a careful human would pick the same label.',
  'If the reply mixes a question with interest, prefer "question".',
  'If you are unsure, use "other" with a low confidence. Never guess high.',
].join('\n');

/** The model's reading, or `other` at zero confidence when there is none. */
export async function classifyReplyWithModel(
  model: TextModel,
  input: ClassifyReplyInput,
): Promise<ReplyClassification> {
  const fresh = newReplyText(input.body) || input.body.trim();

  if (!fresh && !input.subject?.trim()) {
    return unreadable('the reply has no text to read');
  }

  const user = [
    input.ourLastMessage
      ? `What we sent them:\n"""\n${input.ourLastMessage.slice(0, 2000)}\n"""`
      : '',
    `Their reply${input.subject ? ` (subject: ${input.subject.slice(0, 200)})` : ''}:`,
    `"""\n${fresh.slice(0, 4000)}\n"""`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const generated = await model.generate({ system: SYSTEM, user, maxTokens: 200 });
  if (generated.refused) return unreadable('the model declined to label it');

  return parseClassification(generated.text);
}

/**
 * Reads the model's answer, strictly.
 *
 * Exported for tests. A label outside the list, a confidence that is not a
 * number between 0 and 1, or prose instead of JSON all come back as `other`
 * at zero — the one label that triggers nothing.
 */
export function parseClassification(text: string): ReplyClassification {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return unreadable('the model did not answer in the expected shape');

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return unreadable('the model did not answer in the expected shape');
  }

  const record = parsed as { label?: unknown; confidence?: unknown; reason?: unknown };
  if (!isReplyLabel(record.label)) return unreadable('the model named a label that does not exist');

  const confidence =
    typeof record.confidence === 'number' && Number.isFinite(record.confidence)
      ? Math.min(1, Math.max(0, record.confidence))
      : 0;

  return {
    label: record.label,
    confidence,
    source: 'model',
    reason:
      typeof record.reason === 'string' && record.reason.trim()
        ? record.reason.trim().slice(0, 300)
        : 'no reason given',
  };
}

function unreadable(reason: string): ReplyClassification {
  return { label: 'other', confidence: 0, source: 'model', reason };
}
