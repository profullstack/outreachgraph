/**
 * Caching what a campaign's terms mean in the words people actually use.
 *
 * `expandTerm` asks a model; this decides how often it is worth asking. The
 * listening loop runs constantly over the same handful of terms, so expanding
 * on every pass would multiply model spend by the crawl frequency to answer a
 * question that changes about as often as the campaign does.
 *
 * Two properties matter more than the caching:
 *
 *   - **Without a model, this is the identity function.** The repository's
 *     standing rule is that the whole pipeline runs end to end on an empty
 *     `.env`. A missing key makes matching literal again; it never makes
 *     listening fail.
 *   - **A cached expansion never blocks a crawl.** If the model is slow or
 *     down, the terms already in the cache are used and the missing ones are
 *     simply not expanded this time.
 */

import { newId } from '@outreachgraph/domain';
import { expandTerm, mergeTerms, type TextModel } from '@outreachgraph/ai';
import { now, queryAll, type Client } from '@outreachgraph/db';

/**
 * How long an expansion is trusted.
 *
 * Thirty days, because this tracks how an industry talks rather than anything
 * about a specific prospect. Vocabulary moves when a competitor launches or a
 * category gets a new name, which is a monthly event at most.
 */
export const EXPANSION_TTL_DAYS = 30;

export interface ExpandTermsDeps {
  readonly db: Client;
  /** Absent means no expansion at all, which is literal matching. */
  readonly model?: TextModel | undefined;
  readonly now?: Date;
  /** Terms to expand in one pass, so a big campaign cannot stall a tick. */
  readonly limit?: number;
}

const DEFAULT_EXPAND_LIMIT = 10;

/**
 * Returns the terms a campaign should actually search for.
 *
 * The originals always come back, in order, whatever happens to the expansion.
 */
export async function expandCampaignTerms(
  deps: ExpandTermsDeps,
  workspaceId: string,
  terms: readonly string[],
): Promise<readonly string[]> {
  if (terms.length === 0) return terms;

  const cached = await loadExpansions(deps.db, workspaceId, terms);

  if (deps.model) {
    const at = deps.now ?? new Date();

    // A human-written expansion is never refreshed, and is never even asked
    // about. Skipping it here rather than only refusing the write is what makes
    // the returned terms agree with the stored ones — otherwise the model's
    // answer would win this call and the human's would win every later one.
    const stale = terms.filter((term) => {
      const entry = cached.get(key(term));
      if (entry?.source === 'manual') return false;
      return !isFresh(entry?.refreshedAt, at);
    });

    for (const term of stale.slice(0, deps.limit ?? DEFAULT_EXPAND_LIMIT)) {
      try {
        const result = await expandTerm(deps.model, term);
        await storeExpansion(deps.db, workspaceId, term, result.expansions);
        cached.set(key(term), {
          expansions: result.expansions,
          refreshedAt: at.toISOString(),
          source: 'model',
        });
      } catch {
        // A model that will not answer costs this term its expansion, not the
        // crawl. Whatever is already cached still applies.
      }
    }
  }

  const map = new Map<string, readonly string[]>();
  for (const [term, entry] of cached) map.set(term, entry.expansions);

  return mergeTerms(terms, map);
}

interface CachedExpansion {
  readonly expansions: readonly string[];
  readonly refreshedAt: string;
  /** 'manual' entries are authoritative and never regenerated. */
  readonly source: string;
}

function key(term: string): string {
  return term.trim().toLowerCase();
}

function isFresh(refreshedAt: string | undefined, at: Date): boolean {
  if (!refreshedAt) return false;
  const age = at.getTime() - new Date(refreshedAt).getTime();
  return age >= 0 && age < EXPANSION_TTL_DAYS * 86_400_000;
}

async function loadExpansions(
  db: Client,
  workspaceId: string,
  terms: readonly string[],
): Promise<Map<string, CachedExpansion>> {
  const keys = [...new Set(terms.map(key))];
  if (keys.length === 0) return new Map();

  const placeholders = keys.map(() => '?').join(', ');
  const rows = await queryAll<{
    term: string;
    expansions: string;
    refreshed_at: string;
    source: string;
  }>(
    db,
    `SELECT term, expansions, refreshed_at, source FROM term_expansions
      WHERE workspace_id = ? AND term IN (${placeholders})`,
    [workspaceId, ...keys],
  );

  const map = new Map<string, CachedExpansion>();
  for (const row of rows) {
    map.set(row.term, {
      expansions: parseList(row.expansions),
      refreshedAt: row.refreshed_at,
      source: row.source,
    });
  }

  return map;
}

async function storeExpansion(
  db: Client,
  workspaceId: string,
  term: string,
  expansions: readonly string[],
): Promise<void> {
  const stamp = now();

  await db.execute({
    sql: `INSERT INTO term_expansions (id, workspace_id, term, expansions, source,
          created_at, refreshed_at)
          VALUES (?, ?, ?, ?, 'model', ?, ?)
          ON CONFLICT(workspace_id, term) DO UPDATE SET
            expansions = excluded.expansions,
            refreshed_at = excluded.refreshed_at
          -- A human-written expansion is never overwritten by a model. Someone
          -- who typed the phrases their market uses knows it better than we do.
          WHERE term_expansions.source = 'model'`,
    args: [
      newId('termExpansion'),
      workspaceId,
      key(term),
      JSON.stringify(expansions),
      stamp,
      stamp,
    ],
  });
}

function parseList(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
