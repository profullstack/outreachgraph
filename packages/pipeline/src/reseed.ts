/**
 * Reading a campaign's seed again.
 *
 * A campaign is seeded once, at creation: the URL is crawled, or the keyword
 * is expanded into companies and those are crawled. Nothing ever returns to
 * the seed. So a directory that gains members, a team page that hires, a
 * market that a second discovery run would name differently — none of it
 * reaches the product, and once the initial crop of research cards has been
 * cleared the intake has nothing left to run on. The digest reported "sites
 * read 0, new people 0" for ten consecutive days while six campaigns sat
 * active. Nothing was broken; nothing was being asked.
 *
 * This asks again, on a slow clock, for campaigns that are active and idle.
 * Idle means no job of theirs is pending or running, so a campaign still
 * working through its first crop is left alone. The crawl dedupe key is
 * partial — it only blocks a duplicate while the earlier job is outstanding —
 * so the same seed queues cleanly, and the pipeline already recognises a
 * person it has read before, so a re-read finds only what is new.
 */

import { now, queryAll, type Client } from '@outreachgraph/db';
import { emitEvent } from './events';
import { enqueue } from './queue';

/** How long a campaign is left alone after its seed was last read. */
const DEFAULT_EVERY_DAYS = 7;

export interface ReseedResult {
  readonly considered: number;
  readonly queued: number;
}

interface IdleCampaign {
  readonly id: string;
  readonly name: string;
  readonly seed_kind: string;
  readonly seed_value: string;
}

export async function reseedIdleCampaigns(
  db: Client,
  input: { readonly workspaceId: string; readonly everyDays?: number; readonly now?: Date },
): Promise<ReseedResult> {
  const at = input.now ?? new Date();
  const days = input.everyDays ?? DEFAULT_EVERY_DAYS;
  const cutoff = new Date(at.getTime() - days * 86_400_000).toISOString();

  const idle = await queryAll<IdleCampaign>(
    db,
    `SELECT c.id, c.name, c.seed_kind, c.seed_value
       FROM campaigns c
      WHERE c.workspace_id = ?
        AND c.status IN ('active', 'running')
        AND c.seed_kind IN ('url', 'keyword')
        AND c.seed_value IS NOT NULL AND trim(c.seed_value) <> ''
        AND COALESCE(c.reseeded_at, c.started_at, c.created_at) < ?
        AND NOT EXISTS (
              SELECT 1 FROM jobs j
               WHERE j.workspace_id = c.workspace_id
                 AND j.status IN ('pending', 'running')
                 AND j.payload_json LIKE '%' || c.id || '%')
      ORDER BY COALESCE(c.reseeded_at, c.started_at, c.created_at) ASC`,
    [input.workspaceId, cutoff],
  );

  let queued = 0;

  for (const campaign of idle) {
    const seed = campaign.seed_value.trim();

    const result =
      campaign.seed_kind === 'url'
        ? await enqueue(db, {
            workspaceId: input.workspaceId,
            kind: 'crawl_site',
            payload: {
              url: /^https?:\/\//i.test(seed) ? seed : `https://${seed}`,
              campaignId: campaign.id,
            },
            dedupeKey: `crawl:${campaign.id}:${seed.replace(/^https?:\/\//i, '')}`,
          })
        : await enqueue(db, {
            workspaceId: input.workspaceId,
            kind: 'discover_domains',
            payload: { keyword: seed, campaignId: campaign.id },
            dedupeKey: `discover:${campaign.id}`,
          });

    // Stamped whether or not a job was queued: a dedupe hit means the work is
    // already outstanding, and asking again next tick would not change that.
    await db.execute({
      sql: 'UPDATE campaigns SET reseeded_at = ?, updated_at = ? WHERE id = ?',
      args: [now(), now(), campaign.id],
    });

    if (!result.queued) continue;
    queued += 1;

    await emitEvent(db, {
      workspaceId: input.workspaceId,
      campaignId: campaign.id,
      phase: 'intake',
      message:
        campaign.seed_kind === 'url'
          ? `Reading ${seed} again for anyone new`
          : `Looking again for companies matching “${seed}”`,
      detail: { seedKind: campaign.seed_kind, seed, everyDays: days },
    });
  }

  return { considered: idle.length, queued };
}
