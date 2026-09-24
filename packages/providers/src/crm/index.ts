import type { CrmProvider } from '@outreachgraph/domain';
import { HubSpotClient } from './hubspot';
import { PipedriveClient } from './pipedrive';
import type { CrmClient, CrmClientOptions } from './types';

export { HubSpotClient, HUBSPOT_API } from './hubspot';
export { PipedriveClient, PIPEDRIVE_API } from './pipedrive';
export {
  CrmError,
  type CrmClient,
  type CrmClientOptions,
  type CrmContactInput,
  type CrmContactRef,
} from './types';

/** The adapter for a provider name. Callers never name a vendor class. */
export function crmClientFor(provider: CrmProvider, options: CrmClientOptions): CrmClient {
  switch (provider) {
    case 'hubspot':
      return new HubSpotClient(options);
    case 'pipedrive':
      return new PipedriveClient(options);
  }
}
