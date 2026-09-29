/**
 * Addresses a cold message must never go to.
 *
 * Two kinds, both found in production (2026-09-28): of 283 emails in a
 * fortnight, 209 went to role mailboxes and six went to the workspace's own
 * products. Neither ever produced a reply.
 *
 * - **A desk that does not buy.** `support@`, `abuse@`, `security@` and the
 *   rest open a ticket, send an acknowledgement and close it as "won't do".
 *   Worse than wasted: an abuse or security desk that files a sales email is
 *   a complaint against the sending domain. `hello@`, `info@`, `sales@` and
 *   `contact@` stay allowed — at a small company they are how you reach the
 *   founder.
 * - **The workspace itself.** A workspace that sells fifty products is, to
 *   discovery, fifty companies in its own market. Its own domains are not
 *   prospects.
 *
 * Deterministic, and applied to cold outreach only: answering someone who
 * wrote to us is always allowed, whatever address they wrote from.
 */

import { queryAll, type Client } from '@outreachgraph/db';

const NON_BUYER_DESKS = new Set([
  'support',
  'help',
  'helpdesk',
  'servicedesk',
  'customerservice',
  'customersupport',
  'care',
  'abuse',
  'security',
  'noc',
  'postmaster',
  'hostmaster',
  'webmaster',
  'billing',
  'accounts',
  'invoices',
  'privacy',
  'legal',
  'dpo',
  'gdpr',
  'compliance',
  'careers',
  'jobs',
  'hr',
  'recruiting',
  'noreply',
  'donotreply',
  'mailer-daemon',
  'bounce',
  'bounces',
]);

function localPart(address: string): string {
  const local = address.trim().toLowerCase().split('@')[0] ?? '';
  // `support+eu` and `support.team` are still the support desk.
  return local.split('+')[0]!.replace(/[._-]/g, '');
}

function domainOf(address: string): string {
  return address.trim().toLowerCase().split('@').pop() ?? '';
}

function hostOf(url: string): string {
  return url
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#:]/)[0]!;
}

/** True when the mailbox is a desk that files rather than reads. */
export function isNonBuyerDesk(address: string): boolean {
  const local = localPart(address);
  return (
    NON_BUYER_DESKS.has(local) || local.startsWith('noreply') || local.startsWith('donotreply')
  );
}

/** Every domain this workspace sells from, lower-cased, without `www.`. */
export async function ownDomains(db: Client, workspaceId: string): Promise<Set<string>> {
  const rows = await queryAll<{ url: string }>(
    db,
    'SELECT url FROM offerings WHERE workspace_id = ? AND url IS NOT NULL',
    [workspaceId],
  );
  return new Set(rows.map((row) => hostOf(row.url)).filter((host) => host.includes('.')));
}

/**
 * Why this address must not receive cold outreach, or undefined when it may.
 *
 * `own` is passed in by callers that check many addresses in one pass, so the
 * offerings are read once per tick rather than once per card.
 */
export function refuseRecipient(address: string, own: ReadonlySet<string>): string | undefined {
  const domain = domainOf(address);
  for (const host of own) {
    if (domain === host || domain.endsWith(`.${host}`)) {
      return `${address} belongs to one of this workspace's own products`;
    }
  }
  if (isNonBuyerDesk(address)) {
    return `${address} is a ${localPart(address)} desk, not a buyer`;
  }
  return undefined;
}
