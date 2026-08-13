import { describe, expect, test } from 'bun:test';
import type { GroundingContext } from '@outreachgraph/ai';
import { MAX_VIDEO_SECONDS } from '@outreachgraph/domain';
import { buildVideoScript, splitSentences } from './script';

const GROUNDING: GroundingContext = {
  evidence: ['Does anyone have a good alternative to our current cross-border payouts provider?'],
  facts: ['Jane Smith', 'Acme', 'Head of Payments'],
  offering: ['Settlement in 40 markets', 'We cut reconciliation time by 30%'],
};

const SIGNALS = ['sig_fees'];

function build(body: string, overrides: Partial<Parameters<typeof buildVideoScript>[0]> = {}) {
  return buildVideoScript({
    draftBody: body,
    groundedSignalIds: SIGNALS,
    grounding: GROUNDING,
    ...overrides,
  });
}

describe('splitSentences', () => {
  test('splits on terminal punctuation', () => {
    expect(splitSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?']);
  });

  test('drops empty fragments and trims', () => {
    expect(splitSentences('  Only one.   ')).toEqual(['Only one.']);
    expect(splitSentences('')).toEqual([]);
  });
});

describe('building a script from an approved draft', () => {
  test('assigns the first sentence to the hook and the last to the ask', () => {
    const result = build(
      'I saw you asked about cross-border payouts. We settle in 40 markets. Worth a look?',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.script.segments.map((s) => s.kind)).toEqual(['hook', 'context', 'ask']);
    expect(result.script.segments[0]?.text).toBe('I saw you asked about cross-border payouts.');
    expect(result.script.segments[2]?.text).toBe('Worth a look?');
  });

  test('carries grounding on the hook and nowhere else', () => {
    const result = build('I saw your question. We settle in 40 markets. Worth a look?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.script.segments[0]?.groundedSignalIds).toEqual(SIGNALS);
    expect(result.script.segments[1]?.groundedSignalIds).toEqual([]);
    expect(result.script.segments[2]?.groundedSignalIds).toEqual([]);
  });

  test('handles a two-sentence draft with no context', () => {
    const result = build('I saw your question. Worth a look?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.script.segments.map((s) => s.kind)).toEqual(['hook', 'ask']);
  });

  test('handles a single sentence as hook only', () => {
    const result = build('I saw your question about payouts.');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.script.segments.map((s) => s.kind)).toEqual(['hook']);
  });

  test('reports word count and an estimated duration', () => {
    const result = build('I saw your question. We settle in 40 markets. Worth a look?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.script.wordCount).toBe(12);
    expect(result.script.estimatedSeconds).toBeGreaterThan(0);
    expect(result.script.estimatedSeconds).toBeLessThanOrEqual(MAX_VIDEO_SECONDS);
  });

  test('de-duplicates the grounding signal list', () => {
    const result = build('I saw your question. Worth a look?', {
      groundedSignalIds: ['sig_fees', 'sig_fees', 'sig_other'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.script.groundedSignalIds).toEqual(['sig_fees', 'sig_other']);
  });
});

describe('refusing to build a script', () => {
  test('refuses an empty draft', () => {
    const result = build('   ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_draft_body');
  });

  test('refuses when nothing grounds the personalisation', () => {
    const result = build('I saw your question. Worth a look?', { groundedSignalIds: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_grounded_evidence');
  });

  test('refuses a hook that invents a figure', () => {
    const result = build('I saw you lost 82% of volume last quarter. Worth a look?');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('hook_not_grounded');
    expect(result.unsupported).toContain('82%');
  });

  test('refuses an unsupported claim outside the hook', () => {
    const result = build('I saw your question. We cut costs by 91%. Worth a look?');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported_claims');
    expect(result.unsupported).toContain('91%');
  });

  test('allows a figure that the offering actually supports', () => {
    const result = build('I saw your question. We settle in 40 markets. Worth a look?');
    expect(result.ok).toBe(true);
  });

  test('refuses a script that would run past the ceiling', () => {
    const long = `I saw your question. ${'We settle everywhere and reconcile quickly. '.repeat(30)}Worth a look?`;
    const result = build(long);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too_long');
  });

  test('honours a tighter caller-supplied cap', () => {
    const body = 'I saw your question. We settle in 40 markets and reconcile fast. Worth a look?';
    expect(build(body).ok).toBe(true);
    expect(build(body, { maxSeconds: 1 }).ok).toBe(false);
  });

  test('ignores a cap that tries to exceed the ceiling', () => {
    const long = `I saw your question. ${'We settle everywhere and reconcile quickly. '.repeat(30)}Worth a look?`;
    const result = build(long, { maxSeconds: 600 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too_long');
  });
});
