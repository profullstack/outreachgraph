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
import { isConsumerMailDomain } from '@outreachgraph/domain';

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
  'recruitment',
  'recruiter',
  'hiring',
  'talent',
  'press',
  'media',
  'pr',
  'newsroom',
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

/**
 * A mailbox a server could deliver to. Job-board text yields fragments:
 * `jobs+hn@dat.com` split at the plus came back as `+hn@dat.com` and was
 * mailed three times (2026-10-27).
 */
export function isWellFormed(address: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9_-])?@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(
    address.trim(),
  );
}

/** True when the mailbox is a desk that files rather than reads. */
export function isNonBuyerDesk(address: string): boolean {
  const local = localPart(address);
  return (
    NON_BUYER_DESKS.has(local) || local.startsWith('noreply') || local.startsWith('donotreply')
  );
}

/**
 * Hosts that many unrelated people publish under. An offering whose URL is a
 * GitHub repo or a bare `vercel.app` names a place, not a company, and taking
 * the host as "ours" would refuse every developer on GitHub. A subdomain of
 * one (`acme.vercel.app`) is specific and stays.
 */
const SHARED_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'workers.dev',
  'herokuapp.com',
  'railway.app',
  'fly.dev',
  'onrender.com',
  'github.io',
  'substack.com',
  'medium.com',
  'notion.site',
  'linkedin.com',
  'x.com',
  'twitter.com',
]);

/** RFC 2606 names, which belong to nobody — fixtures and demo accounts use them. */
const RESERVED = /(^|\.)example\.(com|net|org)$|\.(test|example|invalid|localhost)$/;

function isOwnable(host: string): boolean {
  return (
    host.includes('.') &&
    !SHARED_HOSTS.has(host) &&
    !RESERVED.test(host) &&
    !isConsumerMailDomain(host)
  );
}

/**
 * Every domain this workspace's organization sells or sends from, lower-cased,
 * without `www.`.
 *
 * The organization, not the workspace: a teammate's workspace that sells one
 * product is still part of a company that owns fifty, and in production
 * (2026-10-12) it knew only its own one. Beyond the offerings, the domains the
 * organization's people and mailboxes use are ours too — `profullstack.com`
 * is not an offering anywhere, and is where every message is sent from.
 */
export async function ownDomains(db: Client, workspaceId: string): Promise<Set<string>> {
  const offerings = await queryAll<{ url: string }>(
    db,
    `SELECT o.url FROM offerings o
      WHERE o.url IS NOT NULL
        AND o.workspace_id IN (
          SELECT w.id FROM workspaces w
           WHERE w.organization_id = (SELECT organization_id FROM workspaces WHERE id = ?))`,
    [workspaceId],
  );

  const addresses = await queryAll<{ address: string | null }>(
    db,
    `SELECT u.email AS address FROM users u
       JOIN organization_members m ON m.user_id = u.id
      WHERE m.organization_id = (SELECT organization_id FROM workspaces WHERE id = ?)
     UNION ALL
     SELECT handle AS address FROM integration_accounts
      WHERE workspace_id = ? AND network = 'email'`,
    [workspaceId, workspaceId],
  );

  const hosts = [
    ...offerings.map((row) => hostOf(row.url)),
    ...addresses.filter((row) => row.address?.includes('@')).map((row) => domainOf(row.address!)),
  ];
  return new Set(hosts.filter(isOwnable));
}

/**
 * Whether a person belongs to one of these domains: their company's domain or
 * published inbox, or any address we hold for them.
 *
 * Asked before a card is made, so our own products never reach the approval
 * queue on any network — the send-time check only ever covered email, and a
 * card nobody may approve is clutter a reviewer has to dismiss by hand.
 */
export async function personOnOwnDomain(
  db: Client,
  workspaceId: string,
  personId: string,
  own: ReadonlySet<string>,
): Promise<boolean> {
  if (own.size === 0) return false;

  const rows = await queryAll<{ value: string | null }>(
    db,
    `SELECT co.domain AS value FROM people p JOIN companies co ON co.id = p.current_company_id
      WHERE p.id = ?
     UNION ALL
     SELECT co.contact_email FROM people p JOIN companies co ON co.id = p.current_company_id
      WHERE p.id = ?
     UNION ALL
     SELECT handle FROM social_identities WHERE person_id = ? AND network = 'email'
     UNION ALL
     SELECT address FROM person_emails WHERE person_id = ? AND workspace_id = ?`,
    [personId, personId, personId, personId, workspaceId],
  );

  return rows.some((row) => {
    if (!row.value) return false;
    const domain = row.value.includes('@') ? domainOf(row.value) : hostOf(row.value);
    return onDomain(domain, own);
  });
}

function onDomain(domain: string, own: ReadonlySet<string>): boolean {
  for (const host of own) {
    if (domain === host || domain.endsWith(`.${host}`)) return true;
  }
  return false;
}

/**
 * Why this address must not receive cold outreach, or undefined when it may.
 *
 * `own` is passed in by callers that check many addresses in one pass, so the
 * offerings are read once per tick rather than once per card.
 */
export function refuseRecipient(address: string, own: ReadonlySet<string>): string | undefined {
  if (!isWellFormed(address)) {
    return `${address} is not a usable address`;
  }
  if (onDomain(domainOf(address), own)) {
    return `${address} belongs to one of this workspace's own products`;
  }
  if (isNonBuyerDesk(address)) {
    return `${address} is a ${localPart(address)} desk, not a buyer`;
  }
  return undefined;
}
