/**
 * Putting one webhook on the wire.
 *
 * The only function in the product that POSTs to a URL a customer typed, so
 * it carries every rule that makes doing so safe, in one place:
 *
 *   - The URL is checked against `assertPublicUrl` on every attempt, not once
 *     at creation. DNS changes, and an endpoint that resolved publicly last
 *     month can resolve to `10.0.0.1` today.
 *   - Redirects are not followed. A public endpoint answering 302 to
 *     `http://169.254.169.254/` would otherwise walk straight past the check
 *     above, and a webhook receiver has no business redirecting anyway.
 *   - Ten seconds, then abort. The worker drains its queue serially, so one
 *     receiver that accepts the connection and never answers would otherwise
 *     hold up every crawl and send behind it.
 *   - The response body is read only to a short excerpt, for the delivery log.
 *     It is the receiver's text, not ours, and never needs to be larger than
 *     the error a person would want to see.
 *
 * This returns an outcome rather than throwing on a bad status: whether a 500
 * is retried is the queue's decision, and it needs the status to make it.
 */

import type { FetchLike } from '../site/fetch';
import { assertPublicUrl, UnsafeUrlError, type PublicUrlOptions } from '../net/public-url';

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_USER_AGENT = 'OutreachGraph-Webhooks/1 (+https://outreachgraph.com)';
const EXCERPT_BYTES = 500;

export interface PostWebhookInput extends PublicUrlOptions {
  readonly url: string;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export type PostWebhookOutcome =
  | { readonly ok: true; readonly status: number; readonly excerpt: string }
  | {
      readonly ok: false;
      /** Absent when no response arrived: refused, timed out, or never sent. */
      readonly status?: number;
      readonly error: string;
      /** False when retrying cannot help: the URL itself is not allowed. */
      readonly retryable: boolean;
    };

export async function postWebhook(input: PostWebhookInput): Promise<PostWebhookOutcome> {
  try {
    await assertPublicUrl(input.url, input);
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      return { ok: false, error: `refused: ${error.message}`, retryable: false };
    }
    throw error;
  }

  const fetchImpl = input.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(input.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'user-agent': WEBHOOK_USER_AGENT,
        ...input.headers,
      },
      body: input.body,
      signal: AbortSignal.timeout(input.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      ok: false,
      error: timedOut
        ? `no answer within ${(input.timeoutMs ?? WEBHOOK_TIMEOUT_MS) / 1000}s`
        : `could not connect: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    };
  }

  const excerpt = await readExcerpt(response);

  if (response.status >= 200 && response.status < 300) {
    return { ok: true, status: response.status, excerpt };
  }

  if (response.status >= 300 && response.status < 400) {
    return {
      ok: false,
      status: response.status,
      error: 'the endpoint redirected; webhooks do not follow redirects',
      retryable: true,
    };
  }

  return {
    ok: false,
    status: response.status,
    error: `HTTP ${response.status}${excerpt ? `: ${excerpt}` : ''}`,
    retryable: true,
  };
}

async function readExcerpt(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, EXCERPT_BYTES).trim();
  } catch {
    return '';
  }
}
