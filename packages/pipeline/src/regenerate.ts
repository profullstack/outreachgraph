/**
 * The `regenerate_recommendations` job: re-decide people whose evidence moved.
 *
 * A recommendation is decided once, at the moment a person is processed, and
 * never revisited. That is fine while evidence only ever arrives with the
 * person — but it stops being fine the moment evidence can appear afterwards,
 * and it now can: migration 0015 wrote a signal for 75 people who had been
 * crawled without one.
 *
 * Those people were left holding a `refresh_research` card decided under the
 * old facts. Re-crawling does not fix it, which is the part that is easy to
 * get wrong: `runCrawlJob` only runs the chain for people it finds *on the
 * page this time*, so anyone whose name has since moved, or who was read off
 * a page the crawl no longer reaches, keeps the stale card forever. A smoke
 * test against three real sites confirmed it — two of the three companies
 * re-crawled cleanly and their original stalled people still had research
 * cards afterwards.
 *
 * So this closes the loop from the other end: take the people whose stored
 * evidence no longer matches the card they are holding, and ask the engine
 * again. It reads no network and calls no model. Everything it needs is
 * already in the database.
 */

import { queryAll, type Client } from '@outreachgraph/db';
import { regenerateFor, type PipelineOptions } from './pipeline';

export interface RegenerateInput {
  readonly db: Client;
  readonly workspaceId: string;
  readonly campaignId: string;
  /** Ceiling per run, so one job cannot walk an entire workspace. */
  readonly limit?: number;
  readonly providers?: PipelineOptions['providers'];
  readonly model?: PipelineOptions['model'];
  readonly emailSendingEnabled?: boolean;
}

export interface RegenerateResult {
  readonly considered: number;
  readonly replaced: number;
  readonly unchanged: number;
}

/** Default ceiling. High enough to clear the known backlog in one pass. */
const DEFAULT_LIMIT = 200;

/**
 * Re-runs the recommendation step for people holding a stale internal card.
 *
 * The selection is deliberately narrow. Only people who
 *
 *   - have at least one signal that has not expired, and
 *   - are holding a *pending internal* card — research, observe, wait,
 *
 * are considered. An outbound card is never touched: it may already carry a
 * drafted message and a half-made human decision, and re-deciding it behind
 * the reviewer's back would discard real work. A person with no card at all is
 * also left alone — they were excluded for a reason the engine will reach
 * again on its own, and manufacturing cards for them is a different job than
 * repairing ones that are demonstrably out of date.
 *
 * Suppressed and deleted people are excluded by the join, not by a later
 * check, so there is no window where one is processed.
 */
export async function regenerateRecommendations(input: RegenerateInput): Promise<RegenerateResult> {
  const { db, workspaceId, campaignId } = input;

  const rows = await queryAll<{ person_id: string }>(
    db,
    `SELECT DISTINCT r.person_id
       FROM recommendations r
       JOIN people p ON p.id = r.person_id
      WHERE r.workspace_id = ?
        AND r.campaign_id = ?
        AND r.status = 'pending'
        AND r.action IN ('refresh_research', 'observe', 'wait')
        AND p.status = 'active'
        AND p.outreach_eligible = 1
        AND EXISTS (
              SELECT 1 FROM signals s
               WHERE s.person_id = p.id
                 AND s.workspace_id = r.workspace_id
                 AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))
            )
      LIMIT ?`,
    [workspaceId, campaignId, input.limit ?? DEFAULT_LIMIT],
  );

  let replaced = 0;

  for (const row of rows) {
    // `regenerateFor` supersedes the stale card as part of writing the new
    // one, so a person either ends with exactly one pending card or keeps the
    // one they had. Returning undefined means the engine still has no
    // permitted action, which is a legitimate answer and not a failure.
    const created = await regenerateFor(
      {
        db,
        workspaceId,
        campaignId,
        providers: input.providers ?? [],
        ...(input.model ? { model: input.model } : {}),
        ...(input.emailSendingEnabled === undefined
          ? {}
          : { emailSendingEnabled: input.emailSendingEnabled }),
      },
      row.person_id,
    );

    if (created) replaced += 1;
  }

  return {
    considered: rows.length,
    replaced,
    unchanged: rows.length - replaced,
  };
}
