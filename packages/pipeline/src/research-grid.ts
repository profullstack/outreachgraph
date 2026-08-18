/**
 * N questions across M prospects, answered into a table.
 *
 * The product could research one person in response to one trigger. It could
 * not answer "for these two hundred leads, which competitor are they on"
 * without opening two hundred cards, and that is the question a human has when
 * deciding where to spend a week.
 *
 * Built as a batch rather than a chat box, deliberately. A grid's cost is
 * knowable before it runs — questions times people, one model call each — and
 * its progress is a fraction rather than a spinner. Model spend is this
 * product's real COGS, so a research surface that cannot be costed in advance
 * is one that cannot be sold at a fixed price.
 *
 * Cells are answered one at a time and committed as they land. A grid that
 * fails halfway keeps the answers it already has, because re-running two
 * hundred cells to recover from one timeout is how a feature becomes too
 * expensive to use.
 */

import { newId } from '@outreachgraph/domain';
import {
  answerGridCell,
  type GridEvidence,
  type GridQuestion,
  type TextModel,
} from '@outreachgraph/ai';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';

/** How much evidence one cell may reason over. */
const EVIDENCE_PER_CELL = 12;

export interface CreateGridInput {
  readonly workspaceId: string;
  readonly campaignId?: string | undefined;
  readonly name: string;
  readonly questions: readonly string[];
  readonly personIds: readonly string[];
}

export type CreateGridResult =
  | {
      readonly created: true;
      readonly gridId: string;
      readonly questions: readonly GridQuestion[];
      readonly cells: number;
    }
  | { readonly created: false; readonly reason: string };

/** How many cells one grid may contain. */
export const MAX_GRID_CELLS = 2000;

/**
 * Lays out a grid and every cell it will fill.
 *
 * Cells are written up front rather than as work is done, so the total is a
 * fact about the grid rather than a guess, and a resumed run knows exactly
 * what is left without recomputing the cross product.
 */
export async function createResearchGrid(
  db: Client,
  input: CreateGridInput,
): Promise<CreateGridResult> {
  const name = input.name.trim();
  if (!name) return { created: false, reason: 'a grid needs a name' };

  const questions: GridQuestion[] = input.questions
    .map((prompt) => prompt.trim())
    .filter((prompt) => prompt.length > 0)
    .map((prompt) => ({ id: newId('gridQuestion'), prompt }));

  if (questions.length === 0)
    return { created: false, reason: 'a grid needs at least one question' };

  // Only people this workspace can see. A grid is a bulk read, which makes it
  // the most attractive place in the API to try to enumerate somebody else's
  // prospects — so the person list is filtered here rather than trusted.
  const people = await visiblePeople(db, input.workspaceId, input.personIds);
  if (people.length === 0)
    return { created: false, reason: 'none of those people are in this workspace' };

  const total = questions.length * people.length;
  if (total > MAX_GRID_CELLS) {
    return {
      created: false,
      reason: `that grid is ${total} cells; the limit is ${MAX_GRID_CELLS}`,
    };
  }

  const gridId = newId('researchGrid');
  const stamp = now();

  await db.execute({
    sql: `INSERT INTO research_grids (id, workspace_id, campaign_id, name, questions_json,
          status, cells_total, cells_done, created_at)
          VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?)`,
    args: [
      gridId,
      input.workspaceId,
      input.campaignId ?? null,
      name,
      JSON.stringify(questions),
      total,
      stamp,
    ],
  });

  for (const personId of people) {
    for (const question of questions) {
      await db.execute({
        sql: `INSERT INTO research_grid_cells (id, grid_id, workspace_id, person_id,
              question_id, status)
              VALUES (?, ?, ?, ?, ?, 'unanswered')`,
        args: [newId('gridCell'), gridId, input.workspaceId, personId, question.id],
      });
    }
  }

  return { created: true, gridId, questions, cells: total };
}

