/**
 * Cards for the people a campaign kept who can now be emailed and hold none.
 *
 * A person gains an address in several ways — a posting published it, the
 * openprofile job read it, `find_email` confirmed it — and only some of them
 * ask the engine again. On 2026-10-26, 41 of the 47 people the Engineering
 * Contracts campaign kept with an address had no email card at all, so
 * autopilot had nothing to send them. This asks the engine again for each,
 * through `regenerateFor`: the same policy, the same card, nothing sent here.
 * A pending research card does not count as a card: it is what the engine
 * writes when it could not send, and `regenerateFor` supersedes it.
 */

import { queryAll, type Client } from '@outreachgraph/db';
import { regenerateFor } from './pipeline';

/** Re-decisions per call: each is a handful of queries, no model call. */
const DEFAULT_LIMIT = 300;

export async function cardReachableMembers(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly campaignId: string;
    readonly emailSendingEnabled?: boolean | undefined;
    readonly limit?: number;
  },
): Promise<{ checked: number; carded: number }> {
  const people = await queryAll<{ person_id: string }>(
    db,
    `SELECT cp.person_id FROM campaign_people cp JOIN people p ON p.id = cp.person_id
      WHERE cp.campaign_id = ? AND p.status = 'active' AND p.outreach_eligible = 1
        AND cp.status IN ('discovered', 'resolved', 'researching', 'qualified', 'recommended',
                          'awaiting_approval')
        AND (EXISTS (SELECT 1 FROM person_emails pe WHERE pe.person_id = p.id)
             OR EXISTS (SELECT 1 FROM social_identities si
                         WHERE si.person_id = p.id AND si.network = 'email'
                           AND si.handle IS NOT NULL AND trim(si.handle) <> ''))
        AND NOT EXISTS (SELECT 1 FROM recommendations r
                         WHERE r.campaign_id = cp.campaign_id AND r.person_id = cp.person_id
                           AND r.status IN ('pending', 'approved', 'executed')
                           AND r.action NOT IN ('refresh_research', 'observe', 'wait'))
      LIMIT ?`,
    [input.campaignId, input.limit ?? DEFAULT_LIMIT],
  );

  let carded = 0;
  for (const { person_id: personId } of people) {
    const id = await regenerateFor(
      {
        db,
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        providers: [],
        ...(input.emailSendingEnabled === undefined
          ? {}
          : { emailSendingEnabled: input.emailSendingEnabled }),
      },
      personId,
    );
    if (id) carded += 1;
  }
  return { checked: people.length, carded };
}
