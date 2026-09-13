/**
 * OpenAccess (openaccess.logicsrc.com): OAuth 2.1 with a grant you can carry.
 *
 * The descriptor at /.well-known/openaccess.json names the scopes this site
 * honours. An access token the hub minted for `outreachgraph.com` is verified
 * here against the hub's published keys, and its claims decide what the
 * caller may do. Today that is one thing: a person correcting the
 * OpenProfile.md this deployment holds about them (`openprofile:edit`),
 * without a session here, because the profile is theirs before it is ours.
 */

import { OpenAccessApp } from '@logicsrc/openaccess/client';
import type { BearerClaims } from './openprofile';

export const HUB = 'https://openaccess.logicsrc.com';
export const CLIENT_ID = 'outreachgraph.com';

let app: OpenAccessApp | undefined;

function hub(): OpenAccessApp {
  app ??= new OpenAccessApp({
    hub: HUB,
    clientId: CLIENT_ID,
    redirectUri: `https://${CLIENT_ID}/api/v1/openaccess/callback`,
  });
  return app;
}

/** The claims behind an OpenAccess bearer, or undefined for a token that is not one. */
export async function verifyOpenAccessBearer(token: string): Promise<BearerClaims | undefined> {
  try {
    const claims = await hub().verify(token);
    return typeof claims.sub === 'string' && claims.sub ? (claims as BearerClaims) : undefined;
  } catch {
    return undefined;
  }
}
