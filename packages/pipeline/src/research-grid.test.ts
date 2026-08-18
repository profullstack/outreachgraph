/**
 * The grid as a batch: costed before it runs, resumable while it does, and
 * incapable of reading another workspace's prospects.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { newId } from '@outreachgraph/domain';
import { StubModel } from '@outreachgraph/ai';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { createResearchGrid, readResearchGrid, runResearchGrid } from './research-grid';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const ANSWER = JSON.stringify({ answer: 'Stripe.', signalIds: ['sig_fees'], hasEvidence: true });

async function grid(db: Client, questions: readonly string[] = ['Which provider?']) {
  return createResearchGrid(db, {
    workspaceId: SEED.workspaceId,
    campaignId: SEED.campaignId,
    name: 'Competitor scan',
    questions,
    personIds: [SEED.personId],
  });
}

describe('createResearchGrid', () => {
  test('lays out every cell up front', async () => {
    seeded = await seedDatabase('grid-create');

    const created = await grid(seeded.db, ['Which provider?', 'Are they hiring?']);

    expect(created.created).toBe(true);
    if (!created.created) return;

    // One person, two questions. The total is a fact about the grid, not a
    // guess, so progress can be a fraction rather than a spinner.
    expect(created.cells).toBe(2);
    expect(await queryAll(seeded.db, 'SELECT id FROM research_grid_cells')).toHaveLength(2);
  });

  test('refuses a grid with no questions', async () => {
    seeded = await seedDatabase('grid-noquestions');

    expect((await grid(seeded.db, ['  '])).created).toBe(false);
  });

  test('refuses a nameless grid', async () => {
    seeded = await seedDatabase('grid-noname');

    const created = await createResearchGrid(seeded.db, {
      workspaceId: SEED.workspaceId,
      name: '   ',
      questions: ['Which provider?'],
      personIds: [SEED.personId],
    });

    expect(created.created).toBe(false);
  });

  test('will not read a person from another workspace', async () => {
    // A grid is a bulk read, which makes it the most attractive place in the
    // API to try to enumerate somebody else's prospects.
    seeded = await seedDatabase('grid-isolation');

    const created = await createResearchGrid(seeded.db, {
      workspaceId: 'wsp_someone_else',
      name: 'Snoop',
      questions: ['Which provider?'],
      personIds: [SEED.personId],
    });

    expect(created.created).toBe(false);
    if (!created.created) expect(created.reason).toContain('workspace');
  });
});

describe('runResearchGrid', () => {
  test('answers a cell from stored evidence', async () => {
    seeded = await seedDatabase('grid-answer');
    const { db } = seeded;
    const created = await grid(db);
    if (!created.created) throw new Error('not created');

    const result = await runResearchGrid(
      { db, model: new StubModel(ANSWER) },
      SEED.workspaceId,
      created.gridId,
    );

    expect(result.answered).toBe(1);
    expect(result.remaining).toBe(0);
    expect(result.status).toBe('complete');

    const cell = await queryOne<{ answer: string; grounded_signal_ids: string }>(
      db,
      'SELECT answer, grounded_signal_ids FROM research_grid_cells LIMIT 1',
    );
    expect(cell?.answer).toBe('Stripe.');
    // The citation is what makes a surprising cell checkable without re-running.
    expect(JSON.parse(cell!.grounded_signal_ids)).toEqual(['sig_fees']);
  });

  test('records no evidence rather than inventing an answer', async () => {
    seeded = await seedDatabase('grid-noevidence');
    const { db } = seeded;

    await db.execute('DELETE FROM signals');
    const created = await grid(db);
    if (!created.created) throw new Error('not created');

    const result = await runResearchGrid(
      { db, model: new StubModel(ANSWER) },
      SEED.workspaceId,
      created.gridId,
    );

    expect(result.noEvidence).toBe(1);
    expect(result.answered).toBe(0);

    const cell = await queryOne<{ status: string; answer: string | null }>(
      db,
      'SELECT status, answer FROM research_grid_cells LIMIT 1',
    );
    expect(cell?.status).toBe('no_evidence');
    expect(cell?.answer).toBeNull();
  });

  test('keeps the answers it has when a cell fails', async () => {
    seeded = await seedDatabase('grid-partial');
    const { db } = seeded;
    const created = await grid(db, ['Which provider?', 'Are they hiring?']);
    if (!created.created) throw new Error('not created');

    // First cell answers, second returns prose the parser cannot use.
    const model = new StubModel([ANSWER, 'no idea really']);
    const result = await runResearchGrid({ db, model }, SEED.workspaceId, created.gridId);

    expect(result.answered).toBe(1);
    expect(result.noEvidence).toBe(1);
    expect(result.remaining).toBe(0);
  });

  test('resumes rather than restarting', async () => {
    seeded = await seedDatabase('grid-resume');
    const { db } = seeded;
    const created = await grid(db, ['Q one?', 'Q two?', 'Q three?']);
    if (!created.created) throw new Error('not created');

    const model = new StubModel(ANSWER);
    const first = await runResearchGrid({ db, model, limit: 2 }, SEED.workspaceId, created.gridId);
    expect(first.remaining).toBe(1);
    expect(first.status).toBe('running');

    const second = await runResearchGrid({ db, model, limit: 2 }, SEED.workspaceId, created.gridId);
    expect(second.answered).toBe(1);
    expect(second.status).toBe('complete');

    // Three cells, three calls — never a re-run of what was already answered.
    expect(model.calls).toHaveLength(3);
  });

  test('tracks progress as a fraction', async () => {
    seeded = await seedDatabase('grid-progress');
    const { db } = seeded;
    const created = await grid(db, ['Q one?', 'Q two?']);
    if (!created.created) throw new Error('not created');

    await runResearchGrid(
      { db, model: new StubModel(ANSWER), limit: 1 },
      SEED.workspaceId,
      created.gridId,
    );

    const row = await queryOne<{ cells_total: number; cells_done: number }>(
      db,
      'SELECT cells_total, cells_done FROM research_grids LIMIT 1',
    );
    expect(row?.cells_total).toBe(2);
    expect(row?.cells_done).toBe(1);
  });

  test('refuses a grid in another workspace', async () => {
    seeded = await seedDatabase('grid-run-isolation');
    const { db } = seeded;
    const created = await grid(db);
    if (!created.created) throw new Error('not created');

    expect(
      runResearchGrid({ db, model: new StubModel(ANSWER) }, 'wsp_someone_else', created.gridId),
    ).rejects.toThrow();
  });
});

describe('readResearchGrid', () => {
  test('returns the grid as a table', async () => {
    seeded = await seedDatabase('grid-read');
    const { db } = seeded;
    const created = await grid(db);
    if (!created.created) throw new Error('not created');

    await runResearchGrid({ db, model: new StubModel(ANSWER) }, SEED.workspaceId, created.gridId);

    const table = await readResearchGrid(db, SEED.workspaceId, created.gridId);

    expect(table?.questions).toHaveLength(1);
    expect(table?.rows).toHaveLength(1);
    expect(table?.rows[0]?.displayName).toBeTruthy();

    const questionId = table!.questions[0]!.id;
    expect(table?.rows[0]?.answers[questionId]?.answer).toBe('Stripe.');
  });

  test('returns nothing for a grid in another workspace', async () => {
    seeded = await seedDatabase('grid-read-isolation');
    const created = await grid(seeded.db);
    if (!created.created) throw new Error('not created');

    expect(await readResearchGrid(seeded.db, 'wsp_someone_else', created.gridId)).toBeUndefined();
  });
});

describe('evidence selection', () => {
  test('ignores an expired signal', async () => {
    seeded = await seedDatabase('grid-expired');
    const { db } = seeded;

    await db.execute({
      sql: `UPDATE signals SET expires_at = ? WHERE id = ?`,
      args: ['2020-01-01T00:00:00.000Z', SEED.signalId],
    });

    const created = await grid(db);
    if (!created.created) throw new Error('not created');

    const result = await runResearchGrid(
      { db, model: new StubModel(ANSWER) },
      SEED.workspaceId,
      created.gridId,
    );

    // A decayed signal is not evidence, so the honest answer is that there is
    // none — not an answer resting on something we no longer believe.
    expect(result.noEvidence).toBe(1);
  });

  test('does not read another workspace’s signals as evidence', async () => {
    seeded = await seedDatabase('grid-signal-isolation');
    const { db } = seeded;

    // A real second workspace, because the foreign key is doing its job.
    await db.execute({
      sql: `INSERT INTO workspaces (id, organization_id, name, slug, created_at, updated_at)
            VALUES ('wsp_elsewhere', ?, 'Elsewhere', 'elsewhere', ?, ?)`,
      args: [SEED.organizationId, now(), now()],
    });

    await db.execute({
      sql: `UPDATE signals SET workspace_id = 'wsp_elsewhere' WHERE id = ?`,
      args: [SEED.signalId],
    });

    const created = await grid(db);
    if (!created.created) throw new Error('not created');

    const result = await runResearchGrid(
      { db, model: new StubModel(ANSWER) },
      SEED.workspaceId,
      created.gridId,
    );

    expect(result.noEvidence).toBe(1);
  });
});

describe('grid ids', () => {
  test('question ids are unique per grid', async () => {
    seeded = await seedDatabase('grid-ids');
    const a = await grid(seeded.db, ['Same question?']);
    const b = await grid(seeded.db, ['Same question?']);

    if (!a.created || !b.created) throw new Error('not created');

    // Reusing an id across grids would make one grid's answers appear in
    // another's column.
    expect(a.questions[0]!.id).not.toBe(b.questions[0]!.id);
    expect(newId('gridQuestion').startsWith('gqn_')).toBe(true);
  });
});