async function visiblePeople(
  db: Client,
  workspaceId: string,
  personIds: readonly string[],
): Promise<readonly string[]> {
  if (personIds.length === 0) return [];

  const unique = [...new Set(personIds)];
  const placeholders = unique.map(() => '?').join(', ');

  const rows = await queryAll<{ id: string }>(
    db,
    `SELECT DISTINCT p.id
       FROM people p
       JOIN campaign_people cp ON cp.person_id = p.id
       JOIN campaigns c ON c.id = cp.campaign_id
      WHERE c.workspace_id = ? AND p.id IN (${placeholders})`,
    [workspaceId, ...unique],
  );

  return rows.map((row) => row.id);
}

export interface RunGridDeps {
  readonly db: Client;
  readonly model: TextModel;
  /** Cells to answer in one pass. Keeps a tick bounded. */
  readonly limit?: number;
}

export interface RunGridResult {
  readonly gridId: string;
  readonly answered: number;
  readonly noEvidence: number;
  readonly failed: number;
  readonly remaining: number;
  readonly status: string;
}

const DEFAULT_CELL_LIMIT = 50;

/**
 * Answers as many outstanding cells as the limit allows.
 *
 * Returns a report rather than throwing on a cell that fails. One prospect
 * whose evidence confuses the model must not cost the other hundred and
 * ninety-nine answers in the same grid.
 */
