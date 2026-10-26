import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { WorkflowControls } from '../../../../components/workflow-controls';
import { StatusChip, WorkflowPlan } from '../../../../components/workflow-plan';
import { RestoreVersion } from '../../../../components/workflow-run-actions';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchWorkflow,
  fetchWorkflowVersions,
  relativeTime,
  type WorkflowRunView,
  type WorkflowVersionView,
  type WorkflowView,
} from '../../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Workflow · OutreachGraph' };

/**
 * One workflow: the plan it runs, the controls, the editors, the runs and the
 * versions. Read top to bottom: what it does, change it, what it did.
 */
export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let found: { workflow: WorkflowView; runs: WorkflowRunView[] } | undefined;
  let versions: WorkflowVersionView[] = [];
  try {
    [found, versions] = await Promise.all([fetchWorkflow(id), fetchWorkflowVersions(id)]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) {
      return (
        <p className="border-border text-ink-muted mt-4 rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      );
    }
    throw error;
  }
  if (!found) notFound();
  const { workflow, runs } = found;

  return (
    <div className="flex flex-col gap-6 pt-4">
      <div>
        <nav className="text-ink-muted mb-2 text-xs">
          <Link href="/workflows" className="underline">
            Workflows
          </Link>{' '}
          / {workflow.name}
        </nav>
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">{workflow.name}</h1>
            <p className="text-ink-muted mt-1 text-sm">{workflow.definition.goal}</p>
          </div>
          <StatusChip status={workflow.status} />
        </header>
        <dl className="text-ink-muted mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs tabular-nums">
          <dt>Runs</dt>
          <dd>{workflow.schedule}</dd>
          <dt>Next run</dt>
          <dd>
            {workflow.nextRunAt
              ? `${relativeTime(workflow.nextRunAt)} (${workflow.nextRunAt.slice(0, 16).replace('T', ' ')} UTC)`
              : '—'}
          </dd>
          <dt>Live version</dt>
          <dd>
            {workflow.publishedVersion ? `v${workflow.publishedVersion}` : 'not published'}
            {workflow.unpublishedChanges ? ` · v${workflow.version} has unpublished changes` : ''}
          </dd>
          <dt>Campaign</dt>
          <dd>{workflow.campaignName ?? 'created on the first run'}</dd>
          {workflow.owner ? (
            <>
              <dt>Owner</dt>
              <dd>{workflow.owner}</dd>
            </>
          ) : null}
        </dl>
      </div>

      <WorkflowControls key={`${workflow.id}-${workflow.version}`} workflow={workflow} />

      <section aria-labelledby="plan-heading">
        <h2 id="plan-heading" className="mb-2 text-sm font-semibold">
          Plan (v{workflow.version})
        </h2>
        <WorkflowPlan plan={workflow.plan} />
      </section>

      <section aria-labelledby="runs-heading">
        <h2 id="runs-heading" className="mb-2 text-sm font-semibold">
          Runs
        </h2>
        {runs.length === 0 ? (
          <p className="text-ink-muted text-xs">
            No runs yet. A dry run shows what the first one would do.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {runs.map((run) => (
              <li key={run.id}>
                <Link
                  href={`/workflows/${workflow.id}/runs/${run.id}`}
                  className="border-border flex min-h-[44px] items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs"
                >
                  <span className="tabular-nums">
                    {relativeTime(run.startedAt)} · {run.trigger.replace('_', ' ')} · v{run.version}
                    {run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}
                  </span>
                  <StatusChip status={run.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="versions-heading">
        <h2 id="versions-heading" className="mb-2 text-sm font-semibold">
          Versions
        </h2>
        <ul className="flex flex-col gap-1">
          {versions.map((v) => (
            <li
              key={v.version}
              className="border-border flex min-h-[44px] items-center justify-between gap-2 rounded-xl border px-3 py-1 text-xs"
            >
              <span>
                v{v.version}
                {v.published ? ' · live' : ''}
                {v.current ? ' · current' : ''} — {v.note ?? 'edit'}{' '}
                <span className="text-ink-muted">{relativeTime(v.createdAt)}</span>
              </span>
              {!v.current ? <RestoreVersion workflowId={workflow.id} version={v.version} /> : null}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="prompt-heading">
        <h2 id="prompt-heading" className="mb-2 text-sm font-semibold">
          Description
        </h2>
        <p className="text-ink-muted text-xs leading-relaxed whitespace-pre-line">
          {workflow.prompt}
        </p>
      </section>
    </div>
  );
}
