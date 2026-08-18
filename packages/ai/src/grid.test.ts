/**
 * A research cell, and the reason its grounding rule is stricter than a
 * draft's rather than looser.
 *
 * A draft that invents a fact is read by a reviewer who knows the prospect. A
 * grid is scanned, sorted and filtered on, and nobody re-reads a cell — so an
 * invented competitor name here is more dangerous, not less.
 */

import { describe, expect, test } from 'bun:test';
import { StubModel } from './model';
import { answerGridCell, type GridEvidence } from './grid';

const QUESTION = { id: 'q1', prompt: 'Which payments provider are they on?' };

const EVIDENCE: readonly GridEvidence[] = [
  {
    signalId: 'sig_1',
    summary: 'complained about Stripe fees',
    excerpt: 'our Stripe fees went up again this quarter',
    sourceUrl: 'https://bsky.app/profile/jane/post/1',
  },
];

function input(evidence: readonly GridEvidence[] = EVIDENCE) {
  return { question: QUESTION, personName: 'Jane Smith', companyName: 'Acme', evidence };
}

describe('answerGridCell', () => {
  test('answers from the evidence and cites it', async () => {
    const model = new StubModel(
      JSON.stringify({ answer: 'Stripe.', signalIds: ['sig_1'], hasEvidence: true }),
    );

    const result = await answerGridCell(model, input());

    expect(result.status).toBe('answered');
    expect(result.answer).toBe('Stripe.');
    expect(result.groundedSignalIds).toEqual(['sig_1']);
  });

  test('does not call the model when there is nothing to reason over', async () => {
    const model = new StubModel('{}');

    const result = await answerGridCell(model, input([]));

    expect(result.status).toBe('no_evidence');
    expect(model.calls).toHaveLength(0);
  });

  test('reports no evidence when the model says it has none', async () => {
    const model = new StubModel(JSON.stringify({ answer: '', signalIds: [], hasEvidence: false }));

    expect((await answerGridCell(model, input())).status).toBe('no_evidence');
  });

  test('drops a citation to a signal it was never given', async () => {
    // The citation is the only thing that makes a cell checkable. A model that
    // cites an id it invented has invented the evidence too.
    const model = new StubModel(
      JSON.stringify({ answer: 'Adyen.', signalIds: ['sig_invented'], hasEvidence: true }),
    );

    const result = await answerGridCell(model, input());

    expect(result.status).toBe('no_evidence');
    expect(result.answer).toBeUndefined();
  });

  test('keeps only the citations it was actually given', async () => {
    const model = new StubModel(
      JSON.stringify({ answer: 'Stripe.', signalIds: ['sig_1', 'sig_nope'], hasEvidence: true }),
    );

    expect((await answerGridCell(model, input())).groundedSignalIds).toEqual(['sig_1']);
  });

  test('treats an empty answer as no evidence', async () => {
    const model = new StubModel(
      JSON.stringify({ answer: '   ', signalIds: ['sig_1'], hasEvidence: true }),
    );

    expect((await answerGridCell(model, input())).status).toBe('no_evidence');
  });

  test('treats prose instead of JSON as no evidence', async () => {
    const model = new StubModel('I think they probably use Stripe, based on the vibe.');

    expect((await answerGridCell(model, input())).status).toBe('no_evidence');
  });

  test('puts the evidence and the question in the prompt', async () => {
    const model = new StubModel(
      JSON.stringify({ answer: 'Stripe.', signalIds: ['sig_1'], hasEvidence: true }),
    );

    await answerGridCell(model, input());

    const prompt = model.calls[0]?.user ?? '';
    expect(prompt).toContain('Which payments provider');
    expect(prompt).toContain('our Stripe fees went up again');
    expect(prompt).toContain('sig_1');
  });
});
