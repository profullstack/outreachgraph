/**
 * The CRM boundary: two operations, whatever the vendor.
 *
 * Everything the product wants from a CRM is "make sure this person exists"
 * and "write down what just happened to them". Keeping the interface that
 * small is what lets HubSpot and Pipedrive sit behind one sync job, and what
 * makes the third CRM an adapter rather than a new code path.
 *
 * Create-if-missing, never overwrite. A contact that already exists in the
 * customer's CRM has been edited by their sales team, and a prospecting tool
 * silently replacing a hand-corrected job title with whatever it scraped is
 * the fastest way to be uninstalled. So `ensureContact` finds by email and
 * only writes fields on a contact it created itself.
 */

import type { FetchLike } from '../site/fetch';

export interface CrmContactInput {
  /** The match key. A contact without one is not pushed at all. */
  readonly email: string;
  readonly name: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly title?: string;
  readonly company?: string;
  readonly website?: string;
}

export interface CrmContactRef {
  readonly id: string;
  /** False when a contact with this email already existed. */
  readonly created: boolean;
}

export interface CrmClient {
  /** Proves the credential works. Called before storing it. */
  verify(): Promise<void>;
  ensureContact(input: CrmContactInput): Promise<CrmContactRef>;
  addNote(contactId: string, body: string, at?: Date): Promise<{ id: string }>;
}

export interface CrmClientOptions {
  readonly token: string;
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
}

/**
 * A CRM said no.
 *
 * `retryable` is the only distinction the sync job acts on. A 429 or a 5xx is
 * the vendor having a bad minute and is retried with backoff; a 401 is a
 * revoked token, and retrying it five times only fills the log.
 */
export class CrmError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, status: number | undefined, retryable: boolean) {
    super(message);
    this.name = 'CrmError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** Shared by both adapters: one request, JSON in and out, errors classified. */
export async function crmRequest<T>(
  fetchImpl: FetchLike,
  vendor: string,
  url: string,
  init: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new CrmError(
      `${vendor} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      true,
    );
  }

  const text = await response.text().catch(() => '');

  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    const reason =
      response.status === 401 || response.status === 403
        ? 'the token was refused'
        : text.slice(0, 300) || `HTTP ${response.status}`;
    throw new CrmError(`${vendor}: ${reason}`, response.status, retryable);
  }

  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CrmError(`${vendor} answered with something that is not JSON`, response.status, true);
  }
}
