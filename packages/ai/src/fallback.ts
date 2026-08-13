/**
 * Trying one model, then the next, when the first has run out of money.
 *
 * The whole design rests on one distinction: a provider being *out of budget*
 * is worth retrying elsewhere, and almost nothing else is. A refusal is a
 * judgement another vendor will likely repeat; a malformed request is our bug
 * and will fail identically downstream; a 500 is transient and belongs to
 * whatever retries the job. Falling back on those would turn one clear failure
 * into two vague ones and quietly double the spend.
 *
 * Written after both keys in the vault turned out to be exhausted — Anthropic
 * capped until September, OpenAI at zero credits — which is exactly the failure
 * this exists to survive.
 */

import type { GenerateInput, GenerateResult, TextModel } from './model';

export interface FallbackAttempt {
  readonly provider: string;
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Whether an error means "this provider has no budget left".
 *
 * Matched on message text as well as status because the shapes differ per
 * vendor and none of them is a clean signal on its own: Anthropic reports a
 * spend cap as a **400** `invalid_request_error`, OpenAI reports exhausted
 * credits as a 429, and Gemini uses 429 RESOURCE_EXHAUSTED for both quota and
 * ordinary rate limiting.
 */
export function isBudgetExhausted(error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status;
  const message = error instanceof Error ? error.message : String(error);

  if (
    /usage limit|insufficient_quota|credit balance|no credits remaining|quota exceeded|billing|RESOURCE_EXHAUSTED|exceeded your current quota/i.test(
      message,
    )
  ) {
    return true;
  }

  // A bare 429 is rate limiting rather than exhaustion, but from here the two
  // are indistinguishable and both mean "not this provider, not now".
  return status === 429;
}

export interface FallbackEntry {
  readonly name: string;
  readonly model: TextModel;
}

export interface FallbackModelOptions {
  /** Called when a provider is skipped, so the operator can see it happening. */
  readonly onFallback?: (attempt: FallbackAttempt) => void;
}

/**
 * A `TextModel` that tries each provider in order.
 *
 * Callers see one model and cannot tell which vendor answered — which is the
 * point: the composer, the profile drafter and the site extractor all keep
 * working unchanged, and the deterministic quality gates still run over
 * whatever comes back.
 */
export class FallbackModel implements TextModel {
  readonly #entries: readonly FallbackEntry[];
  readonly #onFallback: FallbackModelOptions['onFallback'];

  constructor(entries: readonly FallbackEntry[], options: FallbackModelOptions = {}) {
    if (entries.length === 0) throw new Error('a fallback chain needs at least one model');
    this.#entries = entries;
    this.#onFallback = options.onFallback;
  }

  /** The providers in the order they will be tried, for logging at boot. */
  get providers(): readonly string[] {
    return this.#entries.map((entry) => entry.name);
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    let lastError: unknown;

    for (let i = 0; i < this.#entries.length; i += 1) {
      const entry = this.#entries[i]!;
      const isLast = i === this.#entries.length - 1;

      try {
        return await entry.model.generate(input);
      } catch (error) {
        lastError = error;

        // Out of budget and somewhere else to go: move on.
        if (isBudgetExhausted(error) && !isLast) {
          this.#onFallback?.({
            provider: entry.name,
            ok: false,
            reason: error instanceof Error ? error.message.slice(0, 200) : String(error),
          });
          continue;
        }

        // Anything else, or nowhere left to go: the caller gets the real
        // error, with the real reason, from the provider that actually failed.
        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('every model failed');
  }
}
