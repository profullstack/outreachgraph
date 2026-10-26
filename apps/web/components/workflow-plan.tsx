import type { WorkflowPlanStepView } from '../lib/api';

/**
 * A workflow's execution plan, drawn as the graph it is: one card per step in
 * dependency order, a rail between them, and for each step what it does, the
 * existing feature it calls, what it waits for, and anything that will make it
 * skip. Steps that change something carry a marker — those are the ones with an
 * idempotency key, and the ones a dry run never performs.
 *
 * No hooks, so it renders on the server pages and inside the client composer.
 */
export function WorkflowPlan({
  plan,
  statuses,
}: {
  plan: readonly WorkflowPlanStepView[];
  /** Per-step outcome from a dry run or a run, keyed by step id. */
  statuses?: Readonly<Record<string, { status: string; detail: string }>>;
}) {
  return (
    <ol className="relative flex flex-col gap-2" aria-label="Execution plan">
      {plan.map((step, index) => {
        const outcome = statuses?.[step.id];
        return (
          <li key={step.id} className="relative pl-8">
            {/* The rail: a line through the step numbers. */}
            {index < plan.length - 1 ? (
              <span
                aria-hidden="true"
                className="bg-border absolute top-7 bottom-[-0.5rem] left-[11px] w-px"
              />
            ) : null}
            <span
              aria-hidden="true"
              className={`absolute top-3 left-0 grid size-6 place-items-center rounded-full text-[11px] font-semibold ${
                step.type === 'trigger'
                  ? 'bg-accent text-white'
                  : step.sideEffect
                    ? 'bg-ink/80 text-surface'
                    : 'bg-ink-muted/15 text-ink-muted'
              }`}
            >
              {step.type === 'trigger' ? '▶' : index}
            </span>

            <div className="border-border bg-surface-raised rounded-2xl border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h3 className="text-sm font-medium">{step.title}</h3>
                <span className="text-ink-muted font-mono text-[10px]">
                  {step.type === 'trigger' ? 'trigger' : step.id}
                  {step.sideEffect ? ' · changes state' : ''}
                </span>
              </div>
              <p className="text-ink-muted mt-1 text-xs leading-relaxed">{step.detail}</p>

              <div className="text-ink-muted mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                <span>uses {step.uses}</span>
                {step.after.length > 0 && step.type !== 'trigger' ? (
                  <span>after {step.after.join(', ')}</span>
                ) : null}
                {step.when && step.when.length > 0 ? <span>on {step.when.join(' / ')}</span> : null}
              </div>

              {step.warnings.map((warning) => (
                <p key={warning} className="mt-2 text-xs text-amber-600">
                  {warning}
                </p>
              ))}

              {outcome ? (
                <p className="mt-2 text-xs">
                  <StatusChip status={outcome.status} /> {outcome.detail}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const CHIP: Record<string, string> = {
  ok: 'bg-emerald-500/15 text-emerald-600',
  ready: 'bg-emerald-500/15 text-emerald-600',
  succeeded: 'bg-emerald-500/15 text-emerald-600',
  active: 'bg-emerald-500/15 text-emerald-600',
  send: 'bg-emerald-500/15 text-emerald-600',
  replayed: 'bg-sky-500/15 text-sky-600',
  queue_for_approval: 'bg-sky-500/15 text-sky-600',
  dry_run: 'bg-sky-500/15 text-sky-600',
  running: 'bg-sky-500/15 text-sky-600',
  warning: 'bg-amber-500/15 text-amber-600',
  skipped: 'bg-amber-500/15 text-amber-600',
  retry_scheduled: 'bg-amber-500/15 text-amber-600',
  paused: 'bg-amber-500/15 text-amber-600',
  draft: 'bg-ink-muted/10 text-ink-muted',
  no_send: 'bg-ink-muted/10 text-ink-muted',
  cancelled: 'bg-ink-muted/10 text-ink-muted',
  blocked: 'bg-rose-500/15 text-rose-600',
  failed: 'bg-rose-500/15 text-rose-600',
  dead_letter: 'bg-rose-500/15 text-rose-600',
};

export function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
        CHIP[status] ?? 'bg-ink-muted/10 text-ink-muted'
      }`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}
