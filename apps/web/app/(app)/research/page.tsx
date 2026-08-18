import Link from 'next/link';
import { redirect } from 'next/navigation';
import { GridBuilder } from '../../../components/grid-builder';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchGrids,
  fetchProspects,
  relativeTime,
  type GridRowView,
} from '../../../lib/api';
import type { ProspectRow } from '../../../lib/types';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Research · OutreachGraph' };

/**
 * Asking one question of many prospects at once.
 *
 * The product could research a person in response to a trigger and produce a
 * card. It could not answer "for these two hundred leads, which competitor are
 * they on" without opening two hundred cards — which is the question somebody
 * actually has when deciding where to spend a week.
 */
export default async function ResearchPage() {
  let grids: GridRowView[] = [];
  let prospects: ProspectRow[] = [];
  let offline = false;

  try {
    [grids, prospects] = await Promise.all([fetchGrids(), fetchProspects()]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Research</h1>
        <p className="text-ink-muted text-sm">
          The same questions, asked of everyone on a list, answered into a table.
        </p>
      </header>

      {offline ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {grids.length > 0 ? (
            <ul className="border-border divide-border divide-y overflow-hidden rounded-2xl border">
              {grids.map((grid) => (
                <li key={grid.id} className="bg-surface-raised">
                  <Link href={`/research/${grid.id}`} className="block p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium">{grid.name}</div>
                        <div className="text-ink-muted mt-0.5 text-xs">
                          {grid.cells_done} of {grid.cells_total} answered ·{' '}
                          {relativeTime(grid.created_at)}
                        </div>
                      </div>

                      <span
                        className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-medium ${
                          grid.status === 'complete'
                            ? 'bg-emerald-500/15 text-emerald-600'
                            : grid.status === 'running'
                              ? 'bg-sky-500/15 text-sky-600'
                              : 'bg-ink-muted/10 text-ink-muted'
                        }`}
                      >
                        {grid.status}
                      </span>
                    </div>

                    {/* Progress as a fraction rather than a spinner: the total
                        is known before the grid runs, so there is no reason to
                        show an indeterminate bar. */}
                    <div className="bg-ink-muted/15 mt-3 h-1.5 overflow-hidden rounded-full">
                      <div
                        className="bg-accent h-full rounded-full"
                        style={{
                          width: `${grid.cells_total > 0 ? Math.round((grid.cells_done / grid.cells_total) * 100) : 0}%`,
                        }}
                      />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}

          <GridBuilder prospects={prospects} />
        </div>
      )}
    </div>
  );
}
