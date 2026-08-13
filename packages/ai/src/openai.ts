/**
 * OpenAI behind the same `TextModel` interface.
 *
 * This is the first fallback, not the second: it sits between Anthropic and
 * Gemini because it is the closer substitute — same instruction-following
 * shape, same prompt structure, so a draft written here still passes the
 * deterministic gates that were tuned against Claude's output.
 *
 * Plain HTTP rather than the OpenAI SDK, for the reason `GeminiModel` gives:
 * one POST with a documented body is less to keep working than a dependency,
 * and it keeps this package's install footprint to the one SDK it already has.
 */

import type { GenerateInput, GenerateResult, TextModel } from './model';

/**
 * Undated rather than a dated snapshot, matching the Gemini adapter's
 * reasoning: snapshots retire on a schedule and a pinned one is an outage with
 * a date on it. `gpt-5.5` resolves to whichever snapshot backs that generation.
 *
 * There is no moving `-latest` alias to use here the way Gemini has one — the
 * `*-chat-latest` ids move, but they are the chat-tuned line and not the
 * reasoning line, so they are not the same model with a friendlier name. That
 * makes this a generation to be bumped by hand, and `OPENAI_MODEL` exists so a
 * newer one can be adopted without a deploy of this file.
 */
export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export interface OpenAIModelOptions {
  readonly apiKey?: string;
  readonly model?: string;
  /** For a proxy or a compatible gateway; defaults to the OpenAI endpoint. */
  readonly endpoint?: string;
  readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export class MissingOpenAIKeyError extends Error {
  constructor() {
    super('OPENAI_API_KEY is not configured');
    this.name = 'MissingOpenAIKeyError';
  }
}

/** Carries the HTTP status so the fallback chain can tell budget from bad input. */
export class OpenAIApiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`openai ${status}: ${detail}`);
    this.name = 'OpenAIApiError';
    this.status = status;
  }
}

interface OpenAIResponse {
  model?: string;
  choices?: {
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export class OpenAIModel implements TextModel {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #endpoint: string;
  readonly #fetch: NonNullable<OpenAIModelOptions['fetchImpl']>;

  constructor(options: OpenAIModelOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new MissingOpenAIKeyError();

    this.#apiKey = apiKey;
    this.#model = options.model ?? DEFAULT_OPENAI_MODEL;
    this.#endpoint = options.endpoint ?? ENDPOINT;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const model = input.model ?? this.#model;

    // Prompt caching here is automatic on the prefix of the request — there is
    // no breakpoint to declare — so the cached half is simply put first and
    // the discount either applies or it does not. Dropping it instead would
    // change the instructions the model works from, which is the one outcome
    // worth avoiding.
    const system = input.cachedPrefix ? `${input.cachedPrefix}\n\n${input.system}` : input.system;

    // Reasoning tokens are drawn from this same budget and are not small, the
    // lesson `GeminiModel` already paid for: sizing the cap to the caller's
    // `maxTokens` alone lets the model reason up to the limit and return an
    // empty string, which reads downstream as a model that had nothing to say.
    const maxCompletionTokens = (input.maxTokens ?? 2048) * 3 + 2048;

    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          // Not `max_tokens`: the reasoning models reject it outright, and a
          // fallback that 400s on every call is worse than no fallback.
          max_completion_tokens: maxCompletionTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: input.user },
          ],
        }),
      });
    } catch (error) {
      throw new OpenAIApiError(0, error instanceof Error ? error.message : String(error));
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new OpenAIApiError(response.status, detail.slice(0, 500));
    }

    const body = (await response.json()) as OpenAIResponse;

    const choice = body.choices?.[0];

    // A refusal comes back as HTTP 200 with `refusal` set and `content` null.
    // Reading content without checking it is how a refusal becomes an empty
    // draft that looks like success.
    const refused = Boolean(choice?.message?.refusal) || choice?.finish_reason === 'content_filter';

    return {
      text: (choice?.message?.content ?? '').trim(),
      model: body.model ?? model,
      inputTokens: body.usage?.prompt_tokens ?? 0,
      // `completion_tokens` already includes reasoning tokens, so this is the
      // billed figure rather than a flattering subset of it.
      outputTokens: body.usage?.completion_tokens ?? 0,
      cachedTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      refused,
    };
  }
}
