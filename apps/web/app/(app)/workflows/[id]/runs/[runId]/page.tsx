import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { StatusChip } from '../../../../../../components/workflow-plan';
import { WorkflowRunActions } from '../../../../../../components/workflow-run-actions';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchWorkflowRun,
  relativeTime,
} from '../../../../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Workflow run · OutreachGraph' };

/**
 * One run, step by step: what each step did, skipped or failed and why, the
 * counts it produced, and the idempotency key that stops a retry or resume
 * doing it twice. A dry run shows its checks, decisions and estimate here too.
 */
export default async function WorkflowRunPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = await params;

  let found: Awaited<ReturnType<typeof fetchWorkflowRun>>;
  try {
    found = await fetchWorkflowRun(id, runId);
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
  const { workflow, run } = found;
  const summary = run.summary as {
    decisions?: { send: number; queueForApproval: number; noSend: number };
    estimate?: { effectiveDailyCap: number; dailyLimit: number; sentToday: number };
    replayed?: number;
  };

  return (
    <div className="flex flex-col gap-5 pt-4">
      <div>
        <nav className="text-ink-muted mb-2 text-xs">
          <Link href="/workflows" className="underline">
            Workflows
          </Link>{' '}
          /{' '}
          <Link href={`/workflows/${workflow.id}`} className="underline">
            {workflow.name}
          </Link>{' '}
          / run
        </nav>
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">
              {run.trigger === 'dry_run' ? 'Dry run' : 'Run'} · v{run.version}
            </h1>
            <p className="text-ink-muted mt-1 text-xs tabular-nums">
              {run.trigger.replace('_', ' ')} · started {relativeTime(run.startedAt)}
              {run.finishedAt ? ` · finished ${relativeTime(run.finishedAt)}` : ''}
              {run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}
              {run.retryAt ? ` · retry ${relativeTime(run.retryAt)}` : ''}
            </p>
            <p className="text-ink-muted mt-1 font-mono text-[11px] break-all">
              slot {run.slotKey}
            </p>
          </div>
          <StatusChip status={run.status} />
        </header>
      </div>

      <WorkflowRunActions workflowId={workflow.id} runId={run.id} status={run.status} />

      {summary.estimate ? (
        <p className="text-ink-muted text-xs tabular-nums">
          Cap {summary.estimate.effectiveDailyCap}/day (asked {summary.estimate.dailyLimit}),{' '}
          {summary.estimate.sentToday} sent that day.
          {summary.decisions
            ? ` Decisions: ${summary.decisions.send} send, ${summary.decisions.queueForApproval} for approval, ${summary.decisions.noSend} no send.`
            : ''}
        </p>
      ) : null}

      {run.error ? (
        <section
          aria-labelledby="errors-heading"
          className="rounded-2xl border border-rose-500/30 p-3"
        >
          <h2 id="errors-heading" className="text-sm font-semibold text-rose-600">
            Errors
          </h2>
          <pre className="mt-2 text-xs whitespace-pre-wrap">{run.error}</pre>
        </section>
      ) : null}

      <section aria-labelledby="log-heading">
        <h2 id="log-heading" className="mb-2 text-sm font-semibold">
          Step log
        </h2>
        <ol className="flex flex-col gap-2">
          {run.steps.map((step) => (
            <li
              key={step.id}
              className="border-border bg-surface-raised rounded-2xl border p-3 text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  {step.title} <span className="text-ink-muted font-mono">{step.id}</span>
                </span>
                <StatusChip status={step.status} />
              </div>
              <p className="text-ink-muted mt-1 leading-relaxed">{step.detail}</p>
              {step.counts && Object.keys(step.counts).length > 0 ? (
                <p className="text-ink-muted mt-1 tabular-nums">
                  {Object.entries(step.counts)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(' · ')}
                </p>
              ) : null}
              {step.idempotencyKey ? (
                <p className="text-ink-muted mt-1 font-mono text-[10px] break-all">
                  key {step.idempotencyKey}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
