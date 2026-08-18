import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { CadenceStatus } from '../../../../components/cadence-status';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchCadence,
  fetchEnrollments,
  relativeTime,
  type CadenceDetailView,
  type EnrollmentRowView,
} from '../../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Plan · OutreachGraph' };

/**
 * One plan: its steps, and who is partway through it.
 *
 * The enrolment list is the point of the page rather than the step list. A
 * plan's steps are what somebody wrote; the enrolments are what actually
 * happened, and the gap between the two is where this product either earns
 * trust or quietly wastes leads.
 */
export default async function CadencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let detail: CadenceDetailView | undefined;
  let enrollments: EnrollmentRowView[] = [];
  let offline = false;

  try {
    [detail, enrollments] = await Promise.all([fetchCadence(id), fetchEnrollments(id)]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else notFound();
  }

  if (offline || !detail) {
    return (
      <div className="pt-4">
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      </div>
    );
  }

  const { cadence, steps } = detail;
  const totalHours = steps.reduce((sum, step) => sum + step.delay_hours, 0);

  return (
    <div className="pt-4">
      <Link href="/cadences" className="text-ink-muted text-xs underline">
        ← All plans
      </Link>

      <header className="mt-2 mb-4">
        <h1 className="text-xl font-semibold">{cadence.name}</h1>
        <p className="text-ink-muted text-sm">
          {steps.length} {steps.length === 1 ? 'touch' : 'touches'} over {formatHours(totalHours)} ·{' '}
          {cadence.status}
        </p>
      </header>

      <div className="mb-6">
        <CadenceStatus id={cadence.id} status={cadence.status} />
      </div>

      <section className="border-border bg-surface-raised mb-6 rounded-2xl border p-4">
        <h2 className="text-sm font-semibold">The plan</h2>

        <ol className="mt-3 flex flex-col gap-2">
          {steps.map((step) => (
            <li key={step.position} className="border-border rounded-xl border p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">
                  {step.position + 1}. {step.action.replace(/_/g, ' ')} on {step.network}
                </span>
                <span className="text-ink-muted shrink-0 text-xs">
                  {step.delay_hours === 0
                    ? 'straight away'
                    : `after ${formatHours(step.delay_hours)}`}
                </span>
              </div>

              {step.intent ? <p className="text-ink-muted mt-1 text-xs">{step.intent}</p> : null}
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">
          Who is on it{enrollments.length > 0 ? ` (${enrollments.length})` : ''}
        </h2>

        {enrollments.length === 0 ? (
          <p className="border-border text-ink-muted rounded-2xl border border-dashed p-6 text-center text-sm">
            Nobody yet. Enrol someone from a prospect, or let a rule do it.
          </p>
        ) : (
          <ul className="border-border divide-border divide-y overflow-hidden rounded-2xl border">
            {enrollments.map((enrollment) => (
              <li key={enrollment.id} className="bg-surface-raised p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/prospects/${enrollment.person_id}`} className="font-medium">
                      {enrollment.display_name}
                    </Link>
                    <div className="text-ink-muted mt-0.5 text-xs">
                      step {enrollment.current_step + 1}
                      {enrollment.next_due_at
                        ? ` · next ${relativeTime(enrollment.next_due_at)}`
                        : ''}
                      {enrollment.stopped_reason ? ` · ${enrollment.stopped_reason}` : ''}
                    </div>
                  </div>

                  <span
                    className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-medium ${
                      enrollment.status === 'active'
                        ? 'bg-emerald-500/15 text-emerald-600'
                        : enrollment.status === 'completed'
                          ? 'bg-sky-500/15 text-sky-600'
                          : 'bg-ink-muted/10 text-ink-muted'
                    }`}
                  >
                    {enrollment.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function formatHours(hours: number): string {
  if (hours === 0) return 'no wait';
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)} days`;
}
