import { describe, expect, test } from 'bun:test';
import { composeDraft, type ComposeInput } from './composer';
import { StubModel, type GenerateInput, type GenerateResult, type TextModel } from './model';

function input(overrides: Partial<ComposeInput> = {}): ComposeInput {
  return {
    action: 'reply',
    network: 'x',
    offering: {
      name: 'ExamplePay',
      category: 'developer payments infrastructure',
      valuePropositions: ['reduce payment integration time'],
      likelyPains: ['high payment fees', 'international settlement'],
      competitors: ['Stripe'],
    },
    prospect: {
      displayName: 'Jane Smith',
      firstName: 'Jane',
      title: 'VP Engineering',
      companyName: 'Acme',
      identityConfidence: 0.97,
    },
    trigger: {
      id: 'sig_1',
      summary: 'Asked for alternatives for cross-border payouts',
      evidence:
        'Does anyone have a good alternative to Stripe for cross-border payouts? ' +
        'Fees are brutal and settlement takes days.',
      sourceUrl: 'https://x.com/janesmith/status/1',
      network: 'x',
      ageDescription: '4h ago',
    },
    minIdentityConfidence: 0.85,
    ...overrides,
  };
}

const GOOD_DRAFT = 'Settlement taking days was our breaking point too on cross-border payouts.';