export async function runResearchGrid(
  deps: RunGridDeps,
  workspaceId: string,
  gridId: string,
): Promise<RunGridResult> {
  const { db } = deps;

  const grid = await queryOne<{ id: string; questions_json: string; status: string }>(
    db,
    'SELECT id, questions_json, status FROM research_grids WHERE id = ? AND workspace_id = ?',
    [gridId, workspaceId],
  );

  if (!grid) throw new Error('no such grid');

  const questions = parseQuestions(grid.questions_json);
  const byId = new Map(questions.map((q) => [q.id, q]));

  await db.execute({
    sql: `UPDATE research_grids SET status = 'running' WHERE id = ? AND status = 'pending'`,
    args: [gridId],
  });

  const cells = await queryAll<{
    id: string;
    person_id: string;
    question_id: string;
    display_name: string;
    company_name: string | null;
  }>(
    db,
    `SELECT c.id, c.person_id, c.question_id, p.display_name, co.name AS company_name
       FROM research_grid_cells c
       JOIN people p ON p.id = c.person_id
       LEFT JOIN companies co ON co.id = p.current_company_id
      WHERE c.grid_id = ? AND c.status = 'unanswered'
      LIMIT ?`,
    [gridId, deps.limit ?? DEFAULT_CELL_LIMIT],
  );

  let answered = 0;
  let noEvidence = 0;
  let failed = 0;

  for (const cell of cells) {
    const question = byId.get(cell.question_id);
    if (!question) {
      await markCell(db, cell.id, 'failed', undefined, [], undefined);
      failed += 1;
      continue;
    }

    const evidence = await evidenceFor(db, workspaceId, cell.person_id);

    try {
      const result = await answerGridCell(deps.model, {
        question,
        personName: cell.display_name,
        ...(cell.company_name ? { companyName: cell.company_name } : {}),
        evidence,
      });

      await markCell(
        db,
        cell.id,
        result.status,
        result.answer,
        result.groundedSignalIds,
        result.model,
      );

      if (result.status === 'answered') answered += 1;
      else if (result.status === 'no_evidence') noEvidence += 1;
      else failed += 1;
    } catch {
      // A model error is this cell's problem. The grid keeps what it has.
      await markCell(db, cell.id, 'failed', undefined, [], undefined);
      failed += 1;
    }
  }

  const done = answered + noEvidence + failed;
  if (done > 0) {
    await db.execute({
      sql: `UPDATE research_grids SET cells_done = cells_done + ? WHERE id = ?`,
      args: [done, gridId],
    });
  }

  const remainingRow = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM research_grid_cells WHERE grid_id = ? AND status = 'unanswered'`,
    [gridId],
  );

  const remaining = Number(remainingRow?.n ?? 0);
  let status = 'running';

  if (remaining === 0) {
    status = 'complete';
    await db.execute({
      sql: `UPDATE research_grids SET status = 'complete', completed_at = ? WHERE id = ?`,
      args: [now(), gridId],
    });
  }

  return { gridId, answered, noEvidence, failed, remaining, status };
}

/**
 * The stored signals one cell may reason over.
 *
 * Freshest first and capped, because a prospect with two hundred signals would
 * otherwise put two hundred into a prompt — expensive, and worse at answering
 * than the dozen most recent, which is what a human would read.
 */
async function evidenceFor(
  db: Client,
  workspaceId: string,
  personId: string,
): Promise<readonly GridEvidence[]> {
  const rows = await queryAll<{
    id: string;
    summary: string;
    evidence: string | null;
    source_url: string | null;
    observed_at: string;
  }>(
    db,
    `SELECT id, summary, evidence, source_url, observed_at
       FROM signals
      WHERE workspace_id = ? AND person_id = ?
        AND (expires_at IS NULL OR expires_at > ?)
   ORDER BY coalesce(source_timestamp, observed_at) DESC
      LIMIT ?`,
    [workspaceId, personId, now(), EVIDENCE_PER_CELL],
  );

  return rows.map((row) => ({
    signalId: row.id,
    summary: row.summary,
    ...(row.evidence ? { excerpt: row.evidence } : {}),
    ...(row.source_url ? { sourceUrl: row.source_url } : {}),
    observedAt: row.observed_at,
  }));
}

async function markCell(
  db: Client,
  cellId: string,
  status: string,
  answer: string | undefined,
  signalIds: readonly string[],
  model: string | undefined,
): Promise<void> {
  await db.execute({
    sql: `UPDATE research_grid_cells
             SET status = ?, answer = ?, grounded_signal_ids = ?, model = ?, answered_at = ?
           WHERE id = ?`,
    args: [status, answer ?? null, JSON.stringify(signalIds), model ?? null, now(), cellId],
  });
}

function parseQuestions(json: string): readonly GridQuestion[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (q): q is GridQuestion =>
        typeof q === 'object' &&
        q !== null &&
        typeof (q as GridQuestion).id === 'string' &&
        typeof (q as GridQuestion).prompt === 'string',
    );
  } catch {
    return [];
  }
}

export interface GridRow {
  readonly personId: string;
  readonly displayName: string;
  readonly answers: Readonly<Record<string, { answer: string | null; status: string }>>;
}

/** The grid as a table, ready to render. */
export async function readResearchGrid(
  db: Client,
  workspaceId: string,
  gridId: string,
): Promise<
  | {
      readonly questions: readonly GridQuestion[];
      readonly rows: readonly GridRow[];
      readonly status: string;
      readonly cellsTotal: number;
      readonly cellsDone: number;
    }
  | undefined
> {
  const grid = await queryOne<{
    questions_json: string;
    status: string;
    cells_total: number;
    cells_done: number;
  }>(
    db,
    `SELECT questions_json, status, cells_total, cells_done
       FROM research_grids WHERE id = ? AND workspace_id = ?`,
    [gridId, workspaceId],
  );

  if (!grid) return undefined;

  const cells = await queryAll<{
    person_id: string;
    display_name: string;
    question_id: string;
    answer: string | null;
    status: string;
  }>(
    db,
    `SELECT c.person_id, p.display_name, c.question_id, c.answer, c.status
       FROM research_grid_cells c
       JOIN people p ON p.id = c.person_id
      WHERE c.grid_id = ?
   ORDER BY p.display_name`,
    [gridId],
  );

  const byPerson = new Map<
    string,
    GridRow & { answers: Record<string, { answer: string | null; status: string }> }
  >();

  for (const cell of cells) {
    let row = byPerson.get(cell.person_id);
    if (!row) {
      row = { personId: cell.person_id, displayName: cell.display_name, answers: {} };
      byPerson.set(cell.person_id, row);
    }
    row.answers[cell.question_id] = { answer: cell.answer, status: cell.status };
  }

  return {
    questions: parseQuestions(grid.questions_json),
    rows: [...byPerson.values()],
    status: grid.status,
    cellsTotal: grid.cells_total,
    cellsDone: grid.cells_done,
  };
}
