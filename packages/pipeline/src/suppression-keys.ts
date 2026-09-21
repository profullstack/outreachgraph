/**
 * Every spelling under which a person can be suppressed.
 *
 * Suppression started as `person:<id>` plus `platform:<network>:<id>`, which
 * is exact and survives deletion but cannot express "never write to anyone at
 * this company" or "this address, whoever it turns out to belong to". Named
 * suppress lists add `email:<address>` and `domain:<host>`, and this is the
 * one function that knows all four — the pipeline, the cadence runner and the
 * API each used to build the list themselves, and a fifth spelling added in
 * one of them would have been a hole in the other two.
 */

import { queryAll, queryOne, type Client } from '@outreachgraph/db';

export function emailMatchKey(address: string): string {
  return `email:${address.trim().toLowerCase()}`;
}

export function domainMatchKey(domain: string): string {
  return `domain:${normaliseDomain(domain)}`;
}

/** `www.Example.com/` and `example.com` are one company. */
export function normaliseDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '');
}

export async function matchKeysForPerson(db: Client, personId: string): Promise<string[]> {
  const keys = new Set<string>([`person:${personId}`]);

  const identities = await queryAll<{
    network: string;
    handle: string | null;
    platform_user_id: string | null;
  }>(db, 'SELECT network, handle, platform_user_id FROM social_identities WHERE person_id = ?', [
    personId,
  ]);

  for (const identity of identities) {
    if (identity.platform_user_id) {
      keys.add(`platform:${identity.network}:${identity.platform_user_id}`);
    }
    if (identity.network === 'email' && identity.handle?.trim()) {
      keys.add(emailMatchKey(identity.handle));
    }
  }

  const imported = await queryAll<{ address: string }>(
    db,
    'SELECT address FROM person_emails WHERE person_id = ?',
    [personId],
  );
  for (const row of imported) {
    if (row.address?.trim()) keys.add(emailMatchKey(row.address));
  }

  const company = await queryOne<{ domain: string | null; contact_email: string | null }>(
    db,
    `SELECT co.domain, co.contact_email
       FROM people p JOIN companies co ON co.id = p.current_company_id
      WHERE p.id = ?`,
    [personId],
  );
  if (company?.domain?.trim()) keys.add(domainMatchKey(company.domain));
  // A shared inbox is still an address someone asked us not to write to.
  if (company?.contact_email?.trim()) keys.add(emailMatchKey(company.contact_email));

  return [...keys];
}

/**
 * People this workspace holds who match an email or domain key right now.
 *
 * Used when a list is created, so what is already queued for them stops
 * today rather than at the next policy check — and so `person:` keys can be
 * written alongside, which is what keeps them suppressed if the address or
 * company on their record later changes.
 */
export async function peopleMatchingKeys(
  db: Client,
  workspaceId: string,
  keys: readonly string[],
): Promise<string[]> {
  const emails = keys.filter((key) => key.startsWith('email:')).map((key) => key.slice(6));
  const domains = keys.filter((key) => key.startsWith('domain:')).map((key) => key.slice(7));
  const found = new Set<string>();

  if (emails.length > 0) {
    const placeholders = emails.map(() => '?').join(', ');
    const rows = await queryAll<{ id: string }>(
      db,
      `SELECT DISTINCT p.id
         FROM people p
         JOIN campaign_people cp ON cp.person_id = p.id AND cp.workspace_id = ?
        WHERE EXISTS (SELECT 1 FROM social_identities si
                       WHERE si.person_id = p.id AND si.network = 'email'
                         AND lower(trim(si.handle)) IN (${placeholders}))
           OR EXISTS (SELECT 1 FROM person_emails pe
                       WHERE pe.person_id = p.id AND lower(trim(pe.address)) IN (${placeholders}))`,
      [workspaceId, ...emails, ...emails],
    );
    for (const row of rows) found.add(row.id);
  }

  if (domains.length > 0) {
    const placeholders = domains.map(() => '?').join(', ');
    const rows = await queryAll<{ id: string }>(
      db,
      `SELECT DISTINCT p.id
         FROM people p
         JOIN companies co ON co.id = p.current_company_id
         JOIN campaign_people cp ON cp.person_id = p.id AND cp.workspace_id = ?
        WHERE lower(trim(co.domain)) IN (${placeholders})`,
      [workspaceId, ...domains],
    );
    for (const row of rows) found.add(row.id);
  }

  return [...found];
}
