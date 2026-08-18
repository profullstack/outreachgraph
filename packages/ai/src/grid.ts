/**
 * Answering one research question about one prospect (PRD §14.1 grounding).
 *
 * The product could research a person in response to a trigger and produce a
 * card. It could not answer "for these two hundred leads, which competitor are
 * they on" without opening two hundred cards, which is the question a human
 * actually has when deciding where to spend a week.
 *
 * The grounding rule from the composer applies here unchanged, and for a
 * sharper reason. A draft that invents a fact gets read by a reviewer who
 * knows the prospect and might catch it. A research table gets scanned, sorted
 * and filtered on — nobody re-reads a cell. An invented competitor name in a
 * grid is therefore *more* dangerous than one in a draft, not less, so
 * "not enough evidence" is a first-class answer and the model is told to
 * prefer it.
 */

import type { TextModel } from './model';

export interface GridQuestion {
  readonly id: string;
  readonly prompt: string;
}

/** One piece of stored evidence the answer may rest on. */
export interface GridEvidence {
  readonly signalId: string;
  readonly summary: string;
  readonly excerpt?: string;
  readonly sourceUrl?: string;
  readonly observedAt?: string;
}

export interface GridAnswerInput {
  readonly question: GridQuestion;
  readonly personName: string;
  readonly companyName?: string;
  readonly evidence: readonly GridEvidence[];
}

export type GridAnswerStatus = 'answered' | 'no_evidence' | 'failed';

export interface GridAnswer {
  readonly status: GridAnswerStatus;
  readonly answer?: string;
  /** Signals the answer actually used. Empty on `no_evidence`. */
  readonly groundedSignalIds: readonly string[];
  readonly model?: string;
}

const SYSTEM = [
  'You answer one question about one person, using only the evidence provided.',
  '',
  'Return one JSON object and nothing else:',
  '{"answer": string, "signalIds": [string], "hasEvidence": boolean}',
  '',
  'Rules:',
  '- Use only the numbered evidence. You have no other knowledge of this person.',
  '- If the evidence does not answer the question, set hasEvidence to false and',
  '  leave answer empty. Do not guess, and do not answer from the company name.',
  '- Every id in signalIds must be one you were given, and must be one you used.',
  '- Answer in at most two sentences. This lands in a table cell.',
  '- No hedging phrases. Either the evidence says it or it does not.',
].join('\n');

/**
 * Answers one cell.
 *
 * Returns `no_evidence` rather than throwing when there is nothing to reason
 * over, because a prospect with no signals yet is an ordinary state and not a
 * failure of the grid.
 */
export async function answerGridCell(
  model: TextModel,
  input: GridAnswerInput,
): Promise<GridAnswer> {
  if (input.evidence.length === 0) {
    return { status: 'no_evidence', groundedSignalIds: [] };
  }

  const result = await model.generate({
    system: SYSTEM,
    user: renderPrompt(input),
    maxTokens: 400,
  });

  if (result.refused) return { status: 'failed', groundedSignalIds: [] };

  const parsed = parseAnswer(result.text);
  if (!parsed || !parsed.hasEvidence || !parsed.answer.trim()) {
    return { status: 'no_evidence', groundedSignalIds: [], model: result.model };
  }

  // Only ids we actually supplied survive. A model that cites a signal it was
  // not given has either hallucinated the id or the evidence behind it, and
  // either way the citation is worthless — which makes the answer worthless,
  // because the citation is the only thing that makes it checkable.
  const allowed = new Set(input.evidence.map((item) => item.signalId));
  const cited = parsed.signalIds.filter((id) => allowed.has(id));

  if (cited.length === 0) {
    return { status: 'no_evidence', groundedSignalIds: [], model: result.model };
  }

  return {
    status: 'answered',
    answer: parsed.answer.trim(),
    groundedSignalIds: cited,
    model: result.model,
  };
}

function renderPrompt(input: GridAnswerInput): string {
  const lines = [
    `Person: ${input.personName}`,
    ...(input.companyName ? [`Company: ${input.companyName}`] : []),
    '',
    `Question: ${input.question.prompt}`,
    '',
    'Evidence:',
  ];

  for (const item of input.evidence) {
    lines.push(`- id: ${item.signalId}`);
    lines.push(`  summary: ${item.summary}`);
    if (item.excerpt) lines.push(`  said: "${item.excerpt}"`);
    if (item.observedAt) lines.push(`  when: ${item.observedAt}`);
    if (item.sourceUrl) lines.push(`  where: ${item.sourceUrl}`);
  }

  return lines.join('\n');
}

interface ParsedAnswer {
  readonly answer: string;
  readonly signalIds: readonly string[];
  readonly hasEvidence: boolean;
}

function parseAnswer(text: string): ParsedAnswer | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      answer?: unknown;
      signalIds?: unknown;
      hasEvidence?: unknown;
    };

    return {
      answer: typeof parsed.answer === 'string' ? parsed.answer : '',
      signalIds: Array.isArray(parsed.signalIds)
        ? parsed.signalIds.filter((v): v is string => typeof v === 'string')
        : [],
      hasEvidence: parsed.hasEvidence === true,
    };
  } catch {
    return undefined;
  }
}
