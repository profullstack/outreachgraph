import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { GridRunner } from '../../../../components/grid-runner';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchGrid,
  type GridTableView,
} from '../../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Research · OutreachGraph' };

/**
 * A grid, as a table.
 *
 * Wide on purpose and allowed to scroll sideways inside its own container:
 * this is the one screen in a phone-first app whose whole value is comparing
 * rows against each other, and wrapping the columns would destroy that.
 *
 * An empty cell is rendered as an explicit "no evidence" rather than as blank
 * space, because the two mean different things. Blank could be "we have not
 * asked yet"; this one means "we asked, and nothing we hold supports an
 * answer" — which is a finding rather than a gap.
 */
export default async function GridPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let grid: GridTableView | undefined;
  let offline = false;

  try {
    grid = await fetchGrid(id);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else notFound();
  }

  if (offline || !grid) {
    return (
      <div className="pt-4">
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      </div>
    );
  }

  const remaining = grid.cellsTotal - grid.cellsDone;

  return (
    <div className="pt-4">
      <Link href="/research" className="text-ink-muted text-xs underline">
        ← All research
      </Link>

      <header className="mt-2 mb-4">
        <h1 className="text-xl font-semibold">
          {grid.rows.length} {grid.rows.length === 1 ? 'person' : 'people'} ·{' '}
          {grid.questions.length} {grid.questions.length === 1 ? 'question' : 'questions'}
        </h1>
        <p className="text-ink-muted text-sm">
          {grid.cellsDone} of {grid.cellsTotal} answered
        </p>
      </header>

      <div className="mb-5">
        <GridRunner id={id} remaining={remaining} />
      </div>

      {/* Its own scroll container, so the page body never scrolls sideways. */}
      <div className="border-border overflow-x-auto rounded-2xl border">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="bg-surface-raised">
              <th className="border-border sticky left-0 z-10 border-b bg-inherit p-3 text-left text-xs font-semibold">
                Person
              </th>
              {grid.questions.map((question) => (
                <th
                  key={question.id}
                  className="border-border min-w-[220px] border-b p-3 text-left text-xs font-semibold"
                >
                  {question.prompt}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {grid.rows.map((row) => (
              <tr key={row.personId} className="border-border border-b last:border-b-0">
                <td className="bg-surface sticky left-0 z-10 p-3 align-top">
                  <Link href={`/prospects/${row.personId}`} className="font-medium">
                    {row.displayName}
                  </Link>
                </td>

                {grid.questions.map((question) => {
                  const cell = row.answers[question.id];

                  return (
                    <td key={question.id} className="p-3 align-top">
                      {cell?.status === 'answered' && cell.answer ? (
                        <span>{cell.answer}</span>
                      ) : cell?.status === 'no_evidence' ? (
                        <span className="text-ink-muted text-xs italic">nothing to go on</span>
                      ) : cell?.status === 'failed' ? (
                        <span className="text-xs text-rose-600">failed</span>
                      ) : (
                        <span className="text-ink-muted text-xs">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-ink-muted mt-4 text-xs leading-relaxed">
        Every answer rests on evidence already collected about that person. Where there was none the
        cell says so rather than guessing — a research table gets scanned and sorted rather than
        read, so an invented answer would never be caught.
      </p>
    </div>
  );
}
