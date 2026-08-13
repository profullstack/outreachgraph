/**
 * Gemini behind the same `TextModel` interface.
 *
 * A second vendor does not weaken the "one place talks to a model" rule — this
 * is still that one package, and callers still see one method. What changes is
 * only which service answers it.
 *
 * Plain HTTP rather than the Google SDK, for the reason `ResendMailer` gives:
 * one POST with a documented body is less to keep working than a dependency,
 * and it keeps the package's install footprint to the one SDK it already has.
 */

import type { GenerateInput, GenerateResult, TextModel } from './model';

/**
 * A moving alias rather than a pinned version, deliberately.
 *
 * `gemini-2.0-flash` is already retired and answers 404 with "no longer
 * available" — a pinned model is a scheduled outage. The alias tracks whatever
 * the current flash model is, and this is the fallback path: predictable
 * availability matters more here than a fixed output.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiModelOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export class MissingGeminiKeyError extends Error {
  constructor() {
    super('GEMINI_API_KEY is not configured');
    this.name = 'MissingGeminiKeyError';
  }
}

/** Carries the HTTP status so the fallback chain can tell budget from bad input. */
export class GeminiApiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`gemini ${status}: ${detail}`);
    this.name = 'GeminiApiError';
    this.status = status;
  }
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

export class GeminiModel implements TextModel {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetch: NonNullable<GeminiModelOptions['fetchImpl']>;

  constructor(options: GeminiModelOptions = {}) {
    const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) throw new MissingGeminiKeyError();

    this.#apiKey = apiKey;
    this.#model = options.model ?? DEFAULT_GEMINI_MODEL;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const model = input.model ?? this.#model;

    // A cached prefix has no equivalent here, so it is prepended to the system
    // text rather than dropped. Losing it would quietly change the instructions
    // the model is working from, which is worse than losing the cache discount.
    const system = input.cachedPrefix ? `${input.cachedPrefix}\n\n${input.system}` : input.system;

    // Thinking tokens count against this budget, and they are not small: a
    // 13-token prompt in testing spent 147 of them before writing 5 tokens of
    // answer. Sizing this to the caller's `maxTokens` alone returns an empty
    // string — the model thinks up to the cap and never reaches the reply.
    const maxOutputTokens = (input.maxTokens ?? 2048) * 3 + 2048;

    let response: Response;
    try {
      response = await this.#fetch(`${ENDPOINT}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.#apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: input.user }] }],
          generationConfig: { maxOutputTokens },
        }),
      });
    } catch (error) {
      throw new GeminiApiError(0, error instanceof Error ? error.message : String(error));
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new GeminiApiError(response.status, detail.slice(0, 500));
    }

    const body = (await response.json()) as GeminiResponse;

    const candidate = body.candidates?.[0];
    const refused =
      Boolean(body.promptFeedback?.blockReason) || candidate?.finishReason === 'SAFETY';

    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();

    return {
      text,
      model,
      inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
      // Thinking is output the caller paid for, so it is reported rather than
      // hidden — an accounting line that reads low while the bill reads high
      // is how a cost surprise happens.
      outputTokens:
        (body.usageMetadata?.candidatesTokenCount ?? 0) +
        (body.usageMetadata?.thoughtsTokenCount ?? 0),
      cachedTokens: 0,
      refused,
    };
  }
}
