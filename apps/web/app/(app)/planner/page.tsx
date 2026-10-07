import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PlannerRunButton, PlannerToggle } from '../../../components/planner-controls';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchPlanner,
  fetchPlannerYear,
  type PlannerView,
  type PlannerYearView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Outreach planner · OutreachGraph' };

const SEQUENCE_LABELS: Record<string, string> = {
  direct: 'Direct',
  value_first: 'Value first',
  relationship: 'Relationship',
  experiment: 'Experiment',
};

/**
 * The 12-month outreach planner: this month's buying mode and plays, what was
 * launched for each product, and the year at a glance. Nothing here needs
 * doing by hand; the worker launches each month's plays on its own.
 */
export default async function PlannerPage() {
  let view: PlannerView | undefined;
  let year: PlannerYearView | undefined;
  let offline = false;

  try {
    [view, year] = await Promise.all([fetchPlanner(), fetchPlannerYear()]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  if (offline || !view || !year) {
    return (
      <div className="pt-4">
        <h1 className="mb-3 text-xl font-semibold">Outreach planner</h1>
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 pt-4 pb-8">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">Outreach planner</h1>
          <p className="text-ink-muted text-sm">
            Q{view.quarter} · Month {view.month} · {view.period}
          </p>
        </div>
        <PlannerRunButton />
      </header>

      <section className="border-border bg-surface-raised space-y-2 rounded-2xl border p-4">
        <h2 className="text-base font-semibold">{view.label}</h2>
        <p className="text-sm">
          <span className="text-ink-muted">Buying mode:</span> {view.buyingMode}
        </p>
        <p className="text-ink-muted text-sm">{view.whatBuyersAreDoing}</p>
        <p className="text-sm">
          <span className="text-ink-muted">Good looks like:</span> {view.benchmark}
        </p>
        {view.plays.length > 0 ? (
          <ul className="space-y-1 pt-1 text-sm">
            {view.plays.map((play) => (
              <li key={play.key}>
                <span className="text-accent text-xs font-medium uppercase">
                  {SEQUENCE_LABELS[play.sequence] ?? play.sequence}
                </span>{' '}
                {play.title}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">
            This month builds fresh lists: every product’s seeds are re-read.
          </p>
        )}
        {!view.tracksEngagement ? (
          <p className="text-ink-muted pt-1 text-xs">
            Opens and clicks are not tracked (plain-text email, as the planner recommends), so plays
            pick people by delivery and replies: written to, delivered, no answer.
          </p>
        ) : null}
        <p className="text-ink-muted pt-1 text-xs">Next month: {view.next.label}</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Your products</h2>
        {view.offerings.length === 0 ? (
          <p className="text-ink-muted text-sm">No products yet.</p>
        ) : (
          view.offerings.map((offering) => {
            const runs = offering.runs.filter((run) => run.period === view.period);
            return (
              <div
                key={offering.offeringId}
                className="border-border bg-surface-raised flex items-start justify-between gap-3 rounded-2xl border p-4"
              >
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-semibold">{offering.name}</p>
                  {!offering.enabled ? (
                    <p className="text-ink-muted text-xs">Planner off for this product.</p>
                  ) : runs.length === 0 ? (
                    <p className="text-ink-muted text-xs">
                      Nothing launched yet this month. Plays start once someone fits them.
                    </p>
                  ) : (
                    runs.map((run) => (
                      <p key={run.playKey} className="text-xs">
                        {run.playKey === 'refresh_lists'
                          ? 'Lists refreshed'
                          : `${run.playKey.replace(/_/g, ' ')}: ${run.people} people`}
                        {run.campaignId ? (
                          <>
                            {' · '}
                            <Link
                              href={`/products/${encodeURIComponent(offering.offeringId)}`}
                              className="text-accent"
                            >
                              campaign
                            </Link>
                          </>
                        ) : null}
                      </p>
                    ))
                  )}
                </div>
                <PlannerToggle offeringId={offering.offeringId} enabled={offering.enabled} />
              </div>
            );
          })
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">The year</h2>
        <ol className="border-border divide-border divide-y rounded-2xl border">
          {year.months.map((month) => {
            const current = month.quarter === view.quarter && month.month === view.month;
            return (
              <li
                key={`${month.quarter}-${month.month}`}
                className={`p-3 text-sm ${current ? 'bg-surface-raised' : ''}`}
              >
                <span className="text-ink-muted mr-2 text-xs">
                  Q{month.quarter} M{month.month}
                </span>
                <span className={current ? 'font-semibold' : ''}>{month.label}</span>
              </li>
            );
          })}
        </ol>
        <p className="text-ink-muted text-xs">
          Running all year, every month: addresses verified before sending, campaigns paused above
          2% bounce, one contact per company in persona order, A/B winners promoted at 50+ per arm,
          business hours where the recipient is, and one bump when a conversation goes quiet.
        </p>
      </section>
    </div>
  );
}
