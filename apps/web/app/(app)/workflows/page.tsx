import Link from 'next/link';
import { redirect } from 'next/navigation';
import { StatusChip } from '../../../components/workflow-plan';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchWorkflows,
  relativeTime,
  type WorkflowView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Workflows · OutreachGraph' };

/**
 * Saved workflows (PRD-ECO §14): what each one is, whether it is on, when it
 * last ran and how that went, when it runs next, and whether anything has
 * failed this week. Creating one starts from English or a template.
 */
export default async function WorkflowsPage() {
  let workflows: WorkflowView[] = [];
  let offline = false;

  try {
    ({ workflows } = await fetchWorkflows());
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Workflows</h1>
          <p className="text-ink-muted text-sm">
            Describe the outreach you want in plain English; review the plan; run it on a schedule.
          </p>
        </div>
        <Link
          href="/workflows/new"
          className="bg-accent inline-flex min-h-[44px] shrink-0 items-center rounded-xl px-4 text-sm font-medium text-white"
        >
          New
        </Link>
      </header>

      {offline ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : workflows.length === 0 ? (
        <div className="border-border rounded-2xl border border-dashed p-6 text-center text-sm">
          <p className="text-ink-muted">No workflows yet.</p>
          <Link href="/workflows/new" className="text-accent mt-2 inline-block underline">
            Start with Engineering Contract Acquisition, or describe your own
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {workflows.map((w) => (
            <li key={w.id}>
              <Link
                href={`/workflows/${w.id}`}
                className="border-border bg-surface-raised block rounded-2xl border p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{w.name}</div>
                    <div className="text-ink-muted mt-0.5 text-xs">
                      {w.schedule}
                      {w.owner ? ` · ${w.owner}` : ''}
                    </div>
                  </div>
                  <StatusChip status={w.status} />
                </div>
                <div className="text-ink-muted mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
                  <span>
                    v{w.publishedVersion ?? '–'} live
                    {w.unpublishedChanges ? ` · v${w.version} unpublished` : ''}
                  </span>
                  <span>
                    last run{' '}
                    {w.lastRunAt ? (
                      <>
                        {relativeTime(w.lastRunAt)}{' '}
                        <StatusChip status={w.lastRunStatus ?? 'unknown'} />
                      </>
                    ) : (
                      'never'
                    )}
                  </span>
                  <span>next {w.nextRunAt ? relativeTime(w.nextRunAt) : '—'}</span>
                  {w.failuresThisWeek > 0 ? (
                    <span className="text-rose-600">{w.failuresThisWeek} failed this week</span>
                  ) : null}
                  {w.campaignName ? <span>campaign {w.campaignName}</span> : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="text-ink-muted mt-6 text-xs">
        Also from a terminal (<code>og workflows</code>) and from agents over MCP — the same API,
        the same policy checks.
      </p>
    </div>
  );
}
