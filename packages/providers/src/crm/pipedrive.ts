/**
 * Pipedrive, through a personal API token.
 *
 * The token goes in the `x-api-token` header rather than the `api_token`
 * query parameter Pipedrive's older docs show. A token in a URL ends up in
 * every proxy log and error message between here and Pipedrive; a header does
 * not.
 *
 * `api.pipedrive.com` routes to the right company from the token, so the
 * customer does not have to tell us their company subdomain.
 */

import type { FetchLike } from '../site/fetch';
import {
  crmRequest,
  type CrmClient,
  type CrmClientOptions,
  type CrmContactInput,
  type CrmContactRef,
} from './types';

export const PIPEDRIVE_API = 'https://api.pipedrive.com';

interface Envelope<T> {
  readonly success?: boolean;
  readonly data?: T;
}

interface PersonSearch {
  readonly items?: readonly { readonly item?: { readonly id?: number } }[];
}

export class PipedriveClient implements CrmClient {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly base: string;

  constructor(options: CrmClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.base = (options.baseUrl ?? PIPEDRIVE_API).replace(/\/$/, '');
  }

  private call<T>(path: string, init: RequestInit = {}): Promise<Envelope<T>> {
    return crmRequest<Envelope<T>>(this.fetchImpl, 'Pipedrive', `${this.base}${path}`, {
      ...init,
      headers: {
        'x-api-token': this.token,
        'content-type': 'application/json',
        accept: 'application/json',
      },
    });
  }

  async verify(): Promise<void> {
    await this.call('/v1/users/me');
  }

  async ensureContact(input: CrmContactInput): Promise<CrmContactRef> {
    const email = input.email.trim().toLowerCase();
    const query = new URLSearchParams({
      term: email,
      fields: 'email',
      exact_match: 'true',
      limit: '1',
    });

    const found = await this.call<PersonSearch>(`/v1/persons/search?${query}`);
    const existing = found.data?.items?.[0]?.item?.id;
    if (existing !== undefined) return { id: String(existing), created: false };

    // Pipedrive has no job-title field on a person by default, and the
    // organisation is a separate record we would have to find or create.
    // Both go into the first note instead of guessing at custom fields.
    const created = await this.call<{ id: number }>('/v1/persons', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        email: [{ value: email, primary: true, label: 'work' }],
      }),
    });

    if (created.data?.id === undefined) {
      throw new Error('Pipedrive created a person and returned no id');
    }
    return { id: String(created.data.id), created: true };
  }

  async addNote(contactId: string, body: string): Promise<{ id: string }> {
    const note = await this.call<{ id: number }>('/v1/notes', {
      method: 'POST',
      body: JSON.stringify({ content: body, person_id: Number(contactId) }),
    });
    return { id: String(note.data?.id ?? '') };
  }
}
