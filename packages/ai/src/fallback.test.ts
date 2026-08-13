import { describe, expect, test } from 'bun:test';
import { FallbackModel, isBudgetExhausted } from './fallback';
import { GeminiModel, GeminiApiError, DEFAULT_GEMINI_MODEL } from './gemini';
import { StubModel, type GenerateInput, type GenerateResult, type TextModel } from './model';

/** A model that always throws, for driving the chain's failure paths. */
function failing(error: unknown): TextModel {
  return {
    generate: async () => {
      throw error;
    },
  };
}

function withStatus(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe('isBudgetExhausted', () => {
  test("Anthropic's spend cap is a 400, and is still exhaustion", () => {
    // The real body, which is why message matching exists at all: keying on
    // status alone would treat this as a bad request and never fall back.
    expect(
      isBudgetExhausted(
        withStatus(
          400,
          'You have reached your specified API usage limits. You will regain access on 2026-09-01.',
        ),
      ),
    ).toBe(true);
  });

  test('OpenAI exhausted credits', () => {
    expect(
      isBudgetExhausted(withStatus(429, 'You have no credits remaining. Add credits to continue')),
    ).toBe(true);
  });

  test('Gemini resource exhaustion', () => {
    expect(isBudgetExhausted(new GeminiApiError(429, 'RESOURCE_EXHAUSTED'))).toBe(true);
  });

  test('a bad request is not exhaustion', () => {
    expect(isBudgetExhausted(withStatus(400, 'messages.0.content: field required'))).toBe(false);
  });

  test('a server error is not exhaustion', () => {
    expect(isBudgetExhausted(withStatus(500, 'internal server error'))).toBe(false);
  });
});

describe('FallbackModel', () => {
  const INPUT: GenerateInput = { system: 'be brief', user: 'hello' };

  test('the first provider answers and the second is never called', async () => {
    let secondCalled = false;
    const second: TextModel = {
      generate: async (): Promise<GenerateResult> => {
        secondCalled = true;
        return {
          text: 'second',
          model: 'b',
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          refused: false,
        };
      },
    };

    const chain = new FallbackModel([
      { name: 'anthropic', model: new StubModel('first') },
      { name: 'gemini', model: second },
    ]);

    expect((await chain.generate(INPUT)).text).toBe('first');
    expect(secondCalled).toBe(false);
  });

  test('an exhausted provider hands over to the next', async () => {
    const skipped: string[] = [];

    const chain = new FallbackModel(
      [
        { name: 'anthropic', model: failing(withStatus(400, 'reached your API usage limits')) },
        { name: 'gemini', model: new StubModel('from gemini') },
      ],
      { onFallback: (attempt) => skipped.push(attempt.provider) },
    );

    expect((await chain.generate(INPUT)).text).toBe('from gemini');
    expect(skipped).toEqual(['anthropic']);
  });

  test('a bad request fails immediately rather than being re-sent elsewhere', async () => {
    let secondCalled = false;

    const chain = new FallbackModel([
      { name: 'anthropic', model: failing(withStatus(400, 'messages.0.content: field required')) },
      {
        name: 'gemini',
        model: {
          generate: async () => {
            secondCalled = true;
            return new StubModel('nope').generate(INPUT);
          },
        },
      },
    ]);

    await expect(chain.generate(INPUT)).rejects.toThrow('field required');
    // Our bug will fail identically on the next vendor. Retrying it would turn
    // one clear error into two vague ones and double the spend.
    expect(secondCalled).toBe(false);
  });

  test('a refusal is returned, not retried on another vendor', async () => {
    const refusing: TextModel = {
      generate: async () => ({
        text: '',
        model: 'a',
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        refused: true,
      }),
    };

    let secondCalled = false;
    const chain = new FallbackModel([
      { name: 'anthropic', model: refusing },
      {
        name: 'gemini',
        model: {
          generate: async () => {
            secondCalled = true;
            return new StubModel('x').generate(INPUT);
          },
        },
      },
    ]);

    const result = await chain.generate(INPUT);
    // A refusal is an answer, and shopping it around until a vendor agrees is
    // precisely the behaviour this product should not have.
    expect(result.refused).toBe(true);
    expect(secondCalled).toBe(false);
  });

  test('when the last provider is also exhausted the real reason survives', async () => {
    const chain = new FallbackModel([
      { name: 'anthropic', model: failing(withStatus(400, 'reached your API usage limits')) },
      { name: 'gemini', model: failing(withStatus(429, 'RESOURCE_EXHAUSTED: quota exceeded')) },
    ]);

    // Not "everything failed": the operator needs to know both are out and why.
    await expect(chain.generate(INPUT)).rejects.toThrow('quota exceeded');
  });

  test('it reports its order for the boot log', () => {
    const chain = new FallbackModel([
      { name: 'anthropic', model: new StubModel('a') },
      { name: 'gemini', model: new StubModel('b') },
    ]);

    expect(chain.providers).toEqual(['anthropic', 'gemini']);
  });

  test('an empty chain is a configuration error, not a silent no-op', () => {
    expect(() => new FallbackModel([])).toThrow('at least one model');
  });
});

describe('GeminiModel', () => {
  function stubFetch(body: unknown, status = 200) {
    return async (): Promise<Response> =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
  }

  test('it reads the reply and reports thinking as output', async () => {
    const model = new GeminiModel({
      apiKey: 'test',
      fetchImpl: stubFetch({
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 5, thoughtsTokenCount: 147 },
      }),
    });

    const result = await model.generate({ system: 's', user: 'u' });

    expect(result.text).toBe('{"ok":true}');
    // 5 visible tokens cost 152. Reporting only the visible ones is how a bill
    // arrives thirty times larger than the logs suggest.
    expect(result.outputTokens).toBe(152);
    expect(result.refused).toBe(false);
  });

  test('the token budget leaves room for thinking', async () => {
    let sentBody: Record<string, unknown> | undefined;

    const model = new GeminiModel({
      apiKey: 'test',
      fetchImpl: async (_input, init) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }),
          {
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });

    await model.generate({ system: 's', user: 'u', maxTokens: 100 });

    const config = sentBody?.generationConfig as { maxOutputTokens: number };
    // Sizing this to maxTokens alone returns an empty string: the model spends
    // the budget thinking and never reaches the reply.
    expect(config.maxOutputTokens).toBeGreaterThan(100);
  });

  test('a blocked prompt is a refusal, not an exception', async () => {
    const model = new GeminiModel({
      apiKey: 'test',
      fetchImpl: stubFetch({ promptFeedback: { blockReason: 'SAFETY' } }),
    });

    const result = await model.generate({ system: 's', user: 'u' });
    expect(result.refused).toBe(true);
  });

  test('an http error carries its status so the chain can classify it', async () => {
    const model = new GeminiModel({
      apiKey: 'test',
      fetchImpl: stubFetch({ error: { message: 'RESOURCE_EXHAUSTED' } }, 429),
    });

    await expect(model.generate({ system: 's', user: 'u' })).rejects.toBeInstanceOf(GeminiApiError);
  });

  test('the cached prefix is prepended rather than dropped', async () => {
    let sentBody: Record<string, unknown> | undefined;

    const model = new GeminiModel({
      apiKey: 'test',
      fetchImpl: async (_input, init) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }),
          {
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });

    await model.generate({ system: 'rules', user: 'u', cachedPrefix: 'the offering' });

    const system = sentBody?.systemInstruction as { parts: { text: string }[] };
    // Gemini has no cache breakpoint, but silently dropping the prefix would
    // change the instructions the model works from.
    expect(system.parts[0]!.text).toContain('the offering');
    expect(system.parts[0]!.text).toContain('rules');
  });

  test('the default model is an alias, not a pinned version', () => {
    // A pinned model is a scheduled outage: gemini-2.0-flash already 404s.
    expect(DEFAULT_GEMINI_MODEL).toContain('latest');
  });
});
