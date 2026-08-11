/**
 * The model boundary (PRD §1.1 principle 8, §20).
 *
 * One place in the codebase talks to an LLM. Everything else — policy,
 * identity, scoring, the quality gates — is deterministic and stays that way.
 * Keeping the surface this narrow is what makes "no LLM decides a merge or a
 * policy outcome" an architectural fact rather than a guideline.
 */

import Anthropic from '@anthropic-ai/sdk';

/** Opus 5 is the default; a workspace may pin a cheaper model per campaign. */
export const DEFAULT_MODEL = 'claude-opus-5';

export interface GenerateInput {
  readonly system: string;
  readonly user: string;
  readonly maxTokens?: number;
  readonly model?: string;
  /**
   * Stable prefix for prompt caching. The offering and voice profile repeat
   * across every draft in a campaign, so they belong here rather than inlined
   * into `system` where a per-prospect edit would invalidate the cache.
   */
  readonly cachedPrefix?: string;
}

export interface GenerateResult {
  readonly text: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  /** True when the model declined; the caller must not treat text as a draft. */
  readonly refused: boolean;
}

export interface TextModel {
  generate(input: GenerateInput): Promise<GenerateResult>;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY is not configured');
    this.name = 'MissingApiKeyError';
  }
}

export interface ClaudeModelOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly client?: Anthropic;
}

export class ClaudeModel implements TextModel {
  readonly #client: Anthropic;
  readonly #model: string;

  constructor(options: ClaudeModelOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!options.client && !apiKey) throw new MissingApiKeyError();

    this.#client = options.client ?? new Anthropic({ apiKey });
    this.#model = options.model ?? DEFAULT_MODEL;
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const model = input.model ?? this.#model;

    const system = input.cachedPrefix
      ? [
          // The breakpoint sits at the end of the stable prefix, so the
          // per-prospect half after it can change freely without a cache miss.
          {
            type: 'text' as const,
            text: input.cachedPrefix,
            cache_control: { type: 'ephemeral' as const },
          },
          { type: 'text' as const, text: input.system },
        ]
      : input.system;

    // `output_config: { effort: "low" }` would suit this task — drafting is
    // short and well-specified, and lower effort produces less of the
    // elaboration the quality gates then reject. It is omitted because the
    // installed SDK does not type it, and an unverifiable request parameter
    // that 400s means no drafts at all. Add it once the SDK catches up.
    const response = await this.#client.messages.create({
      model,
      max_tokens: input.maxTokens ?? 2048,
      system,
      messages: [{ role: 'user', content: input.user }],
    });

    // A refusal returns HTTP 200 with an empty or partial body — reading
    // content[0] without checking stop_reason is how that becomes a crash.
    const refused = response.stop_reason === 'refusal';

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    return {
      text,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cachedTokens: response.usage.cache_read_input_tokens ?? 0,
      refused,
    };
  }
}

/**
 * A model that returns a fixed response.
 *
 * Composer tests assert on prompt construction and the quality gates, neither
 * of which should depend on a live API call — or cost money in CI.
 */
export class StubModel implements TextModel {
  readonly #responses: string[];
  readonly calls: GenerateInput[] = [];

  constructor(responses: string | readonly string[]) {
    this.#responses = typeof responses === 'string' ? [responses] : [...responses];
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    this.calls.push(input);
    const text = this.#responses.length > 1 ? this.#responses.shift()! : this.#responses[0]!;

    return {
      text,
      model: 'stub',
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      refused: false,
    };
  }
}
