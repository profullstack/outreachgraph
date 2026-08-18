import { redirect } from 'next/navigation';
import { RuleBuilder } from '../../../components/rule-builder';
import { RuleToggle } from '../../../components/rule-toggle';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchCadences,
  fetchRules,
  fetchUsage,
  type CadenceRowView,
  type RuleRowView,
  type UsageView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Rules · OutreachGraph' };

const TRIGGER_LABELS: Record<string, string> = {
  signal_received: 'a new signal',
  score_crossed: 'a score threshold',
  reply_received: 'a reply',
  stage_changed: 'a funnel move',
};

const ACTION_LABELS: Record<string, string> = {
  enroll_cadence: 'put them on a plan',
  notify: 'tell you',
  suppress: 'never contact them',
  set_status: 'move them in the funnel',
};

/**
 * Rules, and what this month has cost.
 *
 * The two sit together because they are the same question asked twice: what is
 * this thing doing while nobody is watching, and how much of the month has it
 * spent doing it.
 */
export default async function RulesPage() {
  let rules: RuleRowView[] = [];
  let cadences: CadenceRowView[] = [];
  let usage: UsageView | undefined;
  let offline = false;

  try {
    [rules, cadences, usage] = await Promise.all([fetchRules(), fetchCadences(), fetchUsage()]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Rules</h1>
        <p className="text-ink-muted text-sm">When this happens, do that — without asking you.</p>
      </header>

      {offline ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {usage ? <UsagePanel usage={usage} /> : null}

          {rules.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {rules.map((rule) => (
                <li
                  key={rule.id}
                  className="border-border bg-surface-raised rounded-2xl border p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium">{rule.name}</div>
                      <div className="text-ink-muted mt-0.5 text-xs">
                        On {TRIGGER_LABELS[rule.trigger] ?? rule.trigger} →{' '}
                        {ACTION_LABELS[rule.action] ?? rule.action}
                      </div>

                      {/* Fired and applied are different numbers, and the gap
                          between them is the most useful thing on this row: a
                          rule that matches constantly and is refused every
                          time looks identical to a working one from a count. */}
                      <div className="text-ink-muted mt-2 text-xs tabular-nums">
                        fired {rule.fired} · did something {rule.applied}
                        {rule.fired > 0 && rule.applied === 0 ? (
                          <span className="text-amber-600"> — never actually did anything</span>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <span
                        className={`rounded-full px-2 py-1 text-[11px] font-medium ${
                          rule.enabled === 1
                            ? 'bg-emerald-500/15 text-emerald-600'
                            : 'bg-ink-muted/10 text-ink-muted'
                        }`}
                      >
                        {rule.enabled === 1 ? 'on' : 'off'}
                      </span>
                      <RuleToggle id={rule.id} enabled={rule.enabled === 1} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="border-border text-ink-muted rounded-2xl border border-dashed p-6 text-center text-sm">
              No rules yet.
            </p>
          )}

          <RuleBuilder cadences={cadences} />
        </div>
      )}
    </div>
  );
}

function UsagePanel({ usage }: { usage: UsageView }) {
  const { plan, thisMonth } = usage;
  const used = thisMonth.prospectsContacted;
  const pct = plan.prospectsPerMonth > 0 ? Math.min(100, (used / plan.prospectsPerMonth) * 100) : 0;

  return (
    <section className="border-border bg-surface-raised rounded-2xl border p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">This month</h2>
        <span className="text-ink-muted text-xs">{plan.name} plan</span>
      </div>

      <p className="mt-3 text-sm tabular-nums">
        <span className="text-lg font-semibold">{used}</span>
        <span className="text-ink-muted"> of {plan.prospectsPerMonth} people contacted</span>
      </p>

      <div className="bg-ink-muted/15 mt-2 h-2 overflow-hidden rounded-full">
        <div
          className={`h-full rounded-full ${thisMonth.exhausted ? 'bg-rose-500' : 'bg-accent'}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <p className="text-ink-muted mt-3 text-xs tabular-nums">
        {thisMonth.gridCells} of {plan.gridCellsPerMonth} research answers used
      </p>

      {thisMonth.exhausted ? (
        <p className="mt-3 text-xs text-rose-600">
          The month&rsquo;s allowance is spent, so outbound actions are being refused. Nothing is
          lost — the queue keeps building and resumes on the 1st.
        </p>
      ) : (
        <p className="text-ink-muted mt-3 text-xs">
          Counted once per person however many times you contact them, so following up costs nothing
          extra.
        </p>
      )}
    </section>
  );
}