describe('grounding requirement (PRD §14.1)', () => {
  test('refuses to write anything without stored evidence', async () => {
    const model = new StubModel(GOOD_DRAFT);
    const result = await composeDraft(model, input({ trigger: undefined }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_evidence');
    // The model is never even called — there is nothing it could ground on.
    expect(model.calls).toHaveLength(0);
  });

  test('refuses when the signal has a summary but no verbatim excerpt', async () => {
    const model = new StubModel(GOOD_DRAFT);
    const result = await composeDraft(
      model,
      input({
        trigger: {
          id: 'sig_2',
          summary: 'Complained about payment fees',
          network: 'x',
          ageDescription: '2h ago',
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_evidence');
  });

  test('accepts a draft built from the evidence', async () => {
    const result = await composeDraft(new StubModel(GOOD_DRAFT), input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBe(GOOD_DRAFT);
    expect(result.groundedSignalIds).toEqual(['sig_1']);
  });
});

describe('a hallucinating model is rejected, not surfaced', () => {
  test('withholds a draft that invents a product', async () => {
    // Both attempts hallucinate — the composer must give up, not degrade.
    const model = new StubModel([
      'Your cross-border payouts note — Fluxwire fixed this for us.',
      'On cross-border settlement, Fluxwire solved it.',
    ]);

    const result = await composeDraft(model, input());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('failed_checks');
    expect(result.report?.unsupported).toContain('Fluxwire');
  });

  test('retries once and accepts a corrected second attempt', async () => {
    const model = new StubModel(['Your payouts note — Fluxwire fixed this for us.', GOOD_DRAFT]);

    const result = await composeDraft(model, input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts).toBe(2);
    expect(result.body).toBe(GOOD_DRAFT);
  });

  test('tells the model exactly what it invented on the retry', async () => {
    const model = new StubModel(['Your payouts note — Fluxwire fixed this for us.', GOOD_DRAFT]);

    await composeDraft(model, input());

    expect(model.calls).toHaveLength(2);
    // Naming the rejected fragment works better than restating the rule.
    expect(model.calls[1]!.user).toContain('Fluxwire');
    expect(model.calls[1]!.user).toContain('rejected');
  });

  test('honours maxAttempts of 1 — no retry', async () => {
    // Mid-sentence, so the extractor sees it — a sentence-initial capital
    // carries no information and is deliberately skipped.
    const model = new StubModel(['We use Fluxwire for cross-border settlement.', GOOD_DRAFT]);
    const result = await composeDraft(model, input({ maxAttempts: 1 }));

    expect(result.ok).toBe(false);
    expect(model.calls).toHaveLength(1);
  });

  test('withholds flattery even when otherwise grounded', async () => {
    const model = new StubModel([
      'I loved your post about cross-border settlement delays.',
      'I loved your post about cross-border settlement delays.',
    ]);

    const result = await composeDraft(model, input());
    expect(result.ok).toBe(false);
  });
});

describe('prompt construction', () => {
  test('gives the model the verbatim excerpt', async () => {
    const model = new StubModel(GOOD_DRAFT);
    await composeDraft(model, input());

    expect(model.calls[0]!.user).toContain('Fees are brutal');
  });

  test('puts the stable offering and voice behind the cache breakpoint', async () => {
    const model = new StubModel(GOOD_DRAFT);
    await composeDraft(model, input());

    const call = model.calls[0]!;
    // The offering repeats for every prospect in a campaign, so it must sit
    // in the cached prefix, not the per-prospect half.
    expect(call.cachedPrefix).toContain('ExamplePay');
    expect(call.cachedPrefix).not.toContain('Jane Smith');
    expect(call.user).toContain('Jane Smith');
  });

  test('states the channel length limit', async () => {
    const model = new StubModel(GOOD_DRAFT);
    await composeDraft(model, input({ network: 'x' }));

    expect(model.calls[0]!.system).toContain('280');
  });

  test('carries the voice profile into the cached prefix', async () => {
    const model = new StubModel(GOOD_DRAFT);
    await composeDraft(
      model,
      input({
        voice: {
          style: 'technical',
          instructions: 'Reference specific error modes.',
          prohibitedClaims: ['guaranteed uptime'],
        },
      }),
    );

    const prefix = model.calls[0]!.cachedPrefix ?? '';
    expect(prefix).toContain('Reference specific error modes.');
    expect(prefix).toContain('guaranteed uptime');
  });

  test('tells the model a public reply has an audience', async () => {
    const model = new StubModel(GOOD_DRAFT);
    await composeDraft(model, input({ action: 'reply' }));

    expect(model.calls[0]!.system).toContain('public reply');
  });
});

describe('model failures', () => {
  test('a refusal is not treated as a draft', async () => {
    const refusing: TextModel = {
      async generate(): Promise<GenerateResult> {
        return {
          text: '',
          model: 'stub',
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          refused: true,
        };
      },
    };

    const result = await composeDraft(refusing, input());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('model_refused');
  });

  test('an empty response is not treated as a draft', async () => {
    const result = await composeDraft(new StubModel('   '), input());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty');
  });
});

describe('output cleanup', () => {
  test('strips surrounding quotes the model adds despite instructions', async () => {
    const result = await composeDraft(new StubModel(`"${GOOD_DRAFT}"`), input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBe(GOOD_DRAFT);
  });

  test('strips a code fence', async () => {
    const result = await composeDraft(new StubModel(`\`\`\`\n${GOOD_DRAFT}\n\`\`\``), input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBe(GOOD_DRAFT);
  });
});

describe('identity confidence', () => {
  test('withholds a draft for a prospect below the threshold', async () => {
    const result = await composeDraft(
      new StubModel(GOOD_DRAFT),
      input({
        prospect: { displayName: 'Jane Smith', identityConfidence: 0.5 },
        minIdentityConfidence: 0.85,
      }),
    );

    expect(result.ok).toBe(false);
  });
});

describe('duplicate suppression', () => {
  test('withholds a draft identical to one already sent', async () => {
    const first = await composeDraft(new StubModel(GOOD_DRAFT), input());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await composeDraft(
      new StubModel(GOOD_DRAFT),
      input({ priorDraftHashes: [first.report.similarityHash] }),
    );

    expect(second.ok).toBe(false);
  });
});

describe('determinism of the checked surface', () => {
  test('the same model output always yields the same verdict', async () => {
    const state = input();
    const first = await composeDraft(new StubModel(GOOD_DRAFT), state);

    for (let i = 0; i < 10; i += 1) {
      const repeat = await composeDraft(new StubModel(GOOD_DRAFT), state);
      expect(repeat.ok).toBe(first.ok);
    }
  });

  test('prompts do not vary between identical calls', async () => {
    const a = new StubModel(GOOD_DRAFT);
    const b = new StubModel(GOOD_DRAFT);

    await composeDraft(a, input());
    await composeDraft(b, input());

    const stripVolatile = (call: GenerateInput) => ({ ...call });
    expect(stripVolatile(a.calls[0]!)).toEqual(stripVolatile(b.calls[0]!));
  });
});
