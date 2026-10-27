import { queryOne, type Client } from '@outreachgraph/db';

export interface AddressUsage {
  readonly thisWeek: number;
  readonly hoursSinceLast?: number;
}

/**
 * The same two limits, counted against the mailbox rather than the person.
 *
 * Read from `interactions.contact_address` — the address a message actually
 * reached — rather than from `actions`, which records who it was addressed to.
 * For a shared inbox those are different questions, and only the first one can
 * see fourteen colleagues arriving at one `support@`.
 *
 * Counting outbound interactions also means a message sent by hand from the
 * approval queue counts against the automated path, and vice versa. A mailbox
 * does not care which half of the product wrote to it.
 */
export async function addressCounts(
  db: Client,
  workspaceId: string,
  address: string,
  at: Date,
): Promise<AddressUsage> {
  const weekAgo = new Date(at.getTime() - 7 * 24 * 3_600_000).toISOString();

  const row = await queryOne<{ n: number; last_at: string | null }>(
    db,
    `SELECT COUNT(*) AS n,
            (SELECT MAX(occurred_at) FROM interactions
              WHERE workspace_id = ? AND contact_address = ? AND direction = 'outbound') AS last_at
       FROM interactions
      WHERE workspace_id = ? AND contact_address = ? AND direction = 'outbound'
        AND occurred_at >= ?`,
    [workspaceId, address, workspaceId, address, weekAgo],
  );

  const thisWeek = row?.n ?? 0;
  if (!row?.last_at) return { thisWeek };

  const stamp = Date.parse(row.last_at);
  if (Number.isNaN(stamp)) return { thisWeek };

  return { thisWeek, hoursSinceLast: (at.getTime() - stamp) / 3_600_000 };
}
