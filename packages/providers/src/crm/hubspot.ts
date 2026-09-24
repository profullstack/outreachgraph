/**
 * HubSpot, through a private app token.
 *
 * A private app rather than OAuth because a private app is what a HubSpot
 * admin can create in two minutes without us registering a public app and
 * passing HubSpot's marketplace review. The token needs the
 * `crm.objects.contacts.read` and `crm.objects.contacts.write` scopes; notes
 * are written through the contacts scope.
 *
 * Find-then-create rather than the batch upsert endpoint, because upsert
 * overwrites every property it is given — see `types.ts` for why we never do
 * that to a contact a salesperson has already touched.
 */

import type { FetchLike } from '../site/fetch';
import {
  crmRequest,
  type CrmClient,
  type CrmClientOptions,
  type CrmContactInput,
  type CrmContactRef,
} from './types';

export const HUBSPOT_API = 'https://api.hubapi.com';

/** HubSpot's built-in association type for note → contact. */
const NOTE_TO_CONTACT = 202;

interface SearchResponse {
  readonly total?: number;
  readonly results?: readonly { readonly id: string }[];
}

export class HubSpotClient implements CrmClient {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly base: string;

  constructor(options: CrmClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.base = (options.baseUrl ?? HUBSPOT_API).replace(/\/$/, '');
  }

  private call<T>(path: string, init: RequestInit = {}): Promise<T> {
    return crmRequest<T>(this.fetchImpl, 'HubSpot', `${this.base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
    });
  }

  async verify(): Promise<void> {
    await this.call('/crm/v3/objects/contacts?limit=1&properties=email');
  }

  async ensureContact(input: CrmContactInput): Promise<CrmContactRef> {
    const email = input.email.trim().toLowerCase();

    const found = await this.call<SearchResponse>('/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: ['email'],
        limit: 1,
      }),
    });

    const existing = found.results?.[0];
    if (existing) return { id: existing.id, created: false };

    const properties: Record<string, string> = { email };
    if (input.firstName) properties.firstname = input.firstName;
    if (input.lastName) properties.lastname = input.lastName;
    if (!input.firstName && !input.lastName) properties.firstname = input.name;
    if (input.title) properties.jobtitle = input.title;
    if (input.company) properties.company = input.company;
    if (input.website) properties.website = input.website;

    const created = await this.call<{ id: string }>('/crm/v3/objects/contacts', {
      method: 'POST',
      body: JSON.stringify({ properties }),
    });

    return { id: created.id, created: true };
  }

  async addNote(contactId: string, body: string, at: Date = new Date()): Promise<{ id: string }> {
    const note = await this.call<{ id: string }>('/crm/v3/objects/notes', {
      method: 'POST',
      body: JSON.stringify({
        properties: { hs_timestamp: at.toISOString(), hs_note_body: body },
        associations: [
          {
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }],
          },
        ],
      }),
    });

    return { id: note.id };
  }
}
