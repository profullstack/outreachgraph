/**
 * Choosing the reader for one watch.
 *
 * Kept apart from `audience.ts` so the watcher's logic — idempotence,
 * refusals, signals — is testable with a fake reader and no credentials, and
 * so the API and the worker build readers the same way rather than each
 * growing its own idea of what a connected X account is.
 *
 * Three answers, and two of them are "no":
 *
 * - Bluesky needs nothing. The AppView is public, so a watch works the moment
 *   somebody types a handle.
 * - X needs the workspace's own OAuth grant. A cookie session can post, like
 *   and follow, but the audience reads here go through the v2 API, so a
 *   session-only connection is not a reader.
 * - LinkedIn has none. Reading reactions would mean driving the member's
 *   session for something `--accept-linkedin-risk` never covered, and the
 *   rule is that anything new on LinkedIn goes through that gate or stays a
 *   hand-off. It stays a hand-off.
 */

import type { Client } from '@outreachgraph/db';
import {
  BlueskyAudienceReader,
  XAudienceReader,
  type AudienceReader,
  type FetchLike,
} from '@outreachgraph/providers';
import { xCredentialsForWorkspace, type XCredentialDeps } from './x-account';
import type { AudienceWatch } from './audience';

export interface AudienceReaderDeps extends XCredentialDeps {
  /** Test seam for the Bluesky AppView, which needs no credentials. */
  readonly blueskyFetch?: FetchLike | undefined;
}

export async function audienceReaderFor(
  db: Client,
  watch: AudienceWatch,
  deps: AudienceReaderDeps = {},
): Promise<AudienceReader | undefined> {
  if (watch.network === 'bluesky') {
    return new BlueskyAudienceReader(deps.blueskyFetch ? { fetchImpl: deps.blueskyFetch } : {});
  }

  if (watch.network === 'x') {
    const credentials = await xCredentialsForWorkspace(db, watch.workspaceId, deps);
    // A cookie session posts; it does not answer /2/users/:id/followers.
    if (credentials?.kind !== 'bearer') return undefined;

    return new XAudienceReader(credentials.accessToken, {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      grantedScopes: credentials.scopes,
    });
  }

  return undefined;
}
