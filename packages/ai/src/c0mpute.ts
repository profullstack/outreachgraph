/**
 * c0mpute: inference on the peer network, through Infernet's public chat API.
 *
 * OutreachGraph prefers c0mpute for every model call and must not fall back
 * to a paid provider without approval (AGENTS.md). Infernet's playground API
 * is free and keyless:
 *
 *   POST /api/chat {messages, maxTokens, temperature, modelName?}
 *     -> {jobId, source, provider}
 *   GET  /api/chat/stream/<jobId>   server-sent events: meta, token…, done
 *
 * `source` says who serves it. `p2p` is a c0mpute node. When no node can take
 * the job, Infernet falls back to a hosted provider (`nim`: Cloudflare Workers
 * AI, billed to someone), so by default this adapter refuses any answer that
 * did not come from the peer network. `p2pOnly: false` lifts that.
 *
 * The public API allows 20 requests an hour per IP; a 429 surfaces with its
 * status, which the fallback chain reads as "not this provider, not now".
 */

import type { GenerateInput, GenerateResult, TextModel } from './model';

export const DEFAULT_C0MPUTE_URL = 'https://infernetprotocol.com';

export interface C0mputeModelOptions {
  readonly baseUrl?: string;
  /** A model a node serves, e.g. `qwen2.5:7b`. Unset: whatever node is free. */
  readonly model?: string;
  /** Refuse answers from Infernet's hosted fallback. Default true. */
  readonly p2pOnly?: boolean;
  /** Whole job, submit to done. Small CPU and iGPU nodes are slow. */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** Carries the HTTP status so the fallback chain can tell budget from bad input. */
export class C0mputeApiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`c0mpute ${status}: ${detail}`);
    this.name = 'C0mputeApiError';
    this.status = status;
  }
}

interface SubmitResponse {
  jobId?: string;
  source?: string;
  model?: string | null;
  error?: string;
}

export class C0mputeModel implements TextModel {
  readonly #baseUrl: string;
  readonly #model: string | undefined;
  readonly #p2pOnly: boolean;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: C0mputeModelOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_C0MPUTE_URL).replace(/\/$/, '');
    this.#model = options.model?.trim() || undefined;
    this.#p2pOnly = options.p2pOnly ?? true;
    this.#timeoutMs = options.timeoutMs ?? 180_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const system = [input.cachedPrefix, input.system].filter(Boolean).join('\n\n');
      const submitted = await this.#fetch(`${this.#baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: input.user },
          ],
          maxTokens: input.maxTokens ?? 1024,
          temperature: 0.4,
          ...(input.model || this.#model ? { modelName: input.model ?? this.#model } : {}),
        }),
        signal: controller.signal,
      });
      const job = (await submitted.json().catch(() => ({}))) as SubmitResponse;
      if (!submitted.ok || !job.jobId) {
        throw new C0mputeApiError(submitted.status, job.error ?? 'no job was created');
      }
      if (this.#p2pOnly && job.source !== 'p2p') {
        // Not free: a hosted fallback took it. Reported as unavailable so the
        // queue holds the work instead of paying for it.
        throw new C0mputeApiError(
          429,
          `no c0mpute node took the job (source ${job.source ?? 'unknown'})`,
        );
      }

      const stream = await this.#fetch(`${this.#baseUrl}/api/chat/stream/${job.jobId}`, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!stream.ok || !stream.body) {
        throw new C0mputeApiError(stream.status, 'could not read the job stream');
      }
      const { text, model } = await readStream(stream.body);
      return {
        text,
        model: `c0mpute/${model ?? job.model ?? 'p2p'}`,
        inputTokens: Math.ceil((system.length + input.user.length) / 4),
        outputTokens: Math.ceil(text.length / 4),
        cachedTokens: 0,
        refused: false,
      };
    } catch (error) {
      if (error instanceof C0mputeApiError) throw error;
      throw new C0mputeApiError(0, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Reads `meta`, `token` and `done` events until `done` or an `error`. */
export async function readStream(
  body: ReadableStream<Uint8Array>,
): Promise<{ text: string; model?: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let model: string | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const event = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim();
      const raw = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!event || !raw) continue;
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event === 'meta' && typeof data.model === 'string') model = data.model;
      else if (event === 'token' && typeof data.text === 'string') text += data.text;
      else if (event === 'done') {
        await reader.cancel().catch(() => undefined);
        return {
          text: typeof data.text === 'string' && data.text ? data.text : text,
          ...(model ? { model } : {}),
        };
      } else if (event === 'error') {
        await reader.cancel().catch(() => undefined);
        throw new C0mputeApiError(502, String(data.message ?? data.error ?? 'job failed'));
      }
    }
    if (done) break;
  }
  if (!text) throw new C0mputeApiError(502, 'the stream ended without an answer');
  return { text, ...(model ? { model } : {}) };
}
